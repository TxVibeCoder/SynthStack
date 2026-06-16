/**
 * UI theme constants — the single source of truth for colors, fonts, and sizing.
 * `src/ui/styles.css` mirrors these values as :root custom properties; change both
 * together or neither (design-agent owned; see CONVENTIONS.md ownership map).
 *
 * Styling policy: dark panels, cream legends, gold-ish knobs —
 * original styling in the spirit of the hardware. NO third-party logos, wordmarks, or
 * trade-dress copies. Plain-text functional titles in our own typography only.
 */

/** Cable palette + cable budget come from the engine — re-exported, not duplicated. */
export { CABLE_COLORS, CABLE_COUNT } from '../engine/studio';

export const COLORS = {
  /** Page background (darker than panels so the rack reads as raised). */
  bg: '#101012',
  /** Panel face. */
  panel: '#1b1b1d',
  /** Raised panel areas (sequencer wells, mixer strip). */
  panelRaised: '#232326',
  /** Section outlines, panel border strokes. */
  panelEdge: '#2e2e33',
  /** Drop shadows / jack holes / recesses. */
  panelShadow: '#0a0a0b',
  /** Primary legend (labels, titles, section names). */
  legend: '#e8e0cf',
  /** Secondary legend (units, min/max ticks, hints). */
  legendDim: '#a89f8c',
  /** Knob body (gold-ish family). */
  knob: '#c89b3c',
  /** Knob top highlight. */
  knobHi: '#e0b95f',
  /** Knob skirt / shaded side. */
  knobLo: '#8a6a24',
  /** Knob pointer line (dark on gold). */
  knobPointer: '#141210',
  ledRed: '#e23b2e',
  ledAmber: '#f0a030',
  ledGreen: '#43b05c',
  /** Unlit LED lens. */
  ledOff: '#473530',
  /** Jack ferrule / hex nut metal. */
  jackRing: '#9aa0a6',
  /** Jack ring shading. */
  jackRingDark: '#5f6469',
  /** Jack bore. */
  jackHole: '#0a0a0b',
  /** focus-visible outline + drag value readout accent. */
  focus: '#f0a030',
} as const;

/** Body / readout text. System sans only — no webfont dependencies. */
export const FONT_STACK =
  "'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif";
/** Panel legends: condensed where the platform has it, graceful fallback otherwise. */
export const FONT_CONDENSED =
  "'Arial Narrow', 'Roboto Condensed', 'Helvetica Neue', 'Segoe UI', Arial, sans-serif";

/**
 * Group-border colors (16:9 layout): a thick outline
 * unifies each machine's controls with its jack-field zone. Blue=Monarch by design;
 * Yellow=Cascade / Green=Anvil follow the layout listing order; the mixer's violet
 * is the pick for the 4th color.
 */
export const GROUP_BORDER = {
  cascade: '#e0c341', // yellow
  anvil: '#4caf5f', // green
  monarch: '#4f8fd9', // blue
  mixer: '#9d6fd6', // violet (4th color)
} as const;

/** Group-border stroke width (intentionally "thick"). */
export const GROUP_BORDER_WIDTH = 4.5;
/** Borders inset this far from the region seams so adjacent strokes never touch. */
export const GROUP_BORDER_INSET = 3.5;

/** Knob radii in panel viewBox units (s = trimmer-size, m = standard, l = hero FREQ/CUTOFF). */
export const KNOB_RADIUS = { s: 13, m: 17, l: 22 } as const;

/**
 * Jack radii in panel viewBox units. `ring` = visible metal, `hole` = bore,
 * `hit` = invisible pointer target (must carry data-jack-id — see types.ts JackProps).
 */
export const JACK_RADIUS = { ring: 11, hole: 4.5, hit: 16 } as const;

/** Knob rotation sweep: 270°, -135° (min value) to +135° (max value), 0° = straight up. */
export const KNOB_SWEEP_DEG = { start: -135, end: 135 } as const;
/** Vertical relative drag: this many px of pointer travel = one full min→max sweep. */
export const DRAG_FULL_SWEEP_PX = 150;
/** Sensitivity multiplier while Shift is held (fine adjust). */
export const FINE_DRAG_FACTOR = 0.1;

/** LED lens radius in panel viewBox units (step LEDs, button lamps). */
export const LED_RADIUS = 5;
