/**
 * Layout invariants for the SAMPLER pad section (feature-sampler-pads). The pad
 * geometry is INDEXED (PADS), not keyed by control id, so the checks mirror the
 * per-panel layout tests in spirit: all 8 pads placed, knob centers ≥ 40 units
 * apart (the anvil minimum), jack centers ≥ 26 units apart (the jack-field
 * minimum), everything inside the viewBox (0..width / 0..height), and the jacks
 * spelled exactly as data/sampler.json declares them (so the layout can never
 * drift from the ids SamplerPanel reads + the CableLayer patches).
 *
 * SAMPLER_REGION is a sampler-owned constant (NOT in stage16x9.REGIONS) — its
 * width must span the stage and it must sit directly under the 16:9 console.
 */

import { describe, expect, it } from 'vitest';
import {
  PADS,
  PAD_SECTION_H,
  QUANT,
  SAMPLER_REGION,
  samplerLayout,
  DRUM_REGION,
  DRUM_SECTION_H,
  SAMPLER_TOTAL_H,
  DRUM_GRID,
  DRUM_TRANSPORT,
  cellRect,
  columnX,
  drumLayout,
  type PadCell,
} from '../../src/ui/panels/samplerLayout';
import { STAGE } from '../../src/ui/stage16x9';
import samplerJson from '../../data/sampler.json';
import type { ModuleDef } from '../../data/schema';
import type { Pt } from '../../src/ui/types';

const def = samplerJson as unknown as ModuleDef;

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Jack hit-circle radius (theme.JACK_RADIUS.hit) — the patchable target the CableLayer
 *  hit-tests; must NOT be occluded by any later-painted transparent rect. */
const JACK_HIT_R = 16;

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The LOOP Switch's transparent hit-rect in cell-local coords, mirroring Switch.tsx for a
 * 2-position switch: slotH = max(count-1,1)*16 + 14 = 30, rect x ∈ [cx-34, cx+50] and
 * y ∈ [cy-(slotH/2+18), cy+slotH/2] = [cy-33, cy+15]. This rect is painted AFTER the jacks
 * (LOOP <g> renders last in the pad), so wherever it covers a jack's hit circle the jack
 * becomes un-patchable — the regression this asserts against.
 */
function loopHitRect(p: PadCell): Rect {
  const slotH = (2 - 1) * 16 + 14; // 2-position LOOP switch -> slotH = 30 (Switch.tsx)
  return {
    x0: p.loopX - 34,
    y0: p.loopY - (slotH / 2 + 18),
    x1: p.loopX + 50,
    y1: p.loopY + slotH / 2,
  };
}

/**
 * The KIT factory-picker trigger's DRAWN hit-rect in screen (panel-local) coords. UNLIKE the
 * LOOP Switch, the KIT button's hit area IS its drawn rect (mirrors the LOAD <g>, no oversized
 * transparent rect), so this is the actual clickable footprint. The ~34×14 rect is centered on
 * (kitX, kitY): x ∈ [kitX-17, kitX+17], y ∈ [kitY-7, kitY+7]. It is painted in the pad alongside
 * the LOAD button; the invariant below pins that it never reaches the OUT/TRIG jack hit-circles.
 */
function kitHitRect(p: PadCell): Rect {
  return {
    x0: p.kitX - 17,
    y0: p.kitY - 7,
    x1: p.kitX + 17,
    y1: p.kitY + 7,
  };
}

/** True if axis-aligned `r` intersects the circle of radius `radius` centered at `c`. */
function rectIntersectsCircle(r: Rect, c: Pt, radius: number): boolean {
  const nearestX = Math.max(r.x0, Math.min(c.x, r.x1));
  const nearestY = Math.max(r.y0, Math.min(c.y, r.y1));
  return Math.hypot(c.x - nearestX, c.y - nearestY) < radius;
}

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

/** All knob centers across all pads, tagged by id. */
function allKnobs(): [string, Pt][] {
  const out: [string, Pt][] = [];
  for (const p of PADS) {
    out.push([`SAMP_PAD${p.index + 1}_LEVEL`, { x: p.levelX, y: p.levelY }]);
    out.push([`SAMP_PAD${p.index + 1}_TUNE`, { x: p.tuneX, y: p.tuneY }]);
  }
  return out;
}

/** All jack centers across all pads, tagged by id. */
function allJacks(): [string, Pt][] {
  const out: [string, Pt][] = [];
  for (const p of PADS) {
    out.push([`SAMP_PAD${p.index + 1}_OUT`, { x: p.outX, y: p.outY }]);
    out.push([`SAMP_PAD${p.index + 1}_TRIG_IN`, { x: p.trigX, y: p.trigY }]);
  }
  return out;
}

