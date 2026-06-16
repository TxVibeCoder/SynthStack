/**
 * MasterRibbon — the dynamic master strip, rendered as out-of-stage chrome ABOVE
 * `.stage-viewport` (App.tsx), screen-pixel sized (NOT inside the transform:scale
 * console). It is the new home of everything that used to live in the in-stage
 * UtilityStrip + the in-panel MASTER knob, PLUS one new datum: the ACTIVE MODULE NAME
 * for the current tab (sourced from the module registry's displayName).
 *
 * Why a single ribbon: per REFACTOR_DESIGN §2 the master controls are global and must
 * read correctly on every tab. POWER (audio unlock), TEMPO LINK, RECORD, MASTER all
 * self-subscribe to the store, so they update on a tab switch with no new wiring. The
 * only tab-AWARE control is START/STOP ALL: on the 'sampler' tab it drives the drum grid
 * (engineBridge.drumRun/drumStop); on every other tab (the 3 voice tabs + patchbay) it
 * drives the three voice transports (engineBridge.runAll/stopAll). That branch lives
 * HERE, not in the leaf.
 *
 * testid contract: the ribbon root carries data-testid="utility-strip" (e2e still finds
 * the master cluster there). POWER keeps data-testid="power"; RECORD keeps
 * "record"/"record-elapsed"; INIT keeps "init"; PRESETS/SAVE keep "presets"/"save". The
 * ribbon also now hosts the four mixer CHANNEL FADERS (ChannelFaders, data-testid=
 * "tier-mixer", relocated from the in-stage mixer Region App no longer mounts) and the
 * MASTER knob. These leaves are now rendered ONLY here — App.tsx no longer renders the
 * in-stage UtilityStrip / mixer Regions and MixerKnobs is no longer mounted — so each
 * testid still appears EXACTLY ONCE in the DOM.
 *
 * Layout: one horizontal SVG row. The leaf components (PowerButton, RunStopAll,
 * TempoLinkButton, RecordButton, FullScreenButton, MasterKnob) render SVG <g>s
 * positioned by x/y in viewBox units, so the ribbon composes them inside its own
 * <svg> by passing explicit coordinates. The SVG scales to the screen-pixel chrome
 * height via CSS (width:100%, height:RIBBON_H) while preserving its aspect by slicing
 * width — see styles.css `.master-ribbon`.
 */

import { memo, useCallback } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { COLORS, FONT_CONDENSED } from './theme';
import { Button } from './controls/Button';
import type { ControlDef } from '../../data/schema';
import { engineBridge } from './engineBridge';
import {
  PowerButton,
  TempoLinkButton,
  RecordButton,
  FullScreenButton,
} from './UtilityStrip';
import { MasterKnob, ChannelFaders } from './MixerKnobs';
import { displayNameOf, modulesForTab, type ModuleTabId } from '../engine/modules/moduleConfig';

/** Ribbon viewBox: a single 1805.19-wide × 90-tall row (stage width so the chrome reads
 *  across the full console width; height is the ribbon's own logical height). The SVG is
 *  drawn at this aspect and CSS scales it to the screen-pixel RIBBON_H. */
export const RIBBON_VB_W = 1805.19;
export const RIBBON_VB_H = 90;

/** Vertical centers for the two visual rows of leaves inside the ribbon. Most caps are
 *  one row; the elements were authored with their own internal offsets, so we pick a
 *  single baseline that centers them in the 90-tall box. */
const ROW_Y = 18;

const RUN_ALL_DEF: ControlDef = { id: 'MIX_RUN_ALL', panelLabel: 'RUN ALL', type: 'button' };
const STOP_ALL_DEF: ControlDef = { id: 'MIX_STOP_ALL', panelLabel: 'STOP ALL', type: 'button' };

/**
 * Tab-aware START ALL / STOP ALL. On the 'sampler' tab the pair drives the drum grid
 * (drumRun/drumStop) per REFACTOR_DESIGN §2; on EVERY other tab (the 3 voice tabs +
 * patchbay) it drives the three voice transports (runAll/stopAll) — these are global
 * voice transports, so they read the same on each voice tab. Both caps are momentary
 * (fire on the down edge); the shared aria-label prefixes ("RUN ALL"/"STOP ALL") are
 * preserved so existing e2e `aria-label^="RUN ALL"` queries still match. */
