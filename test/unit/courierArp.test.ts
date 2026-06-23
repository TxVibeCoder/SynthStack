import { describe, expect, it } from 'vitest';
import {
  CourierSequencer,
  type CourierArpMode,
  courierStepDurS,
} from '../../src/engine/sequencers/courierSeq';
import { Scheduler, type TransportEvent } from '../../src/engine/scheduler';

// ---------------------------------------------------------------------------
// Full arpeggiator: 13 patterns + octave span (1..4) + programmable rhythm.
// All assertions are EXACT pitch arrays — the arp is fully deterministic (the
// traversal is baked into arpList(); RANDOM/RANDOM_WALK use the seeded mulberry32
// stream, reseeded on start()). These arrays are the engine's actual output.
// ---------------------------------------------------------------------------

/** Author scattered notes across the first three steps. Default authored order = [C=0, G=7, E=4]
 *  so AS_PLAYED (insertion order) is observably different from the sorted [0,4,7]. */
const armArp = (
  mode: CourierArpMode,
  opts: { oct?: number; seed?: number; notes?: number[] } = {},
) => {
  const seq = new CourierSequencer();
  seq.tempoBpm = 120;
  seq.endStep = 3;
  const notes = opts.notes ?? [0, 7, 4];
  seq.steps[0]!.noteVv = notes[0]!;
  seq.steps[1]!.noteVv = notes[1]!;
  seq.steps[2]!.noteVv = notes[2]!;
  seq.arpMode = mode;
  if (opts.oct != null) seq.arpOctave = opts.oct;
  if (opts.seed != null) seq.seed = opts.seed;
  return seq;
};

/** pull/advance n times; collect the single emitted pitch per pass (undefined when none). */
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

/** Run through the real scheduler with fake time, collecting events (mirrors courierseq.test). */
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
const times = (evs: TransportEvent[], type: string) =>
  evs.filter((e) => e.type === type).map((e) => e.time);

describe('Courier arp — pattern note ordering (sorted pool [0,4,7], authored [0,7,4])', () => {
  it('UP walks the pool ascending and wraps', () => {
    expect(pitchSeq(armArp('UP'), 8)).toEqual([0, 4, 7, 0, 4, 7, 0, 4]);
  });

  it('DOWN walks the pool descending and wraps', () => {
    expect(pitchSeq(armArp('DOWN'), 8)).toEqual([7, 4, 0, 7, 4, 0, 7, 4]);
  });

  it('UPDOWN_INC bounces hitting both end notes twice', () => {
    // [0,4,7] then full reverse [7,4,0]: …,7,7,… and …,0,0,… at the turnarounds
    expect(pitchSeq(armArp('UPDOWN_INC'), 8)).toEqual([0, 4, 7, 7, 4, 0, 0, 4]);
  });

  it('UPDOWN_EXC bounces WITHOUT repeating the turnaround notes', () => {
    // [0,4,7] then inner reverse [4]: period = [0,4,7,4]
    expect(pitchSeq(armArp('UPDOWN_EXC'), 8)).toEqual([0, 4, 7, 4, 0, 4, 7, 4]);
  });

  it('DOWNUP_INC bounces down-then-up hitting both ends twice', () => {
    expect(pitchSeq(armArp('DOWNUP_INC'), 8)).toEqual([7, 4, 0, 0, 4, 7, 7, 4]);
  });

  it('DOWNUP_EXC bounces down-then-up without repeating the ends', () => {
    expect(pitchSeq(armArp('DOWNUP_EXC'), 8)).toEqual([7, 4, 0, 4, 7, 4, 0, 4]);
  });

  it('CONVERGE goes outside-in (low, high, middle)', () => {
    expect(pitchSeq(armArp('CONVERGE'), 6)).toEqual([0, 7, 4, 0, 7, 4]);
  });

  it('DIVERGE goes inside-out (CONVERGE reversed)', () => {
    expect(pitchSeq(armArp('DIVERGE'), 6)).toEqual([4, 7, 0, 4, 7, 0]);
  });

  it('PENDULUM is the classic both-ends bounce (== UPDOWN_INC order)', () => {
    expect(pitchSeq(armArp('PENDULUM'), 8)).toEqual([0, 4, 7, 7, 4, 0, 0, 4]);
  });

  it('AS_PLAYED keeps the AUTHORED insertion order (not sorted)', () => {
    // authored [0,7,4] — distinct from the sorted UP [0,4,7]
    expect(pitchSeq(armArp('AS_PLAYED'), 6)).toEqual([0, 7, 4, 0, 7, 4]);
  });
});

