/**
 * Anvil voice on the shared worklets. Sequencer events arrive
 * via the scheduler binding (studio assembly) calling the *At() methods.
 */

import type { ModuleDef } from '../../../data/schema';
import { ModuleBase } from './moduleBase';
import { constant, gain, shaper } from './helpers';
import { createNoiseSource } from '../noise';
import { DriftSource } from '../drift';
import { PITCH_REF_HZ, clamp } from '../units';

/** Linear FM depth, Hz per vv of (scaled) VCO1 signal — tunable. */
const ANV_FM_DEPTH_HZ_PER_VV = 200;
/** Decay CV: seconds added per vv (linear v1 simplification). */
const DECAY_CV_S_PER_VV = 0.3;

export class AnvilModule extends ModuleBase {
  readonly vco1: AudioWorkletNode;
  readonly vco2: AudioWorkletNode;
  readonly vcoEg: AudioWorkletNode;
  readonly vcfEg: AudioWorkletNode;
  readonly vcaEg: AudioWorkletNode;
  readonly ladder: AudioWorkletNode;
  readonly drift1: DriftSource;
  readonly drift2: DriftSource;

  private readonly seqPitch: ConstantSourceNode; // PITCH CV bus (current step)
  private readonly seqVelocity: ConstantSourceNode; // VELOCITY row (current step)
  private readonly seqClock: ConstantSourceNode; // INTERNAL:ANV_SEQ_CLOCK pulses
  private readonly triggerOut: ConstantSourceNode;

  private readonly seqMask1: GainNode; // SEQ PITCH MOD masks
  private readonly seqMask2: GainNode;
  private readonly egAmt1: GainNode;
  private readonly egAmt2: GainNode;
  private readonly hardSyncGain: GainNode;
  private readonly fmAmount: GainNode;
  private readonly vco1Level: GainNode;
  private readonly noiseExtLevel: GainNode;
  private readonly vco2Level: GainNode;
  private readonly vcfModAmount: GainNode; // NOISE/VCF MOD knob
  private readonly vcfEgAmt: GainNode;
  private readonly vcaGainNode: GainNode;
  private readonly volume: GainNode;

