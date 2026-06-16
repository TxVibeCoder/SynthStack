/**
 * Per-VCO analog drift source — pure logic.
 * A slow random walk: every 0.5–1.5 s (randomized) pick a new target clamped to
 * ±0.0025 vv (±3 cents); the engine binding applies it with setTargetAtTime(τ=1.0 s).
 * Seedable RNG so tests are deterministic; subs share their parent VCO's drift.
 */

import { DRIFT_MAX_VV } from '../units';

/** mulberry32 — tiny seedable PRNG, good enough for drift. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DriftStep {
  /** Seconds until the next walk step. */
  intervalS: number;
  /** New walk target in vv, clamped to ±DRIFT_MAX_VV. */
  targetVv: number;
}

export class DriftWalk {
  private current = 0;
  private readonly rng: () => number;
  private readonly stepVv: number;

  constructor(seed = 1, stepVv = 0.0012) {
    this.rng = mulberry32(seed);
    this.stepVv = stepVv;
  }

  /** Produce the next walk step (interval + target). */
  next(): DriftStep {
    const intervalS = 0.5 + this.rng();
    let target = this.current + (this.rng() * 2 - 1) * this.stepVv;
    if (target > DRIFT_MAX_VV) target = DRIFT_MAX_VV;
    if (target < -DRIFT_MAX_VV) target = -DRIFT_MAX_VV;
    this.current = target;
    return { intervalS, targetVv: target };
  }

  /**
   * Simulate the smoothed drift signal (as setTargetAtTime with τ would produce),
   * sampled at `rateHz`, for tests. Returns vv values.
   */
  simulate(seconds: number, rateHz = 100, tauS = 1.0): Float64Array {
    const n = Math.floor(seconds * rateHz);
    const out = new Float64Array(n);
    const coef = 1 - Math.exp(-1 / (rateHz * tauS));
    let smoothed = 0;
    let target = 0;
    let nextStepAt = 0;
    let t = 0;
    for (let i = 0; i < n; i++, t = i / rateHz) {
      if (t >= nextStepAt) {
        const step = this.next();
        target = step.targetVv;
        nextStepAt = t + step.intervalS;
      }
      smoothed += coef * (target - smoothed);
      out[i] = smoothed;
    }
    return out;
  }
}
