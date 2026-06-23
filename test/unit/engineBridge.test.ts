/**
 * Engine-bridge routing table (PURE — no Studio, no AudioContext instantiated).
 * Verifies every special-case control id in data/*.json classifies to its
 * transport-side route and that everything else falls through to 'module'.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyControl, engineBridge, parseControlRoute, type ControlRoute } from '../../src/ui/engineBridge';
import { defaultFactoryPad } from '../../src/state/studioState';
import { FACTORY_KIT } from '../../src/engine/factorySamples';
import { noteToVv } from '../../src/engine/voice/monoVoice';
import monarch from '../../data/monarch.json';
import anvil from '../../data/anvil.json';
import cascade from '../../data/cascade.json';
import type { ModuleDef } from '../../data/schema';

const defs = [monarch, anvil, cascade] as unknown as ModuleDef[];

/** The complete expected special-case map (everything absent here is 'module'). */
const SPECIAL: Record<string, ControlRoute> = {
  MON_TEMPO: 'monarchTempo',
  MON_SWING: 'monarchSwing',
  ANV_TEMPO: 'anvilTempo',
  CAS_TEMPO: 'cascadeTempo',
  CAS_EG: 'cascadeEg',
};
for (let n = 1; n <= 8; n++) {
  SPECIAL[`ANV_SEQ_PITCH_${n}`] = 'anvilStepPitch';
  SPECIAL[`ANV_SEQ_VELOCITY_${n}`] = 'anvilStepVelocity';
}
for (let n = 1; n <= 4; n++) {
  SPECIAL[`CAS_RHYTHM_${n}`] = 'cascadeRhythmDiv';
  SPECIAL[`CAS_RHYTHM${n}_SEQ1`] = 'cascadeRhythmAssign';
  SPECIAL[`CAS_RHYTHM${n}_SEQ2`] = 'cascadeRhythmAssign';
}

describe('engineBridge routing table (pure)', () => {
  it('every special-case id exists in data/*.json (the table cannot drift from the data)', () => {
    const allIds = new Set(defs.flatMap((d) => d.controls.map((c) => c.id)));
    for (const id of Object.keys(SPECIAL)) {
      expect(allIds.has(id), `${id} missing from data/*.json`).toBe(true);
    }
  });

  it('classifies every control id of every module as expected', () => {
    for (const def of defs) {
      for (const c of def.controls) {
        const expected = SPECIAL[c.id] ?? 'module';
        expect(classifyControl(c.id), c.id).toBe(expected);
      }
    }
  });

  it('routes exactly the documented ids away from module — no extras, no omissions', () => {
    const allIds = defs.flatMap((d) => d.controls.map((c) => c.id));
    const nonModule = allIds.filter((id) => classifyControl(id) !== 'module');
    expect(new Set(nonModule)).toEqual(new Set(Object.keys(SPECIAL)));
  });

  it('module-owned sequencer-adjacent ids stay on the module', () => {
    const moduleOwned = [
      'MON_GLIDE', // MonarchModule.setControl owns glideTimeS
      'ANV_SEQ_PITCH_MOD', // a switch — must not match the ANV_SEQ_PITCH_n step knobs
      'CAS_QUANTIZE',
      'CAS_SEQ_OCT',
      'CAS_SEQ1_STEP_1',
      'CAS_SEQ1_STEP_4',
      'CAS_SEQ2_STEP_1',
      'CAS_SEQ2_STEP_4',
      'CAS_SEQ1_ASSIGN_OSC',
      'CAS_SEQ1_ASSIGN_SUB1',
      'CAS_SEQ1_ASSIGN_SUB2',
      'CAS_SEQ2_ASSIGN_OSC',
      'CAS_SEQ2_ASSIGN_SUB1',
      'CAS_SEQ2_ASSIGN_SUB2',
    ];
    for (const id of moduleOwned) {
      expect(classifyControl(id), id).toBe('module');
    }
  });

  it('transport buttons fall through to module (handled by dedicated bridge methods)', () => {
    const buttons = [
      'MON_RUN_STOP',
      'MON_RESET',
      'MON_HOLD',
      'ANV_RUN_STOP',
      'ANV_ADVANCE',
      'ANV_TRIGGER',
      'CAS_PLAY',
      'CAS_TRIGGER_BTN',
      'CAS_RESET',
      'CAS_NEXT',
    ];
    for (const id of buttons) {
      expect(classifyControl(id), id).toBe('module');
    }
  });

  it('near-miss / unknown ids fall through to module', () => {
    const nearMisses = [
      'CAS_RHYTHM_0',
      'CAS_RHYTHM_5',
      'CAS_RHYTHM_17',
      'CAS_RHYTHM5_SEQ1',
      'CAS_RHYTHM1_SEQ3',
      'CAS_RHYTHM1_SEQ',
      'ANV_SEQ_PITCH_0',
      'ANV_SEQ_PITCH_9',
      'ANV_SEQ_VELOCITY_0',
      'ANV_SEQ_VELOCITY_9',
      'MON_TEMPO_IN', // jack id, not a control
      'ANV_TEMPO_IN',
      'CAS_CLOCK_IN',
      'NOT_A_CONTROL',
      '',
    ];
    for (const id of nearMisses) {
      expect(classifyControl(id), id || '(empty)').toBe('module');
    }
  });

  it('parses 0-based indices for the indexed routes', () => {
    for (let n = 1; n <= 8; n++) {
      expect(parseControlRoute(`ANV_SEQ_PITCH_${n}`).index).toBe(n - 1);
      expect(parseControlRoute(`ANV_SEQ_VELOCITY_${n}`).index).toBe(n - 1);
    }
    for (let n = 1; n <= 4; n++) {
      expect(parseControlRoute(`CAS_RHYTHM_${n}`).index).toBe(n - 1);
      for (const seq of [1, 2] as const) {
        const parsed = parseControlRoute(`CAS_RHYTHM${n}_SEQ${seq}`);
        expect(parsed.index).toBe(n - 1);
        expect(parsed.seq).toBe(seq - 1);
      }
    }
  });
});

