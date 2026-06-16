import { describe, expect, it } from 'vitest';
import { nextQuantizeMode, quantizeHz, quantizeVv, QUANTIZE_CYCLE } from '../../src/engine/quantize';

describe('quantizer (work order §11.1, D3)', () => {
  it('OFF passes through', () => {
    expect(quantizeVv(0.123456, 'OFF')).toBe(0.123456);
  });

  it('12-ET snaps to the nearest semitone', () => {
    expect(quantizeVv(0.04, 'ET12')).toBeCloseTo(0, 10); // C
    expect(quantizeVv(0.0625, 'ET12')).toBeCloseTo(1 / 12, 10); // C#
    expect(quantizeVv(-0.04, 'ET12')).toBeCloseTo(0, 10);
    expect(quantizeVv(1.49 / 12, 'ET12')).toBeCloseTo(1 / 12, 10);
  });

  it('a pitch ramp through 12-ET hits only semitone values', () => {
    for (let vv = -2; vv <= 2; vv += 0.013) {
      const q = quantizeVv(vv, 'ET12');
      const semis = q * 12;
      expect(Math.abs(semis - Math.round(semis))).toBeLessThan(1e-9);
      expect(Math.abs(q - vv)).toBeLessThanOrEqual(0.5 / 12 + 1e-9); // never further than half a semitone
    }
  });

  it('8-ET snaps to equal-tempered major-scale degrees', () => {
    const degrees = [0, 2, 4, 5, 7, 9, 11].map((s) => s / 12);
    for (let vv = 0; vv < 1; vv += 0.017) {
      const q = quantizeVv(vv, 'ET8');
      const frac = q - Math.floor(q);
      const ok = degrees.some((d) => Math.abs(frac - d) < 1e-9) || Math.abs(frac) < 1e-9;
      expect(ok, `vv=${vv} -> ${q}`).toBe(true);
    }
    // F# (6 semitones) is not in the major scale: 0.5 vv snaps to F or G
    const q = quantizeVv(0.5, 'ET8');
    expect([5 / 12, 7 / 12]).toContainEqual(q);
  });

  it('12-JI snaps to the 5-limit chromatic set', () => {
    // a just major third above C4: ratio 5/4
    const thirdVv = Math.log2(5 / 4);
    expect(quantizeVv(thirdVv + 0.01, 'JI12')).toBeCloseTo(thirdVv, 10);
    // a just fifth: 3/2
    const fifthVv = Math.log2(3 / 2);
    expect(quantizeVv(fifthVv - 0.01, 'JI12')).toBeCloseTo(fifthVv, 10);
  });

  it('8-JI: just major scale plus octave fold', () => {
    const set = [1, 9 / 8, 5 / 4, 4 / 3, 3 / 2, 5 / 3, 15 / 8].map((r) => Math.log2(r));
    for (let vv = 0; vv < 2; vv += 0.019) {
      const q = quantizeVv(vv, 'JI8');
      const frac = q - Math.floor(q);
      const ok = set.some((d) => Math.abs(frac - d) < 1e-9) || Math.abs(frac) < 1e-9;
      expect(ok, `vv=${vv} -> ${q}`).toBe(true);
    }
  });

  it('octave boundaries: values just below an octave snap up to it', () => {
    expect(quantizeVv(0.99, 'JI12')).toBeCloseTo(1, 10);
    expect(quantizeVv(1.97 / 2, 'ET8')).toBeCloseTo(1, 10);
    expect(quantizeVv(-0.02, 'JI8')).toBeCloseTo(0, 10);
  });

  it('quantizeHz works against the C-rooted grid (C4 = 261.63)', () => {
    expect(quantizeHz(265, 'ET12')).toBeCloseTo(261.63, 1);
    expect(quantizeHz(523, 'ET12')).toBeCloseTo(523.26, 0);
    expect(quantizeHz(391, 'JI12')).toBeCloseTo(261.63 * 1.5, 0); // just G
  });

  it('button cycles Off -> 12-ET -> 8-ET -> 12-JI -> 8-JI -> Off', () => {
    let mode = QUANTIZE_CYCLE[0]!;
    const seen = [mode];
    for (let i = 0; i < 5; i++) {
      mode = nextQuantizeMode(mode);
      seen.push(mode);
    }
    expect(seen).toEqual(['OFF', 'ET12', 'ET8', 'JI12', 'JI8', 'OFF']);
  });
});
