/**
 * moduleConfig.ts — THE module registry: one ordered, single-source-of-truth list
 * describing every module the studio builds. This replaces four hard-coded module
 * lists that previously had to be kept in lockstep by hand:
 *
 *   1. studio.ts:100         — the `defs` array + the four `new *Module(...)` + mixer taps
 *   2. state/presets.ts:31   — `MODULE_DEFS` (the control-bearing defs coalesce seeds)
 *   3. engineBridge.ts:783   — the `jackIndex` def list (cable validation)
 *   4. engineBridge.ts:1111  — `resetAll`'s control-default seed loop
 *
 * Each list site derives from MODULES instead (see the per-field docs below). The
 * entries here pin the EXACT current wiring; nothing about runtime behavior changes.
 *
 * PURE-ish data module: imports the module classes + the data JSON only. No Web Audio
 * is touched at import time — `factory` is a lazy constructor the studio calls under a
 * live AudioContext at power-on.
 */

import type { ModuleDef } from '../../../data/schema';
import monarchDef from '../../../data/monarch.json';
import anvilDef from '../../../data/anvil.json';
import cascadeDef from '../../../data/cascade.json';
import samplerDef from '../../../data/sampler.json';
import { ModuleBase } from './moduleBase';
import { MonarchModule } from './monarch';
import { AnvilModule } from './anvil';
import { CascadeModule } from './cascade';
import { SamplerModule } from './sampler';

/** Which UI tab a module's panels live under. Each of the 3 voices now has its OWN tab
 *  ('cascade' / 'anvil' / 'monarch') — there is no longer a shared 'studio' tab; the
 *  sampler/drum machine lives on 'sampler'. (Voice jacks all still co-mount on the
 *  'patchbay' tab, so cross-machine cables stay whole despite the per-voice control tabs.)
 *
 *  'patchbay' is a UI-ONLY tab: NO module has tabId 'patchbay' and none ever should
 *  (modulesForTab('patchbay') therefore returns [] — harmless). It exists only as a
 *  destination in the UI tab set (src/ui/tabs.ts) where the jack field + sampler jacks
 *  co-mount for cross-machine patching; the engine/presets/studio.ts never reference it.
 *  The literal lives in this union so the UI's ModuleTabId-typed tab state can hold it. */
export type ModuleTabId = 'cascade' | 'anvil' | 'monarch' | 'patchbay' | 'sampler';

/**
 * Everything the build, persistence, validation and (future) teardown paths need to
 * know about one module — derived once here so the four call sites above stay in sync.
 */
export interface ModuleConfig {
  /** Stable module id (matches ModuleDef.id and the state.controls / state slice keys). */
  id: string;
  /** Human-readable name for the ribbon "active module" label (from the data JSON). */
  displayName: string;
  /** The authored module JSON (jacks/controls/internalSources). */
  def: ModuleDef;
  /** UI tab the module's panels mount under. */
  tabId: ModuleTabId;
  /** Lazy constructor — the studio calls this under a live AudioContext at power-on.
   *  Mirrors `new MonarchModule(ctx, def)` etc. (studio.ts:101-104). */
  factory: (ctx: BaseAudioContext, def: ModuleDef) => ModuleBase;
  /** The module's main output tap jack id, fed into the mixer (studio.ts:107-110).
   *  null = the module has no single summed output edge into the mixer. */
  mainOutJack: string | null;
  /** Mixer channel index `mixer.connectInput(outputTap(mainOutJack), ch)` taps into
   *  (studio.ts:107-110). null = not mixed (paired with mainOutJack === null). */
  mixerChannel: number | null;
  /** True when this module's JSON control defaults are SEEDED by coalesce/resetAll and
   *  its controls participate in applyState's `state.controls[id]` loop. The sampler is
   *  FALSE: its pad params live in `state.sampler` (NOT `state.controls`), and applyState
   *  / coalesce / resetAll all skip it (studio.ts:713; presets.ts:45; engineBridge.ts:1111). */
  ownsControlDefaults: boolean;
  /** True when the module contributes a transport/clock to the scheduler. All four
   *  current modules do (Monarch seq, Anvil seq, Cascade clock, Sampler loop+step). */
  hasTransport: boolean;
}

