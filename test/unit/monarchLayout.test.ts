/**
 * Layout invariants for the Monarch panel (16:9 redesign: CONTROLS-ONLY —
 * jack placement is jackFieldLayout's job, tested in jackFieldLayout.test.ts).
 * Every control id in data/monarch.json must be placed, nothing may collide
 * (controls ≥ 40 units apart), and everything must sit inside the panel
 * viewBox, which is the panel's OWN landscape canvas (MONARCH_W × MONARCH_H) —
 * the voice tab is decoupled from the stage16x9 regions (App.tsx frames it directly).
 */

import { describe, expect, it } from 'vitest';
import { monarchLayout, MONARCH_W, MONARCH_H } from '../../src/ui/panels/monarchLayout';
import monarch from '../../data/monarch.json';
import type { ModuleDef } from '../../data/schema';
import type { Pt } from '../../src/ui/types';

const def = monarch as unknown as ModuleDef;

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Asserts every pairwise distance among `entries` is >= `minUnits`. */
function assertMinPitch(entries: [string, Pt][], minUnits: number): void {
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]!;
      const b = entries[j]!;
      expect(
        dist(a[1], b[1]),
        `${a[0]} and ${b[0]} closer than ${minUnits} units`,
      ).toBeGreaterThanOrEqual(minUnits);
    }
  }
}

describe('monarchLayout', () => {
  it('uses its own landscape canvas dims (decoupled from stage regions)', () => {
    expect(monarchLayout.width).toBe(MONARCH_W);
    expect(monarchLayout.height).toBe(MONARCH_H);
    expect(monarchLayout.width).toBeGreaterThan(monarchLayout.height); // landscape
  });

  it('places every control id from data/monarch.json', () => {
    for (const c of def.controls) {
      expect(monarchLayout.controls[c.id], `missing control position for ${c.id}`).toBeDefined();
    }
  });

  it('owns no jacks (all 32 moved to the consolidated jack field)', () => {
    expect(Object.keys(monarchLayout.jacks)).toHaveLength(0);
  });

  it('has no stray control/jack keys that are not in the JSON', () => {
    const controlIds = new Set(def.controls.map((c) => c.id));
    const jackIds = new Set(def.jacks.map((j) => j.id));
    for (const key of Object.keys(monarchLayout.controls)) {
      expect(controlIds.has(key), `unknown control key ${key}`).toBe(true);
    }
    for (const key of Object.keys(monarchLayout.jacks)) {
      expect(jackIds.has(key), `unknown jack key ${key}`).toBe(true);
    }
  });

  it('keeps control centers >= 40 units apart', () => {
    assertMinPitch(Object.entries(monarchLayout.controls), 40);
  });

  it('keeps all control and jack positions inside the viewBox', () => {
    const all: [string, Pt][] = [
      ...Object.entries(monarchLayout.controls),
      ...Object.entries(monarchLayout.jacks),
    ];
    for (const [id, p] of all) {
      expect(p.x, `${id} x`).toBeGreaterThanOrEqual(0);
      expect(p.x, `${id} x`).toBeLessThanOrEqual(monarchLayout.width);
      expect(p.y, `${id} y`).toBeGreaterThanOrEqual(0);
      expect(p.y, `${id} y`).toBeLessThanOrEqual(monarchLayout.height);
    }
  });

  it('keeps section rects inside the viewBox', () => {
    for (const s of monarchLayout.sections) {
      expect(s.x, s.label).toBeGreaterThanOrEqual(0);
      expect(s.y, s.label).toBeGreaterThanOrEqual(0);
      expect(s.x + s.w, s.label).toBeLessThanOrEqual(monarchLayout.width);
      expect(s.y + s.h, s.label).toBeLessThanOrEqual(monarchLayout.height);
    }
  });
});
