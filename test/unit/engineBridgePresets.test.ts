/**
 * Engine-bridge PRESETS + SAVE/LOAD seam (PURE / store-level — the singleton bridge is
 * UNPOWERED throughout, so every engine write is a no-op and only the store + localStorage +
 * sample-backend effects are observable). DISJOINT from engineBridge.test.ts /
 * engineBridgeRecording.test.ts so the preset slice never collides with the routing / sampler /
 * keyboard / recording suites that share the same singleton bridge.
 *
 * What is provable headlessly here:
 *   - slot save/list/load/delete round-trips through a tiny in-test localStorage stub (the
 *     bridge is the FIRST localStorage consumer; its try/catch must also no-op when absent),
 *   - loadFactoryPreset(known id) applies the recipe to the store (controls/sampler/transport
 *     present, all running flags false); unknown id is a no-op,
 *   - importSetup of a buildBundle(...)-built JSON File restores the state + returns { ok:true };
 *     a foreign / corrupt file returns { ok:false } and leaves the store untouched (no-throw),
 *   - the import sample-byte ORDERING (resetAll BEFORE importSamples) re-puts a colliding
 *     outgoing id's BUNDLE byte LAST on the key — proven at g2's importSamples seam against a
 *     MemoryBackend we control (the singleton bridge's backend is module-private),
 *   - coalesceStudioState integration: a partial tree loads clean (version 1, flags false).
 *
 * The REAL powered restore (buffer decode, RHYTHM dividers reaching cascadeClock, etc.) is a
 * manual checkpoint — no AudioContext under Node. Here _powered stays false, so applyPreset's
 * resetAll + restoreFullState run the store-side of the path and reloadPadBuffers is skipped.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { engineBridge, __setSampleBackendForTests } from '../../src/ui/engineBridge';
import {
  defaultStudioState,
  type StudioState,
} from '../../src/state/studioState';
import {
  buildBundle,
  collectUserSampleIds,
  type PresetBundle,
} from '../../src/state/presets';
import { listFactoryPresets } from '../../src/state/factoryPresets';
import {
  exportSamples,
  importSamples,
  MemoryBackend,
  type SampleBackend,
  type SampleBundleEntry,
} from '../../src/engine/sampleStore';

/** Minimal synchronous localStorage stub (the bridge only uses get/set/remove Item). */
class LocalStorageStub {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

/** A tiny ASCII-bytes File whose .text() resolves to the given JSON (Node has global File). */
function jsonFile(text: string, name = 'preset.json'): File {
  return new File([text], name, { type: 'application/json' });
}

/** Reach the private _powered flag to assert the suite never powers on. */
interface BridgePrivates {
  _powered: boolean;
}

describe('engineBridge presets — slots (localStorage, unpowered)', () => {
  const original = (globalThis as { localStorage?: unknown }).localStorage;
  let stub: LocalStorageStub;

  beforeEach(() => {
    stub = new LocalStorageStub();
    (globalThis as { localStorage?: unknown }).localStorage = stub;
    engineBridge.resetAll(); // clean store before each slot round-trip
  });

  afterEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = original;
  });

  it('starts with no saved slots', () => {
    expect(engineBridge.listSlots()).toEqual([]);
  });

  it('saveSlot -> listSlots -> loadSlot round-trips the StudioState through the store', async () => {
    // Mutate a couple of distinctive store values so the round-trip is observable.
    engineBridge.setQuantize('1/8');
    engineBridge.setKeyboardOctave(2);
    engineBridge.setDrumStep(0, 0, true);

    engineBridge.saveSlot('My Patch');
    expect(engineBridge.listSlots()).toEqual(['My Patch']);

    // Now change the live store away from the saved snapshot...
    engineBridge.setQuantize('OFF');
    engineBridge.setKeyboardOctave(-1);
    engineBridge.clearDrumPattern();
    expect(engineBridge.getQuantize()).toBe('OFF');

    // ...and loading the slot restores it exactly (coalesced; version 1).
    await engineBridge.loadSlot('My Patch');
    const s = engineBridge.store.getState();
    expect(s.version).toBe(1);
    expect(s.sampler.quantize).toBe('1/8');
    expect(s.keyboard.octave).toBe(2);
    expect(s.sampler.pattern[0]![0]).toBe(true);
    // restored presets never spontaneously sound
    expect(s.sampler.seqRunning).toBe(false);
    expect(s.transport.monarch.running).toBe(false);
  });

