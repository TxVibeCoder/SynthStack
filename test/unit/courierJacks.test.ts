/**
 * Courier jack-band invariants: the band must place EVERY Courier jack (9 = 4 in + 5 out)
 * exactly once, keep sockets ≥ 26 px apart, split INPUTS strictly left of OUTPUTS, and keep
 * every jack (plus label clearance) inside the band. Mirrors jackFieldLayout.test.ts for the
 * separately-docked Courier zone.
 */

import { describe, expect, it } from 'vitest';
import type { ModuleDef } from '../../data/schema';
import courierJson from '../../data/courier.json';
import { COURIER_JACK_POS, CJ_W, CJ_H } from '../../src/ui/panels/CourierJacks';

const courier = courierJson as unknown as ModuleDef;
const dirById = new Map(courier.jacks.map((j) => [j.id, j.direction]));

describe('CourierJacks band', () => {
  it('places all 9 Courier jacks, no strays', () => {
    expect(courier.jacks).toHaveLength(9);
    for (const j of courier.jacks) {
      expect(COURIER_JACK_POS[j.id], `jack ${j.id} missing from the band`).toBeDefined();
    }
    const known = new Set(courier.jacks.map((j) => j.id));
    for (const id of Object.keys(COURIER_JACK_POS)) {
      expect(known.has(id), `band jack ${id} not in courier.json`).toBe(true);
    }
    expect(Object.keys(COURIER_JACK_POS)).toHaveLength(9);
  });

  it('keeps every pair of jack centres ≥ 26 px apart', () => {
    const e = Object.entries(COURIER_JACK_POS);
    for (let i = 0; i < e.length; i++) {
      for (let j = i + 1; j < e.length; j++) {
        const [aId, a] = e[i]!;
        const [bId, b] = e[j]!;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        expect(d, `${aId} <-> ${bId} only ${d.toFixed(1)} apart`).toBeGreaterThanOrEqual(26);
      }
    }
  });

  it('splits INPUTS strictly left of OUTPUTS', () => {
    const ins = Object.entries(COURIER_JACK_POS).filter(([id]) => dirById.get(id) === 'in');
    const outs = Object.entries(COURIER_JACK_POS).filter(([id]) => dirById.get(id) === 'out');
    const maxInX = Math.max(...ins.map(([, p]) => p.x));
    const minOutX = Math.min(...outs.map(([, p]) => p.x));
    expect(maxInX, 'an input sits at/right of an output').toBeLessThan(minOutX);
  });

  it('keeps all jacks (plus label clearance) inside the band', () => {
    for (const [id, p] of Object.entries(COURIER_JACK_POS)) {
      expect(p.x, `${id} x`).toBeGreaterThanOrEqual(16);
      expect(p.x, `${id} x`).toBeLessThanOrEqual(CJ_W - 16);
      expect(p.y, `${id} y`).toBeGreaterThanOrEqual(16);
      expect(p.y + 27, `${id} label clipped at the band bottom`).toBeLessThanOrEqual(CJ_H);
    }
  });
});
