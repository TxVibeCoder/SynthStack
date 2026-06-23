import { describe, expect, it } from 'vitest';
import {
  coalesceCourierModAssignState,
  coalesceCourierSequencerState,
  coalesceKeyboardState,
  coalesceSamplerState,
  defaultCourierModAssignState,
  defaultCourierSequencerState,
  defaultCourierStep,
  defaultKeyboardState,
  defaultPattern,
  defaultStudioState,
  DRUM_STEPS,
  DRUM_TRACKS,
  QUANTIZE_DIVISIONS,
  StudioStore,
  type CourierModAssignState,
  type CourierSequencerState,
} from '../../src/state/studioState';
import { QUANT_CYCLE } from '../../src/engine/quantGrid';
import { FACTORY_KIT } from '../../src/engine/factorySamples';
import monarch from '../../data/monarch.json';
import anvil from '../../data/anvil.json';
import cascade from '../../data/cascade.json';
import sampler from '../../data/sampler.json';
import type { ModuleDef } from '../../data/schema';

describe('studio state round-trip (work order §3.6)', () => {
  it('JSON round-trips the default state', () => {
    const store = new StudioStore();
    const s = store.getState();
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('setState(getState()) is idempotent', () => {
    const store = new StudioStore();
    const before = store.getState();
    store.setState(before);
    expect(store.getState()).toEqual(before);
  });

  it('round-trips with every control of every module set to its default', () => {
    const store = new StudioStore();
    for (const def of [monarch, anvil, cascade] as unknown as ModuleDef[]) {
      for (const c of def.controls) {
        if (c.default !== undefined) store.setControl(def.id, c.id, c.default);
        else if (c.type === 'button') store.setControl(def.id, c.id, 'IDLE');
      }
    }
    const s = store.getState();
    const restored = new StudioStore(JSON.parse(JSON.stringify(s)));
    expect(restored.getState()).toEqual(s);
    // mutating the store after getState must not affect the snapshot (deep copy)
    store.setControl('monarch', 'MON_VOLUME', 0.123);
    expect(s.controls['monarch']!['MON_VOLUME']).not.toBe(0.123);
  });

  it('preserves cables and sequencer contents', () => {
    const store = new StudioStore();
    const s = store.getState();
    s.cables.push({ id: 'c1', from: 'MON_LFO_TRI_OUT', to: 'MON_VCF_CUTOFF_IN', color: '#d4a017' });
    s.transport.monarch.steps[0]!.noteVv = 0.25;
    s.transport.monarch.steps[3]!.ratchet = 3;
    s.transport.anvil.steps[7]!.pitchVv = -2.5;
    store.setState(s);
    expect(store.getState()).toEqual(s);
  });

  it('default state matches work order step defaults', () => {
    const s = defaultStudioState();
    expect(s.transport.monarch.steps).toHaveLength(32);
    expect(s.transport.monarch.steps[0]).toEqual({
      noteVv: -1,
      gateLength: 0.5,
      accent: false,
      rest: false,
      glide: false,
      ratchet: 1,
    });
    expect(s.transport.anvil.steps).toHaveLength(8);
    expect(s.transport.anvil.steps[0]).toEqual({ pitchVv: 0, velocityVv: 4 });
  });

  it('default state pre-loads the 8-piece factory kit and keeps an open spare mixer channel', () => {
    const s = defaultStudioState();
    expect(s.mixer.channelLevels).toHaveLength(5);
    expect(s.mixer.channelLevels[3]).toBe(0.8); // SAMP_MIX_OUT audible un-patched
    expect(s.mixer.channelLevels[4]).toBe(0.8); // Courier (MIX_CH5_LEVEL) default
    expect(s.sampler.pads).toHaveLength(8);
    expect(s.sampler.pads[0]).toEqual({
      sampleId: 'factory-kick',
      sampleName: 'Kick',
      level: 0.8,
      tuneSemis: 0,
      loop: false,
    });
    // every default pad now references a factory sound (playable on first power-on)
    expect(
      s.sampler.pads.every((p) => p.sampleId !== null && p.sampleId.startsWith('factory-')),
    ).toBe(true);
    // pad t === FACTORY_KIT[t]: the manifest order is the single contract (pad = render = picker order)
    expect(s.sampler.pads.map((p) => p.sampleId)).toEqual(FACTORY_KIT.map((e) => e.id));
    expect(s.sampler.pads.map((p) => p.sampleName)).toEqual(FACTORY_KIT.map((e) => e.name));
  });

  it('coalesceSamplerState aliases the retired bare factory-hat id to factory-hat-closed', () => {
    const tree = {
      pads: [{ sampleId: 'factory-hat', sampleName: 'Hat', level: 0.8, tuneSemis: 0, loop: false }],
    } as unknown as Parameters<typeof coalesceSamplerState>[0];
    expect(coalesceSamplerState(tree).pads[0]!.sampleId).toBe('factory-hat-closed');
    // a still-valid split id is untouched
    const ok = coalesceSamplerState({
      pads: [{ sampleId: 'factory-hat-open' }],
    } as unknown as Parameters<typeof coalesceSamplerState>[0]);
    expect(ok.pads[0]!.sampleId).toBe('factory-hat-open');
  });

  it('round-trips the sampler slice (sample references only, bytes-free)', () => {
    const store = new StudioStore();
    const s = store.getState();
    s.sampler.pads[0] = {
      sampleId: 'samp-abc',
      sampleName: 'kick.wav',
      level: 0.5,
      tuneSemis: -12,
      loop: true,
    };
    s.sampler.pads[7]!.tuneSemis = 7;
    store.setState(s);
    expect(store.getState()).toEqual(s);
  });

  it('default sampler quantize is 1 BAR', () => {
    expect(defaultStudioState().sampler.quantize).toBe('1 BAR');
  });

  it('coalesceSamplerState(undefined) yields 8 default pads and quantize 1 BAR', () => {
    const s = coalesceSamplerState(undefined);
    expect(s.pads).toHaveLength(8);
    expect(s.pads.every((p) => p.loop === false)).toBe(true);
    expect(s.quantize).toBe('1 BAR');
  });

  it('coalesceSamplerState fills loop/quantize defaults for an older-shape tree', () => {
    const oldTree = {
      pads: [{ sampleId: 'x', sampleName: 'y', level: 0.5, tuneSemis: 0 }],
    } as unknown as Parameters<typeof coalesceSamplerState>[0];
    const s = coalesceSamplerState(oldTree);
    expect(s.pads).toHaveLength(8);
    expect(s.pads[0]).toEqual({
      sampleId: 'x',
      sampleName: 'y',
      level: 0.5,
      tuneSemis: 0,
      loop: false,
    });
    expect(s.pads[1]).toEqual({
      sampleId: null,
      sampleName: null,
      level: 0.8,
      tuneSemis: 0,
      loop: false,
    });
    expect(s.quantize).toBe('1 BAR');
  });

  it('default sampler drum pattern is 8x16 all-false with seqRunning false', () => {
    const s = defaultStudioState();
    expect(s.sampler.pattern).toHaveLength(DRUM_TRACKS);
    expect(s.sampler.pattern.every((row) => row.length === DRUM_STEPS)).toBe(true);
    expect(s.sampler.pattern.every((row) => row.every((cell) => cell === false))).toBe(true);
    expect(s.sampler.seqRunning).toBe(false);
  });

  it('defaultPattern() is a fresh 8x16 all-false grid', () => {
    const p = defaultPattern();
    expect(p).toHaveLength(DRUM_TRACKS);
    expect(p.every((row) => row.length === DRUM_STEPS)).toBe(true);
    expect(p.every((row) => row.every((cell) => cell === false))).toBe(true);
  });

  it('round-trips a drum pattern with set cells and seqRunning', () => {
    const store = new StudioStore();
    const s = store.getState();
    s.sampler.pattern[0]![0] = true;
    s.sampler.pattern[3]![7] = true;
    s.sampler.seqRunning = true;
    store.setState(s);
    expect(store.getState()).toEqual(s);
  });

  it('coalesceSamplerState(undefined) yields an all-false 8x16 pattern and seqRunning false', () => {
    const s = coalesceSamplerState(undefined);
    expect(s.pattern).toHaveLength(DRUM_TRACKS);
    expect(s.pattern.every((row) => row.length === DRUM_STEPS)).toBe(true);
    expect(s.pattern.every((row) => row.every((cell) => cell === false))).toBe(true);
    expect(s.seqRunning).toBe(false);
  });

  it('coalesceSamplerState fills an all-false pattern + seqRunning false for an older tree lacking them', () => {
    const oldTree = {
      pads: [{ sampleId: 'x', sampleName: 'y', level: 0.5, tuneSemis: 0 }],
    } as unknown as Parameters<typeof coalesceSamplerState>[0];
    const s = coalesceSamplerState(oldTree);
    expect(s.pattern).toHaveLength(DRUM_TRACKS);
    expect(s.pattern.every((row) => row.length === DRUM_STEPS)).toBe(true);
    expect(s.pattern.every((row) => row.every((cell) => cell === false))).toBe(true);
    expect(s.seqRunning).toBe(false);
  });

  it('coalesceSamplerState normalizes a ragged/non-boolean pattern to a strict 8x16 grid', () => {
    const ragged = {
      pattern: [[true], [], [false, 1, null, true]],
      seqRunning: true,
    } as unknown as Parameters<typeof coalesceSamplerState>[0];
    const s = coalesceSamplerState(ragged);
    const expected = Array.from({ length: DRUM_TRACKS }, () =>
      new Array(DRUM_STEPS).fill(false),
    ) as boolean[][];
    expected[0]![0] = true; // [0][0] truthy boolean -> true
    expected[2]![3] = true; // [2][3] === true; [2][1]===1 and [2][2]===null both coerce to false
    expect(s.pattern).toEqual(expected);
    expect(s.pattern.every((row) => row.length === DRUM_STEPS)).toBe(true);
    expect(s.pattern.every((row) => row.every((cell) => typeof cell === 'boolean'))).toBe(true);
    expect(s.seqRunning).toBe(true);
  });

  it('coalesceSamplerState coerces a non-boolean seqRunning to a strict boolean (=== true)', () => {
    // The pinned coalesce body is `raw.seqRunning === true`, so any non-`true` value
    // (including the integer 1) normalizes to false — guaranteeing JSON round-trip safety.
    const one = { seqRunning: 1 } as unknown as Parameters<typeof coalesceSamplerState>[0];
    expect(coalesceSamplerState(one).seqRunning).toBe(false);
    const lit = { seqRunning: true } as unknown as Parameters<typeof coalesceSamplerState>[0];
    expect(coalesceSamplerState(lit).seqRunning).toBe(true);
  });

  it('coalesceSamplerState clamps/guards a garbage pad (level / tuneSemis / sampleId / sampleName)', () => {
    // A hand-edited bundle could inject junk per pad. Before the field-level guards, `...p`
    // spread these through verbatim: tuneSemis: 1e308 would reach setPadTune -> playbackRate
    // = Infinity, and a numeric sampleId would break the factory-/user predicate downstream.
    const garbage = {
      pads: [
        {
          level: 'loud', // non-number -> default 0.8
          tuneSemis: 1e308, // huge -> clamp to +24
          sampleId: 42, // numeric -> null
          sampleName: 99, // numeric -> null
          loop: 'yes', // non-boolean -> false
        },
        {
          level: 5, // over 1 -> clamp to 1
          tuneSemis: -100, // under -24 -> clamp to -24
          sampleId: 'samp-real', // string kept
          sampleName: 'kick.wav', // string kept
        },
        {
          level: -2, // under 0 -> clamp to 0
          tuneSemis: 3.7, // non-integer -> rounded to 4
        },
        {
          tuneSemis: NaN, // not finite -> default 0
          level: Infinity, // not finite -> default 0.8
        },
      ],
    } as unknown as Parameters<typeof coalesceSamplerState>[0];
    const s = coalesceSamplerState(garbage);
    expect(s.pads[0]).toEqual({
      sampleId: null,
      sampleName: null,
      level: 0.8,
      tuneSemis: 24,
      loop: false,
    });
    expect(s.pads[1]).toEqual({
      sampleId: 'samp-real',
      sampleName: 'kick.wav',
      level: 1,
      tuneSemis: -24,
      loop: false,
    });
    expect(s.pads[2]!.level).toBe(0);
    expect(s.pads[2]!.tuneSemis).toBe(4);
    expect(s.pads[3]!.level).toBe(0.8);
    expect(s.pads[3]!.tuneSemis).toBe(0);
    // every pad field is now type-correct + finite (JSON round-trips, no Infinity sneaks through)
    for (const p of s.pads) {
      expect(Number.isFinite(p.level)).toBe(true);
      expect(Number.isFinite(p.tuneSemis)).toBe(true);
      expect(Number.isInteger(p.tuneSemis)).toBe(true);
      expect(p.sampleId === null || typeof p.sampleId === 'string').toBe(true);
      expect(p.sampleName === null || typeof p.sampleName === 'string').toBe(true);
    }
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('lockstep: QUANTIZE_DIVISIONS === sampler.json SAMP_QUANTIZE.positions === quantGrid QUANT_CYCLE', () => {
    const def = sampler as unknown as ModuleDef;
    const quantizeCtl = def.controls.find((c) => c.id === 'SAMP_QUANTIZE');
    expect(quantizeCtl?.positions).toEqual(QUANTIZE_DIVISIONS);
    expect(QUANT_CYCLE).toEqual(QUANTIZE_DIVISIONS);
  });

  it('default state carries keyboard:{octave:0} and version stays 1', () => {
    const s = defaultStudioState();
    expect(s.keyboard).toEqual({ octave: 0 });
    expect(s.version).toBe(1); // additive slice — no version bump (mirrors the sampler slice)
  });

  it('JSON round-trips the keyboard octave across the store', () => {
    const store = new StudioStore();
    const s = store.getState();
    s.keyboard.octave = 2;
    store.setState(s);
    expect(store.getState().keyboard).toEqual({ octave: 2 });
    expect(store.getState()).toEqual(s);
  });

  it('defaultKeyboardState() is {octave:0}', () => {
    expect(defaultKeyboardState()).toEqual({ octave: 0 });
  });

  it('coalesceKeyboardState(undefined) yields {octave:0}', () => {
    expect(coalesceKeyboardState(undefined)).toEqual({ octave: 0 });
  });

  it('coalesceKeyboardState coalesces a pre-feature tree missing keyboard to {octave:0}', () => {
    // A whole studio tree built before the keyboard slice existed has no `keyboard` field.
    const preFeatureTree = defaultStudioState() as Partial<ReturnType<typeof defaultStudioState>>;
    delete preFeatureTree.keyboard;
    expect(coalesceKeyboardState(preFeatureTree.keyboard)).toEqual({ octave: 0 });
  });

  it('coalesceKeyboardState clamps/defaults a corrupt octave', () => {
    const bad = (octave: unknown) =>
      coalesceKeyboardState({ octave } as Partial<{ octave: number }>).octave;
    expect(bad(3.5)).toBe(0); // non-integer -> default 0
    expect(bad('x')).toBe(0); // wrong type -> default 0
    expect(bad(99)).toBe(3); // above range -> clamp +3
    expect(bad(-99)).toBe(-3); // below range -> clamp -3
    expect(bad(NaN)).toBe(0); // NaN is not an integer -> default 0
    expect(bad(undefined)).toBe(0); // missing -> default 0
  });

  it('coalesceKeyboardState passes the full -3..+3 range through unchanged', () => {
    for (const octave of [-3, -2, -1, 0, 1, 2, 3]) {
      expect(coalesceKeyboardState({ octave })).toEqual({ octave });
    }
  });

  it('default state carries courier.modAssign all-null and version stays 1', () => {
    const s = defaultStudioState();
    expect(s.courier.modAssign).toEqual(defaultCourierModAssignState());
    expect(s.courier.modAssign).toEqual({ routes: { kb: null, fEnv: null, aEnv: null, lfo1: null } });
    expect(s.version).toBe(1); // additive slice — no version bump (mirrors the keyboard slice)
  });

  it('JSON round-trips a courier.modAssign route across the store', () => {
    const store = new StudioStore();
    const s = store.getState();
    s.courier.modAssign.routes.lfo1 = { controlId: 'COU_CUTOFF', depth: 0.5 };
    store.setState(s);
    expect(store.getState().courier.modAssign.routes.lfo1).toEqual({
      controlId: 'COU_CUTOFF',
      depth: 0.5,
    });
    expect(store.getState()).toEqual(s);
  });

  it('defaultCourierModAssignState() is all-null routes', () => {
    expect(defaultCourierModAssignState()).toEqual({
      routes: { kb: null, fEnv: null, aEnv: null, lfo1: null },
    });
  });

  it('coalesceCourierModAssignState(undefined) yields the all-null default', () => {
    expect(coalesceCourierModAssignState(undefined)).toEqual(defaultCourierModAssignState());
  });

  it('coalesceCourierModAssignState coalesces a pre-feature tree missing courier to all-null', () => {
    const preFeatureTree: Partial<ReturnType<typeof defaultStudioState>> = defaultStudioState();
    delete preFeatureTree.courier;
    const courier = preFeatureTree.courier as { modAssign?: Partial<CourierModAssignState> } | undefined;
    expect(coalesceCourierModAssignState(courier?.modAssign)).toEqual(
      defaultCourierModAssignState(),
    );
  });

  it('coalesceCourierModAssignState clamps depth and drops garbage / unknown targets', () => {
    const out = coalesceCourierModAssignState({
      routes: {
        kb: { controlId: 'COU_CUTOFF', depth: 9 }, // clamp -> 1
        fEnv: { controlId: 'COU_TUNE', depth: -9 }, // clamp -> -1
        aEnv: { controlId: 'COU_NOPE', depth: 0.5 }, // unknown id -> null
        lfo1: { controlId: 'COU_CUTOFF', depth: 'x' }, // non-number depth -> null
      },
    } as unknown as Partial<CourierModAssignState>);
    expect(out.routes.kb).toEqual({ controlId: 'COU_CUTOFF', depth: 1 });
    expect(out.routes.fEnv).toEqual({ controlId: 'COU_TUNE', depth: -1 });
    expect(out.routes.aEnv).toBeNull();
    expect(out.routes.lfo1).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Courier sequencer slice (Phase C MVP) — mirrors the modAssign block above.
  // -------------------------------------------------------------------------

  it('default state carries courier.seq with 64 default steps and version stays 1', () => {
    const s = defaultStudioState();
    expect(s.courier.seq).toEqual(defaultCourierSequencerState());
    expect(s.courier.seq.steps).toHaveLength(64);
    expect(s.courier.seq.steps[0]).toEqual({
      noteVv: -1,
      gateLength: 0.5,
      rest: false,
      glide: false,
      lock: null,
    });
    expect(s.courier.seq.endStep).toBe(16);
    expect(s.courier.seq.clockDivIdx).toBe(3);
    expect(s.courier.seq.mode).toBe('SEQ');
    expect(s.courier.seq.arpMode).toBe('OFF');
    expect(s.courier.seq.running).toBe(false);
    expect(s.version).toBe(1); // additive slice — no version bump
  });

  it('defaultCourierStep() is an unauthored half-gate step with a null lock', () => {
    expect(defaultCourierStep()).toEqual({
      noteVv: -1,
      gateLength: 0.5,
      rest: false,
      glide: false,
      lock: null,
    });
  });

  it('JSON round-trips a courier.seq edit (step note + endStep + arp) across the store', () => {
    const store = new StudioStore();
    const s = store.getState();
    s.courier.seq.steps[0]!.noteVv = 0.25;
    s.courier.seq.steps[17]!.gateLength = 1.0; // tie on a later page
    s.courier.seq.steps[17]!.glide = true;
    s.courier.seq.endStep = 32;
    s.courier.seq.clockDivIdx = 1;
    s.courier.seq.mode = 'ARP';
    s.courier.seq.arpMode = 'UP';
    store.setState(s);
    expect(store.getState()).toEqual(s);
    expect(store.getState().courier.seq.steps[17]).toEqual({
      noteVv: -1,
      gateLength: 1.0,
      rest: false,
      glide: true,
      lock: null,
    });
  });

  it('JSON round-trips a non-null per-step param-lock map across the store', () => {
    const store = new StudioStore();
    const s = store.getState();
    s.courier.seq.steps[0]!.lock = { COU_CUTOFF: 1000, COU_TUNE: 3 };
    s.courier.seq.steps[5]!.lock = { COU_OSC1_WAVESHAPE: 0.4 };
    store.setState(s);
    expect(store.getState().courier.seq.steps[0]!.lock).toEqual({ COU_CUTOFF: 1000, COU_TUNE: 3 });
    expect(store.getState().courier.seq.steps[5]!.lock).toEqual({ COU_OSC1_WAVESHAPE: 0.4 });
    expect(store.getState().courier.seq.steps[1]!.lock).toBeNull();
  });

  it('coalesceCourierSequencerState preserves a non-null lock and keeps a non-object lock null', () => {
    const out = coalesceCourierSequencerState({
      steps: [
        { noteVv: 0, gateLength: 0.5, rest: false, glide: false, lock: { COU_CUTOFF: 1500 } },
        { noteVv: 0, gateLength: 0.5, rest: false, glide: false, lock: null },
        // a junk non-object lock canonicalizes to null
        {
          noteVv: 0,
          gateLength: 0.5,
          rest: false,
          glide: false,
          lock: 7 as unknown as Record<string, number>,
        },
      ],
    } as Partial<CourierSequencerState>);
    expect(out.steps[0]!.lock).toEqual({ COU_CUTOFF: 1500 });
    expect(out.steps[1]!.lock).toBeNull();
    expect(out.steps[2]!.lock).toBeNull();
  });

  it('coalesceCourierSequencerState(undefined) yields the 64-step default', () => {
    expect(coalesceCourierSequencerState(undefined)).toEqual(defaultCourierSequencerState());
  });

  it('coalesceCourierSequencerState coalesces a pre-feature tree missing courier.seq to defaults', () => {
    const preFeatureTree: Partial<ReturnType<typeof defaultStudioState>> = defaultStudioState();
    delete (preFeatureTree.courier as { seq?: unknown }).seq;
    const seq = (preFeatureTree.courier as { seq?: Partial<CourierSequencerState> }).seq;
    expect(coalesceCourierSequencerState(seq)).toEqual(defaultCourierSequencerState());
  });

  it('coalesceCourierSequencerState rebuilds a missing/short steps array to exactly 64', () => {
    const out = coalesceCourierSequencerState({
      steps: [{ noteVv: 1, gateLength: 0.5, rest: false, glide: false, lock: null }],
    } as Partial<CourierSequencerState>);
    expect(out.steps).toHaveLength(64);
    expect(out.steps[0]!.noteVv).toBe(1);
    expect(out.steps[1]).toEqual(defaultCourierStep()); // gap filled with a default step
  });

  it('coalesceCourierSequencerState clamps endStep/clockDivIdx and validates mode/arpMode', () => {
    const out = coalesceCourierSequencerState({
      endStep: 999, // clamp -> 64
      clockDivIdx: 50, // clamp -> 5
      swingPct: 200, // clamp -> 100
      gateLenScale: 9, // clamp -> 1
      mode: 'NOPE' as unknown as 'SEQ',
      arpMode: 'SIDEWAYS' as unknown as 'OFF',
      running: true, // FORCED false
    } as Partial<CourierSequencerState>);
    expect(out.endStep).toBe(64);
    expect(out.clockDivIdx).toBe(5);
    expect(out.swingPct).toBe(100);
    expect(out.gateLenScale).toBe(1);
    expect(out.mode).toBe('SEQ');
    expect(out.arpMode).toBe('OFF');
    expect(out.running).toBe(false);
  });

  it('coalesceCourierSequencerState forces running:false even when the raw says true', () => {
    expect(coalesceCourierSequencerState({ running: true } as Partial<CourierSequencerState>).running).toBe(
      false,
    );
  });

  it('coalesceCourierSequencerState clamps a per-step gateLength and defaults junk fields', () => {
    const out = coalesceCourierSequencerState({
      steps: [
        { noteVv: 'x', gateLength: 5, rest: 'yes', glide: 1, lock: null },
        { noteVv: NaN, gateLength: -1, rest: false, glide: false, lock: null },
      ],
    } as unknown as Partial<CourierSequencerState>);
    expect(out.steps[0]!.noteVv).toBe(-1); // non-number -> default
    expect(out.steps[0]!.gateLength).toBe(1); // clamp to 1
    expect(out.steps[0]!.rest).toBe(false); // non-boolean -> default
    expect(out.steps[0]!.glide).toBe(false);
    expect(out.steps[1]!.noteVv).toBe(-1); // NaN -> default
    expect(out.steps[1]!.gateLength).toBe(0.05); // clamp to floor
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  it('coalesceCourierSequencerState preserves a forward-compat per-step lock map', () => {
    const out = coalesceCourierSequencerState({
      steps: [{ noteVv: 0, gateLength: 0.5, rest: false, glide: false, lock: { COU_CUTOFF: 0.7 } }],
    } as Partial<CourierSequencerState>);
    expect(out.steps[0]!.lock).toEqual({ COU_CUTOFF: 0.7 });
  });
});
