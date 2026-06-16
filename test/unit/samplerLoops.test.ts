import { describe, expect, it } from 'vitest';
import { SamplerLoopClock } from '../../src/engine/sequencers/samplerLoops';
import { Scheduler, type TransportEvent } from '../../src/engine/scheduler';
import { barPeriodS, nextBoundary, type PhaseRef } from '../../src/engine/quantGrid';
import { monarchStepDurS } from '../../src/engine/units';

/** A running master phase whose bar downbeat sits at `anchorTime`. */
function runningPhase(anchorTime = 0, bpm = 120): PhaseRef {
  return { running: true, tempoBpm: bpm, anchorTime, sixteenthDurS: monarchStepDurS(bpm) };
}
function stoppedPhase(bpm = 120): PhaseRef {
  return { running: false, tempoBpm: bpm, anchorTime: 0, sixteenthDurS: monarchStepDurS(bpm) };
}

/**
 * Drive the clock through the real Scheduler with fake time. `setup` runs once at t=0
 * (after the clock is registered) to queue launches/stops, mirroring monarchseq.test.ts.
 */
function collect(
  clock: SamplerLoopClock,
  untilS: number,
  setup: (clock: SamplerLoopClock) => void,
): TransportEvent[] {
  let now = 0;
  const out: TransportEvent[] = [];
  const sched = new Scheduler(() => now, 0.1);
  sched.add(clock, (e) => out.push(e));
  setup(clock);
  while (now < untilS) {
    sched.pump();
    now += 0.025;
  }
  return out.filter((e) => e.time <= untilS);
}

const padTimes = (evs: TransportEvent[], type: string, pad: number) =>
  evs.filter((e) => e.type === type && e.data?.['pad'] === pad).map((e) => e.time);