/**
 * Sampler bridge surface (PURE / store-level — unpowered, so engine writes are no-ops).
 * Proves the SAMP_* jacks are recognised by the bridge's jack index (separate from the
 * engine router) and that pad LEVEL/TUNE commits land in state.sampler.pads, not
 * state.controls.
 */
describe('engineBridge sampler surface', () => {
  it('recognises SAMP_* jack directions via the bridge jack index', () => {
    expect(engineBridge.isOutputJack('SAMP_PAD1_OUT')).toBe(true);
    expect(engineBridge.isOutputJack('SAMP_MIX_OUT')).toBe(true);
    expect(engineBridge.isOutputJack('SAMP_PAD1_TRIG_IN')).toBe(false);
  });

  it('validates patches to/from sampler jacks', () => {
    // pad OUT -> an Monarch CV input
    expect(engineBridge.validatePatch('SAMP_PAD1_OUT', 'MON_VCF_CUTOFF_IN').ok).toBe(true);
    // an internal trigger OUT -> a pad TRIG input
    expect(engineBridge.validatePatch('ANV_TRIGGER_OUT', 'SAMP_PAD1_TRIG_IN').ok).toBe(true);
    // a TRIG input is not a valid source
    expect(engineBridge.validatePatch('SAMP_PAD1_TRIG_IN', 'MON_VCF_CUTOFF_IN').ok).toBe(false);
  });

  it('getPadState pre-loads the factory kit on an untouched pad', () => {
    // defaultStudioState now seeds the 8-piece kit (pad t = FACTORY_KIT[t]); pad 5 is the Low Tom.
    expect(engineBridge.getPadState(5)).toEqual(defaultFactoryPad(5));
    expect(engineBridge.getPadState(5).sampleId).toBe(FACTORY_KIT[5]!.id);
  });

  it('commitPadControl writes the value into state.sampler.pads (not state.controls)', () => {
    engineBridge.commitPadControl(0, 'level', 0.4);
    expect(engineBridge.store.getState().sampler.pads[0]!.level).toBe(0.4);
    expect(engineBridge.getPadState(0).level).toBe(0.4);
    // never leaks into the controls map (would be dropped by applyState's sampler guard)
    expect(engineBridge.store.getState().controls['sampler'] ?? {}).toEqual({});

    engineBridge.commitPadControl(0, 'tuneSemis', -7);
    const pad = engineBridge.getPadState(0);
    expect(pad.tuneSemis).toBe(-7);
    expect(pad.level).toBe(0.4); // other field preserved across commits
  });
});

/**
 * Loop-quantize bridge surface (PURE / store-level — unpowered, so engine writes are
 * no-ops; only the store commit is observable). Uses pad indices 2/3 so it never
 * disturbs the getPadState(5)===defaultFactoryPad(5) and commitPadControl(0,...) expectations
 * in the singleton bridge above.
 */
describe('engineBridge loop-quantize surface', () => {
  it('setQuantize / getQuantize round-trip through the store', () => {
    expect(engineBridge.getQuantize()).toBe('1 BAR'); // default
    engineBridge.setQuantize('1/8');
    expect(engineBridge.getQuantize()).toBe('1/8');
    expect(engineBridge.store.getState().sampler.quantize).toBe('1/8');
    engineBridge.setQuantize('OFF');
    expect(engineBridge.getQuantize()).toBe('OFF');
    // defensive: an invalid division is ignored (last valid value stands)
    engineBridge.setQuantize('nope' as unknown as Parameters<typeof engineBridge.setQuantize>[0]);
    expect(engineBridge.getQuantize()).toBe('OFF');
    engineBridge.setQuantize('1 BAR'); // restore default for any later reader
  });

  it('setPadLoop writes sampler.pads[i].loop without leaking into controls', () => {
    expect(engineBridge.getPadState(2).loop).toBe(false); // default
    engineBridge.setPadLoop(2, true);
    expect(engineBridge.getPadState(2).loop).toBe(true);
    expect(engineBridge.store.getState().sampler.pads[2]!.loop).toBe(true);
    expect(engineBridge.store.getState().controls['sampler'] ?? {}).toEqual({});
    engineBridge.setPadLoop(2, false);
    expect(engineBridge.getPadState(2).loop).toBe(false);
  });

  it('setPadLoop preserves the rest of the pad meta', () => {
    engineBridge.commitPadControl(3, 'level', 0.55);
    engineBridge.setPadLoop(3, true);
    const pad = engineBridge.getPadState(3);
    expect(pad.loop).toBe(true);
    expect(pad.level).toBe(0.55); // other fields survive the loop toggle
  });

  it('isPadLoopSounding is false while unpowered', () => {
    expect(engineBridge.isPadLoopSounding(0)).toBe(false);
  });
});

