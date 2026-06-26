/**
 * React hooks over the engine bridge (stage 1 — CONVENTIONS.md data-flow rules).
 *
 * useControl subscribes a SINGLE control via useSyncExternalStore with a
 * per-control snapshot: the snapshot is a primitive (number | string), so React's
 * Object.is bailout means a store write re-renders only the controls it changed —
 * never a whole panel. onInput is the imperative engine-only write for drags;
 * onCommit lands the one store write on release.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { engineBridge, type TransportFlags } from './engineBridge';
import type { CourierModAssignState } from '../state/studioState';
import { readCourierSeqSettings, subscribeStore } from './sequencer/courierSeqBridge';

export type { TransportFlags };

/**
 * [value, onInput, onCommit] for one control.
 * - value: store value, or `fallback` (normally ControlDef.default) when unset.
 * - onInput(v): immediate engine write via the bridge — NO store write, no re-renders
 *   outside the dragged control (its mid-drag value is the control's own local state).
 * - onCommit(v): engine write + single store commit (release / double-click reset).
 *
 * T is number for knobs/stepKnobs, string for switch/button positions — the store
 * holds whichever the control's ControlDef defines, so the cast is the data contract.
 */
export function useControl<T extends number | string>(
  moduleId: string,
  controlId: string,
  fallback: T,
): [T, (v: T) => void, (v: T) => void] {
  const subscribe = useCallback(
    (onStoreChange: () => void) => engineBridge.store.subscribe(onStoreChange),
    [],
  );
  const getSnapshot = useCallback(
    () => (engineBridge.store.getControl(moduleId, controlId) ?? fallback) as T,
    [moduleId, controlId, fallback],
  );
  const value = useSyncExternalStore(subscribe, getSnapshot);

  const onInput = useCallback(
    (v: T) => engineBridge.applyControlInput(moduleId, controlId, v),
    [moduleId, controlId],
  );
  const onCommit = useCallback(
    (v: T) => engineBridge.applyControlCommit(moduleId, controlId, v),
    [moduleId, controlId],
  );
  return [value, onInput, onCommit];
}

/**
 * Power switch state. powerOn() must be called from a user gesture (autoplay
 * policy). Tracked as local state over the bridge's flag;
 * stage 1 has a single power control, so no cross-component subscription needed.
 */
export function usePower(): {
  powered: boolean;
  powerOn: () => Promise<void>;
  powerOff: () => Promise<void>;
} {
  const [powered, setPowered] = useState(() => engineBridge.powered);
  const powerOn = useCallback(async () => {
    await engineBridge.powerOn();
    setPowered(engineBridge.powered);
  }, []);
  const powerOff = useCallback(async () => {
    await engineBridge.powerOff();
    setPowered(engineBridge.powered);
  }, []);
  return { powered, powerOn, powerOff };
}

/**
 * Step-LED chase position for a machine (stage 3): −1 until the transport has
 * emitted a step. Driven by the bridge's rAF drain of the scheduler uiQueue
 * — re-renders only when the position actually changes.
 */
export function useStepPosition(machine: 'monarch' | 'anvil' | 'drum'): number;
export function useStepPosition(machine: 'cascade', seq: 0 | 1): number;
export function useStepPosition(machine: 'monarch' | 'anvil' | 'cascade' | 'drum', seq?: 0 | 1): number {
  const subscribe = useCallback(
    (onChange: () => void) => engineBridge.subscribeStepPositions(onChange),
    [],
  );
  const getSnapshot = useCallback(
    () =>
      machine === 'cascade'
        ? engineBridge.getStepPosition('cascade', seq ?? 0)
        : engineBridge.getStepPosition(machine),
    [machine, seq],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * Subscribe to the Courier mod-matrix slice (reference-stable via getCourierModAssign's JSON
 * cache, so it re-renders only when a route actually changes). Mirrors useControl's
 * subscribe/getSnapshot shape. Target knobs read their own route by selecting the entry whose
 * controlId === their def.id.
 */
export function useCourierModAssign(): CourierModAssignState {
  const subscribe = useCallback((cb: () => void) => engineBridge.store.subscribe(cb), []);
  const getSnapshot = useCallback(() => engineBridge.getCourierModAssign(), []);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * Snapshot of the Courier sequencer SETTINGS scalars (`state.courier.seq.*`), re-read on store
 * change and JSON-diffed so a settings write re-renders the row but unrelated store traffic
 * doesn't. SHARED by the step-editor settings row and the main Courier panel's sequencer-band
 * controls — both read/write the one seq slice (via setCourierSeqField) so they stay in lockstep.
 * (readCourierSeqSettings returns a fresh object each call, so this can't be a plain
 * useSyncExternalStore getSnapshot — it would loop; the JSON-diff + useState is the stable form.)
 */
export function useCourierSeqSettings(): ReturnType<typeof readCourierSeqSettings> {
  const [snap, setSnap] = useState(readCourierSeqSettings);
  useEffect(() => {
    let last = JSON.stringify(readCourierSeqSettings());
    return subscribeStore(() => {
      const next = readCourierSeqSettings();
      const key = JSON.stringify(next);
      if (key !== last) {
        last = key;
        setSnap(next);
      }
    });
  }, []);
  return snap;
}

/** UI poll cadence for transport lamps — UI-only; audio events never use timers like this. */
const TRANSPORT_POLL_MS = 250;

/**
 * Minimal stage-1 transport lamps: running flags polled straight off the pure
 * transports every 250 ms. Bails out (returns the same object) when nothing
 * changed, so subscribers re-render at most on actual run/stop transitions.
 * Step-LED chasing is NOT this hook — that comes from the scheduler uiQueue via
 * rAF in stage 2.
 */
export function useTransportFlags(): TransportFlags {
  const [flags, setFlags] = useState<TransportFlags>(() => engineBridge.getTransportFlags());
  useEffect(() => {
    const id = setInterval(() => {
      const next = engineBridge.getTransportFlags();
      setFlags((prev) =>
        prev.monarchRunning === next.monarchRunning &&
        prev.anvilRunning === next.anvilRunning &&
        prev.cascadePlaying === next.cascadePlaying &&
        prev.drumRunning === next.drumRunning
          ? prev
          : next,
      );
    }, TRANSPORT_POLL_MS);
    return () => clearInterval(id);
  }, []);
  return flags;
}

/** UI poll cadence for the RECORD lamp + elapsed timer — UI-only (same as the transport poll). */
const RECORDING_POLL_MS = 250;

/** Master-output recorder state surfaced to the UI (runtime-only). */
export interface RecordingState {
  recording: boolean;
  elapsedMs: number;
}

/**
 * Master-recording lamp + elapsed readout: `{ recording, elapsedMs }`
 * polled off the bridge every 250 ms. Bails out (returns the same object) when both
 * fields are unchanged, so the RECORD button re-renders at most once per tick while
 * recording and never while idle. UI poll only — no rAF, no audio timer; the elapsed
 * value is a UI timer, never an audio event. The engine auto-stops on power-off, so the
 * poll observes `recording` flip to false within one tick (the UI is not a second owner
 * of stop). engineBridge.getRecordingState() is safe before power-on ({false, 0}).
 */
export function useRecordingState(): RecordingState {
  const [s, setS] = useState<RecordingState>(() => engineBridge.getRecordingState());
  useEffect(() => {
    const id = setInterval(() => {
      const next = engineBridge.getRecordingState();
      setS((prev) =>
        prev.recording === next.recording && prev.elapsedMs === next.elapsedMs ? prev : next,
      );
    }, RECORDING_POLL_MS);
    return () => clearInterval(id);
  }, []);
  return s;
}
