/**
 * Monarch voice built on the shared worklets. All normals are
 * wired at construction; the Phase-2 router re-routes the same persistent buses.
 *
 * vv conventions per units.ts. Two oscillator worklet instances run side by side
 * (saw + pulse) because both raw waves appear on the patchbay simultaneously;
 * the WAVE switch only selects which one feeds the MIX crossfade.
 */

import type { ModuleDef } from '../../../data/schema';
import { ModuleBase } from './moduleBase';
import { constant, equalPowerCrossfade, gain, shaper, type Crossfade } from './helpers';
import { createNoiseSource } from '../noise';
import { DriftSource } from '../drift';
import type { AssignSource } from '../assign';
import {
  ACCENT_CUTOFF_BOOST_VV,
  PITCH_REF_HZ,
  clamp,
} from '../units';

/** Linear FM depth, Hz per vv (no published figure — tunable). */
const LIN_FM_DEPTH_HZ_PER_VV = 150;

export class MonarchModule extends ModuleBase {
  // sources
  readonly sawOsc: AudioWorkletNode;
  readonly pulseOsc: AudioWorkletNode;
  readonly lfoTri: OscillatorNode;
  readonly lfoSq: OscillatorNode;
  readonly eg: AudioWorkletNode;
  readonly ladder: AudioWorkletNode;
  readonly drift: DriftSource;

  // control constants (knob values riding the graph)
  private readonly kbCv: ConstantSourceNode; // sequencer/keyboard pitch (stub −1 vv)
  private readonly kbGate: ConstantSourceNode; // internal KB gate (0 / 5)
  private readonly assignOut: ConstantSourceNode;
  private readonly accentCutoff: ConstantSourceNode; // +1.5 vv during accented steps
  readonly accentVcaGain: GainNode; // ×1.25 during accents (gain set by seq binding)

  // crossfades
  private readonly mix: Crossfade; // VCO vs noise/ext
  private readonly vcMix: Crossfade; // MIX1 vs MIX2
  private readonly mixPosKnob: ConstantSourceNode;
  private readonly vcMixPosKnob: ConstantSourceNode;

  // mod routing gains (switch positions are 0/1 gains)
  private readonly lfoToVcoMod: GainNode;
  private readonly egToVcoMod: GainNode; // carries EG or VCO MOD jack (pattern-2 bus)
  private readonly vcoModAmountToFreq: GainNode;
  private readonly vcoModAmountToPw: GainNode;
  private readonly lfoToVcfMod: GainNode;
  private readonly egToVcfMod: GainNode;
  private readonly vcfModAmount: GainNode;
  private readonly egToVca: GainNode;
  private readonly onToVca: GainNode;
  private readonly vcaGainNode: GainNode;
  private readonly volume: GainNode;
  private readonly vcoModBus: GainNode; // pattern-2 bus: EG by default, jack replaces

