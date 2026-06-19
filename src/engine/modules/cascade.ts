/**
 * Cascade voice: six oscillator-worklet sources
 * (VCO1 + 2 subs, VCO2 + 2 subs) -> six-level mixer -> LP-only ladder -> VCA.
 *
 * Pitch model: each VCO has a scheduled ConstantSource pitch bus in vv. Subs ride
 * their parent's bus plus a divider offset of −log2(N) vv (division in frequency =
 * subtraction in vv). Quantize applies to knob+sequencer values at event time
 * (CV jacks remain continuous/unquantized — authentic behavior). The sub-CV jacks go
 * through a WaveShaper whose curve maps CV to the *delta* divider offset around
 * the current knob+seq integer (curve rebuilt on control changes).
 */

import type { ModuleDef } from '../../../data/schema';
import { ModuleBase } from './moduleBase';
import { constant, gain, shaper } from './helpers';
import { DriftSource } from '../drift';
import { clamp, cascadeSeqOctRange, cascadeSeqToSubOffset } from '../units';
import { quantizeVv, type QuantizeMode } from '../quantize';

const PITCH_REF_HZ = 261.63;

interface VcoSection {
  vco: AudioWorkletNode;
  sub1: AudioWorkletNode;
  sub2: AudioWorkletNode;
  pitchSet: ConstantSourceNode; // quantized knob+seq value, vv (scheduled)
  sub1Offset: ConstantSourceNode; // −log2(N1), vv (scheduled)
  sub2Offset: ConstantSourceNode;
  sub1CvShaper: WaveShaperNode;
  sub2CvShaper: WaveShaperNode;
  pwmNormalTap: GainNode; // gated: only in MIXED wave position
  knobVv: number;
  sub1KnobN: number;
  sub2KnobN: number;
  seqVv: number; // current sequencer OSC contribution
  sub1SeqOffset: number;
  sub2SeqOffset: number;
}

export class CascadeModule extends ModuleBase {
  readonly ladder: AudioWorkletNode;
  readonly vcfEg: AudioWorkletNode;
  readonly vcaEg: AudioWorkletNode;
  private readonly sections: [VcoSection, VcoSection];
  private readonly levels: GainNode[] = [];
  private readonly vcfEgAmt: GainNode;
  private readonly vcaGainNode: GainNode;
  private readonly volume: GainNode;
  private readonly egGate: ConstantSourceNode;
  private readonly triggerOut: ConstantSourceNode;
  private readonly clockOut: ConstantSourceNode;
  private readonly seqOut: [ConstantSourceNode, ConstantSourceNode];
  private readonly seqClkOut: [ConstantSourceNode, ConstantSourceNode];
  readonly drift1: DriftSource;
  readonly drift2: DriftSource;

  quantizeMode: QuantizeMode = 'OFF';
  seqOctRange = 1;
  /** step knobs, ±1, scaled by seqOctRange at apply time */
  seqSteps: [number[], number[]] = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  /** SEQ ASSIGN buttons per sequencer: what the step value modifies. */
  seqAssign: [{ osc: boolean; sub1: boolean; sub2: boolean }, { osc: boolean; sub1: boolean; sub2: boolean }] = [
    { osc: true, sub1: false, sub2: false },
    { osc: true, sub1: false, sub2: false },
  ];

