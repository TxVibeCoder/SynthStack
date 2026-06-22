import { describe, expect, it } from 'vitest';
import { encodeWav, peaks, regionFrames, trimAndFade } from '../../src/engine/sampleEdit';

const ramp = (n: number): Float32Array => Float32Array.from({ length: n }, (_, i) => i / n);
const sine = (n: number, cyclesPerN = 4): Float32Array =>
  Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * cyclesPerN * i) / n));

describe('sampleEdit — regionFrames', () => {
  it('orders, clamps, and enforces a 2-frame minimum', () => {
    expect(regionFrames(100, 0.25, 0.75)).toEqual({ start: 25, end: 75 });
    expect(regionFrames(100, 0.8, 0.2)).toEqual({ start: 20, end: 80 }); // reversed -> ordered
    expect(regionFrames(100, -1, 2)).toEqual({ start: 0, end: 100 }); // clamped to [0,1]
    const tiny = regionFrames(100, 0.5, 0.5);
    expect(tiny.end - tiny.start).toBeGreaterThanOrEqual(2);
  });
});

describe('sampleEdit — trimAndFade', () => {
  it('slices to the region length and never mutates the input', () => {
    const ch = ramp(1000);
    const before = ch.slice();
    const [out] = trimAndFade([ch], 48000, 0.2, 0.6, 0);
    expect(out!.length).toBe(600 - 200);
    expect(ch).toEqual(before); // pure
  });

  it('fades both ends toward zero (click-free seam) while preserving the middle', () => {
    const n = 4800;
    const ch = sine(n); // full-scale sine
    const fadeMs = 5; // 5 ms @ 48k = 240 frames
    const [out] = trimAndFade([ch], 48000, 0, 1, fadeMs);
    const fadeN = Math.floor((fadeMs / 1000) * 48000);
    // first and last samples are scaled by the smallest fade gain -> near zero
    expect(Math.abs(out![0]!)).toBeLessThan(Math.abs(ch[0]!) + 0.02);
    expect(Math.abs(out![0]!)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(out![out!.length - 1]!)).toBeLessThanOrEqual(0.05);
    // a sample WELL past the fade region equals the source (untouched middle)
    const mid = fadeN + 50;
    expect(out![mid]!).toBeCloseTo(ch[mid]!, 6);
  });

  it('clamps the fade to at most half the region (fades never overlap)', () => {
    const ch = sine(1000);
    // ask for a 1 s fade on a tiny region — must not throw or produce NaN
    const [out] = trimAndFade([ch], 48000, 0.4, 0.45, 1000);
    expect(out!.length).toBeGreaterThanOrEqual(2);
    for (const v of out!) expect(Number.isFinite(v)).toBe(true);
  });

  it('handles every channel independently', () => {
    const a = ramp(800);
    const b = sine(800);
    const out = trimAndFade([a, b], 48000, 0.1, 0.9, 1);
    expect(out).toHaveLength(2);
    expect(out[0]!.length).toBe(out[1]!.length);
  });
});

describe('sampleEdit — peaks', () => {
  it('returns one min/max pair per bucket spanning the extremes', () => {
    const ch = sine(2000);
    const { min, max } = peaks(ch, 64);
    expect(min.length).toBe(64);
    expect(max.length).toBe(64);
    for (let i = 0; i < 64; i++) {
      expect(min[i]!).toBeLessThanOrEqual(0);
      expect(max[i]!).toBeGreaterThanOrEqual(0);
    }
    // a full-scale sine reaches near ±1 somewhere
    expect(Math.max(...max)).toBeGreaterThan(0.9);
    expect(Math.min(...min)).toBeLessThan(-0.9);
  });

  it('is safe on empty input', () => {
    const { min, max } = peaks(new Float32Array(0), 10);
    expect(min.length).toBe(10);
    expect(max.every((v) => v === 0)).toBe(true);
  });
});

describe('sampleEdit — encodeWav', () => {
  it('writes a valid 16-bit PCM WAV header for the channel data', () => {
    const sr = 44100;
    const ch = sine(100);
    const buf = encodeWav([ch], sr);
    const view = new DataView(buf);
    const str = (off: number, n: number) =>
      String.fromCharCode(...Array.from({ length: n }, (_, i) => view.getUint8(off + i)));
    expect(str(0, 4)).toBe('RIFF');
    expect(str(8, 4)).toBe('WAVE');
    expect(str(12, 4)).toBe('fmt ');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(sr);
    expect(view.getUint16(34, true)).toBe(16); // bits/sample
    expect(str(36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(100 * 2); // dataSize = frames * blockAlign
    expect(buf.byteLength).toBe(44 + 100 * 2);
  });

  it('interleaves stereo and clamps out-of-range samples', () => {
    const left = Float32Array.from([1.5, -2, 0]); // out of range -> clamps to +1 / -1
    const right = Float32Array.from([0, 0.5, -0.5]);
    const buf = encodeWav([left, right], 48000);
    const view = new DataView(buf);
    expect(view.getUint16(22, true)).toBe(2); // stereo
    expect(view.getUint32(40, true)).toBe(3 * 2 * 2); // 3 frames * 2ch * 2 bytes
    // frame 0: L clamps to +1 (0x7fff), R = 0
    expect(view.getInt16(44, true)).toBe(0x7fff);
    expect(view.getInt16(46, true)).toBe(0);
    // frame 1: L clamps to -1 (-0x8000)
    expect(view.getInt16(48, true)).toBe(-0x8000);
  });
});