/**
 * Per-pad FACTORY picker bridge surface (PURE / store-level — unpowered, so the engine write is a
 * no-op; only the coalesced store commit is observable). Uses pad index 4 so it never disturbs the
 * getPadState(5) pre-load expectation or the level/loop pads (0/2/3) above. The reference-gated
 * free of a replaced USER sample is proven in engineBridgePresets.test.ts (it owns the backend seam).
 */
describe('engineBridge factory picker surface', () => {
  it('assignFactoryToPad commits the kit {sampleId, sampleName} without leaking into controls', () => {
    // Reassign pad 4 (default Open Hat) to the Snare and back.
    engineBridge.assignFactoryToPad(4, 'factory-snare');
    let pad = engineBridge.getPadState(4);
    expect(pad.sampleId).toBe('factory-snare');
    expect(pad.sampleName).toBe('Snare');
    expect(engineBridge.store.getState().sampler.pads[4]!.sampleId).toBe('factory-snare');
    // never leaks into the controls map
    expect(engineBridge.store.getState().controls['sampler'] ?? {}).toEqual({});

    // restore the pad's default kit assignment (Open Hat) for any later reader
    engineBridge.assignFactoryToPad(4, FACTORY_KIT[4]!.id);
    pad = engineBridge.getPadState(4);
    expect(pad.sampleId).toBe(FACTORY_KIT[4]!.id);
    expect(pad.sampleName).toBe(FACTORY_KIT[4]!.name);
  });

  it('assignFactoryToPad preserves the rest of the pad meta (level / tune / loop)', () => {
    engineBridge.commitPadControl(4, 'level', 0.6);
    engineBridge.commitPadControl(4, 'tuneSemis', 3);
    engineBridge.setPadLoop(4, true);
    engineBridge.assignFactoryToPad(4, 'factory-clap');
    const pad = engineBridge.getPadState(4);
    expect(pad.sampleId).toBe('factory-clap');
    expect(pad.level).toBe(0.6); // LEVEL/TUNE/LOOP survive the sound swap
    expect(pad.tuneSemis).toBe(3);
    expect(pad.loop).toBe(true);
    // reset pad 4 back to its kit default so the suite stays order-independent
    engineBridge.assignFactoryToPad(4, FACTORY_KIT[4]!.id);
    engineBridge.commitPadControl(4, 'level', defaultFactoryPad(4).level);
    engineBridge.commitPadControl(4, 'tuneSemis', defaultFactoryPad(4).tuneSemis);
    engineBridge.setPadLoop(4, defaultFactoryPad(4).loop);
  });

  it('assignFactoryToPad ignores an out-of-range pad index and an unknown factory id', () => {
    const before = engineBridge.getPadState(4).sampleId;
    engineBridge.assignFactoryToPad(8, 'factory-kick'); // index out of range -> no-op
    engineBridge.assignFactoryToPad(-1, 'factory-kick'); // index out of range -> no-op
    engineBridge.assignFactoryToPad(4, 'factory-nope'); // unknown id -> no-op
    engineBridge.assignFactoryToPad(4, 'user-1234'); // non-manifest id -> no-op
    expect(engineBridge.getPadState(4).sampleId).toBe(before); // pad 4 unchanged
  });
});

/**
 * Drum step sequencer bridge surface (PURE / store-level — unpowered, so engine writes are
 * no-ops; only the coalesced store commit is observable). Each test starts from a known
 * clean grid (clearDrumPattern + drumStop) so it is order-independent against the singleton
 * bridge shared with the cases above.
 */
