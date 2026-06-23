import { describe, expect, it } from 'vitest';
import {
  COURIER_MOD_TARGETS,
  MOD_TARGETS,
  findModTarget,
  modGain,
  type ModTargetSpec,
} from '../../src/engine/modRouter';

describe('modRouter (pure Courier mod-matrix routing core)', () => {
  it('exposes exactly the 6 supported COU_ targets', () => {
    expect(COURIER_MOD_TARGETS).toEqual([
      'COU_CUTOFF',
      'COU_TUNE',
      'COU_OSC2_FREQ',
      'COU_OSC1_WAVESHAPE',
      'COU_OSC2_WAVESHAPE',
      'COU_SUB_WAVE',
    ]);
    expect(COURIER_MOD_TARGETS).toEqual(MOD_TARGETS.map((t) => t.controlId));
  });

  it('modGain(depth, spec) === clamp(depth,-1,1) * spec.scale for every target', () => {
    for (const spec of MOD_TARGETS) {
      expect(modGain(0, spec)).toBe(0);
      expect(modGain(1, spec)).toBe(spec.scale);
      expect(modGain(-1, spec)).toBe(-spec.scale);
      expect(modGain(0.5, spec)).toBeCloseTo(0.5 * spec.scale, 12);
    }
  });

  it('depth=1 is musically scaled per target (cutoff 5, tune 1, sub-wave 0.2)', () => {
    expect(modGain(1, findModTarget('COU_CUTOFF')!)).toBe(5);
    expect(modGain(1, findModTarget('COU_TUNE')!)).toBe(1);
    expect(modGain(1, findModTarget('COU_OSC2_FREQ')!)).toBe(1);
    expect(modGain(1, findModTarget('COU_SUB_WAVE')!)).toBeCloseTo(0.2, 12);
    expect(modGain(1, findModTarget('COU_OSC1_WAVESHAPE')!)).toBeCloseTo(0.2, 12);
    expect(modGain(1, findModTarget('COU_OSC2_WAVESHAPE')!)).toBeCloseTo(0.2, 12);
  });

  it('clamps out-of-range depth to +-scale', () => {
    const cutoff = findModTarget('COU_CUTOFF')!;
    expect(modGain(2, cutoff)).toBe(5); // clamp 2 -> 1 -> 5
    expect(modGain(-2, cutoff)).toBe(-5); // clamp -2 -> -1 -> -5
    expect(modGain(100, cutoff)).toBe(5);
  });

  it('findModTarget returns the spec for each of the 6 ids', () => {
    for (const id of COURIER_MOD_TARGETS) {
      const spec = findModTarget(id);
      expect(spec).toBeDefined();
      expect((spec as ModTargetSpec).controlId).toBe(id);
    }
  });

  it('findModTarget excludes switches / non-modulatable controls (undefined)', () => {
    expect(findModTarget('COU_FILTER_MODE')).toBeUndefined();
    expect(findModTarget('COU_LFO1_DEST')).toBeUndefined();
    expect(findModTarget('COU_NOT_A_CONTROL')).toBeUndefined();
  });
});
