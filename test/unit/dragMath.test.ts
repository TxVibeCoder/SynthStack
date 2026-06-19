import { describe, expect, it } from 'vitest';
import {
  DRAG_FULL_SWEEP_PX,
  FINE_DRAG_FACTOR,
  KNOB_SWEEP_DEG,
  clamp01,
  dragDelta,
  formatValue,
  normToAngle,
  normToValue,
  snapStepped,
  stepCount,
  valueToNorm,
} from '../../src/ui/controls/dragMath';
import type { ControlDef } from '../../data/schema';

const knob = (over: Partial<ControlDef> = {}): ControlDef => ({
  id: 'TEST',
  panelLabel: 'TEST',
  type: 'knob',
  min: 0,
  max: 1,
  default: 0,
  taper: 'lin',
  ...over,
});

const lin10 = knob({ min: 0, max: 10 });
const exp20k = knob({ min: 20, max: 20000, taper: 'exp', unit: 'Hz' });
const sub16 = knob({
  id: 'CAS_SUB_FREQ_1',
  type: 'stepKnob',
  min: 1,
  max: 16,
  default: 1,
  taper: 'stepped',
  steps: 16,
  unit: 'div',
});

describe('dragMath: lin taper', () => {
  it('maps endpoints and midpoint linearly', () => {
    expect(valueToNorm(0, lin10)).toBe(0);
    expect(valueToNorm(10, lin10)).toBe(1);
    expect(valueToNorm(5, lin10)).toBeCloseTo(0.5, 10);
    expect(normToValue(0.25, lin10)).toBeCloseTo(2.5, 10);
  });

  it('round-trips arbitrary values', () => {
    for (const v of [0, 0.1, 2.5, 7.31, 10]) {
      expect(normToValue(valueToNorm(v, lin10), lin10)).toBeCloseTo(v, 10);
    }
  });

  it('clamps at both rails', () => {
    expect(valueToNorm(-3, lin10)).toBe(0);
    expect(valueToNorm(42, lin10)).toBe(1);
    expect(normToValue(-0.2, lin10)).toBe(0);
    expect(normToValue(1.7, lin10)).toBe(10);
  });
});

describe('dragMath: exp taper across 20..20000', () => {
  it('maps endpoints and the geometric midpoint', () => {
    expect(valueToNorm(20, exp20k)).toBe(0);
    expect(valueToNorm(20000, exp20k)).toBeCloseTo(1, 10);
    expect(normToValue(0.5, exp20k)).toBeCloseTo(Math.sqrt(20 * 20000), 2); // 632.456
  });

  it('round-trips across the audible range', () => {
    for (const v of [20, 55, 440, 2500, 12000, 20000]) {
      expect(normToValue(valueToNorm(v, exp20k), exp20k)).toBeCloseTo(v, 6);
    }
  });

  it('equal norm steps give equal frequency ratios', () => {
    const r1 = normToValue(0.35, exp20k) / normToValue(0.25, exp20k);
    const r2 = normToValue(0.85, exp20k) / normToValue(0.75, exp20k);
    expect(r1).toBeCloseTo(r2, 6);
    expect(r1).toBeCloseTo(Math.pow(1000, 0.1), 6); // (max/min)^0.1
  });

  it('clamps at both rails', () => {
    expect(normToValue(2, exp20k)).toBeCloseTo(20000, 8);
    expect(normToValue(-1, exp20k)).toBe(20);
    expect(valueToNorm(1e6, exp20k)).toBeCloseTo(1, 10);
    expect(valueToNorm(1, exp20k)).toBe(0); // below min -> clamp to rail
  });

  it('falls back to lin when min <= 0 or below the 0.001 floor', () => {
    const expZero = knob({ min: 0, max: 10, taper: 'exp' });
    expect(normToValue(0.5, expZero)).toBeCloseTo(5, 10);
    expect(valueToNorm(2.5, expZero)).toBeCloseTo(0.25, 10);

    const expTiny = knob({ min: 0.0005, max: 10, taper: 'exp' });
    expect(normToValue(0.5, expTiny)).toBeCloseTo(5.0, 2); // linear midpoint

    const expAtFloor = knob({ min: 0.001, max: 10, taper: 'exp' });
    expect(normToValue(0.5, expAtFloor)).toBeCloseTo(Math.sqrt(0.001 * 10), 6); // exp active
  });
});