describe('engineBridge drum step sequencer surface', () => {
  beforeEach(() => {
    engineBridge.clearDrumPattern();
    engineBridge.drumStop();
  });

  it('getPattern returns an 8x16 all-false grid on a clean store', () => {
    const pattern = engineBridge.getPattern();
    expect(pattern.length).toBe(8);
    for (const row of pattern) {
      expect(row.length).toBe(16);
      expect(row.every((cell) => cell === false)).toBe(true);
    }
  });

  it('setDrumStep commits the coalesced 8x16 pattern to the store', () => {
    engineBridge.setDrumStep(0, 0, true);
    engineBridge.setDrumStep(3, 7, true);
    expect(engineBridge.getStep(0, 0)).toBe(true);
    expect(engineBridge.getStep(3, 7)).toBe(true);
    // the persisted slice is a full 8x16 strict-boolean grid
    const stored = engineBridge.store.getState().sampler.pattern;
    expect(stored.length).toBe(8);
    expect(stored[0]!.length).toBe(16);
    expect(stored[0]![0]).toBe(true);
    expect(stored[3]![7]).toBe(true);
    // every other cell stays false
    expect(stored[0]![1]).toBe(false);
    expect(stored[1]!.every((c) => c === false)).toBe(true);
  });

  it('out-of-range track/step is a no-op (never a ragged write)', () => {
    const before = JSON.parse(JSON.stringify(engineBridge.getPattern())) as boolean[][];
    engineBridge.setDrumStep(-1, 0, true);
    engineBridge.setDrumStep(8, 0, true);
    engineBridge.setDrumStep(0, -1, true);
    engineBridge.setDrumStep(0, 16, true);
    engineBridge.toggleStep(-1, 0);
    engineBridge.toggleStep(0, 16);
    expect(engineBridge.getPattern()).toEqual(before);
  });

  it('toggleStep flips a cell and a second toggle flips it back (idempotent pair)', () => {
    expect(engineBridge.getStep(2, 5)).toBe(false);
    engineBridge.toggleStep(2, 5);
    expect(engineBridge.getStep(2, 5)).toBe(true);
    engineBridge.toggleStep(2, 5);
    expect(engineBridge.getStep(2, 5)).toBe(false);
  });

  it('clearDrumPattern zeroes the whole grid', () => {
    engineBridge.setDrumStep(1, 1, true);
    engineBridge.setDrumStep(6, 14, true);
    engineBridge.clearDrumPattern();
    const pattern = engineBridge.getPattern();
    expect(pattern.every((row) => row.every((cell) => cell === false))).toBe(true);
  });

  it('drumRun / drumStop persist seqRunning in the store', () => {
    expect(engineBridge.getDrumSeqRunning()).toBe(false);
    engineBridge.drumRun();
    expect(engineBridge.getDrumSeqRunning()).toBe(true);
    expect(engineBridge.store.getState().sampler.seqRunning).toBe(true);
    engineBridge.drumStop();
    expect(engineBridge.getDrumSeqRunning()).toBe(false);
    expect(engineBridge.store.getState().sampler.seqRunning).toBe(false);
  });

  it('drum actions never leak into the controls map', () => {
    engineBridge.setDrumStep(4, 4, true);
    engineBridge.drumRun();
    expect(engineBridge.store.getState().controls['sampler'] ?? {}).toEqual({});
    engineBridge.drumStop();
  });

  it('getStepPosition(drum) is -1 initially and drumRunning is false on the fresh bridge', () => {
    expect(engineBridge.getStepPosition('drum')).toBe(-1);
    expect(engineBridge.getTransportFlags().drumRunning).toBe(false);
  });
});

/**
 * Keyboard + Web MIDI bridge surface (feature: keyboard). The bridge is a SHARED singleton
 * reused by every suite in this file, so each test resets the mono stack + octave in a
 * beforeEach (releaseAllNotes + setKeyboardOctave(0)) to stay order-independent.
 *
 * The store-level cases run unpowered (engine writes are no-ops). The mono-semantics / vv
 * cases need the engine WRITE to be observable, so they spy on the real Studio's
 * monarchNoteOn/monarchNoteOff (mockImplementation replaces the body, so NO AudioContext is touched)
 * and temporarily flip the private _powered — restored in afterEach so the singleton is left
 * exactly as found for the suites above and below.
 */
interface BridgePrivates {
  _powered: boolean;
  studioInstance: {
    monarchNoteOn(noteVv: number, retrigger: boolean): void;
    monarchNoteOff(): void;
    courierNoteOn(noteVv: number, retrigger: boolean, velocityVv?: number): void;
    courierNoteOff(): void;
    courierPitchBend(semitones: number): void;
    courierModWheel(amount01: number): void;
    monarch: { setControl(id: string, value: number | string): void };
    anvil: { setControl(id: string, value: number | string): void };
    cascade: { setControl(id: string, value: number | string): void };
    courier: { setControl(id: string, value: number | string): void };
    sampler: { setControl(id: string, value: number | string): void };
  } | null;
}

