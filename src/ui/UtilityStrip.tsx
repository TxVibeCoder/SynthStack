/**
 * Utility strip — 16:9 layout: the mixer's
 * buttons + POWER in the top-right corner (588.63 × 102.78), two rows:
 *
 *   row 1 (live):     POWER · RUN ALL · STOP ALL · TEMPO LINK · INIT · MIDI LED
 *   row 2 (features): PRESETS · SAVE · RECORD · FULL SCREEN · HELP "?"
 *
 * PRESETS / SAVE are now LIVE — momentary caps that open the
 * preset-picker overlay (PresetPicker.tsx) via the onOpenPicker prop: PRESETS in
 * 'browse' mode (factory presets + saved setups + import), SAVE in 'save' mode
 * (name-a-slot + export + import). App owns the overlay open-state. HELP is the
 * one reserved placeholder still rendered dimmed and inert. RECORD is live —
 * a latching button that captures the master output to a downloadable webm/opus
 * file, lit red while recording with an elapsed m:ss readout (state polled off
 * the bridge). FULL SCREEN is live — the 16:9 stage targets the
 * full 1080p viewport. The MIDI LED renders unlit and makes NO Web
 * MIDI calls yet (no permission prompt before the feature exists).
 *
 * POWER is the AudioContext user-gesture unlock and keeps its
 * data-testid="power" contract; App owns the usePower state (it also drives
 * panel dimming) and passes it down. This strip is the one region that never
 * dims when unpowered.
 */

import { memo, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ControlDef } from '../../data/schema';
import { COLORS, FONT_CONDENSED } from './theme';
import { REGIONS } from './stage16x9';
import { Button } from './controls/Button';
import { engineBridge } from './engineBridge';
import { useRecordingState } from './useStudio';
import { formatElapsed } from '../engine/recordHelpers';

const W = REGIONS.utilityStrip.w;
const H = REGIONS.utilityStrip.h;
// Rows sit high enough that row-2 labels clear the violet group border, which
// runs inset ~3.5+4.5 px along the strip's bottom edge (GroupBorders.tsx).
const ROW1_Y = 28;
const ROW2_Y = 70;

const RUN_ALL_DEF: ControlDef = { id: 'MIX_RUN_ALL', panelLabel: 'RUN ALL', type: 'button' };
const STOP_ALL_DEF: ControlDef = { id: 'MIX_STOP_ALL', panelLabel: 'STOP ALL', type: 'button' };
const TEMPO_LINK_DEF: ControlDef = {
  id: 'MIX_TEMPO_LINK',
  panelLabel: 'TEMPO LINK',
  type: 'button',
  positions: ['OFF', 'ON'],
  default: 'OFF',
};
const FULL_SCREEN_DEF: ControlDef = {
  id: 'UI_FULL_SCREEN',
  panelLabel: 'FULL SCREEN',
  type: 'button',
  positions: ['OFF', 'ON'],
  default: 'OFF',
};
const RECORD_DEF: ControlDef = {
  id: 'UI_RECORD',
  panelLabel: 'RECORD',
  type: 'button',
  positions: ['OFF', 'ON'],
  default: 'OFF',
};

function subscribeStore(onChange: () => void): () => void {
  return engineBridge.store.subscribe(onChange);
}

// ---- POWER (custom cap spanning both rows; pulse animation lives in styles.css) ---------

const PowerButton = memo(function PowerButton({
  powered,
  busy,
  onToggle,
}: {
  powered: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<SVGGElement>) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      onToggle();
    },
    [onToggle],
  );
  return (
    <g
      className="control"
      role="button"
      tabIndex={0}
      aria-pressed={powered}
      aria-label={powered ? 'POWER: on' : 'POWER: off'}
      aria-disabled={busy}
      data-testid="power"
      onClick={busy ? undefined : onToggle}
      onKeyDown={busy ? undefined : onKeyDown}
      opacity={busy ? 0.6 : 1}
    >
      <title>{powered ? 'Power the studio off' : 'Power the studio on (unlocks audio)'}</title>
      <rect
        x={16}
        y={26}
        width={72}
        height={40}
        rx={6}
        fill={COLORS.panelShadow}
        stroke={powered ? COLORS.ledRed : COLORS.panelEdge}
        strokeWidth={1.5}
      />
      <circle
        cx={32}
        cy={46}
        r={5}
        className={powered ? 'power-lamp power-lamp--on' : 'power-lamp power-lamp--off'}
        stroke={COLORS.panelShadow}
        strokeWidth={1}
      />
      <text
        x={44}
        y={50}
        fontFamily={FONT_CONDENSED}
        fontSize={12}
        letterSpacing={2}
        fill={COLORS.legend}
      >
        POWER
      </text>
    </g>
  );
});

