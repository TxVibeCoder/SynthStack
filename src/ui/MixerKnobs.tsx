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
import { engineBridge } from './engineBridge';

const W = REGIONS.mixerKnobs.w;
const H = REGIONS.mixerKnobs.h;
/** Knob row center. */
const KNOB_Y = 64;

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
    def: { id: 'MIX_CH4_LEVEL', panelLabel: 'AUX', type: 'knob', min: 0, max: 1, default: 0 },
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
const MASTER_X = 424;

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

const MasterKnob = memo(function MasterKnob() {
  const getSnapshot = useCallback(() => engineBridge.store.getState().mixer.masterVolume, []);
  const value = useSyncExternalStore(subscribeStore, getSnapshot);
  const onLevel = useCallback((v: number) => engineBridge.setMasterVolume(v), []);
  return (
    <Knob
      def={MASTER_DEF}
      value={value}
      onInput={onLevel}
      onCommit={onLevel}
      size="l"
      x={MASTER_X}
      y={KNOB_Y}
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

      {CHANNEL_SPECS.map((spec) => (
        <ChannelKnob key={spec.def.id} channel={spec.channel} def={spec.def} x={spec.x} />
      ))}

      {/* channel/master divider */}
      <line x1={344} x2={344} y1={28} y2={104} stroke={COLORS.panelEdge} strokeWidth={1} />

      <MasterKnob />

      <DebugFooter />
    </svg>
  );
});
