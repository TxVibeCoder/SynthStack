import { describe, expect, it } from 'vitest';
import { validateModuleDef, type ModuleDef } from '../../data/schema';
import monarch from '../../data/monarch.json';
import anvil from '../../data/anvil.json';
import cascade from '../../data/cascade.json';
import sampler from '../../data/sampler.json';

const modules = [
  { def: monarch as unknown as ModuleDef, inputs: 18, outputs: 14 },
  { def: anvil as unknown as ModuleDef, inputs: 15, outputs: 9 },
  { def: cascade as unknown as ModuleDef, inputs: 17, outputs: 15 },
  { def: sampler as unknown as ModuleDef, inputs: 8, outputs: 9 },
];

describe('module data (work order §5, Appendices A–C)', () => {
  for (const { def, inputs, outputs } of modules) {
    describe(def.id, () => {
      it('passes schema validation', () => {
        expect(validateModuleDef(def)).toEqual([]);
      });

      it(`has exactly ${inputs} input jacks and ${outputs} output jacks`, () => {
        expect(def.jacks.filter((j) => j.direction === 'in')).toHaveLength(inputs);
        expect(def.jacks.filter((j) => j.direction === 'out')).toHaveLength(outputs);
      });

      it('every jack has a manual page reference', () => {
        for (const j of def.jacks) {
          expect(j.manualRef, `jack ${j.id}`).toBeTruthy();
        }
      });

      it('every normalledTo references an existing output jack or internal source', () => {
        const outputIds = new Set(def.jacks.filter((j) => j.direction === 'out').map((j) => j.id));
        const internal = new Set(def.internalSources);
        for (const j of def.jacks) {
          if (j.normalledTo == null) continue;
          if (j.normalledTo.startsWith('INTERNAL:')) {
            expect(internal.has(j.normalledTo.slice(9)), `${j.id} -> ${j.normalledTo}`).toBe(true);
          } else {
            expect(outputIds.has(j.normalledTo), `${j.id} -> ${j.normalledTo}`).toBe(true);
          }
        }
      });

      it('every knob has min < max and default in range', () => {
        for (const c of def.controls) {
          if (c.type !== 'knob' && c.type !== 'stepKnob') continue;
          expect(c.min, `${c.id} min`).toBeTypeOf('number');
          expect(c.max, `${c.id} max`).toBeTypeOf('number');
          expect(c.min!, `${c.id} min<max`).toBeLessThan(c.max!);
          expect(c.default, `${c.id} default`).toBeTypeOf('number');
          expect(c.default as number, `${c.id} default>=min`).toBeGreaterThanOrEqual(c.min!);
          expect(c.default as number, `${c.id} default<=max`).toBeLessThanOrEqual(c.max!);
        }
      });
    });
  }

  it('jack ids are globally unique across modules (needed for cross-module patching)', () => {
    const all = modules.flatMap(({ def }) => def.jacks.map((j) => j.id));
    expect(new Set(all).size).toBe(all.length);
  });
});
