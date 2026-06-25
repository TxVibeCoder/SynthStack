import { describe, expect, it } from 'vitest';
import { CascadeClock } from '../../src/engine/sequencers/cascadeClock';
import type { TransportEvent } from '../../src/engine/scheduler';

function runTicks(clock: CascadeClock, n: number): TransportEvent[][] {
  const perTick: TransportEvent[][] = [];
  for (let i = 0; i < n; i++) {
    perTick.push(clock.pullEventsAt(i));
    clock.advance();
  }
  return perTick;
}

const fresh = (): CascadeClock => {
  const c = new CascadeClock();
  c.reset();
  return c;
};

describe('Cascade polyrhythm clock (work order §11.2)', () => {
  it('RG with division d fires on every d-th tick from reset', () => {
    const c = fresh();
    c.divisions = [3, 4, 16, 1];
    c.assign = [
      [true, false],
      [false, true],
      [false, false],
      [false, false],
    ];
    const ticks = runTicks(c, 17);
    const firedAt = (rg: number) =>
      ticks.map((evs, i) => ({ i, rgs: evs.find((e) => e.type === 'rgFired')?.data?.['rgs'] as number[] | undefined }))
        .filter((x) => x.rgs?.includes(rg))
        .map((x) => x.i);
    expect(firedAt(0)).toEqual([0, 3, 6, 9, 12, 15]);
    expect(firedAt(1)).toEqual([0, 4, 8, 12, 16]);
    expect(firedAt(2)).toEqual([0, 16]);
    expect(firedAt(3)).toEqual(ticks.map((_, i) => i)); // ÷1 = every tick
  });

  it('OR-combine: coincident assigned RGs cause ONE advance and ONE EG trigger', () => {
    const c = fresh();
    c.divisions = [2, 2, 1, 1]; // RG1 and RG2 coincide on even ticks
    c.assign = [
      [true, false],
      [true, false],
      [false, false],
      [false, false],
    ];
    const ticks = runTicks(c, 4);
    // tick 0: both fire -> exactly one pitchUpdate for seq 0, one egTrigger
    const t0 = ticks[0]!;
    expect(t0.filter((e) => e.type === 'pitchUpdate' && e.data?.['seq'] === 0)).toHaveLength(1);
    expect(t0.filter((e) => e.type === 'egTrigger')).toHaveLength(1);
    // after ticks 0 and 2, seq 0 advanced exactly twice (steps -1 -> 0 -> 1)
    expect(c.steps[0]).toBe(1);
  });

  it('manual polyrhythm recipe: two RGs on SEQ 1 advance it at the irregular UNION pattern', () => {
    // The Cascade manual's "CREATING A POLYRHYTHM" walkthrough (p.30): RG1 and RG2
    // both assigned to Sequencer 1 with different divisions. SEQ 1 must advance
    // on the union of both pulse trains — an uneven gallop, not a steady pulse.
    const c = fresh();
    c.divisions = [4, 3, 1, 1];
    c.assign = [
      [true, false], // RHYTHM 1 -> SEQ 1 (default)
      [true, false], // RHYTHM 2 -> SEQ 1 (the tutorial's button press; SEQ 2 off)
      [false, false],
      [false, false],
    ];
    const ticks = runTicks(c, 24);
    const seq1AdvancedAt = ticks
      .map((evs, i) => ({ i, hit: evs.some((e) => e.type === 'pitchUpdate' && e.data?.['seq'] === 0) }))
      .filter((x) => x.hit)
      .map((x) => x.i);
    // union of multiples of 4 and 3 within 0..23
    expect(seq1AdvancedAt).toEqual([0, 3, 4, 6, 8, 9, 12, 15, 16, 18, 20, 21]);
    // the gaps are IRREGULAR (3,1,2,2,1,3,…) — that unevenness IS the polyrhythm
    const gaps = seq1AdvancedAt.slice(1).map((t, k) => t - seq1AdvancedAt[k]!);
    expect(new Set(gaps).size).toBeGreaterThan(1);
    // and the EG fires on exactly those ticks (coalesced, mode ON)
    const egAt = ticks
      .map((evs, i) => ({ i, hit: evs.some((e) => e.type === 'egTrigger') }))
      .filter((x) => x.hit)
      .map((x) => x.i);
    expect(egAt).toEqual(seq1AdvancedAt);
  });

  it('coalesced EG: both sequencers firing on the same tick emit a single egTrigger', () => {
    const c = fresh();
    c.divisions = [1, 1, 1, 1];
    c.assign = [
      [true, false],
      [false, true],
      [false, false],
      [false, false],
    ];
    const [t0] = runTicks(c, 1);
    expect(t0!.filter((e) => e.type === 'egTrigger')).toHaveLength(1);
    expect(t0!.filter((e) => e.type === 'pitchUpdate')).toHaveLength(2); // one per seq
    expect(t0!.filter((e) => e.type === 'seqClkPulse')).toHaveLength(2);
  });

  it('EG mode OFF suppresses egTrigger but not advancement', () => {
    const c = fresh();
    c.egMode = 'OFF';
    const ticks = runTicks(c, 2);
    expect(ticks.flat().filter((e) => e.type === 'egTrigger')).toHaveLength(0);
    expect(c.steps[0]).toBeGreaterThanOrEqual(0); // still advanced
  });

  it('a sequencer with NO assigned RG never advances (authentic)', () => {
    const c = fresh();
    c.assign = [
      [true, false],
      [false, false],
      [false, false],
      [false, false],
    ];
    runTicks(c, 12);
    expect(c.steps[0]).toBeGreaterThanOrEqual(0);
    expect(c.steps[1]).toBe(-1); // seq 2 untouched
  });

  it('RESET: first tick after reset lands on step 1 (index 0)', () => {
    const c = fresh();
    runTicks(c, 5);
    c.reset();
    expect(c.steps).toEqual([-1, -1]);
    runTicks(c, 1);
    expect(c.steps[0]).toBe(0);
  });

  it('held RESET: stays on step 1 while EGs keep triggering; NEXT advances manually', () => {
    const c = fresh();
    runTicks(c, 3);
    c.reset();
    c.resetHeld = true;
    const ticks = runTicks(c, 6);
    expect(c.steps[0]).toBe(0); // pinned to step 1
    expect(ticks.flat().some((e) => e.type === 'egTrigger')).toBe(true); // EGs keep firing
    const nextEvents = c.next(99);
    expect(c.steps[0]).toBe(1); // NEXT still advances during hold
    expect(nextEvents.some((e) => e.type === 'egTrigger')).toBe(false); // without retrigger
  });

  it('division CV: d = clamp(round(knob + cv*1.5), 1, 16), applied at tick time', () => {
    const c = fresh();
    c.divisions = [8, 1, 1, 1];
    c.assign = [
      [true, false],
      [false, false],
      [false, false],
      [false, false],
    ];
    c.divisionCvVv = [2, 0, 0, 0]; // 8 + 3 = 11
    const ticks = runTicks(c, 23);
    const fires = ticks
      .map((evs, i) => ({ i, rgs: evs.find((e) => e.type === 'rgFired')?.data?.['rgs'] as number[] | undefined }))
      .filter((x) => x.rgs?.includes(0))
      .map((x) => x.i);
    expect(fires).toEqual([0, 11, 22]);
    // extreme CV clamps to the 1..16 range
    c.divisionCvVv = [-10, 0, 0, 0];
    c.reset();
    const t2 = runTicks(c, 3);
    expect(
      t2.every((evs) => (evs.find((e) => e.type === 'rgFired')?.data?.['rgs'] as number[]).includes(0)),
    ).toBe(true); // d clamped to 1 -> fires every tick
  });

  it('division CV (U2): effectiveDivision clamps to 1..16 — no 0/negative/NaN divider', () => {
    // U2 CV-rate guard: CAS_RHYTHM_n_IN CV rides divisionCvVv and feeds effectiveDivision via
    // cascadeRhythmDivision(knob, cv). A 0 or negative divider would be `tickIndex % 0` (NaN) — a
    // divide-by-zero that silently wedges the polyrhythm. Confirm every CV extreme clamps to 1..16.
    const c = fresh();
    c.divisions = [4, 1, 1, 1];
    c.assign = [
      [true, false],
      [false, false],
      [false, false],
      [false, false],
    ];
    // huge NEGATIVE CV would push the divider far below 1 → clamps to 1 → RG fires every tick
    c.divisionCvVv = [-100, 0, 0, 0];
    const neg = runTicks(c, 5);
    expect(
      neg.every((evs) => (evs.find((e) => e.type === 'rgFired')?.data?.['rgs'] as number[]).includes(0)),
    ).toBe(true); // d clamped to 1 — never a 0/negative divider (no NaN tick math)

    // huge POSITIVE CV clamps to 16 (never blows past the 16-tick ceiling)
    c.reset();
    c.divisionCvVv = [100, 0, 0, 0];
    const pos = runTicks(c, 17);
    const firedAt = pos
      .map((evs, i) => ({ i, rgs: evs.find((e) => e.type === 'rgFired')?.data?.['rgs'] as number[] | undefined }))
      .filter((x) => x.rgs?.includes(0))
      .map((x) => x.i);
    expect(firedAt).toEqual([0, 16]); // d clamped to 16

    // NaN CV must NOT propagate a NaN divider (clamp defaults NaN to the low rail = 1)
    c.reset();
    c.divisionCvVv = [NaN, 0, 0, 0];
    const nan = runTicks(c, 3);
    expect(
      nan.every((evs) => (evs.find((e) => e.type === 'rgFired')?.data?.['rgs'] as number[]).includes(0)),
    ).toBe(true); // d defaulted to 1 — never a NaN divider
  });

  it('division changes take effect on the next tick without phase jump', () => {
    const c = fresh();
    c.divisions = [4, 1, 1, 1];
    c.assign = [
      [true, false],
      [false, false],
      [false, false],
      [false, false],
    ];
    runTicks(c, 6); // ticks 0..5; RG0 fired at 0, 4
    c.divisions = [3, 1, 1, 1];
    const more = runTicks(c, 4); // ticks 6..9; tickIndex%3==0 -> 6, 9
    const fires = more
      .map((evs, i) => ({ i: i + 6, rgs: evs.find((e) => e.type === 'rgFired')?.data?.['rgs'] as number[] | undefined }))
      .filter((x) => x.rgs?.includes(0))
      .map((x) => x.i);
    expect(fires).toEqual([6, 9]);
  });

  it('PHASE-LOCK PROOF: 10,000 ticks, d=[3,4] — re-coincides every 12 ticks, forever', () => {
    const c = fresh();
    c.divisions = [3, 4, 1, 1];
    c.assign = [
      [true, false],
      [false, true],
      [false, false],
      [false, false],
    ];
    let seq1Advances = 0;
    let seq2Advances = 0;
    for (let i = 0; i < 10000; i++) {
      const evs = c.pullEventsAt(i);
      if (evs.some((e) => e.type === 'pitchUpdate' && e.data?.['seq'] === 0)) seq1Advances++;
      if (evs.some((e) => e.type === 'pitchUpdate' && e.data?.['seq'] === 1)) seq2Advances++;
      const rgs = (evs.find((e) => e.type === 'rgFired')?.data?.['rgs'] as number[]) ?? [];
      const coincide = rgs.includes(0) && rgs.includes(1);
      // they coincide exactly on multiples of lcm(3,4) = 12 — forever
      expect(coincide).toBe(i % 12 === 0);
      c.advance();
    }
    expect(seq1Advances).toBe(Math.ceil(10000 / 3)); // 3334
    expect(seq2Advances).toBe(2500);
  });

  it('external clock: internal ticks muted, edges drive the engine', () => {
    const c = fresh();
    c.externalClock = true;
    c.start(0);
    expect(c.pullEventsAt(0)).toEqual([]);
    const before = c.currentTick;
    c.advance();
    expect(c.currentTick).toBe(before); // internal advance does not move the counter
    const evs = c.onExternalEdge(1.0);
    expect(evs.some((e) => e.type === 'pitchUpdate')).toBe(true);
    expect(c.currentTick).toBe(before + 1);
  });

  it('tempo changes take effect from the next boundary', () => {
    const c = fresh();
    c.tempoHz = 2;
    c.start(0);
    c.pullEventsAt(0);
    c.advance();
    expect(c.nextEventTime).toBeCloseTo(0.5, 10);
    c.tempoHz = 4;
    c.pullEventsAt(0.5);
    c.advance();
    expect(c.nextEventTime).toBeCloseTo(0.75, 10);
  });
});
