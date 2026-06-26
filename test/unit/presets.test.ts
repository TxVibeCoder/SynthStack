import { describe, expect, it } from 'vitest';
import {
  buildBundle,
  buildPresetFilename,
  coalesceStudioState,
  collectUserSampleIds,
  parseBundle,
  parseSlot,
  PRESET_BUNDLE_KIND,
  serializeSlot,
  SLOT_PREFIX,
  slotStorageKey,
  type PresetBundle,
} from '../../src/state/presets';
import {
  defaultCourierModAssignState,
  defaultStudioState,
  DRUM_STEPS,
  DRUM_TRACKS,
  type StudioState,
} from '../../src/state/studioState';
import { FACTORY_PRESETS, getFactoryPreset, listFactoryPresets } from '../../src/state/factoryPresets';
import monarch from '../../data/monarch.json';
import anvil from '../../data/anvil.json';
import cascade from '../../data/cascade.json';
import type { ModuleDef } from '../../data/schema';

const MODULE_DEFS = [monarch, anvil, cascade] as unknown as ModuleDef[];

/** Every control id that has a JSON default — the set resetAll seeds (engineBridge.ts:963-968). */
function seededControlIds(): Set<string> {
  const ids = new Set<string>();
  for (const def of MODULE_DEFS) {
    for (const c of def.controls) {
      if (c.default !== undefined) ids.add(`${def.id}.${c.id}`);
    }
  }
  return ids;
}

