import { describe, it, expect } from 'vitest';
import {
  resolveModContributions,
  routeGainForTarget,
  MOD_BUSES,
  MOD_TARGETS,
  findModTarget,
  modGain,
  type ModSourceValues,
} from '../../src/engine/courierModRouter';
import {
  defaultCourierModAssignState,
  type CourierModAssignState,
} from '../../src/state/studioState';

/** All-zero source values (override per test). */
function zeroSources(): ModSourceValues {
  return { kb: 0, fEnv: 0, aEnv: 0, lfo1: 0 };
}

function stateWith(routes: Partial<CourierModAssignState['routes']>): CourierModAssignState {
  const s = defaultCourierModAssignState();
  Object.assign(s.routes, routes);
  return s;
}

describe('courierModRouter — routeGainForTarget', () => {
  it('returns 0 for a null route on every spec', () => {
    for (const spec of MOD_TARGETS) expect(routeGainForTarget(null, spec)).toBe(0);
  });

  it('returns 0 when the route targets a DIFFERENT control', () => {
    const cutoff = findModTarget('COU_CUTOFF')!;
    expect(routeGainForTarget({ controlId: 'COU_TUNE', depth: 1 }, cutoff)).toBe(0);
  });

  it('returns modGain(depth, spec) when the route targets THIS control', () => {
    const cutoff = findModTarget('COU_CUTOFF')!;
    expect(routeGainForTarget({ controlId: 'COU_CUTOFF', depth: 1 }, cutoff)).toBe(5);
    expect(routeGainForTarget({ controlId: 'COU_CUTOFF', depth: -0.5 }, cutoff)).toBeCloseTo(-2.5);
  });
});

describe('courierModRouter — resolveModContributions', () => {
  it('depth 0 = no effect (all buses 0) even with a hot source', () => {
    const state = stateWith({ kb: { controlId: 'COU_CUTOFF', depth: 0 } });
    const out = resolveModContributions(state, { ...zeroSources(), kb: 8 });
    for (const bus of MOD_BUSES) expect(out[bus]).toBe(0);
  });

  it('default (all null) contributes nothing on every bus', () => {
    const out = resolveModContributions(defaultCourierModAssignState(), {
      kb: 7,
      fEnv: 8,
      aEnv: 8,
      lfo1: 5,
    });
    for (const bus of MOD_BUSES) expect(out[bus]).toBe(0);
  });

  it('routes a single source onto its target with depth*scale*signal', () => {
    // kb (value 1 vv) -> COU_CUTOFF (scale 5), depth 1 -> +5 onto cutoff bus
    const state = stateWith({ kb: { controlId: 'COU_CUTOFF', depth: 1 } });
    const out = resolveModContributions(state, { ...zeroSources(), kb: 1 });
    expect(out.cutoff).toBe(5);
    expect(out.pitch).toBe(0);
  });

  it('bipolar depth flips the contribution sign', () => {
    const pos = resolveModContributions(
      stateWith({ lfo1: { controlId: 'COU_TUNE', depth: 0.5 } }),
      { ...zeroSources(), lfo1: 1 },
    );
    const neg = resolveModContributions(
      stateWith({ lfo1: { controlId: 'COU_TUNE', depth: -0.5 } }),
      { ...zeroSources(), lfo1: 1 },
    );
    expect(pos.pitch).toBeCloseTo(0.5);
    expect(neg.pitch).toBeCloseTo(-0.5);
    expect(pos.pitch).toBeCloseTo(-neg.pitch);
  });

  it('applies the x1/5 wave-morph scale (depth 1 on a wave target = 0.2 * signal)', () => {
    const state = stateWith({ fEnv: { controlId: 'COU_OSC1_WAVESHAPE', depth: 1 } });
    const out = resolveModContributions(state, { ...zeroSources(), fEnv: 1 });
    expect(out.osc1wave).toBeCloseTo(0.2);
  });

  it('sums multiple sources onto DISTINCT targets independently', () => {
    const state = stateWith({
      kb: { controlId: 'COU_CUTOFF', depth: 1 }, // cutoff bus
      lfo1: { controlId: 'COU_TUNE', depth: 1 }, // pitch bus
      fEnv: { controlId: 'COU_OSC2_FREQ', depth: 1 }, // osc2pitch bus
    });
    const out = resolveModContributions(state, { kb: 1, fEnv: 2, aEnv: 0, lfo1: 0.5 });
    expect(out.cutoff).toBe(5); // 1 * 5 * 1
    expect(out.pitch).toBeCloseTo(0.5); // 0.5 * 1 * 1
    expect(out.osc2pitch).toBe(2); // 2 * 1 * 1
    expect(out.subwave).toBe(0);
  });

  it('sums multiple sources routed onto the SAME bus additively', () => {
    const state = stateWith({
      kb: { controlId: 'COU_CUTOFF', depth: 1 }, // 2 * 5 * 1 = 10
      fEnv: { controlId: 'COU_CUTOFF', depth: 0.5 }, // 4 * 5 * 0.5 = 10
    });
    const out = resolveModContributions(state, { kb: 2, fEnv: 4, aEnv: 0, lfo1: 0 });
    expect(out.cutoff).toBe(20);
  });

  it('clamps depth beyond [-1,1] to the scaled rail', () => {
    const hi = resolveModContributions(
      stateWith({ kb: { controlId: 'COU_CUTOFF', depth: 2 } }),
      { ...zeroSources(), kb: 1 },
    );
    const lo = resolveModContributions(
      stateWith({ kb: { controlId: 'COU_CUTOFF', depth: -2 } }),
      { ...zeroSources(), kb: 1 },
    );
    expect(hi.cutoff).toBe(5); // clamp(2) * 5
    expect(lo.cutoff).toBe(-5); // clamp(-2) * 5
  });

  it('ignores an unsupported controlId as a safe no-op', () => {
    const state = stateWith({ kb: { controlId: 'COU_FILTER_MODE', depth: 1 } });
    const out = resolveModContributions(state, { ...zeroSources(), kb: 8 });
    for (const bus of MOD_BUSES) expect(out[bus]).toBe(0);
  });

  it('never produces NaN for finite inputs across all targets', () => {
    for (const spec of MOD_TARGETS) {
      const out = resolveModContributions(
        stateWith({ aEnv: { controlId: spec.controlId, depth: 0.37 } }),
        { ...zeroSources(), aEnv: 3.3 },
      );
      for (const bus of MOD_BUSES) expect(Number.isNaN(out[bus])).toBe(false);
    }
  });

  it('matches modGain * signal for every spec (resolver == math contract)', () => {
    for (const spec of MOD_TARGETS) {
      const depth = 0.5;
      const signal = 1.7;
      const out = resolveModContributions(
        stateWith({ kb: { controlId: spec.controlId, depth } }),
        { ...zeroSources(), kb: signal },
      );
      expect(out[spec.bus]).toBeCloseTo(signal * modGain(depth, spec));
    }
  });
});
