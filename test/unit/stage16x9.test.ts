/**
 * 16:9 stage geometry invariants. Two jobs:
 *
 * 1. THE DESIGN COORDINATES ARE TRUTH: the raw polyline vertices
 *    (copied verbatim below) must match the
 *    snapped REGIONS / JACK_ZONES / GROUP_OUTLINES within 1.1 px — the sketch
 *    carries sub-pixel snap jitter (e.g. 644.28 vs 644.78) that stage16x9.ts
 *    canonicalizes onto shared seams.
 *
 * 2. The snapped regions tile the stage exactly: every adjacency closes with
 *    no gap, and the stage is exactly 16:9.
 *
 * Plus unit coverage for insetRectilinear (the group-border inset math).
 */

import { describe, expect, it } from 'vitest';
import {
  designToScreen,
  GROUP_OUTLINES,
  insetRectilinear,
  JACK_FIELD_STEP_X,
  JACK_FIELD_STEP_Y,
  JACK_ZONES,
  polygonPath,
  REGIONS,
  STAGE,
  type Pt,
} from '../../src/ui/stage16x9';

/** Sketch jitter tolerance (max observed ~0.8 px; snap may add ~0.5). */
const TOL = 1.1;

type CadPt = readonly [number, number];

/** Raw design vertices, model space y-up. */
const RAW = {
  a50: [
    [3545.9367, 2115.2817],
    [5351.1241, 2115.2817],
    [5351.1241, 1099.8637],
    [3545.9367, 1099.8637],
  ],
  abf: [
    [3545.9367, 2115.2817],
    [4166.5602, 2115.2817],
    [4166.5602, 1470.7777],
    [3545.9367, 1470.7777],
  ],
  ac0: [
    [4166.5602, 2115.2817],
    [4762.5, 2115.2817],
    [4762.5, 1605.8036],
    [4166.5602, 1605.8036],
  ],
  abb: [
    [4762.5, 2115.2817],
    [5351.1241, 2115.2817],
    [5351.1241, 2012.5],
    [4762.5, 2012.5],
  ],
  abd: [
    [4166.5, 1605.3013],
    [4663.5, 1605.3013],
    [4663.5, 1471],
    [4166.5, 1471],
  ],
  ac8: [
    [4663.5, 1605.3013],
    [5351.1241, 1605.3013],
    [5351.1241, 1446.5],
    [4663.5, 1446.5],
  ],
  ab1: [
    [5351.1241, 1241],
    [3545.9367, 1241],
    [3545.9367, 1470.5],
    [4663.5, 1471],
    [4663.5, 1446.5],
    [5351.1241, 1446.5],
  ],
  acf: [
    [3545.9367, 1470.5],
    [4100.5, 1470.5],
    [4100.5, 1241],
    [3545.9367, 1241],
  ],
  ad0: [
    [4100.5, 1470.5],
    [4663.5, 1471],
    [4663.5, 1446.5],
    [4731, 1446.5],
    [4731, 1241],
    [4100.5, 1241],
  ],
  monarchJackZone: [
    [4731, 1446.5],
    [5351.1241, 1446.5],
    [5351.1241, 1241],
    [4731, 1241],
  ],
  abe: [
    [3545.9367, 1241],
    [5351.1241, 1241],
    [5351.1241, 1099.8637],
    [3545.9367, 1099.8637],
  ],
  ad5: [
    [3545.9367, 2115.2817],
    [4166.5602, 2115.2817],
    [4166.5, 1471],
    [4100.5, 1470.5],
    [4100.5, 1241],
    [3545.9367, 1241],
  ],
  ad6: [
    [4166.5602, 2115.2817],
    [4762.5, 2115.2817],
    [4762.5, 1605.8036],
    [4663.5, 1605.3013],
    [4166.5602, 1605.8036],
  ],
  ad9: [
    [4762.5, 2012.5],
    [5351.1241, 2012.5],
    [5351.1241, 1241],
    [4731, 1241],
    [4731, 1446.5],
    [4663.5, 1446.5],
    [4662.7007, 1605.3013],
    [4762.5, 1605.8036],
  ],
} as const satisfies Record<string, readonly CadPt[]>;

/** Axis-aligned bounding box of raw design vertices, in screen space. */
function rawBox(verts: readonly CadPt[]): { x: number; y: number; w: number; h: number } {
  const pts = verts.map(([X, Y]) => designToScreen(X, Y));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

function expectBoxNear(
  actual: { x: number; y: number; w: number; h: number },
  raw: { x: number; y: number; w: number; h: number },
  label: string,
): void {
  expect(Math.abs(actual.x - raw.x), `${label} x`).toBeLessThanOrEqual(TOL);
  expect(Math.abs(actual.y - raw.y), `${label} y`).toBeLessThanOrEqual(TOL);
  expect(Math.abs(actual.w - raw.w), `${label} w`).toBeLessThanOrEqual(TOL);
  expect(Math.abs(actual.h - raw.h), `${label} h`).toBeLessThanOrEqual(TOL);
}

/** Distance from a point to the nearest point on a rectilinear polygon's edges. */
function distToOutline(p: { x: number; y: number }, poly: readonly Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i]!;
    const [x2, y2] = poly[(i + 1) % poly.length]!;
    // axis-aligned segments: clamp the point onto the segment, take the distance
    const cx = Math.min(Math.max(p.x, Math.min(x1, x2)), Math.max(x1, x2));
    const cy = Math.min(Math.max(p.y, Math.min(y1, y2)), Math.max(y1, y2));
    best = Math.min(best, Math.hypot(p.x - cx, p.y - cy));
  }
  return best;
}

