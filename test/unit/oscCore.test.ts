import { describe, expect, it } from 'vitest';
import {
  OscCore,
  SHAPE_PULSE,
  SHAPE_SAW,
  SHAPE_TRIANGLE,
  WS_SAW,
  WS_SQUARE,
  WS_TRI,
  type OscSampleIn,
} from '../../src/engine/dsp/oscCore';
import { db, fftMag, magAtHz, rms, spectralCentroidHz, zeroCrossFreq } from '../helpers/spectral';

const FS = 48000;

function render(core: OscCore, seconds: number, inp: Partial<OscSampleIn>): Float32Array {
  const n = Math.floor(seconds * FS);
  const out = new Float32Array(n);
  const full: OscSampleIn = {
    baseHz: 440,
    pitchCvVv: 0,
    linFmVv: 0,
    linFmDepthHzPerVv: 0,
    syncIn: 0,
    pulseWidth: 0.5,
    shape: SHAPE_SAW,
    ...inp,
  };
  for (let i = 0; i < n; i++) out[i] = core.processSample(full).out;
  return out;
}

describe('osc.worklet core — polyBLEP (work order §7.2)', () => {
  it('saw at 3 kHz: aliased partials >= 40 dB below the strongest true partial', () => {
    // 3001 Hz instead of exactly 3000 so folded aliases land OFF the true-partial
    // bins; at exactly 3 kHz / 48 kHz every alias hides under a true harmonic and
    // the test would be blind.
    const f0 = 3001;
    const core = new OscCore(FS);
    const buf = render(core, 2, { baseHz: f0, shape: SHAPE_SAW });
    const size = 16384;
    const spec = fftMag(buf, FS, size, FS); // analyze after 1 s
    const binHz = spec.binHz;

    // true partials and their exclusion zones (main lobe + near sidelobes)
    const trueBins = new Set<number>();
    for (let k = 1; k * f0 < FS / 2; k++) {
      const bin = Math.round((k * f0) / binHz);
      for (let d = -10; d <= 10; d++) trueBins.add(bin + d);
    }
    let strongestTrue = 0;
    for (let k = 1; k * f0 < FS / 2; k++) {
      strongestTrue = Math.max(strongestTrue, magAtHz(spec, k * f0));
    }
    // Measure up to the half-band decimator's transition edge (23.4 kHz). The 8th
    // harmonic (24,008 Hz) folds 16 Hz across Nyquist to 23,992 Hz — inside the
    // transition band, where no realizable decimator attenuates, and 16 Hz from its
    // true position at the top of the audible band. Audible-band aliases are the
    // acceptance target.
    let worstAlias = 0;
    const lowBinGuard = Math.round(50 / binHz); // skip DC/leakage skirt
    const highBinGuard = Math.round(23400 / binHz);
    for (let i = lowBinGuard; i < highBinGuard; i++) {
      if (trueBins.has(i)) continue;
      if (spec.mags[i]! > worstAlias) worstAlias = spec.mags[i]!;
    }
    expect(db(worstAlias / strongestTrue)).toBeLessThanOrEqual(-40);
  });

  it('pulse width controls duty cycle and PW at the rail silences output', () => {
    const core = new OscCore(FS);
    const buf = render(core, 0.5, { baseHz: 100, shape: SHAPE_PULSE, pulseWidth: 0.25 });
    // 25% duty: mean = 0.25·(+5) + 0.75·(−5) = −2.5 vv
    let mean = 0;
    for (const v of buf) mean += v;
    mean /= buf.length;
    expect(mean).toBeGreaterThan(-2.8);
    expect(mean).toBeLessThan(-2.2);

    const silent = render(new OscCore(FS), 0.2, { baseHz: 100, shape: SHAPE_PULSE, pulseWidth: 0.01 });
    // 1% duty ~ silent-ish but not zero; the authentic "silence" happens at 0/100%
    // which the engine reaches by clamping — verify DC-ness via tiny AC energy
    const ac = rms(silent.map((v) => v + 4.9));
    expect(ac).toBeLessThan(1.5);
  });

  it('pitch CV is exponential: +1 vv doubles frequency', () => {
    const a = render(new OscCore(FS), 1, { baseHz: 220, shape: SHAPE_TRIANGLE, pitchCvVv: 0 });
    const b = render(new OscCore(FS), 1, { baseHz: 220, shape: SHAPE_TRIANGLE, pitchCvVv: 1 });
    const fa = zeroCrossFreq(a, FS, FS / 2);
    const fb = zeroCrossFreq(b, FS, FS / 2);
    expect(fa).toBeCloseTo(220, -1);
    expect(fb / fa).toBeCloseTo(2, 1);
  });

  it('hard sync locks the slave fundamental to the master', () => {
    const master = new OscCore(FS);
    const slave = new OscCore(FS);
    const n = FS;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const m = master.processSample({
        baseHz: 220, pitchCvVv: 0, linFmVv: 0, linFmDepthHzPerVv: 0,
        syncIn: 0, pulseWidth: 0.5, shape: SHAPE_SAW,
      });
      out[i] = slave.processSample({
        baseHz: 311, pitchCvVv: 0, linFmVv: 0, linFmDepthHzPerVv: 0,
        syncIn: m.syncOut, pulseWidth: 0.5, shape: SHAPE_SAW,
      }).out;
    }
    // synced slave spectrum is harmonic on the MASTER's f0
    const spec = fftMag(out, FS, 16384, 1024);
    const atMaster = magAtHz(spec, 220);
    const atSlaveF0 = magAtHz(spec, 311, 1);
    expect(atMaster).toBeGreaterThan(0);
    // energy at 311 Hz (non-multiple of 220) should be well below the 220 partial set
    expect(db(atSlaveF0 / atMaster)).toBeLessThan(-6);
  });

  it('linear FM shifts frequency by depth·vv linearly', () => {
    const buf = render(new OscCore(FS), 1, {
      baseHz: 440, shape: SHAPE_TRIANGLE, linFmVv: 2, linFmDepthHzPerVv: 50,
    });
    expect(zeroCrossFreq(buf, FS, FS / 2)).toBeCloseTo(540, -1.5);
  });

  it('output level is ±5 vv', () => {
    const buf = render(new OscCore(FS), 0.5, { baseHz: 440, shape: SHAPE_SAW });
    let min = Infinity;
    let max = -Infinity;
    for (const v of buf) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    expect(max).toBeGreaterThan(4.5);
    expect(max).toBeLessThan(5.6); // polyBLEP overshoot allowance
    expect(min).toBeLessThan(-4.5);
    expect(min).toBeGreaterThan(-5.6);
  });

  // ---- manual-spec locks (Workstream C) ------------------------------------------------

  it('narrow pulse at a high pitch: aliased partials >= 40 dB down across the audible band (C7)', () => {
    // A 10% pulse at ~2 kHz is the worst real-world aliaser (richest high-harmonic content).
    const f0 = 2001; // off-grid so folded aliases do not hide under true partials
    const buf = render(new OscCore(FS), 2, { baseHz: f0, shape: SHAPE_PULSE, pulseWidth: 0.1 });
    const size = 16384;
    const spec = fftMag(buf, FS, size, FS);
    const binHz = spec.binHz;
    const trueBins = new Set<number>();
    for (let k = 1; k * f0 < FS / 2; k++) {
      const bin = Math.round((k * f0) / binHz);
      for (let d = -10; d <= 10; d++) trueBins.add(bin + d);
    }
    let strongestTrue = 0;
    for (let k = 1; k * f0 < FS / 2; k++) strongestTrue = Math.max(strongestTrue, magAtHz(spec, k * f0));
    let worstAlias = 0;
    const lowGuard = Math.round(50 / binHz);
    const highGuard = Math.round(23400 / binHz); // half-band transition edge (same scope as the saw test)
    for (let i = lowGuard; i < highGuard; i++) {
      if (trueBins.has(i)) continue;
      if (spec.mags[i]! > worstAlias) worstAlias = spec.mags[i]!;
    }
    expect(db(worstAlias / strongestTrue)).toBeLessThanOrEqual(-40);
  });

  it('audio-rate linear FM produces sidebands at carrier ± modulator (C6 — FM depth sanity)', () => {
    // Carrier 600 Hz, a 200 Hz sine modulator at the Monarch LIN-FM depth (150 Hz/vv, ±1 vv).
    // β = depth·A/mod = 150/200 = 0.75 → first sidebands ≈ 0.4× carrier (Bessel J1/J0). The manuals
    // give NO Hz figure for FM depth; this LOCKS the chosen 150/200 constants by their modulation index.
    const core = new OscCore(FS);
    const n = 2 * FS;
    const carrier = 600;
    const mod = 200;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const lfm = Math.sin((2 * Math.PI * mod * i) / FS);
      out[i] = core.processSample({
        baseHz: carrier, pitchCvVv: 0, linFmVv: lfm, linFmDepthHzPerVv: 150,
        syncIn: 0, pulseWidth: 0.5, shape: SHAPE_TRIANGLE,
      }).out;
    }
    const spec = fftMag(out, FS, 16384, FS);
    const car = magAtHz(spec, carrier, 3);
    const upper = magAtHz(spec, carrier + mod, 3);
    const lower = magAtHz(spec, carrier - mod, 3);
    expect(db(upper / car)).toBeGreaterThan(-15); // clear first sidebands (β ≈ 0.75)
    expect(db(lower / car)).toBeGreaterThan(-15);
  });
});

