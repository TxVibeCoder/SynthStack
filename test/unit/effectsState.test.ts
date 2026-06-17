/**
 * Master-effects state (Wave 2): the `effects` slice must default all-off, round-trip
 * through JSON, and coalesce any partial / older / junk tree to a complete, clamped
 * EffectsState (the load-safety net's contract — mirrors coalesceSamplerState).
 */

import { describe, expect, it } from 'vitest';
import {
  coalesceEffectsState,
  defaultEffectsState,
  defaultStudioState,
  type EffectsState,
} from '../../src/state/studioState';
import { coalesceStudioState } from '../../src/state/presets';

describe('effects state', () => {
  it('defaults all three effects OFF at their default params', () => {
    const m = defaultEffectsState().master;
    expect(m.flanger.on).toBe(false);
    expect(m.delay.on).toBe(false);
    expect(m.reverb.on).toBe(false);
    expect(m.flanger.rate).toBeGreaterThan(0);
    expect(m.delay.time).toBeGreaterThan(0);
    expect(m.reverb.size).toBeGreaterThan(0);
  });

  it('is part of the default studio state + JSON round-trips', () => {
    const s = defaultStudioState();
    expect(s.effects).toEqual(defaultEffectsState());
    const round = JSON.parse(JSON.stringify(s)) as typeof s;
    expect(round.effects).toEqual(s.effects);
  });

  it('coalesces an absent slice to all-off defaults', () => {
    expect(coalesceEffectsState(undefined)).toEqual(defaultEffectsState());
    expect(coalesceEffectsState({})).toEqual(defaultEffectsState());
  });

  it('keeps valid incoming values + flags', () => {
    const raw: Partial<EffectsState> = {
      master: {
        flanger: { on: true, rate: 2, depth: 0.8, feedback: 0.5, mix: 0.7 },
        delay: { on: true, time: 0.5, feedback: 0.6, mix: 0.5 },
        reverb: { on: true, size: 0.9, mix: 0.4 },
      },
    };
    const out = coalesceEffectsState(raw);
    expect(out.master.flanger.on).toBe(true);
    expect(out.master.flanger.rate).toBe(2);
    expect(out.master.delay.time).toBe(0.5);
    expect(out.master.reverb.size).toBe(0.9);
  });

  it('clamps out-of-range / junk params and drops bad flags', () => {
    const raw = {
      master: {
        flanger: { on: 'yes', rate: 1e9, depth: -3, feedback: 5, mix: NaN },
        delay: { on: 1, time: -1, feedback: 99, mix: 2 },
        reverb: { on: null, size: 50, mix: -9 },
      },
    } as unknown as Partial<EffectsState>;
    const out = coalesceEffectsState(raw);
    // bad flags -> default false
    expect(out.master.flanger.on).toBe(false);
    expect(out.master.delay.on).toBe(false);
    expect(out.master.reverb.on).toBe(false);
    // params clamped into range
    expect(out.master.flanger.rate).toBeLessThanOrEqual(12);
    expect(out.master.flanger.feedback).toBeLessThanOrEqual(0.95);
    expect(out.master.delay.time).toBeGreaterThanOrEqual(0.02);
    expect(out.master.delay.mix).toBeLessThanOrEqual(1);
    expect(out.master.reverb.size).toBeLessThanOrEqual(1);
    expect(out.master.reverb.mix).toBeGreaterThanOrEqual(0);
    // NaN mix -> default
    expect(Number.isFinite(out.master.flanger.mix)).toBe(true);
  });

  it('the full load-safety net carries the effects slice through', () => {
    const out = coalesceStudioState({ effects: { master: { reverb: { on: true, size: 0.5, mix: 0.5 } } } });
    expect(out.effects.master.reverb.on).toBe(true);
    expect(out.effects.master.flanger.on).toBe(false); // missing -> default
  });
});
