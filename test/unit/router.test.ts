import { describe, expect, it } from 'vitest';
import {
  affectedInputs,
  buildJackIndex,
  resolveInput,
  RouterBinding,
  validateCable,
  type Cable,
  type ConnectableNode,
  type EndpointRegistry,
  type PatchState,
  type SourceRef,
} from '../../src/engine/router';
import type { ModuleDef } from '../../data/schema';
import monarch from '../../data/monarch.json';
import anvil from '../../data/anvil.json';
import cascade from '../../data/cascade.json';

const defs = [monarch, anvil, cascade] as unknown as ModuleDef[];
const index = buildJackIndex(defs);
const cable = (from: string, to: string, id = 'c1'): Cable => ({ id, from, to, color: '#fff' });
const patch = (...cables: Cable[]): PatchState => ({ cables });

describe('router resolution (work order §6, §8.1)', () => {
  it('unpatched input with no normal resolves to silence', () => {
    expect(resolveInput('MON_VCF_CUTOFF_IN', patch(), index)).toEqual({ kind: 'silence' });
  });

  it('unpatched input with internal normal resolves to it', () => {
    expect(resolveInput('MON_GATE_IN', patch(), index)).toEqual({
      kind: 'internal',
      sourceId: 'MON_KB_GATE',
    });
    expect(resolveInput('ANV_TRIGGER_IN', patch(), index)).toEqual({
      kind: 'internal',
      sourceId: 'ANV_SEQ_CLOCK',
    });
  });

  it('patched cable takes precedence over the normal', () => {
    const p = patch(cable('MON_LFO_SQ_OUT', 'MON_GATE_IN'));
    expect(resolveInput('MON_GATE_IN', p, index)).toEqual({ kind: 'jack', jackId: 'MON_LFO_SQ_OUT' });
  });

  it('removing the cable restores the normal', () => {
    const p = patch(cable('MON_LFO_SQ_OUT', 'MON_GATE_IN'));
    expect(resolveInput('MON_GATE_IN', p, index).kind).toBe('jack');
    expect(resolveInput('MON_GATE_IN', patch(), index)).toEqual({
      kind: 'internal',
      sourceId: 'MON_KB_GATE',
    });
  });

  it('Cascade VCO1->VCO2 pass-along normal', () => {
    expect(resolveInput('CAS_VCO2_IN', patch(), index)).toEqual({
      kind: 'internal',
      sourceId: 'CAS_VCO1_IN_SIGNAL',
    });
    const p = patch(cable('MON_KB_OUT', 'CAS_VCO2_IN'));
    expect(resolveInput('CAS_VCO2_IN', p, index)).toEqual({ kind: 'jack', jackId: 'MON_KB_OUT' });
  });
});

describe('validateCable', () => {
  it('rejects in->in, out->out, occupied inputs', () => {
    expect(validateCable('MON_GATE_IN', 'MON_VCA_CV_IN', index, patch()).ok).toBe(false);
    expect(validateCable('MON_VCA_OUT', 'MON_NOISE_OUT', index, patch()).ok).toBe(false);
    const occupied = patch(cable('MON_LFO_TRI_OUT', 'MON_VCF_CUTOFF_IN'));
    expect(validateCable('MON_EG_OUT', 'MON_VCF_CUTOFF_IN', index, occupied).ok).toBe(false);
  });

  it('allows out->in, including cross-module', () => {
    expect(validateCable('MON_ASSIGN_OUT', 'ANV_ADV_CLOCK_IN', index, patch()).ok).toBe(true);
    expect(validateCable('CAS_CLOCK_OUT', 'ANV_ADV_CLOCK_IN', index, patch()).ok).toBe(true);
  });

  it('flags unusual signal pairings but allows them', () => {
    const v = validateCable('MON_VCA_OUT', 'MON_GATE_IN', index, patch());
    expect(v.ok).toBe(true);
    expect((v as { ok: true; warning?: string }).warning).toBeTruthy();
  });

  it('rejects MIDI patching', () => {
    expect(validateCable('MON_LFO_TRI_OUT', 'CAS_MIDI_IN', index, patch()).ok).toBe(false);
  });

  it('fan-out: one output may feed many inputs', () => {
    const p = patch(cable('MON_LFO_TRI_OUT', 'MON_VCF_CUTOFF_IN', 'c1'));
    expect(validateCable('MON_LFO_TRI_OUT', 'MON_VCF_RES_IN', index, p).ok).toBe(true);
  });
});

