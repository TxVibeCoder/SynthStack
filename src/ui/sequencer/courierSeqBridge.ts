/**
 * UI-local adapter for the Courier step editor's store/engine interactions.
 *
 * WHY this file exists: the dedicated engineBridge transport / step-edit / record
 * methods for Courier (courierRun/courierStop/courierReset, updateCourierStep,
 * setCourierEndStep, setCourierRecordHandler, the `courierRunning` TransportFlags
 * field + the 'courier' step-position channel) are owned by the engine/bridge
 * Integrate step and are added there, NOT here. So this UI step:
 *
 *   - STEP EDITS + END STEP: written DIRECTLY through engineBridge.store (the public,
 *     pre-power store). One clone-edit-setState commit per edit, exactly mirroring what
 *     updateCourierStep/setCourierEndStep do. Studio.syncTransportConfig (wired by the
 *     Integrate step) mirrors the courier.seq slice into the live CourierSequencer on the
 *     resulting store notification — so no direct engine write is needed here and this
 *     works today with zero bridge changes.
 *
 *   - TRANSPORT (run/stop/reset), LIVE/STEP RECORD, the courierRunning lamp, and the
 *     step-LED chase channel: these genuinely need the engine. They are feature-detected
 *     off engineBridge at runtime via a structural optional-method interface, so this
 *     module type-checks and the editor renders whether or not the Integrate step has
 *     landed yet. Once Integrate adds the named bridge methods, these light up with no UI
 *     change. Until then they are graceful no-ops (the step grid + editing still work).
 *
 * This boundary keeps the UI step inside its allowed files (it never edits engineBridge.ts,
 * studio.ts, or courierSeq.ts) while honoring the contract's named actions.
 */

import { engineBridge } from '../engineBridge';
import type { CourierSequencerState, CourierStepState } from '../../state/studioState';

/** The slice shape the editor reads. */
export interface CourierSeqView {
  steps: CourierStepState[];
  endStep: number;
}

/** Read the live courier.seq slice straight off the store (deep-cloned by getState). */
export function readCourierSeq(): CourierSeqView {
  const seq = engineBridge.store.getState().courier.seq;
  return { steps: seq.steps, endStep: seq.endStep };
}

/**
 * Patch one step (0..63) and commit the whole tree. Mirrors the contract's
 * updateCourierStep(index, patch): bounds-guard, clone, Object.assign, setState.
 * syncTransportConfig mirrors it into the live sequencer on the notification.
 */
export function updateCourierStep(index: number, patch: Partial<CourierStepState>): void {
  if (index < 0 || index > 63) return;
  const s = engineBridge.store.getState();
  const step = s.courier.seq.steps[index];
  if (!step) return;
  Object.assign(step, patch);
  engineBridge.store.setState(s);
}

/** Clamp + commit END STEP (sequence LENGTH 1..64). Mirrors setCourierEndStep. */
export function setCourierEndStep(endStep: number): void {
  const s = engineBridge.store.getState();
  s.courier.seq.endStep = Math.min(64, Math.max(1, Math.round(endStep)));
  engineBridge.store.setState(s);
}

/**
 * Commit one scalar/enum field of the courier.seq slice (LENGTH/SWING/GATE LENGTH/CLOCK
 * DIV/MODE/ARP MODE). These live ON the seq slice — Studio.syncTransportConfig reads
 * s.courier.seq directly, so they MUST be written here (a plain controls-store write would
 * be inert for the sequencer). Each value is clamped to its valid range by the editor before
 * calling, but the slice fields are typed so an out-of-range write can't compile.
 */
type CourierSeqScalarKey = 'endStep' | 'swingPct' | 'gateLenScale' | 'clockDivIdx' | 'mode' | 'arpMode';
type CourierSeqScalars = Pick<CourierSequencerState, CourierSeqScalarKey>;
export function setCourierSeqField<K extends CourierSeqScalarKey>(
  key: K,
  value: CourierSequencerState[K],
): void {
  const s = engineBridge.store.getState();
  s.courier.seq[key] = value;
  engineBridge.store.setState(s);
}

/** Read the full seq-settings snapshot (the scalar/enum fields) for the strip's setting row. */
export function readCourierSeqSettings(): CourierSeqScalars {
  const q = engineBridge.store.getState().courier.seq;
  return {
    endStep: q.endStep,
    swingPct: q.swingPct,
    gateLenScale: q.gateLenScale,
    clockDivIdx: q.clockDivIdx,
    mode: q.mode,
    arpMode: q.arpMode,
  };
}

// ---- engine-owned surfaces, feature-detected (Integrate step lands these) ------------------

/**
 * Optional bridge surface added by the Integrate step. Declared structurally so this UI
 * module compiles against whatever engineBridge currently exposes — the methods are read
 * defensively and called only when present.
 */
interface CourierEngineBridge {
  courierRun?(): void;
  courierStop?(): void;
  courierReset?(): void;
  setCourierRecordHandler?(fn: ((noteVv: number) => void) | null): void;
  getTransportFlags?(): { courierRunning?: boolean };
  getStepPosition?(machine: string): number;
  subscribeStepPositions?(cb: () => void): () => void;
}

/** engineBridge viewed through the optional Courier surface (no `any`, no nonexistent refs). */
const cbridge = engineBridge as unknown as CourierEngineBridge;

export function courierRun(): void {
  cbridge.courierRun?.();
}
export function courierStop(): void {
  cbridge.courierStop?.();
}
export function courierReset(): void {
  cbridge.courierReset?.();
}

/** Arm/clear the live+step record handler (no-op until the Integrate step adds it). */
export function setCourierRecordHandler(fn: ((noteVv: number) => void) | null): void {
  cbridge.setCourierRecordHandler?.(fn);
}

/** True while the Courier sequencer is running; false if the flag isn't wired yet. */
export function courierIsRunning(): boolean {
  return cbridge.getTransportFlags?.().courierRunning === true;
}

/** Current Courier step-chase index (-1 until the engine emits a 'step' for it). */
export function courierStepPosition(): number {
  const fn = cbridge.getStepPosition;
  if (!fn) return -1;
  try {
    return fn.call(engineBridge, 'courier');
  } catch {
    // The channel isn't registered yet — treat as "no position".
    return -1;
  }
}

/** Subscribe to step-position changes (shared rAF channel). No-op unsub if unavailable. */
export function subscribeCourierStepPosition(cb: () => void): () => void {
  return cbridge.subscribeStepPositions?.(cb) ?? (() => undefined);
}

/** Subscribe to the store (for the seq snapshot + the running-flag poll fallback). */
export function subscribeStore(cb: () => void): () => void {
  return engineBridge.store.subscribe(cb);
}