describe('coalesceStudioState — load-safety net totality', () => {
  it('returns a complete valid default tree for null / undefined / garbage', () => {
    for (const garbage of [null, undefined, 42, 'x', true, [], NaN]) {
      const s = coalesceStudioState(garbage as unknown);
      expect(s.version).toBe(1);
      expect(s.power).toBe(false);
      expect(s.transport.monarch.steps).toHaveLength(32);
      expect(s.transport.anvil.steps).toHaveLength(8);
      expect(s.sampler.pads).toHaveLength(8);
      expect(s.sampler.pattern).toHaveLength(DRUM_TRACKS);
      expect(s.mixer.channelLevels).toHaveLength(5);
      expect(s.courier.modAssign).toEqual(defaultCourierModAssignState());
      // JSON round-trips cleanly
      expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    }
  });

  it('coalesces a corrupt / pre-feature courier slice to the all-null default', () => {
    // Corrupt routes (bad controlId type + non-number depth) coalesce to null.
    const corrupt = coalesceStudioState({
      courier: { modAssign: { routes: { lfo1: { controlId: 5, depth: 'x' } } } },
    } as unknown);
    expect(corrupt.courier.modAssign).toEqual(defaultCourierModAssignState());
    // A pre-feature tree with no `courier` key coalesces to the default.
    const preFeature = defaultStudioState() as Partial<StudioState>;
    delete preFeature.courier;
    const out = coalesceStudioState(preFeature as unknown);
    expect(out.courier.modAssign).toEqual(defaultCourierModAssignState());
  });

  it('preserves a valid courier.modAssign route through coalesce', () => {
    const s = coalesceStudioState({
      courier: { modAssign: { routes: { lfo1: { controlId: 'COU_CUTOFF', depth: 0.5 } } } },
    } as unknown);
    expect(s.courier.modAssign.routes.lfo1).toEqual({ controlId: 'COU_CUTOFF', depth: 0.5 });
    expect(s.courier.modAssign.routes.kb).toBeNull();
  });

  it('never throws on a deeply corrupt tree', () => {
    const corrupt = {
      version: 99,
      power: 'yes',
      controls: { monarch: 'not-an-object', anvil: { ANV_CUTOFF: 'x' }, cascade: null },
      cables: [{ from: 1, to: 'X' }, 'junk', { from: 'A', to: 'B' }],
      transport: { monarch: { steps: 'nope' }, anvil: 7, cascade: { playing: 1 } },
      mixer: { channelLevels: ['a', 2, 0.5], masterVolume: 'loud', tempoLink: 1 },
      sampler: { pads: 'no', pattern: [[1, 'x']], seqRunning: 1 },
      keyboard: { octave: 'high' },
    };
    const s = coalesceStudioState(corrupt as unknown);
    expect(s.version).toBe(1);
    expect(s.power).toBe(false);
    expect(s.mixer.channelLevels).toEqual([0.8, 2 > 1 ? 1 : 2, 0.5, 0.8, 0.8]); // 2 clamps to 1, 'a' -> 0.8, missing (ch4 sampler + ch5 Courier) -> 0.8
    expect(s.mixer.masterVolume).toBe(0.8);
    expect(s.mixer.tempoLink).toBe(false);
    expect(s.keyboard.octave).toBe(0);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('forces version 1, power false, and all running/playing/seqRunning false', () => {
    const live = defaultStudioState();
    live.version = 1;
    live.power = true;
    live.transport.monarch.running = true;
    live.transport.anvil.running = true;
    live.transport.cascade.playing = true;
    live.sampler.seqRunning = true;
    const s = coalesceStudioState(live);
    expect(s.version).toBe(1);
    expect(s.power).toBe(false);
    expect(s.transport.monarch.running).toBe(false);
    expect(s.transport.anvil.running).toBe(false);
    expect(s.transport.cascade.playing).toBe(false);
    expect(s.sampler.seqRunning).toBe(false);
  });

  it('seeds the module-JSON control defaults so every defaulted control is present', () => {
    const s = coalesceStudioState({});
    for (const def of MODULE_DEFS) {
      for (const c of def.controls) {
        if (c.default !== undefined) {
          expect(s.controls[def.id]![c.id]).toBe(c.default);
        }
      }
    }
  });

  it('COMPLETENESS: coalesce seeds EXACTLY resetAll\'s control-default set (lockstep)', () => {
    // resetAll seeds every control with a JSON default; coalesce must match it 1:1 so a future
    // control-JSON change can never silently diverge the two seeding loops.
    const expected = seededControlIds();
    const s = coalesceStudioState({});
    const seeded = new Set<string>();
    for (const moduleId of ['monarch', 'anvil', 'cascade']) {
      for (const controlId of Object.keys(s.controls[moduleId] ?? {})) {
        seeded.add(`${moduleId}.${controlId}`);
      }
    }
    expect(seeded).toEqual(expected);
  });

  it('clamps numeric knob overlays to the JSON min/max', () => {
    const s = coalesceStudioState({
      controls: {
        monarch: { MON_VCF_CUTOFF: 999999, MON_FREQUENCY: -50 },
        anvil: { ANV_TEMPO: 99999 },
      },
    });
    expect(s.controls.monarch!.MON_VCF_CUTOFF).toBe(20000); // clamp to max
    expect(s.controls.monarch!.MON_FREQUENCY).toBe(-1); // clamp to min
    expect(s.controls.anvil!.ANV_TEMPO).toBe(700); // clamp to max
  });

  it('floors CAS_VCO1_FREQ / CAS_VCO2_FREQ below 261.63 up to the min', () => {
    const s = coalesceStudioState({
      controls: { cascade: { CAS_VCO1_FREQ: 130.81, CAS_VCO2_FREQ: 100 } },
    });
    expect(s.controls.cascade!.CAS_VCO1_FREQ).toBe(261.63);
    expect(s.controls.cascade!.CAS_VCO2_FREQ).toBe(261.63);
  });

  it('clamps CAS_RHYTHM_n outside 1..16', () => {
    const s = coalesceStudioState({
      controls: { cascade: { CAS_RHYTHM_1: 0, CAS_RHYTHM_2: 99 } },
    });
    expect(s.controls.cascade!.CAS_RHYTHM_1).toBe(1);
    expect(s.controls.cascade!.CAS_RHYTHM_2).toBe(16);
  });

  it('DROPS a non-number value for a knob id (keeps the seeded default)', () => {
    const s = coalesceStudioState({
      controls: { monarch: { MON_VCF_CUTOFF: 'x' } },
    });
    expect(s.controls.monarch!.MON_VCF_CUTOFF).toBe(800); // JSON default, NOT 'x'
  });

  it('passes switch/button string positions through verbatim', () => {
    const s = coalesceStudioState({
      controls: { monarch: { MON_VCO_WAVE: 'PULSE', MON_VCF_MODE: 'HP' } },
    });
    expect(s.controls.monarch!.MON_VCO_WAVE).toBe('PULSE');
    expect(s.controls.monarch!.MON_VCF_MODE).toBe('HP');
  });

  it('skips the sampler module in the controls overlay (applyState skips it too)', () => {
    const s = coalesceStudioState({ controls: { sampler: { SAMP_QUANTIZE: '1/8' } } });
    expect(s.controls.sampler).toEqual({}); // default tree leaves sampler controls empty
  });

  it('rebuilds a strict 32-step monarch transport from a partial / ragged tree', () => {
    const s = coalesceStudioState({
      transport: {
        monarch: {
          steps: [{ noteVv: 0.5, accent: true, ratchet: 3 }, { noteVv: 'bad', ratchet: 9 }],
          endStep: 99,
          swingPct: -5,
        },
      },
    });
    expect(s.transport.monarch.steps).toHaveLength(32);
    expect(s.transport.monarch.steps[0]).toEqual({
      noteVv: 0.5,
      gateLength: 0.5,
      accent: true,
      rest: false,
      glide: false,
      ratchet: 3,
    });
    // bad noteVv -> default -1; bad ratchet 9 -> 1
    expect(s.transport.monarch.steps[1]!.noteVv).toBe(-1);
    expect(s.transport.monarch.steps[1]!.ratchet).toBe(1);
    expect(s.transport.monarch.endStep).toBe(32); // clamp 1..32
    expect(s.transport.monarch.swingPct).toBe(0); // clamp 0..100
  });

  it('defaults monarch swingPct to 50 (NOT 0) and endStep to 16 when absent', () => {
    const s = coalesceStudioState({});
    expect(s.transport.monarch.swingPct).toBe(50);
    expect(s.transport.monarch.endStep).toBe(16);
  });

  it('rebuilds a strict 8-step anvil transport clamping pitch/velocity', () => {
    const s = coalesceStudioState({
      transport: { anvil: { steps: [{ pitchVv: 99, velocityVv: -3 }, {}] } },
    });
    expect(s.transport.anvil.steps).toHaveLength(8);
    expect(s.transport.anvil.steps[0]).toEqual({ pitchVv: 5, velocityVv: 0 });
    expect(s.transport.anvil.steps[1]).toEqual({ pitchVv: 0, velocityVv: 4 }); // defaults
  });

  it('clamps the 5 mixer channel levels and master volume to 0..1', () => {
    const s = coalesceStudioState({
      mixer: { channelLevels: [2, -1, 0.5], masterVolume: 9, tempoLink: true },
    });
    expect(s.mixer.channelLevels).toEqual([1, 0, 0.5, 0.8, 0.8]); // ch4 sampler + ch5 Courier default to 0.8
    expect(s.mixer.masterVolume).toBe(1);
    expect(s.mixer.tempoLink).toBe(true);
  });

  it('clamps/guards garbage sampler pad fields on the full load path (import/slot/factory hardening)', () => {
    // coalesceStudioState delegates pads to coalesceSamplerState, so a hand-edited bundle whose
    // pad carries tuneSemis: 1e308 (-> setPadTune -> playbackRate Infinity) or a numeric sampleId
    // must heal to finite, type-correct values BEFORE any load path applies it.
    const s = coalesceStudioState({
      sampler: {
        pads: [{ level: 'x', tuneSemis: 1e308, sampleId: 7, sampleName: 7, loop: 1 }],
      },
    });
    expect(s.sampler.pads[0]).toEqual({
      sampleId: null,
      sampleName: null,
      level: 0.8,
      tuneSemis: 24,
      loop: false,
    });
    expect(Number.isFinite(s.sampler.pads[0]!.tuneSemis)).toBe(true);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('rebuilds a strict 8x16 sampler grid via coalesceSamplerState', () => {
    const s = coalesceStudioState({ sampler: { pattern: [[true]], seqRunning: true } });
    expect(s.sampler.pattern).toHaveLength(DRUM_TRACKS);
    expect(s.sampler.pattern.every((row) => row.length === DRUM_STEPS)).toBe(true);
    expect(s.sampler.pattern[0]![0]).toBe(true);
    expect(s.sampler.seqRunning).toBe(false); // forced false even though raw was true
  });

  it('keeps only string cable from/to, defaulting id/color', () => {
    const s = coalesceStudioState({
      cables: [
        { id: 'c1', from: 'A', to: 'B', color: '#fff' },
        { from: 'C', to: 'D' }, // missing id/color
        { from: 1, to: 'X' }, // bad from -> dropped
        'junk',
      ],
    });
    expect(s.cables).toHaveLength(2);
    expect(s.cables[0]).toEqual({ id: 'c1', from: 'A', to: 'B', color: '#fff' });
    expect(s.cables[1]!.from).toBe('C');
    expect(s.cables[1]!.to).toBe('D');
    expect(typeof s.cables[1]!.id).toBe('string');
    expect(typeof s.cables[1]!.color).toBe('string');
  });

  it('coalesces an older tree missing whole slices without throwing', () => {
    const older = { controls: { monarch: { MON_VOLUME: 0.5 } } }; // no transport/mixer/sampler/keyboard
    const s = coalesceStudioState(older);
    expect(s.controls.monarch!.MON_VOLUME).toBe(0.5);
    expect(s.transport.anvil.steps).toHaveLength(8);
    expect(s.keyboard).toEqual({ octave: 0, midiChannel: -1, glideS: 0 });
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('does not share refs with the input (deep copy)', () => {
    const input = defaultStudioState();
    const s = coalesceStudioState(input);
    s.transport.monarch.steps[0]!.noteVv = 99;
    expect(input.transport.monarch.steps[0]!.noteVv).not.toBe(99);
  });
});

describe('bundle envelope', () => {
  const sampleBlob = { id: 'samp-1', name: 'kick', mime: 'audio/wav', bytesBase64: 'AAA=' };

  it('buildBundle assembles the kind/version/state/samples envelope', () => {
    const state = defaultStudioState();
    const bundle = buildBundle(state, [sampleBlob]);
    expect(bundle.kind).toBe(PRESET_BUNDLE_KIND);
    expect(bundle.version).toBe(1);
    expect(bundle.state).toBe(state);
    expect(bundle.samples).toEqual([sampleBlob]);
  });

  it('round-trips buildBundle -> JSON -> parseBundle', () => {
    const state = defaultStudioState();
    state.controls.monarch!.MON_VOLUME = 0.42;
    const bundle = buildBundle(coalesceStudioState(state), [sampleBlob]);
    const parsed = parseBundle(JSON.stringify(bundle));
    expect(parsed).not.toBeNull();
    expect(parsed!.state.controls.monarch!.MON_VOLUME).toBe(0.42);
    expect(parsed!.samples).toEqual([sampleBlob]);
  });

  it('parseBundle rejects bad JSON', () => {
    expect(parseBundle('{not json')).toBeNull();
    expect(parseBundle('')).toBeNull();
  });

  it('parseBundle rejects foreign JSON (wrong/absent kind)', () => {
    expect(parseBundle(JSON.stringify({ kind: 'something-else', state: {} }))).toBeNull();
    expect(parseBundle(JSON.stringify({ version: 1, state: {} }))).toBeNull(); // a saved slot file
    expect(parseBundle(JSON.stringify([1, 2, 3]))).toBeNull();
  });

  it('parseBundle filters malformed sample entries and coalesces the state', () => {
    const text = JSON.stringify({
      kind: PRESET_BUNDLE_KIND,
      version: 1,
      state: { transport: { monarch: { running: true } } },
      samples: [
        sampleBlob,
        { id: 'x', name: 'y' }, // missing mime/bytesBase64 -> dropped
        'junk',
        null,
        { id: 1, name: 'y', mime: 'm', bytesBase64: 'b' }, // non-string id -> dropped
      ],
    });
    const parsed = parseBundle(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.samples).toEqual([sampleBlob]);
    expect(parsed!.state.transport.monarch.running).toBe(false); // coalesced
    expect(parsed!.state.version).toBe(1);
  });

  it('parseBundle yields [] samples when samples is absent / not an array', () => {
    const text = JSON.stringify({ kind: PRESET_BUNDLE_KIND, version: 1, state: {} });
    expect(parseBundle(text)!.samples).toEqual([]);
  });
});

describe('collectUserSampleIds', () => {
  it('collects distinct non-factory pad ids', () => {
    const state = defaultStudioState();
    state.sampler.pads[0]!.sampleId = 'samp-a';
    state.sampler.pads[1]!.sampleId = 'factory-kick';
    state.sampler.pads[2]!.sampleId = 'samp-a'; // duplicate
    state.sampler.pads[3]!.sampleId = 'samp-b';
    state.sampler.pads[4]!.sampleId = null;
    expect(collectUserSampleIds(state)).toEqual(['samp-a', 'samp-b']);
  });

  it('returns [] for an all-factory / empty kit', () => {
    const state = defaultStudioState();
    state.sampler.pads[0]!.sampleId = 'factory-kick';
    expect(collectUserSampleIds(state)).toEqual([]);
  });

  it('does not throw on a partial sampler slice', () => {
    const state = { sampler: { pads: [{ sampleId: 'samp-x' }] } } as unknown as StudioState;
    expect(collectUserSampleIds(state)).toEqual(['samp-x']);
  });
});

describe('slot codec', () => {
  it('SLOT_PREFIX + slotStorageKey form the namespaced key', () => {
    expect(SLOT_PREFIX).toBe('synthstack-preset:');
    expect(slotStorageKey('My Kit')).toBe('synthstack-preset:My Kit');
  });

  it('serializeSlot -> parseSlot round-trips through coalesce', () => {
    const state = defaultStudioState();
    state.controls.anvil!.ANV_VOLUME = 0.33;
    const restored = parseSlot(serializeSlot(coalesceStudioState(state)));
    expect(restored.controls.anvil!.ANV_VOLUME).toBe(0.33);
    expect(restored.version).toBe(1);
  });

  it('parseSlot returns a default tree on bad JSON (never throws)', () => {
    const s = parseSlot('{broken');
    expect(s.version).toBe(1);
    expect(s.transport.anvil.steps).toHaveLength(8);
  });
});

describe('buildPresetFilename', () => {
  const ts = '2026-06-15T12-00-00-000Z';

  it('slugs the name and appends the injected timestamp', () => {
    expect(buildPresetFilename('My Cool Setup', ts)).toBe(`synthstack-my-cool-setup-${ts}.json`);
  });

  it('strips punctuation, collapses repeats, trims dashes', () => {
    expect(buildPresetFilename('  --Acid!! Bass__#1--  ', ts)).toBe(`synthstack-acid-bass1-${ts}.json`);
  });

  it('falls back to "preset" for an empty / all-punctuation name', () => {
    expect(buildPresetFilename('', ts)).toBe(`synthstack-preset-${ts}.json`);
    expect(buildPresetFilename('!!!', ts)).toBe(`synthstack-preset-${ts}.json`);
  });
});

describe('factory presets', () => {
  const knobRanges: Record<string, { min: number; max: number }> = (() => {
    const m: Record<string, { min: number; max: number }> = {};
    for (const def of MODULE_DEFS) {
      for (const c of def.controls) {
        if ((c.type === 'knob' || c.type === 'stepKnob') && typeof c.min === 'number' && typeof c.max === 'number') {
          m[c.id] = { min: c.min, max: c.max };
        }
      }
    }
    return m;
  })();

  const positionSets: Record<string, string[]> = (() => {
    const m: Record<string, string[]> = {};
    for (const def of MODULE_DEFS) {
      for (const c of def.controls) {
        if ((c.type === 'switch' || c.type === 'button') && c.positions) m[c.id] = c.positions;
      }
    }
    return m;
  })();

  const knownControlIds = new Set<string>(
    MODULE_DEFS.flatMap((def) => def.controls.map((c) => c.id)),
  );

  it('lists 5 presets with original names + descriptions', () => {
    const list = listFactoryPresets();
    expect(list).toHaveLength(5);
    expect(list.map((p) => p.id)).toEqual([
      'factory-preset-cellar-door',
      'factory-preset-iron-garden',
      'factory-preset-tide-engine',
      'factory-preset-corner-store',
      'factory-preset-furnace-room',
    ]);
    for (const p of list) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.description.length).toBeGreaterThan(0);
    }
  });

  it('getFactoryPreset(unknown) -> null, no throw', () => {
    expect(getFactoryPreset('nope')).toBeNull();
  });

  for (const preset of FACTORY_PRESETS) {
    describe(preset.id, () => {
      const state = preset.build();

      it('is a complete valid JSON-round-tripping tree (version 1, flags false)', () => {
        expect(state.version).toBe(1);
        expect(state.power).toBe(false);
        expect(state.transport.monarch.running).toBe(false);
        expect(state.transport.anvil.running).toBe(false);
        expect(state.transport.cascade.playing).toBe(false);
        expect(state.sampler.seqRunning).toBe(false);
        expect(state.keyboard.octave).toBe(0);
        expect(state.transport.monarch.steps).toHaveLength(32);
        expect(state.transport.anvil.steps).toHaveLength(8);
        expect(state.sampler.pads).toHaveLength(8);
        expect(state.sampler.pattern).toHaveLength(DRUM_TRACKS);
        expect(JSON.parse(JSON.stringify(state))).toEqual(state);
      });

      it('references only real control ids with in-range / valid values', () => {
        for (const moduleId of ['monarch', 'anvil', 'cascade']) {
          for (const [id, value] of Object.entries(state.controls[moduleId] ?? {})) {
            expect(knownControlIds.has(id)).toBe(true);
            if (typeof value === 'number') {
              const range = knobRanges[id];
              if (range) {
                expect(value).toBeGreaterThanOrEqual(range.min);
                expect(value).toBeLessThanOrEqual(range.max);
              }
            } else {
              const positions = positionSets[id];
              if (positions) expect(positions).toContain(value);
            }
          }
        }
      });
    });
  }

  it('Tide Engine floors CAS_VCO1_FREQ to the 261.63 min', () => {
    const s = getFactoryPreset('factory-preset-tide-engine')!;
    expect(s.controls.cascade!.CAS_VCO1_FREQ).toBe(261.63);
    expect(s.controls.cascade!.CAS_VCO2_FREQ).toBe(392);
  });

  it('Corner Store pads reference only factory ids and an authored 8x16 grid', () => {
    const s = getFactoryPreset('factory-preset-corner-store')!;
    expect(s.sampler.pads[0]!.sampleId).toBe('factory-kick');
    expect(s.sampler.pads[1]!.sampleId).toBe('factory-hat-closed');
    expect(s.sampler.pads[2]!.sampleId).toBe('factory-tom');
    expect(s.sampler.pads.slice(3).every((p) => p.sampleId === null)).toBe(true);
    // no USER sample ids -> fully portable with an empty samples[]
    expect(collectUserSampleIds(s)).toEqual([]);
    // kick on every quarter
    expect([0, 4, 8, 12].every((step) => s.sampler.pattern[0]![step] === true)).toBe(true);
    expect(s.sampler.pattern[1]![2]).toBe(true);
    expect(s.sampler.pattern[2]![7]).toBe(true);
    expect(s.sampler.pattern.every((row) => row.length === DRUM_STEPS)).toBe(true);
  });

  it('Cellar Door has an authored monarch bassline with accents/glide/rest', () => {
    const s = getFactoryPreset('factory-preset-cellar-door')!;
    expect(s.transport.monarch.swingPct).toBe(56);
    expect(s.transport.monarch.steps.some((st) => st.accent)).toBe(true);
    expect(s.transport.monarch.steps.some((st) => st.glide)).toBe(true);
    expect(s.transport.monarch.steps.some((st) => st.rest)).toBe(true);
  });

  it('Furnace Room voices the Courier deep + aggressive and authors a 16-step riff', () => {
    const s = getFactoryPreset('factory-preset-furnace-room')!;
    const cou = s.controls.courier!;
    // deep stack: OSC 1 dropped an octave + a hot sub, fat 4-pole ladder with growl
    expect(cou.COU_OSC1_OCTAVE).toBe('16');
    expect(cou.COU_MIX_SUB).toBe(0.7);
    expect(cou.COU_FILTER_MODE).toBe('LP4');
    expect(cou.COU_RES_BASS).toBe('ON');
    expect((cou.COU_RESONANCE as number)).toBeGreaterThan(0.5);
    expect((cou.COU_EG_AMOUNT as number)).toBeGreaterThan(0.5);
    // the demo bassline is authored (LENGTH 16, at least one octave pop + one glide step)
    expect(s.courier.seq.endStep).toBe(16);
    expect(s.courier.seq.steps.some((st) => st.glide)).toBe(true);
    expect(s.courier.seq.steps.some((st) => st.rest)).toBe(true);
    expect(s.courier.seq.steps.some((st) => Math.abs(st.noteVv - 1) < 1e-9)).toBe(true); // +12 semis
    expect(s.courier.seq.running).toBe(false); // a load never spontaneously sounds
  });
});

// Reference the imported PresetBundle type so noUnusedLocals stays happy and the export is pinned.
const _bundleTypeCheck: PresetBundle | null = null;
void _bundleTypeCheck;
