/**
 * SAMPLER panel layout (feature-sampler-pads) — the 8-pad section that lives
 * BELOW the fixed 16:9 stage, rendered inside the SAME uniformly-scaled stage
 * container so the existing CableLayer reaches its jacks for free.
 *
 * Geometry is its OWN constant family (NOT added to stage16x9.REGIONS, which is
 * pinned to the design coordinates — a 9th region there would break
 * stage16x9.test.ts). SAMPLER_REGION + PAD_SECTION_H are imported by App.tsx
 * (g5) to size the scroll sizer and place the <Region>; PADS drives SamplerPanel.
 *
 * Coordinate frame: panel-LOCAL stage units, origin = the SAMPLER_REGION's
 * top-left, viewBox = STAGE.w × PAD_SECTION_H (1:1 stage px, like every panel
 * since the 16:9 redesign). Coordinates locate element CENTERS (types.ts Pt
 * convention) except faceX/faceY which is the pad face rect's CENTER and
 * faceW/faceH its size.
 *
 * Arrangement: 4 columns × 2 rows of pads across STAGE.w. Each cell carries a
 * pad face (click-to-audition / drop target), a LEVEL + TUNE knob pair, an OUT
 * + TRIG jack pair, a sample-name label, and a LOAD button. Spacing invariants
 * (knob pitch ≥ 40, jack pitch ≥ the jack-field minimum, viewBox containment)
 * are enforced by test/unit/samplerLayout.test.ts.
 */

// .ts extensions on imports to match anvilLayout.ts (scripts/export-geometry.ts
// loads layouts straight in Node, whose ESM resolver wants explicit extensions).
import type { PanelLayout } from '../types.ts';
import { STAGE } from '../stage16x9.ts';
// Shared sampler control/jack defs (single source — SamplerPanel + SamplerJacks both
// import padDefs/quantizeDef from here). schema is .ts type-only and sampler.json is a
// static, side-effect-free JSON import, so export-geometry.ts (which loads this module
// in Node for geometry) still resolves them with NO extension changes.
import type { ControlDef, JackDef, ModuleDef } from '../../../data/schema';
import samplerJson from '../../../data/sampler.json';

/** Height (stage units) of the scrollable pad section below the 16:9 fold. */
export const PAD_SECTION_H = 320;

/**
 * The pad section's region in STAGE space: full width, directly under the
 * 1805.19 × 1015.42 console. g5 mounts <Region box={SAMPLER_REGION}> here.
 */
export const SAMPLER_REGION = { x: 0, y: STAGE.h, w: STAGE.w, h: PAD_SECTION_H } as const;

/** Per-pad cell geometry, panel-local. All values are element CENTERS but face* (rect). */
export interface PadCell {
  index: number;
  faceX: number;
  faceY: number;
  faceW: number;
  faceH: number;
  levelX: number;
  levelY: number;
  tuneX: number;
  tuneY: number;
  outX: number;
  outY: number;
  trigX: number;
  trigY: number;
  nameX: number;
  nameY: number;
  loadX: number;
  loadY: number;
  loopX: number;
  loopY: number;
  kitX: number;
  kitY: number;
}

/** 4 columns × 2 rows. Cell = 400 × 140; column pitch 440, row pitch 140. */
const COLS = 4;
const ROWS = 2;
const CELL_W = 400;
const COL_PITCH = 440;
const ROW_PITCH = 140;
/** Left margin: centers the 4-column band (3·440 + 400 = 1720 wide) under STAGE.w. */
const MARGIN_X = (STAGE.w - ((COLS - 1) * COL_PITCH + CELL_W)) / 2;
/** Top of the first cell row — clears the panel title band. */
const TOP_Y = 36;

/** Cell-local offsets (from the cell's top-left). Tuned so labels never collide. */
const FACE = { cx: 62, cy: 56, w: 100, h: 96 } as const;
const LEVEL = { x: 165, y: 50 } as const;
const TUNE = { x: 235, y: 50 } as const; // 70-unit horizontal pitch from LEVEL
const OUT = { x: 320, y: 44 } as const;
const TRIG = { x: 320, y: 96 } as const; // 52-unit vertical pitch from OUT
const NAME = { x: 62, y: 112 } as const; // centered under the pad face
const LOAD = { x: 200, y: 118 } as const;
// LOOP switch — moved OFF the x320 OUT/TRIG column. Its full-footprint Switch hit-rect,
// [loopX-34..loopX+50] × [loopY-33..loopY+15], previously occluded the TRIG jack's hit
// circle and ate cable patches / clicks on it (the regression this fix targets). At
// {122,125} the hit-rect spans x[88,172] y[92,140]: it clears BOTH jack hit-circles
// (x[304,336]) by >130 units, clears the LOAD button (x[172,228]) and both LEVEL/TUNE
// knobs+labels, and stays inside the 400×140 cell, riding the open space under the pad
// face / left of LOAD. The 84-wide rect cannot fully miss EVERY element in this dense
// cell, so it grazes the pad-face button's bottom-right corner (~24×12 of a 100×96 face)
// — a benign overlap (audition still fires from the rest of the face), unlike the patch-
// blocking jack occlusion. samplerLayout.test.ts pins the jack non-overlap so the LOOP
// rect can never regress back onto the OUT/TRIG patch column.
const LOOP = { x: 122, y: 125 } as const;
// KIT factory-picker trigger — a small ~34×14 SVG button in the cell's top-right corner.
// UNLIKE the LOOP Switch (whose full-footprint transparent hit-rect occluded a jack, see the
// note above), the KIT button is mirrored on the LOAD <g>: its hit area IS the drawn rect, with
// NO oversized transparent rect. The drawn rect spans cell-local x[303,337] y[7,21]. The OUT jack
// is cell-local (320,44) with JACK_HIT_R=16 — its hit-circle top edge is y=28; the rect bottom is
// y=21, a 7-unit gap, so the rect does NOT touch the OUT hit-circle and the jack stays patchable.
// TRIG (320,96) and the TUNE knob (235,50) are far clear. The rect stays inside the 400×140 cell
// (x to 337<400, y from 7). The rect MUST stay drawn strictly above y=23 so the OUT hit-circle's
// top edge (y=28) remains patchable — pinned by samplerLayout.test.ts's kitHitRect invariant.
const KIT = { x: 320, y: 14 } as const;

