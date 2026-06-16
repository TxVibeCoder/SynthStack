/**
 * Shared measurement helpers: rms, fftMag, spectralCentroidSeries,
 * detectOnsets, zeroCrossFreq. Pure — usable from Vitest (Node) now and from the
 * browser offline-audio harness later. FFT backed by fft.js (test-only dep).
 */

import FFT from 'fft.js';

export function rms(buf: ArrayLike<number>, start = 0, end = buf.length): number {
  let sum = 0;
  const n = end - start;
  for (let i = start; i < end; i++) sum += (buf[i] as number) * (buf[i] as number);
  return Math.sqrt(sum / Math.max(1, n));
}

function hann(n: number): Float64Array {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

export interface Spectrum {
  mags: Float64Array; // size/2 bins, linear magnitude
  binHz: number;
}

/** Hann-windowed magnitude spectrum of buf[offset .. offset+size). size must be a power of 2. */
export function fftMag(buf: ArrayLike<number>, sampleRate: number, size = 8192, offset = 0): Spectrum {
  const fft = new FFT(size);
  const windowed = new Array<number>(size);
  const w = hann(size);
  for (let i = 0; i < size; i++) windowed[i] = ((buf[offset + i] as number) ?? 0) * w[i]!;
  const out = fft.createComplexArray();
  fft.realTransform(out, windowed);
  const mags = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) {
    const re = out[2 * i]!;
    const im = out[2 * i + 1]!;
    mags[i] = Math.hypot(re, im);
  }
  return { mags, binHz: sampleRate / size };
}

/** Average of several spectra along the buffer (Welch) for noise measurements. */
export function fftMagAveraged(
  buf: ArrayLike<number>,
  sampleRate: number,
  size = 8192,
  hop = size / 2,
): Spectrum {
  const acc = new Float64Array(size / 2);
  let count = 0;
  for (let off = 0; off + size <= buf.length; off += hop) {
    const { mags } = fftMag(buf, sampleRate, size, off);
    for (let i = 0; i < acc.length; i++) acc[i]! += mags[i]!;
    count++;
  }
  for (let i = 0; i < acc.length; i++) acc[i]! /= Math.max(1, count);
  return { mags: acc, binHz: sampleRate / size };
}

export function magAtHz(spec: Spectrum, hz: number, searchBins = 2): number {
  const center = Math.round(hz / spec.binHz);
  let best = 0;
  for (let i = Math.max(0, center - searchBins); i <= center + searchBins && i < spec.mags.length; i++) {
    if (spec.mags[i]! > best) best = spec.mags[i]!;
  }
  return best;
}

export function db(ratio: number): number {
  return 20 * Math.log10(Math.max(ratio, 1e-12));
}

export function spectralCentroidHz(spec: Spectrum): number {
  let num = 0;
  let den = 0;
  for (let i = 1; i < spec.mags.length; i++) {
    num += i * spec.binHz * spec.mags[i]!;
    den += spec.mags[i]!;
  }
  return den > 0 ? num / den : 0;
}

/** Centroid per window of winS seconds — for sweep / wobble tests. */
export function spectralCentroidSeries(
  buf: ArrayLike<number>,
  sampleRate: number,
  winS = 0.05,
): number[] {
  let size = 1;
  while (size * 2 <= winS * sampleRate) size *= 2;
  const series: number[] = [];
  for (let off = 0; off + size <= buf.length; off += size) {
    series.push(spectralCentroidHz(fftMag(buf, sampleRate, size, off)));
  }
  return series;
}

/** Estimate dominant frequency by zero-crossing count (good for near-sinusoids). */
export function zeroCrossFreq(buf: ArrayLike<number>, sampleRate: number, start = 0, end = buf.length): number {
  let crossings = 0;
  let prev = buf[start] as number;
  for (let i = start + 1; i < end; i++) {
    const cur = buf[i] as number;
    if ((prev <= 0 && cur > 0) || (prev >= 0 && cur < 0)) crossings++;
    prev = cur;
  }
  return (crossings / 2) * (sampleRate / (end - start));
}

/** Simple energy-rise onset detector; returns sample indices. */
export function detectOnsets(
  buf: ArrayLike<number>,
  sampleRate: number,
  thresh = 0.05,
  winS = 0.005,
): number[] {
  const win = Math.max(8, Math.floor(winS * sampleRate));
  const onsets: number[] = [];
  let prevE = 0;
  let armed = true;
  for (let off = 0; off + win <= buf.length; off += win) {
    const e = rms(buf, off, off + win);
    if (armed && e > thresh && e > prevE * 2) {
      onsets.push(off);
      armed = false;
    } else if (e < thresh * 0.5) {
      armed = true;
    }
    prevE = e;
  }
  return onsets;
}
