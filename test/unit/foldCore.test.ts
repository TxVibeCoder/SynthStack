/**
 * PURE wavefolder core (G8 FOLD FX). Objective properties only — the fold CHARACTER (drive
 * range/map, symmetry taper, defaults) is a by-ear call for the operator (see foldCore.ts
 * header); these tests lock the STRUCTURE: odd symmetry at symmetry=0, ±1 rail-safety for all
 * drive, near-identity at low drive, monotonic BRIGHTNESS (spectral centroid) enrichment vs
 * drive + added odd-harmonic energy vs the near-sine baseline, and even harmonics appearing
 * when symmetry≠0. NOTE: individual harmonics (H3/H5) are deliberately NOT asserted monotonic —
 * a deep fold migrates energy between odd partials (a real folder trait), so the centroid is the
 * robust objective metric, not any single Hk.
 */

import { describe, expect, it } from 'vitest';
import {
  foldTransfer,
  buildFoldCurve,
  FOLD_DRIVE_MIN,
  FOLD_DRIVE_MAX,
} from '../../src/engine/dsp/foldCore';
import { fftMag, harmonicAmpsDb, magAtHz, spectralCentroidHz } from '../helpers/spectral';

/** Render a pure sine at f0 through the static fold curve (linear interp of the WaveShaper map). */
function renderSineThroughCurve(
  curve: Float32Array,
  f0: number,
  sampleRate: number,
  n: number,
): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = Math.sin((2 * Math.PI * f0 * i) / sampleRate); // ∈ [-1,1]
    // WaveShaper curve lookup: map x∈[-1,1] → index ∈ [0, len-1] with linear interpolation.
    const pos = ((x + 1) / 2) * (curve.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(curve.length - 1, lo + 1);
    const frac = pos - lo;
    out[i] = curve[lo]! * (1 - frac) + curve[hi]! * frac;
  }
  return out;
}

describe('foldCore.foldTransfer', () => {
  it('is odd-symmetric at symmetry=0: f(-x) = -f(x)', () => {
    for (const drive of [1, 1.5, 2, 4, 8]) {
      for (let x = -1; x <= 1; x += 0.05) {
        const a = foldTransfer(x, drive, 0);
        const b = foldTransfer(-x, drive, 0);
        expect(a + b).toBeCloseTo(0, 6);
      }
    }
  });

  it('is bounded to ±1 (rail-safe) for ALL drive in 1..8 and any input', () => {
    for (let drive = FOLD_DRIVE_MIN; drive <= FOLD_DRIVE_MAX; drive += 0.25) {
      for (const sym of [-1, -0.5, 0, 0.5, 1]) {
        for (let x = -1.5; x <= 1.5; x += 0.03) {
          const y = foldTransfer(x, drive, sym);
          expect(y).toBeLessThanOrEqual(1);
          expect(y).toBeGreaterThanOrEqual(-1);
        }
      }
    }
  });

  it('is near-identity at drive ≈ 1 (gentle, no hard fold)', () => {
    for (let x = -1; x <= 1; x += 0.1) {
      // sin((π/2)·x) ≈ x near the origin; allow the mild sine bow.
      expect(foldTransfer(x, 1, 0)).toBeCloseTo(Math.sin((Math.PI / 2) * x), 6);
    }
    // and it tracks the input sign (monotone-ish, no fold-over at drive 1)
    expect(foldTransfer(0.5, 1, 0)).toBeGreaterThan(0);
    expect(foldTransfer(-0.5, 1, 0)).toBeLessThan(0);
  });

  it('clamps drive + symmetry into range (out-of-range args do not throw / escape ±1)', () => {
    expect(foldTransfer(0.7, 999, 0)).toBe(foldTransfer(0.7, FOLD_DRIVE_MAX, 0));
    expect(foldTransfer(0.7, -5, 0)).toBe(foldTransfer(0.7, FOLD_DRIVE_MIN, 0));
    expect(foldTransfer(0.7, 4, 9)).toBe(foldTransfer(0.7, 4, 1));
  });
});

