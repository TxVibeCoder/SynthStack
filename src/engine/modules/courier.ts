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
 * re-attacks the gated envelope as an LFO. (Velocity scaling of the EGs — F/A ENV VEL — still
 * awaits a Courier velocity bus; those two toggles remain stored-only for now.)
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

  // VCA
  private readonly vcaGainNode: GainNode;
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
    this.lfo1 = lfo1Tri.osc; // primary handle (the four share one RATE, written to all of lfo1Oscs)
    this.lfo1Oscs = [lfo1Tri.osc, lfo1Saw.osc, lfo1Ramp.osc, lfo1Sq.osc];
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
    vcaShape.connect(vcaCtl);
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
        for (const o of this.lfo1Oscs) o.frequency.value = num;
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
        // graph shell: clock-sync of the LFO rate is a transport binding (deferred).
        break;
      case 'COU_LFO1_KB_RESET':
        // graph shell: phase reset on key press is a binding hook (deferred).
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
        // velocity routing: when ON, the velocity input would scale the EG (Anvil-style). Courier
        // has no velocity bus yet, so this toggle is stored-only — see the velocity workstream.
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
        break; // see COU_F_ENV_VEL (Courier velocity bus deferred to the velocity workstream)
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

  /** Set keyboard pitch CV at an exact time, with optional glide (mirrors the Monarch). */
  setPitchAt(noteVv: number, time: number, glide: boolean): void {
    const p = this.kbCv.offset;
    p.cancelAndHoldAtTime?.(time);
    if (glide && this.glideTimeS > 0.001) {
      p.setTargetAtTime(noteVv, time, this.glideTimeS / 3);
    } else {
      p.setValueAtTime(noteVv, time);
    }
  }

  /** Set the keyboard gate (0/5 vv) at an exact time. */
  gateAt(on: boolean, time: number): void {
    this.kbGate.offset.setValueAtTime(on ? 5 : 0, time);
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
      case 'COU_LFO1_RATE':
        for (const o of this.lfo1Oscs) o.frequency.setValueAtTime(value, time);
        break;
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
