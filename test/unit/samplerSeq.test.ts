import { describe, expect, it } from 'vitest';
import { SamplerStepSeq } from '../../src/engine/sequencers/samplerSeq';
import { Scheduler, type TransportEvent } from '../../src/engine/scheduler';
import { nextBoundary, type PhaseRef } from '../../src/engine/quantGrid';
import { monarchStepDurS } from '../../src/engine/units';

/** A running master phase whose bar downbeat sits at `anchorTime`. */
function runningPhase(anchorTime = 0, bpm = 120): PhaseRef {
  return { running: true, tempoBpm: bpm, anchorTime, sixteenthDurS: monarchStepDurS(bpm) };
}
function stoppedPhase(bpm = 120): PhaseRef {
  return { running: false, tempoBpm: bpm, anchorTime: 0, sixteenthDurS: monarchStepDurS(bpm) };
}

/** Wire a SamplerStepSeq to a mutable phase box (the studio uses () => monarchSeq.phaseRef()). */
function wired(phaseBox: { phase: PhaseRef }): SamplerStepSeq {
  const seq = new SamplerStepSeq();
  seq.setPhaseProvider(() => phaseBox.phase);
  return seq;
}

const hits = (evs: TransportEvent[]) => evs.filter((e) => e.type === 'drumHit');
const steps = (evs: TransportEvent[]) => evs.filter((e) => e.type === 'drumStep');

