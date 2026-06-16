/**
 * Adapts a set of ModuleBase instances to the router's EndpointRegistry.
 * Jack ids are globally namespaced (MON_*, ANV_*, CAS_*) so cross-module
 * patching needs no extra work.
 */

import type { ConnectableNode, EndpointRegistry, SourceRef } from '../router';
import type { ModuleBase } from './moduleBase';

export class StudioEndpointRegistry implements EndpointRegistry {
  private readonly inputOwner = new Map<string, ModuleBase>();
  private readonly outputOwner = new Map<string, ModuleBase>();
  private readonly internalOwner = new Map<string, ModuleBase>();

  constructor(modules: ModuleBase[]) {
    for (const m of modules) {
      for (const jack of m.def.jacks) {
        if (jack.signal === 'midi') continue;
        (jack.direction === 'in' ? this.inputOwner : this.outputOwner).set(jack.id, m);
      }
      for (const src of m.def.internalSources) {
        this.internalOwner.set(src, m);
      }
    }
  }

  sourceNode(ref: SourceRef): ConnectableNode | null {
    if (ref.kind === 'silence') return null;
    if (ref.kind === 'internal') {
      const owner = this.internalOwner.get(ref.sourceId);
      return owner ? (owner.internalSource(ref.sourceId) as ConnectableNode) : null;
    }
    const owner = this.outputOwner.get(ref.jackId);
    return owner ? (owner.outputTap(ref.jackId) as ConnectableNode) : null;
  }

  inputBus(jackId: string): ConnectableNode {
    const owner = this.inputOwner.get(jackId);
    if (!owner) throw new Error(`no module owns input ${jackId}`);
    return owner.inputBus(jackId) as ConnectableNode;
  }
}
