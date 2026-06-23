/**
 * tabs.ts — the EXPLICIT UI tab set (single source of truth for which tabs the chrome
 * shows, in order). NOT derived from the module registry: 'patchbay' is a UI-only tab
 * with NO MODULES entry (no module has tabId 'patchbay'), so a registry-derived list
 * (tabIds()) physically cannot produce it. The order here is load-bearing — the 4 voice
 * tabs come first, then patchbay, then sampler, so the chrome reads
 * CASCADE · ANVIL · MONARCH · COURIER · PATCHBAY · SAMPLER.
 */

import type { ModuleTabId } from '../engine/modules/moduleConfig';

/** The UI tabs, in display order. The 4 per-voice tabs (cascade · anvil · monarch · courier) ·
 *  patchbay (UI-only jack field + sampler jacks) · sampler (sampler/drum controls) ·
 *  fx (UI-only master effects panel). The Patchbook GUIDE is NOT a tab — the ribbon's
 *  GUIDE link opens it in its own window (public/guide.html, see MasterRibbon.tsx). */
export const UI_TABS: ModuleTabId[] = [
  'cascade',
  'anvil',
  'monarch',
  'courier',
  'patchbay',
  'sampler',
  'fx',
];
