/**
 * Courier voice on the shared worklets: the deepest voice in the rack.
 *
 * Signal flow:
 *   OSC 1 + OSC 2 (waveshape morph) + SUB (subWave morph) + NOISE  -> per-source mixer
 *     -> multimode ladder (LP4/LP2/BP/HP, RES BASS) -> VCA -> VOLUME -> COU_AUDIO_OUT.
 * Two EGs (filter + amp) on the shared eg worklet; two native-oscillator LFOs
 * (LFO 1 panel mod with a destination router; LFO 2 left-hand wheel-style mod).
 * FM 1->2 and hard-sync 1->2 reuse the osc linear-FM / sync inputs. OSC 2 also
 * audio-rate modulates cutoff. Pitch CV carries glide (mirrors the Monarch).
 *
 * Pitch model: PITCH_REF_HZ × 2^vv, 1 vv = 1 octave. A scheduled ConstantSource
 * carries the keyboard note in vv on a shared pitch bus; OSC octave switches and
 * TUNE / OSC 2 FREQ detune are summed onto each oscillator's own pitch sub-bus.
 *
 * EG model: both EGs run the shared eg worklet in 'adsr' mode — full attack, decay-to-SUSTAIN
 * level, hold while gated, an independent RELEASE on gate-off, and an optional ENV LOOP that
 * re-attacks the gated envelope as an LFO. Velocity scaling of the EGs — F/A ENV VEL (U4) — is live:
 * a note-on velocity feeds a velBus into the FILTER EG (input 1; F ENV VEL gates the velBus VALUE —
 * ON = note velocity scales the filter-EG peak, OFF = full peak) and gates G1's velocityGain on the
 * AMP path (A ENV VEL); amp velocity is never double-applied (the worklet amp-velocity input is unwired).
 */

import type { ModuleDef } from '../../../data/schema';
import { ModuleBase } from './moduleBase';
import { constant, gain, shaper } from './helpers';
import { createNoiseSource } from '../noise';
import { DriftSource } from '../drift';
import { PITCH_REF_HZ, clamp } from '../units';
import { MOD_TARGETS, modGain, type ModBus } from '../modRouter';
import type { CourierModSource, ModAssignEntry } from '../../state/studioState';
import { COURIER_MOD_SOURCES } from '../../state/studioState';

/**
 * Courier resonance scale: onset of self-oscillation. 1.43 places onset at knob ≈ 0.70 ("above two
 * o'clock"), matching the measured hardware reference — an earlier onset than the 1.15 (~0.87)
 * Monarch/Anvil default. Do NOT lower it; this value is test-locked (ladderCore.test.ts).
 */
const COURIER_RES_SCALE = 1.43;

/** Linear-FM depth, Hz per vv (unsourced assumption — tunable, mirrors the other voices). */
const COU_FM_DEPTH_HZ_PER_VV = 150;

/** Full-scale note velocity in vv (egCore reads 0..5; 5 = full EG peak). The filter velBus rests here
 *  so a non-live note (sequencer/arp, which never calls velocityAt) sees full filter-EG peak. */
const FULL_VEL_VV = 5;

/** OSC 2 -> cutoff audio-rate FM: full knob (=1) maps the ±5 vv OSC 2 signal to ±N vv of cutoff. */
const OSC2_CUTOFF_DEPTH = 1;

type Lfo1Dest = 'CUTOFF' | 'OSC2_FREQ' | 'OSC1_WAVE' | 'SUB_WAVE';
type Lfo2Dest = 'PITCH' | 'CUTOFF' | 'AMP';

export class CourierModule extends ModuleBase {
  readonly osc1: AudioWorkletNode;
  readonly osc2: AudioWorkletNode;
  readonly sub: AudioWorkletNode;
  readonly ladder: AudioWorkletNode;
  readonly filterEg: AudioWorkletNode;
  readonly ampEg: AudioWorkletNode;
  readonly lfo1: OscillatorNode;
  readonly lfo2: OscillatorNode;
  readonly drift1: DriftSource;
  readonly drift2: DriftSource;

  // pitch
  private readonly kbCv: ConstantSourceNode; // scheduled keyboard note, vv
  private readonly kbGate: ConstantSourceNode; // internal KB gate 0/5
  private readonly osc1Octave: ConstantSourceNode; // octave + master TUNE, vv
  private readonly osc2Octave: ConstantSourceNode; // octave + OSC 2 FREQ detune, vv
  private readonly pitchBus: GainNode; // shared keyboard-note pitch bus (vv); mod 'pitch' target
  private readonly osc2Pitch: GainNode; // OSC 2 pitch sub-bus (vv); mod 'osc2pitch' target
  private readonly pitchBend: ConstantSourceNode; // live pitch-wheel offset (vv), summed onto pitchBus

  // mixer
  private readonly mixOsc1: GainNode;
  private readonly mixOsc2: GainNode;
  private readonly mixSub: GainNode;
  private readonly mixNoise: GainNode;
  private readonly mixFbExt: GainNode;

  // filter cutoff CV summing + mod amounts
  private readonly cutoffCvSum: GainNode;
  private readonly filterEgAmt: GainNode; // bipolar EG -> cutoff
  private readonly osc2ToCutoff: GainNode; // OSC 2 audio-rate FM of cutoff
  private readonly kbToCutoff: GainNode; // KB TRACKING: keyboard pitch (1 vv/oct) -> cutoff CV
  private readonly modFenvOsc2Freq: GainNode; // MOD DEST: filter EG -> OSC 2 pitch
  private readonly modFenvOsc2Wave: GainNode; // MOD DEST: filter EG -> OSC 2 waveshape
  private readonly modFenvSubWave: GainNode; // MOD DEST: filter EG -> SUB waveshape

  // FM / sync between oscillators
  private readonly fmAmount: GainNode;
  private readonly hardSyncGain: GainNode;

  // velocity (U4): one ConstantSource carrying the note-on velocity in vv (0..5) into the FILTER EG
  // input 1 (which always reads it — useVelocity seeded true). COU_F_ENV_VEL gates the velBus VALUE:
  // ON => note velocity scales the filter-EG peak; OFF => pinned to FULL (5 vv = full peak). The amp
  // EG never reads this bus — amp velocity stays G1's velocityGain node (no double-apply).
  private readonly velBus: ConstantSourceNode;

  // VCA
  private readonly vcaGainNode: GainNode;
  private readonly velocityGain: GainNode; // G1: per-note velocity SCALE on the EG->vcaCtl path (default unity)
  private readonly ampVca: GainNode; // LFO 2 AMP-destination tremolo
  private readonly volume: GainNode;

