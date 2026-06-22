/**
 * Mixer knob block — 16:9 layout: the mixer SPLIT in
 * two. This panel (stage region mixerKnobs, 496.96 × 134.8, centered
 * between the Cascade column and the seq strip) holds the four channel level
 * knobs + MASTER in one row. The transports / TEMPO LINK / INIT / POWER moved
 * to the utility strip (UtilityStrip.tsx, top-right).
 *
 * Data flow (CONVENTIONS.md): level/master knobs call
 * bridge.setMixerLevel / setMasterVolume on BOTH onInput and onCommit — the
 * bridge writes the engine immediately and debounces the store mirror itself,
 * so drags never re-render anything but the dragged knob. Each knob subscribes
 * to its own primitive store snapshot (Object.is bailout).
 *
 * The baseLatency debug readout stays here: click the footer line to
 * toggle it (same low-contrast treatment as before).
 */

import { memo, useCallback, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ControlDef } from '../../data/schema';
import { COLORS, FONT_CONDENSED } from './theme';
import { REGIONS } from './stage16x9';
import { Knob } from './controls/Knob';
import type { KnobSize } from './types';
import { engineBridge } from './engineBridge';

const W = REGIONS.mixerKnobs.w;
const H = REGIONS.mixerKnobs.h;
/** Knob row center. */
const KNOB_Y = 64;
/** MASTER knob x in the mixer-panel layout (right of the channel/master divider). */
const MASTER_X_DEFAULT = 424;

type MixChannel = 0 | 1 | 2 | 3;

// ---- synthesized ControlDefs (the mixer has no data/*.json module) ---------------------
// min/max/default mirror state/studioState.ts defaultStudioState().mixer so
// double-click reset lands on the store default.

const CHANNEL_SPECS: ReadonlyArray<{ channel: MixChannel; def: ControlDef; x: number }> = [
  {
    channel: 0,
    x: 48,
    def: { id: 'MIX_CH1_LEVEL', panelLabel: 'Cascade', type: 'knob', min: 0, max: 1, default: 0.8 },
  },
  {
    channel: 1,
    x: 128,
    def: { id: 'MIX_CH2_LEVEL', panelLabel: 'Anvil', type: 'knob', min: 0, max: 1, default: 0.8 },
  },
  {
    channel: 2,
    x: 208,
    def: { id: 'MIX_CH3_LEVEL', panelLabel: 'Monarch', type: 'knob', min: 0, max: 1, default: 0.8 },
  },
  {
    channel: 3,
    x: 288,
    def: { id: 'MIX_CH4_LEVEL', panelLabel: 'Sampler', type: 'knob', min: 0, max: 1, default: 0 },
  },
];

const MASTER_DEF: ControlDef = {
  id: 'MIX_MASTER',
  panelLabel: 'MASTER',
  type: 'knob',
  min: 0,
  max: 1,
  default: 0.8,
};

// ---- store plumbing ---------------------------------------------------------------------

/** Module-level stable subscribe — safe to hand to useSyncExternalStore directly. */
function subscribeStore(onChange: () => void): () => void {
  return engineBridge.store.subscribe(onChange);
}

/**
 * baseLatency debug readout. The bridge deliberately exposes no Studio handle, so
 * reach through the private `studioInstance` field at runtime (TS privacy is
 * compile-time only) instead of widening the bridge surface. Null until the
 * studio exists / is powered.
 */
function readBaseLatencySec(): number | null {
  const studio = (
    engineBridge as unknown as {
      studioInstance?: { context?: { baseLatency?: number } } | null;
    }
  ).studioInstance;
  const v = studio?.context?.baseLatency;
  return typeof v === 'number' && v > 0 ? v : null;
}

// ---- per-control subcomponents (each memoized; each re-renders alone) -------------------

/** Channel level: store snapshot is the one primitive level; both knob callbacks
 *  hit bridge.setMixerLevel (immediate engine write, debounced store mirror). */
const ChannelKnob = memo(function ChannelKnob({
  channel,
  def,
  x,
}: {
  channel: MixChannel;
  def: ControlDef;
  x: number;
}) {
  const getSnapshot = useCallback(
    () => engineBridge.store.getState().mixer.channelLevels[channel],
    [channel],
  );
  const value = useSyncExternalStore(subscribeStore, getSnapshot);
  const onLevel = useCallback((v: number) => engineBridge.setMixerLevel(channel, v), [channel]);
  return <Knob def={def} value={value} onInput={onLevel} onCommit={onLevel} x={x} y={KNOB_Y} />;
});

/**
 * The four mixer CHANNEL faders (Cascade / Anvil / Monarch / Sampler) as a standalone row,
 * exported so the MasterRibbon can render them as chrome (out-of-stage) without dragging
 * in the whole MixerKnobs panel. Same store wiring as the in-panel knobs — each ChannelKnob
 * self-subscribes to its own mixer.channelLevels[ch] snapshot and writes via
 * engineBridge.setMixerLevel — so MIX_CH{1..4}_LEVEL appear EXACTLY ONCE in the DOM (App no
 * longer mounts the in-stage MixerKnobs Region).
 *
 * The group root carries data-testid="tier-mixer" (relocated from the old in-stage mixer
 * Region) so the existing mixer e2e still finds the fader cluster on the ribbon.
 *
 * x/y position the WHOLE row's origin in the parent <svg>'s units; the 4 knobs are then laid
 * out at x + CHANNEL_SPECS[i].x relative to that origin (default x/y reproduce the in-panel
 * positions). Like every Knob this renders SVG <g>s and MUST be mounted inside an <svg>.
 */
