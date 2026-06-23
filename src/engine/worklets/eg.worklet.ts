/**
 * AudioWorklet shell around EgCore. No allocations in process().
 *
 * Inputs:  0 = gate/trigger (vv, threshold 2.5 rising)
 *          1 = velocity (vv 0..5, Anvil) — optional
 * Outputs: 0 = EG level (vv)
 * Params:  attackS, decayS, releaseS (k-rate; releaseS used only by the 'adsr' mode)
 * Config (processorOptions / port messages): sustainMode, retrigInAttack,
 * attackCompletes, peakVv, forceHeld, and (ADSR only) sustainLevel + loop.
 */

import { EgCore, type EgConfig } from '../dsp/egCore';

interface EgOptionsMessage {
  type: 'configure';
  config: Partial<EgConfig>;
}
interface EgHeldMessage {
  type: 'forceHeld';
  held: boolean;
}

class SynthStackEgProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'attackS', defaultValue: 0.01, minValue: 0.0005, maxValue: 10, automationRate: 'k-rate' },
      { name: 'decayS', defaultValue: 0.3, minValue: 0.001, maxValue: 10, automationRate: 'k-rate' },
      { name: 'releaseS', defaultValue: 0, minValue: 0, maxValue: 10, automationRate: 'k-rate' },
    ];
  }

  private readonly core: EgCore;

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    const cfg = (options?.processorOptions ?? {}) as Partial<EgConfig>;
    this.core = new EgCore(sampleRate, {
      attackS: cfg.attackS ?? 0.01,
      decayS: cfg.decayS ?? 0.3,
      sustainMode: cfg.sustainMode ?? 'gateHold',
      retrigInAttack: cfg.retrigInAttack ?? true,
      attackCompletes: cfg.attackCompletes ?? false,
      peakVv: cfg.peakVv ?? 7.5,
      // ADSR-only seeds: pass them through so processorOptions actually configures the core at
      // construction (EgCore applies its own ?? defaults when omitted, so the A-D voices are
      // unaffected). releaseS is also a k-rate AudioParam, re-read every block in process().
      sustainLevel: cfg.sustainLevel,
      releaseS: cfg.releaseS,
      loop: cfg.loop,
      useVelocity: cfg.useVelocity,
    });
    this.port.onmessage = (e: MessageEvent) => {
      const msg = e.data as EgOptionsMessage | EgHeldMessage;
      if (msg.type === 'configure') this.core.configure(msg.config);
      else if (msg.type === 'forceHeld') this.core.forceHeld = msg.held;
    };
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const gate = inputs[0]?.[0];
    const velocity = inputs[1]?.[0];

    this.core.setTimes(parameters['attackS']![0]!, parameters['decayS']![0]!, parameters['releaseS']![0]!);
    if (velocity && velocity.length > 0) this.core.setVelocity(velocity[0]!);

    for (let i = 0; i < out.length; i++) {
      out[i] = this.core.processSample(gate ? (gate[i] ?? 0) : 0);
    }
    return true;
  }
}

registerProcessor('synthstack-eg', SynthStackEgProcessor);