describe('engineBridge keyboard surface (store-level, unpowered)', () => {
  beforeEach(() => {
    engineBridge.releaseAllNotes();
    engineBridge.setKeyboardOctave(0);
  });

  it('setKeyboardOctave commits + round-trips through state.keyboard.octave', () => {
    engineBridge.setKeyboardOctave(2);
    expect(engineBridge.getKeyboardOctave()).toBe(2);
    expect(engineBridge.store.getState().keyboard.octave).toBe(2);
    engineBridge.setKeyboardOctave(-1);
    expect(engineBridge.getKeyboardOctave()).toBe(-1);
    expect(engineBridge.store.getState().keyboard.octave).toBe(-1);
  });

  it('setKeyboardOctave clamps to -3..+3 and integer-guards (matches coalesceKeyboardState)', () => {
    engineBridge.setKeyboardOctave(99);
    expect(engineBridge.getKeyboardOctave()).toBe(3);
    engineBridge.setKeyboardOctave(-99);
    expect(engineBridge.getKeyboardOctave()).toBe(-3);
    // non-integer -> coalesce default 0
    engineBridge.setKeyboardOctave(1.5);
    expect(engineBridge.getKeyboardOctave()).toBe(0);
  });

  it('keyboard commits never leak into the controls map', () => {
    engineBridge.setKeyboardOctave(3);
    expect(engineBridge.store.getState().controls['sampler'] ?? {}).toEqual({});
    expect(engineBridge.store.getState().controls['keyboard'] ?? undefined).toBeUndefined();
  });

  it('noteOn / noteOff / releaseAllNotes are safe no-ops while unpowered (no throw)', () => {
    expect(() => {
      engineBridge.noteOn(60, 100);
      engineBridge.noteOn(64, 100);
      engineBridge.noteOff(60);
      engineBridge.noteOff(64);
      engineBridge.releaseAllNotes();
    }).not.toThrow();
  });

  it('getMidiStatus is { state:"disabled", deviceCount:0, deviceNames:[] } initially', () => {
    const status = engineBridge.getMidiStatus();
    expect(status.state).toBe('disabled');
    expect(status.deviceCount).toBe(0);
    expect(status.deviceNames).toEqual([]);
  });

  it('enableMidi resolves to "unsupported" under Node (no navigator.requestMIDIAccess), never throws', async () => {
    const status = await engineBridge.enableMidi();
    expect(status.state).toBe('unsupported');
    expect(status.deviceCount).toBe(0);
    expect(status.deviceNames).toEqual([]);
  });
});

describe('engineBridge keyboard mono semantics (engine writes spied; AudioContext-free)', () => {
  // Force the real Studio to exist (touching .store lazily constructs it), grab the private
  // handles, and spy on the two Monarch passthroughs so the engine-facing vv + retrigger are
  // observable without a real AudioContext.
  const priv = engineBridge as unknown as BridgePrivates;
  let monarchNoteOn: ReturnType<typeof vi.fn>;
  let monarchNoteOff: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Construct + reach the real Studio instance (audio-free constructor).
    void engineBridge.store;
    const studio = priv.studioInstance!;
    monarchNoteOn = vi.fn();
    monarchNoteOff = vi.fn();
    vi.spyOn(studio, 'monarchNoteOn').mockImplementation(monarchNoteOn);
    vi.spyOn(studio, 'monarchNoteOff').mockImplementation(monarchNoteOff);
    engineBridge.releaseAllNotes();
    engineBridge.setKeyboardOctave(0);
    monarchNoteOn.mockClear();
    monarchNoteOff.mockClear();
    priv._powered = true;
  });

  afterEach(() => {
    // Drop any held note while still "powered" so the stack + gate are clean, then unpower
    // and restore the real passthroughs — the singleton is left exactly as the other suites
    // expect it (unpowered, octave 0, empty stack).
    engineBridge.releaseAllNotes();
    priv._powered = false;
    vi.restoreAllMocks();
    engineBridge.setKeyboardOctave(0);
  });

  it('single note: noteOn -> monarchNoteOn(vv, retrigger=true), noteOff -> monarchNoteOff', () => {
    engineBridge.noteOn(60, 100); // middle C
    expect(monarchNoteOn).toHaveBeenCalledTimes(1);
    expect(monarchNoteOn).toHaveBeenLastCalledWith(0, true); // noteToVv(60)=0; fresh attack retriggers
    engineBridge.noteOff(60);
    expect(monarchNoteOff).toHaveBeenCalledTimes(1);
  });

  it('vv mapping: 72 -> +1, 48 -> -1, 61 -> 1/12', () => {
    engineBridge.noteOn(72, 100);
    expect(monarchNoteOn).toHaveBeenLastCalledWith(1, true);
    engineBridge.releaseAllNotes();
    monarchNoteOn.mockClear();
    engineBridge.noteOn(48, 100);
    expect(monarchNoteOn).toHaveBeenLastCalledWith(-1, true);
    engineBridge.releaseAllNotes();
    monarchNoteOn.mockClear();
    engineBridge.noteOn(61, 100);
    expect(monarchNoteOn).toHaveBeenLastCalledWith(noteToVv(61), true);
    expect(noteToVv(61)).toBeCloseTo(1 / 12, 10);
  });

  it('legato stacking: second note is retrigger=false, pitch follows the new top', () => {
    engineBridge.noteOn(60, 100); // retrigger=true
    monarchNoteOn.mockClear();
    engineBridge.noteOn(64, 100); // legato: gate already high
    expect(monarchNoteOn).toHaveBeenCalledTimes(1);
    expect(monarchNoteOn).toHaveBeenLastCalledWith(noteToVv(64), false);
    expect(monarchNoteOff).not.toHaveBeenCalled();
  });

  it('release the top note falls back to the held note (gate stays high, retrigger=false)', () => {
    engineBridge.noteOn(60, 100);
    engineBridge.noteOn(64, 100); // top = 64
    monarchNoteOn.mockClear();
    monarchNoteOff.mockClear();
    engineBridge.noteOff(64); // fall back to 60
    expect(monarchNoteOff).not.toHaveBeenCalled();
    expect(monarchNoteOn).toHaveBeenCalledTimes(1);
    expect(monarchNoteOn).toHaveBeenLastCalledWith(noteToVv(60), false);
  });

  it('releasing a non-top held note writes nothing (gate:unchanged)', () => {
    engineBridge.noteOn(60, 100);
    engineBridge.noteOn(64, 100); // top = 64
    monarchNoteOn.mockClear();
    monarchNoteOff.mockClear();
    engineBridge.noteOff(60); // not the top -> no engine write
    expect(monarchNoteOn).not.toHaveBeenCalled();
    expect(monarchNoteOff).not.toHaveBeenCalled();
  });

  it('releasing the last held note gates off', () => {
    engineBridge.noteOn(60, 100);
    monarchNoteOn.mockClear();
    engineBridge.noteOff(60);
    expect(monarchNoteOff).toHaveBeenCalledTimes(1);
  });

  it('velocity 0 routes noteOn -> noteOff (MIDI running-status guard)', () => {
    engineBridge.noteOn(60, 100); // real note on
    monarchNoteOn.mockClear();
    monarchNoteOff.mockClear();
    engineBridge.noteOn(60, 0); // running-status note-off
    expect(monarchNoteOn).not.toHaveBeenCalled();
    expect(monarchNoteOff).toHaveBeenCalledTimes(1); // gated off (was the only held note)
  });

  it('octave offset is applied to the vv EXACTLY once (no double-shift)', () => {
    engineBridge.setKeyboardOctave(1);
    engineBridge.noteOn(60, 100);
    // noteToVv(60)=0, +1 octave -> vv 1, applied a single time in the bridge
    expect(monarchNoteOn).toHaveBeenLastCalledWith(1, true);
    engineBridge.releaseAllNotes();
    monarchNoteOn.mockClear();
    engineBridge.setKeyboardOctave(-2);
    engineBridge.noteOn(72, 100); // noteToVv(72)=1, -2 -> vv -1
    expect(monarchNoteOn).toHaveBeenLastCalledWith(-1, true);
  });

  it('releaseAllNotes gates off and clears the stack (next press retriggers fresh)', () => {
    engineBridge.noteOn(60, 100);
    engineBridge.noteOn(64, 100);
    monarchNoteOff.mockClear();
    engineBridge.releaseAllNotes();
    expect(monarchNoteOff).toHaveBeenCalledTimes(1); // single panic gate-off
    monarchNoteOn.mockClear();
    engineBridge.noteOn(67, 100); // empty stack -> fresh attack
    expect(monarchNoteOn).toHaveBeenLastCalledWith(noteToVv(67), true);
  });
});

