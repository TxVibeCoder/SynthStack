/**
 * Courier mod-matrix routing core (PURE — no Web Audio types, Node-unit-tested).
 *
 * THE single source of truth for the Courier per-patch mod matrix:
 *  - which panel controls are valid modulation TARGETS (the COU_ allow-list),
 *  - which engine bus each target maps to, and
 *  - the depth -> gain scaling so depth=1 is musically sensible on every target.
 *
 * Shared by three consumers so they never drift: the state coalesce (which targets are
 * legal), the UI (which knobs accept a depth assignment), and the engine (the per-pair
 * scale-gain `.gain.value` it writes). The engine sets each (source,target) pair's gain to
 * `modGain(depth, spec)`; an unassigned / elsewhere-assigned pair is 0. Summation onto a
 * multi-source bus (e.g. cutoff already summing EG + LFOs) is plain additive AudioNode fan-in.
 */

/** The engine buses a mod source can be summed onto (one per supported target). */
export type ModBus = 'cutoff' | 'pitch' | 'osc2pitch' | 'osc1wave' | 'osc2wave' | 'subwave';

export interface ModTargetSpec {
  controlId: string;
  bus: ModBus;
  /** depth(-1..1) -> bus contribution scale. Carries the per-target unit conversion
   *  (e.g. 1/5 folds a +-5 vv swing into a 0..1 waveshape morph). */
  scale: number;
}

/** The 6 supported modulation targets. scale makes depth=1 a full, musical swing on each. */
export const MOD_TARGETS: ModTargetSpec[] = [
  { controlId: 'COU_CUTOFF', bus: 'cutoff', scale: 5 }, // +5 vv = +5 oct cutoff CV
  { controlId: 'COU_TUNE', bus: 'pitch', scale: 1 }, // both oscillators, +1 oct (vibrato)
  { controlId: 'COU_OSC2_FREQ', bus: 'osc2pitch', scale: 1 }, // OSC 2 only, +1 oct
  { controlId: 'COU_OSC1_WAVESHAPE', bus: 'osc1wave', scale: 1 / 5 }, // +-5 vv -> +-1 morph
  { controlId: 'COU_OSC2_WAVESHAPE', bus: 'osc2wave', scale: 1 / 5 },
  { controlId: 'COU_SUB_WAVE', bus: 'subwave', scale: 1 / 5 },
];

/** The allow-list of modulatable COU_ control ids (re-exported by studioState.ts). */
export const COURIER_MOD_TARGETS: string[] = MOD_TARGETS.map((t) => t.controlId);

/** Look up a target spec by control id; undefined for a non-modulatable control (e.g. a switch). */
export function findModTarget(controlId: string): ModTargetSpec | undefined {
  return MOD_TARGETS.find((t) => t.controlId === controlId);
}

/**
 * Routing math: one (source,target) pair contributes `source_signal * modGain(depth, spec)`
 * onto the target bus. Clamps depth to [-1,1] (the bipolar UI range) then applies the
 * target's scale. This IS the value the engine writes to the pair's scale-gain `.gain.value`.
 */
export function modGain(depth: number, spec: ModTargetSpec): number {
  return Math.max(-1, Math.min(1, depth)) * spec.scale;
}