describe('stage16x9 — design coordinates are truth', () => {
  it('stage = the design window rectangle, exactly 16:9', () => {
    const raw = rawBox(RAW.a50);
    expect(Math.abs(STAGE.w - raw.w)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(STAGE.h - raw.h)).toBeLessThanOrEqual(TOL);
    expect(STAGE.w / STAGE.h).toBeCloseTo(16 / 9, 3);
  });

  it('rectangular regions match their design rectangles within tolerance', () => {
    expectBoxNear(REGIONS.cascadeControls, rawBox(RAW.abf), 'cascadeControls (abf)');
    expectBoxNear(REGIONS.anvilControls, rawBox(RAW.ac0), 'anvilControls (ac0)');
    expectBoxNear(REGIONS.utilityStrip, rawBox(RAW.abb), 'utilityStrip (abb)');
    expectBoxNear(REGIONS.mixerKnobs, rawBox(RAW.abd), 'mixerKnobs (abd)');
    expectBoxNear(REGIONS.seqStrip, rawBox(RAW.ac8), 'seqStrip (ac8)');
    expectBoxNear(REGIONS.jackField, rawBox(RAW.ab1), 'jackField (ab1)');
    expectBoxNear(REGIONS.futureStrip, rawBox(RAW.abe), 'futureStrip (abe)');
    expectBoxNear(JACK_ZONES.cascade, rawBox(RAW.acf), 'cascade jack zone (acf)');
    expectBoxNear(JACK_ZONES.anvil, rawBox(RAW.ad0), 'anvil jack zone (ad0)');
    expectBoxNear(JACK_ZONES.monarch, rawBox(RAW.monarchJackZone), 'monarch jack zone');
  });

  it('monarchControls matches the rectangular part of region ac7 (its L-foot IS the seq strip)', () => {
    // The controls rect is bounded by abb's bottom edge (2012.5), the stage
    // right edge, and the seq strip's top edge (1605.3013).
    const topLeft = designToScreen(4762.5, 2012.5);
    const bottomRight = designToScreen(5351.1241, 1605.3013);
    expect(Math.abs(REGIONS.monarchControls.x - topLeft.x)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(REGIONS.monarchControls.y - topLeft.y)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(REGIONS.monarchControls.x + REGIONS.monarchControls.w - bottomRight.x)).toBeLessThanOrEqual(TOL);
    expect(Math.abs(REGIONS.monarchControls.y + REGIONS.monarchControls.h - bottomRight.y)).toBeLessThanOrEqual(TOL);
  });

  it('group outlines stay within tolerance of the design border polylines', () => {
    const cases: ReadonlyArray<{ raw: readonly CadPt[]; index: number; label: string }> = [
      { raw: RAW.ad5, index: 0, label: 'Cascade (ad5)' },
      { raw: RAW.ad6, index: 1, label: 'Anvil controls (ad6)' },
      { raw: RAW.ad0, index: 2, label: 'Anvil jacks (ad7 = ad0)' },
      { raw: RAW.ad9, index: 3, label: 'Monarch (ad9)' },
    ];
    for (const { raw, index, label } of cases) {
      const outline = GROUP_OUTLINES[index]!;
      for (const [X, Y] of raw) {
        const p = designToScreen(X, Y);
        expect(
          distToOutline(p, outline.points),
          `${label}: raw vertex (${p.x.toFixed(2)},${p.y.toFixed(2)}) off the snapped outline`,
        ).toBeLessThanOrEqual(TOL);
      }
    }
  });

  it('group outlines are closed rectilinear polygons inside the stage', () => {
    for (const o of GROUP_OUTLINES) {
      expect(o.points.length).toBeGreaterThanOrEqual(4);
      for (let i = 0; i < o.points.length; i++) {
        const [x1, y1] = o.points[i]!;
        const [x2, y2] = o.points[(i + 1) % o.points.length]!;
        expect(x1 === x2 || y1 === y2, `${o.group} edge ${i} not axis-aligned`).toBe(true);
        expect(x1).toBeGreaterThanOrEqual(0);
        expect(x1).toBeLessThanOrEqual(STAGE.w);
        expect(y1).toBeGreaterThanOrEqual(0);
        expect(y1).toBeLessThanOrEqual(STAGE.h);
      }
      // and the border inset must be constructible (GroupBorders.tsx does this)
      expect(() => insetRectilinear(o.points, 3.5)).not.toThrow();
    }
  });
});

