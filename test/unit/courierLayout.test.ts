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

  // Phase C added the sequencer/arp SETTINGS controls to data/courier.json. These do NOT live on
  // the main CourierPanel voice layout — they belong to the step-editor / transport surface (a
  // separate region the UI step owns), so they are exempt from this panel-placement invariant
  // exactly as Setup-only params would be.
  // The full-face replica surfaces most seq settings onto the panel (TEMPO, CLOCK DIV, ARP
  // PATTERN/OCTAVE, SWING, GATE LENGTH, SEQ/ARP). What remains Setup-only lives on the
  // step-editor / transport surface and is exempt from the panel-placement invariant.
  const SETUP_ONLY = new Set<string>(['COU_SEQ_LENGTH', 'COU_ARP_RHYTHM', 'COU_RUN_STOP', 'COU_RESET']);

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

  // Faithful-replica spacing: gold KNOBS need room for their below-labels (≥44), but the
  // dense editor packs small selectors / lamp buttons closer, so any two control centres need
  // only clear 16 (no overlap).
  const KNOB_TYPES = new Set(['knob', 'stepKnob']);
  const typeById = new Map(courier.controls.map((c) => [c.id, c.type]));
  it('keeps knob centres ≥44 apart and every control centre ≥16 apart', () => {
    for (const [a, b] of pairs(placedControls)) {
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const bothKnobs = KNOB_TYPES.has(typeById.get(a.id) ?? '') && KNOB_TYPES.has(typeById.get(b.id) ?? '');
      const min = bothKnobs ? 44 : 16;
      expect(d, `${a.id} <-> ${b.id} only ${d.toFixed(1)} apart (min ${min})`).toBeGreaterThanOrEqual(min);
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
