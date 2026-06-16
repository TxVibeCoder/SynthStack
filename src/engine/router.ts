/**
 * Normalling/patch router — PURE resolution logic plus a thin
 * Web Audio binding. Resolution: patchedSource ?? defaultSource(normal) ?? silence.
 *
 * Three normal patterns, all expressed the same way in the graph: every input jack
 * is a persistent GainNode bus; the router only decides which source node feeds it.
 * Fan-out is free (outputs feed any number of inputs); inputs accept exactly one cable.
 */

import type { JackDef, ModuleDef, SignalType } from '../../data/schema';

export type JackId = string;

export interface Cable {
  id: string;
  from: JackId; // output jack
  to: JackId; // input jack
  color: string;
}

export interface PatchState {
  cables: Cable[];
}

export type SourceRef =
  | { kind: 'jack'; jackId: JackId }
  | { kind: 'internal'; sourceId: string }
  | { kind: 'silence' };

export interface JackIndex {
  byId: Map<JackId, JackDef>;
  outputs: Set<JackId>;
  inputs: Set<JackId>;
}

export function buildJackIndex(moduleDefs: ModuleDef[]): JackIndex {
  const byId = new Map<JackId, JackDef>();
  const outputs = new Set<JackId>();
  const inputs = new Set<JackId>();
  for (const def of moduleDefs) {
    for (const jack of def.jacks) {
      byId.set(jack.id, jack);
      (jack.direction === 'out' ? outputs : inputs).add(jack.id);
    }
  }
  return { byId, outputs, inputs };
}

/** patched ?? normalled ?? silence. */
export function resolveInput(jackId: JackId, patch: PatchState, index: JackIndex): SourceRef {
  const cable = patch.cables.find((c) => c.to === jackId);
  if (cable) return { kind: 'jack', jackId: cable.from };
  const def = index.byId.get(jackId);
  if (!def || def.normalledTo == null) return { kind: 'silence' };
  if (def.normalledTo.startsWith('INTERNAL:')) {
    return { kind: 'internal', sourceId: def.normalledTo.slice(9) };
  }
  return { kind: 'jack', jackId: def.normalledTo };
}

export type CableValidation =
  | { ok: true; warning?: string }
  | { ok: false; reason: string };

/** out→in only; one cable per input; signal-type warnings (audio→gate allowed but flagged). */
export function validateCable(
  from: JackId,
  to: JackId,
  index: JackIndex,
  patch: PatchState,
): CableValidation {
  if (!index.outputs.has(from)) {
    return { ok: false, reason: `${from} is not an output jack` };
  }
  if (!index.inputs.has(to)) {
    return { ok: false, reason: `${to} is not an input jack` };
  }
  if (patch.cables.some((c) => c.to === to)) {
    return { ok: false, reason: `input ${to} already has a cable` };
  }
  const fromSig = index.byId.get(from)!.signal;
  const toSig = index.byId.get(to)!.signal;
  if (toSig === 'midi' || fromSig === 'midi') {
    return { ok: false, reason: 'MIDI jacks are not patchable with audio cables' };
  }
  const warning = signalWarning(fromSig, toSig);
  return warning ? { ok: true, warning } : { ok: true };
}

function signalWarning(from: SignalType, to: SignalType): string | undefined {
  if (from === to) return undefined;
  // everything is voltage — allowed, but flag the surprising ones
  const benign = new Set([
    'cv->gate', 'gate->cv', 'clock->gate', 'gate->clock', 'clock->cv', 'cv->clock',
    'cv->audio', 'audio->cv',
  ]);
  const key = `${from}->${to}`;
  if (benign.has(key)) return undefined;
  return `patching ${from} into a ${to} input — allowed, but unusual`;
}

/** Inputs whose resolved source changes between two patch states. */
export function affectedInputs(oldPatch: PatchState, newPatch: PatchState): Set<JackId> {
  const touched = new Set<JackId>();
  const oldByTo = new Map(oldPatch.cables.map((c) => [c.to, c.from]));
  const newByTo = new Map(newPatch.cables.map((c) => [c.to, c.from]));
  for (const [to, from] of oldByTo) {
    if (newByTo.get(to) !== from) touched.add(to);
  }
  for (const [to, from] of newByTo) {
    if (oldByTo.get(to) !== from) touched.add(to);
  }
  return touched;
}

// ---------------------------------------------------------------------------
// Web Audio binding. Endpoints are persistent; only edges change.
// Abstracted over a minimal node surface so it is unit-testable with fakes.
// ---------------------------------------------------------------------------

export interface ConnectableNode {
  connect(dest: unknown): unknown;
  disconnect(dest?: unknown): void;
}

export interface EndpointRegistry {
  /** Output jack id or internal source id -> source node. */
  sourceNode(ref: SourceRef): ConnectableNode | null;
  /** Input jack id -> its persistent bus node. */
  inputBus(jackId: JackId): ConnectableNode;
}

export class RouterBinding {
  private readonly current = new Map<JackId, ConnectableNode>(); // input -> connected source
  private patch: PatchState = { cables: [] };

  constructor(
    private readonly index: JackIndex,
    private readonly registry: EndpointRegistry,
  ) {}

  get patchState(): PatchState {
    return this.patch;
  }

  /** Wire every normalled input to its default source (module construction time). */
  applyAllNormals(): void {
    for (const jackId of this.index.inputs) {
      this.rewire(jackId);
    }
  }

  /**
   * Apply a new patch state; reconnects only affected inputs. Callers debounce to
   * one call per animation frame.
   */
  applyPatch(newPatch: PatchState): void {
    const touched = affectedInputs(this.patch, newPatch);
    this.patch = { cables: [...newPatch.cables] };
    for (const jackId of touched) {
      this.rewire(jackId);
    }
  }

  private rewire(jackId: JackId): void {
    // MIDI jacks exist in the data (the Cascade's MIDI IN) but have no audio
    // endpoint in v1 — the registry skips them, so the router must too. Cables to
    // them are already rejected by validateCable.
    if (this.index.byId.get(jackId)?.signal === 'midi') return;
    const bus = this.registry.inputBus(jackId);
    const prev = this.current.get(jackId);
    if (prev) {
      try {
        prev.disconnect(bus);
      } catch {
        // already disconnected — harmless
      }
      this.current.delete(jackId);
    }
    const ref = resolveInput(jackId, this.patch, this.index);
    const src = this.registry.sourceNode(ref);
    if (src) {
      src.connect(bus);
      this.current.set(jackId, src);
    }
  }
}
