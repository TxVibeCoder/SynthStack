import { describe, expect, it } from 'vitest';
import {
  clamp,
  cutoffHz,
  anvilStepRateHz,
  equalPowerXfade,
  expKnob,
  expKnob01,
  lfoRateHz,
  monarchStepDurS,
  monarchVcoHz,
  mixPosition01,
  pulseWidth01,
  resonance01,
  cascadeRhythmDivision,
  cascadeSeqOctRange,
  cascadeSubDivider,
  cascadeTempoHz,
  cascadeVcoKnobHz,
  swingOffsetS,
  vcaGain,
  velocityToVv,
  VELOCITY_VV_MAX,
} from '../../src/engine/units';

describe('param adapters (work order §7.5, D8)', () => {
  it('Monarch VCO: 261.63 Hz at all-zero, clamped 8 Hz–8 kHz with ±5 vv CV', () => {
    expect(monarchVcoHz(0, 0, 0, 0)).toBeCloseTo(261.63, 1);
    expect(monarchVcoHz(1, 0, 0, 0)).toBeCloseTo(523.26, 1); // knob +1 = +1 octave
    expect(monarchVcoHz(0, 5, 0, 0)).toBe(8000); // clamp top
    expect(monarchVcoHz(0, -5, 0, -5)).toBe(8); // clamp bottom
  });

  it('cutoff: 20 Hz–20 kHz over the knob, 1 vv = 1 octave', () => {
    expect(cutoffHz(0, 0)).toBeCloseTo(20, 0);
    expect(cutoffHz(1, 0)).toBeCloseTo(20480, -2);
    expect(cutoffHz(0.5, 1) / cutoffHz(0.5, 0)).toBeCloseTo(2, 5);
    expect(cutoffHz(0.5, -5)).toBeCloseTo(cutoffHz(0.5, 0) / 32, 0);
  });

  it('resonance: ±5 vv sweeps full range at center knob', () => {
    expect(resonance01(0.5, 5)).toBe(1);
    expect(resonance01(0.5, -5)).toBe(0);
    expect(resonance01(0.3, 0)).toBeCloseTo(0.3, 6);
  });

  it('LFO rate: 0.1–350 Hz knob, 600 Hz ceiling with CV', () => {
    expect(lfoRateHz(0, 0)).toBeCloseTo(0.1, 2);
    expect(lfoRateHz(1, 0)).toBeCloseTo(349.2, 0); // 0.1·2^11.77
    expect(lfoRateHz(1, 5)).toBe(600); // ceiling
    expect(lfoRateHz(0, -5)).toBe(0.05); // floor
  });

  it('pulse width clamps at the rails', () => {
    expect(pulseWidth01(0.5, 0)).toBe(0.5);
    expect(pulseWidth01(0.5, 10)).toBe(0.98);
    expect(pulseWidth01(0.5, -10)).toBe(0.02);
    expect(pulseWidth01(0.5, 2.5, 0.02, 0.98)).toBeCloseTo(0.74, 6);
  });

  it('VCA gain: perceptual EG curve, soft-clip approaching 1.2', () => {
    expect(vcaGain(0, 0)).toBe(0);
    expect(vcaGain(7.5, 0)).toBe(1);
    expect(vcaGain(3.75, 0)).toBeCloseTo(Math.pow(0.5, 1.3), 6);
    expect(vcaGain(7.5, 8)).toBeLessThanOrEqual(1.2);
    expect(vcaGain(7.5, 8)).toBeGreaterThan(1.1);
  });

  it('equal-power crossfade conserves power', () => {
    const { a, b } = equalPowerXfade(0.5);
    expect(a * a + b * b).toBeCloseTo(1, 6);
    expect(equalPowerXfade(0).a).toBe(1);
    expect(equalPowerXfade(1).b).toBeCloseTo(1, 6);
    expect(mixPosition01(0.5, 5)).toBe(1);
  });

  it('exp knob mapping round-trips', () => {
    expect(expKnob(0.5, 20, 20000)).toBeCloseTo(Math.sqrt(20 * 20000), 3);
    expect(expKnob01(expKnob(0.3, 0.001, 10), 0.001, 10)).toBeCloseTo(0.3, 6);
  });

  it('Anvil step rate: 0.7–700 Hz knob with 1 vv/oct CV', () => {
    expect(anvilStepRateHz(0, 0)).toBeCloseTo(0.7, 3);
    expect(anvilStepRateHz(1, 0)).toBeCloseTo(700, 0);
    expect(anvilStepRateHz(0.5, 1) / anvilStepRateHz(0.5, 0)).toBeCloseTo(2, 5);
  });

  it('Cascade: VCO knob 262–4186 Hz, sub divider clamps 1–16, tempo 0.333–50 Hz', () => {
    expect(cascadeVcoKnobHz(0)).toBeCloseTo(261.63, 1);
    expect(cascadeVcoKnobHz(1)).toBeCloseTo(4186, 0);
    expect(cascadeSubDivider(4, 0, 0)).toBe(4);
    expect(cascadeSubDivider(16, 5, 0)).toBe(16);
    expect(cascadeSubDivider(1, -5, 0)).toBe(1);
    expect(cascadeSubDivider(8, 0, 2)).toBe(11); // cv·1.5 rounded
    expect(cascadeTempoHz(0)).toBeCloseTo(0.333, 2);
    expect(cascadeTempoHz(1)).toBeCloseTo(50, 1);
    expect(cascadeRhythmDivision(8, -5)).toBe(1);
    expect(cascadeSeqOctRange('OCT5')).toBe(5);
  });

  it('clamp guards NaN to the low rail (never propagate non-finite into a transport/param)', () => {
    expect(clamp(NaN, 0.7, 700)).toBe(0.7);
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
    expect(clamp(Infinity, 0, 10)).toBe(10); // ±Infinity already clamp correctly
    expect(clamp(-Infinity, 0, 10)).toBe(0);
  });

  it('Monarch timing: step duration and swing offsets', () => {
    expect(monarchStepDurS(120)).toBeCloseTo(0.125, 6); // 16ths at 120 BPM
    expect(swingOffsetS(50, 0.125)).toBe(0);
    expect(swingOffsetS(100, 0.125)).toBeCloseTo(0.0625, 6); // max swing = half a step late
    expect(swingOffsetS(0, 0.125)).toBeCloseTo(-0.0625, 6);
  });
});

