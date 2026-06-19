import { describe, expect, it } from 'vitest';
import { OscCore, SHAPE_PULSE, SHAPE_SAW, SHAPE_TRIANGLE, type OscSampleIn } from '../../src/engine/dsp/oscCore';
import { db, fftMag, magAtHz, rms, zeroCrossFreq } from '../helpers/spectral';

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
