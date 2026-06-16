/**
 * Pure drag/taper math for the SVG controls — no React, no DOM, no engine imports
 * (unit-tested in Node; see test/unit/dragMath.test.ts).
 *
 * "norm" is the 0..1 knob position. Tapers ('lin' | 'exp' | 'stepped') shape how a
 * norm maps onto the ControlDef's [min, max] value space:
 *   - lin: straight interpolation.
 *   - exp: equal norm steps = equal value ratios (log mapping). Requires min > 0;
 *     below EXP_MIN_FLOOR the log math degenerates, so we fall back to lin.
 *   - stepped: lin mapping snapped to `steps` evenly spaced detents (integer values
 *     for the 1..16-style step knobs).
 *
 * Detents come ONLY from `taper: 'stepped'` or an explicit `steps` count.
 * `type: 'stepKnob'` marks a sequencer STEP's knob (Anvil pitch/velocity rows,
 * Cascade SEQ 1/2 steps) — those are continuous (`taper: 'lin'`) and must
 * NOT be quantized.
 */

import type { ControlDef } from '../../../data/schema';

/**
 * Mirrors of theme.ts DRAG_FULL_SWEEP_PX / FINE_DRAG_FACTOR / KNOB_SWEEP_DEG.
 * theme.ts re-exports engine code (CABLE_COLORS from src/engine/studio), so importing
 * it here would drag the whole engine into this pure module and its Node tests.
 * Change together with theme.ts or not at all.
 */
export const DRAG_FULL_SWEEP_PX = 150;
export const FINE_DRAG_FACTOR = 0.1;
export const KNOB_SWEEP_DEG = { start: -135, end: 135 } as const;

/** Below this `min`, exp taper (log of min) is unusable — fall back to lin. */
export const EXP_MIN_FLOOR = 0.001;

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function clamp01(n: number): number {
  return clamp(n, 0, 1);
}

/** Defensive [min, max] extraction (schema validation guarantees min < max for knobs). */
function rangeOf(def: ControlDef): { min: number; max: number } {
  const min = typeof def.min === 'number' ? def.min : 0;
  let max = typeof def.max === 'number' ? def.max : 1;
  if (!(max > min)) max = min + 1;
  return { min, max };
}

/** Detented iff the def says so — `type: 'stepKnob'` alone does NOT imply detents. */
function isStepped(def: ControlDef): boolean {
  return def.taper === 'stepped' || typeof def.steps === 'number';
}

/** exp taper is usable only when the whole range sits above the positive floor. */
function usesExpTaper(def: ControlDef): boolean {
  return def.taper === 'exp' && rangeOf(def).min >= EXP_MIN_FLOOR;
}

/**
 * Detent count for stepped defs, null for continuous ones. When `steps` is absent
 * a stepped def snaps to integers (one detent per integer in [min, max]).
 */
export function stepCount(def: ControlDef): number | null {
  if (!isStepped(def)) return null;
  if (typeof def.steps === 'number' && def.steps >= 2) return Math.round(def.steps);
  const { min, max } = rangeOf(def);
  return Math.max(2, Math.round(max - min) + 1);
}

/** Snap a value to the nearest of the def's evenly spaced detents (clamped). No-op for continuous defs. */
export function snapStepped(value: number, def: ControlDef): number {
  const { min, max } = rangeOf(def);
  const v = clamp(value, min, max);
  const count = stepCount(def);
  if (count == null) return v;
  const spacing = (max - min) / (count - 1);
  return min + Math.round((v - min) / spacing) * spacing;
}

/** Value (ControlDef [min, max] space, clamped; stepped values snap) -> norm 0..1. */
export function valueToNorm(value: number, def: ControlDef): number {
  const { min, max } = rangeOf(def);
  const v = clamp(isStepped(def) ? snapStepped(value, def) : value, min, max);
  if (usesExpTaper(def)) return Math.log(v / min) / Math.log(max / min);
  return (v - min) / (max - min);
}

/** Norm 0..1 (clamped) -> value in the def's [min, max] space (stepped values snap). */
export function normToValue(norm: number, def: ControlDef): number {
  const n = clamp01(norm);
  const { min, max } = rangeOf(def);
  const v = usesExpTaper(def) ? min * Math.pow(max / min, n) : min + n * (max - min);
  return isStepped(def) ? snapStepped(v, def) : v;
}

/**
 * Pointer travel -> norm delta. `pixels` is upward-positive travel (callers pass
 * lastY - currentY so dragging up increases the value). DRAG_FULL_SWEEP_PX of travel
 * = one full min->max sweep; `fine` (Shift held) scales by FINE_DRAG_FACTOR.
 * Per-move relative deltas mean toggling Shift mid-drag re-baselines for free.
 */
export function dragDelta(pixels: number, fine: boolean): number {
  return (pixels / DRAG_FULL_SWEEP_PX) * (fine ? FINE_DRAG_FACTOR : 1);
}

/** Norm 0..1 (clamped) -> dial angle in degrees: -135 (min) .. +135 (max), 0 = up. */
export function normToAngle(norm: number): number {
  return KNOB_SWEEP_DEG.start + clamp01(norm) * (KNOB_SWEEP_DEG.end - KNOB_SWEEP_DEG.start);
}

/**
 * Unit-aware display string (<= 4 significant digits for the readout rule):
 * |v| >= 100 -> 0 decimals, >= 1 -> 1, >= 0.1 -> 2, else 3. '%' / 'BPM' / 'div'
 * read as integers from 1 up. Stepped defs always render their integer detent.
 * '%' defs authored as 0..1 fractions (max <= 1, e.g. Monarch PULSE WIDTH duty cycle)
 * display scaled to 0..100; 0..100-calibrated '%' defs (Monarch SWING) pass through.
 * '%' attaches without a space; other units get one.
 */
export function formatValue(value: number, def: ControlDef): string {
  const unit = def.unit ?? '';
  if (isStepped(def)) {
    const n = Math.round(snapStepped(value, def));
    return unit ? (unit === '%' ? `${n}%` : `${n} ${unit}`) : String(n);
  }
  const display = unit === '%' && rangeOf(def).max <= 1 ? value * 100 : value;
  const a = Math.abs(display);
  let decimals: number;
  if (a >= 100) decimals = 0;
  else if (a >= 1) decimals = 1;
  else if (a >= 0.1) decimals = 2;
  else decimals = 3;
  if ((unit === '%' || unit === 'BPM' || unit === 'div') && a >= 1) decimals = 0;
  let text = display.toFixed(decimals);
  if (Number(text) === 0) text = (0).toFixed(decimals); // scrub "-0.000"
  if (!unit) return text;
  return unit === '%' ? `${text}%` : `${text} ${unit}`;
}