describe('engineBridge keyboard target select (Courier vs Monarch; engine writes spied)', () => {
  // Spy BOTH voices' Studio passthroughs (mockImplementation replaces the body, so no
  // AudioContext is touched) and prove a note reaches exactly one. The vv + retrigger args are
  // observable identically for either target — only applyVoiceAction's dispatch differs.
  const priv = engineBridge as unknown as BridgePrivates;
  let monarchNoteOn: ReturnType<typeof vi.fn>;
  let monarchNoteOff: ReturnType<typeof vi.fn>;
  let courierNoteOn: ReturnType<typeof vi.fn>;
  let courierNoteOff: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    void engineBridge.store;
    const studio = priv.studioInstance!;
    monarchNoteOn = vi.fn();
    monarchNoteOff = vi.fn();
    courierNoteOn = vi.fn();
    courierNoteOff = vi.fn();
    vi.spyOn(studio, 'monarchNoteOn').mockImplementation(monarchNoteOn);
    vi.spyOn(studio, 'monarchNoteOff').mockImplementation(monarchNoteOff);
    vi.spyOn(studio, 'courierNoteOn').mockImplementation(courierNoteOn);
    vi.spyOn(studio, 'courierNoteOff').mockImplementation(courierNoteOff);
    engineBridge.releaseAllNotes();
    engineBridge.setKeyboardOctave(0);
    engineBridge.setKeyboardTarget('monarch');
    monarchNoteOn.mockClear();
    monarchNoteOff.mockClear();
    courierNoteOn.mockClear();
    courierNoteOff.mockClear();
    priv._powered = true;
  });

  afterEach(() => {
    engineBridge.releaseAllNotes();
    priv._powered = false;
    vi.restoreAllMocks();
    engineBridge.setKeyboardTarget('monarch');
    engineBridge.setKeyboardOctave(0);
  });

  it('defaults to monarch: the original keyboard voice is unchanged', () => {
    expect(engineBridge.getKeyboardTarget()).toBe('monarch');
    engineBridge.noteOn(60, 100);
    expect(monarchNoteOn).toHaveBeenCalledTimes(1);
    expect(courierNoteOn).not.toHaveBeenCalled();
  });

  it('with Courier selected, a fresh note routes to courierNoteOn(vv, true), NOT Monarch', () => {
    engineBridge.setKeyboardTarget('courier');
    monarchNoteOff.mockClear(); // the flip released a (empty) stack — ignore any gate-off here
    engineBridge.noteOn(72, 100); // noteToVv(72) = +1
    expect(courierNoteOn).toHaveBeenCalledTimes(1);
    expect(courierNoteOn).toHaveBeenLastCalledWith(1, true, expect.any(Number)); // fresh attack retriggers
    expect(monarchNoteOn).not.toHaveBeenCalled();
    expect(monarchNoteOff).not.toHaveBeenCalled();
  });

  it('Courier noteOff routes to courierNoteOff, and Monarch is untouched', () => {
    engineBridge.setKeyboardTarget('courier');
    engineBridge.noteOn(60, 100);
    courierNoteOff.mockClear();
    monarchNoteOff.mockClear();
    engineBridge.noteOff(60);
    expect(courierNoteOff).toHaveBeenCalledTimes(1);
    expect(monarchNoteOff).not.toHaveBeenCalled();
  });

  it('Courier legato: second note is retrigger=false (pitch follows the new top)', () => {
    engineBridge.setKeyboardTarget('courier');
    engineBridge.noteOn(60, 100); // fresh attack, retrigger=true
    courierNoteOn.mockClear();
    engineBridge.noteOn(64, 100); // legato
    expect(courierNoteOn).toHaveBeenCalledTimes(1);
    expect(courierNoteOn).toHaveBeenLastCalledWith(noteToVv(64), false, expect.any(Number));
    expect(courierNoteOff).not.toHaveBeenCalled();
  });

  it('octave applies once on the Courier path too (no double-shift)', () => {
    engineBridge.setKeyboardTarget('courier');
    engineBridge.setKeyboardOctave(1);
    engineBridge.noteOn(60, 100); // noteToVv(60)=0, +1 octave -> vv 1
    expect(courierNoteOn).toHaveBeenLastCalledWith(1, true, expect.any(Number));
  });

  it('flipping target mid-hold gates OFF the old voice (no stranded gate)', () => {
    engineBridge.noteOn(60, 100); // held on Monarch
    expect(monarchNoteOn).toHaveBeenCalledTimes(1);
    monarchNoteOff.mockClear();
    engineBridge.setKeyboardTarget('courier'); // releaseAllNotes() fires the Monarch gate-off
    expect(monarchNoteOff).toHaveBeenCalledTimes(1);
    // The next press now plays Courier with a clean (retriggered) attack.
    engineBridge.noteOn(67, 100);
    expect(courierNoteOn).toHaveBeenLastCalledWith(noteToVv(67), true, expect.any(Number));
  });

  it('threads MIDI note velocity into courierNoteOn (0..127 -> 0..5 vv)', () => {
    engineBridge.setKeyboardTarget('courier');
    courierNoteOn.mockClear();
    engineBridge.noteOn(60, 64); // mid MIDI velocity
    expect(courierNoteOn).toHaveBeenLastCalledWith(0, true, (64 / 127) * 5);
  });

  it('a legato fall-back uses the still-held note’s own velocity (per-note map)', () => {
    engineBridge.setKeyboardTarget('courier');
    engineBridge.noteOn(60, 40); // soft, held underneath
    engineBridge.noteOn(64, 120); // louder note on top (legato)
    courierNoteOn.mockClear();
    engineBridge.noteOff(64); // release the top -> fall back to the still-held 60
    expect(courierNoteOn).toHaveBeenLastCalledWith(noteToVv(60), false, (40 / 127) * 5);
  });

  it('setKeyboardTarget is idempotent (same target does not release a held note)', () => {
    engineBridge.noteOn(60, 100);
    monarchNoteOff.mockClear();
    engineBridge.setKeyboardTarget('monarch'); // no change -> no release
    expect(monarchNoteOff).not.toHaveBeenCalled();
  });

  it('step-record is gated on the Monarch target (no bleed into the Monarch grid from Courier)', () => {
    const recorded: number[] = [];
    engineBridge.setMonarchRecordHandler((vv) => recorded.push(vv));
    engineBridge.setKeyboardTarget('courier');
    engineBridge.noteOn(60, 100); // plays Courier; must NOT write a Monarch step
    expect(recorded).toEqual([]);
    engineBridge.setKeyboardTarget('monarch');
    engineBridge.noteOn(62, 100); // now Monarch -> records
    expect(recorded).toEqual([noteToVv(62)]);
    engineBridge.setMonarchRecordHandler(null);
  });
});

