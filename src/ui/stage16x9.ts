/**
 * 16:9 stage geometry — the design region plan as code. This module holds the
 * SNAPPED screen-space rectangles/outlines the app builds from; the raw design
 * vertices are pinned against these in test/unit/stage16x9.test.ts (±1.1 px —
 * the source sketch carries sub-pixel snap jitter, e.g. 644.28 vs 644.78, that we
 * canonicalize to shared seams).
 *
 * Coordinate frame: screen px, y-down, origin = stage top-left.
 * Model → screen: sx = X − MODEL_ORIGIN.x, sy = MODEL_ORIGIN.y − Y (model is y-up).
 * The stage is 1805.19 × 1015.42 — exactly 16:9, a 1080p viewport.
 * App.tsx scales the whole stage uniformly to fit the window.
 */

/** Model-space origin of the window rectangle. */
export const DESIGN_ORIGIN = { x: 3545.9367, y: 2115.2817 } as const;

/** Convert one model-space vertex (y-up) to stage screen space (y-down). */
export function designToScreen(X: number, Y: number): { x: number; y: number } {
  return { x: X - DESIGN_ORIGIN.x, y: DESIGN_ORIGIN.y - Y };
}

/** Full stage = the window rectangle. */
export const STAGE = { w: 1805.19, h: 1015.42 } as const;

export interface RegionBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Canonical seam coordinates (snapped from the source layout):
 * x: 0 · 554.56 · 620.6 · 1117.56 · 1185.06 · 1216.56 · 1805.19
 * y: 0 · 102.78 · 509.98 · 644.78 · 668.78 · 874.28 · 1015.42
 * Every region edge below lies on one of these, so the regions tile the stage
 * with no gaps (adjacency is asserted in test/unit/stage16x9.test.ts).
 */
export const REGIONS = {
  /** Cascade, controls only. */
  cascadeControls: { x: 0, y: 0, w: 620.6, h: 644.78 },
  /** Anvil, controls only. */
  anvilControls: { x: 620.6, y: 0, w: 595.96, h: 509.98 },
  /** Utility strip: POWER + transports + feature buttons. */
  utilityStrip: { x: 1216.56, y: 0, w: 588.63, h: 102.78 },
  /** Monarch, controls only (above the seq strip). */
  monarchControls: { x: 1216.56, y: 102.78, w: 588.63, h: 407.2 },
  /** Mixer channel + master knobs (split from its buttons). */
  mixerKnobs: { x: 620.6, y: 509.98, w: 496.96, h: 134.8 },
  /** Monarch 32-step editor strip, shifted left of the Monarch column. */
  seqStrip: { x: 1117.56, y: 509.98, w: 687.63, h: 158.8 },
  /**
   * Consolidated patchbay: ALL 88 jacks. Full width; the top edge
   * steps DOWN 24 px right of x=1117.56 (the seq strip reaches y=668.78 there).
   */
  jackField: { x: 0, y: 644.78, w: 1805.19, h: 229.5 },
  /** Reserved: future virtual keyboard / sequencer. */
  futureStrip: { x: 0, y: 874.28, w: 1805.19, h: 141.14 },
} as const satisfies Record<string, RegionBox>;

/** x where the jack field's top edge steps from y=644.78 down to y=668.78. */
export const JACK_FIELD_STEP_X = 1117.56;
/** Top edge of the jack field right of the step (under the seq strip). */
export const JACK_FIELD_STEP_Y = 668.78;

/** Per-machine jack zones inside the field (Cascade / Anvil / Monarch). */
export const JACK_ZONES = {
  /** 32 jacks (17 in + 15 out). */
  cascade: { x: 0, y: 644.78, w: 554.56, h: 229.5 },
  /**
   * 24 jacks (15 in + 9 out). Includes the sliver x 1117.56→1185.06 that only
   * starts at y=668.78 (below the seq strip); jacks stay left of the step.
   */
  anvil: { x: 554.56, y: 644.78, w: 630.5, h: 229.5 },
  /** 32 jacks (18 in + 14 out); starts 24 px lower (under the seq strip). */
  monarch: { x: 1185.06, y: 668.78, w: 620.13, h: 205.5 },
} as const satisfies Record<string, RegionBox>;

export type Pt = readonly [number, number];

/**
 * Group-border outlines (one per machine + the mixer pair), snapped, in
 * stage space, rectilinear and closed. Each machine's border unions its
 * controls with its jack zone ("these jacks go with these controls"); Anvil and
 * the mixer are split into two outlines because other regions sit between
 * their halves. Rendered by GroupBorders.tsx inset via insetRectilinear() so
 * adjacent group strokes never overpaint on a shared seam.
 */
