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
 *          linFmDepthHzPerVv (k-rate)
 */

import { OscCore, type OscSampleIn, type OscShape } from '../dsp/oscCore';

class SynthStackOscProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'frequency', defaultValue: 261.63, minValue: 0, maxValue: 20000, automationRate: 'k-rate' },
      { name: 'pulseWidth', defaultValue: 0.5, minValue: 0.01, maxValue: 0.99, automationRate: 'a-rate' },
      { name: 'shape', defaultValue: 0, minValue: 0, maxValue: 3, automationRate: 'k-rate' },
      { name: 'linFmDepthHzPerVv', defaultValue: 0, minValue: 0, maxValue: 5000, automationRate: 'k-rate' },
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

    const inp = this.inp;
    inp.baseHz = freq[0]!;
    inp.shape = (shape[0]! | 0) as OscShape;
    inp.linFmDepthHzPerVv = fmDepth[0]!;

    for (let i = 0; i < out.length; i++) {
      inp.pitchCvVv = pitchCv ? (pitchCv[i] ?? pitchCv[0] ?? 0) : 0;
      inp.linFmVv = linFm ? (linFm[i] ?? linFm[0] ?? 0) : 0;
      inp.syncIn = syncIn ? (syncIn[i] ?? 0) : 0;
      inp.pulseWidth = pw.length > 1 ? pw[i]! : pw[0]!;
      const r = this.core.processSample(inp);
      out[i] = r.out;
      if (syncOut) syncOut[i] = r.syncOut;
    }
    return true;
  }
}

registerProcessor('synthstack-osc', SynthStackOscProcessor);
