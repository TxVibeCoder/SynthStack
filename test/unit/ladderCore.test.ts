import { describe, expect, it } from 'vitest';
import { LadderCore } from '../../src/engine/dsp/ladderCore';
import { mulberry32 } from '../../src/engine/dsp/driftCore';
import { db, fftMagAveraged, fftMag, magAtHz, rms, spectralCentroidSeries, zeroCrossFreq } from '../helpers/spectral';

const FS = 48000;
const BLOCK = 128;

function whiteNoise(seconds: number, seed = 42, amplitudeVv = 2.5): Float32Array {
  const rng = mulberry32(seed);
  const n = Math.floor(seconds * FS);
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) buf[i] = (rng() * 2 - 1) * amplitudeVv;
  return buf;
}

function processAll(core: LadderCore, input: Float32Array): Float32Array {
  const out = new Float32Array(input.length);
  const inBlock = new Float32Array(BLOCK);
  const outBlock = new Float32Array(BLOCK);
  for (let off = 0; off < input.length; off += BLOCK) {
    const n = Math.min(BLOCK, input.length - off);
    inBlock.set(input.subarray(off, off + n));
    core.processBlock(inBlock, outBlock, n);
    out.set(outBlock.subarray(0, n), off);
  }
  return out;
}

describe('ladder.worklet core — Huovilainen (work order §7.3)', () => {
  it('LP rolloff: cutoff 500 Hz, res 0 — 4 kHz >= 70 dB below the passband on white noise', () => {
    const core = new LadderCore(FS);
    core.setCutoffHz(500);
    core.setResonance01(0);
    // moderate level: hot noise into the tanh stages raises a broadband
    // intermodulation floor that masks the true linear rolloff
    const out = processAll(core, whiteNoise(12, 42, 1.0));
    const spec = fftMagAveraged(out.subarray(FS), FS, 16384, 4096);
    // Reference is 100 Hz (true passband, −0.7 dB), not a literal
    // 250 Hz: an IDEAL 4-pole ladder droops −3.9 dB at cutoff/2, making the literal
    // "≥70 dB below 250 Hz" unachievable even in theory (ideal = −68.6 dB). The
    // intent — 24 dB/oct verified with margin — is preserved.
    const at100 = magAtHz(spec, 100, 2);
    const at4k = magAtHz(spec, 4000, 2);
    expect(db(at4k / at100)).toBeLessThanOrEqual(-70);
    // and the 250 Hz point still beats the ideal filter's own figure
    expect(db(at4k / magAtHz(spec, 250, 2))).toBeLessThanOrEqual(-68);
  });

  it('self-oscillates at max resonance: near-sinusoid within ±3% of 1 kHz, stable RMS', () => {
    const core = new LadderCore(FS);
    core.setCutoffHz(1000);
    core.setResonance01(1);
    const input = new Float32Array(3 * FS);
    input[0] = 1; // tiny kick; thereafter silence
    const out = processAll(core, input);
    const f = zeroCrossFreq(out, FS, FS, 3 * FS);
    expect(Math.abs(f - 1000) / 1000).toBeLessThanOrEqual(0.03);
    const rms1 = rms(out, FS, 2 * FS);
    const rms2 = rms(out, 2 * FS, 3 * FS);
    expect(rms1).toBeGreaterThan(0.5); // it is actually oscillating, in vv
    expect(rms2 / rms1).toBeGreaterThan(0.7);
    expect(rms2 / rms1).toBeLessThan(1.4);
    // near-sinusoid: harmonics well below fundamental
    const spec = fftMag(out, FS, 8192, 2 * FS);
    expect(db(magAtHz(spec, 2000, 4) / magAtHz(spec, 1000, 4))).toBeLessThan(-15);
  });

  it('does NOT self-oscillate at 60% resonance', () => {
    const core = new LadderCore(FS);
    core.setCutoffHz(1000);
    core.setResonance01(0.6);
    const input = new Float32Array(2 * FS);
    input[0] = 1;
    const out = processAll(core, input);
    expect(rms(out, FS, 2 * FS)).toBeLessThan(0.01);
  });

  it('LP slope ≈ 24 dB/octave above cutoff (4-pole ladder, manual) (C1)', () => {
    const core = new LadderCore(FS);
    core.setCutoffHz(500);
    core.setResonance01(0);
    const out = processAll(core, whiteNoise(12, 42, 1.0));
    const spec = fftMagAveraged(out.subarray(FS), FS, 16384, 4096);
    // octave ratios in the asymptotic region (well above the 500 Hz corner)
    const oct1 = db(magAtHz(spec, 2000, 2) / magAtHz(spec, 1000, 2));
    const oct2 = db(magAtHz(spec, 4000, 2) / magAtHz(spec, 2000, 2));
    for (const slope of [oct1, oct2]) {
      expect(slope).toBeLessThan(-18); // 24 dB/oct ± 6
      expect(slope).toBeGreaterThan(-30);
    }
  });

  it('self-oscillation onset: silent at 0.70 knob, oscillating by 0.90 ("above 3 o\'clock") (C2)', () => {
    const tail = (knob: number): number => {
      const core = new LadderCore(FS);
      core.setCutoffHz(1000);
      core.setResonance01(knob);
      const input = new Float32Array(3 * FS);
      input[0] = 1; // tiny kick, then silence
      return rms(processAll(core, input), 2 * FS, 3 * FS);
    };
    expect(tail(0.7)).toBeLessThan(0.01); // not yet oscillating below ~3 o'clock
    expect(tail(0.9)).toBeGreaterThan(0.3); // robust self-oscillation by ~3 o'clock+
  });

  it('per-module resonance scale moves the onset earlier (Cascade ≈ 2 o\'clock)', () => {
    const tail = (knob: number, scale: number): number => {
      const core = new LadderCore(FS);
      core.setResonanceScale(scale);
      core.setCutoffHz(1000);
      core.setResonance01(knob);
      const input = new Float32Array(3 * FS);
      input[0] = 1; // tiny kick, then silence
      return rms(processAll(core, input), 2 * FS, 3 * FS);
    };
    // With the Cascade's 1.43 scale, 0.70 ("above two o'clock") already self-oscillates —
    // where the default 1.15 scale is still silent (asserted in the C2 test above).
    expect(tail(0.7, 1.43)).toBeGreaterThan(0.3);
    expect(tail(0.55, 1.43)).toBeLessThan(0.01); // still silent below the earlier onset
  });

  it('cutoff sweep 100 Hz -> 8 kHz: centroid strictly increases, no NaN/Inf', () => {
    const core = new LadderCore(FS);
    core.setResonance01(0.2);
    const input = whiteNoise(2, 7);
    const out = new Float32Array(input.length);
    const inBlock = new Float32Array(BLOCK);
    const outBlock = new Float32Array(BLOCK);
    for (let off = 0; off < input.length; off += BLOCK) {
      const t = off / input.length;
      core.setCutoffHz(100 * Math.pow(80, t)); // 100 -> 8000 exponential
      const n = Math.min(BLOCK, input.length - off);
      inBlock.set(input.subarray(off, off + n));
      core.processBlock(inBlock, outBlock, n);
      out.set(outBlock.subarray(0, n), off);
    }
    for (const v of out) expect(Number.isFinite(v)).toBe(true);
    const series = spectralCentroidSeries(out, FS, 0.1).slice(1, -1);
    const first = series[0]!;
    const last = series[series.length - 1]!;
    expect(last).toBeGreaterThan(first * 5);
    for (let i = 1; i < series.length; i++) {
      expect(series[i]!).toBeGreaterThan(series[i - 1]! * 0.92); // monotone with jitter allowance
    }
  });

  it('LP2 mode: ≈ 12 dB/octave rolloff above cutoff (2-pole tap)', () => {
    const core = new LadderCore(FS);
    core.mode = 'LP2';
    core.setCutoffHz(500);
    core.setResonance01(0);
    const out = processAll(core, whiteNoise(12, 42, 1.0));
    const spec = fftMagAveraged(out.subarray(FS), FS, 16384, 4096);
    const oct1 = db(magAtHz(spec, 2000, 2) / magAtHz(spec, 1000, 2));
    const oct2 = db(magAtHz(spec, 4000, 2) / magAtHz(spec, 2000, 2));
    for (const slope of [oct1, oct2]) {
      expect(slope).toBeLessThan(-6); // 12 dB/oct ± 6
      expect(slope).toBeGreaterThan(-18);
    }
    // and it is clearly shallower than the LP4 path on the same signal
    const lp4 = new LadderCore(FS);
    lp4.setCutoffHz(500);
    lp4.setResonance01(0);
    const out4 = processAll(lp4, whiteNoise(12, 42, 1.0));
    const spec4 = fftMagAveraged(out4.subarray(FS), FS, 16384, 4096);
    const lp4Oct = db(magAtHz(spec4, 4000, 2) / magAtHz(spec4, 2000, 2));
    expect(lp4Oct).toBeLessThan(oct2 - 6); // LP4 falls off at least ~one octave's worth faster
  });

  it('BP mode: attenuates both bands, peaks near cutoff', () => {
    const core = new LadderCore(FS);
    core.mode = 'BP';
    const fc = 2000;
    core.setCutoffHz(fc);
    core.setResonance01(0.4); // a little resonance sharpens the band
    const out = processAll(core, whiteNoise(6, 23));
    const spec = fftMagAveraged(out.subarray(FS), FS, 8192);
    const center = magAtHz(spec, fc, 3);
    const lowOct = magAtHz(spec, fc / 4, 3); // two octaves below
    const highOct = magAtHz(spec, fc * 4, 3); // two octaves above
    expect(db(lowOct / center)).toBeLessThan(-6); // low side rejected
    expect(db(highOct / center)).toBeLessThan(-6); // high side rejected
  });

  it('HP mode passes highs, attenuates lows (LP4/HP backward-compat unchanged)', () => {
    const core = new LadderCore(FS);
    core.mode = 'HP';
    core.setCutoffHz(2000);
    core.setResonance01(0);
    const out = processAll(core, whiteNoise(4, 11));
    const spec = fftMagAveraged(out.subarray(FS), FS, 8192);
    expect(db(magAtHz(spec, 100, 4) / magAtHz(spec, 8000, 4))).toBeLessThan(-30);
  });

  it('RES BASS: preserves low-end energy under resonance vs. off (no NaN)', () => {
    const lowEnergy = (resBass: boolean): number => {
      const core = new LadderCore(FS);
      core.mode = 'LP'; // LP4 with high resonance thins the bass
      core.resBass = resBass;
      core.setCutoffHz(800);
      core.setResonance01(0.85);
      const out = processAll(core, whiteNoise(4, 31));
      for (const v of out) expect(Number.isFinite(v)).toBe(true);
      const spec = fftMagAveraged(out.subarray(FS), FS, 8192);
      // sub-bass band, well below the 800 Hz corner
      return magAtHz(spec, 80, 4) + magAtHz(spec, 120, 4) + magAtHz(spec, 160, 4);
    };
    const off = lowEnergy(false);
    const on = lowEnergy(true);
    expect(on).toBeGreaterThan(off * 1.2); // RES BASS measurably re-adds low end
  });

  it('saturation: drive increases odd-harmonic distortion (analog-ism #2)', () => {
    const measure3rd = (drive: number): number => {
      const core = new LadderCore(FS);
      core.setCutoffHz(20000); // passband
      core.setResonance01(0);
      core.drive = drive;
      const n = 2 * FS;
      const input = new Float32Array(n);
      for (let i = 0; i < n; i++) input[i] = 5 * Math.sin((2 * Math.PI * 100 * i) / FS);
      const out = processAll(core, input);
      const spec = fftMag(out, FS, 32768, FS);
      return db(magAtHz(spec, 300, 3) / magAtHz(spec, 100, 3));
    };
    const clean = measure3rd(1);
    const driven = measure3rd(4);
    expect(driven).toBeGreaterThan(clean + 10); // at least 10 dB more 3rd harmonic
    expect(driven).toBeGreaterThan(-40); // audibly present when driven
  });
});