describe('velocityToVv (G1 — note-on velocity -> VCA-CV vv)', () => {
  it('maps the full 1..127 range monotonically increasing', () => {
    let prev = -Infinity;
    for (let v = 1; v <= 127; v++) {
      const out = velocityToVv(v);
      expect(out).toBeGreaterThan(prev); // strictly increasing — monotonic
      prev = out;
    }
  });

  it('vel 127 -> the VELOCITY_VV_MAX ceiling; vel 1 -> a small floor; both in the 0..7.5 domain', () => {
    expect(velocityToVv(127)).toBeCloseTo(VELOCITY_VV_MAX, 6); // 7.5 vv max
    const floor = velocityToVv(1);
    expect(floor).toBeGreaterThan(0); // small but non-zero
    expect(floor).toBeLessThan(0.1);
    // every velocity lands inside the VCA-CV domain ~0..7.5
    for (const v of [1, 32, 64, 100, 127]) {
      const out = velocityToVv(v);
      expect(out).toBeGreaterThanOrEqual(0);
      expect(out).toBeLessThanOrEqual(VELOCITY_VV_MAX);
    }
  });

  it('vel 0 (running-status note-off) -> 0; out-of-range clamps to the rails', () => {
    expect(velocityToVv(0)).toBe(0);
    expect(velocityToVv(-5)).toBe(0); // below the floor -> 0
    expect(velocityToVv(200)).toBeCloseTo(VELOCITY_VV_MAX, 6); // above 127 clamps to max
  });

  it('vel 100 (the on-screen reference) is hotter than vel 64 and cooler than vel 127', () => {
    expect(velocityToVv(64)).toBeLessThan(velocityToVv(100));
    expect(velocityToVv(100)).toBeLessThan(velocityToVv(127));
  });
});
