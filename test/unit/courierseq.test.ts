import { describe, expect, it } from 'vitest';
import {
  CourierSequencer,
  COURIER_CLOCK_DIVS,
  courierStepDurS,
  defaultCourierStep,
} from '../../src/engine/sequencers/courierSeq';
import { Scheduler, type TransportEvent } from '../../src/engine/scheduler';

/** Run the sequencer through the real scheduler with fake time, collecting events. */
function collect(seq: CourierSequencer, untilS: number, startAt = 0): TransportEvent[] {
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

const times = (evs: TransportEvent[], type: string) =>
  evs.filter((e) => e.type === type).map((e) => e.time);

describe('courierStepDurS / COURIER_CLOCK_DIVS', () => {
  it('1/16 (idx 3) is the base 16th duration', () => {
    expect(courierStepDurS(120, 3)).toBeCloseTo(0.125, 12); // 60/120/4
  });
  it('1/8 doubles, 1/32 halves, 1/4 quadruples', () => {
    expect(courierStepDurS(120, 1)).toBeCloseTo(0.25, 12); // 1/8
    expect(courierStepDurS(120, 5)).toBeCloseTo(0.0625, 12); // 1/32
    expect(courierStepDurS(120, 0)).toBeCloseTo(0.5, 12); // 1/4
  });
  it('1/8T = base * 4/3, 1/16T = base * 2/3', () => {
    expect(courierStepDurS(120, 2)).toBeCloseTo(0.125 * (4 / 3), 12);
    expect(courierStepDurS(120, 4)).toBeCloseTo(0.125 * (2 / 3), 12);
  });
  it('clamps an out-of-range div index into the table', () => {
    expect(courierStepDurS(120, -5)).toBe(courierStepDurS(120, 0));
    expect(courierStepDurS(120, 99)).toBe(courierStepDurS(120, COURIER_CLOCK_DIVS.length - 1));
  });
  it('div list + multipliers match the contract', () => {
    expect(COURIER_CLOCK_DIVS).toEqual(['1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32']);
  });
});

describe('defaultCourierStep', () => {
  it('is an unauthored, half-gate, non-rest step with a null lock', () => {
    expect(defaultCourierStep()).toEqual({
      noteVv: -1,
      gateLength: 0.5,
      rest: false,
      glide: false,
      lock: null,
    });
  });
});

describe('Courier sequencer — grid + gate', () => {
  it('16 steps at 120 BPM / 1/16: gates land exactly on the 16th grid', () => {
    const seq = new CourierSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 16;
    for (let i = 0; i < 16; i++) seq.steps[i]!.noteVv = 0;
    const evs = collect(seq, 2.0 - 1e-9);
    const ons = times(evs, 'gateOn');
    expect(ons).toHaveLength(16);
    ons.forEach((t, k) => expect(t).toBeCloseTo(k * 0.125, 10));
    // default gate length 0.5 -> offs at on + 62.5 ms
    const offs = times(evs, 'gateOff');
    offs.forEach((t, k) => expect(t).toBeCloseTo(k * 0.125 + 0.0625, 10));
  });

  it('emits a step marker every step (LED chase), even on rests', () => {
    const seq = new CourierSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 2;
    seq.steps[0]!.noteVv = 0;
    seq.steps[1]!.rest = true;
    const evs = collect(seq, 0.25 - 1e-9);
    expect(times(evs, 'step')).toHaveLength(2);
    expect(times(evs, 'gateOn')).toHaveLength(1); // rest has no gate
    expect(times(evs, 'pitch')).toHaveLength(1); // rest has no pitch
  });

  it('an unauthored step (noteVv -1) still gates but does not crash; pitch carries -1', () => {
    const seq = new CourierSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 1;
    const evs = collect(seq, 0.125 - 1e-9);
    const pitch = evs.find((e) => e.type === 'pitch');
    expect(pitch!.data!['noteVv']).toBe(-1); // -1 (unauthored) + transpose 0
    expect(times(evs, 'gateOn')).toHaveLength(1);
  });
});

describe('Courier sequencer — clock divider timing', () => {
  it('1/8 division doubles the step duration (grid at k*0.25)', () => {
    const seq = new CourierSequencer();
    seq.tempoBpm = 120;
    seq.clockDivIdx = 1; // 1/8
    seq.endStep = 4;
    for (let i = 0; i < 4; i++) seq.steps[i]!.noteVv = 0;
    const evs = collect(seq, 1.0 - 1e-9);
    const ons = times(evs, 'gateOn');
    expect(ons).toHaveLength(4);
    ons.forEach((t, k) => expect(t).toBeCloseTo(k * 0.25, 10));
  });

  it('1/32 division halves the step duration (grid at k*0.0625)', () => {
    const seq = new CourierSequencer();
    seq.tempoBpm = 120;
    seq.clockDivIdx = 5; // 1/32
    seq.endStep = 4;
    for (let i = 0; i < 4; i++) seq.steps[i]!.noteVv = 0;
    const evs = collect(seq, 0.25 - 1e-9);
    const ons = times(evs, 'gateOn');
    expect(ons).toHaveLength(4);
    ons.forEach((t, k) => expect(t).toBeCloseTo(k * 0.0625, 10));
  });

  it('1/8T division spaces steps by base*4/3', () => {
    const seq = new CourierSequencer();
    seq.tempoBpm = 120;
    seq.clockDivIdx = 2; // 1/8T
    seq.endStep = 3;
    for (let i = 0; i < 3; i++) seq.steps[i]!.noteVv = 0;
    const dur = 0.125 * (4 / 3);
    const evs = collect(seq, 3 * dur - 1e-9);
    const ons = times(evs, 'gateOn');
    expect(ons).toHaveLength(3);
    ons.forEach((t, k) => expect(t).toBeCloseTo(k * dur, 10));
  });
});

describe('Courier sequencer — swing / tie / rest / length', () => {
  it('swing offsets every 2nd step by (swing-50)/50 x 0.5 x stepDur', () => {
    const seq = new CourierSequencer();
    seq.tempoBpm = 120;
    seq.swingPct = 75;
    seq.endStep = 8;
    for (let i = 0; i < 8; i++) seq.steps[i]!.noteVv = 0;
    const evs = collect(seq, 1.0 - 1e-9);
    const ons = times(evs, 'gateOn');
    const expectedSwing = ((75 - 50) / 50) * 0.5 * 0.125; // 15.625 ms
    ons.forEach((t, k) => {
      const base = k * 0.125;
      expect(t).toBeCloseTo(k % 2 === 1 ? base + expectedSwing : base, 10);
    });
  });

  it('tie (gateLength >= 1): no gate-off, next step does not retrigger', () => {
    const seq = new CourierSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 3;
    for (let i = 0; i < 3; i++) seq.steps[i]!.noteVv = 0;
    seq.steps[0]!.gateLength = 1.0; // tie into step 2
    seq.steps[1]!.gateLength = 0.5;
    const evs = collect(seq, 0.375 - 1e-9);
    const ons = times(evs, 'gateOn');
    const offs = times(evs, 'gateOff');
    expect(ons).toHaveLength(2); // step 2 (tied) does NOT re-gate
    expect(ons[0]).toBeCloseTo(0, 10);
    expect(ons[1]).toBeCloseTo(0.25, 10);
    // the tied note's gate-off comes from step 2's gate length
    expect(offs[0]).toBeCloseTo(0.125 + 0.5 * 0.125, 10);
  });

  it('rest emits a step marker but no pitch/gate (CV holds)', () => {
    const seq = new CourierSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 2;
    seq.steps[0]!.noteVv = 0;
    seq.steps[1]!.rest = true;
    seq.steps[1]!.noteVv = 5; // authored but rested
    const evs = collect(seq, 0.25 - 1e-9);
    expect(times(evs, 'gateOn')).toHaveLength(1);
    expect(times(evs, 'pitch')).toHaveLength(1);
    expect(times(evs, 'step')).toHaveLength(2);
  });

  it('endStep wraps the pattern across pages', () => {
    const seq = new CourierSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 3;
    const evs = collect(seq, 0.75 - 1e-9);
    const stepIdx = evs.filter((e) => e.type === 'step').map((e) => e.data!['stepIndex']);
    expect(stepIdx).toEqual([0, 1, 2, 0, 1, 2]);
  });

  it('steps advance in order across a page boundary (15 -> 16 -> 17)', () => {
    const seq = new CourierSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 20;
    const evs = collect(seq, 18 * 0.125 - 1e-9);
    const stepIdx = evs.filter((e) => e.type === 'step').map((e) => e.data!['stepIndex'] as number);
    expect(stepIdx.slice(14, 18)).toEqual([14, 15, 16, 17]);
  });
});

describe('Courier sequencer — gate length scale', () => {
  it('gateLenScale 0.5 halves the gate-off offset', () => {
    const seq = new CourierSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 1;
    seq.steps[0]!.noteVv = 0;
    seq.steps[0]!.gateLength = 0.8;
    seq.gateLenScale = 0.5;
    const evs = collect(seq, 0.125 - 1e-9);
    const off = times(evs, 'gateOff')[0]!;
    expect(off).toBeCloseTo(0.8 * 0.5 * 0.125, 10);
  });

  it('TIE is keyed off the RAW per-step gateLength, not the scaled value', () => {
    const seq = new CourierSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 2;
    for (let i = 0; i < 2; i++) seq.steps[i]!.noteVv = 0;
    seq.steps[0]!.gateLength = 1.0; // raw >= 1 -> tie even though scale would reduce it
    seq.steps[1]!.gateLength = 0.5;
    seq.gateLenScale = 0.5;
    const evs = collect(seq, 0.25 - 1e-9);
    // tie suppresses step-1 gate-off + step-2 retrigger
    expect(times(evs, 'gateOn')).toHaveLength(1);
  });
});

describe('Courier sequencer — transpose', () => {
  it('transposeVv shifts all emitted pitches uniformly', () => {
    const seq = new CourierSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 3;
    seq.steps[0]!.noteVv = 0;
    seq.steps[1]!.noteVv = 1;
    seq.steps[2]!.noteVv = 2;
    seq.transposeVv = 0.5;
    const evs = collect(seq, 0.375 - 1e-9);
    const pitches = evs.filter((e) => e.type === 'pitch').map((e) => e.data!['noteVv']);
    expect(pitches).toEqual([0.5, 1.5, 2.5]);
  });
});

describe('Courier sequencer — HOLD / RESET (direct pull/advance)', () => {
  const pitchAt = (seq: CourierSequencer) => {
    const evs = seq.pullEventsAt(seq.nextEventTime);
    seq.advance();
    return evs.find((e) => e.type === 'pitch')?.data?.['noteVv'];
  };

  it('HOLD repeats the current step; RESET returns to step 1', () => {
    const seq = new CourierSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 8;
    for (let i = 0; i < 8; i++) seq.steps[i]!.noteVv = i;
    seq.start(0);
    expect(pitchAt(seq)).toBe(0);
    expect(pitchAt(seq)).toBe(1);
    seq.holdActive = true;
    expect(pitchAt(seq)).toBe(2);
    expect(pitchAt(seq)).toBe(2);
    expect(pitchAt(seq)).toBe(2);
    seq.holdActive = false;
    expect(pitchAt(seq)).toBe(2);
    expect(pitchAt(seq)).toBe(3);
    seq.reset();
    expect(pitchAt(seq)).toBe(0);
  });

  it('stop() parks nextEventTime at Infinity; start() re-arms from step 1', () => {
    const seq = new CourierSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 4;
    for (let i = 0; i < 4; i++) seq.steps[i]!.noteVv = i;
    seq.start(0);
    pitchAt(seq);
    seq.stop();
    expect(seq.running).toBe(false);
    expect(seq.nextEventTime).toBe(Infinity);
    seq.start(1.0);
    expect(seq.nextEventTime).toBe(1.0);
    expect(pitchAt(seq)).toBe(0); // restarts at step 1
  });
});

describe('Courier sequencer — tempo / scheduler contract', () => {
  it('tempo change takes effect only from the next boundary', () => {
    const seq = new CourierSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 32;
    for (let i = 0; i < 32; i++) seq.steps[i]!.noteVv = 0;
    let now = 0;
    const out: TransportEvent[] = [];
    const sched = new Scheduler(() => now, 0.05);
    sched.add(seq, (e) => out.push(e));
    seq.start(0);
    sched.pump();
    seq.tempoBpm = 240; // halve the step duration
    while (now < 0.6) {
      now += 0.025;
      sched.pump();
    }
    const ons = times(out, 'gateOn');
    const deltas = ons.slice(1).map((t, i) => t - ons[i]!);
    expect(deltas[0]).toBeCloseTo(0.125, 6);
    expect(deltas[deltas.length - 1]).toBeCloseTo(0.0625, 6);
    for (const dd of deltas) {
      expect(Math.min(Math.abs(dd - 0.125), Math.abs(dd - 0.0625))).toBeLessThan(1e-9);
    }
  });

  it('drops stale events after a throttled-tab gap (no burst)', () => {
    const seq = new CourierSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 32;
    for (let i = 0; i < 32; i++) seq.steps[i]!.noteVv = 0;
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
    const stale = out.slice(scheduledBeforeGap).filter((e) => e.time < 5.0);
    expect(stale).toHaveLength(0);
    const next = out.slice(scheduledBeforeGap).find((e) => e.type === 'gateOn');
    expect(next!.time % 0.125).toBeCloseTo(0, 6);
  });

  it('advance() always strictly increases nextEventTime (no "did not advance" throw)', () => {
    const seq = new CourierSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 64;
    seq.start(0);
    let prev = seq.nextEventTime;
    for (let i = 0; i < 200; i++) {
      seq.pullEventsAt(seq.nextEventTime);
      seq.advance();
      expect(seq.nextEventTime).toBeGreaterThan(prev);
      prev = seq.nextEventTime;
    }
  });

  it('no NaN/Infinity in emitted event times or pitches under defaults', () => {
    const seq = new CourierSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 16;
    for (let i = 0; i < 16; i++) seq.steps[i]!.noteVv = i % 12;
    const evs = collect(seq, 2.0 - 1e-9);
    for (const e of evs) {
      expect(Number.isFinite(e.time)).toBe(true);
      const n = e.data?.['noteVv'];
      if (typeof n === 'number') expect(Number.isFinite(n)).toBe(true);
    }
  });
});

describe('Courier sequencer — MVP arpeggiator (OFF / UP / DOWN)', () => {
  /** Author scattered notes [C=0, G=7, E=4] across the first three steps. */
  const armArp = (mode: 'OFF' | 'UP' | 'DOWN') => {
    const seq = new CourierSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 3;
    seq.steps[0]!.noteVv = 0; // C
    seq.steps[1]!.noteVv = 7; // G
    seq.steps[2]!.noteVv = 4; // E
    seq.arpMode = mode;
    return seq;
  };

  const pitchSeq = (seq: CourierSequencer, n: number) => {
    seq.start(0);
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const evs = seq.pullEventsAt(seq.nextEventTime);
      seq.advance();
      const p = evs.find((e) => e.type === 'pitch')?.data?.['noteVv'];
      if (typeof p === 'number') out.push(p);
    }
    return out;
  };

  it('OFF plays the per-step authored notes in order', () => {
    const seq = armArp('OFF');
    expect(pitchSeq(seq, 6)).toEqual([0, 7, 4, 0, 7, 4]);
  });

  it('UP walks the authored notes ascending and wraps', () => {
    const seq = armArp('UP');
    // sorted ascending: [0,4,7]; cursor starts at 0 then increments each step
    expect(pitchSeq(seq, 6)).toEqual([0, 4, 7, 0, 4, 7]);
  });

  it('DOWN walks the authored notes descending and wraps', () => {
    const seq = armArp('DOWN');
    // sorted descending: [7,4,0]
    expect(pitchSeq(seq, 6)).toEqual([7, 4, 0, 7, 4, 0]);
  });

  it('arp with no authored notes in the window emits no pitch (treated as rest)', () => {
    const seq = new CourierSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 3;
    seq.arpMode = 'UP'; // all steps unauthored
    seq.start(0);
    const evs = seq.pullEventsAt(seq.nextEventTime);
    expect(evs.find((e) => e.type === 'pitch')).toBeUndefined();
    expect(evs.find((e) => e.type === 'gateOn')).toBeUndefined();
    expect(evs.find((e) => e.type === 'step')).toBeDefined(); // step marker still fires
  });

  it('rested steps still produce rests under arp (arp only supplies pitch on gated steps)', () => {
    const seq = armArp('UP');
    seq.steps[1]!.rest = true; // middle step rests
    seq.start(0);
    const gatedSteps: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      const evs = seq.pullEventsAt(seq.nextEventTime);
      seq.advance();
      gatedSteps.push(evs.some((e) => e.type === 'gateOn'));
    }
    expect(gatedSteps).toEqual([true, false, true]); // step 1 (rest) has no gate
  });

  it('transpose shifts arp output uniformly', () => {
    const seq = armArp('UP');
    seq.transposeVv = 1; // +1 octave
    expect(pitchSeq(seq, 3)).toEqual([1, 5, 8]);
  });
});