describe('stage16x9 — regions tile the stage', () => {
  const R = REGIONS;
  const close = (a: number, b: number, label: string) =>
    expect(a, label).toBeCloseTo(b, 6);

  it('every seam closes with no gap', () => {
    close(R.cascadeControls.x + R.cascadeControls.w, R.anvilControls.x, 'Cascade|Anvil');
    close(R.anvilControls.x + R.anvilControls.w, R.utilityStrip.x, 'Anvil|utility');
    close(R.utilityStrip.x, R.monarchControls.x, 'utility|Monarch left edges');
    close(R.utilityStrip.y + R.utilityStrip.h, R.monarchControls.y, 'utility|Monarch');
    close(R.anvilControls.y + R.anvilControls.h, R.mixerKnobs.y, 'Anvil|mixer');
    close(R.cascadeControls.x + R.cascadeControls.w, R.mixerKnobs.x, 'Cascade|mixer');
    close(R.mixerKnobs.x + R.mixerKnobs.w, R.seqStrip.x, 'mixer|seqStrip');
    close(R.monarchControls.y + R.monarchControls.h, R.seqStrip.y, 'Monarch|seqStrip');
    close(R.cascadeControls.y + R.cascadeControls.h, R.jackField.y, 'Cascade|jackField');
    close(R.mixerKnobs.y + R.mixerKnobs.h, R.jackField.y, 'mixer|jackField');
    close(R.seqStrip.y + R.seqStrip.h, JACK_FIELD_STEP_Y, 'seqStrip|field step');
    close(R.jackField.y + R.jackField.h, R.futureStrip.y, 'jackField|future');
    close(R.futureStrip.y + R.futureStrip.h, STAGE.h, 'future|stage bottom');
    close(R.utilityStrip.x + R.utilityStrip.w, STAGE.w, 'utility|stage right');
    close(R.seqStrip.x + R.seqStrip.w, STAGE.w, 'seqStrip|stage right');
    close(R.jackField.w, STAGE.w, 'jackField spans the stage');
    close(R.futureStrip.w, STAGE.w, 'futureStrip spans the stage');
  });

  it('jack zones partition the field width in order Cascade | Anvil | Monarch', () => {
    close(JACK_ZONES.cascade.x + JACK_ZONES.cascade.w, JACK_ZONES.anvil.x, 'cascade|anvil zones');
    close(JACK_ZONES.anvil.x + JACK_ZONES.anvil.w, JACK_ZONES.monarch.x, 'anvil|monarch zones');
    close(JACK_ZONES.monarch.x + JACK_ZONES.monarch.w, STAGE.w, 'monarch zone|stage right');
    close(JACK_ZONES.monarch.y, JACK_FIELD_STEP_Y, 'monarch zone starts at the step');
    expect(JACK_FIELD_STEP_X).toBeGreaterThan(JACK_ZONES.anvil.x);
    expect(JACK_FIELD_STEP_X).toBeLessThan(JACK_ZONES.monarch.x);
  });
});

describe('insetRectilinear', () => {
  it('insets a positive-area square toward its interior', () => {
    const square: Pt[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    expect(insetRectilinear(square, 2)).toEqual([
      [2, 2],
      [8, 2],
      [8, 8],
      [2, 8],
    ]);
  });

  it('insets a reverse-winding square identically (orientation-independent)', () => {
    const square: Pt[] = [
      [0, 0],
      [0, 10],
      [10, 10],
      [10, 0],
    ];
    expect(insetRectilinear(square, 2)).toEqual([
      [2, 2],
      [2, 8],
      [8, 8],
      [8, 2],
    ]);
  });

  it('handles a concave L-shape (the Cascade/Monarch border shapes)', () => {
    const ell: Pt[] = [
      [0, 0],
      [20, 0],
      [20, 10],
      [10, 10],
      [10, 20],
      [0, 20],
    ];
    expect(insetRectilinear(ell, 2)).toEqual([
      [2, 2],
      [18, 2],
      [18, 8],
      [8, 8],
      [8, 18],
      [2, 18],
    ]);
  });

  it('rejects non-axis-aligned and collinear-vertex polygons', () => {
    expect(() =>
      insetRectilinear(
        [
          [0, 0],
          [10, 5],
          [10, 10],
          [0, 10],
        ],
        2,
      ),
    ).toThrow(/not axis-aligned/);
    expect(() =>
      insetRectilinear(
        [
          [0, 0],
          [5, 0],
          [10, 0],
          [10, 10],
          [0, 10],
        ],
        2,
      ),
    ).toThrow(/parallel edges/);
  });

  it('polygonPath emits a closed SVG path', () => {
    expect(
      polygonPath([
        [0, 0],
        [10, 0],
        [10, 10],
      ]),
    ).toBe('M 0.00 0.00 L 10.00 0.00 L 10.00 10.00 Z');
  });
});