describe('affectedInputs', () => {
  it('detects adds, removals, and source swaps only', () => {
    const a = patch(cable('MON_LFO_TRI_OUT', 'MON_VCF_CUTOFF_IN', 'c1'));
    const b = patch(
      cable('MON_EG_OUT', 'MON_VCF_CUTOFF_IN', 'c2'),
      cable('MON_LFO_SQ_OUT', 'MON_VCF_RES_IN', 'c3'),
    );
    const touched = affectedInputs(a, b);
    expect(touched).toEqual(new Set(['MON_VCF_CUTOFF_IN', 'MON_VCF_RES_IN']));
    expect(affectedInputs(a, a).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------

class FakeNode implements ConnectableNode {
  readonly connections = new Set<FakeNode>();
  constructor(readonly name: string) {}
  connect(dest: unknown): unknown {
    this.connections.add(dest as FakeNode);
    return dest;
  }
  disconnect(dest?: unknown): void {
    if (dest) this.connections.delete(dest as FakeNode);
    else this.connections.clear();
  }
}

function fakeRegistry() {
  const sources = new Map<string, FakeNode>();
  const buses = new Map<string, FakeNode>();
  const registry: EndpointRegistry = {
    sourceNode(ref: SourceRef): ConnectableNode | null {
      if (ref.kind === 'silence') return null;
      const key = ref.kind === 'jack' ? ref.jackId : `INTERNAL:${ref.sourceId}`;
      if (!sources.has(key)) sources.set(key, new FakeNode(key));
      return sources.get(key)!;
    },
    inputBus(jackId: string): ConnectableNode {
      if (!buses.has(jackId)) buses.set(jackId, new FakeNode(jackId));
      return buses.get(jackId)!;
    },
  };
  return { registry, sources, buses };
}

describe('RouterBinding (edges only, never node teardown)', () => {
  it('applyAllNormals wires every normalled input to its internal source', () => {
    const { registry, sources, buses } = fakeRegistry();
    const binding = new RouterBinding(index, registry);
    binding.applyAllNormals();
    const gateSrc = sources.get('INTERNAL:MON_KB_GATE')!;
    expect(gateSrc.connections.has(buses.get('MON_GATE_IN')!)).toBe(true);
    const velSrc = sources.get('INTERNAL:ANV_SEQ_VELOCITY_ROW')!;
    expect(velSrc.connections.has(buses.get('ANV_VELOCITY_IN')!)).toBe(true);
  });

  it('patching swaps the edge; unpatching restores the normal', () => {
    const { registry, sources, buses } = fakeRegistry();
    const binding = new RouterBinding(index, registry);
    binding.applyAllNormals();
    const bus = buses.get('MON_GATE_IN')!;
    const normalSrc = sources.get('INTERNAL:MON_KB_GATE')!;

    binding.applyPatch(patch(cable('MON_LFO_SQ_OUT', 'MON_GATE_IN')));
    const patchedSrc = sources.get('MON_LFO_SQ_OUT')!;
    expect(patchedSrc.connections.has(bus)).toBe(true);
    expect(normalSrc.connections.has(bus)).toBe(false);

    binding.applyPatch(patch());
    expect(patchedSrc.connections.has(bus)).toBe(false);
    expect(normalSrc.connections.has(bus)).toBe(true);
  });

  it('rewires only affected inputs', () => {
    const { registry, sources, buses } = fakeRegistry();
    const binding = new RouterBinding(index, registry);
    binding.applyAllNormals();
    binding.applyPatch(patch(cable('MON_LFO_TRI_OUT', 'MON_VCF_CUTOFF_IN', 'c1')));
    const gateBus = buses.get('MON_GATE_IN')!;
    const gateSrc = sources.get('INTERNAL:MON_KB_GATE')!;
    // gate edge untouched by an unrelated patch change
    binding.applyPatch(
      patch(
        cable('MON_LFO_TRI_OUT', 'MON_VCF_CUTOFF_IN', 'c1'),
        cable('MON_EG_OUT', 'MON_VCF_RES_IN', 'c2'),
      ),
    );
    expect(gateSrc.connections.has(gateBus)).toBe(true);
    expect(sources.get('MON_EG_OUT')!.connections.has(buses.get('MON_VCF_RES_IN')!)).toBe(true);
  });

  it('applyAllNormals skips MIDI jacks (registry has no endpoint for them)', () => {
    // regression: CAS_MIDI_IN used to reach registry.inputBus() and throw,
    // killing Studio.powerOn() (found by the stage-1 e2e smoke test)
    const buses = new Map<string, FakeNode>();
    const strictRegistry: EndpointRegistry = {
      sourceNode(ref: SourceRef): ConnectableNode | null {
        return ref.kind === 'silence' ? null : new FakeNode('src');
      },
      inputBus(jackId: string): ConnectableNode {
        if (jackId === 'CAS_MIDI_IN') throw new Error('no module owns input CAS_MIDI_IN');
        if (!buses.has(jackId)) buses.set(jackId, new FakeNode(jackId));
        return buses.get(jackId)!;
      },
    };
    const binding = new RouterBinding(index, strictRegistry);
    expect(() => binding.applyAllNormals()).not.toThrow();
  });

  it('MULT pass-through: patch into MULT in, fan out of MULT 1/2', () => {
    // MULT is plain jacks wired straight through inside the module (§6); the router
    // only needs to allow the cables
    expect(validateCable('MON_LFO_TRI_OUT', 'MON_MULT_IN', index, patch()).ok).toBe(true);
    const p = patch(cable('MON_LFO_TRI_OUT', 'MON_MULT_IN'));
    expect(validateCable('MON_MULT1_OUT', 'MON_VCF_CUTOFF_IN', index, p).ok).toBe(true);
    expect(validateCable('MON_MULT2_OUT', 'ANV_VCO1_CV_IN', index, p).ok).toBe(true);
  });
});