/**
 * The single global QUANTIZE selector, placed in the panel header top-right. The
 * 6-position vertical Switch is ~94px tall (Switch.tsx slotH = 5·16 + 14 = 94) with
 * its caption above at y −(slotH/2 + 8); a center y of 96 keeps that top caption
 * (≈96 − 55 = 41) below the y=24 title and clears the TOP_Y=36 first pad row.
 */
export const QUANT = { x: STAGE.w - 70, y: 96 } as const;

function buildPad(index: number): PadCell {
  const col = index % COLS;
  const row = Math.floor(index / COLS);
  const x0 = MARGIN_X + col * COL_PITCH;
  const y0 = TOP_Y + row * ROW_PITCH;
  return {
    index,
    faceX: x0 + FACE.cx,
    faceY: y0 + FACE.cy,
    faceW: FACE.w,
    faceH: FACE.h,
    levelX: x0 + LEVEL.x,
    levelY: y0 + LEVEL.y,
    tuneX: x0 + TUNE.x,
    tuneY: y0 + TUNE.y,
    outX: x0 + OUT.x,
    outY: y0 + OUT.y,
    trigX: x0 + TRIG.x,
    trigY: y0 + TRIG.y,
    nameX: x0 + NAME.x,
    nameY: y0 + NAME.y,
    loadX: x0 + LOAD.x,
    loadY: y0 + LOAD.y,
    loopX: x0 + LOOP.x,
    loopY: y0 + LOOP.y,
    kitX: x0 + KIT.x,
    kitY: y0 + KIT.y,
  };
}

/** The 8 pad cells, index 0..7 (row-major: 0..3 top row, 4..7 bottom row). */
export const PADS: PadCell[] = Array.from({ length: COLS * ROWS }, (_, i) => buildPad(i));

/**
 * PanelLayout-shaped header for parity with anvilLayout (width/height/title). The
 * pad controls are INDEXED (PADS), not keyed by control id, so sections/controls/
 * jacks stay empty — SamplerPanel reads PADS, not these maps.
 */
export const samplerLayout: PanelLayout = {
  width: STAGE.w,
  height: PAD_SECTION_H,
  title: 'SAMPLER',
  sections: [],
  controls: {},
  jacks: {},
};

// =========================================================================================
// Shared sampler control / jack defs (from data/sampler.json, by id).
//
// SINGLE SOURCE: moved out of SamplerPanel (was module-private) so SamplerPanel (the sampler
// tab's controls) AND SamplerJacks (the patchbay tab's 16 OUT/TRIG jacks) read identical defs.
// Both import padDefs/quantizeDef from here. Throws at module load if sampler.json drifts.
// =========================================================================================

const samplerDef = samplerJson as unknown as ModuleDef;
const controlById = new Map<string, ControlDef>(samplerDef.controls.map((c) => [c.id, c]));
const jackById = new Map<string, JackDef>(samplerDef.jacks.map((j) => [j.id, j]));

/** Defs for pad n (1-based id suffix). Throws at module load if the JSON drifts. */
export function padDefs(padIndex: number): {
  level: ControlDef;
  tune: ControlDef;
  loop: ControlDef;
  out: JackDef;
  trig: JackDef;
} {
  const n = padIndex + 1;
  const level = controlById.get(`SAMP_PAD${n}_LEVEL`);
  const tune = controlById.get(`SAMP_PAD${n}_TUNE`);
  const loop = controlById.get(`SAMP_PAD${n}_LOOP`);
  const out = jackById.get(`SAMP_PAD${n}_OUT`);
  const trig = jackById.get(`SAMP_PAD${n}_TRIG_IN`);
  if (!level || !tune || !loop || !out || !trig) {
    throw new Error(`sampler.json missing defs for pad ${n}`);
  }
  return { level, tune, loop, out, trig };
}

