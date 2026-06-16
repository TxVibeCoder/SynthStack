/**
 * ModuleBase: builds persistent jack endpoints from a module JSON.
 * Inputs -> GainNode buses; outputs -> GainNode taps; internal sources register here
 * so the router can resolve 'INTERNAL:<id>' normals. Nodes are created once and
 * never destroyed — patching only changes edges.
 */

import type { JackDef, ModuleDef } from '../../../data/schema';

export class ModuleBase {
  readonly ctx: BaseAudioContext;
  readonly def: ModuleDef;
  private readonly inputBuses = new Map<string, GainNode>();
  private readonly outputTaps = new Map<string, GainNode>();
  private readonly internal = new Map<string, AudioNode>();

  constructor(ctx: BaseAudioContext, def: ModuleDef) {
    this.ctx = ctx;
    this.def = def;
    for (const jack of def.jacks) {
      if (jack.signal === 'midi') continue; // MIDI jack exists in data; engine deferred (v1)
      const node = ctx.createGain();
      node.gain.value = 1;
      if (jack.direction === 'in') this.inputBuses.set(jack.id, node);
      else this.outputTaps.set(jack.id, node);
    }
  }

  inputBus(jackId: string): GainNode {
    const n = this.inputBuses.get(jackId);
    if (!n) throw new Error(`unknown input jack ${jackId}`);
    return n;
  }

  outputTap(jackId: string): GainNode {
    const n = this.outputTaps.get(jackId);
    if (!n) throw new Error(`unknown output jack ${jackId}`);
    return n;
  }

  registerInternal(sourceId: string, node: AudioNode): void {
    this.internal.set(sourceId, node);
  }

  internalSource(sourceId: string): AudioNode {
    const n = this.internal.get(sourceId);
    if (!n) throw new Error(`unknown internal source ${sourceId}`);
    return n;
  }

  /** All jack defs that have a normal — the router wires/un-wires these edges. */
  get normalledInputs(): JackDef[] {
    return this.def.jacks.filter((j) => j.direction === 'in' && j.normalledTo != null);
  }
}