  // LFO 1 wave selectors + destination amount gains
  private readonly lfo1WaveSel: { tri: GainNode; saw: GainNode; ramp: GainNode; sq: GainNode };
  private readonly lfo1Oscs: OscillatorNode[]; // the 4 real LFO 1 wave cores (RATE writes all four)
  private readonly lfo1Depth: GainNode; // bipolar depth
  private readonly lfo1ToCutoff: GainNode;
  private readonly lfo1ToOsc2Freq: GainNode;
  private readonly lfo1ToOsc1Wave: GainNode;
  private readonly lfo1ToSubWave: GainNode;
  private readonly lfo1Outs: GainNode[]; // the 4 vvScale out gains (osc -> out -> waveSel); KB RESET reconnects new oscs here
  private readonly lfo1Types: OscillatorType[]; // osc type per core (the RAMP inversion lives in the lfo1Outs gain sign)

  // LFO 2 destination amount gains
  private readonly lfo2Depth: GainNode;
  private readonly lfo2ToPitch: GainNode;
  private readonly lfo2ToCutoff: GainNode;
  private readonly lfo2ToAmp: GainNode;

  // transport-facing outs
  private readonly clockOut: ConstantSourceNode;

  // ---- mod-assign matrix (Phase B) ----------------------------------------
  // One pre-built scale-gain per (source x target); built once, never torn down. Each is wired
  // sourceTap -> scaleGain -> targetNode(/param). setModAssign only mutates `.gain.value` to
  // modGain(depth, spec) for the assigned pair (else 0) — audio-rate, like applyLfo1Dest.
  private readonly modScaleGains: Record<CourierModSource, Record<string, GainNode>>;
  private readonly modRoutes: Record<CourierModSource, ModAssignEntry | null> = {
    kb: null,
    fEnv: null,
    aEnv: null,
    lfo1: null,
  };

  // cached panel state (for combined writes)
  private osc1OctaveVv = 0; // OSC 1 OCTAVE (8' default = 0)
  private tuneVv = 0; // master TUNE, vv
  private osc2OctaveVv = 0;
  private osc2DetuneVv = 0;
  private lfo1DepthValue = 0;
  private lfo1Dest: Lfo1Dest = 'CUTOFF';
  private lfo1RateHz = 2; // RATE knob in Hz (default matches the osc init freq); SYNC snaps it to tempo
  private lfo1Sync = false; // SYNC: lock the LFO 1 rate to the (LINK-aware) Courier transport tempo
  private lfo1Tempo = 120; // effective Courier BPM, pushed by the studio, used when SYNC is on
  lfo1KbReset = false; // KB RESET: retrigger LFO 1 phase on each key press (PUBLIC — studio reads it on note-on)
  // LFO 2 has no panel DEPTH knob on the hardware — its depth IS the mod wheel (the wheel alone
  // determines LFO 2 depth). So the effective depth = base × wheel; wheel parked down (0) = no
  // LFO 2, like a physical wheel at rest. lfo2BaseDepth stays a forward-compat hook for a future
  // panel DEPTH knob.
  private lfo2BaseDepth = 1; // full-scale LFO 2 depth base the mod wheel scales
  private modWheel01 = 0; // unipolar mod-wheel 0..1; default 0 = parked down = LFO 2 silent
  private lfo2Dest: Lfo2Dest = 'PITCH';
  multiTrig = false; // MULTI-TRIG: retrigger both EGs on every keypress (read by studio.courierNoteOn)
  private modAmountValue = 0;
  private modDest: 'FM_1_2' | 'FENV_OSC2_FREQ' | 'FENV_OSC2_WAVE' | 'FENV_SUB_WAVE' = 'FM_1_2';
  glideTimeS = 0.001;
  // U4 amp ENV VEL: gate over G1's velocityGain. Defaults ON to match courier.json's A ENV VEL
  // default and today's amp-velocity behavior (so the audio battery, which drives velocityAt
  // directly, is unchanged). When OFF, velocityGain is forced to unity (velocity ignored on the amp).
  private ampEnvVel = true;
  private lastVelGain = 1; // last velGain from velocityAt; re-applied when A ENV VEL is toggled back ON
  // U4 filter ENV VEL: defaults OFF (courier.json default). The egCore useVelocity gate exists (seeded
  // true on the filter EG so it always reads the velBus); this switch gates the velBus VALUE — OFF
  // pins it to FULL (5 vv = full peak, velocity ignored), ON passes the note velocity. Gating the
  // value (not an async configure message) keeps OFF/ON deterministic with no note-time race.
  private filterEnvVel = false;
  private lastVelVv = FULL_VEL_VV; // last note velocity in vv; re-applied when F ENV VEL is toggled ON