describe('SamplerLoopClock (feature: loop-quantize)', () => {
  it('idles at Infinity, stays running, and never throws "did not advance"', () => {
    const clock = new SamplerLoopClock();
    expect(clock.running).toBe(true);
    expect(clock.nextEventTime).toBe(Infinity);
    let now = 0;
    const sched = new Scheduler(() => now, 0.1);
    sched.add(clock, () => {});
    for (let i = 0; i < 50; i++) {
      expect(() => sched.pump()).not.toThrow();
      now += 0.05;
    }
    expect(clock.running).toBe(true);
    expect(clock.nextEventTime).toBe(Infinity);
  });

  it('a quantized launch fires loopStart on the boundary then loopRelaunch each bar', () => {
    const clock = new SamplerLoopClock();
    const phase = runningPhase(0, 120); // bar = 2.0 s
    const out = collect(clock, 7.0 - 1e-9, (c) => {
      // tap mid-bar at 0.3 s, quantized to 1 BAR -> launches at the next bar (2.0 s)
      const target = nextBoundary(0.3, '1 BAR', phase);
      c.requestLaunch(0, target, phase);
    });
    const starts = padTimes(out, 'loopStart', 0);
    const relaunches = padTimes(out, 'loopRelaunch', 0);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toBeCloseTo(2.0, 9);
    // re-launch on every subsequent bar: 4.0, 6.0 (within the 7 s window)
    expect(relaunches).toHaveLength(2);
    expect(relaunches[0]).toBeCloseTo(4.0, 9);
    expect(relaunches[1]).toBeCloseTo(6.0, 9);
  });

  it('per-bar re-launch cadence is drift-free over many bars (absolute origin form)', () => {
    const clock = new SamplerLoopClock();
    const phase = runningPhase(0, 137); // awkward tempo to stress float accumulation
    const period = barPeriodS(phase);
    const bars = 200;
    const out = collect(clock, period * (bars + 0.5), (c) => {
      c.requestLaunch(0, nextBoundary(0.001, '1 BAR', phase), phase);
    });
    const launches = [...padTimes(out, 'loopStart', 0), ...padTimes(out, 'loopRelaunch', 0)];
    launches.sort((a, b) => a - b);
    const firstLaunch = launches[0]!;
    launches.forEach((t, j) => {
      // cycle j sits at the exact multiply firstLaunch + j*period — no accumulation
      expect(t).toBeCloseTo(firstLaunch + j * period, 9);
    });
    // and the cadence actually ran for the expected number of bars
    expect(launches.length).toBeGreaterThanOrEqual(bars);
  });

  it('a quantized stop fires loopStop on the next boundary and halts re-launch', () => {
    const clock = new SamplerLoopClock();
    const phase = runningPhase(0, 120); // bar = 2.0 s
    const out = collect(clock, 9.0 - 1e-9, (c) => {
      c.requestLaunch(0, nextBoundary(0.1, '1 BAR', phase), phase); // start at 2.0
    });
    // mid-run we cannot inject a second tap via collect's single setup; drive a stop
    // through a fresh manual run to assert the stop semantics deterministically.
    const clock2 = new SamplerLoopClock();
    let now = 0;
    const seen: TransportEvent[] = [];
    const sched = new Scheduler(() => now, 0.1);
    sched.add(clock2, (e) => seen.push(e));
    clock2.requestLaunch(0, nextBoundary(0.1, '1 BAR', phase), phase); // 2.0
    // advance to just past the start so the loop is sounding
    while (now < 3.0) {
      sched.pump();
      now += 0.025;
    }
    expect(padTimes(seen, 'loopStart', 0)).toHaveLength(1);
    // now request a stop, quantized to the next bar (4.0)
    clock2.requestStop(0, nextBoundary(now, '1 BAR', phase), phase);
    while (now < 9.0) {
      sched.pump();
      now += 0.025;
    }
    const stops = padTimes(seen, 'loopStop', 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBeCloseTo(4.0, 9);
    // no re-launch fires at or after the stop (4.0); the only relaunch was at 2.0..4.0? none before stop here
    const relaunchesAfterStop = padTimes(seen, 'loopRelaunch', 0).filter((t) => t >= 4.0 - 1e-9);
    expect(relaunchesAfterStop).toHaveLength(0);
    // sanity: the un-stopped first clock keeps re-launching past 4.0
    expect(padTimes(out, 'loopRelaunch', 0).some((t) => t > 4.0)).toBe(true);
  });

  it('last-tap-wins: launch then stop in the same bar leaves no stuck loop', () => {
    const clock = new SamplerLoopClock();
    const phase = runningPhase(0, 120);
    const target = nextBoundary(0.1, '1 BAR', phase); // 2.0
    const out = collect(clock, 9.0 - 1e-9, (c) => {
      c.requestLaunch(0, target, phase);
      c.requestStop(0, target, phase); // immediately superseded by a stop at the same boundary
    });
    // requestStop cleared pendingStart, so NO loopStart, hence nothing to re-launch
    expect(padTimes(out, 'loopStart', 0)).toHaveLength(0);
    expect(padTimes(out, 'loopRelaunch', 0)).toHaveLength(0);
    // the stop fires harmlessly (loop was never started) and the clock returns to idle
    const stops = padTimes(out, 'loopStop', 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBeCloseTo(2.0, 9);
    expect(clock.nextEventTime).toBe(Infinity);
  });

  it('stop superseded by a fresh launch (last tap) keeps the loop running', () => {
    const clock = new SamplerLoopClock();
    const phase = runningPhase(0, 120);
    const target = nextBoundary(0.1, '1 BAR', phase); // 2.0
    const out = collect(clock, 5.0 - 1e-9, (c) => {
      c.requestStop(0, target, phase); // a stop with no running loop
      c.requestLaunch(0, target, phase); // last tap wins -> a launch instead
    });
    expect(padTimes(out, 'loopStop', 0)).toHaveLength(0);
    expect(padTimes(out, 'loopStart', 0)).toHaveLength(1);
    expect(padTimes(out, 'loopRelaunch', 0)[0]).toBeCloseTo(4.0, 9);
  });

  it('re-launch contributes nothing while the master is not running', () => {
    const clock = new SamplerLoopClock();
    const stopped = stoppedPhase(120);
    // with a stopped master a UI tap launches immediately (afterTime); model that target
    const out = collect(clock, 6.0 - 1e-9, (c) => {
      const target = nextBoundary(0.5, '1 BAR', stopped); // == 0.5 (immediate)
      c.requestLaunch(0, target, stopped);
    });
    // the launch still fires (immediate)
    const starts = padTimes(out, 'loopStart', 0);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toBeCloseTo(0.5, 9);
    // but NO grid re-launch occurs while the master is stopped (native source.loop covers continuity)
    expect(padTimes(out, 'loopRelaunch', 0)).toHaveLength(0);
    expect(clock.nextEventTime).toBe(Infinity); // nothing pending, no running-master relaunch
  });

  it('independent pads keep independent re-launch series', () => {
    const clock = new SamplerLoopClock();
    const phase = runningPhase(0, 120);
    let now = 0;
    const seen: TransportEvent[] = [];
    const sched = new Scheduler(() => now, 0.1);
    sched.add(clock, (e) => seen.push(e));
    clock.requestLaunch(0, nextBoundary(0.1, '1 BAR', phase), phase); // pad 0 starts at 2.0
    clock.requestLaunch(3, nextBoundary(0.1, '1/2', phase), phase); // pad 3 starts at the next 1/2 (1.0)
    while (now < 5.0) {
      sched.pump();
      now += 0.025;
    }
    expect(padTimes(seen, 'loopStart', 0)[0]).toBeCloseTo(2.0, 9);
    expect(padTimes(seen, 'loopStart', 3)[0]).toBeCloseTo(1.0, 9);
    // both re-launch once per bar from their own origins
    expect(padTimes(seen, 'loopRelaunch', 0)[0]).toBeCloseTo(4.0, 9);
    expect(padTimes(seen, 'loopRelaunch', 3)[0]).toBeCloseTo(3.0, 9);
  });

  it('advance always pushes nextEventTime strictly forward or to Infinity (no scheduler throw)', () => {
    const clock = new SamplerLoopClock();
    const phase = runningPhase(0, 90); // odd bar period
    let now = 0;
    const sched = new Scheduler(() => now, 0.1);
    sched.add(clock, () => {});
    clock.requestLaunch(0, nextBoundary(0.0, '1/8', phase), phase);
    clock.requestLaunch(5, nextBoundary(0.0, '1/4', phase), phase);
    for (let i = 0; i < 2000; i++) {
      expect(() => sched.pump()).not.toThrow();
      now += 0.025;
    }
  });
});

/**
 * Live per-pump phase provider (loop-quantize bug fixes 1–3). The studio wires
 * SamplerLoopClock.setPhaseProvider(() => monarchSeq.phaseRef()); the scheduler calls
 * onPump(now) every pass BEFORE reading nextEventTime, so a tempo/run-state change that
 * arrives WITHOUT a fresh pad tap is honored from the next pump. These tests drive a
 * MUTABLE phase through that provider — exactly the path a TEMPO-knob turn or RUN/STOP
 * (which never re-tap the pad) takes — and would all fail against the old snapshot-only
 * clock that read its phase solely on the launch tap. Pure/deterministic (fake time).
 */
describe('SamplerLoopClock — live phase provider (bug fixes 1–3)', () => {
  /**
   * Drive the clock with a provider over a mutable `phaseRef` box. `at(t, fn)` mutates the
   * box once when the fake clock first reaches time `t` (a live tempo/run change mid-run).
   */
  function run(
    phaseBox: { phase: PhaseRef },
    untilS: number,
    setup: (clock: SamplerLoopClock) => void,
    schedule: { t: number; fn: () => void }[] = [],
  ): TransportEvent[] {
    let now = 0;
    const out: TransportEvent[] = [];
    const clock = new SamplerLoopClock();
    clock.setPhaseProvider(() => phaseBox.phase);
    const sched = new Scheduler(() => now, 0.1);
    sched.add(clock, (e) => out.push(e));
    const pending = [...schedule];
    setup(clock);
    while (now < untilS) {
      while (pending.length && now >= pending[0]!.t) pending.shift()!.fn();
      sched.pump();
      now += 0.025;
    }
    return out.filter((e) => e.time <= untilS);
  }

  it('Finding 1: a live tempo change re-spaces FUTURE re-launches to the NEW barPeriodS', () => {
    // launch a 1-BAR loop at 120 BPM (bar = 2.0 s), then at t=4.5 s drop to 80 BPM
    // (bar = 3.0 s) THROUGH THE PROVIDER (no re-tap). Re-launches after the change must
    // be spaced by the NEW 3.0 s bar, not the stale 2.0 s the launch tap captured.
    const slow = runningPhase(0, 80); // 16th = 0.1875 s -> bar 3.0 s
    const box = { phase: runningPhase(0, 120) }; // bar 2.0 s at launch
    const out = run(
      box,
      16.0 - 1e-9,
      (c) => c.requestLaunch(0, nextBoundary(0.1, '1 BAR', box.phase), box.phase), // start 2.0
      [{ t: 4.5, fn: () => (box.phase = slow) }],
    );
    const launches = [...padTimes(out, 'loopStart', 0), ...padTimes(out, 'loopRelaunch', 0)].sort(
      (a, b) => a - b,
    );
    // before the change: 120-BPM bars at 2.0, 4.0 (spacing 2.0)
    expect(launches[0]).toBeCloseTo(2.0, 9);
    expect(launches[1]).toBeCloseTo(4.0, 9);
    // after the change (>4.5): every consecutive gap is the NEW 80-BPM bar (3.0 s)
    const newBar = barPeriodS(slow);
    expect(newBar).toBeCloseTo(3.0, 9);
    const afterChange = launches.filter((t) => t > 4.5);
    expect(afterChange.length).toBeGreaterThanOrEqual(3); // several bars sampled
    for (let i = 1; i < afterChange.length; i++) {
      expect(afterChange[i]! - afterChange[i - 1]!).toBeCloseTo(newBar, 6);
    }
  });

  it('Finding 2: a stopped-launched loop reseeds onto the bar grid when the master starts', () => {
    // tap-launch while the master is STOPPED: the loop sounds immediately (afterTime) but
    // NO bar-grid re-launch fires (native source.loop covers continuity). When the master
    // later RUNS (provider flips to running, no re-tap), the loop must re-seat onto the
    // live bar grid and resume per-bar re-launch — the "bulletproof sync" guarantee.
    const running = runningPhase(0, 120); // bar 2.0 s, downbeats at 0,2,4,...
    const box = { phase: stoppedPhase(120) };
    const out = run(
      box,
      14.0 - 1e-9,
      (c) => {
        const target = nextBoundary(0.5, '1 BAR', box.phase); // == 0.5 (immediate, stopped)
        c.requestLaunch(0, target, box.phase);
      },
      [{ t: 5.0, fn: () => (box.phase = running) }], // master starts at 5.0
    );
    expect(padTimes(out, 'loopStart', 0)).toHaveLength(1); // launched immediately
    // NO re-launch fired during the stopped window (before the master started)
    const beforeStart = padTimes(out, 'loopRelaunch', 0).filter((t) => t <= 5.0);
    expect(beforeStart).toHaveLength(0);
    // after the master starts, re-launches resume ON the running bar grid (downbeats:
    // first boundary at/after 5.0 is 6.0, so re-launches land at 8.0, 10.0, 12.0...)
    const afterStart = padTimes(out, 'loopRelaunch', 0).filter((t) => t > 5.0);
    expect(afterStart.length).toBeGreaterThanOrEqual(3);
    const bar = barPeriodS(running);
    for (const t of afterStart) {
      const k = (t - running.anchorTime) / bar;
      expect(k).toBeCloseTo(Math.round(k), 6); // every re-launch sits on a master bar downbeat
    }
    expect(afterStart[0]).toBeCloseTo(8.0, 6); // origin 6.0 + 1 bar
  });

  it('phase-lock across a live tempo change: every subsequent re-launch lands on the master LIVE bar lattice', () => {
    // launch a 1-BAR loop at 120 BPM (bar 2.0 s, lattice on 0,2,4,...), let it re-launch a few
    // bars, then at t≈4.6 s switch THROUGH THE PROVIDER to 90 BPM with a master-consistent,
    // PHASE-SHIFTED anchorTime (the way monarchseq.phaseRef() re-derives the downbeat at the change
    // boundary: anchorTime = baseTime − (tickCount%16)*newSixteenth, generally NOT aligned with
    // the old 120-BPM bar grid). The master bar lattice shifts phase; without the re-anchor fix
    // the frozen firstLaunchTime holds the OLD phase and every later re-launch sits a constant
    // sub-bar OFFSET off the live master lattice.
    const sixteenth90 = monarchStepDurS(90);
    const shifted: PhaseRef = {
      running: true,
      tempoBpm: 90,
      anchorTime: 0.41 * (16 * sixteenth90), // a deliberately off-grid bar downbeat
      sixteenthDurS: sixteenth90,
    };
    const box = { phase: runningPhase(0, 120) }; // bar 2.0 s at launch
    const out = run(
      box,
      18.0 - 1e-9,
      (c) => c.requestLaunch(0, nextBoundary(0.1, '1 BAR', box.phase), box.phase), // start 2.0
      [{ t: 4.6, fn: () => (box.phase = shifted) }],
    );
    const launches = [...padTimes(out, 'loopStart', 0), ...padTimes(out, 'loopRelaunch', 0)].sort(
      (a, b) => a - b,
    );
    // every re-launch at or after the change must sit on the master's LIVE bar lattice:
    // (T − anchorTime) / barPeriodS is within 1e-6 of an integer.
    const phase = box.phase;
    const bar = barPeriodS(phase);
    const afterChange = launches.filter((t) => t > 4.6);
    expect(afterChange.length).toBeGreaterThanOrEqual(3); // several bars sampled past the change
    for (const t of afterChange) {
      const k = (t - phase.anchorTime) / bar;
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6);
    }
  });

  it('Finding 3: stopping the master halts all further re-launch from the next pump', () => {
    // launch a 1-BAR loop with a RUNNING master, let it re-launch a couple bars, then STOP
    // the master through the provider (STOP ALL flips running false — no re-tap). The clock
    // must stop firing loopRelaunch (no re-chopping the held voice on a stale grid) and
    // settle to nextEventTime === Infinity.
    const box = { phase: runningPhase(0, 120) }; // bar 2.0 s
    let idleAtInfinity = false;
    let now = 0;
    const out: TransportEvent[] = [];
    const clock = new SamplerLoopClock();
    clock.setPhaseProvider(() => box.phase);
    const sched = new Scheduler(() => now, 0.1);
    sched.add(clock, (e) => out.push(e));
    clock.requestLaunch(0, nextBoundary(0.1, '1 BAR', box.phase), box.phase); // start 2.0
    while (now < 12.0) {
      if (now >= 5.0 && box.phase.running) box.phase = stoppedPhase(120); // STOP at 5.0
      sched.pump();
      if (now >= 5.5) idleAtInfinity = clock.nextEventTime === Infinity; // settled after the stop
      now += 0.025;
    }
    const relaunches = padTimes(out, 'loopRelaunch', 0);
    // re-launches before the stop happened (2.0->4.0 grid), but NONE at or after the stop
    expect(relaunches.some((t) => t < 5.0)).toBe(true);
    expect(relaunches.filter((t) => t >= 5.0)).toHaveLength(0);
    expect(idleAtInfinity).toBe(true);
  });
});
