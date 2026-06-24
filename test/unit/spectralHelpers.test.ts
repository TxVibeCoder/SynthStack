import { describe, expect, it } from 'vitest';
import { fftMag, harmonicAmpsDb, peakFreqHz } from '../helpers/spectral';

const FS = 48000;
const SIZE = 16384;
const BIN_HZ = FS / SIZE; // ≈ 2.9297 Hz
// A bin-aligned fundamental (75·binHz ≈ 219.73 Hz): every harmonic k·f0 lands exactly on a
// bin, so Hann scalloping loss is zero and peak-bin ratios are exact — the right signal for
// validating the helper MATH. (Non-bin-aligned musical f0 like 110 Hz incurs ~±1.4 dB
// scalloping per harmonic, which is why the real-oscillator fingerprint tests either align
// f0 to the grid or budget ±1.5 dB.)
const F0_ALIGNED = 75 * BIN_HZ;

/** Sum-of-sines additive renderer (deterministic, no DSP under test — validates the helpers). */
function additive(seconds: number, partials: { hz: number; amp: number }[]): Float32Array {
  const n = Math.floor(seconds * FS);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (const p of partials) v += p.amp * Math.sin((2 * Math.PI * p.hz * i) / FS);
    out[i] = v;
  }
  return out;
}

describe('spectral helpers (measurement battery foundation)', () => {
  it('peakFreqHz: recovers a non-bin-aligned tone to sub-bin precision', () => {
    // 440 Hz at binHz ≈ 2.93 (size 16384) lands at bin ≈ 150.1 — deliberately off-grid.
    const buf = additive(1, [{ hz: 440, amp: 1 }]);
    const spec = fftMag(buf, FS, 16384, 8192);
    // nearest-bin would read 149*2.93=439.45 or 150*2.93=439.45..442.4; parabolic interp must
    // recover the true 440 to well within half a bin.
    expect(peakFreqHz(spec)).toBeCloseTo(440, 0); // within 0.5 Hz
    // a band-limited search still finds it
    expect(peakFreqHz(spec, 300, 600)).toBeCloseTo(440, 0);
  });

  it('peakFreqHz: a one-octave-up tone reads exactly double', () => {
    const lo = fftMag(additive(1, [{ hz: 220, amp: 1 }]), FS, 16384, 8192);
    const hi = fftMag(additive(1, [{ hz: 440, amp: 1 }]), FS, 16384, 8192);
    expect(peakFreqHz(hi) / peakFreqHz(lo)).toBeCloseTo(2, 2); // 2:1 within 1%
  });

  it('harmonicAmpsDb: an additive 1/k saw matches the closed-form −6 dB/oct table', () => {
    // ideal saw partials ∝ 1/k → H1..H8 dB = [0, −6.02, −9.54, −12.04, −13.98, −15.56, −16.90, −18.06]
    const f0 = F0_ALIGNED;
    const partials = [];
    for (let k = 1; k <= 30 && k * f0 < FS / 2; k++) partials.push({ hz: k * f0, amp: 1 / k });
    const spec = fftMag(additive(1, partials), FS, SIZE, 8192);
    const amps = harmonicAmpsDb(spec, f0, 8);
    const ideal = [0, -6.02, -9.54, -12.04, -13.98, -15.56, -16.9, -18.06];
    expect(amps[0]).toBe(0); // H1 normalized to 0 by construction
    for (let k = 2; k <= 8; k++) {
      expect(amps[k - 1]!).toBeGreaterThan(ideal[k - 1]! - 0.5);
      expect(amps[k - 1]!).toBeLessThan(ideal[k - 1]! + 0.5);
    }
  });

  it('harmonicAmpsDb: a missing harmonic reads as a deep negative (suppression-floor sanity)', () => {
    // odd-only signal (like a square/triangle): H2 absent → must read far below H1.
    const f0 = F0_ALIGNED;
    const partials = [
      { hz: f0, amp: 1 },
      { hz: 3 * f0, amp: 1 / 3 },
      { hz: 5 * f0, amp: 1 / 5 },
    ];
    const amps = harmonicAmpsDb(fftMag(additive(1, partials), FS, SIZE, 8192), f0, 5);
    expect(amps[1]!).toBeLessThan(-40); // H2 suppressed
    expect(amps[3]!).toBeLessThan(-40); // H4 suppressed
    expect(amps[2]!).toBeGreaterThan(-12); // H3 present (~−9.5)
  });
});