/** Every placeable point in one cell, tagged for containment checks. */
function cellPoints(p: PadCell): [string, Pt][] {
  const n = p.index + 1;
  return [
    [`pad${n} face`, { x: p.faceX, y: p.faceY }],
    [`pad${n} level`, { x: p.levelX, y: p.levelY }],
    [`pad${n} tune`, { x: p.tuneX, y: p.tuneY }],
    [`pad${n} out`, { x: p.outX, y: p.outY }],
    [`pad${n} trig`, { x: p.trigX, y: p.trigY }],
    [`pad${n} name`, { x: p.nameX, y: p.nameY }],
    [`pad${n} load`, { x: p.loadX, y: p.loadY }],
    [`pad${n} loop`, { x: p.loopX, y: p.loopY }],
    [`pad${n} kit`, { x: p.kitX, y: p.kitY }],
  ];
}

describe('samplerLayout', () => {
  it('SAMPLER_REGION spans the stage width and sits under the 16:9 console', () => {
    expect(SAMPLER_REGION.w).toBe(STAGE.w);
    expect(SAMPLER_REGION.y).toBe(STAGE.h);
    expect(SAMPLER_REGION.x).toBe(0);
    expect(SAMPLER_REGION.h).toBe(PAD_SECTION_H);
  });

  it('the panel viewBox is the stage width × the pad-section height', () => {
    expect(samplerLayout.width).toBe(STAGE.w);
    expect(samplerLayout.height).toBe(PAD_SECTION_H);
    expect(samplerLayout.title).toBe('SAMPLER');
  });

  it('places exactly the 8 pads, indexed 0..7', () => {
    expect(PADS).toHaveLength(8);
    expect(PADS.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('keeps every knob center >= 40 units apart', () => {
    assertMinPitch(allKnobs(), 40);
  });

  it('keeps every jack center >= 26 units apart (the jack-field minimum)', () => {
    assertMinPitch(allJacks(), 26);
  });

  it('keeps every pad element inside the viewBox', () => {
    for (const p of PADS) {
      for (const [id, pt] of cellPoints(p)) {
        expect(pt.x, `${id} x`).toBeGreaterThanOrEqual(0);
        expect(pt.x, `${id} x`).toBeLessThanOrEqual(samplerLayout.width);
        expect(pt.y, `${id} y`).toBeGreaterThanOrEqual(0);
        expect(pt.y, `${id} y`).toBeLessThanOrEqual(samplerLayout.height);
      }
      // the pad face RECT (not just its center) must fit too
      expect(p.faceX - p.faceW / 2, `pad${p.index + 1} face left`).toBeGreaterThanOrEqual(0);
      expect(p.faceX + p.faceW / 2, `pad${p.index + 1} face right`).toBeLessThanOrEqual(
        samplerLayout.width,
      );
      expect(p.faceY - p.faceH / 2, `pad${p.index + 1} face top`).toBeGreaterThanOrEqual(0);
      expect(p.faceY + p.faceH / 2, `pad${p.index + 1} face bottom`).toBeLessThanOrEqual(
        samplerLayout.height,
      );
    }
  });

  it('its jack ids match data/sampler.json (OUT + TRIG_IN per pad)', () => {
    const layoutJackIds = new Set(allJacks().map(([id]) => id));
    const jsonOutAndTrig = def.jacks
      .map((j) => j.id)
      .filter((id) => /^SAMP_PAD[1-8]_(OUT|TRIG_IN)$/.test(id));
    expect(jsonOutAndTrig).toHaveLength(16);
    for (const id of jsonOutAndTrig) {
      expect(layoutJackIds.has(id), `layout missing jack ${id}`).toBe(true);
    }
    // and the layout invents no jack the JSON doesn't declare
    const jsonIds = new Set(def.jacks.map((j) => j.id));
    for (const id of layoutJackIds) {
      expect(jsonIds.has(id), `layout has unknown jack ${id}`).toBe(true);
    }
  });

  it('its knob ids match data/sampler.json (LEVEL + TUNE per pad)', () => {
    const layoutKnobIds = new Set(allKnobs().map(([id]) => id));
    const controlIds = new Set(def.controls.map((c) => c.id));
    for (const id of layoutKnobIds) {
      expect(controlIds.has(id), `layout has unknown control ${id}`).toBe(true);
    }
    expect(layoutKnobIds.size).toBe(16);
  });

  it("the LOOP switch hit-rect never occludes that pad's OUT/TRIG jack hit-circles", () => {
    // Regression (loop-quantize): the per-pad LOOP Switch paints a transparent
    // full-footprint hit-rect; placed on the x320 OUT/TRIG column it sat on TOP of the
    // TRIG jack (LOOP renders last), so CableLayer.elementFromPoint hit the LOOP rect
    // instead of the jack and you could neither start nor drop a cable on TRIG_IN.
    for (const p of PADS) {
      const rect = loopHitRect(p);
      const out: Pt = { x: p.outX, y: p.outY };
      const trig: Pt = { x: p.trigX, y: p.trigY };
      expect(
        rectIntersectsCircle(rect, out, JACK_HIT_R),
        `pad${p.index + 1} LOOP hit-rect occludes the OUT jack`,
      ).toBe(false);
      expect(
        rectIntersectsCircle(rect, trig, JACK_HIT_R),
        `pad${p.index + 1} LOOP hit-rect occludes the TRIG_IN jack`,
      ).toBe(false);
    }
  });

  it('the LOOP switch hit-rect stays within the pad cell (no neighbor bleed)', () => {
    // The cell is 400 wide × 140 tall (CELL_W × ROW_PITCH); keep the LOOP hit-rect inside
    // it so it can't reach a sibling cell's controls in the gutter.
    const CELL_W = 400;
    const CELL_H = 140;
    for (const p of PADS) {
      // Recover the cell origin from the OUT jack's known cell-local offset (320,44),
      // so the rect can be expressed in cell-local coords without exporting the layout
      // constants. (TRIG sits at (320,96); either jack recovers the same origin.)
      const x0 = p.outX - 320;
      const y0 = p.outY - 44;
      const r = loopHitRect(p);
      expect(r.x0 - x0, `pad${p.index + 1} LOOP rect off the cell left`).toBeGreaterThanOrEqual(0);
      expect(r.x1 - x0, `pad${p.index + 1} LOOP rect off the cell right`).toBeLessThanOrEqual(CELL_W);
      expect(r.y0 - y0, `pad${p.index + 1} LOOP rect off the cell top`).toBeGreaterThanOrEqual(0);
      expect(r.y1 - y0, `pad${p.index + 1} LOOP rect off the cell bottom`).toBeLessThanOrEqual(CELL_H);
    }
  });

  it("the KIT button hit-rect never occludes that pad's OUT/TRIG jack hit-circles", () => {
    // The per-pad KIT factory-picker trigger sits in the cell's top-right corner, just above the
    // OUT jack's x320 column. Its drawn hit-rect MUST clear both jack hit-circles so cables stay
    // patchable (the same patch-occlusion class the LOOP test guards). Geometry: the rect bottom
    // (kitY+7 = y0+21) sits 7 units above the OUT hit-circle's top edge (y0+44-16 = y0+28).
    for (const p of PADS) {
      const rect = kitHitRect(p);
      const out: Pt = { x: p.outX, y: p.outY };
      const trig: Pt = { x: p.trigX, y: p.trigY };
      expect(
        rectIntersectsCircle(rect, out, JACK_HIT_R),
        `pad${p.index + 1} KIT hit-rect occludes the OUT jack`,
      ).toBe(false);
      expect(
        rectIntersectsCircle(rect, trig, JACK_HIT_R),
        `pad${p.index + 1} KIT hit-rect occludes the TRIG_IN jack`,
      ).toBe(false);
    }
  });

  it('the KIT button hit-rect stays within the pad cell (no neighbor bleed)', () => {
    // Same containment guard as LOOP: keep the KIT hit-rect inside the 400×140 cell so it can't
    // reach a sibling cell's controls. Recover the cell origin from the OUT jack's cell-local
    // offset (320,44), as the LOOP containment test does.
    const CELL_W = 400;
    const CELL_H = 140;
    for (const p of PADS) {
      const x0 = p.outX - 320;
      const y0 = p.outY - 44;
      const r = kitHitRect(p);
      expect(r.x0 - x0, `pad${p.index + 1} KIT rect off the cell left`).toBeGreaterThanOrEqual(0);
      expect(r.x1 - x0, `pad${p.index + 1} KIT rect off the cell right`).toBeLessThanOrEqual(CELL_W);
      expect(r.y0 - y0, `pad${p.index + 1} KIT rect off the cell top`).toBeGreaterThanOrEqual(0);
      expect(r.y1 - y0, `pad${p.index + 1} KIT rect off the cell bottom`).toBeLessThanOrEqual(CELL_H);
    }
  });

  it('places the global QUANTIZE selector inside the viewBox, clear of the title', () => {
    expect(QUANT.x).toBeGreaterThanOrEqual(0);
    expect(QUANT.x).toBeLessThanOrEqual(samplerLayout.width);
    expect(QUANT.y).toBeGreaterThanOrEqual(0);
    expect(QUANT.y).toBeLessThanOrEqual(samplerLayout.height);
    // The 6-position vertical Switch is ~94px tall (Switch.tsx slotH = 5·16 + 14)
    // with its caption above at −(slotH/2 + 8) ≈ −55. The caption top must clear the
    // y=24 panel title, and the slot bottom (+~47) must stay inside the section.
    const SLOT_HALF = (5 * 16 + 14) / 2; // 47
    const CAPTION_ABOVE = SLOT_HALF + 8; // 55
    expect(QUANT.y - CAPTION_ABOVE, 'QUANT caption overlaps the title').toBeGreaterThanOrEqual(24);
    expect(QUANT.y + SLOT_HALF, 'QUANT slot exceeds the section height').toBeLessThanOrEqual(
      samplerLayout.height,
    );
  });
});

describe('drumLayout', () => {
  /** Nominal Button footprint half-width (cap 32 + slack) used for transport containment. */
  const BTN_HALF = 33;

  it('DRUM_REGION spans the stage width and tiles directly below the pad section', () => {
    expect(DRUM_REGION.w).toBe(STAGE.w);
    expect(DRUM_REGION.x).toBe(0);
    expect(DRUM_REGION.y).toBe(STAGE.h + PAD_SECTION_H);
    expect(DRUM_REGION.h).toBe(DRUM_SECTION_H);
  });

  it('SAMPLER_TOTAL_H is the pad section plus the drum section', () => {
    expect(SAMPLER_TOTAL_H).toBe(PAD_SECTION_H + DRUM_SECTION_H);
  });

  it('the panel viewBox is the stage width × the drum-section height', () => {
    expect(drumLayout.width).toBe(STAGE.w);
    expect(drumLayout.height).toBe(DRUM_SECTION_H);
    expect(drumLayout.title).toBe('DRUM MACHINE');
  });

  it('tiles below SAMPLER_REGION with no overlap', () => {
    expect(DRUM_REGION.y).toBe(SAMPLER_REGION.y + PAD_SECTION_H);
  });

  it('places all 128 cells inside the viewBox and clear of the label gutter', () => {
    for (let t = 0; t < 8; t++) {
      for (let s = 0; s < 16; s++) {
        const r = cellRect(t, s);
        expect(r.x, `cell ${t},${s} left`).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w, `cell ${t},${s} right`).toBeLessThanOrEqual(STAGE.w);
        expect(r.y, `cell ${t},${s} top`).toBeGreaterThanOrEqual(0);
        expect(r.y + r.h, `cell ${t},${s} bottom`).toBeLessThanOrEqual(DRUM_SECTION_H);
        // every cell sits to the right of the reserved label gutter
        expect(r.x, `cell ${t},${s} into the label gutter`).toBeGreaterThanOrEqual(
          DRUM_GRID.labelGutter,
        );
      }
    }
  });

  it('keeps the cells non-overlapping (pitch >= cell on both axes)', () => {
    expect(DRUM_GRID.colPitch).toBeGreaterThanOrEqual(DRUM_GRID.cell);
    expect(DRUM_GRID.rowPitch).toBeGreaterThanOrEqual(DRUM_GRID.cell);
  });

  it('keeps the worst-case chase-highlight column band inside the viewBox', () => {
    // The panel paints a full-height bar of width colPitch centered on columnX(pos).
    for (const step of [0, 15]) {
      const left = columnX(step) - DRUM_GRID.colPitch / 2;
      const right = columnX(step) + DRUM_GRID.colPitch / 2;
      expect(left, `chase band left @${step}`).toBeGreaterThanOrEqual(0);
      expect(right, `chase band right @${step}`).toBeLessThanOrEqual(STAGE.w);
    }
  });

  it('places the transport buttons inside the viewBox and clear of the grid right edge', () => {
    const gridRight = columnX(15) + DRUM_GRID.cell / 2;
    for (const [name, x] of [
      ['runStop', DRUM_TRANSPORT.runStopX],
      ['clear', DRUM_TRANSPORT.clearX],
    ] as const) {
      expect(x - BTN_HALF, `${name} button left`).toBeGreaterThanOrEqual(0);
      expect(x + BTN_HALF, `${name} button right`).toBeLessThanOrEqual(STAGE.w);
      expect(x - BTN_HALF, `${name} button overlaps the grid`).toBeGreaterThan(gridRight);
    }
    expect(DRUM_TRANSPORT.y).toBeGreaterThanOrEqual(0);
    expect(DRUM_TRANSPORT.y).toBeLessThanOrEqual(DRUM_SECTION_H);
  });
});
