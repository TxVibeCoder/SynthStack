/**
 * AudioWorklet shell around LadderCore. No allocations in process().
 *
 * Inputs:  0 = audio (vv)
 *          1 = cutoff CV (vv, 1 vv/oct, applied per block)
 * Outputs: 0 = audio (vv)
 * Params:  cutoffHz (k-rate, smoothed in core), resonance (k-rate 0..1),
 *          drive (k-rate), mode (k-rate, rounded: 0 = LP4, 1 = HP, 2 = LP2, 3 = BP),
 *          resBass (k-rate, >= 0.5 enables RES BASS bass-preserve compensation)
 * Options: processorOptions.resScale (number, optional) — per-module resonance scale
 *          (self-oscillation onset ≈ 1/resScale); defaults to the core's 1.15.
 */

import type { FilterMode } from '../dsp/ladderCore';

import { LadderCore } from '../dsp/ladderCore';

class SynthStackLadderProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'cutoffHz', defaultValue: 1000, minValue: 10, maxValue: 24000, automationRate: 'k-rate' },
      { name: 'resonance', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'drive', defaultValue: 1, minValue: 0.1, maxValue: 10, automationRate: 'k-rate' },
      { name: 'mode', defaultValue: 0, minValue: 0, maxValue: 3, automationRate: 'k-rate' },
      { name: 'resBass', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  // mode param integer -> FilterMode. Index 0/1 preserve the original binary encoding
  // (0 = LP4, 1 = HP) so existing callers keep working; 2/3 add the new multimode taps.
  private static readonly MODE_TABLE: readonly FilterMode[] = ['LP', 'HP', 'LP2', 'BP'];

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
    const modeIdx = Math.round(parameters['mode']![0]!);
    this.core.mode = SynthStackLadderProcessor.MODE_TABLE[modeIdx] ?? 'LP';
    this.core.resBass = parameters['resBass']![0]! >= 0.5;

    this.core.processBlock(input, out, out.length, cutoffCv);
    return true;
  }
}

registerProcessor('synthstack-ladder', SynthStackLadderProcessor);
