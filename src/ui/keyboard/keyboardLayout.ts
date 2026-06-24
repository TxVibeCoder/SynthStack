/**
 * Layout geometry for the on-screen piano keyboard (g4-ui-keyboard). The keybed
 * occupies the right of the reserved futureStrip band; a small control cluster
 * (OCTAVE shift, ENABLE MIDI + status, PC KEYS latch) sits to its left.
 *
 * The white/black PATTERN is NOT authored here — it is imported from the engine's
 * pure `KEYBED_SHAPE` (src/engine/voice/keyMap.ts) so the panel and the geometry
 * test consume the SAME source the bridge maps notes from (one mapping, tested
 * once). This module only turns that 25-entry shape into x/y rects inside the
 * futureStrip viewBox, in the spirit of samplerLayout.ts (indexed, viewBox-pure).
 *
 * Coordinates are SVG viewBox units inside REGIONS.futureStrip (1805.19 × 141.14),
 * which maps 1:1 to stage px since the 16:9 redesign (src/ui/stage16x9.ts).
 */

import { KEYBED_SHAPE, type KeyShape } from '../../engine/voice/keyMap';
import { REGIONS } from '../stage16x9';

/** Panel viewBox = the reserved futureStrip band. */
export const KB_W = REGIONS.futureStrip.w; // 1805.19
export const KB_H = REGIONS.futureStrip.h; // 141.14

/** Left control cluster occupies x 0..CLUSTER_W; the keybed takes the rest. */
export const CLUSTER_W = 300;
/** Right inset matching the old FutureStrip text margin (App.tsx used 16). */
export const KEYBED_RIGHT_INSET = 16;
/** Gap between the control cluster and the first white key. */
export const KEYBED_LEFT_GAP = 12;

/** Keybed bounding box. */
export const KEYBED_X0 = CLUSTER_W + KEYBED_LEFT_GAP;
export const KEYBED_X1 = KB_W - KEYBED_RIGHT_INSET;
export const KEYBED_Y0 = 14;
export const KEYBED_Y1 = 132;
export const KEYBED_W = KEYBED_X1 - KEYBED_X0;
export const KEYBED_H = KEYBED_Y1 - KEYBED_Y0;

/** Number of white keys in the 25-key (2-octave + top C) bed. */
export const WHITE_COUNT = KEYBED_SHAPE.filter((k) => !k.isBlack).length; // 15
/** Each white key is an equal slice of the keybed width. */
export const WHITE_W = KEYBED_W / WHITE_COUNT;

/** Black keys are narrower and shorter, painted on top of the white boundaries. */
export const BLACK_W = WHITE_W * 0.62;
export const BLACK_H = KEYBED_H * 0.62;

/** One placed key: its semitone (0..24 from low C), colour and rect. */
export interface KeyRect extends KeyShape {
  /** Index into KEYBED_SHAPE (0..24); the panel testids are key-{i}. */
  i: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** White-key ordinal (0..14) for whites; for blacks, the white to their left. */
  whiteIndex: number;
}

/**
 * Build the 25 key rects from KEYBED_SHAPE. Whites tile the bed left-to-right;
 * each black is centred on the boundary between its preceding white and the next
 * white (the standard piano offset), so blacks land only where the shape marks
 * them (after C/D/F/G/A — never after E/B). Painted whites-first, blacks-second.
 */
function buildKeys(): KeyRect[] {
  const out: KeyRect[] = [];
  let whiteSeen = 0;
  for (let i = 0; i < KEYBED_SHAPE.length; i++) {
    const shape = KEYBED_SHAPE[i]!;
    if (!shape.isBlack) {
      const x = KEYBED_X0 + whiteSeen * WHITE_W;
      out.push({
        ...shape,
        i,
        x,
        y: KEYBED_Y0,
        w: WHITE_W,
        h: KEYBED_H,
        whiteIndex: whiteSeen,
      });
      whiteSeen += 1;
    } else {
      // Centre the black on the boundary between the previous white (whiteSeen-1)
      // and the next white (whiteSeen): boundary x = X0 + whiteSeen*WHITE_W.
      const boundaryX = KEYBED_X0 + whiteSeen * WHITE_W;
      out.push({
        ...shape,
        i,
        x: boundaryX - BLACK_W / 2,
        y: KEYBED_Y0,
        w: BLACK_W,
        h: BLACK_H,
        whiteIndex: whiteSeen - 1,
      });
    }
  }
  return out;
}