const TabTransport = memo(function TabTransport({
  tab,
  runX,
  stopX,
  y,
}: {
  tab: ModuleTabId;
  runX: number;
  stopX: number;
  y: number;
}) {
  const onRun = useCallback(
    (pos: string) => {
      if (pos !== 'ON') return;
      if (tab === 'sampler') engineBridge.drumRun();
      else engineBridge.runAll(); // the 3 voice tabs + patchbay share the voices transport
    },
    [tab],
  );
  const onStop = useCallback(
    (pos: string) => {
      if (pos !== 'ON') return;
      if (tab === 'sampler') engineBridge.drumStop();
      else engineBridge.stopAll();
    },
    [tab],
  );
  return (
    <g>
      <Button def={RUN_ALL_DEF} value="OFF" onChange={onRun} momentary x={runX} y={y} />
      <Button def={STOP_ALL_DEF} value="OFF" onChange={onStop} momentary x={stopX} y={y} />
    </g>
  );
});

/** INIT — double-click resets the whole studio (engineBridge.resetAll). Relocated from
 *  the in-stage UtilityStrip; keeps data-testid="init". Double-click (not single) so a
 *  stray click can't wipe a patch. */
const InitCap = memo(function InitCap({ x, y }: { x: number; y: number }) {
  const onDoubleClick = useCallback(() => engineBridge.resetAll(), []);
  const onKeyDown = useCallback((e: ReactKeyboardEvent<SVGGElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    engineBridge.resetAll();
  }, []);
  return (
    <g
      className="control"
      role="button"
      tabIndex={0}
      aria-label="Reset entire studio to factory defaults (double-click)"
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      data-testid="init"
    >
      <title>Double-click: reset ALL knobs, cables and sequences to factory defaults</title>
      <rect
        x={x - 26}
        y={y - 12}
        width={52}
        height={24}
        rx={5}
        fill={COLORS.panelShadow}
        stroke={COLORS.ledRed}
        strokeWidth={1.2}
      />
      <text
        x={x}
        y={y + 4}
        textAnchor="middle"
        fontFamily={FONT_CONDENSED}
        fontSize={11}
        letterSpacing={2}
        fill={COLORS.ledRed}
      >
        INIT
      </text>
    </g>
  );
});

/** Momentary "open a flow" cap (PRESETS / SAVE) — opens the preset-picker overlay via
 *  onActivate (App owns the open-state). Same shape + testids as the relocated
 *  UtilityStrip FeatureCap so presets.spec.ts (which scopes them under utility-strip)
 *  keeps passing. */
function FeatureCap({
  x,
  y,
  label,
  hint,
  testId,
  onActivate,
}: {
  x: number;
  y: number;
  label: string;
  hint: string;
  testId: string;
  onActivate: () => void;
}) {
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<SVGGElement>) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      onActivate();
    },
    [onActivate],
  );
  return (
    <g
      className="control"
      role="button"
      tabIndex={0}
      aria-label={label}
      data-testid={testId}
      onClick={onActivate}
      onKeyDown={onKeyDown}
    >
      <title>{hint}</title>
      <rect
        x={x - 24}
        y={y - 11}
        width={48}
        height={22}
        rx={4}
        fill={COLORS.panelShadow}
        stroke={COLORS.panelEdge}
        strokeWidth={1.2}
      />
      <text
        x={x}
        y={y + 4}
        textAnchor="middle"
        fontFamily={FONT_CONDENSED}
        fontSize={10}
        letterSpacing={0.5}
        fill={COLORS.legend}
        pointerEvents="none"
        {...(label.length * 5.6 > 44
          ? { textLength: 44, lengthAdjust: 'spacingAndGlyphs' as const }
          : {})}
      >
        {label}
      </text>
    </g>
  );
}

/** The ACTIVE MODULE NAME for the current tab — the one new datum the ribbon needs,
 *  sourced from the registry. Each per-voice tab (cascade/anvil/monarch) and the sampler
 *  tab show their single module's displayNameOf(id); 'patchbay' is the UI-only tab. */
function activeTabName(tab: ModuleTabId): string {
  // patchbay is a UI-only tab (no module) — guard BEFORE modulesForTab (which is []).
  if (tab === 'patchbay') return 'PATCHBAY';
  const mods = modulesForTab(tab);
  return mods.length === 1 ? displayNameOf(mods[0]!.id) : mods.map((m) => m.displayName).join(' / ');
}

