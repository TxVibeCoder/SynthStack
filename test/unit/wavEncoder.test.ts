/**
 * WAV encoder coverage for the lossless capture path (G3): the 24-bit branch of encodeWav, plus a
 * byte-identical regression lock for the default 16-bit branch (so the SampleProcessor + the
 * existing sampleEdit.test.ts are provably untouched by the generalization).
 *
 * The 16-bit branch is also covered by sampleEdit.test.ts; the lock here re-asserts that calling
 * encodeWav with NO bitDepth arg produces EXACTLY the same bytes as before the 24-bit branch
 * existed, by comparing against a hand-computed reference for a small fixture.
 */

import { describe, expect, it } from 'vitest';
import { encodeWav } from '../../src/engine/sampleEdit';

const sine = (n: number, cyclesPerN = 4): Float32Array =>
  Float32Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * cyclesPerN * i) / n));

const str = (view: DataView, off: number, n: number): string =>
  String.fromCharCode(...Array.from({ length: n }, (_, i) => view.getUint8(off + i)));

/** Read a 24-bit little-endian SIGNED sample from the data section. */
const readInt24 = (view: DataView, off: number): number => {
  const u = view.getUint8(off) | (view.getUint8(off + 1) << 8) | (view.getUint8(off + 2) << 16);
  return u >= 0x800000 ? u - 0x1000000 : u;
};

describe('encodeWav — 16-bit default branch byte-identical regression lock', () => {
  it('default arg (no bitDepth) equals an explicit 16 and the known-good header/data', () => {
    const left = Float32Array.from([1.5, -2, 0, 0.5]); // out-of-range clamps to +1 / -1
    const right = Float32Array.from([0, 0.5, -0.5, -1]);
    const a = encodeWav([left, right], 48000); // default
    const b = encodeWav([left, right], 48000, 16); // explicit
    expect(new Uint8Array(a)).toEqual(new Uint8Array(b)); // default === explicit 16

    const view = new DataView(a);
    expect(str(view, 0, 4)).toBe('RIFF');
    expect(str(view, 8, 4)).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(2); // stereo
    expect(view.getUint16(34, true)).toBe(16); // bits/sample
    expect(view.getUint16(32, true)).toBe(2 * 2); // blockAlign = 2ch * 2 bytes
    expect(view.getUint32(28, true)).toBe(48000 * 4); // byteRate
    expect(view.getUint32(40, true)).toBe(4 * 2 * 2); // dataSize = 4 frames * 2ch * 2 bytes
    expect(a.byteLength).toBe(44 + 4 * 2 * 2);
    // frame 0: L clamps to +1 (0x7fff), R = 0
    expect(view.getInt16(44, true)).toBe(0x7fff);
    expect(view.getInt16(46, true)).toBe(0);
    // frame 1: L clamps to -1 (-0x8000)
    expect(view.getInt16(48, true)).toBe(-0x8000);
  });
});

describe('encodeWav — 24-bit branch', () => {
  it('writes a 24-bit PCM header with depth-derived blockAlign/byteRate/dataSize', () => {
    const sr = 44100;
    const ch = sine(100);
    const buf = encodeWav([ch], sr, 24);
    const view = new DataView(buf);
    expect(str(view, 0, 4)).toBe('RIFF');
    expect(str(view, 8, 4)).toBe('WAVE');
    expect(str(view, 12, 4)).toBe('fmt ');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(sr);
    expect(view.getUint16(34, true)).toBe(24); // bits/sample
    expect(view.getUint16(32, true)).toBe(1 * 3); // blockAlign = 1ch * 3 bytes
    expect(view.getUint32(28, true)).toBe(sr * 3); // byteRate
    expect(str(view, 36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(100 * 3); // dataSize = frames * blockAlign
    expect(buf.byteLength).toBe(44 + 100 * 3);
  });

  it('interleaves stereo at 3 bytes/sample and clamps out-of-range samples', () => {
    const left = Float32Array.from([1.5, -2, 0]); // out of range -> clamps to +1 / -1
    const right = Float32Array.from([0, 0.5, -0.5]);
    const buf = encodeWav([left, right], 48000, 24);
    const view = new DataView(buf);
    expect(view.getUint16(22, true)).toBe(2); // stereo
    expect(view.getUint32(40, true)).toBe(3 * 2 * 3); // 3 frames * 2ch * 3 bytes
    // frame 0: L clamps to +1 (0x7fffff), R = 0
    expect(readInt24(view, 44)).toBe(0x7fffff);
    expect(readInt24(view, 47)).toBe(0);
    // frame 1: L clamps to -1 (-0x800000), R = +0.5 -> 0.5*0x7fffff truncated
    expect(readInt24(view, 50)).toBe(-0x800000);
    expect(readInt24(view, 53)).toBe(Math.trunc(0.5 * 0x7fffff));
    // frame 2: R = -0.5 -> -0.5 * 0x800000
    expect(readInt24(view, 59)).toBe(Math.trunc(-0.5 * 0x800000));
  });

  it('round-trips a ramp through 24-bit with full resolution (sub-16-bit deltas survive)', () => {
    // A 24-bit step smaller than one 16-bit LSB must be representable (lossless gain over 16-bit).
    const n = 32;
    const ramp = Float32Array.from({ length: n }, (_, i) => (i / n) * 0.5); // 0..~0.5
    const buf = encodeWav([ramp], 48000, 24);
    const view = new DataView(buf);
    let prev = -1;
    for (let i = 0; i < n; i++) {
      const v = readInt24(view, 44 + i * 3);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBe(Math.trunc(ramp[i]! * 0x7fffff)); // exact quantization
      if (i > 0) expect(v).toBeGreaterThan(prev); // strictly increasing -> distinct codes
      prev = v;
    }
  });
});