/** The single global QUANTIZE selector def. Throws at module load if the JSON drifts. */
export const quantizeDef = (() => {
  const def = controlById.get('SAMP_QUANTIZE');
  if (!def) throw new Error('sampler.json missing SAMP_QUANTIZE def');
  return def;
})();

// =========================================================================================
// DRUM MACHINE section (feature drum-machine) — an 8-track × 16-step TR-808-style toggle
// grid that triggers the 8 sample pads (track t = pad t), stepped one column per master
// 16th by the SamplerStepSeq scheduler citizen. It lives in the SAME scroll-down section
// as the pads, tiled DIRECTLY BELOW SAMPLER_REGION (no overlap), rendered inside the same
// uniformly-scaled stage container. Like the pad section these are sampler-owned constants
// (NOT a stage16x9.REGIONS entry — that map is pinned to the design coordinates).
//
// DrumMachinePanel reads the helpers (columnX / rowY / cellRect) — never these maps — and
// the geometry is enforced by test/unit/samplerLayout.test.ts (128 cells inside the
// viewBox, clear of the label gutter, non-overlapping, transport buttons clear of the
// grid). g5's App.tsx imports DRUM_REGION + SAMPLER_TOTAL_H to size the scroll sizer and
// place the <Region>.
// =========================================================================================

/** Height (stage units) of the drum-machine section, directly below the pad section. Grown
 *  from 300 so the 8×16 grid fills the sampler tab's vertical band with bigger, easier-to-hit
 *  step cells instead of leaving a wide letterbox below the fold. */
export const DRUM_SECTION_H = 600;

/** Total scrollable sampler height below the 16:9 fold = pads + drum grid (320 + 300). */
export const SAMPLER_TOTAL_H = PAD_SECTION_H + DRUM_SECTION_H;

/**
 * The drum section's region in STAGE space: full width, directly under the pad section
 * (y = STAGE.h + PAD_SECTION_H). It tiles below SAMPLER_REGION with no overlap. g5 mounts
 * <Region box={DRUM_REGION}> here.
 */
export const DRUM_REGION = { x: 0, y: STAGE.h + PAD_SECTION_H, w: STAGE.w, h: DRUM_SECTION_H } as const;

/**
 * 8×16 grid geometry, panel-local (viewBox 0 0 STAGE.w DRUM_SECTION_H). x0/y0 locate the
 * CENTER of cell (track 0, step 0); colPitch/rowPitch are the center-to-center spacing;
 * cell is the square toggle's side. labelGutter reserves the left strip for pad-name row
 * labels (every cell center sits to its right). Containment + non-overlap (colPitch ≥ cell,
 * rowPitch ≥ cell) are pinned in samplerLayout.test.ts.
 *
 * The grid spans most of the stage width (transport fills the strip to its right). Rightmost
 * column center = x0 + 15·colPitch = 210 + 1260 = 1470 (+cell/2 = 1498 < STAGE.w). Bottom row
 * center = y0 + 7·rowPitch = 100 + 448 = 548 (+cell/2 = 576 < DRUM_SECTION_H 600).
 */
export const DRUM_GRID = {
  x0: 210,
  y0: 100,
  colPitch: 84,
  rowPitch: 64,
  cell: 56,
  labelGutter: 175,
} as const;

/** Y of the top beat-number / column-LED strip, under the y=24 title and above the grid. */
export const DRUM_BEATROW_Y = 60;

/**
 * Transport buttons, in the strip to the right of the grid (which now ends ~1498).
 * Both x (plus a button footprint) stay < STAGE.w — pinned in the layout test.
 */
export const DRUM_TRANSPORT = { runStopX: 1580, clearX: 1700, y: 260 } as const;

/** CENTER x of column `step` (0..15). */
export function columnX(step: number): number {
  return DRUM_GRID.x0 + step * DRUM_GRID.colPitch;
}

/** CENTER y of row `track` (0..7). */
export function rowY(track: number): number {
  return DRUM_GRID.y0 + track * DRUM_GRID.rowPitch;
}

/** The cell-(track,step) toggle rect (top-left + size), centered on (columnX, rowY). */
export function cellRect(track: number, step: number): { x: number; y: number; w: number; h: number } {
  return {
    x: columnX(step) - DRUM_GRID.cell / 2,
    y: rowY(track) - DRUM_GRID.cell / 2,
    w: DRUM_GRID.cell,
    h: DRUM_GRID.cell,
  };
}

/**
 * PanelLayout-shaped header for parity with samplerLayout/anvilLayout. The grid is computed
 * from the helpers (cellRect/columnX/rowY), not keyed maps, so sections/controls/jacks stay
 * empty — DrumMachinePanel reads the helpers, not these maps.
 */
export const drumLayout: PanelLayout = {
  width: STAGE.w,
  height: DRUM_SECTION_H,
  title: 'DRUM MACHINE',
  sections: [],
  controls: {},
  jacks: {},
};