describe('dragMath: stepped 16-step 1..16 knob', () => {
  it('snaps to the nearest integer detent and clamps', () => {
    expect(snapStepped(7.4, sub16)).toBe(7);
    expect(snapStepped(7.6, sub16)).toBe(8);
    expect(snapStepped(1, sub16)).toBe(1);
    expect(snapStepped(0, sub16)).toBe(1);
    expect(snapStepped(99, sub16)).toBe(16);
  });

  it('normToValue lands on detents (snap during drag)', () => {
    expect(normToValue(0, sub16)).toBe(1);
    expect(normToValue(1, sub16)).toBe(16);
    expect(normToValue(0.4, sub16)).toBe(7); // 1 + round(0.4 * 15)
    expect(normToValue(0.02, sub16)).toBe(1); // tiny drag stays on the detent
  });

  it('round-trips every detent', () => {
    for (let k = 1; k <= 16; k++) {
      expect(normToValue(valueToNorm(k, sub16), sub16)).toBeCloseTo(k, 10);
    }
  });

  it('reports step counts (integer fallback without `steps`)', () => {
    expect(stepCount(sub16)).toBe(16);
    expect(stepCount(lin10)).toBeNull();
    expect(stepCount(knob({ min: 0, max: 7, taper: 'stepped' }))).toBe(8);
    expect(snapStepped(3.4, knob({ min: 0, max: 7, taper: 'stepped' }))).toBe(3);
  });
});

describe('dragMath: stepKnob with lin taper is CONTINUOUS (sequencer step knobs)', () => {
  // type 'stepKnob' marks a sequencer STEP's knob, not a detented knob — detents
  // come only from taper 'stepped' / an explicit `steps` count.
  const anvilPitch = knob({
    id: 'ANV_SEQ_PITCH_1',
    type: 'stepKnob',
    min: -5,
    max: 5,
    unit: 'vv',
  });
  const anvilVelocity = knob({
    id: 'ANV_SEQ_VELOCITY_1',
    type: 'stepKnob',
    min: 0,
    max: 5,
    default: 4,
    unit: 'vv',
  });
  const cascadeStep = knob({ id: 'CAS_SEQ1_STEP_1', type: 'stepKnob', min: -1, max: 1 });

  it('reports no detents', () => {
    expect(stepCount(anvilPitch)).toBeNull();
    expect(stepCount(anvilVelocity)).toBeNull();
    expect(stepCount(cascadeStep)).toBeNull();
  });

  it('does not snap Anvil pitch to whole octaves (1 vv/oct)', () => {
    expect(normToValue(0.525, anvilPitch)).toBeCloseTo(0.25, 10);
    expect(snapStepped(0.25, anvilPitch)).toBeCloseTo(0.25, 10); // no-op for continuous defs
    expect(normToValue(valueToNorm(-2.37, anvilPitch), anvilPitch)).toBeCloseTo(-2.37, 10);
  });

  it('does not collapse Cascade SEQ steps to {-1, 0, 1}', () => {
    expect(normToValue(0.6, cascadeStep)).toBeCloseTo(0.2, 10);
    expect(normToValue(valueToNorm(-0.37, cascadeStep), cascadeStep)).toBeCloseTo(-0.37, 10);
  });

  it('readout keeps fractional precision (no integer-detent formatting)', () => {
    expect(formatValue(0.25, anvilPitch)).toBe('0.25 vv');
    expect(formatValue(-2.4, anvilPitch)).toBe('-2.4 vv');
    expect(formatValue(3.5, anvilVelocity)).toBe('3.5 vv');
  });

  it('stepKnob WITH stepped taper + steps stays detented (SUB FREQ style)', () => {
    expect(stepCount(sub16)).toBe(16); // sub16 is type stepKnob + taper stepped + steps 16
    expect(normToValue(0.4, sub16)).toBe(7);
  });
});