  constructor(ctx: BaseAudioContext, def: ModuleDef) {
    super(ctx, def);

    // ---- internal sources --------------------------------------------------
    const noise = createNoiseSource(ctx);
    this.registerInternal('COU_NOISE', noise.output);

    // ---- pitch bus ----------------------------------------------------------
    this.drift1 = new DriftSource(ctx);
    this.drift2 = new DriftSource(ctx);
    this.kbCv = constant(ctx, 0);
    this.kbGate = constant(ctx, 0);

    // shared pitch bus (keyboard note + EXP pedal pitch is not routed here; EXP is volume/mod)
    const pitchBus = gain(ctx, 1);
    this.pitchBus = pitchBus;
    this.kbCv.connect(pitchBus);
    // Pitch wheel: a constant bend offset (vv) summed onto the bus, INDEPENDENT of kbCv so a bend
    // adds to the held/scheduled note without clobbering setPitchAt's kbCv writes. (constant auto-starts.)
    this.pitchBend = constant(ctx, 0);
    this.pitchBend.connect(pitchBus);

    // ---- oscillators ---------------------------------------------------------
    const mkOsc = (): AudioWorkletNode =>
      new AudioWorkletNode(ctx, 'synthstack-osc', {
        numberOfInputs: 3,
        numberOfOutputs: 2,
        outputChannelCount: [1, 1],
      });
    this.osc1 = mkOsc();
    this.osc2 = mkOsc();
    this.sub = mkOsc();
    for (const o of [this.osc1, this.osc2, this.sub]) {
      o.parameters.get('frequency')!.value = PITCH_REF_HZ;
    }
    // engage the continuous waveshape morph on the main oscillators + the sub morph
    this.osc1.parameters.get('waveshape')!.value = 0.5; // saw default
    this.osc2.parameters.get('waveshape')!.value = 0.5;
    this.sub.parameters.get('subWave')!.value = 0; // triangle default
    this.osc2.parameters.get('linFmDepthHzPerVv')!.value = COU_FM_DEPTH_HZ_PER_VV;

    // OSC 1: pitch bus + octave/TUNE offset + drift
    this.osc1Octave = constant(ctx, 0);
    const osc1Pitch = gain(ctx, 1);
    pitchBus.connect(osc1Pitch);
    this.osc1Octave.connect(osc1Pitch);
    this.drift1.output.connect(osc1Pitch);
    osc1Pitch.connect(this.osc1, 0, 0);

    // SUB: rides OSC 1's pitch one octave below
    const subOffset = constant(ctx, -1); // −1 vv = one octave down
    const subPitch = gain(ctx, 1);
    osc1Pitch.connect(subPitch);
    subOffset.connect(subPitch);
    subPitch.connect(this.sub, 0, 0);

    // OSC 2: pitch bus + octave/detune offset + drift
    this.osc2Octave = constant(ctx, 0);
    const osc2Pitch = gain(ctx, 1);
    this.osc2Pitch = osc2Pitch;
    pitchBus.connect(osc2Pitch);
    this.osc2Octave.connect(osc2Pitch);
    this.drift2.output.connect(osc2Pitch);
    osc2Pitch.connect(this.osc2, 0, 0);

    // hard sync: OSC 1 sync pulses (output 1) -> OSC 2 sync input (input 2), gated
    this.hardSyncGain = gain(ctx, 0);
    this.osc1.connect(this.hardSyncGain, 1);
    this.hardSyncGain.connect(this.osc2, 0, 2);

    // linear FM 1->2: OSC 1 audio × FM amount -> OSC 2 linear FM input (input 1)
    this.fmAmount = gain(ctx, 0);
    this.osc1.connect(this.fmAmount, 0);
    this.fmAmount.connect(this.osc2, 0, 1);

    // ---- mixer --------------------------------------------------------------
    const mixSum = gain(ctx, 1);
    this.mixOsc1 = gain(ctx, 0.8);
    this.mixOsc2 = gain(ctx, 0.8);
    this.mixSub = gain(ctx, 0);
    this.mixNoise = gain(ctx, 0);
    this.mixFbExt = gain(ctx, 0);
    this.osc1.connect(this.mixOsc1, 0).connect(mixSum);
    this.osc2.connect(this.mixOsc2, 0).connect(mixSum);
    this.sub.connect(this.mixSub, 0).connect(mixSum);
    noise.output.connect(this.mixNoise).connect(mixSum);
    // FB / EXT channel: pattern-2 bus normalled from noise (router wires the normal edge)
    this.inputBus('COU_EXT_IN').connect(this.mixFbExt).connect(mixSum);

    // ---- ladder (multimode) -------------------------------------------------
    this.ladder = new AudioWorkletNode(ctx, 'synthstack-ladder', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { resScale: COURIER_RES_SCALE },
    });
    this.ladder.parameters.get('mode')!.value = 0; // LP4 default
    mixSum.connect(this.ladder, 0, 0);

    this.cutoffCvSum = gain(ctx, 1);
    this.cutoffCvSum.connect(this.ladder, 0, 1);
    // EXP pedal feeds the cutoff CV (assignable; default to cutoff per the jack notes)
    this.inputBus('COU_EXP_IN').connect(this.cutoffCvSum);
    // OSC 2 -> cutoff audio-rate FM (depth knob, 0..1)
    this.osc2ToCutoff = gain(ctx, 0);
    this.osc2.connect(this.osc2ToCutoff, 0).connect(this.cutoffCvSum);
    // KB TRACKING: keyboard pitch (kbCv, 1 vv/oct) summed into the cutoff CV so the filter follows
    // the keyboard. Gated 0/1 by the switch (default ON, set on first applyState). ladderCore reads
    // input-1 CV as 1 vv/oct, so gain 1 = full 1 V/oct tracking.
    this.kbToCutoff = gain(ctx, 1);
    this.kbCv.connect(this.kbToCutoff).connect(this.cutoffCvSum);

    // ---- EGs ----------------------------------------------------------------
    const mkEg = (): AudioWorkletNode => {
      const eg = new AudioWorkletNode(ctx, 'synthstack-eg', {
        numberOfInputs: 2,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: {
          attackS: 0.005,
          decayS: 0.3,
          sustainMode: 'adsr', // Courier runs the full four-stage envelope (see egCore)
          retrigInAttack: false,
          attackCompletes: true,
          peakVv: 8,
          sustainLevel: 0.8,
          releaseS: 0.2,
          // U4: the FILTER EG reads velocity from the velBus; the AMP EG's velocity input is never
          // wired (amp velocity = G1's velocityGain). egCore's useVelocity gate is seeded TRUE so the
          // filter EG ALWAYS reads the velBus deterministically (an async configure to flip it on at
          // note time races the attack in an offline render). F ENV VEL OFF/ON is enforced at the
          // velBus VALUE instead: OFF pins it to FULL (5 vv = full peak), ON passes the note velocity.
          // (The amp EG never has input 1 connected, so seeding it true is a harmless no-op there.)
          useVelocity: true,
        },
      });
      // The worklet reads the k-rate AudioParams (attackS/releaseS) every block, which would
      // otherwise override the processorOptions seed with the param default — pin both to the
      // panel defaults until the SUSTAIN/RELEASE controls write through on applyState.
      eg.parameters.get('attackS')!.value = 0.005;
      eg.parameters.get('releaseS')!.value = 0.2;
      return eg;
    };
    this.filterEg = mkEg();
    this.ampEg = mkEg();

    // gate wiring: KB gate + SUSTAIN pedal hold the EGs (velocity on input 1)
    const gateBus = gain(ctx, 1);
    this.kbGate.connect(gateBus);
    this.inputBus('COU_SUSTAIN_IN').connect(gateBus);
    gateBus.connect(this.filterEg, 0, 0);
    gateBus.connect(this.ampEg, 0, 0);

    // U4 velocity bus -> FILTER EG input 1 (velocity in vv 0..5). The filter EG always reads it
    // (useVelocity seeded true); COU_F_ENV_VEL gates the velBus VALUE (ON = note velocity, OFF = FULL).
    // The amp EG's velocity input is intentionally left unwired so amp velocity stays the single G1
    // velocityGain path (no double-apply). Seed FULL (5 vv): a non-live note (sequencer/arp never calls
    // velocityAt) sees full filter-EG peak, and a non-zero seed keeps input 1 continuously driven (a
    // 0-seeded ConstantSource reads as a silent/empty input in the worklet, so setVelocity wouldn't run).
    this.velBus = constant(ctx, FULL_VEL_VV);
    this.velBus.connect(this.filterEg, 0, 1);

