/**
 * AudioWorklet shell around LadderCore. No allocations in process().
 *
 * Inputs:  0 = audio (vv)
 *          1 = cutoff CV (vv, 1 vv/oct, applied per block)
 * Outputs: 0 = audio (vv)
 * Params:  cutoffHz (k-rate, smoothed in core), resonance (k-rate 0..1),
 *          drive (k-rate), mode (k-rate: 0 = LP, 1 = HP)
 * Options: processorOptions.resScale (number, optional) — per-module resonance scale
 *          (self-oscillation onset ≈ 1/resScale); defaults to the core's 1.15.
 */

import { LadderCore } from '../dsp/ladderCore';

class SynthStackLadderProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'cutoffHz', defaultValue: 1000, minValue: 10, maxValue: 24000, automationRate: 'k-rate' },
      { name: 'resonance', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'drive', defaultValue: 1, minValue: 0.1, maxValue: 10, automationRate: 'k-rate' },
      { name: 'mode', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  private readonly core = new LadderCore(sampleRate);
  private readonly silence = new Float32Array(128);

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    // Optional per-module resonance scale (e.g. the Cascade's earlier self-oscillation onset).
    // Omitted by Monarch/Anvil, which keep the core default (1.15).
    const resScale = (options?.processorOptions as { resScale?: number } | undefined)?.resScale;
    if (typeof resScale === 'number') this.core.setResonanceScale(resScale);
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const input = inputs[0]?.[0] ?? this.silence;
    const cutoffCv = inputs[1]?.[0];

    this.core.setCutoffHz(parameters['cutoffHz']![0]!);
    this.core.setResonance01(parameters['resonance']![0]!);
    this.core.drive = parameters['drive']![0]!;
    this.core.mode = parameters['mode']![0]! >= 0.5 ? 'HP' : 'LP';

    this.core.processBlock(input, out, out.length, cutoffCv);
    return true;
  }
}

registerProcessor('synthstack-ladder', SynthStackLadderProcessor);
