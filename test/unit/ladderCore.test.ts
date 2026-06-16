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

  it('HP mode passes highs, attenuates lows', () => {
    const core = new LadderCore(FS);
    core.mode = 'HP';
    core.setCutoffHz(2000);
    core.setResonance01(0);
    const out = processAll(core, whiteNoise(4, 11));
    const spec = fftMagAveraged(out.subarray(FS), FS, 8192);
    expect(db(magAtHz(spec, 100, 4) / magAtHz(spec, 8000, 4))).toBeLessThan(-30);
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