    // filter EG -> cutoff (bipolar amount)
    this.filterEgAmt = gain(ctx, 0);
    this.filterEg.connect(this.filterEgAmt).connect(this.cutoffCvSum);

    // MOD DEST filter-EG destinations (independent of the Phase-B mod-assign matrix). Each routes
    // the filter EG (0..peakVv=8) to a target, gated by applyModDest at a scale × MOD AMOUNT. These
    // are the three non-FM positions of the MOD DESTINATION switch that were previously dead.
    this.modFenvOsc2Freq = gain(ctx, 0);
    this.filterEg.connect(this.modFenvOsc2Freq).connect(this.osc2Pitch);
    this.modFenvOsc2Wave = gain(ctx, 0);
    this.filterEg.connect(this.modFenvOsc2Wave).connect(this.osc2.parameters.get('waveshape')!);
    this.modFenvSubWave = gain(ctx, 0);
    this.filterEg.connect(this.modFenvSubWave).connect(this.sub.parameters.get('subWave')!);

    // ---- LFO 1 (panel mod) — four REAL wave cores, one per WAVE position, gated 0/1 --------
    // The WAVESHAPE switch selects triangle / sawtooth / ramp (falling saw) / square. Each is a
    // native OscillatorNode scaled to ±5 vv; only the selected position's gain is 1, so switching
    // WAVE actually changes the shape (previously all four tapped one triangle = no change).
    const mkLfo1 = (type: OscillatorType, vvScale: number): { osc: OscillatorNode; out: GainNode } => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = 2;
      osc.start();
      const out = gain(ctx, vvScale); // native ±1 -> ±5 vv (ramp = inverted saw)
      osc.connect(out);
      return { osc, out };
    };
    const lfo1Tri = mkLfo1('triangle', 5);
    const lfo1Saw = mkLfo1('sawtooth', 5);
    const lfo1Ramp = mkLfo1('sawtooth', -5); // RAMP = falling saw (inverted)
    const lfo1Sq = mkLfo1('square', 5);
    this.lfo1 = lfo1Tri.osc; // construction-time handle only; NOT read at runtime and NOT updated by
    // retriggerLfo1 (the live cores are always lfo1Oscs[]). RATE/SYNC writes go through lfo1Oscs.
    this.lfo1Oscs = [lfo1Tri.osc, lfo1Saw.osc, lfo1Ramp.osc, lfo1Sq.osc];
    this.lfo1Outs = [lfo1Tri.out, lfo1Saw.out, lfo1Ramp.out, lfo1Sq.out]; // KB RESET reconnects fresh oscs here
    this.lfo1Types = ['triangle', 'sawtooth', 'sawtooth', 'square']; // RAMP = inverted saw (sign lives in lfo1Outs)
    this.lfo1WaveSel = {
      tri: gain(ctx, 1),
      saw: gain(ctx, 0),
      ramp: gain(ctx, 0),
      sq: gain(ctx, 0),
    };
    const lfo1Sel = gain(ctx, 1);
    lfo1Tri.out.connect(this.lfo1WaveSel.tri).connect(lfo1Sel);
    lfo1Saw.out.connect(this.lfo1WaveSel.saw).connect(lfo1Sel);
    lfo1Ramp.out.connect(this.lfo1WaveSel.ramp).connect(lfo1Sel);
    lfo1Sq.out.connect(this.lfo1WaveSel.sq).connect(lfo1Sel);
    this.lfo1Depth = gain(ctx, 0); // bipolar depth
    lfo1Sel.connect(this.lfo1Depth);
    // destination router (only the selected destination gain is non-zero)
    this.lfo1ToCutoff = gain(ctx, 0);
    this.lfo1ToOsc2Freq = gain(ctx, 0);
    this.lfo1ToOsc1Wave = gain(ctx, 0);
    this.lfo1ToSubWave = gain(ctx, 0);
    this.lfo1Depth.connect(this.lfo1ToCutoff).connect(this.cutoffCvSum);
    this.lfo1Depth.connect(this.lfo1ToOsc2Freq).connect(osc2Pitch);
    // wave-morph destinations need a small scale onto the 0..1 a-rate params
    const lfo1WaveScale = gain(ctx, 1 / 5); // ±5 vv -> ±1 morph
    this.lfo1Depth.connect(this.lfo1ToOsc1Wave).connect(lfo1WaveScale);
    lfo1WaveScale.connect(this.osc1.parameters.get('waveshape')!);
    const lfo1SubScale = gain(ctx, 1 / 5);
    this.lfo1Depth.connect(this.lfo1ToSubWave).connect(lfo1SubScale);
    lfo1SubScale.connect(this.sub.parameters.get('subWave')!);

    // ---- LFO 2 (left-hand wheel mod) ---------------------------------------
    this.lfo2 = ctx.createOscillator();
    this.lfo2.type = 'triangle';
    this.lfo2.frequency.value = 4;
    this.lfo2.start();
    const lfo2Out = gain(ctx, 5);
    this.lfo2.connect(lfo2Out);
    this.lfo2Depth = gain(ctx, 0);
    lfo2Out.connect(this.lfo2Depth);
    this.lfo2ToPitch = gain(ctx, 0);
    this.lfo2ToCutoff = gain(ctx, 0);
    this.lfo2ToAmp = gain(ctx, 0);
    this.lfo2Depth.connect(this.lfo2ToPitch).connect(pitchBus);
    this.lfo2Depth.connect(this.lfo2ToCutoff).connect(this.cutoffCvSum);

    // ---- VCA ----------------------------------------------------------------
    const vcaEgNorm = gain(ctx, 1 / 8); // peakVv 8 -> 0..1
    const vcaShape = shaper(ctx, (x) => Math.pow(clamp(x, 0, 1), 1.3));
    this.ampEg.connect(vcaEgNorm).connect(vcaShape);
    const vcaCtl = gain(ctx, 0.5); // into the 0..1 shaper domain
    // G1 (velocity -> VCA): velocity SCALES the amp-EG contribution rather than summing a parallel DC
    // offset. A per-note velocity GAIN (default UNITY — the sequencer/arp never calls velocityAt, so
    // that path is unchanged) sits on the EG->vcaCtl path; velocityAt sets it at note-on. Because it
    // only multiplies the already-decaying envelope, once the EG reaches 0 the velocity term is 0 too
    // (no residual oscillator bleed after note-off) and there is no note-off click. EARS: vel 100 =
    // unity (today's level); the curve/range is a by-ear knob (see units.velocityToGain).
    this.velocityGain = gain(ctx, 1);
    vcaShape.connect(this.velocityGain).connect(vcaCtl);
    const vcaClip = shaper(ctx, (x) => {
      const g = clamp(x, 0, 1) * 2;
      return g <= 1 ? g : 1 + 0.2 * Math.tanh((g - 1) / 0.2);
    });
    vcaCtl.connect(vcaClip);
    this.vcaGainNode = gain(ctx, 0);
    vcaClip.connect(this.vcaGainNode.gain);
    // LFO 2 AMP destination: a ×(1 ± depth) tremolo stage after the VCA
    this.ampVca = gain(ctx, 1);
    this.lfo2ToAmp.gain.value = 0;
    this.lfo2Depth.connect(this.lfo2ToAmp);
    const ampTremScale = gain(ctx, 1 / 5); // ±5 vv -> ±1 around unity
    this.lfo2ToAmp.connect(ampTremScale).connect(this.ampVca.gain);
    this.volume = gain(ctx, 0.7);
    this.ladder.connect(this.vcaGainNode).connect(this.ampVca).connect(this.volume);

    // ---- outs ---------------------------------------------------------------
    this.volume.connect(this.outputTap('COU_AUDIO_OUT')); // main out to the mixer (A6 wires the channel)
    this.ampVca.connect(this.outputTap('COU_VCA_OUT')); // post-VCA tap, pre-VOLUME
    this.kbCv.connect(this.outputTap('COU_CV_OUT')); // 1 vv/oct keyboard pitch CV out
    this.kbGate.connect(this.outputTap('COU_GATE_OUT')); // key gate out
    this.clockOut = constant(ctx, 0);
    this.clockOut.connect(this.outputTap('COU_CLOCK_OUT'));

    // ---- mod-assign matrix: pre-build every (source x target) scale-gain ----
    // sourceTap -> scaleGain(0) -> targetNode/param. The per-target scale (incl. the x1/5 for the
    // wave-morph params) is folded into modGain(depth, spec), so each scaleGain connects directly.
    const modSourceTaps: Record<CourierModSource, AudioNode> = {
      kb: this.kbCv,
      fEnv: this.filterEg,
      aEnv: this.ampEg,
      lfo1: this.lfo1Depth, // rides the panel LFO1 DEPTH knob
    };
    const modTargetNodes: Record<ModBus, AudioNode | AudioParam> = {
      cutoff: this.cutoffCvSum,
      pitch: this.pitchBus,
      osc2pitch: this.osc2Pitch,
      osc1wave: this.osc1.parameters.get('waveshape')!,
      osc2wave: this.osc2.parameters.get('waveshape')!,
      subwave: this.sub.parameters.get('subWave')!,
    };
    this.modScaleGains = { kb: {}, fEnv: {}, aEnv: {}, lfo1: {} };
    for (const src of COURIER_MOD_SOURCES) {
      for (const spec of MOD_TARGETS) {
        const sg = gain(ctx, 0);
        modSourceTaps[src].connect(sg);
        // AudioParam and AudioNode both accept .connect()'s destination overload here.
        sg.connect(modTargetNodes[spec.bus] as AudioNode);
        this.modScaleGains[src][spec.controlId] = sg;
      }
    }

    this.drift1.start();
    this.drift2.start();
  }

  /** Power-off teardown: stop the per-VCO drift random-walk timers (re-armed on power-cycle). */
  stopDrift(): void {
    this.drift1.stop();
    this.drift2.stop();
  }

  private applyOsc1Pitch(): void {
    this.osc1Octave.offset.value = this.osc1OctaveVv + this.tuneVv;
  }
  private applyOsc2Pitch(): void {
    this.osc2Octave.offset.value = this.osc2OctaveVv + this.tuneVv + this.osc2DetuneVv;
  }
  private applyLfo1Dest(): void {
    this.lfo1Depth.gain.value = this.lfo1DepthValue;
    this.lfo1ToCutoff.gain.value = this.lfo1Dest === 'CUTOFF' ? 1 : 0;
    this.lfo1ToOsc2Freq.gain.value = this.lfo1Dest === 'OSC2_FREQ' ? 1 : 0;
    this.lfo1ToOsc1Wave.gain.value = this.lfo1Dest === 'OSC1_WAVE' ? 1 : 0;
    this.lfo1ToSubWave.gain.value = this.lfo1Dest === 'SUB_WAVE' ? 1 : 0;
  }

  /** Effective LFO 1 frequency (Hz): the raw RATE knob value, or — when SYNC is on — snapped to the
   *  nearest power-of-two multiple/division of the beat (lfo1Tempo bpm) so the LFO locks to the clock. */
  private effectiveLfo1Freq(): number {
    if (!this.lfo1Sync) return this.lfo1RateHz;
    const beatHz = this.lfo1Tempo / 60;
    if (!(beatHz > 0)) return this.lfo1RateHz;
    const pow = clamp(Math.round(Math.log2(Math.max(this.lfo1RateHz, 1e-4) / beatHz)), -4, 4);
    return beatHz * Math.pow(2, pow);
  }

  /** Apply the effective LFO 1 frequency to all four wave cores (immediate). */
  private applyLfo1Rate(): void {
    const f = this.effectiveLfo1Freq();
    for (const o of this.lfo1Oscs) o.frequency.value = f;
  }

  /** SYNC tempo feed: the studio pushes the live (LINK-aware) Courier BPM here; re-snaps the rate
   *  when SYNC is on, and is a cheap store otherwise. */
  setLfo1Tempo(bpm: number): void {
    this.lfo1Tempo = bpm;
    if (this.lfo1Sync) this.applyLfo1Rate();
  }

  /** KB RESET: restart LFO 1 from phase 0 at `time`. Native OscillatorNodes have no phase param, so
   *  each of the four wave cores is replaced by a fresh oscillator started at `time` (phase 0); the
   *  vvScale out gains + the wave-select/depth/dest chain are reused, so only the four sources swap. */
  retriggerLfo1(time: number): void {
    const f = this.effectiveLfo1Freq();
    for (let i = 0; i < this.lfo1Oscs.length; i++) {
      const old = this.lfo1Oscs[i]!;
      const osc = this.ctx.createOscillator();
      osc.type = this.lfo1Types[i]!;
      osc.frequency.value = f;
      osc.connect(this.lfo1Outs[i]!);
      osc.start(time);
      try {
        old.stop(time);
      } catch {
        /* already stopped — ignore */
      }
      // `time` is always in the future (courierNoteOn uses currentTime + 0.03/+0.001), so `ended`
      // cannot have fired before this handler is attached — the old node is disconnected on stop.
      old.onended = () => {
        try {
          old.disconnect();
        } catch {
          /* already gone */
        }
      };
      this.lfo1Oscs[i] = osc;
    }
  }
  private applyLfo2Dest(): void {
    this.lfo2Depth.gain.value = this.lfo2BaseDepth * this.modWheel01; // mod wheel is the sole depth source

    this.lfo2ToPitch.gain.value = this.lfo2Dest === 'PITCH' ? 1 : 0;
    this.lfo2ToCutoff.gain.value = this.lfo2Dest === 'CUTOFF' ? 1 : 0;
    this.lfo2ToAmp.gain.value = this.lfo2Dest === 'AMP' ? 1 : 0;
  }
  /** MOD AMOUNT + MOD DEST: FM 1->2, or filter-EG into OSC 2 freq / OSC 2 wave / SUB wave. Only the
   *  selected destination's gain is non-zero; MOD AMOUNT (bipolar) scales it. The filter-EG scales
   *  (1/4 to pitch ≈ ±2 oct at full; 1/8 to a wave param = 0..1 morph) are by-ear-tunable depths. */
  private applyModDest(): void {
    const amt = this.modAmountValue;
    this.fmAmount.gain.value = this.modDest === 'FM_1_2' ? amt : 0;
    this.modFenvOsc2Freq.gain.value = this.modDest === 'FENV_OSC2_FREQ' ? amt * (1 / 4) : 0;
    this.modFenvOsc2Wave.gain.value = this.modDest === 'FENV_OSC2_WAVE' ? amt * (1 / 8) : 0;
    this.modFenvSubWave.gain.value = this.modDest === 'FENV_SUB_WAVE' ? amt * (1 / 8) : 0;
  }

  /** OSC octave foot setting (16'/8'/4'/2') -> vv offset. 8' is the 0-reference. */
  private octaveVv(pos: string): number {
    switch (pos) {
      case '16': return -1;
      case '8': return 0;
      case '4': return 1;
      case '2': return 2;
      default: return 0;
    }
  }

  setControl(id: string, value: number | string): void {
    const num = typeof value === 'number' ? value : 0;
    switch (id) {
      // ---- LFO 1 ----
      case 'COU_LFO1_RATE':
        this.lfo1RateHz = num;
        this.applyLfo1Rate(); // SYNC may snap this to the tempo grid; else it is the raw knob Hz
        break;
      case 'COU_LFO1_WAVE':
        this.lfo1WaveSel.tri.gain.value = value === 'TRI' ? 1 : 0;
        this.lfo1WaveSel.saw.gain.value = value === 'SAW' ? 1 : 0;
        this.lfo1WaveSel.ramp.gain.value = value === 'RAMP' ? 1 : 0;
        this.lfo1WaveSel.sq.gain.value = value === 'SQ' ? 1 : 0;
        break;
      case 'COU_LFO1_DEPTH':
        this.lfo1DepthValue = num;
        this.applyLfo1Dest();
        break;
      case 'COU_LFO1_DEST':
        this.lfo1Dest = value as Lfo1Dest;
        this.applyLfo1Dest();
        break;
      case 'COU_LFO1_SYNC':
        // SYNC: lock the LFO 1 rate to the (LINK-aware) Courier tempo. The studio pushes the live BPM
        // via setLfo1Tempo; applyLfo1Rate snaps the knob Hz to the nearest power-of-two of the beat.
        this.lfo1Sync = value === 'ON';
        this.applyLfo1Rate();
        break;
      case 'COU_LFO1_KB_RESET':
        // KB RESET: arm the per-key-press LFO 1 phase retrigger; the studio calls retriggerLfo1 on note-on.
        this.lfo1KbReset = value === 'ON';
        break;

      // ---- OSC 1 / SUB ----
      case 'COU_OSC1_OCTAVE':
        this.osc1OctaveVv = this.octaveVv(value as string);
        this.applyOsc1Pitch();
        break;
      case 'COU_TUNE':
        this.tuneVv = num / 12; // semitones -> vv (1 vv = 12 st)
        this.applyOsc1Pitch();
        this.applyOsc2Pitch();
        break;
      case 'COU_SUB_WAVE':
        this.sub.parameters.get('subWave')!.value = num;
        break;
      case 'COU_OSC1_WAVESHAPE':
        this.osc1.parameters.get('waveshape')!.value = num;
        break;

      // ---- OSC 2 ----
      case 'COU_OSC2_OCTAVE':
        this.osc2OctaveVv = this.octaveVv(value as string);
        this.applyOsc2Pitch();
        break;
      case 'COU_OSC2_FREQ':
        this.osc2DetuneVv = num / 12; // semitones -> vv
        this.applyOsc2Pitch();
        break;
      case 'COU_OSC2_WAVESHAPE':
        this.osc2.parameters.get('waveshape')!.value = num;
        break;
      case 'COU_SYNC':
        this.hardSyncGain.gain.value = value === 'ON' ? 1 : 0;
        break;
      case 'COU_MOD_AMOUNT':
        this.modAmountValue = num;
        this.applyModDest();
        break;
      case 'COU_MOD_DEST':
        this.modDest = value as 'FM_1_2' | 'FENV_OSC2_FREQ' | 'FENV_OSC2_WAVE' | 'FENV_SUB_WAVE';
        this.applyModDest();
        break;

      // ---- mixer ----
      case 'COU_MIX_OSC1':
        this.mixOsc1.gain.value = num;
        break;
      case 'COU_MIX_OSC2':
        this.mixOsc2.gain.value = num;
        break;
      case 'COU_MIX_SUB':
        this.mixSub.gain.value = num;
        break;
      case 'COU_MIX_NOISE':
        this.mixNoise.gain.value = num;
        break;
      case 'COU_MIX_FB_EXT':
        this.mixFbExt.gain.value = num;
        break;

      // ---- filter ----
      case 'COU_CUTOFF':
        this.ladder.parameters.get('cutoffHz')!.value = num;
        break;
      case 'COU_EG_AMOUNT':
        this.filterEgAmt.gain.value = num;
        break;
      case 'COU_OSC2_CUTOFF':
        this.osc2ToCutoff.gain.value = num * OSC2_CUTOFF_DEPTH;
        break;
      case 'COU_RESONANCE':
        this.ladder.parameters.get('resonance')!.value = num;
        break;
      case 'COU_RES_BASS':
        this.ladder.parameters.get('resBass')!.value = value === 'ON' ? 1 : 0;
        break;
      case 'COU_KB_TRACKING':
        this.kbToCutoff.gain.value = value === 'ON' ? 1 : 0; // 1 vv/oct keyboard -> cutoff tracking
        break;
      case 'COU_FILTER_MODE':
        // LP4=0, HP=1, LP2=2, BP=3 (ladder MODE_TABLE encoding)
        this.ladder.parameters.get('mode')!.value =
          value === 'HP' ? 1 : value === 'LP2' ? 2 : value === 'BP' ? 3 : 0;
        break;

      // ---- filter EG ----
      case 'COU_F_ATTACK':
        this.filterEg.parameters.get('attackS')!.value = num;
        break;
      case 'COU_F_DECAY':
        this.filterEg.parameters.get('decayS')!.value = num;
        break;
      case 'COU_F_RELEASE':
        this.filterEg.parameters.get('releaseS')!.value = num;
        break;
      case 'COU_F_SUSTAIN':
        this.filterEg.port.postMessage({ type: 'configure', config: { sustainLevel: num } });
        break;
      case 'COU_F_ENV_VEL':
        // U4: ON makes the note-on velocity scale the FILTER EG peak — a higher velocity opens the
        // filter envelope further. The filter EG always reads the velBus (useVelocity seeded true);
        // this switch gates the velBus VALUE so the behavior is deterministic (no async-configure
        // race at note time): ON => the last note's velocity, OFF => FULL (5 vv = full peak, velocity
        // ignored). EARS: this scales the EG PEAK, not a separate EG-AMOUNT depth; the depth and
        // whether-peak-vs-amount is a by-ear call for the operator (see U4 spec EARS note).
        this.filterEnvVel = value === 'ON';
        this.velBus.offset.value = this.filterEnvVel ? this.lastVelVv : FULL_VEL_VV;
        break;
      case 'COU_F_ENV_LOOP':
        this.filterEg.port.postMessage({ type: 'configure', config: { loop: value === 'ON' } });
        break;

      // ---- amp EG ----
      case 'COU_A_ATTACK':
        this.ampEg.parameters.get('attackS')!.value = num;
        break;
      case 'COU_A_DECAY':
        this.ampEg.parameters.get('decayS')!.value = num;
        break;
      case 'COU_A_RELEASE':
        this.ampEg.parameters.get('releaseS')!.value = num;
        break;
      case 'COU_A_SUSTAIN':
        this.ampEg.port.postMessage({ type: 'configure', config: { sustainLevel: num } });
        break;
      case 'COU_A_ENV_VEL':
        // U4: gate over G1's velocityGain. ON = re-apply the last note's velGain (velocity scales the
        // amp EG level, today's behavior); OFF = force the velocityGain node to unity so amp level is
        // independent of velocity. This GATES the one existing amp-velocity path — it never drives the
        // amp EG's worklet velocity input, so there is no double-apply.
        this.ampEnvVel = value === 'ON';
        this.velocityGain.gain.value = this.ampEnvVel ? this.lastVelGain : 1;
        break;
      case 'COU_A_ENV_LOOP':
        this.ampEg.port.postMessage({ type: 'configure', config: { loop: value === 'ON' } });
        break;
      case 'COU_MULTI_TRIG':
        // multi-trig (retrigger on every key): the flag drives studio.courierNoteOn to force a gate
        // edge on legato (a held-gate keypress); retrigInAttack covers a rising edge mid-attack.
        this.multiTrig = value === 'ON';
        this.filterEg.port.postMessage({ type: 'configure', config: { retrigInAttack: this.multiTrig } });
        this.ampEg.port.postMessage({ type: 'configure', config: { retrigInAttack: this.multiTrig } });
        break;

      // ---- global ----
      case 'COU_VOLUME':
        this.volume.gain.value = num;
        break;
      case 'COU_GLIDE':
        this.glideTimeS = num;
        break;

      // ---- LFO 2 ----
      case 'COU_LFO2_RATE':
        this.lfo2.frequency.value = num;
        break;
      case 'COU_LFO2_DEST':
        this.lfo2Dest = value as Lfo2Dest;
        this.applyLfo2Dest();
        break;

      default:
        break; // sequencer/arp controls handled by the transport (deferred)
    }
  }

  /**
   * Assign (or clear) one mod SOURCE's single route. Mirrors applyLfo1Dest: for the given source,
   * walk every supported target and set its pre-built scale-gain to modGain(depth, spec) when the
   * route targets that control, else 0. Idempotent; no node teardown. `entry=null` clears (all 0).
   * Unsupported / unknown controlIds are a safe no-op (no spec matches -> every pair stays 0).
   */
  setModAssign(source: CourierModSource, entry: ModAssignEntry | null): void {
    this.modRoutes[source] = entry;
    const gains = this.modScaleGains[source];
    for (const spec of MOD_TARGETS) {
      const g = gains[spec.controlId];
      if (!g) continue; // every spec.controlId is pre-built in the constructor; guard for safety
      g.gain.value = entry && entry.controlId === spec.controlId ? modGain(entry.depth, spec) : 0;
    }
  }

  // ---- transport binding surface ----------------------------------------------

  /**
   * Set keyboard pitch CV at an exact time, with optional glide (mirrors the Monarch).
   *   `glideTimeSOverride` (G1): when provided, glide uses THIS time instead of `this.glideTimeS` —
   *   DEFAULTS to `this.glideTimeS` so the sequencer/arp binder is untouched (only the keyboard/MIDI
   *   live path passes the separate keyboard-glide value).
   */
  setPitchAt(noteVv: number, time: number, glide: boolean, glideTimeSOverride?: number): void {
    const glideS = glideTimeSOverride ?? this.glideTimeS;
    const p = this.kbCv.offset;
    p.cancelAndHoldAtTime?.(time);
    if (glide && glideS > 0.001) {
      p.setTargetAtTime(noteVv, time, glideS / 3);
    } else {
      p.setValueAtTime(noteVv, time);
    }
  }

  /** Set the keyboard gate (0/5 vv) at an exact time. */
  gateAt(on: boolean, time: number): void {
    this.kbGate.offset.setValueAtTime(on ? 5 : 0, time);
  }

  /**
   * Set the note-on VELOCITY at an exact time (mirrors gateAt / the Monarch). `velGain` is the
   * velocity already mapped to a GAIN by units.velocityToGain (unity at 100). It SCALES the
   * amp-EG->vcaCtl contribution, so vel=100 = unity (today's level), louder = hotter, quieter =
   * softer — and since it only scales the (decaying) envelope, NO velocity reset is needed on
   * note-off (the EG returns the VCA to silence; no residual bleed, no click). Only the
   * keyboard/MIDI live path drives this; the sequencer/arp leaves the gain at unity (unchanged).
   */
  velocityAt(velGain: number, time: number): void {
    // Amp velocity (G1): SCALE the EG->vcaCtl path, but only when A ENV VEL is armed (U4). When OFF
    // force unity so the amp level is velocity-independent. lastVelGain is cached so toggling A ENV
    // VEL back ON re-applies this note's velocity.
    this.lastVelGain = velGain;
    this.velocityGain.gain.setValueAtTime(this.ampEnvVel ? velGain : 1, time);
    // Filter velocity (U4): drive the velBus that feeds the filter EG input 1 (vv 0..5). Map the G1
    // velGain (≈0.25..1.3, unity at vel100) to vv so the reference velocity = full peak (vv 5): vv =
    // clamp(velGain*FULL, 0, FULL). Louder velocities pin to full peak; softer ones scale the filter
    // envelope down. Only applied when F ENV VEL is ON; OFF keeps the velBus at FULL (full peak). The
    // value is cached so toggling F ENV VEL ON later re-applies this note's velocity.
    const velVv = velGain * FULL_VEL_VV;
    this.lastVelVv = velVv < 0 ? 0 : velVv > FULL_VEL_VV ? FULL_VEL_VV : velVv;
    this.velBus.offset.setValueAtTime(this.filterEnvVel ? this.lastVelVv : FULL_VEL_VV, time);
  }

  /** PITCH WHEEL: live bend in SEMITONES (vv = semitones/12), summed onto the pitch bus so all
   *  oscillators bend together (per the hardware reference). Runtime/transient; not scheduled. */
  setPitchBend(semitones: number): void {
    this.pitchBend.offset.setTargetAtTime(clamp(semitones, -24, 24) / 12, this.ctx.currentTime, 0.005);
  }

  /** MOD WHEEL (left-hand, unipolar 0..1): scales LFO 2 depth into the selected DEST. Wheel up (1)
   *  = full programmed depth, down (0) = no LFO 2. Holds its value (non-spring). */
  setModWheel(amount01: number): void {
    this.modWheel01 = clamp(amount01, 0, 1);
    this.applyLfo2Dest();
  }

  /** Internal clock out: one +10 vv pulse (2 ms) at `time`. */
  clockPulseAt(time: number): void {
    this.clockOut.offset.setValueAtTime(10, time);
    this.clockOut.offset.setValueAtTime(0, time + 0.002);
  }

  /**
   * Time-scheduled control set for per-step PARAM LOCKS (Phase C-Full). The sequencer binder
   * applies a step's lock at the step's EXACT audio time (e.time), not at bind time (which can be
   * up to SCHEDULE_AHEAD_S ~100 ms early on the lookahead). Only the six lockable targets reach
   * here (the binder allow-lists via findModTarget). `value` is engine-native (Hz for CUTOFF,
   * semitones for TUNE/OSC2_FREQ, 0..1 morphs) — exactly what setControl expects, no conversion.
   *
   * Most lockable targets are clean single-AudioParam (or single GainNode.gain) writes ->
   * sample-accurate setValueAtTime. The exceptions recompute a combined bus from cached JS fields
   * (COU_TUNE / COU_OSC2_FREQ via applyOsc*Pitch, COU_LFO1_DEPTH via applyLfo1Dest) or store a
   * plain JS scalar (COU_GLIDE); for those we fall back to the IMMEDIATE setControl. CAVEAT: those
   * fallback locks land at bind time, up to the lookahead early (~100 ms) — audible only on fast
   * sequences; GLIDE additionally only takes effect on the NEXT note. All the high-traffic targets
   * (cutoff, resonance, the waveshapes, mixers, volume, EG amount, LFO rates) are sample-accurate.
   */
  setControlAt(id: string, value: number, time: number): void {
    switch (id) {
      // ---- filter (sample-accurate AudioParams) ----
      case 'COU_CUTOFF':
        this.ladder.parameters.get('cutoffHz')!.setValueAtTime(value, time);
        break;
      case 'COU_RESONANCE':
        this.ladder.parameters.get('resonance')!.setValueAtTime(value, time);
        break;
      case 'COU_EG_AMOUNT':
        this.filterEgAmt.gain.setValueAtTime(value, time);
        break;
      case 'COU_OSC2_CUTOFF':
        this.osc2ToCutoff.gain.setValueAtTime(value * OSC2_CUTOFF_DEPTH, time);
        break;
      // ---- oscillator waveshapes (sample-accurate AudioParams) ----
      case 'COU_OSC1_WAVESHAPE':
        this.osc1.parameters.get('waveshape')!.setValueAtTime(value, time);
        break;
      case 'COU_OSC2_WAVESHAPE':
        this.osc2.parameters.get('waveshape')!.setValueAtTime(value, time);
        break;
      case 'COU_SUB_WAVE':
        this.sub.parameters.get('subWave')!.setValueAtTime(value, time);
        break;
      // ---- mixer (sample-accurate GainNode.gain) ----
      case 'COU_MIX_OSC1':
        this.mixOsc1.gain.setValueAtTime(value, time);
        break;
      case 'COU_MIX_OSC2':
        this.mixOsc2.gain.setValueAtTime(value, time);
        break;
      case 'COU_MIX_SUB':
        this.mixSub.gain.setValueAtTime(value, time);
        break;
      case 'COU_MIX_NOISE':
        this.mixNoise.gain.setValueAtTime(value, time);
        break;
      // ---- global / LFO rates (sample-accurate) ----
      case 'COU_VOLUME':
        this.volume.gain.setValueAtTime(value, time);
        break;
      case 'COU_LFO1_RATE': {
        this.lfo1RateHz = value;
        const f = this.effectiveLfo1Freq(); // SYNC snaps to the tempo grid; else the raw value
        for (const o of this.lfo1Oscs) o.frequency.setValueAtTime(f, time);
        break;
      }
      case 'COU_LFO2_RATE':
        this.lfo2.frequency.setValueAtTime(value, time);
        break;
      // ---- immediate fallback (recompute-a-bus / JS-scalar targets; ~lookahead early) ----
      // COU_TUNE / COU_OSC2_FREQ recompute combined pitch buses; COU_LFO1_DEPTH recomputes via
      // applyLfo1Dest; COU_GLIDE stores a JS scalar (effective next note). All routed through the
      // immediate setControl, mirroring the pitch-bus pattern.
      case 'COU_TUNE':
      case 'COU_OSC2_FREQ':
      case 'COU_LFO1_DEPTH':
      case 'COU_GLIDE':
      default:
        this.setControl(id, value);
    }
  }
}
