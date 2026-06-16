/**
 * Preset (de)serialize + the never-throwing load-safety net (feature: presets + save/load).
 *
 * PURE module — no Web Audio, no DOM, no wall-clock. Node-testable in the quantGrid /
 * recordHelpers style. Restore must NEVER throw on partial / older / garbage input, so the
 * one public entry point — coalesceStudioState — funnels EVERY load path (loadFactoryPreset /
 * loadSlot / importSetup) through a defensive rebuild against defaultStudioState().
 *
 * Base64 (de)code lives in g2's sampleStore.ts, NOT here; this module imports only the
 * SampleBlob TYPE (type-only — zero runtime coupling, no import cycle: sampleStore imports
 * nothing from here). The bridge (g3) gathers/decodes bytes and passes them through.
 */

import {
  coalesceKeyboardState,
  coalesceSamplerState,
  defaultMonarchStep,
  defaultStudioState,
  type CableState,
  type MonarchStepState,
  type StudioState,
} from './studioState';
import type { ModuleDef } from '../../data/schema';
import monarchDef from '../../data/monarch.json';
import anvilDef from '../../data/anvil.json';
import cascadeDef from '../../data/cascade.json';
import type { SampleBlob } from '../engine/sampleStore';

/** The three control-bearing module defs, in the EXACT order resetAll seeds them
 *  (engineBridge.ts:963). The completeness test pins coalesce's seed set == resetAll's. */
const MODULE_DEFS: ModuleDef[] = [monarchDef, anvilDef, cascadeDef] as unknown as ModuleDef[];

/** moduleId -> controlId -> ControlDef, built once from the JSONs (for the knob min/max clamp). */
const CONTROL_INDEX: Record<string, Record<string, ModuleDef['controls'][number]>> = (() => {
  const index: Record<string, Record<string, ModuleDef['controls'][number]>> = {};
  for (const def of MODULE_DEFS) {
    const byId: Record<string, ModuleDef['controls'][number]> = {};
    for (const c of def.controls) byId[c.id] = c;
    index[def.id] = byId;
  }
  return index;
})();

