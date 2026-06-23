/**
 * Courier per-step PARAM-LOCK restore-diff (Phase C-Full part 1).
 *
 * Tests diffParamLock — the PURE set-diff the engine binder (studio.ts applyCourierParamLock)
 * delegates to. It owns base-capture + restore-on-diff; the pure seq only forwards step.lock.
 * A tiny fake "engine" (records apply calls) + a fake "store base" (readBase) stand in for the
 * live CourierModule + state.controls.courier — no AudioContext needed. The final test drives the
 * REAL CourierSequencer through the REAL Scheduler into the diff, proving emit-on-every-step makes
 * length-wrap / no-lock restore automatic with zero wrap detection.
 */
import { describe, expect, it } from 'vitest';
import {
  COURIER_LOCKABLE,
  COURIER_LOCKABLE_IDS,
  COURIER_MOD_TARGETS,
  diffParamLock,
  isCourierLockable,
} from '../../src/engine/modRouter';
import { CourierSequencer } from '../../src/engine/sequencers/courierSeq';
import { Scheduler, type TransportEvent } from '../../src/engine/scheduler';

/** data/courier.json defaults for the lockable targets (restore fallback when store has none). */
const JSON_DEFAULT: Record<string, number> = {
  // the six mod targets
  COU_CUTOFF: 2000,
  COU_TUNE: 0,
  COU_OSC2_FREQ: 0,
  COU_OSC1_WAVESHAPE: 0,
  COU_OSC2_WAVESHAPE: 0,
  COU_SUB_WAVE: 0,
  // the twelve lock-only continuous controls
  COU_RESONANCE: 0,
  COU_EG_AMOUNT: 0,
  COU_OSC2_CUTOFF: 0,
  COU_MIX_OSC1: 0.8,
  COU_MIX_OSC2: 0.8,
  COU_MIX_SUB: 0,
  COU_MIX_NOISE: 0,
  COU_VOLUME: 0.7,
  COU_LFO1_RATE: 2,
  COU_LFO1_DEPTH: 0,
  COU_LFO2_RATE: 4,
  COU_GLIDE: 0.001,
};

/** A harness mirroring the binder's owned state + injected callbacks. `storeBase` is the
 *  read-only panel-base source (state.controls.courier coalesced to the JSON default). */
function makeHarness(storeBase: Record<string, number> = {}) {
  const active = new Set<string>();
  const base = new Map<string, number>();
  const applied: { id: string; value: number; restoring: boolean }[] = [];
  const readBase = (id: string) =>
    typeof storeBase[id] === 'number' ? storeBase[id]! : (JSON_DEFAULT[id] ?? 0);
  const step = (lock: Record<string, number>) =>
    diffParamLock(lock, active, base, readBase, (id, value, restoring) =>
      applied.push({ id, value, restoring }),
    );
  return { active, base, applied, step, storeBase };
}