describe('engineBridge Courier wheels (pitch bend + mod wheel, runtime-only)', () => {
  const priv = engineBridge as unknown as BridgePrivates;
  let pitchBend: ReturnType<typeof vi.fn>;
  let modWheel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    void engineBridge.store;
    const studio = priv.studioInstance!;
    pitchBend = vi.fn();
    modWheel = vi.fn();
    vi.spyOn(studio, 'courierPitchBend').mockImplementation(pitchBend);
    vi.spyOn(studio, 'courierModWheel').mockImplementation(modWheel);
  });

  afterEach(() => {
    priv._powered = false;
    vi.restoreAllMocks();
  });

  it('does nothing while unpowered (no throw, no engine call) — the runtime-only guard', () => {
    priv._powered = false;
    expect(() => engineBridge.setCourierPitchBend(0.5)).not.toThrow();
    expect(() => engineBridge.setCourierModWheel(0.5)).not.toThrow();
    expect(pitchBend).not.toHaveBeenCalled();
    expect(modWheel).not.toHaveBeenCalled();
  });

  it('pitch wheel maps the bipolar position to ±7 semitones', () => {
    priv._powered = true;
    engineBridge.setCourierPitchBend(1);
    expect(pitchBend).toHaveBeenLastCalledWith(7); // full up = +7 st (a perfect fifth)
    engineBridge.setCourierPitchBend(-1);
    expect(pitchBend).toHaveBeenLastCalledWith(-7); // full down = -7 st
    engineBridge.setCourierPitchBend(0);
    expect(pitchBend).toHaveBeenLastCalledWith(0); // center
  });

  it('mod wheel forwards the 0..1 position straight through', () => {
    priv._powered = true;
    engineBridge.setCourierModWheel(0);
    expect(modWheel).toHaveBeenLastCalledWith(0);
    engineBridge.setCourierModWheel(0.75);
    expect(modWheel).toHaveBeenLastCalledWith(0.75);
    engineBridge.setCourierModWheel(1);
    expect(modWheel).toHaveBeenLastCalledWith(1);
  });

  it('writes NO serializable state (the wheels are performance gestures, not preset state)', () => {
    priv._powered = true;
    const before = JSON.stringify(engineBridge.store.getState());
    engineBridge.setCourierPitchBend(0.4);
    engineBridge.setCourierModWheel(0.6);
    expect(JSON.stringify(engineBridge.store.getState())).toBe(before); // round-trip unchanged
  });
});