// ---- live row-1 controls -----------------------------------------------------------------

/** Convenience transports — momentary caps, bridge action on the down edge. */
const RunStopAll = memo(function RunStopAll() {
  const onRun = useCallback((pos: string) => {
    if (pos === 'ON') engineBridge.runAll();
  }, []);
  const onStop = useCallback((pos: string) => {
    if (pos === 'ON') engineBridge.stopAll();
  }, []);
  return (
    <g>
      <Button def={RUN_ALL_DEF} value="OFF" onChange={onRun} momentary x={132} y={ROW1_Y} />
      <Button def={STOP_ALL_DEF} value="OFF" onChange={onStop} momentary x={212} y={ROW1_Y} />
    </g>
  );
});

/** TEMPO LINK — now a lit latch button (was a 2-pos switch in the old
 *  mixer column; a 46-px-tall switch lever does not fit the 102-px strip). */
const TempoLinkButton = memo(function TempoLinkButton() {
  const getSnapshot = useCallback(() => engineBridge.store.getState().mixer.tempoLink, []);
  const linked = useSyncExternalStore(subscribeStore, getSnapshot);
  const onChange = useCallback((pos: string) => engineBridge.setTempoLink(pos === 'ON'), []);
  return (
    <Button
      def={TEMPO_LINK_DEF}
      value={linked ? 'ON' : 'OFF'}
      onChange={onChange}
      lit={linked}
      x={296}
      y={ROW1_Y}
    />
  );
});

/**
 * INIT: double-click resets every control on
 * all three machines + mixer to factory defaults, clears all cables, stops
 * transports. Double-click (not single) so a stray click can't wipe a patch.
 */