describe('Courier arp — seeded RANDOM patterns (deterministic, reseed-on-start)', () => {
  it('RANDOM picks a fresh seeded index each step (exact stream, seed 1)', () => {
    expect(pitchSeq(armArp('RANDOM', { seed: 1 }), 8)).toEqual([7, 7, 4, 0, 7, 4, 0, 0]);
  });

  it('RANDOM with a different seed diverges', () => {
    const a = pitchSeq(armArp('RANDOM', { seed: 1 }), 8);
    const b = pitchSeq(armArp('RANDOM', { seed: 42 }), 8);
    expect(b).toEqual([7, 4, 7, 4, 4, 0, 7, 7]); // exact seed-42 stream
    expect(a).not.toEqual(b);
  });

  it('RANDOM reseeds on start so two runs of the SAME seq are identical', () => {
    const seq = armArp('RANDOM', { seed: 7 });
    expect(pitchSeq(seq, 8)).toEqual(pitchSeq(seq, 8));
  });

  it('RANDOM_WALK meanders +/-1 from the previous index (seeded, exact)', () => {
    expect(pitchSeq(armArp('RANDOM_WALK', { seed: 42 }), 8)).toEqual([0, 4, 7, 0, 4, 0, 7, 0]);
  });
});

describe('Courier arp — octave modes (1..4)', () => {
  it('octave 1 is the un-expanded pool', () => {
    expect(pitchSeq(armArp('UP', { oct: 1 }), 6)).toEqual([0, 4, 7, 0, 4, 7]);
  });

  it('octave 2 duplicates the pool one octave (+1.0 vv) up before ordering', () => {
    // [0,4,7] then +1 octave [1,5,8]
    expect(pitchSeq(armArp('UP', { oct: 2 }), 8)).toEqual([0, 4, 7, 1, 5, 8, 0, 4]);
  });

  it('octave 4 spans four octaves of the pool', () => {
    expect(pitchSeq(armArp('UP', { oct: 4 }), 12)).toEqual([
      0, 4, 7, 1, 5, 8, 2, 6, 9, 3, 7, 10,
    ]);
  });

  it('octave span composes with DOWN (descends over the octave-expanded run)', () => {
    // expanded run [0,4,7,1,5,8] reversed
    expect(pitchSeq(armArp('DOWN', { oct: 2 }), 6)).toEqual([8, 5, 1, 7, 4, 0]);
  });
});

describe('Courier arp — CHORD', () => {
  it('CHORD sounds all pool notes simultaneously with one shared gate', () => {
    const seq = armArp('CHORD');
    seq.start(0);
    const evs = seq.pullEventsAt(seq.nextEventTime);
    const pitches = evs.filter((e) => e.type === 'pitch').map((e) => e.data?.['noteVv']);
    expect(pitches).toEqual([0, 4, 7]); // the whole sorted pool, at one time
    expect(times(evs, 'pitch').every((t) => t === times(evs, 'pitch')[0])).toBe(true);
    expect(evs.filter((e) => e.type === 'gateOn')).toHaveLength(1); // ONE shared gate
  });

  it('CHORD spans octaves too (arpOctave 2 -> 6 simultaneous notes)', () => {
    const seq = armArp('CHORD', { oct: 2 });
    seq.start(0);
    const evs = seq.pullEventsAt(seq.nextEventTime);
    const pitches = evs.filter((e) => e.type === 'pitch').map((e) => e.data?.['noteVv']);
    expect(pitches).toEqual([0, 4, 7, 1, 5, 8]);
  });
});

describe('Courier arp — programmable RHYTHM (independent clock division)', () => {
  it('the arp runs on arpRhythmIdx, not the seq grid (changes gate-on spacing)', () => {
    // seq grid at clockDivIdx 3 (1/16 = 0.125s), arp rhythm at idx 1 (1/8 = 0.25s) @120bpm
    const seq = armArp('UP');
    seq.clockDivIdx = 3;
    seq.arpRhythmIdx = 1; // 1/8
    const evs = collect(seq, 0.6 - 1e-9);
    const ons = times(evs, 'gateOn');
    // first three gate-ons spaced by the ARP division (0.25s), NOT the grid's 0.125s
    expect(ons[0]).toBeCloseTo(0, 10);
    expect(ons[1]).toBeCloseTo(0.25, 10);
    expect(ons[2]).toBeCloseTo(0.5, 10);
    expect(courierStepDurS(120, 1)).toBeCloseTo(0.25, 12);
  });

  it('when the arp is OFF the seq grid division drives spacing', () => {
    const seq = armArp('OFF');
    seq.clockDivIdx = 3; // 1/16
    seq.arpRhythmIdx = 1; // ignored while OFF
    const evs = collect(seq, 0.3 - 1e-9);
    const ons = times(evs, 'gateOn');
    expect(ons[1]! - ons[0]!).toBeCloseTo(0.125, 10); // grid 1/16, arp rhythm not applied
  });
});

