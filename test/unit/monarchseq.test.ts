import { describe, expect, it } from 'vitest';
import { MonarchSequencer } from '../../src/engine/sequencers/monarchseq';
import { Scheduler, type TransportEvent } from '../../src/engine/scheduler';

/** Run the sequencer through the real scheduler with fake time, collecting events. */
function collect(seq: MonarchSequencer, untilS: number, startAt = 0): TransportEvent[] {
  let now = 0;
  const out: TransportEvent[] = [];
  const sched = new Scheduler(() => now, 0.1);
  sched.add(seq, (e) => out.push(e));
  seq.start(startAt);
  while (now < untilS) {
    sched.pump();
    now += 0.025;
  }
  return out.filter((e) => e.time <= untilS);
}

const times = (evs: TransportEvent[], type: string) => evs.filter((e) => e.type === type).map((e) => e.time);

describe('Monarch sequencer (work order §9.2)', () => {
  it('16 steps at 120 BPM: gates land exactly on the 16th grid', () => {
    const seq = new MonarchSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 16;
    const evs = collect(seq, 2.0 - 1e-9);
    const ons = times(evs, 'gateOn');
    expect(ons).toHaveLength(16);
    ons.forEach((t, k) => expect(t).toBeCloseTo(k * 0.125, 10));
    // default gate length 0.5 -> offs at on + 62.5 ms
    const offs = times(evs, 'gateOff');
    offs.forEach((t, k) => expect(t).toBeCloseTo(k * 0.125 + 0.0625, 10));
  });

  it('swing offsets every 2nd sixteenth by (swing-50)/50 x 0.5 x stepDur', () => {
    const seq = new MonarchSequencer();
    seq.tempoBpm = 120;
    seq.swingPct = 75;
    seq.endStep = 8;
    const evs = collect(seq, 1.0 - 1e-9);
    const ons = times(evs, 'gateOn');
    const expectedSwing = ((75 - 50) / 50) * 0.5 * 0.125; // 15.625 ms
    ons.forEach((t, k) => {
      const base = k * 0.125;
      expect(t).toBeCloseTo(k % 2 === 1 ? base + expectedSwing : base, 10);
    });
  });

  it('ratchet subdivides the step into N gates at gateLength / N', () => {
    const seq = new MonarchSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 1;
    seq.steps[0]!.ratchet = 3;
    seq.steps[0]!.gateLength = 0.6;
    const evs = collect(seq, 0.125 - 1e-9);
    const ons = times(evs, 'gateOn');
    const offs = times(evs, 'gateOff');
    expect(ons).toHaveLength(3);
    const sub = 0.125 / 3;
    ons.forEach((t, r) => expect(t).toBeCloseTo(r * sub, 10));
    offs.forEach((t, r) => expect(t).toBeCloseTo(r * sub + 0.6 * sub, 10));
  });

  it('tie (gateLength 1.0): no gate-off, next step does not retrigger', () => {
    const seq = new MonarchSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 3;
    seq.steps[0]!.gateLength = 1.0; // tie into step 2
    seq.steps[1]!.gateLength = 0.5;
    const evs = collect(seq, 0.375 - 1e-9);
    const ons = times(evs, 'gateOn');
    const offs = times(evs, 'gateOff');
    // step 1 gates on; step 2 must NOT re-gate (tied); step 3 gates normally
    expect(ons).toHaveLength(2);
    expect(ons[0]).toBeCloseTo(0, 10);
    expect(ons[1]).toBeCloseTo(0.25, 10);
    // the tied note's gate-off comes from step 2's gate length
    expect(offs[0]).toBeCloseTo(0.125 + 0.5 * 0.125, 10);
  });

  it('rest: no gate, no pitch event (CV holds)', () => {
    const seq = new MonarchSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 2;
    seq.steps[1]!.rest = true;
    const evs = collect(seq, 0.25 - 1e-9);
    expect(times(evs, 'gateOn')).toHaveLength(1);
    expect(times(evs, 'pitch')).toHaveLength(1);
    // but the step marker and assign clock still fire on rests
    expect(times(evs, 'step')).toHaveLength(2);
    expect(times(evs, 'assignPulse')).toHaveLength(2);
  });

  it('accent rides the gate and emits accentOn/Off', () => {
    const seq = new MonarchSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 2;
    seq.steps[0]!.accent = true;
    const evs = collect(seq, 0.25 - 1e-9);
    expect(times(evs, 'accentOn')).toHaveLength(1);
    expect(times(evs, 'accentOff')[0]).toBeCloseTo(0.0625, 10);
    const firstGate = evs.find((e) => e.type === 'gateOn')!;
    expect(firstGate.data?.['accent']).toBe(true);
  });

  it('hold repeats the current step; reset returns to step 1', () => {
    // pure transport semantics — drive pullEventsAt/advance directly
    const seq = new MonarchSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 8;
    for (let i = 0; i < 8; i++) seq.steps[i]!.noteVv = i;
    seq.start(0);
    const pitchAt = () => {
      const evs = seq.pullEventsAt(seq.nextEventTime);
      seq.advance();
      return evs.find((e) => e.type === 'pitch')?.data?.['noteVv'];
    };
    expect(pitchAt()).toBe(0);
    expect(pitchAt()).toBe(1);
    seq.holdActive = true; // HOLD: repeat current step at tempo
    expect(pitchAt()).toBe(2);
    expect(pitchAt()).toBe(2);
    expect(pitchAt()).toBe(2);
    seq.holdActive = false;
    expect(pitchAt()).toBe(2);
    expect(pitchAt()).toBe(3);
    seq.reset(); // RESET: back to step 1
    expect(pitchAt()).toBe(0);
  });

  it('tempo change takes effect from the next boundary', () => {
    const seq = new MonarchSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 32;
    let now = 0;
    const out: TransportEvent[] = [];
    const sched = new Scheduler(() => now, 0.05);
    sched.add(seq, (e) => out.push(e));
    seq.start(0);
    sched.pump(); // schedules ~2 boundaries
    seq.tempoBpm = 240; // halve the step duration
    while (now < 0.6) {
      now += 0.025;
      sched.pump();
    }
    const ons = times(out, 'gateOn');
    const deltas = ons.slice(1).map((t, i) => t - ons[i]!);
    // early deltas at 125 ms, later ones at 62.5 ms — and nothing in between
    expect(deltas[0]).toBeCloseTo(0.125, 6);
    expect(deltas[deltas.length - 1]).toBeCloseTo(0.0625, 6);
    for (const d of deltas) {
      expect(Math.min(Math.abs(d - 0.125), Math.abs(d - 0.0625))).toBeLessThan(1e-9);
    }
  });

  it('scheduler drops stale events after a throttled-tab gap (no burst)', () => {
    const seq = new MonarchSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 32;
    let now = 0;
    const out: TransportEvent[] = [];
    const sched = new Scheduler(() => now, 0.1);
    sched.add(seq, (e) => out.push(e));
    seq.start(0);
    sched.pump();
    const scheduledBeforeGap = out.length;
    now = 5.0; // tab throttled for 5 seconds
    sched.pump();
    expect(sched.starvationCount).toBe(1);
    // no event between the gap start and `now` was scheduled retroactively
    const stale = out.slice(scheduledBeforeGap).filter((e) => e.time < 5.0);
    expect(stale).toHaveLength(0);
    // and scheduling resumes on-grid relative to the original phase
    const next = out.slice(scheduledBeforeGap).find((e) => e.type === 'gateOn');
    expect(next!.time % 0.125).toBeCloseTo(0, 6);
  });

  it('endStep wraps the pattern', () => {
    const seq = new MonarchSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 3;
    const evs = collect(seq, 0.75 - 1e-9);
    const stepIdx = evs.filter((e) => e.type === 'step').map((e) => e.data?.['stepIndex']);
    expect(stepIdx).toEqual([0, 1, 2, 0, 1, 2]);
  });
});