const InitButton = memo(function InitButton({ x, y }: { x: number; y: number }) {
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

/** MIDI connection LED: unlit indicator only — the feature (and
 *  any Web MIDI permission prompt) lands with MIDI input itself. */
const MidiLed = memo(function MidiLed({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <title>MIDI input — coming soon (BACKLOG #6); lights when a device is connected</title>
      <circle cx={x} cy={y} r={5} fill={COLORS.ledOff} stroke={COLORS.panelShadow} strokeWidth={1} />
      <text
        x={x}
        y={y + 22}
        textAnchor="middle"
        fontFamily={FONT_CONDENSED}
        fontSize={10}
        letterSpacing={1}
        fill={COLORS.legendDim}
      >
        MIDI
      </text>
    </g>
  );
});

// ---- row-2 features ------------------------------------------------------------------------

/**
 * Momentary "open a flow" cap (PRESETS / SAVE, live). Same 32×18
 * rx=4 geometry + y+22 label as the old dimmed PlaceholderButton (so the strip is
 * pixel-identical apart from opacity 0.4→1.0), but full opacity + interactive:
 * className="control", role=button, keyboard-activatable, a tooltip, and a
 * data-testid. NOT the shared <Button> (that paints an OFF/ON caption + LED +
 * aria-pressed for latching toggles — wrong for a momentary picker-opener).
 */
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
        x={x - 16}
        y={y - 9}
        width={32}
        height={18}
        rx={4}
        fill={COLORS.panelShadow}
        stroke={COLORS.panelEdge}
        strokeWidth={1.2}
      />
      <text
        x={x}
        y={y + 22}
        textAnchor="middle"
        fontFamily={FONT_CONDENSED}
        fontSize={10}
        letterSpacing={0.5}
        fill={COLORS.legend}
        pointerEvents="none"
        {...(label.length * 5.6 > 54
          ? { textLength: 54, lengthAdjust: 'spacingAndGlyphs' as const }
          : {})}
      >
        {label}
      </text>
    </g>
  );
}

/**
 * RECORD (live): capture the master output (post-softClip, the final
 * audible node) to a downloadable webm/opus file. The shared latching Button paints
 * the LED lamp (COLORS.ledRed glow while `lit`) + the OFF/ON cap caption + aria-pressed,
 * exactly like FULL SCREEN. The polled `recording` flag (engineBridge → 250 ms poll) is
 * the SINGLE source of truth: value/lit and the onChange branch all read it, so the lamp
 * can never desync from the engine. Button is latching, so the cycled position arg is
 * ignored — we toggle start/stop off the polled flag. The engine auto-stops on power-off,
 * so the UI is never a second owner of stop; the next poll clears the lamp + timer.
 * Elapsed m:ss renders ONLY while recording, to the RIGHT of the cap (inside the gap to
 * FULL SCREEN — below the cap would overflow the 102.78-tall viewBox and be clipped).
 */
const RecordButton = memo(function RecordButton() {
  const { recording, elapsedMs } = useRecordingState();
  const onChange = useCallback(() => {
    if (recording) engineBridge.stopRecording();
    else engineBridge.startRecording();
  }, [recording]);
  return (
    <g data-testid="record">
      <title>
        {recording
          ? `Stop recording (${formatElapsed(elapsedMs)})`
          : 'Record the studio output to a downloadable file'}
      </title>
      <Button
        def={RECORD_DEF}
        value={recording ? 'ON' : 'OFF'}
        onChange={onChange}
        lit={recording}
        x={272}
        y={ROW2_Y}
      />
      {recording && (
        <text
          data-testid="record-elapsed"
          x={293}
          y={ROW2_Y + 3}
          textAnchor="start"
          fontFamily={FONT_CONDENSED}
          fontSize={9}
          fill={COLORS.ledRed}
          letterSpacing={0.5}
        >
          {formatElapsed(elapsedMs)}
        </text>
      )}
    </g>
  );
});

/** FULL SCREEN (live): the stage targets the full 1080p viewport. */
const FullScreenButton = memo(function FullScreenButton() {
  const [isFs, setIsFs] = useState(() => document.fullscreenElement != null);
  useEffect(() => {
    const sync = () => setIsFs(document.fullscreenElement != null);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const onChange = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen().catch(() => undefined);
  }, []);
  return (
    <Button
      def={FULL_SCREEN_DEF}
      value={isFs ? 'ON' : 'OFF'}
      onChange={onChange}
      lit={isFs}
      x={352}
      y={ROW2_Y}
    />
  );
});

/** HELP "?": reserved for the abbreviation-glossary overlay. */
function HelpPlaceholder({ x, y }: { x: number; y: number }) {
  return (
    <g opacity={0.4} aria-disabled="true" aria-label="Help glossary (coming soon)" role="button">
      <title>Abbreviation glossary — coming soon (BACKLOG #8)</title>
      <circle cx={x} cy={y} r={10} fill={COLORS.panelShadow} stroke={COLORS.panelEdge} strokeWidth={1.2} />
      <text
        x={x}
        y={y + 4}
        textAnchor="middle"
        fontFamily={FONT_CONDENSED}
        fontSize={12}
        fill={COLORS.legend}
      >
        ?
      </text>
      <text
        x={x}
        y={y + 24}
        textAnchor="middle"
        fontFamily={FONT_CONDENSED}
        fontSize={10}
        letterSpacing={0.5}
        fill={COLORS.legend}
      >
        HELP
      </text>
    </g>
  );
}

// ---- strip ---------------------------------------------------------------------------------

export const UtilityStrip = memo(function UtilityStrip({
  powered,
  busy,
  onTogglePower,
  onOpenPicker,
}: {
  powered: boolean;
  busy: boolean;
  onTogglePower: () => void;
  /** Open the preset-picker overlay (App owns the open-state). */
  onOpenPicker: (mode: 'browse' | 'save') => void;
}) {
  const onPresets = useCallback(() => onOpenPicker('browse'), [onOpenPicker]);
  const onSave = useCallback(() => onOpenPicker('save'), [onOpenPicker]);
  return (
    <svg
      className="panel"
      viewBox={`0 0 ${W} ${H}`}
      xmlns="http://www.w3.org/2000/svg"
      role="group"
      aria-label="Utility strip — power, transports, features"
    >
      {/* raised strip face (mixer family) */}
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

      <PowerButton powered={powered} busy={busy} onToggle={onTogglePower} />

      <RunStopAll />
      <TempoLinkButton />
      <InitButton x={372} y={ROW1_Y} />
      <MidiLed x={548} y={ROW1_Y} />

      <FeatureCap
        x={132}
        y={ROW2_Y}
        label="PRESETS"
        hint="Browse factory presets + your saved setups (also import a shared .json)"
        testId="presets"
        onActivate={onPresets}
      />
      <FeatureCap
        x={202}
        y={ROW2_Y}
        label="SAVE"
        hint="Save the current setup to a slot, or export it as a shareable .json"
        testId="save"
        onActivate={onSave}
      />
      <RecordButton />
      <FullScreenButton />
      <HelpPlaceholder x={424} y={ROW2_Y} />
    </svg>
  );
});
