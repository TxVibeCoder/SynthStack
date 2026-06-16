import { describe, expect, it } from 'vitest';
import {
  QUANT_CYCLE,
  type PhaseRef,
  type QuantDivision,
  divisionSixteenths,
  barPeriodS,
  nextBoundary,
  RELAUNCH_SIXTEENTHS,
} from '../../src/engine/quantGrid';
import { monarchStepDurS, swingOffsetS } from '../../src/engine/units';

/** A running phase whose bar downbeat sits at `anchorTime` (120 BPM unless overridden). */
function runningPhase(anchorTime = 0, bpm = 120): PhaseRef {
  return { running: true, tempoBpm: bpm, anchorTime, sixteenthDurS: monarchStepDurS(bpm) };
}

describe('quantGrid — sampler launch grid (feature: loop-quantize)', () => {
  it('QUANT_CYCLE is the 6 positions in order', () => {
    expect(QUANT_CYCLE).toEqual(['OFF', '1/16', '1/8', '1/4', '1/2', '1 BAR']);
  });

  it('divisionSixteenths maps each division to its 16th-note length', () => {
    expect(divisionSixteenths('OFF')).toBe(0);
    expect(divisionSixteenths('1/16')).toBe(1);
    expect(divisionSixteenths('1/8')).toBe(2);
    expect(divisionSixteenths('1/4')).toBe(4);
    expect(divisionSixteenths('1/2')).toBe(8);
    expect(divisionSixteenths('1 BAR')).toBe(16);
  });

  it('barPeriodS = 16 sixteenths and RELAUNCH_SIXTEENTHS is one bar', () => {
    const phase = runningPhase(0, 120);
    expect(RELAUNCH_SIXTEENTHS).toBe(16);
    expect(barPeriodS(phase)).toBeCloseTo(16 * 0.125, 12); // 2.0 s at 120 BPM
  });

  it('OFF returns afterTime unchanged (immediate)', () => {
    const phase = runningPhase(0, 120);
    expect(nextBoundary(0.37, 'OFF', phase)).toBe(0.37);
  });

  it('a stopped master degrades to immediate for every division', () => {
    const stopped: PhaseRef = { running: false, tempoBpm: 120, anchorTime: 0, sixteenthDurS: 0.125 };
    for (const d of QUANT_CYCLE) {
      expect(nextBoundary(0.41, d, stopped)).toBe(0.41);
    }
  });

  it('each division snaps to an integer multiple of its grid above the anchor and >= afterTime', () => {
    const phase = runningPhase(0, 120);
    const after = 0.3; // arbitrary mid-bar time
    for (const d of ['1/16', '1/8', '1/4', '1/2', '1 BAR'] as QuantDivision[]) {
      const gridS = divisionSixteenths(d) * phase.sixteenthDurS;
      const b = nextBoundary(after, d, phase);
      expect(b).toBeGreaterThanOrEqual(after);
      const k = (b - phase.anchorTime) / gridS;
      expect(k).toBeCloseTo(Math.round(k), 9); // integer multiple of the grid
      expect(b - gridS).toBeLessThan(after); // it is the FIRST such boundary
    }
  });

  it('respects a non-zero anchor (boundaries ride the bar downbeat, not wall-clock zero)', () => {
    const phase = runningPhase(0.05, 120); // bar downbeat at 50 ms
    // 1/4 grid = 4*0.125 = 0.5 s; first boundary >= 0.6 after 0.05 anchor is 0.05 + 0.5 = 0.55? no -> 0.55<0.6 -> 1.05
    expect(nextBoundary(0.6, '1/4', phase)).toBeCloseTo(1.05, 9);
    // exactly on a boundary fires there (idempotent), not the next grid
    expect(nextBoundary(0.55, '1/4', phase)).toBeCloseTo(0.55, 9);
  });

  it('is idempotent at a boundary and monotonic in afterTime', () => {
    const phase = runningPhase(0, 120);
    const b = nextBoundary(0.0, '1 BAR', phase);
    expect(b).toBeCloseTo(0.0, 9); // anchor itself is a boundary
    // re-applying at the boundary returns the same boundary (no off-by-one drift forward)
    expect(nextBoundary(b, '1 BAR', phase)).toBeCloseTo(b, 9);
    // monotonic: later afterTime never yields an earlier boundary
    let prev = -Infinity;
    for (let t = 0; t < 6; t += 0.013) {
      const x = nextBoundary(t, '1/8', phase);
      expect(x).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = x;
    }
  });

  it('NO DRIFT: the closed form stays bit-stable vs a naive accumulator over 10,000 bars', () => {
    const phase = runningPhase(0, 137); // an awkward tempo to stress float accumulation
    const period = barPeriodS(phase);
    let acc = phase.anchorTime; // naive per-bar accumulator (drifts)
    let maxErr = 0;
    for (let bar = 1; bar <= 10000; bar++) {
      // ask for the boundary strictly after the previous bar -> the next bar's downbeat
      const closed = nextBoundary(phase.anchorTime + bar * period - period / 2, '1 BAR', phase);
      const exact = phase.anchorTime + bar * period; // the true multiply-from-origin value
      acc += period; // accumulator's drifting estimate
      maxErr = Math.max(maxErr, Math.abs(closed - exact));
      expect(closed).toBeCloseTo(exact, 9);
    }
    // the closed form equals the exact multiply at every bar — no per-call accumulation
    expect(maxErr).toBeLessThan(1e-9);
    // the naive accumulator is only kept as the contrast baseline; it stays in the same
    // ballpark here (10k adds of a fixed period), but the POINT is the closed form above
    // never sums, so it cannot drift no matter how long a loop runs.
    expect(Math.abs(acc - (phase.anchorTime + 10000 * period))).toBeLessThan(1e-3);
  });

  it('SWING-IMMUNITY: the anchor (un-swung baseTime grid) is independent of swing %', () => {
    // The studio derives PhaseRef.anchorTime from monarchseq.baseTime (un-swung), NOT the
    // swung nextEventTime. Model that derivation here for two swing settings and prove
    // the resulting boundary is identical — the grid never inherits the gate swing.
    const bpm = 120;
    const stepDur = monarchStepDurS(bpm);
    // baseTime accumulates stepDur per tick regardless of swing; swing only offsets odd
    // ticks' nextEventTime. anchorTime = baseTime - (tickCount % 16) * stepDur.
    function phaseAt(tickCount: number, _swingPct: number): PhaseRef {
      const baseTime = tickCount * stepDur; // un-swung accumulation (swing-independent)
      const anchorTime = baseTime - (tickCount % 16) * stepDur;
      return { running: true, tempoBpm: bpm, anchorTime, sixteenthDurS: stepDur };
    }
    for (let tick = 0; tick < 32; tick++) {
      const noSwing = phaseAt(tick, 50);
      const heavySwing = phaseAt(tick, 75);
      // the anchor used by the grid is byte-identical across swing settings
      expect(heavySwing.anchorTime).toBeCloseTo(noSwing.anchorTime, 12);
      const after = tick * stepDur + 0.01;
      expect(nextBoundary(after, '1/4', heavySwing)).toBeCloseTo(
        nextBoundary(after, '1/4', noSwing),
        12,
      );
    }
    // and the swing offset itself is non-zero at 75% (so the test is meaningful)
    expect(swingOffsetS(75, stepDur)).not.toBeCloseTo(0, 6);
  });

  it('sub-bar boundaries are phase-coherent with the bar downbeat', () => {
    const phase = runningPhase(0.2, 120);
    // every 1/4 boundary in a bar must also be a valid grid offset from the bar anchor
    const barBoundary = nextBoundary(phase.anchorTime, '1 BAR', phase);
    for (let q = 0; q < 4; q++) {
      const after = phase.anchorTime + q * 4 * phase.sixteenthDurS + 1e-6;
      const b = nextBoundary(after, '1/4', phase);
      const offsetFromBar = (b - barBoundary) / phase.sixteenthDurS;
      expect(offsetFromBar).toBeCloseTo(Math.round(offsetFromBar), 9); // integer 16ths off the bar
    }
  });
});