// ---- continuous waveshape morph + wavefolder (Courier headline DSP) -------------------

const FFT_SIZE = 16384;

/** Magnitude at the k-th harmonic of f0 (peak within ±2 bins). */
function harm(spec: ReturnType<typeof fftMag>, f0: number, k: number): number {
  return magAtHz(spec, k * f0, 2);
}

/** Sum of |H2..H20| magnitudes — absolute high-harmonic energy above the fundamental. */
function highHarmEnergy(buf: Float32Array, f0: number): number {
  const spec = fftMag(buf, FS, FFT_SIZE, FS);
  let sum = 0;
  for (let k = 2; k <= 20 && k * f0 < FS / 2; k++) sum += harm(spec, f0, k);
  return sum;
}

describe('osc.worklet core — waveshape morph + wavefolder (A2)', () => {
  it('folding monotonically increases harmonic content as waveshape goes WS_TRI -> 0', () => {
    // At WS_TRI the wave is a clean triangle (no fold); driving waveshape toward 0 deepens
    // the sine-fold, which must add brightness monotonically. Measure BOTH spectral centroid
    // and absolute high-harmonic energy — both should rise as we fold harder.
    const f0 = 220;
    const steps = [WS_TRI, 0.24, 0.21, 0.18, 0.15, 0.12, 0.09, 0.06, 0.03, 0.0];
    let prevCentroid = -1;
    let prevEnergy = -1;
    for (const ws of steps) {
      const buf = render(new OscCore(FS), 1.5, { baseHz: f0, waveshape: ws });
      const centroid = spectralCentroidHz(fftMag(buf, FS, FFT_SIZE, FS));
      const energy = highHarmEnergy(buf, f0);
      // strictly increasing (small tolerance for FFT bin noise)
      expect(centroid).toBeGreaterThanOrEqual(prevCentroid - 2);
      expect(energy).toBeGreaterThanOrEqual(prevEnergy - 1);
      prevCentroid = centroid;
      prevEnergy = energy;
    }
    // sanity: the max-fold wave is meaningfully brighter than the plain triangle
    const tri = render(new OscCore(FS), 1.5, { baseHz: f0, waveshape: WS_TRI });
    const fold = render(new OscCore(FS), 1.5, { baseHz: f0, waveshape: 0 });
    expect(highHarmEnergy(fold, f0)).toBeGreaterThan(highHarmEnergy(tri, f0) + 1000);
  });

  it('morph endpoints hit recognizable triangle / saw / square spectra', () => {
    const f0 = 220;
    const triBuf = render(new OscCore(FS), 1.5, { baseHz: f0, waveshape: WS_TRI });
    const sawBuf = render(new OscCore(FS), 1.5, { baseHz: f0, waveshape: WS_SAW });
    const sqBuf = render(new OscCore(FS), 1.5, { baseHz: f0, waveshape: WS_SQUARE });
    const triS = fftMag(triBuf, FS, FFT_SIZE, FS);
    const sawS = fftMag(sawBuf, FS, FFT_SIZE, FS);
    const sqS = fftMag(sqBuf, FS, FFT_SIZE, FS);

    // Triangle: odd harmonics only, even harmonics strongly suppressed.
    expect(db(harm(triS, f0, 2) / harm(triS, f0, 1))).toBeLessThan(-30);
    expect(db(harm(triS, f0, 4) / harm(triS, f0, 1))).toBeLessThan(-30);
    // Triangle rolls off as 1/k^2 — H3 is weak (~1/9).
    expect(harm(triS, f0, 3) / harm(triS, f0, 1)).toBeLessThan(0.2);

    // Saw: all harmonics present, ~1/k roll-off (H2 is the strongest overtone, ~0.5).
    expect(harm(sawS, f0, 2) / harm(sawS, f0, 1)).toBeGreaterThan(0.3);
    expect(harm(sawS, f0, 3) / harm(sawS, f0, 1)).toBeGreaterThan(0.2);

    // Square: odd harmonics only, even strongly suppressed; H3 ~ 1/3 (much stronger than the triangle's H3).
    expect(db(harm(sqS, f0, 2) / harm(sqS, f0, 1))).toBeLessThan(-30);
    expect(db(harm(sqS, f0, 4) / harm(sqS, f0, 1))).toBeLessThan(-30);
    expect(harm(sqS, f0, 3) / harm(sqS, f0, 1)).toBeGreaterThan(0.25);
  });

  it('sub morph hits recognizable triangle and square spectra (tri -> square -> PWM)', () => {
    // The sub-osc runs one octave below the main and is mixed at half level. Isolate the
    // pure sub by subtracting a main-only render: with the sub engaged the main drops to
    // 0.5×, so (main+sub) − 0.5×(main-only) = 0.5×sub exactly (same deterministic phase seed).
    const baseHz = 220;
    const subF = baseHz / 2; // 110 Hz
    function subOnly(subWave: number): Float32Array {
      const main = render(new OscCore(FS), 1.5, { baseHz, waveshape: WS_SAW });
      const both = render(new OscCore(FS), 1.5, { baseHz, waveshape: WS_SAW, subWave });
      const out = new Float32Array(main.length);
      for (let i = 0; i < out.length; i++) out[i] = both[i]! - 0.5 * main[i]!;
      return out;
    }
    const triS = fftMag(subOnly(0), FS, FFT_SIZE, FS); // subWave = 0 -> triangle
    const sqS = fftMag(subOnly(0.5), FS, FFT_SIZE, FS); // subWave = 0.5 -> square
    const pwmS = fftMag(subOnly(1), FS, FFT_SIZE, FS); // subWave = 1 -> narrow PWM pulse

    // Both tri and square are odd-only; square's H3 is far stronger than the triangle's.
    expect(db(harm(triS, subF, 2) / harm(triS, subF, 1))).toBeLessThan(-25);
    expect(harm(triS, subF, 3) / harm(triS, subF, 1)).toBeLessThan(0.2);
    expect(db(harm(sqS, subF, 2) / harm(sqS, subF, 1))).toBeLessThan(-25);
    expect(harm(sqS, subF, 3) / harm(sqS, subF, 1)).toBeGreaterThan(0.25);
    // PWM (narrow pulse) breaks the odd-only symmetry: strong even harmonics appear.
    expect(harm(pwmS, subF, 2) / harm(pwmS, subF, 1)).toBeGreaterThan(0.5);
  });

  it('no NaN/Inf anywhere across the full 0..1 waveshape and subWave sweep', () => {
    const allFinite = (buf: Float32Array): boolean => {
      for (const v of buf) if (!Number.isFinite(v)) return false;
      return true;
    };
    let bad = 0;
    for (let i = 0; i <= 20; i++) {
      const ws = i / 20;
      // main morph alone, and combined with three sub settings
      for (const subWave of [undefined, 0, 0.5, 1] as const) {
        const inp: Partial<OscSampleIn> = { baseHz: 330, waveshape: ws };
        if (subWave !== undefined) inp.subWave = subWave;
        if (!allFinite(render(new OscCore(FS), 0.05, inp))) bad++;
      }
      // subWave swept on its own (discrete-shape main path, waveshape undefined)
      if (!allFinite(render(new OscCore(FS), 0.05, { baseHz: 330, shape: SHAPE_SAW, subWave: ws }))) bad++;
    }
    expect(bad).toBe(0);
  });

  it('max-fold aliasing stays >= 40 dB below the strongest true partial across the audible band', () => {
    // The deepest fold (waveshape = 0) is the richest aliaser. Off-grid f0 so folded aliases
    // do not hide under true partials; same −40 dB audible-band acceptance as the saw test.
    const f0 = 2001;
    const buf = render(new OscCore(FS), 2, { baseHz: f0, waveshape: 0 });
    const spec = fftMag(buf, FS, FFT_SIZE, FS);
    const binHz = spec.binHz;
    const trueBins = new Set<number>();
    for (let k = 1; k * f0 < FS / 2; k++) {
      const bin = Math.round((k * f0) / binHz);
      for (let d = -10; d <= 10; d++) trueBins.add(bin + d);
    }
    let strongestTrue = 0;
    for (let k = 1; k * f0 < FS / 2; k++) strongestTrue = Math.max(strongestTrue, magAtHz(spec, k * f0));
    let worstAlias = 0;
    const lowGuard = Math.round(50 / binHz);
    const highGuard = Math.round(23400 / binHz);
    for (let i = lowGuard; i < highGuard; i++) {
      if (trueBins.has(i)) continue;
      if (spec.mags[i]! > worstAlias) worstAlias = spec.mags[i]!;
    }
    expect(db(worstAlias / strongestTrue)).toBeLessThanOrEqual(-40);
  });

  it('morph output stays within the ±5 vv rail (with modest fold/morph overshoot)', () => {
    // sweep the whole morph; the band-limited blends can overshoot ±5 slightly (polyBLEP +
    // the sine-fold), but must stay bounded well under runaway.
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i <= 20; i++) {
      const buf = render(new OscCore(FS), 0.2, { baseHz: 220, waveshape: i / 20 });
      for (const v of buf) {
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    expect(max).toBeLessThan(6.0);
    expect(min).toBeGreaterThan(-6.0);
  });
});