/**
 * External TEMPO clock (MON_TEMPO IN — the Monarch "Single Clock Advance" default). Each rising
 * edge fires the current step then advances; the internal clock is suppressed.
 */
describe('Monarch external clock (MON_TEMPO IN)', () => {
  it('pullEventsAt returns nothing while externalClock (internal clock suppressed)', () => {
    const seq = new MonarchSequencer();
    seq.externalClock = true;
    seq.start(0);
    expect(seq.pullEventsAt(0)).toEqual([]);
    seq.advance();
    expect(seq.nextEventTime).toBe(Infinity); // never self-scheduled
  });

  it('one edge = one step, in order; step markers wrap at endStep', () => {
    const seq = new MonarchSequencer();
    seq.externalClock = true;
    seq.endStep = 3;
    const steps: number[] = [];
    for (let i = 0; i < 6; i++) {
      const evs = seq.onExternalEdge(i * 0.2, 0.2);
      steps.push(evs.find((e) => e.type === 'step')!.data!['stepIndex'] as number);
    }
    expect(steps).toEqual([0, 1, 2, 0, 1, 2]);
  });

  it('ratchet sub-gates space by the MEASURED external interval, not the internal step duration', () => {
    const seq = new MonarchSequencer();
    seq.tempoBpm = 120; // internal stepDur 0.125 — must NOT be used while externally clocked
    seq.externalClock = true;
    seq.endStep = 1;
    seq.steps[0]!.ratchet = 2;
    seq.steps[0]!.gateLength = 0.5;
    const interval = 0.4;
    const ons = seq.onExternalEdge(1.0, interval).filter((e) => e.type === 'gateOn').map((e) => e.time);
    expect(ons).toHaveLength(2);
    expect(ons[0]).toBeCloseTo(1.0, 10);
    expect(ons[1]).toBeCloseTo(1.0 + interval / 2, 10); // half the EXTERNAL interval, not 0.125/2
  });

  it('tie across two edges emits no second gateOn', () => {
    const seq = new MonarchSequencer();
    seq.externalClock = true;
    seq.endStep = 2;
    seq.steps[0]!.gateLength = 1.0; // tie into step 2
    seq.steps[1]!.gateLength = 0.5;
    const a = seq.onExternalEdge(0, 0.25);
    const b = seq.onExternalEdge(0.25, 0.25);
    expect(a.filter((e) => e.type === 'gateOn')).toHaveLength(1);
    expect(b.filter((e) => e.type === 'gateOn')).toHaveLength(0);
  });

  it('HOLD re-fires the current step on each edge', () => {
    const seq = new MonarchSequencer();
    seq.externalClock = true;
    seq.endStep = 8;
    for (let i = 0; i < 8; i++) seq.steps[i]!.noteVv = i;
    seq.onExternalEdge(0, 0.2); // step 0
    seq.onExternalEdge(0.2, 0.2); // step 1
    seq.holdActive = true;
    const p2 = seq.onExternalEdge(0.4, 0.2).find((e) => e.type === 'pitch')!.data!['noteVv'];
    const p3 = seq.onExternalEdge(0.6, 0.2).find((e) => e.type === 'pitch')!.data!['noteVv'];
    expect(p2).toBe(2);
    expect(p3).toBe(2);
  });

  it('resumeInternal re-anchors the clock to now (unplug-while-running recovery)', () => {
    const seq = new MonarchSequencer();
    seq.externalClock = true;
    seq.start(0);
    seq.advance(); // external → nextEventTime Infinity
    expect(seq.nextEventTime).toBe(Infinity);
    seq.externalClock = false;
    seq.resumeInternal(3.0);
    expect(seq.nextEventTime).toBe(3.0); // lookahead clock resumes instead of freezing
  });
});