describe('Courier arp — edge cases + probability composition', () => {
  it('an empty authored window still emits the step marker with no pitch', () => {
    const seq = new CourierSequencer();
    seq.tempoBpm = 120;
    seq.endStep = 3;
    seq.arpMode = 'UP'; // no authored notes
    seq.start(0);
    const evs = seq.pullEventsAt(seq.nextEventTime);
    expect(evs.find((e) => e.type === 'pitch')).toBeUndefined();
    expect(evs.find((e) => e.type === 'gateOn')).toBeUndefined();
    expect(evs.find((e) => e.type === 'step')).toBeDefined();
  });

  it('rested steps stay rests under the arp (no gate on a rest step)', () => {
    const seq = armArp('UP');
    seq.steps[1]!.rest = true; // middle step rests
    seq.start(0);
    const gated: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      const evs = seq.pullEventsAt(seq.nextEventTime);
      seq.advance();
      gated.push(evs.some((e) => e.type === 'gateOn'));
    }
    expect(gated).toEqual([true, false, true]);
  });

  it('the arp composes deterministically with NOTE PROB (skips suppress pitch + gate)', () => {
    // noteProb 0.5 on every step; seed 1 rNote stream sounds when < 0.5.
    const seq = armArp('UP', { seed: 1 });
    for (let i = 0; i < 3; i++) seq.steps[i]!.noteProb = 0.5;
    seq.start(0);
    const out: (number | undefined)[] = [];
    for (let i = 0; i < 6; i++) {
      const evs = seq.pullEventsAt(seq.nextEventTime);
      seq.advance();
      out.push(evs.find((e) => e.type === 'pitch')?.data?.['noteVv'] as number | undefined);
    }
    // seed 1 rNote: .627 .968 .426 .139 .489 .286 -> sound on steps where < 0.5 (2..5);
    // when a step sounds it takes the arp's UP pitch for that cursor position.
    const a = out;
    // reproducible with the same seed
    const seq2 = armArp('UP', { seed: 1 });
    for (let i = 0; i < 3; i++) seq2.steps[i]!.noteProb = 0.5;
    seq2.start(0);
    const b: (number | undefined)[] = [];
    for (let i = 0; i < 6; i++) {
      const evs = seq2.pullEventsAt(seq2.nextEventTime);
      seq2.advance();
      b.push(evs.find((e) => e.type === 'pitch')?.data?.['noteVv'] as number | undefined);
    }
    expect(a).toEqual(b);
    expect(a[0]).toBeUndefined(); // step 0 skipped (.627 >= 0.5)
    expect(a[1]).toBeUndefined(); // step 1 skipped (.968 >= 0.5)
    expect(typeof a[2]).toBe('number'); // step 2 sounds (.426 < 0.5)
  });

  it('no NaN/Infinity in any emitted time or pitch across every pattern + octave + rhythm', () => {
    const modes: CourierArpMode[] = [
      'UP', 'DOWN', 'UPDOWN_INC', 'UPDOWN_EXC', 'DOWNUP_INC', 'DOWNUP_EXC',
      'CONVERGE', 'DIVERGE', 'PENDULUM', 'AS_PLAYED', 'RANDOM', 'RANDOM_WALK', 'CHORD',
    ];
    for (const m of modes) {
      const seq = armArp(m, { oct: 3, seed: 12345 });
      seq.arpRhythmIdx = 4; // 1/16T
      const evs = collect(seq, 1.0 - 1e-9);
      for (const e of evs) {
        expect(Number.isFinite(e.time)).toBe(true);
        const n = e.data?.['noteVv'];
        if (typeof n === 'number') expect(Number.isFinite(n)).toBe(true);
      }
    }
  });

  it('nextEventTime stays strictly increasing under a RANDOM arp + probability', () => {
    const seq = armArp('RANDOM', { seed: 2024 });
    seq.endStep = 3;
    for (let i = 0; i < 3; i++) seq.steps[i]!.gateProb = 0.5;
    seq.start(0);
    let prev = seq.nextEventTime;
    for (let i = 0; i < 100; i++) {
      seq.pullEventsAt(seq.nextEventTime);
      seq.advance();
      expect(seq.nextEventTime).toBeGreaterThan(prev);
      prev = seq.nextEventTime;
    }
  });

  it('pullEventsAt stays read-only with the arp active (pull twice == once)', () => {
    const seq = armArp('RANDOM', { seed: 5 });
    seq.start(0);
    const a = seq.pullEventsAt(seq.nextEventTime);
    const b = seq.pullEventsAt(seq.nextEventTime);
    expect(a).toEqual(b);
  });
});