  constructor(ctx: BaseAudioContext, def: ModuleDef) {
    super(ctx, def);

    // ---- internal sources --------------------------------------------------
    const noise = createNoiseSource(ctx);
    this.registerInternal('MON_NOISE', noise.output);
    this.kbGate = constant(ctx, 0);
    this.registerInternal('MON_KB_GATE', this.kbGate);
    this.registerInternal('MON_ZERO', gain(ctx, 0)); // silent bus
    this.registerInternal('MON_PLUS5', constant(ctx, 5));

    // ---- oscillators ---------------------------------------------------------
    this.drift = new DriftSource(ctx);
    const pitchCvSum = gain(ctx, 1);
    this.kbCv = constant(ctx, -1); // Monarch default step note stub
    this.kbCv.connect(pitchCvSum);
    this.drift.output.connect(pitchCvSum);
    this.inputBus('MON_VCO_1VOCT_IN').connect(pitchCvSum);

    const mkOsc = (shape: number): AudioWorkletNode => {
      const osc = new AudioWorkletNode(ctx, 'synthstack-osc', {
        numberOfInputs: 3,
        numberOfOutputs: 2,
        outputChannelCount: [1, 1],
      });
      osc.parameters.get('shape')!.value = shape;
      osc.parameters.get('frequency')!.value = PITCH_REF_HZ;
      osc.parameters.get('linFmDepthHzPerVv')!.value = LIN_FM_DEPTH_HZ_PER_VV;
      pitchCvSum.connect(osc, 0, 0);
      this.inputBus('MON_VCO_LIN_FM_IN').connect(osc, 0, 1);
      return osc;
    };
    this.sawOsc = mkOsc(0);
    this.pulseOsc = mkOsc(1);
    this.sawOsc.connect(this.outputTap('MON_VCO_SAW_OUT'), 0);
    this.pulseOsc.connect(this.outputTap('MON_VCO_PULSE_OUT'), 0);

    // ---- LFO (native oscillators are fine for LFOs — D6) ---------------------
    this.lfoTri = ctx.createOscillator();
    this.lfoTri.type = 'triangle';
    this.lfoSq = ctx.createOscillator();
    this.lfoSq.type = 'square';
    this.lfoTri.frequency.value = 5;
    this.lfoSq.frequency.value = 5;
    const lfoTriOut = gain(ctx, 5); // ±1 -> ±5 vv
    const lfoSqOut = gain(ctx, 5);
    this.lfoTri.connect(lfoTriOut);
    this.lfoSq.connect(lfoSqOut);
    this.lfoTri.start();
    this.lfoSq.start();
    lfoTriOut.connect(this.outputTap('MON_LFO_TRI_OUT'));
    lfoSqOut.connect(this.outputTap('MON_LFO_SQ_OUT'));
    // LFO RATE CV: 1 vv/oct exponential via detune (1200 cents per vv)
    const rateCvToDetune = gain(ctx, 1200);
    this.inputBus('MON_LFO_RATE_IN').connect(rateCvToDetune);
    rateCvToDetune.connect(this.lfoTri.detune);
    rateCvToDetune.connect(this.lfoSq.detune);

    // ---- VCO MOD path ---------------------------------------------------------
    // pattern-2 bus: reads EG by default; patching MON_VCO_MOD_IN replaces the feed
    this.vcoModBus = this.inputBus('MON_VCO_MOD_IN');
    // LFO WAVE switch selects which wave feeds the mod paths
    const lfoModSelect = gain(ctx, 1);
    this.lfoTriSel = gain(ctx, 1);
    this.lfoSqSel = gain(ctx, 0);
    lfoTriOut.connect(this.lfoTriSel).connect(lfoModSelect);
    lfoSqOut.connect(this.lfoSqSel).connect(lfoModSelect);
    this.lfoToVcoMod = gain(ctx, 1);
    this.egToVcoMod = gain(ctx, 0);
    lfoModSelect.connect(this.lfoToVcoMod);
    this.vcoModBus.connect(this.egToVcoMod);
    const vcoModSum = gain(ctx, 1);
    this.lfoToVcoMod.connect(vcoModSum);
    this.egToVcoMod.connect(vcoModSum);
    this.vcoModAmountToFreq = gain(ctx, 0);
    this.vcoModAmountToPw = gain(ctx, 0);
    vcoModSum.connect(this.vcoModAmountToFreq).connect(pitchCvSum);
    vcoModSum.connect(this.vcoModAmountToPw);
    // PW mod: ±5 vv = full span (≈0.96/10 per vv), summed onto the a-rate param
    const pwModScale = gain(ctx, 0.096);
    this.vcoModAmountToPw.connect(pwModScale);
    pwModScale.connect(this.pulseOsc.parameters.get('pulseWidth')!);

    // ---- MIX (VCO vs noise/ext) ----------------------------------------------
    this.mix = equalPowerCrossfade(ctx);
    this.mixPosKnob = constant(ctx, 0);
    this.mixPosKnob.connect(this.mix.positionBus);
    const mixCvScale = gain(ctx, 0.1); // ±5 vv = full sweep
    this.inputBus('MON_MIX_CV_IN').connect(mixCvScale).connect(this.mix.positionBus);
    // wave select into the VCO side
    const sawSel = gain(ctx, 1);
    const pulseSel = gain(ctx, 0);
    this.sawOsc.connect(sawSel, 0);
    this.pulseOsc.connect(pulseSel, 0);
    sawSel.connect(this.mix.aIn);
    pulseSel.connect(this.mix.aIn);
    this.waveSel = { sawSel, pulseSel };
    // noise/ext side: pattern-2 — EXT AUDIO bus is normalled from noise
    // (the normal edge itself is wired by RouterBinding.applyAllNormals)
    const extBus = this.inputBus('MON_EXT_AUDIO_IN');
    extBus.connect(this.mix.bIn);
    noise.output.connect(this.outputTap('MON_NOISE_OUT'));

    // ---- ladder filter ----------------------------------------------------------
    this.ladder = new AudioWorkletNode(ctx, 'synthstack-ladder', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.mix.out.connect(this.ladder, 0, 0);
    // cutoff CV bus: jack + VCF MOD path + accent boost, all in vv
    const cutoffCvSum = gain(ctx, 1);
    this.inputBus('MON_VCF_CUTOFF_IN').connect(cutoffCvSum);
    this.accentCutoff = constant(ctx, 0);
    this.accentCutoff.connect(cutoffCvSum);
    cutoffCvSum.connect(this.ladder, 0, 1);
    // resonance CV: ±5 vv = full sweep -> 0.1 per vv summed onto the k-rate param
    const resCvScale = gain(ctx, 0.1);
    this.inputBus('MON_VCF_RES_IN').connect(resCvScale);
    resCvScale.connect(this.ladder.parameters.get('resonance')!);
    this.ladder.connect(this.outputTap('MON_VCF_OUT'));

    // ---- VCF MOD path ----------------------------------------------------------
    this.lfoToVcfMod = gain(ctx, 0);
    this.egToVcfMod = gain(ctx, 1);
    lfoModSelect.connect(this.lfoToVcfMod);
    this.vcfModAmount = gain(ctx, 0); // amount × polarity
    this.lfoToVcfMod.connect(this.vcfModAmount);
    this.egToVcfMod.connect(this.vcfModAmount);
    this.vcfModAmount.connect(cutoffCvSum);

    // ---- EG ----------------------------------------------------------------------
    this.eg = new AudioWorkletNode(ctx, 'synthstack-eg', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        sustainMode: 'on',
        retrigInAttack: false,
        attackCompletes: false,
        peakVv: 7.5,
      },
    });
    const gateBus = this.inputBus('MON_GATE_IN'); // normal KB_GATE wired by router
    gateBus.connect(this.eg, 0, 0);
    this.eg.connect(this.outputTap('MON_EG_OUT'));
    this.eg.connect(this.egToVcfMod);
    // pattern-2: VCO MOD bus reads INTERNAL:MON_EG via the router's normal edge