export const GROUP_OUTLINES: ReadonlyArray<{
  group: 'cascade' | 'anvil' | 'monarch' | 'mixer';
  points: readonly Pt[];
}> = [
  {
    // controls necking into the jack zone, one continuous outline
    group: 'cascade',
    points: [
      [0, 0],
      [620.6, 0],
      [620.6, 644.78],
      [554.56, 644.78],
      [554.56, 874.28],
      [0, 874.28],
    ],
  },
  {
    // control block (jack zone is separate: the mixer knobs sit between)
    group: 'anvil',
    points: [
      [620.6, 0],
      [1216.56, 0],
      [1216.56, 509.98],
      [620.6, 509.98],
    ],
  },
  {
    // jack zone, with the 24 px step at x=1117.56 and the right sliver
    group: 'anvil',
    points: [
      [554.56, 644.78],
      [1117.56, 644.78],
      [1117.56, 668.78],
      [1185.06, 668.78],
      [1185.06, 874.28],
      [554.56, 874.28],
    ],
  },
  {
    // BLUE — controls → seq strip → jack zone
    group: 'monarch',
    points: [
      [1216.56, 102.78],
      [1805.19, 102.78],
      [1805.19, 874.28],
      [1185.06, 874.28],
      [1185.06, 668.78],
      [1117.56, 668.78],
      [1117.56, 509.98],
      [1216.56, 509.98],
    ],
  },
  {
    // mixer knob block — same treatment as Anvil's split: two outlines
    group: 'mixer',
    points: [
      [620.6, 509.98],
      [1117.56, 509.98],
      [1117.56, 644.78],
      [620.6, 644.78],
    ],
  },
  {
    // mixer buttons + POWER strip
    group: 'mixer',
    points: [
      [1216.56, 0],
      [1805.19, 0],
      [1805.19, 102.78],
      [1216.56, 102.78],
    ],
  },
];

/** Signed area (shoelace); > 0 = counter-clockwise in y-down screen space. */
function signedArea(points: readonly Pt[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i]!;
    const [x2, y2] = points[(i + 1) % points.length]!;
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/**
 * Inset a closed RECTILINEAR polygon by `d` toward its interior. Adjacent group
 * borders share seam lines (e.g. Cascade right edge = Anvil left edge at x=620.6);
 * drawing both centered on the seam would overpaint, so each outline pulls in
 * by half the stroke + a hair before stroking.
 *
 * Every edge must be axis-aligned (the GROUP_OUTLINES are, after snapping).
 * Each edge offsets toward the interior side; new vertices are the
 * re-intersections of consecutive offset edges (trivial for axis-aligned
 * edges: x comes from the vertical edge, y from the horizontal one).
 */
export function insetRectilinear(points: readonly Pt[], d: number): Pt[] {
  const n = points.length;
  // In y-down screen space a CLOCKWISE polygon has negative shoelace area and
  // its interior lies to the LEFT of travel… orientation conventions invert
  // with the y-flip, so derive the interior side from the sign directly.
  const ccw = signedArea(points) > 0;

  interface Edge {
    vertical: boolean;
    /** Offset line position: x for vertical edges, y for horizontal. */
    pos: number;
  }

  const edges: Edge[] = [];
  for (let i = 0; i < n; i++) {
    const [x1, y1] = points[i]!;
    const [x2, y2] = points[(i + 1) % n]!;
    if (x1 === x2 && y1 === y2) throw new Error(`degenerate edge at vertex ${i}`);
    if (x1 !== x2 && y1 !== y2) {
      throw new Error(`edge ${i} is not axis-aligned: (${x1},${y1})→(${x2},${y2})`);
    }
    // Positive shoelace area in y-down coords ⇒ interior lies to the RIGHT of
    // travel ("right" = travel direction rotated 90° screen-clockwise).
    const interiorRight = ccw;
    if (x1 === x2) {
      const down = y2 > y1; // right of downward travel is −x
      const sign = (down ? 1 : -1) * (interiorRight ? -1 : 1);
      edges.push({ vertical: true, pos: x1 + sign * d });
    } else {
      const right = x2 > x1; // right of rightward travel is +y
      const sign = (right ? -1 : 1) * (interiorRight ? -1 : 1);
      edges.push({ vertical: false, pos: y1 + sign * d });
    }
  }

  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const prev = edges[(i - 1 + n) % n]!;
    const cur = edges[i]!;
    if (prev.vertical === cur.vertical) {
      throw new Error(`consecutive parallel edges at vertex ${i} (collinear point?)`);
    }
    const x = prev.vertical ? prev.pos : cur.pos;
    const y = prev.vertical ? cur.pos : prev.pos;
    out.push([x, y]);
  }
  return out;
}

/** SVG path ("M … Z") for a closed polygon. */
export function polygonPath(points: readonly Pt[]): string {
  return (
    points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`).join(' ') +
    ' Z'
  );
}
