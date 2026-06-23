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
  // the six mod targets (also lockable; slots 0-5)
  COU_CUTOFF: 'CUTOFF',
  COU_TUNE: 'TUNE',
  COU_OSC2_FREQ: 'OSC2 FRQ',
  COU_OSC1_WAVESHAPE: 'O1 WAVE',
  COU_OSC2_WAVESHAPE: 'O2 WAVE',
  COU_SUB_WAVE: 'SUB WAVE',
  // the twelve lock-only continuous controls (slots 6-17)
  COU_RESONANCE: 'RESO',
  COU_EG_AMOUNT: 'EG AMT',
  COU_OSC2_CUTOFF: 'O2>CUT',
  COU_MIX_OSC1: 'MIX O1',
  COU_MIX_OSC2: 'MIX O2',
  COU_MIX_SUB: 'MIX SUB',
  COU_MIX_NOISE: 'MIX NSE',
  COU_VOLUME: 'VOLUME',
  COU_LFO1_RATE: 'L1 RATE',
  COU_LFO1_DEPTH: 'L1 DEPTH',
  COU_LFO2_RATE: 'L2 RATE',
  COU_GLIDE: 'GLIDE',
};

/**
 * THE shared per-step param-lock allow-list (Phase C-Full part 2). Both the engine binder
 * (which validates each lock via isCourierLockable) and the UI matrix (which renders one button
 * per entry) import THIS so the lockable set can never drift. It is a strict SUPERSET of
 * MOD_TARGETS: the six mod targets first (slots 0-5, kept stable so existing locks/tests do not
 * churn), then twelve lock-only continuous controls (slots 6-17). It is INDEPENDENT of mod-assign
 * — param-locks are settable-at-a-time control writes, not mod-bus routes — so widening this list
 * never touches MOD_TARGETS / findModTarget / setModAssign (the mod-matrix stays exactly the six).
 * The UI resolves each control's min/max/taper from data/courier.json (the single range source).
 */
export const COURIER_LOCKABLE_IDS: string[] = [
  // slots 0-5: the six mod targets (order preserved)
  'COU_CUTOFF',
  'COU_TUNE',
  'COU_OSC2_FREQ',
  'COU_OSC1_WAVESHAPE',
  'COU_OSC2_WAVESHAPE',
  'COU_SUB_WAVE',
  // slots 6-17: lock-only continuous controls (every one is cleanly settable in courier.ts)
  'COU_RESONANCE',
  'COU_EG_AMOUNT',
  'COU_OSC2_CUTOFF',
  'COU_MIX_OSC1',
  'COU_MIX_OSC2',
  'COU_MIX_SUB',
  'COU_MIX_NOISE',
  'COU_VOLUME',
  'COU_LFO1_RATE',
  'COU_LFO1_DEPTH',
  'COU_LFO2_RATE',
  'COU_GLIDE',
];

export const COURIER_LOCKABLE: { controlId: string; cap: string }[] = COURIER_LOCKABLE_IDS.map(
  (id) => ({ controlId: id, cap: SHORT_CAP[id] ?? id }),
);

/** True iff `id` may be per-step param-locked. The binder's allow-list gate (NOT findModTarget,
 *  which is the narrower mod-assign gate). */
export function isCourierLockable(id: string): boolean {
  return COURIER_LOCKABLE_IDS.includes(id);
}

/** Look up a target spec by control id; undefined for a non-modulatable control (e.g. a switch).
 *  This is the MOD-ASSIGN gate (the six MOD_TARGETS) — NOT the wider param-lock gate. */
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
 * Behavior: (1) APPLY — for each id in `lock` that passes the allow-list (isCourierLockable),
 * capture-base-if-new then apply the locked value; (2) RESTORE — for each currently-active id NOT
 * in `lock`, apply its captured base and clear it. Because every step calls this with its full map,
 * length-wrap and RESET-jump restore for free (a no-lock step's empty map releases everything).
 * Stray / non-lockable ids are a safe no-op (never applied, never tracked).
 */
export function diffParamLock(
  lock: Record<string, number>,
  active: Set<string>,
  base: Map<string, number>,
  readBase: (id: string) => number,
  apply: (id: string, value: number, restoring: boolean) => void,
): void {
  for (const id of Object.keys(lock)) {
    if (!isCourierLockable(id)) continue; // allow-list gate (the 18 lockable controls)
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