export const MasterRibbon = memo(function MasterRibbon({
  tab,
  powered,
  busy,
  onTogglePower,
  onOpenPicker,
}: {
  tab: ModuleTabId;
  powered: boolean;
  busy: boolean;
  onTogglePower: () => void;
  /** Open the preset-picker overlay (App owns the open-state). */
  onOpenPicker: (mode: 'browse' | 'save') => void;
}) {
  const onPresets = useCallback(() => onOpenPicker('browse'), [onOpenPicker]);
  const onSave = useCallback(() => onOpenPicker('save'), [onOpenPicker]);
  const name = activeTabName(tab);

  return (
    <div className="master-ribbon" data-testid="utility-strip">
      <svg
        className="master-ribbon__svg"
        viewBox={`0 0 ${RIBBON_VB_W} ${RIBBON_VB_H}`}
        preserveAspectRatio="xMidYMid meet"
        xmlns="http://www.w3.org/2000/svg"
        role="group"
        aria-label="Master ribbon — active module, power, transports, master"
      >
        {/* raised ribbon face (mixer family) */}
        <rect
          x={0.5}
          y={0.5}
          width={RIBBON_VB_W - 1}
          height={RIBBON_VB_H - 1}
          rx={10}
          fill={COLORS.panelRaised}
          stroke={COLORS.panelEdge}
          strokeWidth={1.5}
        />

        {/* ACTIVE MODULE NAME — far left. */}
        <text
          x={20}
          y={38}
          fontFamily={FONT_CONDENSED}
          fontSize={26}
          letterSpacing={3}
          fontWeight={600}
          fill={COLORS.legend}
          data-testid="ribbon-active-name"
        >
          {name.toUpperCase()}
        </text>
        <text
          x={20}
          y={62}
          fontFamily={FONT_CONDENSED}
          fontSize={11}
          letterSpacing={4}
          fill={COLORS.legendDim}
        >
          MASTER
        </text>

        {/* divider after the name block */}
        <line x1={300} x2={300} y1={14} y2={76} stroke={COLORS.panelEdge} strokeWidth={1} />

        {/* POWER — always mounted, never dimmed (the audio unlock). */}
        <PowerButton powered={powered} busy={busy} onToggle={onTogglePower} x={320} y={24} />

        {/* tab-aware START ALL / STOP ALL (studio -> runAll/stopAll, sampler -> drum). */}
        <TabTransport tab={tab} runX={470} stopX={552} y={ROW_Y} />

        {/* TEMPO LINK — self-subscribes; updates on tab switch for free. */}
        <TempoLinkButton x={650} y={ROW_Y} />

        {/* INIT — double-click factory reset. */}
        <InitCap x={744} y={32} />

        {/* divider before the features cluster */}
        <line x1={812} x2={812} y1={14} y2={76} stroke={COLORS.panelEdge} strokeWidth={1} />

        {/* PRESETS / SAVE — open the picker overlay. */}
        <FeatureCap
          x={864}
          y={32}
          label="PRESETS"
          hint="Browse factory presets + your saved setups (also import a shared .json)"
          testId="presets"
          onActivate={onPresets}
        />
        <FeatureCap
          x={924}
          y={32}
          label="SAVE"
          hint="Save the current setup to a slot, or export it as a shareable .json"
          testId="save"
          onActivate={onSave}
        />

        {/* RECORD — capture master output; keeps record/record-elapsed testids. */}
        <RecordButton x={1010} y={28} />

        {/* FULL SCREEN — target the full viewport. */}
        <FullScreenButton x={1100} y={28} />

        {/* MIXER CHANNEL FADERS — relocated from the in-stage mixer Region (which App no
         * longer mounts) onto the ribbon. The row carries data-testid="tier-mixer" so the
         * existing mixer e2e finds the faders here. Origin places the 4 knobs (Cascade /
         * Anvil / Monarch / AUX) left of the MASTER divider, dials at y≈42 with labels
         * below inside the 90-tall ribbon box. */}
        <ChannelFaders x={1300} y={-22} />

        {/* divider before MASTER */}
        <line x1={1640} x2={1640} y1={14} y2={76} stroke={COLORS.panelEdge} strokeWidth={1} />

        {/* MASTER volume knob — relocated from the mixer panel; self-wired. */}
        <MasterKnob x={1720} y={45} size="l" />
      </svg>
    </div>
  );
});