describe('diffParamLock — apply + restore', () => {
  it('applies a lock on its step and restores to base on the next non-locking step', () => {
    const h = makeHarness({ COU_CUTOFF: 2000 });
    h.step({ COU_CUTOFF: 1000 }); // step 0 locks
    expect(h.applied).toEqual([{ id: 'COU_CUTOFF', value: 1000, restoring: false }]);
    expect(h.active.has('COU_CUTOFF')).toBe(true);

    h.applied.length = 0;
    h.step({}); // step 1 locks nothing -> restore
    expect(h.applied).toEqual([{ id: 'COU_CUTOFF', value: 2000, restoring: true }]);
    expect(h.active.size).toBe(0);
    expect(h.base.size).toBe(0);
  });

  it('captures the base from the STORE value, not the JSON default', () => {
    const h = makeHarness({ COU_CUTOFF: 800 }); // user moved the knob to 800
    h.step({ COU_CUTOFF: 1200 });
    h.applied.length = 0;
    h.step({}); // restore -> 800 (store base), NOT 2000 (json default), NOT 1200 (locked)
    expect(h.applied).toEqual([{ id: 'COU_CUTOFF', value: 800, restoring: true }]);
  });

  it('falls back to the data/courier.json default when the store has no value', () => {
    const h = makeHarness({}); // no store value for COU_CUTOFF
    h.step({ COU_CUTOFF: 1200 });
    h.applied.length = 0;
    h.step({});
    expect(h.applied).toEqual([{ id: 'COU_CUTOFF', value: 2000, restoring: true }]); // json default
  });

  it('persists across consecutive locked steps (no spurious restore), re-applying each step', () => {
    const h = makeHarness({ COU_CUTOFF: 2000 });
    h.step({ COU_CUTOFF: 1000 });
    h.step({ COU_CUTOFF: 1500 }); // still locked, new value
    // base captured ONCE (first override), value re-applied each step, no restore yet
    expect(h.base.get('COU_CUTOFF')).toBe(2000);
    expect(h.applied).toEqual([
      { id: 'COU_CUTOFF', value: 1000, restoring: false },
      { id: 'COU_CUTOFF', value: 1500, restoring: false },
    ]);
    expect(h.active.has('COU_CUTOFF')).toBe(true);
  });

  it('locks multiple params independently and restores each as it is dropped', () => {
    const h = makeHarness({ COU_CUTOFF: 2000, COU_TUNE: 0 });
    h.step({ COU_CUTOFF: 1000, COU_TUNE: 5 });
    expect(h.active.size).toBe(2);
    h.applied.length = 0;
    h.step({ COU_CUTOFF: 1000 }); // TUNE dropped -> restore TUNE only; CUTOFF stays locked
    expect(h.applied).toEqual([
      { id: 'COU_CUTOFF', value: 1000, restoring: false },
      { id: 'COU_TUNE', value: 0, restoring: true },
    ]);
    expect([...h.active]).toEqual(['COU_CUTOFF']);
  });

  it('gates the allow-list: a non-lockable switch id and garbage id are safe no-ops', () => {
    const h = makeHarness({});
    // COU_FILTER_MODE is a switch (not in the lockable set); NOT_A_CONTROL is garbage.
    h.step({ COU_FILTER_MODE: 1, NOT_A_CONTROL: 42 });
    expect(h.applied).toEqual([]); // neither passes isCourierLockable
    expect(h.active.size).toBe(0);
    expect(h.base.size).toBe(0);
  });

  it('applies + restores a newly-lockable continuous control (COU_RESONANCE)', () => {
    const h = makeHarness({ COU_RESONANCE: 0.3 }); // store base
    h.step({ COU_RESONANCE: 0.9 });
    expect(h.applied).toEqual([{ id: 'COU_RESONANCE', value: 0.9, restoring: false }]);
    expect(h.active.has('COU_RESONANCE')).toBe(true);

    h.applied.length = 0;
    h.step({}); // restore to store base
    expect(h.applied).toEqual([{ id: 'COU_RESONANCE', value: 0.3, restoring: true }]);
    expect(h.active.size).toBe(0);
  });

  it('locks multiple NEW targets independently (mixer + volume + LFO rate)', () => {
    const h = makeHarness({}); // all fall back to JSON defaults
    h.step({ COU_MIX_OSC1: 0.2, COU_VOLUME: 0.9, COU_LFO1_RATE: 8 });
    expect(h.active.size).toBe(3);
    h.applied.length = 0;
    h.step({ COU_VOLUME: 0.9 }); // drop two -> restore them to JSON defaults; volume stays
    expect(h.applied).toEqual([
      { id: 'COU_VOLUME', value: 0.9, restoring: false },
      { id: 'COU_MIX_OSC1', value: 0.8, restoring: true },
      { id: 'COU_LFO1_RATE', value: 2, restoring: true },
    ]);
    expect([...h.active]).toEqual(['COU_VOLUME']);
  });

  it('a mid-sequence step-jump that lands on a no-lock step restores everything', () => {
    const h = makeHarness({ COU_CUTOFF: 2000 });
    h.step({ COU_CUTOFF: 1000 }); // locked
    h.step({ COU_CUTOFF: 1000 }); // still locked
    h.applied.length = 0;
    h.step({}); // RESET jumped to a no-lock step -> empty map restores it
    expect(h.applied).toEqual([{ id: 'COU_CUTOFF', value: 2000, restoring: true }]);
    expect(h.active.size).toBe(0);
  });
});

