/**
 * Layout invariants for the Anvil panel (16:9 redesign: CONTROLS-ONLY — jack
 * placement is jackFieldLayout's job, tested in jackFieldLayout.test.ts).
 * Every control id in data/anvil.json must be placed, nothing may collide
 * (controls ≥ 40 units apart), and everything must sit inside the panel
 * viewBox, which equals the stage region (stage16x9.REGIONS.anvilControls).
 */

import { describe, expect, it } from 'vitest';
import { anvilLayout } from '../../src/ui/panels/anvilLayout';
import { REGIONS } from '../../src/ui/stage16x9';
import anvil from '../../data/anvil.json';
import type { ModuleDef } from '../../data/schema';
import type { Pt } from '../../src/ui/types';

const def = anvil as unknown as ModuleDef;

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

describe('anvilLayout', () => {
  it('matches the anvilControls stage region (16:9 redesign)', () => {
    expect(anvilLayout.width).toBe(REGIONS.anvilControls.w);
    expect(anvilLayout.height).toBe(REGIONS.anvilControls.h);
  });

  it('places every control id from data/anvil.json', () => {
    for (const c of def.controls) {
      expect(anvilLayout.controls[c.id], `missing control position for ${c.id}`).toBeDefined();
    }
  });

  it('owns no jacks (all 24 moved to the consolidated jack field)', () => {
    expect(Object.keys(anvilLayout.jacks)).toHaveLength(0);
  });

  it('has no stray control/jack keys that are not in the JSON', () => {
    const controlIds = new Set(def.controls.map((c) => c.id));
    const jackIds = new Set(def.jacks.map((j) => j.id));
    for (const key of Object.keys(anvilLayout.controls)) {
      expect(controlIds.has(key), `unknown control key ${key}`).toBe(true);
    }
    for (const key of Object.keys(anvilLayout.jacks)) {
      expect(jackIds.has(key), `unknown jack key ${key}`).toBe(true);
    }
  });

  it('keeps control centers >= 40 units apart', () => {
    assertMinPitch(Object.entries(anvilLayout.controls), 40);
  });

  it('keeps all control and jack positions inside the viewBox', () => {
    const all: [string, Pt][] = [
      ...Object.entries(anvilLayout.controls),
      ...Object.entries(anvilLayout.jacks),
    ];
    for (const [id, p] of all) {
      expect(p.x, `${id} x`).toBeGreaterThanOrEqual(0);
      expect(p.x, `${id} x`).toBeLessThanOrEqual(anvilLayout.width);
      expect(p.y, `${id} y`).toBeGreaterThanOrEqual(0);
      expect(p.y, `${id} y`).toBeLessThanOrEqual(anvilLayout.height);
    }
  });

  it('keeps section rects inside the viewBox', () => {
    for (const s of anvilLayout.sections) {
      expect(s.x, s.label).toBeGreaterThanOrEqual(0);
      expect(s.y, s.label).toBeGreaterThanOrEqual(0);
      expect(s.x + s.w, s.label).toBeLessThanOrEqual(anvilLayout.width);
      expect(s.y + s.h, s.label).toBeLessThanOrEqual(anvilLayout.height);
    }
  });
});
