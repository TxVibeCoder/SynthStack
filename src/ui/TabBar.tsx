/**
 * TabBar — out-of-stage chrome that selects which module tab the stage shows.
 * Rendered as a SIBLING above `.stage-viewport` (App.tsx), screen-pixel sized — NOT
 * inside the transform:scale console — so it never inherits the stage scale and never
 * touches the stage16x9 geometry.
 *
 * Tabs are an EXPLICIT UI list (src/ui/tabs.ts UI_TABS), NOT registry-derived. The bar
 * shows STUDIO · PATCHBAY · SAMPLER. 'patchbay' is a UI-only tab with no MODULES entry,
 * so a registry-derived list cannot produce it — hence the explicit list. The 3 voices
 * (Monarch/Anvil/Cascade) share the single 'studio' tab — splitting them would unmount
 * voice jacks and delete cross-machine cables; the jack field + sampler jacks co-mount
 * on 'patchbay' where cross-machine patching happens.
 *
 * Accessibility: a WAI-ARIA tablist. Each tab is role="tab" with aria-selected; the
 * active tab is the only one in the focus order (roving tabindex), and ArrowLeft/Right
 * (+ Home/End) move selection, matching the APG tabs pattern. The bar does NOT render
 * the tab panels themselves — App mounts the per-tab Regions — so there is no
 * aria-controls target to point at here; the panels live in the scaled stage and are
 * gated by App on the same `tab` state.
 */

import { memo, useCallback, useMemo, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { modulesForTab, type ModuleTabId } from '../engine/modules/moduleConfig';
import { UI_TABS } from './tabs';

/** Human label for a tab. 'studio' is a tab-level title (3 voices, no single module);
 *  every other tab labels itself with its single module's displayName from the registry
 *  (e.g. 'sampler' -> 'SAMPLER'). Never hard-code names — read them from the registry. */
function tabLabel(tabId: ModuleTabId): string {
  if (tabId === 'studio') return 'STUDIO';
  // patchbay is a UI-only tab (no module) — guard BEFORE modulesForTab, which would
  // return [] and join to an empty label.
  if (tabId === 'patchbay') return 'PATCHBAY';
  const mods = modulesForTab(tabId);
  // single-module tabs use the module's displayName; multi-module tabs join them.
  return mods.length === 1
    ? mods[0]!.displayName.toUpperCase()
    : mods.map((m) => m.displayName).join(' / ').toUpperCase();
}

export const TabBar = memo(function TabBar({
  tab,
  onTab,
}: {
  tab: ModuleTabId;
  onTab: (tab: ModuleTabId) => void;
}) {
  const ids = useMemo(() => UI_TABS, []);
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLButtonElement>) => {
      const i = ids.indexOf(tab);
      let next = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % ids.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + ids.length) % ids.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = ids.length - 1;
      else return;
      e.preventDefault();
      const nextId = ids[next]!;
      onTab(nextId);
      // follow focus to the newly-selected tab (APG: selection follows focus).
      btnRefs.current[next]?.focus();
    },
    [ids, tab, onTab],
  );

  return (
    <div className="tab-bar" role="tablist" aria-label="Module tabs">
      {ids.map((id, i) => {
        const selected = id === tab;
        return (
          <button
            key={id}
            ref={(el) => {
              btnRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${id}`}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            data-testid={`tab-${id}`}
            className={selected ? 'tab-bar__tab tab-bar__tab--active' : 'tab-bar__tab'}
            onClick={() => onTab(id)}
            onKeyDown={onKeyDown}
          >
            {tabLabel(id)}
          </button>
        );
      })}
    </div>
  );
});