    // ---- VCA ------------------------------------------------------------------------
    // control bus: shaped EG (perceptual ^1.3) + VCA CV, soft-knee toward 1.2
    const egNorm = gain(ctx, 1 / 7.5);
    const egShape = shaper(ctx, (x) => Math.pow(clamp(x, 0, 1), 1.3));
    this.eg.connect(egNorm).connect(egShape);
    this.egToVca = gain(ctx, 1);
    egShape.connect(this.egToVca);
    this.onToVca = gain(ctx, 0);
    constant(ctx, 1).connect(this.onToVca);
    const vcaCvNorm = gain(ctx, 1 / 7.5);
    this.inputBus('MON_VCA_CV_IN').connect(vcaCvNorm);
    const vcaCtl = gain(ctx, 0.5); // into shaper domain (0..~2 -> 0..1)
    this.egToVca.connect(vcaCtl);
    this.onToVca.connect(vcaCtl);
    vcaCvNorm.connect(vcaCtl);
    const vcaClip = shaper(ctx, (x) => {
      const g = clamp(x, 0, 1) * 2;
      return g <= 1 ? g : 1 + 0.2 * Math.tanh((g - 1) / 0.2);
    });
    vcaCtl.connect(vcaClip);
    this.vcaGainNode = gain(ctx, 0);
    vcaClip.connect(this.vcaGainNode.gain);
    this.accentVcaGain = gain(ctx, 1); // seq binding ramps to 1.25 on accents
    this.volume = gain(ctx, 0.7);
    this.ladder.connect(this.vcaGainNode).connect(this.accentVcaGain).connect(this.volume);
    this.volume.connect(this.outputTap('MON_VCA_OUT'));

