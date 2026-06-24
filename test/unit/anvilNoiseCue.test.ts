/**
 * "Normal is live" cue for the Anvil's two pattern-2 normalled inputs: the cue
 * shows only when the shared attenuator knob is up AND nothing is patched into
 * the jack (so the internal NOISE normal is what's actually routed). Cross-checks
 * the jack→knob mapping against anvil.json so it can't silently drift.
 */

import { describe, expect, it } from 'vitest';
import type { ModuleDef } from '../../data/schema';
import anvilJson from '../../data/anvil.json';
import { ANVIL_NOISE_NORMAL_JACKS, isNoiseNormalLive } from '../../src/ui/panels/anvilNoiseCue';

const anvil = anvilJson as unknown as ModuleDef;

describe('isNoiseNormalLive', () => {
  it('shows when the knob is up and no cable is patched in', () => {
    expect(isNoiseNormalLive(0.5, false)).toBe(true);
  });

  it('hides when a cable is patched into the jack (the cable carries the signal)', () => {
    expect(isNoiseNormalLive(0.5, true)).toBe(false);
  });

  it('hides when the shared attenuator knob is 0 (the normal is silent)', () => {
    expect(isNoiseNormalLive(0, false)).toBe(false);
  });

  it('hides at knob 0 even with no cable, and stays hidden when patched', () => {
    expect(isNoiseNormalLive(0, true)).toBe(false);
  });
});

describe('ANVIL_NOISE_NORMAL_JACKS mapping', () => {
  it('maps exactly the two NOISE-normalled pattern-2 jacks to real knob controls', () => {
    expect(ANVIL_NOISE_NORMAL_JACKS).toEqual({
      ANV_VCF_MOD_IN: 'ANV_NOISE_VCF_MOD',
      ANV_EXT_AUDIO_IN: 'ANV_NOISE_EXT_LEVEL',
    });

    const jackById = new Map(anvil.jacks.map((j) => [j.id, j]));
    const controlById = new Map(anvil.controls.map((c) => [c.id, c]));

    for (const [jackId, knobId] of Object.entries(ANVIL_NOISE_NORMAL_JACKS)) {
      const jack = jackById.get(jackId);
      expect(jack, `jack ${jackId} missing from anvil.json`).toBeDefined();
      // both jacks are normalled to the internal noise source
      expect(jack!.normalledTo).toBe('INTERNAL:ANV_NOISE');

      const knob = controlById.get(knobId);
      expect(knob, `knob ${knobId} missing from anvil.json`).toBeDefined();
      expect(knob!.type).toBe('knob');
      // shared attenuator floors at 0 and defaults to 0 (silent normal at rest)
      expect(knob!.min).toBe(0);
      expect(knob!.default).toBe(0);
    }
  });
});