export const ChannelFaders = memo(function ChannelFaders({
  x = 0,
  y = 0,
}: {
  x?: number;
  y?: number;
} = {}) {
  return (
    <g data-testid="tier-mixer" transform={`translate(${x} ${y})`}>
      {CHANNEL_SPECS.map((spec) => (
        <ChannelKnob key={spec.def.id} channel={spec.channel} def={spec.def} x={spec.x} />
      ))}
    </g>
  );
});

/**
 * MASTER volume knob — self-contained: subscribes to its own
 * `mixer.masterVolume` store snapshot and writes via `engineBridge.setMasterVolume`
 * on both onInput and onCommit (zero engine change; identical wiring wherever it
 * mounts). Exported so the master ribbon can render it as a leaf without dragging in
 * the whole mixer panel. Position/size default to the in-panel mixer coordinates
 * (size "l", x 424, y KNOB_Y) so MixerKnobs renders pixel-identically; the ribbon
 * passes its own x/y/size. Like every Knob, it renders an SVG <g> positioned by
 * translate(x y) and MUST be mounted inside an <svg>.
 */
export const MasterKnob = memo(function MasterKnob({
  x = MASTER_X_DEFAULT,
  y = KNOB_Y,
  size = 'l',
}: {
  x?: number;
  y?: number;
  size?: KnobSize;
} = {}) {
  const getSnapshot = useCallback(() => engineBridge.store.getState().mixer.masterVolume, []);
  const value = useSyncExternalStore(subscribeStore, getSnapshot);
  const onLevel = useCallback((v: number) => engineBridge.setMasterVolume(v), []);
  return (
    <Knob
      def={MASTER_DEF}
      value={value}
      onInput={onLevel}
      onCommit={onLevel}
      size={size}
      x={x}
      y={y}
    />
  );
});

/** Footer — clicking it reveals the tiny low-contrast baseLatency readout. */
const DebugFooter = memo(function DebugFooter() {
  const [show, setShow] = useState(false);
  const toggle = useCallback(() => setShow((s) => !s), []);
  const onKeyDown = useCallback((e: ReactKeyboardEvent<SVGGElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    setShow((s) => !s);
  }, []);
  const sec = show ? readBaseLatencySec() : null;
  return (
    <g
      className="control"
      role="button"
      tabIndex={0}
      aria-label="Toggle audio latency readout"
      aria-pressed={show}
      onClick={toggle}
      onKeyDown={onKeyDown}
    >
      {/* invisible-but-painted hit band */}
      <rect x={6} y={112} width={W - 12} height={18} rx={4} fill="transparent" />
      <text
        x={10}
        y={125}
        fontFamily={FONT_CONDENSED}
        fontSize={9}
        letterSpacing={1.5}
        fill={COLORS.legendDim}
        opacity={0.6}
      >
        STUDIO OUT
      </text>
      {show && (
        <text
          x={W - 10}
          y={125}
          textAnchor="end"
          fontFamily={FONT_CONDENSED}
          fontSize={8}
          letterSpacing={1}
          fill={COLORS.legendDim}
          opacity={0.45}
        >
          {`BASE LATENCY ${sec != null ? `${(sec * 1000).toFixed(1)} ms` : '—'}`}
        </text>
      )}
    </g>
  );
});

// ---- panel -------------------------------------------------------------------------------

export const MixerKnobs = memo(function MixerKnobs() {
  return (
    <svg
      className="panel"
      viewBox={`0 0 ${W} ${H}`}
      xmlns="http://www.w3.org/2000/svg"
      role="group"
      aria-label="Mixer levels"
    >
      {/* raised strip face */}
      <rect
        x={0.5}
        y={0.5}
        width={W - 1}
        height={H - 1}
        rx={10}
        fill={COLORS.panelRaised}
        stroke={COLORS.panelEdge}
        strokeWidth={1.5}
      />

      {/* plain-text functional title (no trade dress) */}
      <text
        x={12}
        y={18}
        fontFamily={FONT_CONDENSED}
        fontSize={14}
        letterSpacing={2.5}
        fill={COLORS.legend}
      >
        MIXER
      </text>

      {/* The 4 channel faders are the shared ChannelFaders row (also rendered by the
       * MasterRibbon). NOTE: App no longer mounts this MixerKnobs panel — the faders live
       * on the ribbon now (Wave-1 tab restructure) — so this in-panel copy is kept only
       * for parity/future use and is NOT in the live DOM; the ribbon's ChannelFaders is the
       * single mounted instance (one tier-mixer / MIX_CH*_LEVEL each). */}
      <ChannelFaders />

      {/* MASTER now lives in the MasterRibbon (out-of-stage chrome) — the ribbon owns
       * the single MasterKnob instance so MIX_MASTER appears exactly once in the DOM.
       * The in-panel divider + <MasterKnob /> that used to sit here were removed when
       * g-ui-app relocated MASTER to the ribbon (Wave 1). The MasterKnob export at the
       * top of this file is what the ribbon renders; the mixer panel keeps only the 4
       * channel faders. */}

      <DebugFooter />
    </svg>
  );
});