    // ---- VC MIX -------------------------------------------------------------------
    this.vcMix = equalPowerCrossfade(ctx);
    this.vcMixPosKnob = constant(ctx, 0.5);
    this.vcMixPosKnob.connect(this.vcMix.positionBus);
    const vcMixCvScale = gain(ctx, 0.1);
    this.inputBus('MON_VC_MIX_CTRL_IN').connect(vcMixCvScale).connect(this.vcMix.positionBus);
    this.inputBus('MON_MIX1_IN').connect(this.vcMix.aIn); // normal = 0 V (router-wired)
    this.inputBus('MON_MIX2_IN').connect(this.vcMix.bIn); // normal = +5 V (router-wired)
    this.vcMix.out.connect(this.outputTap('MON_VC_MIX_OUT'));

    // ---- MULT ------------------------------------------------------------------------
    this.inputBus('MON_MULT_IN').connect(this.outputTap('MON_MULT1_OUT'));
    this.inputBus('MON_MULT_IN').connect(this.outputTap('MON_MULT2_OUT'));

    // ---- KB / GATE / ASSIGN outs ------------------------------------------------------
    this.kbCv.connect(this.outputTap('MON_KB_OUT'));
    this.kbGate.connect(this.outputTap('MON_GATE_OUT'));
    this.assignOut = constant(ctx, 0);
    this.assignOut.connect(this.outputTap('MON_ASSIGN_OUT'));
    this.registerInternal('MON_EG', this.eg);