  constructor(ctx: BaseAudioContext, def: ModuleDef) {
    super(ctx, def);

    // ---- internal sources ----------------------------------------------------
    const noise = createNoiseSource(ctx);
    this.registerInternal('ANV_NOISE', noise.output);
    this.seqClock = constant(ctx, 0);
    this.registerInternal('ANV_SEQ_CLOCK', this.seqClock);
    this.seqVelocity = constant(ctx, 4);
    this.registerInternal('ANV_SEQ_VELOCITY_ROW', this.seqVelocity);

    // ---- pitch CV per VCO -----------------------------------------------------
    this.drift1 = new DriftSource(ctx);
    this.drift2 = new DriftSource(ctx);
    this.seqPitch = constant(ctx, 0);
    this.seqMask1 = gain(ctx, 1);
    this.seqMask2 = gain(ctx, 1);
    this.seqPitch.connect(this.seqMask1);
    this.seqPitch.connect(this.seqMask2);

    const pitchSum1 = gain(ctx, 1);
    const pitchSum2 = gain(ctx, 1);
    this.seqMask1.connect(pitchSum1);
    this.seqMask2.connect(pitchSum2);
    this.drift1.output.connect(pitchSum1);
    this.drift2.output.connect(pitchSum2);
    this.inputBus('ANV_VCO1_CV_IN').connect(pitchSum1);
    this.inputBus('ANV_VCO2_CV_IN').connect(pitchSum2);

    // ---- VCO EG (decay-only, attack 1 ms) into both pitches, bipolar amounts ---
    this.vcoEg = this.mkEg(ctx, 0.001);
    this.egAmt1 = gain(ctx, 0);
    this.egAmt2 = gain(ctx, 0);
    // EG 0..8 vv scaled to vv-per-octave pitch: amount ±1 -> ±(eg/8)·5 vv ≈ kick sweeps
    const egNorm = gain(ctx, 5 / 8);
    this.vcoEg.connect(egNorm);
    egNorm.connect(this.egAmt1).connect(pitchSum1);
    egNorm.connect(this.egAmt2).connect(pitchSum2);
    this.vcoEg.connect(this.outputTap('ANV_VCO_EG_OUT'));

    // ---- oscillators ------------------------------------------------------------
    const mkOsc = (): AudioWorkletNode =>
      new AudioWorkletNode(ctx, 'synthstack-osc', {
        numberOfInputs: 3,
        numberOfOutputs: 2,
        outputChannelCount: [1, 1],
      });
    this.vco1 = mkOsc();
    this.vco2 = mkOsc();
    this.vco1.parameters.get('shape')!.value = 3; // square default
    this.vco2.parameters.get('shape')!.value = 3;
    this.vco1.parameters.get('frequency')!.value = PITCH_REF_HZ;
    this.vco2.parameters.get('frequency')!.value = PITCH_REF_HZ;
    this.vco2.parameters.get('linFmDepthHzPerVv')!.value = ANV_FM_DEPTH_HZ_PER_VV;
    pitchSum1.connect(this.vco1, 0, 0);
    pitchSum2.connect(this.vco2, 0, 0);

    // hard sync: VCO1 sync pulses (output 1) -> VCO2 sync input (input 2), gated
    this.hardSyncGain = gain(ctx, 0);
    this.vco1.connect(this.hardSyncGain, 1);
    this.hardSyncGain.connect(this.vco2, 0, 2);

    // linear FM: VCO1 audio × (FM AMOUNT knob + CV) -> VCO2 linear FM input
    this.fmAmount = gain(ctx, 0);
    this.vco1.connect(this.fmAmount, 0);
    const fmCvScale = gain(ctx, 1 / 8); // 0..+8 vv CV adds up to +1 of knob range
    this.inputBus('ANV_FM_AMT_IN').connect(fmCvScale).connect(this.fmAmount.gain);
    this.fmAmount.connect(this.vco2, 0, 1);

    this.vco1.connect(this.outputTap('ANV_VCO1_OUT'), 0);
    this.vco2.connect(this.outputTap('ANV_VCO2_OUT'), 0);

    // ---- mixer into the ladder -----------------------------------------------------
    this.vco1Level = gain(ctx, 0.8);
    this.vco2Level = gain(ctx, 0.8);
    this.noiseExtLevel = gain(ctx, 0);
    const extBus = this.inputBus('ANV_EXT_AUDIO_IN'); // normal: noise (router-wired)
    extBus.connect(this.noiseExtLevel);
    // NOISE LEVEL CV adds to the knob (can clip — authentic)
    const noiseLevelCv = gain(ctx, 1 / 8);
    this.inputBus('ANV_NOISE_LEVEL_IN').connect(noiseLevelCv).connect(this.noiseExtLevel.gain);
    const mixSum = gain(ctx, 1);
    this.vco1.connect(this.vco1Level, 0).connect(mixSum);
    this.vco2.connect(this.vco2Level, 0).connect(mixSum);
    this.noiseExtLevel.connect(mixSum);

    this.ladder = new AudioWorkletNode(ctx, 'synthstack-ladder', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    mixSum.connect(this.ladder, 0, 0);

    // ---- cutoff modulation -----------------------------------------------------------
    const cutoffCvSum = gain(ctx, 1);
    cutoffCvSum.connect(this.ladder, 0, 1);
    // pattern-2: VCF MOD bus reads noise unless the jack is patched; knob attenuates
    this.vcfModAmount = gain(ctx, 0);
    this.inputBus('ANV_VCF_MOD_IN').connect(this.vcfModAmount).connect(cutoffCvSum);
    // VCF EG bipolar amount (EG 0..8 vv -> ± octaves of cutoff)
    this.vcfEg = this.mkEg(ctx, 0.001);
    this.vcfEgAmt = gain(ctx, 0);
    this.vcfEg.connect(this.vcfEgAmt).connect(cutoffCvSum);
    this.vcfEg.connect(this.outputTap('ANV_VCF_EG_OUT'));

    // ---- VCA ---------------------------------------------------------------------------
    this.vcaEg = this.mkEg(ctx, 0.001);
    this.vcaEg.connect(this.outputTap('ANV_VCA_EG_OUT'));
    const vcaEgNorm = gain(ctx, 1 / 8);
    const vcaShape = shaper(ctx, (x) => Math.pow(clamp(x, 0, 1), 1.3));
    this.vcaEg.connect(vcaEgNorm).connect(vcaShape);
    const vcaCvNorm = gain(ctx, 1 / 8);
    this.inputBus('ANV_VCA_CV_IN').connect(vcaCvNorm);
    const vcaCtl = gain(ctx, 0.5);
    vcaShape.connect(vcaCtl);
    vcaCvNorm.connect(vcaCtl);
    const vcaClip = shaper(ctx, (x) => {
      const g = clamp(x, 0, 1) * 2;
      return g <= 1 ? g : 1 + 0.2 * Math.tanh((g - 1) / 0.2);
    });
    vcaCtl.connect(vcaClip);
    this.vcaGainNode = gain(ctx, 0);
    vcaClip.connect(this.vcaGainNode.gain);
    this.volume = gain(ctx, 0.7);
    this.ladder.connect(this.vcaGainNode).connect(this.volume);
    this.volume.connect(this.outputTap('ANV_VCA_OUT'));

    // ---- EG gate wiring: TRIGGER bus (normal = seq clock) + velocity bus ------------
    const trigBus = this.inputBus('ANV_TRIGGER_IN');
    const velBus = this.inputBus('ANV_VELOCITY_IN');
    for (const eg of [this.vcoEg, this.vcfEg, this.vcaEg]) {
      trigBus.connect(eg, 0, 0);
      velBus.connect(eg, 0, 1);
    }

    // ---- decay CV summing (linear v1 simplification) ----------------------------------
    const decayCv = (jack: string, eg: AudioWorkletNode) => {
      const g = gain(ctx, DECAY_CV_S_PER_VV);
      this.inputBus(jack).connect(g);
      g.connect(eg.parameters.get('decayS')!);
    };
    decayCv('ANV_VCO_DECAY_IN', this.vcoEg);
    decayCv('ANV_VCF_DECAY_IN', this.vcfEg);
    decayCv('ANV_VCA_DECAY_IN', this.vcaEg);

    // ---- CV outs ------------------------------------------------------------------------
    this.seqPitch.connect(this.outputTap('ANV_PITCH_OUT'));
    this.seqVelocity.connect(this.outputTap('ANV_VELOCITY_OUT'));
    this.triggerOut = constant(ctx, 0);
    this.triggerOut.connect(this.outputTap('ANV_TRIGGER_OUT'));

    this.drift1.start();
    this.drift2.start();
  }

  private mkEg(ctx: BaseAudioContext, attackS: number): AudioWorkletNode {
    const eg = new AudioWorkletNode(ctx, 'synthstack-eg', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        attackS,
        decayS: 0.1,
        sustainMode: 'off',
        retrigInAttack: true,
        attackCompletes: false,
        peakVv: 8,
      },
    });
    // eg.worklet's process() re-applies the attackS AudioParam (default 0.01) on EVERY block,
    // clobbering the constructor's processorOptions.attackS. Pin the param so vcoEg/vcfEg keep
    // the intended 1 ms percussion attack (vcaEg is later overridden by ANV_VCA_EG_ATTACK).
    eg.parameters.get('attackS')!.value = attackS;
    return eg;
  }

  /** Power-off teardown: stop the per-VCO drift random-walk timers (re-armed on power-cycle). */
  stopDrift(): void {
    this.drift1.stop();
    this.drift2.stop();
  }

  setControl(id: string, value: number | string): void {
    const num = typeof value === 'number' ? value : 0;
    switch (id) {
      case 'ANV_VCO1_FREQUENCY':
        this.vco1.parameters.get('frequency')!.value = PITCH_REF_HZ * Math.pow(2, num);
        break;
      case 'ANV_VCO2_FREQUENCY':
        this.vco2.parameters.get('frequency')!.value = PITCH_REF_HZ * Math.pow(2, num);
        break;
      case 'ANV_VCO1_WAVE':
        this.vco1.parameters.get('shape')!.value = value === 'TRI' ? 2 : 3;
        break;
      case 'ANV_VCO2_WAVE':
        this.vco2.parameters.get('shape')!.value = value === 'TRI' ? 2 : 3;
        break;
      case 'ANV_HARD_SYNC':
        this.hardSyncGain.gain.value = value === 'ON' ? 1 : 0;
        break;
      case 'ANV_FM_AMOUNT':
        this.fmAmount.gain.value = num;
        break;
      case 'ANV_SEQ_PITCH_MOD':
        this.seqMask1.gain.value = value === 'VCO1_2' ? 1 : 0;
        this.seqMask2.gain.value = value === 'OFF' ? 0 : 1;
        break;
      case 'ANV_VCO_DECAY':
        this.vcoEg.parameters.get('decayS')!.value = num;
        break;
      case 'ANV_VCO1_EG_AMOUNT':
        this.egAmt1.gain.value = num;
        break;
      case 'ANV_VCO2_EG_AMOUNT':
        this.egAmt2.gain.value = num;
        break;
      case 'ANV_VCO1_LEVEL':
        this.vco1Level.gain.value = num;
        break;
      case 'ANV_NOISE_EXT_LEVEL':
        this.noiseExtLevel.gain.value = num;
        break;
      case 'ANV_VCO2_LEVEL':
        this.vco2Level.gain.value = num;
        break;
      case 'ANV_CUTOFF':
        this.ladder.parameters.get('cutoffHz')!.value = num;
        break;
      case 'ANV_RESONANCE':
        this.ladder.parameters.get('resonance')!.value = num;
        break;
      case 'ANV_VCF_MODE':
        this.ladder.parameters.get('mode')!.value = value === 'HP' ? 1 : 0;
        break;
      case 'ANV_VCF_DECAY':
        this.vcfEg.parameters.get('decayS')!.value = num;
        break;
      case 'ANV_VCF_EG_AMOUNT':
        this.vcfEgAmt.gain.value = num;
        break;
      case 'ANV_NOISE_VCF_MOD':
        this.vcfModAmount.gain.value = num;
        break;
      case 'ANV_VCA_EG_ATTACK':
        this.vcaEg.parameters.get('attackS')!.value = value === 'SLOW' ? 0.1 : 0.001;
        break;
      case 'ANV_VCA_DECAY':
        this.vcaEg.parameters.get('decayS')!.value = num;
        break;
      case 'ANV_VOLUME':
        this.volume.gain.value = num;
        break;
      default:
        break; // TEMPO + step knobs live on the transport
    }
  }

  // ---- sequencer binding surface --------------------------------------------------

  /** Step event: update PITCH/VELOCITY CV buses at the scheduled time. */
  setStepCvAt(pitchVv: number, velocityVv: number, time: number): void {
    this.seqPitch.offset.setValueAtTime(pitchVv, time);
    this.seqVelocity.offset.setValueAtTime(velocityVv, time);
  }

  /** Trigger event: ~1 ms +5 pulse on the internal seq clock and the TRIGGER out. */
  triggerAt(time: number): void {
    this.seqClock.offset.setValueAtTime(5, time);
    this.seqClock.offset.setValueAtTime(0, time + 0.001);
    this.triggerOut.offset.setValueAtTime(5, time);
    this.triggerOut.offset.setValueAtTime(0, time + 0.001);
  }
}