  it('saveSlot trims the name and ignores an empty / whitespace name', () => {
    engineBridge.saveSlot('  Spaced  ');
    expect(engineBridge.listSlots()).toEqual(['Spaced']);
    engineBridge.saveSlot('   '); // whitespace only -> no-op
    engineBridge.saveSlot(''); // empty -> no-op
    expect(engineBridge.listSlots()).toEqual(['Spaced']);
  });

  it('saveSlot upserts (re-saving the same name does not duplicate the index entry)', () => {
    engineBridge.saveSlot('Dup');
    engineBridge.saveSlot('Dup');
    expect(engineBridge.listSlots()).toEqual(['Dup']);
  });

  it('listSlots returns a sorted copy', () => {
    engineBridge.saveSlot('Zeta');
    engineBridge.saveSlot('Alpha');
    engineBridge.saveSlot('Mu');
    expect(engineBridge.listSlots()).toEqual(['Alpha', 'Mu', 'Zeta']);
  });

  it('deleteSlot removes the name + the per-slot payload', async () => {
    engineBridge.saveSlot('Gone');
    engineBridge.saveSlot('Stays');
    engineBridge.deleteSlot('Gone');
    expect(engineBridge.listSlots()).toEqual(['Stays']);
    // loading a deleted slot is a silent no-op (does not throw, store unchanged shape)
    const before = engineBridge.store.getState();
    await engineBridge.loadSlot('Gone');
    expect(engineBridge.store.getState().version).toBe(before.version);
  });

  it('loadSlot of an unknown name is a silent no-op', async () => {
    await expect(engineBridge.loadSlot('never-saved')).resolves.toBeUndefined();
  });

  it('a corrupt per-slot payload coalesces to the default tree (never throws)', async () => {
    engineBridge.saveSlot('Bad');
    stub.setItem('synthstack-preset:Bad', '{not valid json'); // clobber the payload
    await expect(engineBridge.loadSlot('Bad')).resolves.toBeUndefined();
    const s = engineBridge.store.getState();
    expect(s.version).toBe(1); // default tree, no throw
  });

  it('a corrupt index degrades listSlots to []', () => {
    stub.setItem('synthstack-preset-index', '{not an array');
    expect(engineBridge.listSlots()).toEqual([]);
  });

  it('a slot named "__index__" no longer wipes the slot list (index key is outside the namespace)', async () => {
    // Regression for the INDEX_KEY collision: the old index key sat at SLOT_PREFIX+'__index__',
    // so saveSlot('__index__') overwrote the index and dropped every other slot. With the index
    // key moved out of the SLOT_PREFIX namespace, '__index__' is just another harmless slot.
    engineBridge.setQuantize('1/8');
    engineBridge.saveSlot('Keeper');
    engineBridge.setQuantize('1/4');
    engineBridge.saveSlot('__index__');
    // Both slots survive and both appear in the index.
    expect(engineBridge.listSlots()).toEqual(['Keeper', '__index__'].sort());
    // ...and both load their saved snapshot.
    await engineBridge.loadSlot('Keeper');
    expect(engineBridge.getQuantize()).toBe('1/8');
    await engineBridge.loadSlot('__index__');
    expect(engineBridge.getQuantize()).toBe('1/4');
  });

  it('the suite never powers on', () => {
    expect((engineBridge as unknown as BridgePrivates)._powered).toBe(false);
  });
});

describe('engineBridge presets — slots with NO localStorage (graceful no-op)', () => {
  const original = (globalThis as { localStorage?: unknown }).localStorage;

  beforeEach(() => {
    // Delete the global entirely so `typeof localStorage === 'undefined'` is true in the bridge.
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });

  afterEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = original;
  });

  it('listSlots -> [] and the mutators are no-throw no-ops without localStorage', async () => {
    expect(() => {
      engineBridge.saveSlot('NoStore');
      engineBridge.deleteSlot('NoStore');
    }).not.toThrow();
    expect(engineBridge.listSlots()).toEqual([]);
    await expect(engineBridge.loadSlot('NoStore')).resolves.toBeUndefined();
  });
});