/**
 * THE registry — ordered exactly as studio.ts builds the modules (monarch, anvil,
 * cascade, sampler). Order is load-bearing for the `defs` array and the resetAll /
 * coalesce seed order (the completeness test pins it).
 */
export const MODULES: ModuleConfig[] = [
  {
    id: 'monarch',
    displayName: (monarchDef as unknown as ModuleDef).displayName, // 'Monarch'
    def: monarchDef as unknown as ModuleDef,
    tabId: 'monarch',
    factory: (ctx, def) => new MonarchModule(ctx, def),
    mainOutJack: 'MON_VCA_OUT',
    mixerChannel: 2, // mixer.connectInput(monarch.outputTap('MON_VCA_OUT'), 2)
    ownsControlDefaults: true,
    hasTransport: true,
  },
  {
    id: 'anvil',
    displayName: (anvilDef as unknown as ModuleDef).displayName, // 'Anvil'
    def: anvilDef as unknown as ModuleDef,
    tabId: 'anvil',
    factory: (ctx, def) => new AnvilModule(ctx, def),
    mainOutJack: 'ANV_VCA_OUT',
    mixerChannel: 1, // mixer.connectInput(anvil.outputTap('ANV_VCA_OUT'), 1)
    ownsControlDefaults: true,
    hasTransport: true,
  },
  {
    id: 'cascade',
    displayName: (cascadeDef as unknown as ModuleDef).displayName, // 'Cascade'
    def: cascadeDef as unknown as ModuleDef,
    tabId: 'cascade',
    factory: (ctx, def) => new CascadeModule(ctx, def),
    mainOutJack: 'CAS_VCA_OUT',
    mixerChannel: 0, // mixer.connectInput(cascade.outputTap('CAS_VCA_OUT'), 0)
    ownsControlDefaults: true,
    hasTransport: true,
  },
  {
    id: 'sampler',
    displayName: (samplerDef as unknown as ModuleDef).displayName, // 'SAMPLER'
    def: samplerDef as unknown as ModuleDef,
    tabId: 'sampler',
    factory: (ctx, def) => new SamplerModule(ctx, def),
    mainOutJack: 'SAMP_MIX_OUT',
    mixerChannel: 3, // mixer.connectInput(sampler.outputTap('SAMP_MIX_OUT'), 3)
    ownsControlDefaults: false, // pad params live in state.sampler, not state.controls
    hasTransport: true,
  },
];

/** Module ids in registry/build order: ['monarch','anvil','cascade','sampler']. */
export const MODULE_IDS: string[] = MODULES.map((m) => m.id);

/** The control-bearing modules whose JSON defaults coalesce/resetAll seed and whose
 *  controls applyState iterates — i.e. monarch/anvil/cascade (sampler excluded).
 *  presets.ts MODULE_DEFS === controlDefaultModules.map(m => m.def). */
export const controlDefaultModules: ModuleConfig[] = MODULES.filter((m) => m.ownsControlDefaults);

/** The module ids the mixer taps, in channel order (derives studio.ts:107-110). */
export const mixedModules: ModuleConfig[] = MODULES.filter(
  (m) => m.mainOutJack !== null && m.mixerChannel !== null,
);

/** Lookup a ModuleConfig by id (undefined if unknown). */
export function moduleConfig(id: string): ModuleConfig | undefined {
  return MODULES.find((m) => m.id === id);
}

/** Ribbon "active module" label source: the displayName for a module id, or '' if unknown. */
export function displayNameOf(id: string): string {
  return moduleConfig(id)?.displayName ?? '';
}

/** The module configs whose panels mount under a given tab (UI mount-gating helper).
 *  Each voice now owns its own tab, so modulesForTab('monarch') === [monarch],
 *  modulesForTab('anvil') === [anvil], modulesForTab('cascade') === [cascade], and
 *  modulesForTab('sampler') === [sampler]; modulesForTab('patchbay') === [] (UI-only).
 *  Used for the tab label + the ribbon active-name. */
export function modulesForTab(tabId: ModuleTabId): ModuleConfig[] {
  return MODULES.filter((m) => m.tabId === tabId);
}