describe('engineBridge module routing (applyControlInput -> the right module.setControl)', () => {
  // Regression guard: moduleFor() once defaulted every non-monarch/anvil id to cascade, so the
  // ENTIRE Courier (and sampler) panel surface routed to CascadeModule.setControl and was silently
  // dropped. Prove each module id reaches ITS OWN setControl and nobody else's. The real module
  // fields aren't built until powerOn (needs an AudioContext), so swap in mock modules + restore.
  const priv = engineBridge as unknown as BridgePrivates;
  const IDS = ['monarch', 'anvil', 'cascade', 'courier', 'sampler'] as const;
  let studio: Record<string, { setControl: (id: string, value: number | string) => void }>;
  let originals: Record<string, unknown>;
  let spies: Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    void engineBridge.store;
    studio = priv.studioInstance as unknown as typeof studio;
    originals = {};
    spies = {};
    for (const id of IDS) {
      originals[id] = studio[id];
      spies[id] = vi.fn();
      studio[id] = { setControl: spies[id]! };
    }
    priv._powered = true;
  });
  afterEach(() => {
    priv._powered = false;
    for (const id of IDS) studio[id] = originals[id] as (typeof studio)[string];
  });

  it('routes a Courier control to CourierModule.setControl (not Cascade)', () => {
    engineBridge.applyControlInput('courier', 'COU_OSC1_WAVESHAPE', 0.3);
    expect(spies['courier']).toHaveBeenCalledWith('COU_OSC1_WAVESHAPE', 0.3);
    expect(spies['cascade']).not.toHaveBeenCalled();
  });

  it('routes a Sampler control to SamplerModule.setControl (not Cascade)', () => {
    engineBridge.applyControlInput('sampler', 'SAMP_PAD1_LEVEL', 0.5);
    expect(spies['sampler']).toHaveBeenCalledWith('SAMP_PAD1_LEVEL', 0.5);
    expect(spies['cascade']).not.toHaveBeenCalled();
  });

  it('still routes monarch / anvil / cascade to their own modules (no regression)', () => {
    engineBridge.applyControlInput('monarch', 'MON_VCF_CUTOFF', 0.6);
    engineBridge.applyControlInput('anvil', 'ANV_VCO_DECAY', 0.4);
    engineBridge.applyControlInput('cascade', 'CAS_CUTOFF', 0.7);
    expect(spies['monarch']).toHaveBeenCalledWith('MON_VCF_CUTOFF', 0.6);
    expect(spies['anvil']).toHaveBeenCalledWith('ANV_VCO_DECAY', 0.4);
    expect(spies['cascade']).toHaveBeenCalledWith('CAS_CUTOFF', 0.7);
    expect(spies['courier']).not.toHaveBeenCalled();
  });
});