/**
 * phaseRef() — the master bar/beat phase source for the sampler quantize grid
 * (loop-quantize feature). Pure read; purely additive — the 10 tests above stay green.
 * The anchorTime invariant is the highest-leverage property of the whole feature.
 */
describe('Monarch phaseRef (sampler quantize grid)', () => {
  it('reports run state + the 16th-note duration for the current BPM', () => {
    const seq = new MonarchSequencer();
    seq.tempoBpm = 120;
    expect(seq.phaseRef().running).toBe(false); // not started
    seq.start(0);
    const p = seq.phaseRef();
    expect(p.running).toBe(true);
    expect(p.tempoBpm).toBe(120);
    expect(p.sixteenthDurS).toBeCloseTo(0.125, 12); // 60/120/4
  });

  it('anchorTime stays pinned to the bar downbeat across one bar, then jumps by a full bar', () => {
    const seq = new MonarchSequencer();
    seq.tempoBpm = 120; // 16th = 0.125 s, bar = 2.0 s
    seq.endStep = 32; // long pattern so no wrap interferes inside the bar
    seq.start(0);
    // Right after start(), tickCount=0 -> anchor at the downbeat (0).
    expect(seq.phaseRef().anchorTime).toBeCloseTo(0, 12);
    // Advance through the 16 sixteenths of bar 0: anchor is INVARIANT at the downbeat.
    for (let tick = 1; tick <= 15; tick++) {
      seq.pullEventsAt(seq.nextEventTime);
      seq.advance();
      expect(seq.phaseRef().anchorTime, `tick ${tick}`).toBeCloseTo(0, 10);
    }
    // The 16th advance crosses into bar 1: anchor jumps by exactly one bar (16 * 0.125).
    seq.pullEventsAt(seq.nextEventTime);
    seq.advance();
    expect(seq.phaseRef().anchorTime).toBeCloseTo(2.0, 10);
  });

  it('anchorTime is swing-immune: identical at swing 50 vs swing 75 for the same tick', () => {
    const make = (swing: number): number => {
      const seq = new MonarchSequencer();
      seq.tempoBpm = 120;
      seq.endStep = 32;
      seq.swingPct = swing;
      seq.start(0);
      // advance a few odd/even ticks so the swing offset is in play on nextEventTime
      for (let i = 0; i < 5; i++) {
        seq.pullEventsAt(seq.nextEventTime);
        seq.advance();
      }
      return seq.phaseRef().anchorTime;
    };
    // anchor derives from the un-swung baseTime, so swing cannot move the grid.
    expect(make(75)).toBeCloseTo(make(50), 12);
  });

  it('bar grid keeps moving under HOLD (tickCount advances even when stepIndex is frozen)', () => {
    const seq = new MonarchSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 4;
    seq.start(0);
    seq.holdActive = true; // freezes stepIndex, NOT tickCount
    for (let i = 0; i < 16; i++) {
      seq.pullEventsAt(seq.nextEventTime);
      seq.advance();
    }
    // 16 ticks under HOLD still cross a full bar — anchor advanced one bar.
    expect(seq.phaseRef().anchorTime).toBeCloseTo(2.0, 10);
  });
});