describe('engineBridge presets — factory presets (unpowered)', () => {
  beforeEach(() => {
    engineBridge.resetAll();
  });

  it('loadFactoryPreset applies each shipped recipe to the store (flags false, version 1)', async () => {
    const presets = listFactoryPresets();
    expect(presets.length).toBeGreaterThanOrEqual(3); // 3-4 curated recipes
    for (const { id } of presets) {
      await engineBridge.loadFactoryPreset(id);
      const s = engineBridge.store.getState();
      expect(s.version).toBe(1);
      // a load never spontaneously sounds
      expect(s.transport.monarch.running).toBe(false);
      expect(s.transport.anvil.running).toBe(false);
      expect(s.transport.cascade.playing).toBe(false);
      expect(s.sampler.seqRunning).toBe(false);
      // the recipe seeded the module-JSON control defaults (coalesce's seed loop ran)
      expect(Object.keys(s.controls['monarch'] ?? {}).length).toBeGreaterThan(0);
      // strict grid invariants survive the recipe
      expect(s.transport.monarch.steps.length).toBe(32);
      expect(s.transport.anvil.steps.length).toBe(8);
      expect(s.sampler.pads.length).toBe(8);
      expect(s.sampler.pattern.length).toBe(8);
      expect(s.sampler.pattern[0]!.length).toBe(16);
    }
  });

  it('loadFactoryPreset of an unknown id is a silent no-op', async () => {
    await engineBridge.loadFactoryPreset('factory-preset-cellar-door'); // seed something real
    const before = engineBridge.store.getState();
    await engineBridge.loadFactoryPreset('no-such-preset-xyz');
    // unknown id never touched the store (applyPreset was never called)
    expect(engineBridge.store.getState()).toEqual(before);
  });

  it('the Corner Store sampler recipe references only factory pad ids (no user bytes needed)', async () => {
    await engineBridge.loadFactoryPreset('factory-preset-corner-store');
    const s = engineBridge.store.getState();
    const ids = s.sampler.pads.map((p) => p.sampleId).filter((id): id is string => !!id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id.startsWith('factory-')).toBe(true);
    // -> collectUserSampleIds yields nothing portable for this recipe
    expect(collectUserSampleIds(s)).toEqual([]);
  });
});

describe('engineBridge presets — importSetup (portable bundle, unpowered)', () => {
  beforeEach(() => {
    engineBridge.resetAll();
  });

  it('importSetup of a buildBundle(...) JSON restores the state + returns { ok:true }', async () => {
    // Author a distinctive state, bundle it (no user samples -> empty samples[]), import it.
    const state = defaultStudioState();
    state.controls['monarch'] = { MON_TEMPO: 137 };
    state.keyboard.octave = -2;
    state.sampler.quantize = '1/4';
    const bundle = buildBundle(state, []);
    const result = await engineBridge.importSetup(jsonFile(JSON.stringify(bundle)));
    expect(result.ok).toBe(true);
    const s = engineBridge.store.getState();
    expect(s.controls['monarch']!['MON_TEMPO']).toBe(137);
    expect(s.keyboard.octave).toBe(-2);
    expect(s.sampler.quantize).toBe('1/4');
    expect(s.version).toBe(1);
  });

  it('importSetup of foreign JSON (wrong kind) returns { ok:false } and leaves the store untouched', async () => {
    // Seed a known state, then attempt to import a foreign file.
    engineBridge.setQuantize('1/2');
    const before = engineBridge.store.getState();
    const foreign = JSON.stringify({ kind: 'some-other-app', version: 1, state: {} });
    const result = await engineBridge.importSetup(jsonFile(foreign));
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    // parseBundle returned null BEFORE resetAll, so the store is byte-identical
    expect(engineBridge.store.getState()).toEqual(before);
  });

  it('importSetup of malformed JSON returns { ok:false } (no throw)', async () => {
    const result = await engineBridge.importSetup(jsonFile('{ this is : not json'));
    expect(result.ok).toBe(false);
  });

  it('importSetup of a saved-slot JSON (wrong kind) is rejected', async () => {
    // A slot file is a bare StudioState wrapper, NOT a { kind:'synthstack-preset' } bundle.
    const slotLike = JSON.stringify({ version: 1, savedAt: 1, state: defaultStudioState() });
    const result = await engineBridge.importSetup(jsonFile(slotLike));
    expect(result.ok).toBe(false);
  });

  it('importSetup coalesces a partial bundle state (version forced 1, grids rebuilt)', async () => {
    // A hand-edited bundle whose state is a thin partial — coalesceStudioState must heal it.
    const partial = {
      kind: 'synthstack-preset',
      version: 1,
      state: { controls: { monarch: { MON_TEMPO: 90 } } },
      samples: [],
    };
    const result = await engineBridge.importSetup(jsonFile(JSON.stringify(partial)));
    expect(result.ok).toBe(true);
    const s = engineBridge.store.getState();
    expect(s.version).toBe(1);
    expect(s.controls['monarch']!['MON_TEMPO']).toBe(90);
    expect(s.transport.monarch.steps.length).toBe(32);
    expect(s.transport.anvil.steps.length).toBe(8);
    expect(s.sampler.pattern.length).toBe(8);
  });
});