    this.drift.start();
  }

  private readonly waveSel: { sawSel: GainNode; pulseSel: GainNode };
  private lfoTriSel!: GainNode;
  private lfoSqSel!: GainNode;

  /** Apply a panel control (values per data/monarch.json). */
  setControl(id: string, value: number | string): void {
    const num = typeof value === 'number' ? value : 0;
    switch (id) {
      case 'MON_FREQUENCY': {
        const hz = PITCH_REF_HZ * Math.pow(2, num);
        this.sawOsc.parameters.get('frequency')!.value = hz;
        this.pulseOsc.parameters.get('frequency')!.value = hz;
        break;
      }
      case 'MON_VCO_WAVE':
        this.waveSel.sawSel.gain.value = value === 'SAW' ? 1 : 0;
        this.waveSel.pulseSel.gain.value = value === 'PULSE' ? 1 : 0;
        break;
      case 'MON_PULSE_WIDTH':
        this.pulseOsc.parameters.get('pulseWidth')!.value = num;
        break;
      case 'MON_VCO_MOD_SOURCE':
        this.lfoToVcoMod.gain.value = value === 'LFO' ? 1 : 0;
        this.egToVcoMod.gain.value = value === 'EG' ? 1 : 0;
        break;
      case 'MON_VCO_MOD_AMOUNT':
        this.vcoModAmount = num;
        this.applyVcoModDest();
        break;
      case 'MON_VCO_MOD_DEST':
        this.vcoModDest = value === 'PW' ? 'PW' : 'FREQUENCY';
        this.applyVcoModDest();
        break;
      case 'MON_LFO_RATE':
        this.lfoTri.frequency.value = num;
        this.lfoSq.frequency.value = num;
        break;
      case 'MON_LFO_WAVE':
        // both raw waves stay available on the patchbay; the switch picks the mod feed
        this.lfoTriSel.gain.value = value === 'TRI' ? 1 : 0;
        this.lfoSqSel.gain.value = value === 'SQ' ? 1 : 0;
        break;
      case 'MON_MIX':
        this.mixPosKnob.offset.value = num;
        break;
      case 'MON_VCF_CUTOFF':
        this.ladder.parameters.get('cutoffHz')!.value = num;
        break;
      case 'MON_VCF_RESONANCE':
        this.ladder.parameters.get('resonance')!.value = num;
        break;
      case 'MON_VCF_MODE':
        this.ladder.parameters.get('mode')!.value = value === 'HP' ? 1 : 0;
        break;
      case 'MON_VCF_MOD_SOURCE':
        this.lfoToVcfMod.gain.value = value === 'LFO' ? 1 : 0;
        this.egToVcfMod.gain.value = value === 'EG' ? 1 : 0;
        break;
      case 'MON_VCF_MOD_AMOUNT':
        this.vcfModAmountValue = num;
        this.applyVcfModAmount();
        break;
      case 'MON_VCF_MOD_POLARITY':
        this.vcfModPolarity = value === 'MINUS' ? -1 : 1;
        this.applyVcfModAmount();
        break;
      case 'MON_ATTACK':
        this.eg.parameters.get('attackS')!.value = num;
        break;
      case 'MON_DECAY':
        this.eg.parameters.get('decayS')!.value = num;
        break;
      case 'MON_SUSTAIN':
        this.eg.port.postMessage({ type: 'configure', config: { sustainMode: value === 'ON' ? 'on' : 'off', retrigInAttack: value === 'OFF' } });
        break;
      case 'MON_VCA_MODE':
        this.egToVca.gain.value = value === 'EG' ? 1 : 0;
        this.onToVca.gain.value = value === 'ON' ? 1 : 0;
        break;
      case 'MON_VOLUME':
        this.volume.gain.value = num;
        break;
      case 'MON_GLIDE':
        this.glideTimeS = num;
        break;
      case 'MON_VC_MIX':
        this.vcMixPosKnob.offset.value = num;
        break;
      case 'MON_ASSIGN_SOURCE':
        if (typeof value === 'string') this._assignSource = value as AssignSource;
        break;
      default:
        break; // sequencer controls handled by the transport (Phase 3)
    }
  }

  private vcoModAmount = 0;
  private vcoModDest: 'PW' | 'FREQUENCY' = 'FREQUENCY';
  private vcfModAmountValue = 0;
  private vcfModPolarity = 1;
  glideTimeS = 0;

  private applyVcoModDest(): void {
    this.vcoModAmountToFreq.gain.value = this.vcoModDest === 'FREQUENCY' ? this.vcoModAmount : 0;
    this.vcoModAmountToPw.gain.value = this.vcoModDest === 'PW' ? this.vcoModAmount : 0;
  }

  private applyVcfModAmount(): void {
    this.vcfModAmount.gain.value = this.vcfModAmountValue * this.vcfModPolarity;
  }

  // ---- sequencer binding surface (Phase 3 drives these at scheduled times) ------

  /** Set pitch CV at an exact time, with optional glide. */
  setPitchAt(noteVv: number, time: number, glide: boolean): void {
    const p = this.kbCv.offset;
    p.cancelAndHoldAtTime?.(time);
    if (glide && this.glideTimeS > 0.001) {
      p.setTargetAtTime(noteVv, time, this.glideTimeS / 3);
    } else {
      p.setValueAtTime(noteVv, time);
    }
  }

  gateAt(on: boolean, time: number): void {
    this.kbGate.offset.setValueAtTime(on ? 5 : 0, time);
  }

  accentAt(on: boolean, time: number): void {
    this.accentCutoff.offset.setValueAtTime(on ? ACCENT_CUTOFF_BOOST_VV : 0, time);
    this.accentVcaGain.gain.setValueAtTime(on ? 1.25 : 1, time);
  }

  /** ASSIGN out source (Setup-mode page 1). The binder reads this to realize the 9 analog sources;
   *  defaults to CLOCK so the out-of-box behavior is unchanged. */
  private _assignSource: AssignSource = 'CLOCK';
  get assignSource(): AssignSource {
    return this._assignSource;
  }

  /** ASSIGN out as a clock-type source: one +5 V pulse (5 ms) at `time`. */
  assignPulseAt(time: number): void {
    this.assignOut.offset.setValueAtTime(5, time);
    this.assignOut.offset.setValueAtTime(0, time + 0.005);
  }

  /** ASSIGN out as a step-shape source (RAMP/SAW/TRI/RANDOM): a held CV level (0..+5 V) at `time`. */
  assignLevelAt(vv: number, time: number): void {
    this.assignOut.offset.setValueAtTime(vv, time);
  }

  /** Power-off teardown: stop the per-VCO drift random-walk timer (re-armed on power-cycle). */
  stopDrift(): void {
    this.drift.stop();
  }
}
