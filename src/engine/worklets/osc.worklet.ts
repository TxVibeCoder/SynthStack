/**
 * AudioWorklet shell around OscCore. DSP lives in the core;
 * this file only marshals buffers and parameters. No allocations in process().
 *
 * Inputs:  0 = pitch CV (vv, 1 vv/oct, exponential)
 *          1 = linear FM (vv)
 *          2 = hard sync (rising edge resets phase)
 * Outputs: 0 = audio (±5 vv)
 *          1 = sync pulses (+5 on phase wrap)
 * Params:  frequency (Hz, k-rate), pulseWidth (a-rate), shape (k-rate int),
 *          linFmDepthHzPerVv (k-rate), waveshape (a-rate, 0..1 morph/fold),
 *          subWave (a-rate, 0..1 sub-osc morph)
 *
 * waveshape/subWave are negative sentinels by default (< 0 ⇒ "unset"): the core only takes
 * the continuous-morph path when the field is provided, so legacy graphs that never connect
 * these params keep the discrete `shape` behavior unchanged.
 */

import { OscCore, type OscSampleIn, type OscShape } from '../dsp/oscCore';

class SynthStackOscProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'frequency', defaultValue: 261.63, minValue: 0, maxValue: 20000, automationRate: 'k-rate' },
      { name: 'pulseWidth', defaultValue: 0.5, minValue: 0.01, maxValue: 0.99, automationRate: 'a-rate' },
      { name: 'shape', defaultValue: 0, minValue: 0, maxValue: 3, automationRate: 'k-rate' },
      { name: 'linFmDepthHzPerVv', defaultValue: 0, minValue: 0, maxValue: 5000, automationRate: 'k-rate' },
      // Continuous main-osc morph/fold (0..1). Default -1 = "unset" → discrete `shape` path.
      { name: 'waveshape', defaultValue: -1, minValue: -1, maxValue: 1, automationRate: 'a-rate' },
      // Sub-osc morph (0..1): tri → square → PWM. Default -1 = "unset" → no sub mixed in.
      { name: 'subWave', defaultValue: -1, minValue: -1, maxValue: 1, automationRate: 'a-rate' },
    ];
  }

  private readonly core = new OscCore(sampleRate);
  private readonly inp: OscSampleIn = {
    baseHz: 261.63,
    pitchCvVv: 0,
    linFmVv: 0,
    linFmDepthHzPerVv: 0,
    syncIn: 0,
    pulseWidth: 0.5,
    shape: 0,
    waveshape: undefined,
    subWave: undefined,
  };

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const syncOut = outputs[1]?.[0];
    const pitchCv = inputs[0]?.[0];
    const linFm = inputs[1]?.[0];
    const syncIn = inputs[2]?.[0];
    const freq = parameters['frequency']!;
    const pw = parameters['pulseWidth']!;
    const shape = parameters['shape']!;
    const fmDepth = parameters['linFmDepthHzPerVv']!;
    const wave = parameters['waveshape']!;
    const sub = parameters['subWave']!;

    const inp = this.inp;
    inp.baseHz = freq[0]!;
    inp.shape = (shape[0]! | 0) as OscShape;
    inp.linFmDepthHzPerVv = fmDepth[0]!;

    for (let i = 0; i < out.length; i++) {
      inp.pitchCvVv = pitchCv ? (pitchCv[i] ?? pitchCv[0] ?? 0) : 0;
      inp.linFmVv = linFm ? (linFm[i] ?? linFm[0] ?? 0) : 0;
      inp.syncIn = syncIn ? (syncIn[i] ?? 0) : 0;
      inp.pulseWidth = pw.length > 1 ? pw[i]! : pw[0]!;
      // negative sentinel ⇒ leave the field undefined so the core keeps the legacy path
      const ws = wave.length > 1 ? wave[i]! : wave[0]!;
      inp.waveshape = ws >= 0 ? ws : undefined;
      const swv = sub.length > 1 ? sub[i]! : sub[0]!;
      inp.subWave = swv >= 0 ? swv : undefined;
      const r = this.core.processSample(inp);
      out[i] = r.out;
      if (syncOut) syncOut[i] = r.syncOut;
    }
    return true;
  }
}

registerProcessor('synthstack-osc', SynthStackOscProcessor);