/**
 * Import sample-byte ORDERING (the colliding-outgoing-id case) — proven at g2's importSamples
 * seam against a MemoryBackend WE control, replicating the bridge's importSetup order:
 *   resetAll (delete outgoing id X) -> importSamples (re-put bundle id X) -> reloadPadBuffers.
 * Because IndexedDB executes transactions in CREATION order on a key, the bridge creates the
 * delete(X) (inside resetAll) BEFORE the put(X) (inside importSamples), so the BUNDLE byte is
 * the LAST write on X and wins. MemoryBackend is synchronous, so the same ordering is exact.
 */
describe('preset import — colliding-id byte ordering (g2 seam, controlled backend)', () => {
  const ENC = (s: string): ArrayBuffer => {
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
    return u.buffer;
  };
  const DEC = (b: ArrayBuffer): string => String.fromCharCode(...new Uint8Array(b));

  it('re-put of a colliding id wins over the outgoing delete (bundle byte survives)', async () => {
    const backend = new MemoryBackend();
    // The OUTGOING setup owns a user sample under id X with OLD bytes...
    await backend.put({ id: 'collide-X', name: 'old', mime: 'audio/wav', bytes: ENC('OLDBYTES') });

    // The incoming bundle also references id X, but with NEW bytes (e.g. re-importing a kit
    // you already own). Build the bundle entry via the same g2 export path.
    const src = new MemoryBackend();
    await src.put({ id: 'collide-X', name: 'new', mime: 'audio/wav', bytes: ENC('NEWBYTES') });
    const entries: SampleBundleEntry[] = await exportSamples(src, ['collide-X']);
    expect(entries.length).toBe(1);

    // Replicate the bridge order: delete the OUTGOING id (resetAll's fire-and-forget delete),
    // THEN importSamples re-puts the bundle id. The later-created put must win.
    await backend.delete('collide-X');
    await importSamples(backend, entries);

    const rec = await backend.get('collide-X');
    expect(rec).not.toBeNull();
    expect(DEC(rec!.bytes)).toBe('NEWBYTES'); // the BUNDLE byte, not the deleted old one
  });

  it('importSetup imports ONLY bundle entries the state references (unreferenced blob is not written)', async () => {
    // A hand-edited bundle can carry extra sample blobs no pad names. The bridge filters the
    // bundle's samples[] to collectUserSampleIds(state) before importSamples, so the leak blob
    // is never written. Replicate the bridge's filter+import order against a backend we control.
    const backend = new MemoryBackend();

    // The bundle state references ONLY 'used-X' on a pad; 'leak-Y' is carried but unreferenced.
    const state: StudioState = defaultStudioState();
    state.sampler.pads[0] = {
      sampleId: 'used-X',
      sampleName: 'kick',
      level: 0.8,
      tuneSemis: 0,
      loop: false,
    };
    const entries: SampleBundleEntry[] = [
      { id: 'used-X', name: 'kick', mime: 'audio/wav', bytesBase64: 'QUJD' /* "ABC" */ },
      { id: 'leak-Y', name: 'orphan', mime: 'audio/wav', bytesBase64: 'WFla' /* "XYZ" */ },
    ];

    const wanted = new Set(collectUserSampleIds(state));
    await importSamples(
      backend,
      entries.filter((e) => wanted.has(e.id)),
    );

    expect(await backend.get('used-X')).not.toBeNull(); // referenced -> imported
    expect(await backend.get('leak-Y')).toBeNull(); // unreferenced -> NOT written (no leak)
  });

  it('a factory-only bundle yields empty samples[] (factory ids carry no bytes)', async () => {
    const state: StudioState = defaultStudioState();
    state.sampler.pads[0] = { sampleId: 'factory-kick', sampleName: 'Kick', level: 0.8, tuneSemis: 0, loop: false };
    const ids = collectUserSampleIds(state);
    expect(ids).toEqual([]); // factory-* dropped by the shared predicate
    const bundle: PresetBundle = buildBundle(state, await exportSamples(new MemoryBackend(), ids));
    expect(bundle.samples).toEqual([]);
    expect(bundle.kind).toBe('synthstack-preset');
  });
});

