import { describe, expect, it } from 'vitest';
import type { ModuleDef } from '../../data/schema';
import cascadeJson from '../../data/cascade.json';
import { cascadeLayout, CASCADE_W, CASCADE_H } from '../../src/ui/panels/cascadeLayout';

const cascade = cascadeJson as unknown as ModuleDef;

interface Placed {
  id: string;
  x: number;
  y: number;
}

const placedControls: Placed[] = Object.entries(cascadeLayout.controls).map(([id, p]) => ({
  id,
  x: p.x,
  y: p.y,
}));
const placedJacks: Placed[] = Object.entries(cascadeLayout.jacks).map(([id, p]) => ({
  id,
  x: p.x,
  y: p.y,
}));

/** All unordered pairs of placed elements. */
function pairs(items: Placed[]): Array<[Placed, Placed]> {
  const out: Array<[Placed, Placed]> = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      if (a !== undefined && b !== undefined) out.push([a, b]);
    }
  }
  return out;
}

describe('cascadeLayout (Cascade panel layout)', () => {
  it('uses its own landscape canvas dims (decoupled from stage regions)', () => {
    expect(cascadeLayout.width).toBe(CASCADE_W);
    expect(cascadeLayout.height).toBe(CASCADE_H);
    expect(cascadeLayout.width).toBeGreaterThan(cascadeLayout.height); // landscape
  });

  it('places every control id from data/cascade.json', () => {
    for (const c of cascade.controls) {
      expect(cascadeLayout.controls[c.id], `control ${c.id} missing a position`).toBeDefined();
    }
  });

  it('owns no jacks (all 32 moved to the consolidated jack field)', () => {
    expect(Object.keys(cascadeLayout.jacks)).toHaveLength(0);
  });

  it('has no stray ids that are not in the module JSON', () => {
    const controlIds = new Set(cascade.controls.map((c) => c.id));
    const jackIds = new Set(cascade.jacks.map((j) => j.id));
    for (const id of Object.keys(cascadeLayout.controls)) {
      expect(controlIds.has(id), `layout control ${id} not in JSON`).toBe(true);
    }
    for (const id of Object.keys(cascadeLayout.jacks)) {
      expect(jackIds.has(id), `layout jack ${id} not in JSON`).toBe(true);
    }
  });

  it('keeps every pair of control centers at least 40 units apart', () => {
    for (const [a, b] of pairs(placedControls)) {
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      expect(d, `${a.id} <-> ${b.id} only ${d.toFixed(1)} apart`).toBeGreaterThanOrEqual(40);
    }
  });

  it('keeps all control and jack positions inside the viewBox', () => {
    for (const p of [...placedControls, ...placedJacks]) {
      expect(p.x, `${p.id} x`).toBeGreaterThanOrEqual(0);
      expect(p.x, `${p.id} x`).toBeLessThanOrEqual(cascadeLayout.width);
      expect(p.y, `${p.id} y`).toBeGreaterThanOrEqual(0);
      expect(p.y, `${p.id} y`).toBeLessThanOrEqual(cascadeLayout.height);
    }
  });
});
