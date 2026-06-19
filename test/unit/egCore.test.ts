import { describe, expect, it } from 'vitest';
import { EgCore, type EgConfig } from '../../src/engine/dsp/egCore';
import { GATE_THRESHOLD_VV } from '../../src/engine/units';

const FS = 48000;

function renderEg(cfg: EgConfig, gate: (tS: number) => number, seconds: number): Float32Array {
  const eg = new EgCore(FS, cfg);
  const n = Math.floor(seconds * FS);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = eg.processSample(gate(i / FS));
  return out;
}

const at = (buf: Float32Array, tS: number) => buf[Math.floor(tS * FS)]!;

describe('eg.worklet core (work order §7.6, D2)', () => {
  const monarchSustainOn: EgConfig = {
    attackS: 0.01,
    decayS: 0.2,
    sustainMode: 'on',
    retrigInAttack: false,
    attackCompletes: false,
    peakVv: 7.5,
  };

  it('Monarch sustain ON: gate 0.5 s, A=10 ms, D=200 ms — amplitude profile within 10%', () => {
    const buf = renderEg(monarchSustainOn, (t) => (t < 0.5 ? 5 : 0), 1.0);
    const peak = 7.5;
    // one-pole τ=time/4 model expectations at 5 points
    expect(at(buf, 0.005)).toBeCloseTo(peak * (1 - Math.exp(-2)), 0); // mid-attack
    expect(at(buf, 0.012)).toBeGreaterThan(peak * 0.9); // attack complete
    expect(at(buf, 0.25)).toBeCloseTo(peak, 1); // holding
    const relAt = (dt: number) => peak * Math.exp(-dt / 0.05); // τ = 200ms/4
    expect(Math.abs(at(buf, 0.55) - relAt(0.05)) / peak).toBeLessThan(0.1);
    expect(Math.abs(at(buf, 0.7) - relAt(0.2)) / peak).toBeLessThan(0.1);
  });

  it('Monarch sustain ON: legato (gate stays high) does not retrigger', () => {
    const buf = renderEg(monarchSustainOn, () => 5, 0.5);
    // after attack completes it must sit at peak forever — no dips
    for (let t = 0.05; t < 0.5; t += 0.05) {
      expect(at(buf, t)).toBeGreaterThan(7.5 * 0.98);
    }
  });

  it('Monarch sustain OFF: attack then immediate decay even while gate held', () => {
    const cfg: EgConfig = { ...monarchSustainOn, sustainMode: 'off', retrigInAttack: true };
    const buf = renderEg(cfg, () => 5, 1.0);
    const peakIdx = buf.indexOf(Math.max(...Array.from(buf)));
    expect(peakIdx / FS).toBeLessThan(0.05); // peaked early
    expect(at(buf, 0.8)).toBeLessThan(0.5); // decayed despite gate high
  });

  it('Monarch sustain OFF: every rising edge retriggers', () => {
    const cfg: EgConfig = { ...monarchSustainOn, sustainMode: 'off', retrigInAttack: true, decayS: 0.05 };
    // gates at 0 and 0.3 s
    const buf = renderEg(cfg, (t) => ((t % 0.3) < 0.02 ? 5 : 0), 0.6);
    expect(at(buf, 0.012)).toBeGreaterThan(5);
    expect(at(buf, 0.25)).toBeLessThan(0.5);
    expect(at(buf, 0.312)).toBeGreaterThan(5); // retriggered
  });

  it('Cascade: a 1 ms trigger pulse completes the full attack (manual p.34)', () => {
    const cfg: EgConfig = {
      attackS: 0.1,
      decayS: 0.2,
      sustainMode: 'gateHold',
      retrigInAttack: false,
      attackCompletes: true,
      peakVv: 8,
    };
    const buf = renderEg(cfg, (t) => (t < 0.001 ? 5 : 0), 0.5);
    // despite the gate falling at 1 ms, level must keep RISING through the attack
    expect(at(buf, 0.05)).toBeGreaterThan(at(buf, 0.02));
    // attack completes (~3.5τ with τ=A/4) near full peak before decay begins
    expect(Math.max(...Array.from(buf))).toBeGreaterThan(8 * 0.95);
    // and then decay
    expect(at(buf, 0.45)).toBeLessThan(at(buf, 0.12));
  });

  it('Cascade: triggers during the Attack stage are ignored (documented quirk)', () => {
    const cfg: EgConfig = {
      attackS: 0.2,
      decayS: 0.1,
      sustainMode: 'gateHold',
      retrigInAttack: false,
      attackCompletes: true,
      peakVv: 8,
    };
    // second trigger lands at 50 ms, mid-attack; profile must be identical to a single trigger
    const single = renderEg(cfg, (t) => (t < 0.001 ? 5 : 0), 0.4);
    const double = renderEg(cfg, (t) => (t < 0.001 || (t >= 0.05 && t < 0.051) ? 5 : 0), 0.4);
    for (let t = 0; t < 0.4; t += 0.02) {
      expect(Math.abs(at(double, t) - at(single, t))).toBeLessThan(0.01);
    }
  });

  it('Cascade gate: attack, hold while high, decay on release', () => {
    const cfg: EgConfig = {
      attackS: 0.01,
      decayS: 0.1,
      sustainMode: 'gateHold',
      retrigInAttack: false,
      attackCompletes: true,
      peakVv: 8,
    };
    const buf = renderEg(cfg, (t) => (t < 0.3 ? 5 : 0), 0.6);
    expect(at(buf, 0.15)).toBeGreaterThan(8 * 0.97); // holding
    expect(at(buf, 0.55)).toBeLessThan(1); // released
  });

  it('Anvil: velocity scales peak and stretches decay', () => {
    const cfg: EgConfig = {
      attackS: 0.001,
      decayS: 0.2,
      sustainMode: 'off',
      retrigInAttack: true,
      attackCompletes: false,
      peakVv: 8,
    };
    const egFull = new EgCore(FS, cfg);
    egFull.setVelocity(5);
    const egHalf = new EgCore(FS, cfg);
    egHalf.setVelocity(2.5);
    const egZero = new EgCore(FS, cfg);
    egZero.setVelocity(0);
    const n = Math.floor(0.3 * FS);
    const full = new Float32Array(n);
    const half = new Float32Array(n);
    const zero = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const gate = i < FS * 0.001 ? 5 : 0;
      full[i] = egFull.processSample(gate);
      half[i] = egHalf.processSample(gate);
      zero[i] = egZero.processSample(gate);
    }
    const peakOf = (b: Float32Array) => Math.max(...Array.from(b));
    expect(peakOf(full)).toBeGreaterThan(7.5);
    expect(peakOf(half) / peakOf(full)).toBeCloseTo(0.5, 1);
    expect(peakOf(zero)).toBe(0); // velocity 0 = silence (authentic)
  });

  it('no clicks: max sample-to-sample delta stays small with A,D >= 5 ms', () => {
    const cfg: EgConfig = { ...monarchSustainOn, attackS: 0.005, decayS: 0.005 };
    const buf = renderEg(cfg, (t) => (t > 0.1 && t < 0.3 ? 5 : 0), 0.5);
    let maxDelta = 0;
    for (let i = 1; i < buf.length; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(buf[i]! - buf[i - 1]!));
    }
    expect(maxDelta).toBeLessThan(0.15); // vv per sample at 48 kHz
  });

  // ---- manual-spec locks (Workstream C) ------------------------------------------------

  it('gate threshold = units.ts +2.5 vv: fires at 2.6, not at 2.4 (C3 dedup lock)', () => {
    expect(GATE_THRESHOLD_VV).toBe(2.5);
    const cfg: EgConfig = { ...monarchSustainOn, sustainMode: 'off', retrigInAttack: true, attackS: 0.001, decayS: 0.1 };
    const below = renderEg(cfg, () => 2.4, 0.1); // sub-threshold gate never triggers
    const above = renderEg(cfg, () => 2.6, 0.1); // supra-threshold triggers
    expect(Math.max(...Array.from(below))).toBeLessThan(0.01);
    expect(Math.max(...Array.from(above))).toBeGreaterThan(5);
  });

  it('Anvil VCA EG attack endpoints: FAST = 1 ms, SLOW = 100 ms (manual)', () => {
    const base: EgConfig = {
      attackS: 0.001, decayS: 5, sustainMode: 'off', retrigInAttack: true, attackCompletes: false, peakVv: 8,
    };
    const fast = renderEg(base, (t) => (t < 0.005 ? 5 : 0), 0.2);
    const slow = renderEg({ ...base, attackS: 0.1 }, () => 5, 0.3);
    // FAST: ~peak within ~1.5 ms (τ = A/4 = 0.25 ms)
    expect(at(fast, 0.0015)).toBeGreaterThan(8 * 0.9);
    // SLOW: barely risen at 1 ms; near peak only by ~100 ms
    expect(at(slow, 0.001)).toBeLessThan(8 * 0.3);
    expect(at(slow, 0.11)).toBeGreaterThan(8 * 0.9);
  });

  it('decay endpoints span 10 ms–10 s (manual)', () => {
    const base: EgConfig = {
      attackS: 0.001, decayS: 0.01, sustainMode: 'off', retrigInAttack: true, attackCompletes: false, peakVv: 8,
    };
    const dShort = renderEg(base, (t) => (t < 0.005 ? 5 : 0), 0.1);
    const dLong = renderEg({ ...base, decayS: 10 }, (t) => (t < 0.005 ? 5 : 0), 1.0);
    expect(at(dShort, 0.05)).toBeLessThan(8 * 0.05); // 10 ms decay essentially gone by 50 ms
    expect(at(dLong, 0.2)).toBeGreaterThan(8 * 0.8); // 10 s decay barely moved at 200 ms
  });
});