describe('foldCore harmonic enrichment (objective fidelity gate)', () => {
  const sampleRate = 48000;
  const f0 = 220;
  const N = 8192;

  function specAtDrive(drive: number) {
    const curve = buildFoldCurve(drive, 0);
    const buf = renderSineThroughCurve(curve, f0, sampleRate, N);
    return fftMag(buf, sampleRate, N, 0);
  }
  const centroidAtDrive = (drive: number) => spectralCentroidHz(specAtDrive(drive));
  /** Combined odd-harmonic (H3 + H5 + H7) energy — robust to a single harmonic notching as
   *  fold depth migrates energy between odd partials. */
  function oddEnergyAtDrive(drive: number): number {
    const spec = specAtDrive(drive);
    return magAtHz(spec, 3 * f0) ** 2 + magAtHz(spec, 5 * f0) ** 2 + magAtHz(spec, 7 * f0) ** 2;
  }

  it('spectral centroid (brightness) STRICTLY increases with drive (1 < 2 < 4 < 8)', () => {
    // The centroid is the robust, monotonic "more fold = brighter" gate. Individual harmonics
    // oscillate as deep folds migrate energy between odd partials (a real folder trait), so the
    // centroid — not any single Hk — is the objective enrichment metric.
    const c1 = centroidAtDrive(1);
    const c2 = centroidAtDrive(2);
    const c4 = centroidAtDrive(4);
    const c8 = centroidAtDrive(8);
    expect(c2).toBeGreaterThan(c1);
    expect(c4).toBeGreaterThan(c2);
    expect(c8).toBeGreaterThan(c4);
  });

  it('folding (drive >= 2) adds odd-harmonic energy vs the near-sine baseline (drive 1)', () => {
    // drive≈1 is a near-identity (one near-pure sine → almost no upper odd harmonics); every
    // folded setting has STRICTLY more combined odd-harmonic (H3+H5+H7) energy.
    const e1 = oddEnergyAtDrive(1);
    for (const d of [2, 4, 8]) {
      expect(oddEnergyAtDrive(d)).toBeGreaterThan(e1);
    }
  });
});

describe('foldCore symmetry → even harmonics', () => {
  const sampleRate = 48000;
  const f0 = 220;
  const N = 8192;

  function h2Db(symmetry: number): number {
    const curve = buildFoldCurve(4, symmetry);
    const buf = renderSineThroughCurve(curve, f0, sampleRate, N);
    const spec = fftMag(buf, sampleRate, N, 0);
    return harmonicAmpsDb(spec, f0, 2)[1]!; // H2 relative to H1, dB
  }

  it('symmetry=0 has ~no even (H2) energy; symmetry≠0 adds H2', () => {
    const h2Zero = h2Db(0); // odd-symmetric → H2 deeply suppressed
    const h2Pos = h2Db(0.6);
    const h2Neg = h2Db(-0.6);
    // a strongly-suppressed even harmonic reads as a large negative dB
    expect(h2Zero).toBeLessThan(-60);
    // symmetry brings H2 up by a wide margin (objective: even harmonics appear)
    expect(h2Pos).toBeGreaterThan(h2Zero + 40);
    expect(h2Neg).toBeGreaterThan(h2Zero + 40);
  });
});

describe('foldCore buildFoldCurve', () => {
  it('produces a samples-length Float32Array spanning the [-1,1] domain endpoints', () => {
    const curve = buildFoldCurve(2, 0, 256);
    expect(curve).toBeInstanceOf(Float32Array);
    expect(curve.length).toBe(256);
    // endpoints map x=-1 and x=+1 through the transfer fn
    expect(curve[0]!).toBeCloseTo(foldTransfer(-1, 2, 0), 6);
    expect(curve[curve.length - 1]!).toBeCloseTo(foldTransfer(1, 2, 0), 6);
    // every sample stays rail-safe
    for (const v of curve) {
      expect(v).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(-1);
    }
  });

  it('mix=0 dry-passthrough is an engine-shell property, but the curve itself is stable per (drive,symmetry)', () => {
    // Determinism: same args → byte-identical curve (no RNG, pure).
    const a = buildFoldCurve(3, 0.2, 512);
    const b = buildFoldCurve(3, 0.2, 512);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