/** The module ids whose controls coalesce overlays (applyState skips 'sampler' — studio.ts:701). */
const CONTROL_MODULE_IDS = ['monarch', 'anvil', 'cascade'] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function clampNumber(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

const RATCHETS: ReadonlyArray<MonarchStepState['ratchet']> = [1, 2, 3, 4];

/**
 * THE load-safety net. Normalizes any value (null / garbage / partial / older tree) to a
 * complete, valid, JSON-safe StudioState. NEVER throws; never shares refs with `raw`.
 *
 * Mirrors resetAll's INIT stance: version forced to 1, power forced false (the bridge
 * overwrites it from live _powered), module-JSON control defaults SEEDED first (replicating
 * resetAll's loop EXACTLY), then incoming numeric knob values clamped to the JSON min/max and
 * non-number knob overlays DROPPED. Every transport/sampler running flag is forced FALSE so a
 * restored preset never spontaneously sounds.
 */
export function coalesceStudioState(raw: unknown): StudioState {
  const base = defaultStudioState();

  // 5a. Seed module-JSON control defaults FIRST — replicates resetAll (engineBridge.ts:963-968).
  for (const def of MODULE_DEFS) {
    const mod = (base.controls[def.id] ??= {});
    for (const c of def.controls) {
      if (c.default !== undefined) mod[c.id] = c.default as number | string;
    }
  }

  if (!isObject(raw)) return base;

  // 5b. Overlay incoming controls (number|string only), clamping numeric knobs to JSON min/max.
  if (isObject(raw.controls)) {
    for (const moduleId of CONTROL_MODULE_IDS) {
      const incoming = (raw.controls as Record<string, unknown>)[moduleId];
      if (!isObject(incoming)) continue;
      const mod = (base.controls[moduleId] ??= {});
      const defs = CONTROL_INDEX[moduleId] ?? {};
      for (const controlId of Object.keys(incoming)) {
        const value = incoming[controlId];
        const def = defs[controlId];
        const isKnob = def?.type === 'knob' || def?.type === 'stepKnob';
        if (typeof value === 'number') {
          if (!Number.isFinite(value)) continue; // drop NaN/Infinity
          if (isKnob && typeof def?.min === 'number' && typeof def?.max === 'number') {
            mod[controlId] = clampNumber(value, def.min, def.max);
          } else {
            mod[controlId] = value;
          }
        } else if (typeof value === 'string') {
          // A non-number for a knob id is DROPPED (guards a corrupt 'x' for a knob).
          if (isKnob) continue;
          mod[controlId] = value;
        }
        // any other type (boolean/object/null) is dropped
      }
    }
  }

  // 6. cables — keep only string from/to; id/color default to '' / fallback color.
  if (Array.isArray(raw.cables)) {
    const cables: CableState[] = [];
    for (const entry of raw.cables) {
      if (!isObject(entry)) continue;
      const from = entry.from;
      const to = entry.to;
      if (typeof from !== 'string' || typeof to !== 'string') continue;
      cables.push({
        id: typeof entry.id === 'string' ? entry.id : '',
        from,
        to,
        color: typeof entry.color === 'string' ? entry.color : '#888888',
      });
    }
    base.cables = cables;
  }

  // 7. transport — rebuild strictly against base.transport (32 monarch steps, 8 anvil steps).
  const transport = isObject(raw.transport) ? raw.transport : {};
  const monarchRaw = isObject(transport.monarch) ? transport.monarch : {};
  const monarchSteps = Array.isArray(monarchRaw.steps) ? monarchRaw.steps : [];
  base.transport.monarch.steps = Array.from({ length: 32 }, (_, i) => {
    const s = monarchSteps[i];
    const d = defaultMonarchStep();
    if (!isObject(s)) return d;
    const noteVv = typeof s.noteVv === 'number' && Number.isFinite(s.noteVv) ? s.noteVv : d.noteVv;
    const gateLength =
      typeof s.gateLength === 'number' && Number.isFinite(s.gateLength)
        ? clampNumber(s.gateLength, 0.05, 1)
        : d.gateLength;
    const ratchet = RATCHETS.includes(s.ratchet as MonarchStepState['ratchet'])
      ? (s.ratchet as MonarchStepState['ratchet'])
      : 1;
    return {
      noteVv,
      gateLength,
      accent: typeof s.accent === 'boolean' ? s.accent : d.accent,
      rest: typeof s.rest === 'boolean' ? s.rest : d.rest,
      glide: typeof s.glide === 'boolean' ? s.glide : d.glide,
      ratchet,
    };
  });
  base.transport.monarch.endStep =
    typeof monarchRaw.endStep === 'number' && Number.isFinite(monarchRaw.endStep)
      ? Math.round(clampNumber(monarchRaw.endStep, 1, 32))
      : 16;
  base.transport.monarch.swingPct =
    typeof monarchRaw.swingPct === 'number' && Number.isFinite(monarchRaw.swingPct)
      ? clampNumber(monarchRaw.swingPct, 0, 100)
      : 50;
  base.transport.monarch.running = false;

  const anvilRaw = isObject(transport.anvil) ? transport.anvil : {};
  const anvilSteps = Array.isArray(anvilRaw.steps) ? anvilRaw.steps : [];
  base.transport.anvil.steps = Array.from({ length: 8 }, (_, i) => {
    const s = anvilSteps[i];
    if (!isObject(s)) return { pitchVv: 0, velocityVv: 4 };
    const pitchVv =
      typeof s.pitchVv === 'number' && Number.isFinite(s.pitchVv) ? clampNumber(s.pitchVv, -5, 5) : 0;
    const velocityVv =
      typeof s.velocityVv === 'number' && Number.isFinite(s.velocityVv)
        ? clampNumber(s.velocityVv, 0, 5)
        : 4;
    return { pitchVv, velocityVv };
  });
  base.transport.anvil.running = false;

  base.transport.cascade.playing = false;

  // 8. mixer — exactly 4 channel levels clamp 0..1; master 0..1; tempoLink boolean.
  const mixerRaw = isObject(raw.mixer) ? raw.mixer : {};
  const levelsRaw = Array.isArray(mixerRaw.channelLevels) ? mixerRaw.channelLevels : [];
  const levels = Array.from({ length: 4 }, (_, i) => {
    const v = levelsRaw[i];
    return typeof v === 'number' && Number.isFinite(v) ? clampNumber(v, 0, 1) : 0.8;
  });
  base.mixer.channelLevels = [levels[0]!, levels[1]!, levels[2]!, levels[3]!];
  base.mixer.masterVolume =
    typeof mixerRaw.masterVolume === 'number' && Number.isFinite(mixerRaw.masterVolume)
      ? clampNumber(mixerRaw.masterVolume, 0, 1)
      : 0.8;
  base.mixer.tempoLink = mixerRaw.tempoLink === true;

  // 9/10. sampler + keyboard — delegate to the existing strict coalesce helpers (force flags false).
  base.sampler = coalesceSamplerState(
    isObject(raw.sampler) ? (raw.sampler as Parameters<typeof coalesceSamplerState>[0]) : undefined,
  );
  base.sampler.seqRunning = false; // a restored preset never spontaneously runs the drum grid
  base.keyboard = coalesceKeyboardState(
    isObject(raw.keyboard) ? (raw.keyboard as Parameters<typeof coalesceKeyboardState>[0]) : undefined,
  );

  base.version = 1;
  base.power = false;
  return base;
}

// ---------------------------------------------------------------------------
// B. Portable bundle envelope (the .json export shape).
// ---------------------------------------------------------------------------

/** The magic string parseBundle checks to reject foreign JSON (a slot file / random JSON). */
export const PRESET_BUNDLE_KIND = 'synthstack-preset';

export interface PresetBundle {
  kind: 'synthstack-preset';
  version: 1;
  state: StudioState;
  /** g2's portable per-sample record ({ id, name, mime, bytesBase64 }). */
  samples: SampleBlob[];
}

/** Pure assembler. The bridge gathers `sampleEntries` via g2.exportSamples and passes them in;
 *  g1 NEVER touches bytes or base64. */
export function buildBundle(state: StudioState, sampleEntries: SampleBlob[]): PresetBundle {
  return { kind: PRESET_BUNDLE_KIND, version: 1, state, samples: sampleEntries };
}

/** Distinct, non-null, NON-factory pad sampleIds. The bridge feeds these to g2.exportSamples.
 *  The predicate `id && !id.startsWith('factory-')` MUST agree with g2.exportSamples + the
 *  bridge's orphan capture. Uses coalesce so a partial sampler slice can't throw. */
export function collectUserSampleIds(state: StudioState): string[] {
  const pads = coalesceSamplerState(state.sampler).pads;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const p of pads) {
    const id = p.sampleId;
    if (id && !id.startsWith('factory-') && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/** Parse + validate a portable bundle. Returns null on bad JSON or foreign / wrong-kind JSON.
 *  The bridge decodes each surviving blob via g2.importSamples BEFORE setState + reloadPadBuffers. */
export function parseBundle(text: string): { state: StudioState; samples: SampleBlob[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObject(parsed) || parsed.kind !== PRESET_BUNDLE_KIND) return null;
  const samples = Array.isArray(parsed.samples)
    ? (parsed.samples.filter(
        (e): e is SampleBlob =>
          isObject(e) &&
          typeof e.id === 'string' &&
          typeof e.name === 'string' &&
          typeof e.mime === 'string' &&
          typeof e.bytesBase64 === 'string',
      ) as SampleBlob[])
    : [];
  return { state: coalesceStudioState(parsed.state), samples };
}

// ---------------------------------------------------------------------------
// C. Slot codec (localStorage; the bridge does the actual I/O).
// ---------------------------------------------------------------------------

/** localStorage namespace for saved user slots — every per-slot wrapper key is SLOT_PREFIX+name
 *  (colon-suffixed). The bridge's slot-name index lives OUTSIDE this namespace
 *  ('synthstack-preset-index', hyphen — no colon) so no slot name can collide with it. */
export const SLOT_PREFIX = 'synthstack-preset:';

export function slotStorageKey(name: string): string {
  return SLOT_PREFIX + name;
}

/** Slots carry ONLY a StudioState — user sample bytes stay in IndexedDB locally, NOT bundled. */
export function serializeSlot(state: StudioState): string {
  return JSON.stringify(state);
}

/** Parse a slot's StudioState JSON through the coalesce safety net. Returns the default tree on
 *  bad JSON; NEVER throws. */
export function parseSlot(text: string): StudioState {
  try {
    return coalesceStudioState(JSON.parse(text));
  } catch {
    return coalesceStudioState(null);
  }
}

// ---------------------------------------------------------------------------
// D. Download filename (timestamp INJECTED — the bridge makes the one wall-clock read).
// ---------------------------------------------------------------------------

/** `synthstack-${slug}-${timestamp}.json`. slug = name lowercased, spaces->'-', strip
 *  non [a-z0-9-], collapse repeat '-', trim leading/trailing '-', fallback 'preset' if empty. */
export function buildPresetFilename(name: string, timestamp: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '') || 'preset';
  return `synthstack-${slug}-${timestamp}.json`;
}