describe('dragMath: dragDelta', () => {
  it('mirrors the theme constants (200 px sweep, x0.1 fine)', () => {
    expect(DRAG_FULL_SWEEP_PX).toBe(200);
    expect(FINE_DRAG_FACTOR).toBe(0.1);
  });

  it('200 px = one full sweep, proportional below', () => {
    expect(dragDelta(200, false)).toBe(1);
    expect(dragDelta(20, false)).toBeCloseTo(0.1, 10);
    expect(dragDelta(-100, false)).toBeCloseTo(-0.5, 10);
  });

  it('Shift fine-drag scales by 0.1', () => {
    expect(dragDelta(20, true)).toBeCloseTo(0.01, 10);
    expect(dragDelta(200, true)).toBeCloseTo(0.1, 10);
  });
});

describe('dragMath: normToAngle', () => {
  it('maps 0..1 onto -135..+135 with 0.5 straight up', () => {
    expect(normToAngle(0)).toBe(KNOB_SWEEP_DEG.start);
    expect(normToAngle(0)).toBe(-135);
    expect(normToAngle(1)).toBe(135);
    expect(normToAngle(0.5)).toBeCloseTo(0, 10);
  });

  it('clamps out-of-range norms to the end stops', () => {
    expect(normToAngle(-0.5)).toBe(-135);
    expect(normToAngle(1.5)).toBe(135);
    expect(clamp01(1.5)).toBe(1);
  });
});

describe('dragMath: formatValue', () => {
  const hz = knob({ min: 0.01, max: 20000, unit: 'Hz' });

  it('Hz precision follows magnitude', () => {
    expect(formatValue(440, hz)).toBe('440 Hz');
    expect(formatValue(23.7, hz)).toBe('23.7 Hz');
    expect(formatValue(0.5, hz)).toBe('0.50 Hz');
    expect(formatValue(0.05, hz)).toBe('0.050 Hz');
  });

  it('s / BPM / % / vv / div are unit-aware', () => {
    expect(formatValue(0.003, knob({ unit: 's' }))).toBe('0.003 s');
    expect(formatValue(120, knob({ min: 20, max: 300, unit: 'BPM' }))).toBe('120 BPM');
    expect(formatValue(62.4, knob({ min: 0, max: 100, unit: '%' }))).toBe('62%');
    expect(formatValue(2.5, knob({ min: -5, max: 5, unit: 'vv' }))).toBe('2.5 vv');
    expect(formatValue(7, sub16)).toBe('7 div');
    expect(formatValue(7.4, sub16)).toBe('7 div'); // stepped always shows the detent
  });

  it('scrubs negative zero and handles unitless defs', () => {
    expect(formatValue(-0.0001, knob({ min: -5, max: 5, unit: 'vv' }))).toBe('0.000 vv');
    expect(formatValue(0.5, knob())).toBe('0.50');
  });

  it("'%' defs authored as 0..1 fractions display as 0..100% (Monarch PULSE WIDTH)", () => {
    const pulseWidth = knob({
      id: 'MON_PULSE_WIDTH',
      min: 0.02,
      max: 0.98,
      default: 0.5,
      unit: '%',
    });
    expect(formatValue(0.5, pulseWidth)).toBe('50%');
    expect(formatValue(0.02, pulseWidth)).toBe('2%');
    expect(formatValue(0.98, pulseWidth)).toBe('98%');
    // 0..100-calibrated '%' defs (Monarch SWING) are untouched
    expect(formatValue(62.4, knob({ min: 0, max: 100, unit: '%' }))).toBe('62%');
  });
});

describe('dragMath: NaN / non-finite hardening', () => {
  it('clamp01 coerces every non-finite input to 0', () => {
    expect(clamp01(NaN)).toBe(0);
    expect(clamp01(Infinity)).toBe(0);
    expect(clamp01(-Infinity)).toBe(0);
  });

  it('valueToNorm / normToValue never emit a non-finite number', () => {
    expect(valueToNorm(NaN, lin10)).toBe(0);
    expect(Number.isFinite(normToValue(NaN, lin10))).toBe(true);
    expect(normToValue(NaN, lin10)).toBe(0); // -> min
    expect(Number.isFinite(normToValue(Infinity, exp20k))).toBe(true);
  });

  it('formatValue falls back to the default — never renders "NaN" / "Infinity"', () => {
    expect(formatValue(NaN, lin10)).not.toContain('NaN');
    expect(formatValue(Infinity, exp20k)).not.toContain('Infinity');
    expect(formatValue(NaN, sub16)).not.toContain('NaN');
  });
});
