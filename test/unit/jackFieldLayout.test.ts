/**
 * Consolidated jack-field invariants (16:9 redesign): the field must place
 * EVERY jack of all three modules exactly once (88 = Cascade 32 + Anvil 24 +
 * Monarch 32), keep sockets ≥ 26 px apart, keep each machine's jacks inside its
 * own zone (Cascade | Anvil | Monarch left→right), keep every zone's INPUTS strictly
 * left of its divider and OUTPUTS strictly right of it, and respect the
 * field's stepped top edge (Monarch jacks sit below the seq strip's overhang).
 */

import { describe, expect, it } from 'vitest';
import type { ModuleDef } from '../../data/schema';
import monarchJson from '../../data/monarch.json';
import anvilJson from '../../data/anvil.json';
import cascadeJson from '../../data/cascade.json';
import {
  FIELD,
  JACK_ZONE_CHROME,
  jackFieldJacks,
} from '../../src/ui/panels/jackFieldLayout';
import { JACK_ZONES, REGIONS } from '../../src/ui/stage16x9';

const modules = {
  cascade: cascadeJson as unknown as ModuleDef,
  anvil: anvilJson as unknown as ModuleDef,
  monarch: monarchJson as unknown as ModuleDef,
} as const;

const allJackDefs = [...modules.cascade.jacks, ...modules.anvil.jacks, ...modules.monarch.jacks];

/** Stage-space zone rect → field-local (the field starts at stage y 644.78). */
function zoneLocal(key: keyof typeof JACK_ZONES): { x0: number; x1: number; y0: number; y1: number } {
  const z = JACK_ZONES[key];
  return {
    x0: z.x - REGIONS.jackField.x,
    x1: z.x + z.w - REGIONS.jackField.x,
    y0: z.y - REGIONS.jackField.y,
    y1: z.y + z.h - REGIONS.jackField.y,
  };
}

const zoneFor = (id: string): keyof typeof JACK_ZONES =>
  id.startsWith('CAS_') ? 'cascade' : id.startsWith('ANV_') ? 'anvil' : 'monarch';

describe('jackFieldLayout', () => {
  it('places all 88 jacks — every id from all three module JSONs, no strays', () => {
    expect(allJackDefs).toHaveLength(88);
    for (const j of allJackDefs) {
      expect(jackFieldJacks[j.id], `jack ${j.id} missing from the field`).toBeDefined();
    }
    const known = new Set(allJackDefs.map((j) => j.id));
    for (const id of Object.keys(jackFieldJacks)) {
      expect(known.has(id), `field jack ${id} not in any module JSON`).toBe(true);
    }
    expect(Object.keys(jackFieldJacks)).toHaveLength(88);
  });

  it('keeps every pair of jack centers at least 26 px apart', () => {
    const entries = Object.entries(jackFieldJacks);
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const [aId, a] = entries[i]!;
        const [bId, b] = entries[j]!;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        expect(d, `${aId} <-> ${bId} only ${d.toFixed(1)} apart`).toBeGreaterThanOrEqual(26);
      }
    }
  });

  it('keeps each machine’s jacks inside its own zone', () => {
    for (const [id, p] of Object.entries(jackFieldJacks)) {
      const z = zoneLocal(zoneFor(id));
      expect(p.x, `${id} x left of its zone`).toBeGreaterThanOrEqual(z.x0);
      expect(p.x, `${id} x right of its zone`).toBeLessThanOrEqual(z.x1);
      expect(p.y, `${id} y above its zone`).toBeGreaterThanOrEqual(z.y0);
      expect(p.y, `${id} y below its zone`).toBeLessThanOrEqual(z.y1);
    }
  });

  it('keeps Anvil jacks left of the field’s top-edge step (the sliver stays empty)', () => {
    for (const j of modules.anvil.jacks) {
      const p = jackFieldJacks[j.id]!;
      // ring r=11 + label ½-width ≈ 24 must clear the step line
      expect(p.x, `${j.id} too close to the step at x=${FIELD.stepX}`).toBeLessThanOrEqual(
        FIELD.stepX - 26,
      );
    }
  });

  it('keeps Monarch jacks below the seq-strip overhang (the stepped top edge)', () => {
    for (const j of modules.monarch.jacks) {
      const p = jackFieldJacks[j.id]!;
      expect(p.y, `${j.id} pokes above the step`).toBeGreaterThanOrEqual(FIELD.stepY + 16);
    }
  });

  it('splits every zone into INPUTS left of the divider, OUTPUTS right of it', () => {
    for (const chrome of JACK_ZONE_CHROME) {
      const defs = modules[chrome.key].jacks;
      for (const j of defs) {
        const p = jackFieldJacks[j.id]!;
        if (j.direction === 'in') {
          expect(p.x, `${j.id} (IN) right of the ${chrome.key} divider`).toBeLessThan(
            chrome.divider.x,
          );
        } else {
          expect(p.x, `${j.id} (OUT) left of the ${chrome.key} divider`).toBeGreaterThan(
            chrome.divider.x,
          );
        }
      }
    }
  });

  it('keeps all jacks (plus label clearance) inside the field', () => {
    for (const [id, p] of Object.entries(jackFieldJacks)) {
      expect(p.x, `${id} x`).toBeGreaterThanOrEqual(16);
      expect(p.x, `${id} x`).toBeLessThanOrEqual(FIELD.width - 16);
      expect(p.y, `${id} y`).toBeGreaterThanOrEqual(16);
      // +23 = ring 11 + label baseline offset 12, +~4 descender room
      expect(p.y + 27, `${id} label clipped at the field bottom`).toBeLessThanOrEqual(
        FIELD.height,
      );
    }
  });

  it('field dimensions equal the jackField stage region', () => {
    expect(FIELD.width).toBe(REGIONS.jackField.w);
    expect(FIELD.height).toBe(REGIONS.jackField.h);
  });
});