/** The 25 placed keys (whites first in array order is NOT guaranteed — render
 *  order is handled by the panel, which paints whites before blacks). */
export const KEYS: readonly KeyRect[] = buildKeys();

/** Whites and blacks split out for two-pass painting (whites under blacks). */
export const WHITE_KEYS: readonly KeyRect[] = KEYS.filter((k) => !k.isBlack);
export const BLACK_KEYS: readonly KeyRect[] = KEYS.filter((k) => k.isBlack);

/**
 * Which key (by semitone index 0..24) sits under a keybed-local point. Whites are
 * hit only in the strip BELOW the black keys (so the overlapping black wins on top);
 * blacks are hit over their full rect. Returns the semitone index or null when the
 * point is outside the bed. Used by the panel's pointer geometry for glissando.
 */
export function keyAtPoint(x: number, y: number): number | null {
  if (x < KEYBED_X0 || x > KEYBED_X1 || y < KEYBED_Y0 || y > KEYBED_Y1) return null;
  // Black keys are on top — test them first.
  for (const k of BLACK_KEYS) {
    if (x >= k.x && x <= k.x + k.w && y >= k.y && y <= k.y + k.h) return k.semitone;
  }
  // Otherwise the white slice under the x.
  for (const k of WHITE_KEYS) {
    if (x >= k.x && x <= k.x + k.w) return k.semitone;
  }
  return null;
}

// ---- left control cluster anchors ------------------------------------------------------

/** Vertical centre line of the cluster controls. */
const CLUSTER_MID_Y = 30;
const CLUSTER_LOW_Y = 96;

/** OCTAVE shift: two momentary buttons flanking a live low-C readout. */
export const OCT_DOWN = { x: 34, y: CLUSTER_MID_Y };
export const OCT_READOUT = { x: 96, y: CLUSTER_MID_Y };
export const OCT_UP = { x: 158, y: CLUSTER_MID_Y };

/** ENABLE MIDI button + its status LED/caption. */
export const ENABLE_MIDI = { x: 60, y: CLUSTER_LOW_Y };
export const MIDI_STATUS_LED = { x: 120, y: CLUSTER_LOW_Y - 4 };
export const MIDI_STATUS_TEXT = { x: 134, y: CLUSTER_LOW_Y - 1 };

/** CLOCK MASTER indicator (external MIDI clock driving the studio) — sits beside the MIDI LED. */
export const CLOCK_MASTER_LED = { x: 120, y: CLUSTER_LOW_Y + 14 };
export const CLOCK_MASTER_TEXT = { x: 134, y: CLUSTER_LOW_Y + 17 };

/** PC KEYS latch (computer-key row mapping). */
export const PC_KEYS = { x: 240, y: CLUSTER_MID_Y };

/**
 * CHANNEL selector (MIDI input channel filter, G1): OMNI / 1..16, a prev/readout/next stepper
 * mirroring the OCTAVE cluster, sitting in the lower row beside ENABLE MIDI. The readout shows
 * "OMNI" or the 1-based channel number. x's locate CH-, the readout, and CH+.
 */
export const CH_DOWN = { x: 196, y: CLUSTER_LOW_Y };
export const CH_READOUT = { x: 230, y: CLUSTER_LOW_Y };
export const CH_UP = { x: 264, y: CLUSTER_LOW_Y };

/** KB GLIDE knob (separate keyboard/MIDI live-play glide, G1) — a small rotary between OCT+ and
 *  PC KEYS in the upper row (paints to r+16 below for its label; clears both neighbors' caps). */
export const KB_GLIDE = { x: 199, y: CLUSTER_MID_Y + 2 };