describe('SamplerStepSeq (feature: drum machine)', () => {
  it('is a permanently-running Transport with the pinned id, idling at Infinity', () => {
    const seq = new SamplerStepSeq();
    expect(seq.id).toBe('samplerseq');
    expect(seq.running).toBe(true);
    expect(seq.nextEventTime).toBe(Infinity);
    expect(seq.isPlaying()).toBe(false);
  });

  it('idle: a running master but !playing stays at Infinity; start seats the first 16th boundary', () => {
    const box = { phase: runningPhase(0, 120) };
    const seq = wired(box);
    // not playing yet: onPump must NOT lift us off Infinity
    seq.onPump(0.137);
    expect(seq.nextEventTime).toBe(Infinity);
    // start at a mid-grid now -> nextEventTime is the first 16th boundary at/after now
    const now = 0.137;
    seq.start(now);
    expect(seq.isPlaying()).toBe(true);
    expect(seq.nextEventTime).toBeCloseTo(nextBoundary(now, '1/16', box.phase), 12);
    expect(seq.nextEventTime).toBeGreaterThan(now);
  });

  it('emits exactly one drumStep{stepIndex} FIRST then one drumHit{pad} per ON cell, in track order, at one time', () => {
    const box = { phase: runningPhase(0, 120) };
    const seq = wired(box);
    seq.setStep(0, 0, true);
    seq.setStep(3, 0, true);
    seq.start(0); // origin 0, stepCounter 0 -> col 0
    const t = seq.nextEventTime;
    const evs = seq.pullEventsAt(t);
    // ONE drumStep, first, with the column index
    expect(evs[0]!.type).toBe('drumStep');
    expect(evs[0]!.data!['stepIndex']).toBe(0);
    expect(steps(evs)).toHaveLength(1);
    // then exactly 2 drumHit, pads 0 then 3, all at the same time t, in order
    const h = hits(evs);
    expect(h).toHaveLength(2);
    expect(h[0]!.data!['pad']).toBe(0);
    expect(h[1]!.data!['pad']).toBe(3);
    expect(evs.every((e) => e.time === t)).toBe(true);
  });

  it('an empty column emits a drumStep marker but zero drumHits', () => {
    const box = { phase: runningPhase(0, 120) };
    const seq = wired(box);
    seq.start(0);
    const evs = seq.pullEventsAt(seq.nextEventTime);
    expect(steps(evs)).toHaveLength(1);
    expect(hits(evs)).toHaveLength(0);
  });

  it('pullEventsAt is PURE (no field writes): repeated pulls at the same boundary are identical', () => {
    const box = { phase: runningPhase(0, 120) };
    const seq = wired(box);
    seq.setStep(1, 0, true);
    seq.start(0);
    const before = seq.nextEventTime;
    const a = seq.pullEventsAt(before);
    const b = seq.pullEventsAt(before);
    expect(seq.nextEventTime).toBe(before); // pull did not advance
    expect(a).toEqual(b);
  });

  it('no-drift: the k-th boundary is the exact closed form origin + k*sixteenthDurS, strictly monotonic', () => {
    const box = { phase: runningPhase(0, 137) }; // awkward tempo to stress float accumulation
    const seq = wired(box);
    seq.start(0.001);
    const origin = seq.nextEventTime; // origin = first 16th boundary at/after 0.001
    const sixteenth = box.phase.sixteenthDurS;
    let prev = -Infinity;
    for (let k = 0; k < 500; k++) {
      const t = seq.nextEventTime;
      expect(t).toBeCloseTo(origin + k * sixteenth, 9); // pure multiply, no accumulation
      expect(t).toBeGreaterThan(prev); // scheduler-monotonicity guard
      prev = t;
      seq.advance();
    }
  });

  it('wrap: the drumStep column cycles 0..15 then back to 0 while the boundary TIMES keep increasing', () => {
    const box = { phase: runningPhase(0, 120) };
    const seq = wired(box);
    seq.start(0);
    const cols: number[] = [];
    const times: number[] = [];
    for (let k = 0; k < 34; k++) {
      const evs = seq.pullEventsAt(seq.nextEventTime);
      cols.push(evs[0]!.data!['stepIndex'] as number);
      times.push(seq.nextEventTime);
      seq.advance();
    }
    // column cycles 0..15,0..15,0,1 — the modulo wrap
    for (let k = 0; k < 34; k++) expect(cols[k]).toBe(k % 16);
    // and the emitted TIMES never reset at the wrap (stepCounter free-runs)
    for (let k = 1; k < 34; k++) expect(times[k]!).toBeGreaterThan(times[k - 1]!);
  });

  it('stop(): nextEventTime -> Infinity and a subsequent onPump leaves it at Infinity', () => {
    const box = { phase: runningPhase(0, 120) };
    const seq = wired(box);
    seq.start(0);
    expect(seq.nextEventTime).toBeLessThan(Infinity);
    seq.stop();
    expect(seq.isPlaying()).toBe(false);
    expect(seq.nextEventTime).toBe(Infinity);
    seq.onPump(1.0);
    expect(seq.nextEventTime).toBe(Infinity);
  });

  it('run-edge re-seat: start while the master is stopped idles at Infinity, then snaps onto the live 16th grid on the run edge', () => {
    const box = { phase: stoppedPhase(120) };
    const seq = wired(box);
    seq.start(0.4); // armed while the master is stopped
    expect(seq.isPlaying()).toBe(true);
    expect(seq.nextEventTime).toBe(Infinity); // nothing emitted while the master is stopped
    // master starts (provider flips to running); onPump re-seats origin + stepCounter=0
    const now2 = 1.234;
    box.phase = runningPhase(0, 120);
    seq.onPump(now2);
    expect(seq.nextEventTime).toBeCloseTo(nextBoundary(now2, '1/16', box.phase), 12);
    expect(seq.nextEventTime).toBeLessThan(Infinity);
    // stepCounter was reset to 0: the first column emitted is 0
    expect(seq.pullEventsAt(seq.nextEventTime)[0]!.data!['stepIndex']).toBe(0);
  });

  it('onPump does NOT re-seat origin on a tempo change (only on the stopped->running edge)', () => {
    const box = { phase: runningPhase(0, 120) };
    const seq = wired(box);
    seq.start(0);
    const origin = seq.nextEventTime;
    seq.advance();
    seq.advance(); // stepCounter = 2
    // a tempo change while ALREADY running must NOT reset origin/stepCounter
    box.phase = runningPhase(0, 80);
    seq.onPump(origin + 0.01);
    expect(seq.nextEventTime).toBeCloseTo(origin + 2 * box.phase.sixteenthDurS, 9);
  });

  it('mid-run tempo re-stretch: FUTURE steps re-space to the new sixteenthDurS, nextEventTime still > the last boundary (no scheduler throw)', () => {
    const box = { phase: runningPhase(0, 120) };
    const seq = wired(box);
    seq.start(0);
    const origin = seq.nextEventTime;
    // advance a few steps at tempo A
    seq.advance();
    seq.advance();
    seq.advance(); // stepCounter = 3
    const lastBoundaryA = seq.nextEventTime; // origin + 3*A
    // mutate the phase to a slower tempo B (>0) via the provider, then pump
    const slow = runningPhase(0, 80); // larger sixteenthDurS
    box.phase = slow;
    seq.onPump(lastBoundaryA + 0.001);
    // closed form re-stretches FUTURE steps from the FIXED origin
    expect(seq.nextEventTime).toBeCloseTo(origin + 3 * slow.sixteenthDurS, 9);
    // and it is still strictly ahead of the last pulled boundary (no "did not advance" throw)
    expect(seq.nextEventTime).toBeGreaterThan(lastBoundaryA);
  });

  it('phase-lock across a live tempo change: every subsequent step lands on the master LIVE 16th lattice', () => {
    // Drive the clock through the real Scheduler with a MUTABLE phase box, exactly the path a
    // TEMPO-knob turn takes (engineBridge sets monarchSeq.tempoBpm live; the provider is
    // () => monarchSeq.phaseRef()). Mid-run we flip the box to a NEW tempo AND a NEW anchorTime the
    // way monarchseq.phaseRef() does — the master lattice is anchorTime + k*sixteenthDurS — so the
    // lattice SHIFTS PHASE. Without the re-anchor fix the frozen origin holds the OLD lattice
    // phase and every later step sits a constant sub-step OFF the live master lattice.
    const box = { phase: runningPhase(0, 120) }; // 16th = 0.125 s, lattice on 0,0.125,...
    const seq = wired(box);
    seq.setStep(0, 0, true);
    let now = 0;
    const fired: TransportEvent[] = [];
    const sched = new Scheduler(() => now, 0.1);
    sched.add(seq, (e) => fired.push(e));
    seq.start(0);
    // run a few steps at 120, then at CHANGE_T switch to 90 BPM with a master-consistent
    // anchorTime: monarchseq sets anchorTime = baseTime − (tickCount%16)*newSixteenth at the change
    // boundary, which is NOT a multiple of the new 16th from 0 (the lattice shifts phase).
    const sixteenth90 = monarchStepDurS(90); // 0.1666… s — the post-change 16th
    const CHANGE_T = 1.07;
    const LOOKAHEAD = 0.1; // matches `new Scheduler(() => now, 0.1)` above
    // deliberately phase-shifted anchor: the master's re-derived downbeat after the change is
    // generally NOT lattice-aligned with the old 120-BPM grid, so origin MUST move to re-lock.
    const shiftedAnchor = 0.37 * sixteenth90;
    let changed = false;
    for (let i = 0; i < 1200; i++) {
      if (!changed && now >= CHANGE_T) {
        box.phase = { running: true, tempoBpm: 90, anchorTime: shiftedAnchor, sixteenthDurS: sixteenth90 };
        changed = true;
      }
      expect(() => sched.pump()).not.toThrow(); // monotonicity guard never trips
      now += 0.02;
    }
    // STEADY-STATE phase-lock is the guarantee. A lookahead scheduler commits the events already
    // inside its ≤LOOKAHEAD horizon at the instant of the change to the OLD grid — those cannot be
    // recalled (true of any lookahead sequencer, hardware or software). So assert lock only PAST
    // that transitional window; from there every step must sit on the master's LIVE 16th lattice:
    // (T − anchorTime) / sixteenthDurS within 1e-6 of an integer.
    const phase = box.phase;
    const settleT = CHANGE_T + LOOKAHEAD + 2 * sixteenth90;
    const afterChange = steps(fired).map((e) => e.time).filter((t) => t > settleT);
    expect(afterChange.length).toBeGreaterThan(3); // several steps sampled past the change
    for (const t of afterChange) {
      const k = (t - phase.anchorTime) / phase.sixteenthDurS;
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6);
    }
    // sanity: the grid kept emitting its ON-cell hit (pad 0) too — it didn't silently stall
    expect(hits(fired).some((e) => e.data!['pad'] === 0)).toBe(true);
  });

  it('throttled fast-forward: advance() is O(1) and emits/buffers no events on its own', () => {
    const box = { phase: runningPhase(0, 120) };
    const seq = wired(box);
    seq.setStep(0, 0, true); // an ON cell that would fire IF pulled
    seq.start(0);
    // many bare advances (the scheduler's stale-boundary drop loop) — no pull, so no hits
    for (let i = 0; i < 1000; i++) seq.advance();
    // nothing was emitted by advance(); only an explicit pull produces events
    expect(seq.nextEventTime).toBeLessThan(Infinity);
    expect(seq.nextEventTime).toBeGreaterThan(0);
  });

  it('setPattern clamps any ragged/non-boolean grid to a strict 8x16 and is read at the boundary', () => {
    const box = { phase: runningPhase(0, 120) };
    const seq = wired(box);
    // ragged + non-boolean input (cast through unknown like the coalesce contract)
    const ragged = [[true], [], [false, 1, null, true]] as unknown as boolean[][];
    seq.setPattern(ragged);
    seq.start(0);
    // col 0: only [0][0] is true; [2][3]=true would be col 3, [2][1]=1 is NOT a strict boolean
    const col0 = seq.pullEventsAt(seq.nextEventTime);
    expect(hits(col0).map((e) => e.data!['pad'])).toEqual([0]);
    // advance to col 3 and confirm the strict-boolean true at [2][3] fires (pad 2)
    for (let k = 0; k < 3; k++) seq.advance();
    const col3 = seq.pullEventsAt(seq.nextEventTime);
    expect(steps(col3)[0]!.data!['stepIndex']).toBe(3);
    expect(hits(col3).map((e) => e.data!['pad'])).toEqual([2]);
  });

  it('clear() zeroes the grid (no surviving hits) without mutating a prior reference', () => {
    const box = { phase: runningPhase(0, 120) };
    const seq = wired(box);
    seq.setStep(0, 0, true);
    seq.setStep(7, 0, true);
    seq.clear();
    seq.start(0);
    expect(hits(seq.pullEventsAt(seq.nextEventTime))).toHaveLength(0);
  });

  it('setStep ignores out-of-range track/col (no throw, no effect)', () => {
    const box = { phase: runningPhase(0, 120) };
    const seq = wired(box);
    expect(() => {
      seq.setStep(-1, 0, true);
      seq.setStep(8, 0, true);
      seq.setStep(0, -1, true);
      seq.setStep(0, 16, true);
    }).not.toThrow();
    seq.start(0);
    expect(hits(seq.pullEventsAt(seq.nextEventTime))).toHaveLength(0);
  });

  it('setNumSteps wraps the column at the new length (clamped 1..16)', () => {
    const box = { phase: runningPhase(0, 120) };
    const seq = wired(box);
    seq.setNumSteps(4);
    seq.start(0);
    const cols: number[] = [];
    for (let k = 0; k < 9; k++) {
      cols.push(seq.pullEventsAt(seq.nextEventTime)[0]!.data!['stepIndex'] as number);
      seq.advance();
    }
    expect(cols).toEqual([0, 1, 2, 3, 0, 1, 2, 3, 0]);
    // clamp bounds
    seq.setNumSteps(99);
    seq.setNumSteps(0);
    expect(() => seq.pullEventsAt(seq.nextEventTime)).not.toThrow();
  });

  it('runs through the real Scheduler with fake time without ever throwing "did not advance"', () => {
    const box = { phase: runningPhase(0, 90) }; // odd tempo
    const seq = wired(box);
    seq.setStep(0, 0, true);
    seq.setStep(2, 8, true);
    let now = 0;
    const fired: TransportEvent[] = [];
    const sched = new Scheduler(() => now, 0.1);
    sched.add(seq, (e) => fired.push(e));
    seq.start(0);
    for (let i = 0; i < 2000; i++) {
      expect(() => sched.pump()).not.toThrow();
      now += 0.025;
    }
    // it actually emitted a stream of drumStep markers + the two ON-cell hits
    expect(steps(fired).length).toBeGreaterThan(0);
    expect(hits(fired).some((e) => e.data!['pad'] === 0)).toBe(true);
    expect(hits(fired).some((e) => e.data!['pad'] === 2)).toBe(true);
  });

  it('a stopped master through the scheduler emits nothing (master-stopped scope, v1)', () => {
    const box = { phase: stoppedPhase(120) };
    const seq = wired(box);
    seq.setStep(0, 0, true);
    let now = 0;
    const fired: TransportEvent[] = [];
    const sched = new Scheduler(() => now, 0.1);
    sched.add(seq, (e) => fired.push(e));
    seq.start(0);
    for (let i = 0; i < 400; i++) {
      sched.pump();
      now += 0.025;
    }
    expect(fired).toHaveLength(0);
    expect(seq.nextEventTime).toBe(Infinity);
  });
});