/**
 * FIX 1 (BLOCKER): reference-aware user-sample-byte deletion. Loading a preset / INIT / pad
 * replace must NEVER delete bytes a live state OR a saved slot still references. The singleton's
 * sample backend is module-private, so we swap in a controlled MemoryBackend via the test seam
 * (mirroring the existing localStorage swap). The bridge stays UNPOWERED here, so loadPadSample
 * runs its unpowered byte-persist path (no decode) and the deletion gate is fully exercised.
 *
 * Each test FAILS without the gate (the old code did `void sampleBackend.delete(id)` for every
 * outgoing/replaced user id unconditionally, erasing a still-referenced sample from the backend).
 */
describe('engineBridge presets — reference-aware sample-byte deletion (FIX 1)', () => {
  const originalLs = (globalThis as { localStorage?: unknown }).localStorage;
  let stub: LocalStorageStub;
  let backend: MemoryBackend;
  let prevBackend: SampleBackend;

  /** A File whose .arrayBuffer() resolves to the given ASCII bytes (Node has global File). */
  const wavFile = (bytes: string, name: string): File =>
    new File([new TextEncoder().encode(bytes)], name, { type: 'audio/wav' });

  beforeEach(() => {
    stub = new LocalStorageStub();
    (globalThis as { localStorage?: unknown }).localStorage = stub;
    backend = new MemoryBackend();
    prevBackend = __setSampleBackendForTests(backend);
    engineBridge.resetAll(); // clean store (no kept states -> any leftover orphan freed)
  });

  afterEach(() => {
    __setSampleBackendForTests(prevBackend);
    (globalThis as { localStorage?: unknown }).localStorage = originalLs;
  });

  it('(a) loading slot A keeps a sample still on a pad: backend bytes survive + pad re-resolves', async () => {
    // Load a user sample X onto pad 0, then save slot 'A' (which now references X). X is still on
    // the live pad. Loading slot 'A' goes applyPreset -> resetAll(...) -> restoreFullState; without
    // the gate, resetAll's outgoing-orphan free would delete(X) before the reload re-resolves it.
    await engineBridge.loadPadSample(0, wavFile('XBYTES', 'x.wav'));
    const idX = engineBridge.getPadState(0).sampleId!;
    expect(idX).toBeTruthy();
    expect(await backend.get(idX)).not.toBeNull();

    engineBridge.saveSlot('A');
    // Slot A references X, and X is still on the live pad. Load A.
    await engineBridge.loadSlot('A');

    // The bytes survived in the backend AND the restored pad still names X.
    expect(await backend.get(idX)).not.toBeNull();
    expect(engineBridge.getPadState(0).sampleId).toBe(idX);
  });

  it('(b) a sample referenced ONLY by another saved slot B is freed by neither INIT nor loading slot A', async () => {
    // Pad 0 holds Z; save slot 'B' (references Z). Then clear the pad off Z (replace with W) and
    // save slot 'A' (references W, NOT Z). Now Z lives ONLY inside slot B's saved state.
    await engineBridge.loadPadSample(0, wavFile('ZBYTES', 'z.wav'));
    const idZ = engineBridge.getPadState(0).sampleId!;
    engineBridge.saveSlot('B');

    // Replace Z with W on the same (only) pad. Z is now off every live pad. The replace delete is
    // itself gated: slot B references Z, so the replace must NOT free Z either.
    await engineBridge.loadPadSample(0, wavFile('WBYTES', 'w.wav'));
    const idW = engineBridge.getPadState(0).sampleId!;
    expect(idW).not.toBe(idZ);
    engineBridge.saveSlot('A'); // A references W only
    expect(await backend.get(idZ)).not.toBeNull(); // replace did not strand slot B's sample

    // INIT clears the live pads. Z is referenced only by slot B -> must survive.
    engineBridge.resetAll();
    expect(await backend.get(idZ)).not.toBeNull();

    // Loading slot A (references W, not Z) must also leave Z alone (slot B still names it).
    await engineBridge.loadSlot('A');
    expect(await backend.get(idZ)).not.toBeNull();
  });

  it('(c) replacing the only pad referencing X, with NO slot referencing X, DOES free X (growth control)', async () => {
    // No slots saved. Pad 0 holds X (the only reference anywhere). Replacing it with Y must free X.
    await engineBridge.loadPadSample(0, wavFile('XBYTES', 'x.wav'));
    const idX = engineBridge.getPadState(0).sampleId!;
    expect(await backend.get(idX)).not.toBeNull();

    await engineBridge.loadPadSample(0, wavFile('YBYTES', 'y.wav'));
    const idY = engineBridge.getPadState(0).sampleId!;
    expect(idY).not.toBe(idX);
    expect(await backend.get(idY)).not.toBeNull(); // the new sample is present
    expect(await backend.get(idX)).toBeNull(); // X was truly unreferenced -> freed
    expect(engineBridge.listSlots()).toEqual([]); // sanity: no slot kept X alive
  });

  it('(d) assignFactoryToPad over a pad holding an UNREFERENCED user sample frees that sample', async () => {
    // Pad 0 holds X (the only reference anywhere). Assigning a FACTORY sound over it must free X —
    // the picker is the ONLY write path and runs the SAME reference-gated free as loadPadSample.
    await engineBridge.loadPadSample(0, wavFile('XBYTES', 'x.wav'));
    const idX = engineBridge.getPadState(0).sampleId!;
    expect(await backend.get(idX)).not.toBeNull();

    engineBridge.assignFactoryToPad(0, 'factory-kick');
    expect(engineBridge.getPadState(0).sampleId).toBe('factory-kick'); // pad now names the factory id
    expect(await backend.get(idX)).toBeNull(); // X was truly unreferenced -> freed
  });

  it('(e) assignFactoryToPad does NOT free a user sample a saved slot still references', async () => {
    // Pad 0 holds X; save a slot that references X. Assigning a FACTORY sound over pad 0 clears
    // X off every live pad, but the slot still names it -> the reference gate must keep the bytes.
    await engineBridge.loadPadSample(0, wavFile('XBYTES', 'x.wav'));
    const idX = engineBridge.getPadState(0).sampleId!;
    engineBridge.saveSlot('keepsX'); // slot now references X
    expect(await backend.get(idX)).not.toBeNull();

    engineBridge.assignFactoryToPad(0, 'factory-tom'); // X off the live pad, but the slot holds it
    expect(engineBridge.getPadState(0).sampleId).toBe('factory-tom');
    expect(await backend.get(idX)).not.toBeNull(); // slot 'keepsX' still references X -> kept
  });

  it('(f) assignFactoryToPad over a pad already holding a FACTORY id frees nothing', async () => {
    // A factory prevId is never freeable (the gate excludes 'factory-' ids). Re-pointing pad 0
    // (kit-default factory-kick) at another factory sound must touch no user bytes.
    expect(engineBridge.getPadState(0).sampleId).toBe('factory-kick'); // kit pre-load (g2)
    engineBridge.assignFactoryToPad(0, 'factory-snare'); // factory -> factory
    expect(engineBridge.getPadState(0).sampleId).toBe('factory-snare');
    // nothing to assert on the backend (no user bytes existed); the gate's factory-id exclusion
    // is what guarantees no spurious delete — this case simply must not throw.
  });
});
