/**
 * Courier mod-assign STATE slice (Phase B) + the engine-bridge set/clear action.
 *
 * Two disjoint concerns:
 *   1. PURE slice — defaultCourierModAssignState / coalesceCourierModAssignState (no engine).
 *   2. The singleton bridge's setCourierModAssign / getCourierModAssign, exercised UNPOWERED
 *      (store-only; the engine write lands in a later step), mirroring engineBridgePresets.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COURIER_MOD_SOURCES,
  COURIER_MOD_TARGETS,
  coalesceCourierModAssignState,
  defaultCourierModAssignState,
  type CourierModAssignState,
} from '../../src/state/studioState';
import { engineBridge } from '../../src/ui/engineBridge';

describe('courier mod-assign slice (pure)', () => {
  it('defaultCourierModAssignState() has all 4 routes null', () => {
    expect(defaultCourierModAssignState()).toEqual({
      routes: { kb: null, fEnv: null, aEnv: null, lfo1: null },
    });
    expect(COURIER_MOD_SOURCES).toEqual(['kb', 'fEnv', 'aEnv', 'lfo1']);
  });

  it('coalesceCourierModAssignState(undefined) yields the all-null default', () => {
    expect(coalesceCourierModAssignState(undefined)).toEqual(defaultCourierModAssignState());
  });

  it('passes a valid route through unchanged', () => {
    const raw = { routes: { lfo1: { controlId: 'COU_CUTOFF', depth: 0.5 } } } as Partial<CourierModAssignState>;
    const out = coalesceCourierModAssignState(raw);
    expect(out.routes.lfo1).toEqual({ controlId: 'COU_CUTOFF', depth: 0.5 });
    expect(out.routes.kb).toBeNull();
  });

  it('clamps depth to [-1,1]', () => {
    const hi = coalesceCourierModAssignState({
      routes: { kb: { controlId: 'COU_TUNE', depth: 9 } },
    } as Partial<CourierModAssignState>);
    expect(hi.routes.kb).toEqual({ controlId: 'COU_TUNE', depth: 1 });
    const lo = coalesceCourierModAssignState({
      routes: { kb: { controlId: 'COU_TUNE', depth: -9 } },
    } as Partial<CourierModAssignState>);
    expect(lo.routes.kb).toEqual({ controlId: 'COU_TUNE', depth: -1 });
  });

  it('drops garbage: non-number depth, non-finite depth, and unknown controlId -> null', () => {
    const garbage = coalesceCourierModAssignState({
      routes: {
        kb: { controlId: 'COU_CUTOFF', depth: 'x' }, // non-number depth -> null
        fEnv: { controlId: 'COU_CUTOFF', depth: NaN }, // non-finite -> null
        aEnv: { controlId: 'COU_NOT_A_TARGET', depth: 0.5 }, // not in allow-list -> null
        lfo1: { controlId: 5, depth: 0.5 }, // non-string controlId -> null
      },
    } as unknown as Partial<CourierModAssignState>);
    expect(garbage).toEqual(defaultCourierModAssignState());
  });

  it('every supported COU_ id is an accepted target', () => {
    for (const cid of COURIER_MOD_TARGETS) {
      const out = coalesceCourierModAssignState({
        routes: { kb: { controlId: cid, depth: 0.25 } },
      } as Partial<CourierModAssignState>);
      expect(out.routes.kb).toEqual({ controlId: cid, depth: 0.25 });
    }
  });

  it('never mutates the raw input', () => {
    const raw = { routes: { kb: { controlId: 'COU_CUTOFF', depth: 5 } } } as Partial<CourierModAssignState>;
    const snapshot = JSON.parse(JSON.stringify(raw));
    coalesceCourierModAssignState(raw);
    expect(raw).toEqual(snapshot); // depth still 5 in raw, only the output is clamped
  });
});

describe('engineBridge.setCourierModAssign / getCourierModAssign (unpowered, store-only)', () => {
  beforeEach(() => {
    engineBridge.resetAll(); // clean store before each
  });
  afterEach(() => {
    engineBridge.resetAll();
  });

  it('starts from the all-null default', () => {
    expect(engineBridge.getCourierModAssign()).toEqual(defaultCourierModAssignState());
  });

  it('assigns one source and persists it through the store', () => {
    engineBridge.setCourierModAssign('lfo1', { controlId: 'COU_CUTOFF', depth: 0.5 });
    expect(engineBridge.getCourierModAssign().routes.lfo1).toEqual({
      controlId: 'COU_CUTOFF',
      depth: 0.5,
    });
    // the store tree itself carries it (round-trips through getState)
    expect(engineBridge.store.getState().courier.modAssign.routes.lfo1).toEqual({
      controlId: 'COU_CUTOFF',
      depth: 0.5,
    });
    // the other sources stay null
    expect(engineBridge.getCourierModAssign().routes.kb).toBeNull();
  });

  it('clear = setCourierModAssign(source, null) restores null for that source', () => {
    engineBridge.setCourierModAssign('kb', { controlId: 'COU_TUNE', depth: -0.8 });
    expect(engineBridge.getCourierModAssign().routes.kb).not.toBeNull();
    engineBridge.setCourierModAssign('kb', null);
    expect(engineBridge.getCourierModAssign().routes.kb).toBeNull();
  });

  it('getCourierModAssign returns a reference-stable snapshot until a route changes', () => {
    const a = engineBridge.getCourierModAssign();
    const b = engineBridge.getCourierModAssign();
    expect(a).toBe(b); // same identity while nothing changed
    engineBridge.setCourierModAssign('aEnv', { controlId: 'COU_OSC2_FREQ', depth: 0.3 });
    const c = engineBridge.getCourierModAssign();
    expect(c).not.toBe(b); // new identity after a change
    expect(c.routes.aEnv).toEqual({ controlId: 'COU_OSC2_FREQ', depth: 0.3 });
  });
});
