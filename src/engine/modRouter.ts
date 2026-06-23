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

/**
 * Short button captions for the param-lock matrix UI, keyed by control id. Kept next to
 * MOD_TARGETS so the lockable set and its labels never drift. (Phase C param-locks.)
 */
const SHORT_CAP: Record<string, string> = {
  COU_CUTOFF: 'CUTOFF',
  COU_TUNE: 'TUNE',
  COU_OSC2_FREQ: 'OSC2 FRQ',
  COU_OSC1_WAVESHAPE: 'O1 WAVE',
  COU_OSC2_WAVESHAPE: 'O2 WAVE',
  COU_SUB_WAVE: 'SUB WAVE',
};

/**
 * THE shared per-step param-lock allow-list (Phase C-Full part 1). Both the engine binder
 * (which validates each lock via findModTarget) and the UI matrix (which renders one button
 * per entry) import THIS so the lockable set can never drift. It is a strict superset-equal of
 * MOD_TARGETS — derived from it, so adding a mod target automatically makes it lockable. The
 * UI resolves each control's min/max/taper from data/courier.json (the single range source).
 */
export const COURIER_LOCKABLE: { controlId: string; cap: string }[] = MOD_TARGETS.map((t) => ({
  controlId: t.controlId,
  cap: SHORT_CAP[t.controlId] ?? t.controlId,
}));

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

/**
 * PURE per-step param-lock set-diff (Phase C-Full) — the heart of the restore design, factored
 * out of the engine binder so it is Node-testable with no AudioContext and so the binder and its
 * tests can never drift. `lock` is the FULL authoritative override-set for the current step
 * (emitted every step, {} when nothing is locked). Mutates the caller-owned `active` set + `base`
 * map in place and drives the live engine only through the injected callbacks:
 *   - `readBase(id)`  -> the un-locked base to restore to (the binder reads the STORE here).
 *   - `apply(id,val)` -> schedule/write the value on the live engine.
 * Behavior: (1) APPLY — for each id in `lock` that passes the allow-list (findModTarget),
 * capture-base-if-new then apply the locked value; (2) RESTORE — for each currently-active id NOT
 * in `lock`, apply its captured base and clear it. Because every step calls this with its full map,
 * length-wrap and RESET-jump restore for free (a no-lock step's empty map releases everything).
 * Stray / non-MOD_TARGET ids are a safe no-op (never applied, never tracked).
 */
export function diffParamLock(
  lock: Record<string, number>,
  active: Set<string>,
  base: Map<string, number>,
  readBase: (id: string) => number,
  apply: (id: string, value: number, restoring: boolean) => void,
): void {
  for (const id of Object.keys(lock)) {
    if (!findModTarget(id)) continue; // allow-list gate (the six MOD_TARGETS only)
    if (!active.has(id)) base.set(id, readBase(id)); // lazy base capture on first override
    apply(id, lock[id]!, false);
    active.add(id);
  }
  for (const id of [...active]) {
    if (Object.prototype.hasOwnProperty.call(lock, id)) continue;
    apply(id, base.get(id)!, true); // restore the dropped lock to its base
    active.delete(id);
    base.delete(id);
  }
}