describe('diffParamLock — driven by the real sequencer (wrap restore is automatic)', () => {
  /** Collect the real seq's events through the real scheduler, fake time. */
  function collect(seq: CourierSequencer, untilS: number): TransportEvent[] {
    let now = 0;
    const out: TransportEvent[] = [];
    const sched = new Scheduler(() => now, 0.1);
    sched.add(seq, (e) => out.push(e));
    seq.start(0);
    while (now < untilS) {
      sched.pump();
      now += 0.025;
    }
    return out.filter((e) => e.time <= untilS);
  }

  it('re-locks on every step0 and restores on every step1 across two wraps', () => {
    const seq = new CourierSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 2; // wraps: 0,1,0,1,0,1
    seq.steps[0]!.noteVv = 0;
    seq.steps[0]!.lock = { COU_CUTOFF: 1000 };
    // step 1 has no lock
    const evs = collect(seq, 0.75 - 1e-9);

    const h = makeHarness({ COU_CUTOFF: 2000 });
    // feed every paramLock event in time order through the diff (what the binder does)
    for (const e of evs.filter((x) => x.type === 'paramLock')) {
      h.step(e.data!['lock'] as Record<string, number>);
    }
    // 3 locks (each step0) + 3 restores (each step1), strictly alternating
    const locks = h.applied.filter((a) => !a.restoring);
    const restores = h.applied.filter((a) => a.restoring);
    expect(locks).toEqual([
      { id: 'COU_CUTOFF', value: 1000, restoring: false },
      { id: 'COU_CUTOFF', value: 1000, restoring: false },
      { id: 'COU_CUTOFF', value: 1000, restoring: false },
    ]);
    expect(restores).toEqual([
      { id: 'COU_CUTOFF', value: 2000, restoring: true },
      { id: 'COU_CUTOFF', value: 2000, restoring: true },
      { id: 'COU_CUTOFF', value: 2000, restoring: true },
    ]);
    expect(h.active.size).toBe(0); // ends restored (last visited step1 was a no-lock step)
  });
});

describe('flushCourierParamLocks semantics (STOP / PANIC)', () => {
  it('restoring every active lock then clearing leaves nothing active', () => {
    // Models the flush: restore all active to base, then clear both structures.
    const h = makeHarness({ COU_CUTOFF: 2000, COU_TUNE: 0 });
    h.step({ COU_CUTOFF: 1000, COU_TUNE: 5 });
    expect(h.active.size).toBe(2);

    // flush = a final diff against {} restores all active locks to base and clears.
    h.applied.length = 0;
    h.step({});
    expect(h.applied.map((a) => ({ id: a.id, restoring: a.restoring }))).toEqual([
      { id: 'COU_CUTOFF', restoring: true },
      { id: 'COU_TUNE', restoring: true },
    ]);
    expect(h.active.size).toBe(0);
    expect(h.base.size).toBe(0);
  });
});

describe('COURIER_LOCKABLE allow-list shape (widened to 18)', () => {
  const EXPECTED: string[] = [
    'COU_CUTOFF', 'COU_TUNE', 'COU_OSC2_FREQ', 'COU_OSC1_WAVESHAPE', 'COU_OSC2_WAVESHAPE',
    'COU_SUB_WAVE', 'COU_RESONANCE', 'COU_EG_AMOUNT', 'COU_OSC2_CUTOFF', 'COU_MIX_OSC1',
    'COU_MIX_OSC2', 'COU_MIX_SUB', 'COU_MIX_NOISE', 'COU_VOLUME', 'COU_LFO1_RATE',
    'COU_LFO1_DEPTH', 'COU_LFO2_RATE', 'COU_GLIDE',
  ];

  it('is exactly the 18 lockable controls in slot order', () => {
    expect(COURIER_LOCKABLE_IDS).toEqual(EXPECTED);
    expect(COURIER_LOCKABLE.map((e) => e.controlId)).toEqual(EXPECTED);
  });

  it('gives every lockable control a short non-empty caption', () => {
    for (const e of COURIER_LOCKABLE) {
      expect(e.cap.length).toBeGreaterThan(0);
      expect(e.cap.length).toBeLessThanOrEqual(8);
    }
  });

  it('is a strict superset of the six MOD_TARGETS (mod-assign unchanged)', () => {
    // Mod-assign must stay EXACTLY the six; the lockable set adds twelve more on top.
    expect(COURIER_MOD_TARGETS).toEqual([
      'COU_CUTOFF', 'COU_TUNE', 'COU_OSC2_FREQ',
      'COU_OSC1_WAVESHAPE', 'COU_OSC2_WAVESHAPE', 'COU_SUB_WAVE',
    ]);
    for (const id of COURIER_MOD_TARGETS) expect(COURIER_LOCKABLE_IDS).toContain(id);
    expect(COURIER_LOCKABLE_IDS.length).toBe(18);
    expect(COURIER_MOD_TARGETS.length).toBe(6);
  });

  it('isCourierLockable is true for all 18 and false for switches / garbage', () => {
    for (const id of EXPECTED) expect(isCourierLockable(id)).toBe(true);
    for (const id of ['COU_FILTER_MODE', 'COU_SYNC', 'COU_RES_BASS', 'NOT_A_CONTROL', ''])
      expect(isCourierLockable(id)).toBe(false);
  });
});
