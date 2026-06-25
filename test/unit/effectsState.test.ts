/**
 * Effects state (Wave 2): the `effects` slice (master bus + per-voice insert chains) must
 * default all-off, round-trip through JSON, and coalesce any partial / older / junk tree to a
 * complete, clamped EffectsState (the load-safety net's contract — mirrors coalesceSamplerState).
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
  it('defaults all four effects OFF at their default params', () => {
    const m = defaultEffectsState().master;
    expect(m.flanger.on).toBe(false);
    expect(m.delay.on).toBe(false);
    expect(m.reverb.on).toBe(false);
    expect(m.fold.on).toBe(false);
    expect(m.flanger.rate).toBeGreaterThan(0);
    expect(m.delay.time).toBeGreaterThan(0);
    expect(m.reverb.size).toBeGreaterThan(0);
    // FOLD voicing default (drive=2, mix=0.5) — see foldCore.ts header (operator's-ears).
    expect(m.fold.drive).toBeGreaterThanOrEqual(1);
    expect(m.fold.symmetry).toBe(0);
    expect(m.fold.mix).toBeGreaterThan(0);
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
        fold: { on: true, drive: 5, symmetry: -0.4, mix: 0.3 },
      },
    };
    const out = coalesceEffectsState(raw);
    expect(out.master.flanger.on).toBe(true);
    expect(out.master.flanger.rate).toBe(2);
    expect(out.master.delay.time).toBe(0.5);
    expect(out.master.reverb.size).toBe(0.9);
    expect(out.master.fold.on).toBe(true);
    expect(out.master.fold.drive).toBe(5);
    expect(out.master.fold.symmetry).toBe(-0.4);
    expect(out.master.fold.mix).toBe(0.3);
  });

  it('clamps out-of-range / junk params and drops bad flags', () => {
    const raw = {
      master: {
        flanger: { on: 'yes', rate: 1e9, depth: -3, feedback: 5, mix: NaN },
        delay: { on: 1, time: -1, feedback: 99, mix: 2 },
        reverb: { on: null, size: 50, mix: -9 },
        fold: { on: 'x', drive: 999, symmetry: -9, mix: NaN },
      },
    } as unknown as Partial<EffectsState>;
    const out = coalesceEffectsState(raw);
    // bad flags -> default false
    expect(out.master.flanger.on).toBe(false);
    expect(out.master.delay.on).toBe(false);
    expect(out.master.reverb.on).toBe(false);
    expect(out.master.fold.on).toBe(false);
    // params clamped into range
    expect(out.master.flanger.rate).toBeLessThanOrEqual(12);
    expect(out.master.flanger.feedback).toBeLessThanOrEqual(0.95);
    expect(out.master.delay.time).toBeGreaterThanOrEqual(0.02);
    expect(out.master.delay.mix).toBeLessThanOrEqual(1);
    expect(out.master.reverb.size).toBeLessThanOrEqual(1);
    expect(out.master.reverb.mix).toBeGreaterThanOrEqual(0);
    // fold params clamped: drive 1..8, symmetry -1..1, NaN mix -> default (finite)
    expect(out.master.fold.drive).toBeLessThanOrEqual(8);
    expect(out.master.fold.drive).toBeGreaterThanOrEqual(1);
    expect(out.master.fold.symmetry).toBeGreaterThanOrEqual(-1);
    expect(Number.isFinite(out.master.fold.mix)).toBe(true);
    // NaN mix -> default
    expect(Number.isFinite(out.master.flanger.mix)).toBe(true);
  });

  it('the full load-safety net carries the effects slice through', () => {
    const out = coalesceStudioState({ effects: { master: { reverb: { on: true, size: 0.5, mix: 0.5 } } } });
    expect(out.effects.master.reverb.on).toBe(true);
    expect(out.effects.master.flanger.on).toBe(false); // missing -> default
  });

  it('defaults a per-voice insert chain for each voice, all off', () => {
    const e = defaultEffectsState();
    for (const v of ['cascade', 'anvil', 'monarch', 'courier'] as const) {
      expect(e.voices[v].flanger.on, v).toBe(false);
      expect(e.voices[v].delay.on, v).toBe(false);
      expect(e.voices[v].reverb.on, v).toBe(false);
      expect(e.voices[v].fold.on, v).toBe(false);
      expect(e.voices[v].reverb.size, v).toBeGreaterThan(0);
      expect(e.voices[v].fold.drive, v).toBeGreaterThanOrEqual(1);
    }
  });

  it('coalesces per-voice slices: keeps valid, fills missing, defaults absent voices', () => {
    const raw = {
      voices: { cascade: { delay: { on: true, time: 0.5, feedback: 0.6, mix: 0.5 } } },
    } as unknown as Partial<EffectsState>;
    const out = coalesceEffectsState(raw);
    expect(out.voices.cascade.delay.on).toBe(true);
    expect(out.voices.cascade.delay.time).toBe(0.5);
    expect(out.voices.cascade.flanger.on).toBe(false); // missing effect -> default
    expect(out.voices.anvil).toEqual(defaultEffectsState().voices.anvil); // absent voice -> all-off
    expect(out.voices.monarch).toEqual(defaultEffectsState().voices.monarch);
    expect(out.voices.courier).toEqual(defaultEffectsState().voices.courier);
  });

  it('a per-voice slice round-trips through the full load-safety net', () => {
    const out = coalesceStudioState({
      effects: { voices: { monarch: { flanger: { on: true, rate: 3, depth: 0.2, feedback: 0.4, mix: 0.6 } } } },
    } as never);
    expect(out.effects.voices.monarch.flanger.on).toBe(true);
    expect(out.effects.voices.monarch.flanger.rate).toBe(3);
    expect(out.effects.voices.cascade.flanger.on).toBe(false); // untouched voice stays default
  });
});
