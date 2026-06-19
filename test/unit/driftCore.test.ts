import { describe, expect, it } from 'vitest';
import { DriftWalk } from '../../src/engine/dsp/driftCore';
import { DRIFT_MAX_VV } from '../../src/engine/units';

describe('VCO drift (work order §7.4)', () => {
  it('walk targets never exceed ±0.0025 vv (±3 cents)', () => {
    const walk = new DriftWalk(123);
    for (let i = 0; i < 1000; i++) {
      const s = walk.next();
      expect(Math.abs(s.targetVv)).toBeLessThanOrEqual(DRIFT_MAX_VV);
      expect(s.intervalS).toBeGreaterThanOrEqual(0.5);
      expect(s.intervalS).toBeLessThanOrEqual(1.5);
    }
  });

  it('smoothed 30 s drift has stddev between 0.5 and 4 cents', () => {
    // acceptance measured on the smoothed signal the
    // engine would apply (setTargetAtTime τ=1.0 s)
    for (const seed of [1, 77, 4242]) {
      const sig = new DriftWalk(seed).simulate(30, 100, 1.0);
      const cents = Array.from(sig, (v) => v * 1200);
      const mean = cents.reduce((a, b) => a + b, 0) / cents.length;
      const variance = cents.reduce((a, b) => a + (b - mean) ** 2, 0) / cents.length;
      const stddev = Math.sqrt(variance);
      expect(stddev).toBeGreaterThanOrEqual(0.5);
      expect(stddev).toBeLessThanOrEqual(4);
    }
  });

  it('independent seeds produce independent walks', () => {
    const a = new DriftWalk(1).simulate(10);
    const b = new DriftWalk(2).simulate(10);
    let identical = true;
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i]! - b[i]!) > 1e-9) {
        identical = false;
        break;
      }
    }
    expect(identical).toBe(false);
  });

  it('separate VCOs decorrelate; a sub seeded from its parent tracks it exactly (C8)', () => {
    // The engine contract (units.ts / drift.ts): each VCO gets its own seed → independent drift,
    // but a sub-oscillator shares its PARENT VCO's drift (same seed → identical series).
    const pearson = (x: Float64Array, y: Float64Array): number => {
      const n = Math.min(x.length, y.length);
      let sx = 0, sy = 0;
      for (let i = 0; i < n; i++) { sx += x[i]!; sy += y[i]!; }
      const mx = sx / n, my = sy / n;
      let cov = 0, vx = 0, vy = 0;
      for (let i = 0; i < n; i++) {
        const dx = x[i]! - mx, dy = y[i]! - my;
        cov += dx * dy; vx += dx * dx; vy += dy * dy;
      }
      return cov / Math.sqrt(Math.max(vx * vy, 1e-30));
    };
    // two independent VCOs over 30 s — weakly correlated at most
    const a = new DriftWalk(1).simulate(30);
    const b = new DriftWalk(2).simulate(30);
    expect(Math.abs(pearson(a, b))).toBeLessThan(0.5);
    // a sub built from the SAME seed as its parent is bit-identical (subs share parent drift)
    const parent = new DriftWalk(7).simulate(10);
    const sub = new DriftWalk(7).simulate(10);
    for (let i = 0; i < parent.length; i++) expect(sub[i]).toBe(parent[i]);
  });
});
