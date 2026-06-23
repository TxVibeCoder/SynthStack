import { describe, expect, it } from 'vitest';
import type { ModuleDef } from '../../data/schema';
import courierJson from '../../data/courier.json';
import { courierLayout, COURIER_W, COURIER_H } from '../../src/ui/panels/courierLayout';

const courier = courierJson as unknown as ModuleDef;

interface Placed {
  id: string;
  x: number;
  y: number;
}

const placedControls: Placed[] = Object.entries(courierLayout.controls).map(([id, p]) => ({
  id,
  x: p.x,
  y: p.y,
}));
const placedJacks: Placed[] = Object.entries(courierLayout.jacks).map(([id, p]) => ({
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

describe('courierLayout (Courier panel layout)', () => {
  it('uses its own landscape canvas dims (decoupled from stage regions)', () => {
    expect(courierLayout.width).toBe(COURIER_W);
    expect(courierLayout.height).toBe(COURIER_H);
    expect(courierLayout.width).toBeGreaterThan(courierLayout.height); // landscape
  });

  // No Setup-only params on Courier (Phase A): every authored control has a front-panel
  // position. The sequencer/arp controls are deferred to a later phase and not in the JSON
  // controls[] yet, so there is nothing to exempt here.
  const SETUP_ONLY = new Set<string>([]);

  it('places every panel control id from data/courier.json (Setup-only params excluded)', () => {
    for (const c of courier.controls) {
      if (SETUP_ONLY.has(c.id)) continue;
      expect(courierLayout.controls[c.id], `control ${c.id} missing a position`).toBeDefined();
    }
  });

  it('owns no jacks (all moved to the consolidated jack field)', () => {
    expect(Object.keys(courierLayout.jacks)).toHaveLength(0);
  });

  it('has no stray ids that are not in the module JSON', () => {
    const controlIds = new Set(courier.controls.map((c) => c.id));
    const jackIds = new Set(courier.jacks.map((j) => j.id));
    for (const id of Object.keys(courierLayout.controls)) {
      expect(controlIds.has(id), `layout control ${id} not in JSON`).toBe(true);
    }
    for (const id of Object.keys(courierLayout.jacks)) {
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
      expect(p.x, `${p.id} x`).toBeLessThanOrEqual(courierLayout.width);
      expect(p.y, `${p.id} y`).toBeGreaterThanOrEqual(0);
      expect(p.y, `${p.id} y`).toBeLessThanOrEqual(courierLayout.height);
    }
  });
});