  constructor(ctx: BaseAudioContext, def: ModuleDef) {
    super(ctx, def);

    this.drift1 = new DriftSource(ctx);
    this.drift2 = new DriftSource(ctx);

    // VCO 1 CV input passes onward to VCO 2 until VCO 2 is patched: the pass-along
    // signal is itself an internal source the router can resolve.
    const vco1InSignal = gain(ctx, 1);
    this.inputBus('CAS_VCO1_IN').connect(vco1InSignal);
    this.registerInternal('CAS_VCO1_IN_SIGNAL', vco1InSignal);

    const mixSum = gain(ctx, 1);
    this.sections = [
      this.buildSection(ctx, 0, this.drift1, mixSum),
      this.buildSection(ctx, 1, this.drift2, mixSum),
    ];

    // ---- ladder (LP only — D7) ----------------------------------------------
    this.ladder = new AudioWorkletNode(ctx, 'synthstack-ladder', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.ladder.parameters.get('mode')!.value = 0; // locked LP
    mixSum.connect(this.ladder, 0, 0);
    const cutoffCvSum = gain(ctx, 1);
    this.inputBus('CAS_CUTOFF_IN').connect(cutoffCvSum);
    cutoffCvSum.connect(this.ladder, 0, 1);

    // ---- EGs (gateHold, no retrigger in attack, attack completes) -------------
    const mkEg = (): AudioWorkletNode =>
      new AudioWorkletNode(ctx, 'synthstack-eg', {
        numberOfInputs: 2,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: {
          attackS: 0.005,
          decayS: 0.3,
          sustainMode: 'gateHold',
          retrigInAttack: false,
          attackCompletes: true,
          peakVv: 8,
        },
      });
    this.vcfEg = mkEg();
    this.vcaEg = mkEg();
    this.egGate = constant(ctx, 0);
    const gateSum = gain(ctx, 1);
    this.egGate.connect(gateSum);
    this.inputBus('CAS_TRIGGER_IN').connect(gateSum);
    gateSum.connect(this.vcfEg, 0, 0);
    gateSum.connect(this.vcaEg, 0, 0);
    this.vcfEg.connect(this.outputTap('CAS_VCF_EG_OUT'));
    this.vcaEg.connect(this.outputTap('CAS_VCA_EG_OUT'));
    this.vcfEgAmt = gain(ctx, 0);
    this.vcfEg.connect(this.vcfEgAmt).connect(cutoffCvSum);

    // ---- VCA ---------------------------------------------------------------------
    const vcaEgNorm = gain(ctx, 1 / 8);
    const vcaCvNorm = gain(ctx, 1 / 8);
    this.inputBus('CAS_VCA_IN').connect(vcaCvNorm);
    // 0.5 pre-scale maps the 0..2 EG+CV sum into the shaper's 0..1 domain (parity with
    // Monarch/Anvil), then a tanh soft-knee caps gain ~1.2 so a patched CAS_VCA_IN can no
    // longer drive the post-filter signal to 2.0 and hard-clip the master bus.
    const vcaCtl = gain(ctx, 0.5);
    vcaEgNorm.connect(vcaCtl);
    vcaCvNorm.connect(vcaCtl);
    this.vcaEg.connect(vcaEgNorm);
    const vcaClip = shaper(ctx, (x) => {
      const g = clamp(x, 0, 1) * 2;
      return g <= 1 ? g : 1 + 0.2 * Math.tanh((g - 1) / 0.2);
    });
    vcaCtl.connect(vcaClip);
    this.vcaGainNode = gain(ctx, 0);
    vcaClip.connect(this.vcaGainNode.gain);
    this.volume = gain(ctx, 0.7);
    this.ladder.connect(this.vcaGainNode).connect(this.volume);
    this.volume.connect(this.outputTap('CAS_VCA_OUT'));

    // ---- transport-facing outs ------------------------------------------------------
    this.triggerOut = constant(ctx, 0);
    this.triggerOut.connect(this.outputTap('CAS_TRIGGER_OUT'));
    this.clockOut = constant(ctx, 0);
    this.clockOut.connect(this.outputTap('CAS_CLOCK_OUT'));
    this.seqOut = [constant(ctx, 0), constant(ctx, 0)];
    this.seqClkOut = [constant(ctx, 0), constant(ctx, 0)];
    this.seqOut[0].connect(this.outputTap('CAS_SEQ1_OUT'));
    this.seqOut[1].connect(this.outputTap('CAS_SEQ2_OUT'));
    this.seqClkOut[0].connect(this.outputTap('CAS_SEQ1_CLK_OUT'));
    this.seqClkOut[1].connect(this.outputTap('CAS_SEQ2_CLK_OUT'));

    this.drift1.start();
    this.drift2.start();
  }

  /** Power-off teardown: stop the per-VCO drift random-walk timers (re-armed on power-cycle). */
  stopDrift(): void {
    this.drift1.stop();
    this.drift2.stop();
  }

  private buildSection(ctx: BaseAudioContext, idx: 0 | 1, drift: DriftSource, mixSum: GainNode): VcoSection {
    const n = idx + 1;
    const mkOsc = (): AudioWorkletNode =>
      new AudioWorkletNode(ctx, 'synthstack-osc', {
        numberOfInputs: 3,
        numberOfOutputs: 2,
        outputChannelCount: [1, 1],
      });
    const vco = mkOsc();
    const sub1 = mkOsc();
    const sub2 = mkOsc();
    for (const o of [vco, sub1, sub2]) {
      o.parameters.get('frequency')!.value = PITCH_REF_HZ;
      o.parameters.get('shape')!.value = 0; // SAW default (panel default)
    }

    // pitch bus: scheduled knob+seq value + drift + the 1 vv/oct CV input
    const pitchBus = gain(ctx, 1);
    const pitchSet = constant(ctx, 0);
    pitchSet.connect(pitchBus);
    drift.output.connect(pitchBus);
    const cvIn = this.inputBus(`CAS_VCO${n}_IN`);
    cvIn.connect(pitchBus);
    pitchBus.connect(vco, 0, 0);

    // subs: parent pitch + divider offsets (−log2 N) + CV-delta shapers
    const sub1Offset = constant(ctx, -1); // default N=2
    const sub2Offset = constant(ctx, -Math.log2(3)); // default N=3
    const subCvIn = this.inputBus(`CAS_VCO${n}_SUB_IN`);
    const subCvPre = gain(ctx, 0.2); // ±5 vv -> shaper domain ±1
    subCvIn.connect(subCvPre);
    const sub1CvShaper = ctx.createWaveShaper();
    const sub2CvShaper = ctx.createWaveShaper();
    subCvPre.connect(sub1CvShaper);
    subCvPre.connect(sub2CvShaper);
    const sub1Pitch = gain(ctx, 1);
    const sub2Pitch = gain(ctx, 1);
    pitchBus.connect(sub1Pitch);
    pitchBus.connect(sub2Pitch);
    sub1Offset.connect(sub1Pitch);
    sub2Offset.connect(sub2Pitch);
    sub1CvShaper.connect(sub1Pitch);
    sub2CvShaper.connect(sub2Pitch);
    sub1Pitch.connect(sub1, 0, 0);
    sub2Pitch.connect(sub2, 0, 0);

    // PWM: the PWM jack bus drives pulse width (±5 vv -> ±0.49 around 0.5); its
    // NORMAL source is the sub-1 saw, but only while the wave switch is MIXED —
    // the tap below is the gated internal source the router resolves.
    const pwmNormalTap = gain(ctx, 0);
    sub1.connect(pwmNormalTap, 0);
    this.registerInternal(`CAS_VCO${n}_SUB1_SAW`, pwmNormalTap);
    const pwmScale = gain(ctx, 0.098);
    this.inputBus(`CAS_VCO${n}_PWM_IN`).connect(pwmScale);
    pwmScale.connect(vco.parameters.get('pulseWidth')!);

    // levels into the mixer + patchbay taps
    const tapNames = [`CAS_VCO${n}_OUT`, `CAS_VCO${n}_SUB1_OUT`, `CAS_VCO${n}_SUB2_OUT`];
    [vco, sub1, sub2].forEach((osc, i) => {
      // both VCOs audible by default (data JSON defaults); subs start at 0
      const level = gain(ctx, i === 0 ? 0.8 : 0);
      osc.connect(level, 0).connect(mixSum);
      osc.connect(this.outputTap(tapNames[i]!), 0);
      this.levels.push(level);
    });

    const section: VcoSection = {
      vco, sub1, sub2, pitchSet, sub1Offset, sub2Offset, sub1CvShaper, sub2CvShaper,
      pwmNormalTap,
      knobVv: 0, sub1KnobN: 2, sub2KnobN: 3, seqVv: 0, sub1SeqOffset: 0, sub2SeqOffset: 0,
    };
    this.rebuildSubCvCurves(section);
    return section;
  }

  /** Curve: cv (±5 vv) -> divider delta in vv around the current knob+seq integer. */
  private rebuildSubCvCurves(s: VcoSection): void {
    const make = (baseN: number): Float32Array => {
      const curve = new Float32Array(1025);
      const n0 = clamp(Math.round(baseN), 1, 16);
      for (let i = 0; i < curve.length; i++) {
        const cv = ((i / (curve.length - 1)) * 2 - 1) * 5;
        const nEff = clamp(Math.round(baseN + cv * 1.5), 1, 16);
        curve[i] = -Math.log2(nEff) + Math.log2(n0);
      }
      return curve;
    };
    s.sub1CvShaper.curve = make(s.sub1KnobN + s.sub1SeqOffset) as Float32Array<ArrayBuffer>;
    s.sub2CvShaper.curve = make(s.sub2KnobN + s.sub2SeqOffset) as Float32Array<ArrayBuffer>;
  }

  /** Recompute & schedule a section's pitch + divider offsets. */
  private applyPitch(s: VcoSection, time?: number): void {
    const t = time ?? 0;
    const target = quantizeVv(s.knobVv + s.seqVv, this.quantizeMode);
    s.pitchSet.offset.setValueAtTime(target, t);
    const n1 = clamp(Math.round(s.sub1KnobN + s.sub1SeqOffset), 1, 16);
    const n2 = clamp(Math.round(s.sub2KnobN + s.sub2SeqOffset), 1, 16);
    s.sub1Offset.offset.setValueAtTime(-Math.log2(n1), t);
    s.sub2Offset.offset.setValueAtTime(-Math.log2(n2), t);
    // internal modulation ceiling ~10 kHz is enforced by the osc worklet's own clamp
  }

  setControl(id: string, value: number | string): void {
    const num = typeof value === 'number' ? value : 0;
    const m = /^CAS_VCO([12])_(.+)$/.exec(id);
    if (m) {
      const s = this.sections[(Number(m[1]) - 1) as 0 | 1]!;
      switch (m[2]) {
        case 'FREQ':
          s.knobVv = Math.log2(num / PITCH_REF_HZ);
          this.applyPitch(s);
          return;
        case 'SUB1_FREQ':
          s.sub1KnobN = num;
          this.applyPitch(s);
          this.rebuildSubCvCurves(s);
          return;
        case 'SUB2_FREQ':
          s.sub2KnobN = num;
          this.applyPitch(s);
          this.rebuildSubCvCurves(s);
          return;
        case 'WAVE': {
          // SQUARE: all square; MIXED: VCO square + subs saw + sub1-saw PWM normal;
          // SAW: all saw
          const vcoShape = value === 'SAW' ? 0 : 1;
          const subShape = value === 'SQUARE' ? 3 : 0;
          s.vco.parameters.get('shape')!.value = vcoShape;
          s.sub1.parameters.get('shape')!.value = subShape;
          s.sub2.parameters.get('shape')!.value = subShape;
          s.pwmNormalTap.gain.value = value === 'MIXED' ? 1 : 0;
          return;
        }
        case 'LEVEL':
        case 'SUB1_LEVEL':
        case 'SUB2_LEVEL': {
          const base = (Number(m[1]) - 1) * 3;
          const offset = m[2] === 'LEVEL' ? 0 : m[2] === 'SUB1_LEVEL' ? 1 : 2;
          this.levels[base + offset]!.gain.value = num;
          return;
        }
      }
    }
    switch (id) {
      case 'CAS_QUANTIZE':
        this.quantizeMode = value as QuantizeMode;
        for (const s of this.sections) this.applyPitch(s);
        break;
      case 'CAS_SEQ_OCT':
        this.seqOctRange = cascadeSeqOctRange(value as 'OCT1' | 'OCT2' | 'OCT5');
        break;
      case 'CAS_CUTOFF':
        this.ladder.parameters.get('cutoffHz')!.value = num;
        break;
      case 'CAS_RESONANCE':
        this.ladder.parameters.get('resonance')!.value = num;
        break;
      case 'CAS_VCF_EG_AMOUNT':
        this.vcfEgAmt.gain.value = num;
        break;
      case 'CAS_VCF_ATTACK':
        this.vcfEg.parameters.get('attackS')!.value = num;
        break;
      case 'CAS_VCF_DECAY':
        this.vcfEg.parameters.get('decayS')!.value = num;
        break;
      case 'CAS_VCA_ATTACK':
        this.vcaEg.parameters.get('attackS')!.value = num;
        break;
      case 'CAS_VCA_DECAY':
        this.vcaEg.parameters.get('decayS')!.value = num;
        break;
      case 'CAS_VOLUME':
        this.volume.gain.value = num;
        break;
      case 'CAS_EG': {
        const held = value === 'HELD';
        this.vcfEg.port.postMessage({ type: 'forceHeld', held });
        this.vcaEg.port.postMessage({ type: 'forceHeld', held });
        break;
      }
      default: {
        const step = /^CAS_SEQ([12])_STEP_([1-4])$/.exec(id);
        if (step) {
          this.seqSteps[(Number(step[1]) - 1) as 0 | 1]![Number(step[2]) - 1] = num;
        }
        const assign = /^CAS_SEQ([12])_ASSIGN_(OSC|SUB1|SUB2)$/.exec(id);
        if (assign) {
          const sIdx = (Number(assign[1]) - 1) as 0 | 1;
          const a = this.seqAssign[sIdx]!;
          const sec = this.sections[sIdx]!;
          const on = value === 'ON';
          // On de-assign, clear the residual sequencer contribution so pitch returns to the
          // knob immediately — even with the sequencer stopped (no future step would clear it).
          if (assign[2] === 'OSC') {
            a.osc = on;
            if (!on) sec.seqVv = 0;
          } else if (assign[2] === 'SUB1') {
            a.sub1 = on;
            if (!on) sec.sub1SeqOffset = 0;
          } else {
            a.sub2 = on;
            if (!on) sec.sub2SeqOffset = 0;
          }
          if (!on) {
            this.applyPitch(sec);
            this.rebuildSubCvCurves(sec);
          }
        }
        break;
      }
    }
  }

  // ---- clock-engine binding surface ------------------------------------------------

  /** pitchUpdate event: apply sequencer step to its assigned destinations. */
  applySeqStep(seq: 0 | 1, stepIndex: number, time: number): void {
    const s = this.sections[seq]!;
    const stepVv = this.seqSteps[seq]![stepIndex]! * this.seqOctRange;
    const a = this.seqAssign[seq]!;
    if (a.osc) s.seqVv = stepVv;
    if (a.sub1) s.sub1SeqOffset = cascadeSeqToSubOffset(stepVv);
    if (a.sub2) s.sub2SeqOffset = cascadeSeqToSubOffset(stepVv);
    this.applyPitch(s, time);
    if (a.sub1 || a.sub2) this.rebuildSubCvCurves(s); // immediate (control-rate)
    // SEQ out reflects the quantized step value (respects quantize & seq-oct)
    this.seqOut[seq].offset.setValueAtTime(quantizeVv(stepVv, this.quantizeMode), time);
  }

  seqClkPulseAt(seq: 0 | 1, time: number): void {
    this.seqClkOut[seq].offset.setValueAtTime(5, time);
    this.seqClkOut[seq].offset.setValueAtTime(0, time + 0.001);
  }

  egTriggerAt(time: number): void {
    this.egGate.offset.setValueAtTime(5, time);
    this.egGate.offset.setValueAtTime(0, time + 0.001);
    this.triggerOut.offset.setValueAtTime(5, time);
    this.triggerOut.offset.setValueAtTime(0, time + 0.001);
  }

  clockPulseAt(time: number): void {
    this.clockOut.offset.setValueAtTime(10, time);
    this.clockOut.offset.setValueAtTime(0, time + 0.002);
  }

  /** TRIGGER button per EG mode (C.3): ON restarts EGs; OFF acts as a held gate. */
  triggerButton(down: boolean, time: number, egMode: 'OFF' | 'ON' | 'HELD'): void {
    if (egMode === 'HELD') return; // no effect
    if (egMode === 'ON') {
      if (down) this.egTriggerAt(time);
    } else {
      this.egGate.offset.setValueAtTime(down ? 5 : 0, time);
    }
  }
}
