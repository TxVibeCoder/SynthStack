/**
 * DRUM MACHINE panel (feature drum-machine) — a TR-808-style 8-track × 16-step toggle
 * grid that triggers the 8 sample pads (row t = pad t), locked to the Monarch master tempo.
 * It lives in the SAME scroll-down section as the pads, tiled directly below SamplerPanel,
 * rendered as ONE SVG inside the scaled stage. The panel has NO jacks (steps fire
 * one-shots via the SamplerStepSeq scheduler citizen), so it adds nothing to the cable
 * coordinate space — the 16:9 console + cable overlay stay pixel-identical.
 *
 * Interaction (all through engineBridge — the ONLY React→engine seam):
 *  - click a cell to toggle that (track, step) on/off (engineBridge.toggleStep)
 *  - RUN/STOP lit-latch starts/stops the grid (drumRun / drumStop); CLEAR zeroes it
 *  - a translucent COLUMN highlight chases the live step (useStepPosition('drum'),
 *    gated on the running flag) — the same on=running&&pos===idx idea the Monarch LEDs use
 *
 * Empty-pad ON cells are a harmless SILENT no-op (sampler.triggerPad early-returns when
 * the pad has no sample) — the cell still toggles; only the row LABEL dims to signal it.
 *
 * Pattern subscription (avoid the render-loop trap — engineBridge.store.getState() clones
 * on every call AND engineBridge.getPattern() mints a fresh array each call, so a
 * fresh-array useSyncExternalStore getSnapshot would infinite-loop): the WHOLE 8×16
 * pattern (128 booleans, tiny) plus the pad-name meta is read into local state once and
 * re-read only when a JSON dirty-key changes — the MonarchStepEditor.readSeq idiom.
 */

import { memo, useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { ControlDef } from '../../../data/schema';
import { COLORS, FONT_CONDENSED } from '../theme';
import { Button } from '../controls/Button';
import { Knob } from '../controls/Knob';
import type { SamplerBridge } from '../sampler/samplerBridge';
import {
  DRUM_BEATROW_Y,
  DRUM_GRID,
  DRUM_TRANSPORT,
  cellRect,
  columnX,
  drumLayout,
} from './samplerLayout';

const TRACKS = 8;
const STEPS = 16;
/** Beat-emphasis columns (downbeats of a 4/4 bar) read brighter for the eye. */
const BEAT_COLS = new Set([0, 4, 8, 12]);

const RUNSTOP_DEF: ControlDef = {
  id: 'DRUM_RUNSTOP',
  panelLabel: 'RUN/STOP',
  type: 'button',
  positions: ['STOP', 'RUN'],
};
// CLEAR is a momentary one-shot: a 2-position button fires onChange(active) on pointerdown
// and onChange(idle) on release (the HOLD idiom). We act ONLY on the active edge so the
// pattern is cleared exactly once per press. The cap always reads 'CLEAR' (idle position).
const CLEAR_IDLE = 'CLEAR';
const CLEAR_FIRE = 'CLEARING';
const CLEAR_DEF: ControlDef = {
  id: 'DRUM_CLEAR',
  panelLabel: 'CLEAR',
  type: 'button',
  positions: [CLEAR_IDLE, CLEAR_FIRE],
};

// LENGTH: commit-only stepped Knob, wrap length 1..16 (16 detents). Columns >= length are
// greyed + unplayed (the engine RETAINS the hidden cells — mirror monarch endStep). onInput is a
// no-op so a drag/step never writes the engine mid-gesture; onCommit pushes the value once.
const LENGTH_DEF: ControlDef = {
  id: 'DRUM_LENGTH',
  panelLabel: 'LENGTH',
  type: 'stepKnob', // integer detents 1..16 (one per integer in range)
  min: 1,
  max: 16,
  default: 16,
};
// SWING: commit-only Knob. State allows 0..100 but the knob is CAPPED at the musical 75 — the
// by-ear range (flagged for the operator). 50 = no swing. Commit-only avoids any liveDrumSwingPct guard
// (syncTransportConfig only reads the committed store value).
const SWING_DEF: ControlDef = {
  id: 'DRUM_SWING',
  panelLabel: 'SWING',
  type: 'knob',
  min: 0,
  max: 75,
  default: 50,
};

/** The panel's whole snapshot: the 8×16 pattern + per-row pad-name meta + var-length/swing. */
interface DrumSnapshot {
  pattern: boolean[][];
  /** Row labels: the raw pad sample name, or null when the pad is empty (dims the label). */
  labels: (string | null)[];
  /** Wrap length 1..16: columns >= numSteps are greyed (retained but unplayed). */
  numSteps: number;
  /** Swing 0..100 (50 = none). */
  swingPct: number;
}

function readSnapshot(bridge: SamplerBridge): DrumSnapshot {
  const pattern = bridge.getPattern();
  const labels = Array.from({ length: TRACKS }, (_, t) => bridge.getPadState(t).sampleName);
  return {
    pattern,
    labels,
    numSteps: bridge.getDrumNumSteps(),
    swingPct: bridge.getDrumSwing(),
  };
}

// ---- single cell -----------------------------------------------------------------------

interface DrumCellProps {
  /** Injected action surface (real engineBridge in-console, proxy in the pop-out). */
  bridge: SamplerBridge;
  track: number;
  step: number;
  on: boolean;
  /** True when step >= numSteps: the cell is RETAINED in state but greyed + unplayed. */
  beyondLength: boolean;
}

/**
 * One toggle. Memoized on (track, step, on, beyondLength) so a single click — or a LENGTH change
 * that only flips the greyed band — re-renders the minimum number of cells. The handler reads the
 * bridge directly (no per-cell callback prop) so the props stay primitive for the memo bailout.
 *
 * beyondLength cells stay TOGGLEABLE (mirror monarch endStep: cells past the wrap are retained,
 * not deleted) — they just render dimmed to signal they will not play at the current length.
 */
const DrumCell = memo(function DrumCell({ bridge, track, step, on, beyondLength }: DrumCellProps) {
  const r = cellRect(track, step);
  const beat = BEAT_COLS.has(step);
  return (
    <rect
      data-testid={`drum-cell-${track}-${step}`}
      role="button"
      tabIndex={0}
      aria-label={`Track ${track + 1} step ${step + 1}: ${on ? 'on' : 'off'}${beyondLength ? ' (beyond length)' : ''}`}
      x={r.x}
      y={r.y}
      width={r.w}
      height={r.h}
      rx={4}
      fill={on ? COLORS.knob : beat ? COLORS.panelRaised : COLORS.panel}
      stroke={on ? COLORS.knobHi : COLORS.panelEdge}
      strokeWidth={beat ? 1.4 : 1}
      opacity={beyondLength ? 0.32 : 1}
      style={{ cursor: 'pointer' }}
      onPointerDown={() => bridge.toggleStep(track, step)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          bridge.toggleStep(track, step);
        }
      }}
    />
  );
});

// ---- panel -----------------------------------------------------------------------------

/**
 * DrumMachinePanel props. `bridge` is the DI seam (G5) and is REQUIRED so this module imports
 * NEITHER `realSamplerBridge` NOR engineBridge (keeping the engine out of the pop-out graph):
 * the MAIN window (App.tsx) passes `realSamplerBridge`, the POP-OUT passes the proxy. Every engine
 * call + the snapshot/transport reads route through `bridge`.
 */
export interface DrumMachinePanelProps {
  bridge: SamplerBridge;
}

export function DrumMachinePanel({ bridge }: DrumMachinePanelProps) {
  const [snap, setSnap] = useState<DrumSnapshot>(() => readSnapshot(bridge));

  // Drum step-chase position via the bridge: in-console this is the rAF chase, in the pop-out it
  // is −1 (control-only v1). Subscribed through the bridge so the source matches the window.
  const subscribeStep = useCallback((cb: () => void) => bridge.subscribeDrumStep(cb), [bridge]);
  const getStepPos = useCallback(() => bridge.getDrumStepPosition(), [bridge]);
  const pos = useSyncExternalStore(subscribeStep, getStepPos);

  // RUN/STOP + master flags via the bridge (in-console: live engine flags; pop-out: the mirror).
  // Polled like useTransportFlags so the in-console latch still reflects RUN ALL etc.; the pop-out
  // reads the mirror, which rebroadcasts on each drum RUN/STOP store write.
  const subscribeStore = useCallback((cb: () => void) => bridge.subscribe(cb), [bridge]);
  const drumRunning = useSyncExternalStore(subscribeStore, () => bridge.getDrumRunning());
  const monarchRunning = useSyncExternalStore(subscribeStore, () => bridge.getMonarchRunning());

  // Whole-pattern + label subscription with a JSON dirty-key (MonarchStepEditor.readSeq idiom).
  // A fresh-array useSyncExternalStore getSnapshot would loop; this re-renders only when a
  // cell toggles or a sample loads.
  useEffect(() => {
    let last = JSON.stringify(readSnapshot(bridge));
    return bridge.subscribe(() => {
      const next = readSnapshot(bridge);
      const key = JSON.stringify(next);
      if (key !== last) {
        last = key;
        setSnap(next);
      }
    });
  }, [bridge]);

  const chaseActive = drumRunning && pos >= 0;

  // Commit-only handlers: onInput is a no-op (no mid-gesture engine write), onCommit pushes once
  // through the bridge (engine write when powered + a single coalesced store commit). No
  // liveDrumSwingPct guard is needed because syncTransportConfig only reads the committed value.
  const onLength = useCallback((v: number) => bridge.setDrumNumSteps(v), [bridge]);
  const onSwing = useCallback((v: number) => bridge.setDrumSwing(v), [bridge]);
  const noop = useCallback(() => undefined, []); // commit-only: onInput must not write the engine

  return (
    <svg
      className="panel"
      data-testid="drum-machine-panel"
      viewBox={`0 0 ${drumLayout.width} ${drumLayout.height}`}
      xmlns="http://www.w3.org/2000/svg"
      role="group"
      aria-label={`${drumLayout.title} panel`}
    >
      {/* panel face */}
      <rect
        x={0.5}
        y={0.5}
        width={drumLayout.width - 1}
        height={drumLayout.height - 1}
        rx={8}
        fill={COLORS.panel}
        stroke={COLORS.panelEdge}
        strokeWidth={1}
      />

      {/* plain-text functional title, top-left — no trade dress */}
      <text
        x={14}
        y={24}
        fontFamily={FONT_CONDENSED}
        fontSize={17}
        letterSpacing={2.5}
        fill={COLORS.legend}
      >
        {drumLayout.title}
      </text>

      {/* live COLUMN highlight — one translucent full-grid-height bar over the active step,
          painted UNDER the cells so the gold ON squares stay legible. Gated on running. */}
      {chaseActive && (
        <rect
          x={columnX(pos) - DRUM_GRID.colPitch / 2}
          y={DRUM_GRID.y0 - DRUM_GRID.cell / 2 - 4}
          width={DRUM_GRID.colPitch}
          height={(TRACKS - 1) * DRUM_GRID.rowPitch + DRUM_GRID.cell + 8}
          rx={4}
          fill={COLORS.ledAmber}
          opacity={0.16}
          pointerEvents="none"
        />
      )}

      {/* top beat-number row (1..16), downbeats brighter for the 4/4 read */}
      {Array.from({ length: STEPS }, (_, s) => (
        <text
          key={s}
          x={columnX(s)}
          y={DRUM_BEATROW_Y}
          textAnchor="middle"
          fontFamily={FONT_CONDENSED}
          fontSize={9.5}
          letterSpacing={0.5}
          fill={
            s >= snap.numSteps
              ? COLORS.legendDim
              : BEAT_COLS.has(s)
                ? COLORS.legend
                : COLORS.legendDim
          }
          opacity={s >= snap.numSteps ? 0.4 : 1}
          pointerEvents="none"
        >
          {s + 1}
        </text>
      ))}

      {/* left-gutter pad-name labels, one per row; dim when the pad is empty */}
      {Array.from({ length: TRACKS }, (_, t) => {
        const label = snap.labels[t] ?? null;
        return (
          <text
            key={t}
            x={DRUM_GRID.labelGutter - 12}
            y={DRUM_GRID.y0 + t * DRUM_GRID.rowPitch + 4}
            textAnchor="end"
            fontFamily={FONT_CONDENSED}
            fontSize={11}
            letterSpacing={0.5}
            fill={label == null ? COLORS.legendDim : COLORS.legend}
            pointerEvents="none"
          >
            {(label ?? `PAD ${t + 1}`).toUpperCase()}
          </text>
        );
      })}

      {/* 8×16 toggle grid */}
      {Array.from({ length: TRACKS }, (_, t) =>
        Array.from({ length: STEPS }, (_, s) => (
          <DrumCell
            key={`${t}-${s}`}
            bridge={bridge}
            track={t}
            step={s}
            on={snap.pattern[t]?.[s] ?? false}
            beyondLength={s >= snap.numSteps}
          />
        )),
      )}

      {/* RUN/STOP lit latch — fires the opposite action on each click */}
      <g data-testid="drum-runstop">
        <Button
          def={RUNSTOP_DEF}
          value={drumRunning ? 'RUN' : 'STOP'}
          lit={drumRunning}
          onChange={() => (drumRunning ? bridge.drumStop() : bridge.drumRun())}
          x={DRUM_TRANSPORT.runStopX}
          y={DRUM_TRANSPORT.y}
        />
      </g>

      {/* CLEAR momentary — zeroes the whole pattern on the press edge only */}
      <g data-testid="drum-clear">
        <Button
          def={CLEAR_DEF}
          value={CLEAR_IDLE}
          momentary
          onChange={(pos) => {
            if (pos === CLEAR_FIRE) bridge.clearDrumPattern();
          }}
          x={DRUM_TRANSPORT.clearX}
          y={DRUM_TRANSPORT.y}
        />
      </g>

      {/* LENGTH (1..16 wrap) + SWING (0..75 musical cap) — commit-only Knobs in the right strip
          below the transport buttons. onInput is a no-op (commit-only): the engine is written once
          on release/step, so there is no live-drag clobber against syncTransportConfig. */}
      <g data-testid="drum-length">
        <Knob def={LENGTH_DEF} value={snap.numSteps} onInput={noop} onCommit={onLength}
          x={DRUM_TRANSPORT.lengthX} y={DRUM_TRANSPORT.lengthY} />
      </g>
      <g data-testid="drum-swing">
        <Knob def={SWING_DEF} value={snap.swingPct} onInput={noop} onCommit={onSwing}
          x={DRUM_TRANSPORT.swingX} y={DRUM_TRANSPORT.swingY} />
      </g>

      {/* MASTER-STOPPED hint: the grid follows the Monarch master clock, so a lit drum RUN
          while the master is stopped emits nothing (v1 master-stopped semantics). Surface it
          so "I pressed RUN and nothing happened" reads as a state, not a bug. RUN ALL (or the
          Monarch's RUN) starts the master; with the master running this vanishes. */}
      {drumRunning && !monarchRunning && (
        <g data-testid="drum-waiting-master" pointerEvents="none">
          <title>
            The drum grid follows the master clock. Start the master (RUN ALL, or the Monarch
            transport) to hear the drums.
          </title>
          <circle cx={DRUM_TRANSPORT.clearX + 50} cy={DRUM_TRANSPORT.y} r={4} fill={COLORS.ledAmber} />
          <text
            x={DRUM_TRANSPORT.clearX + 62}
            y={DRUM_TRANSPORT.y + 4}
            textAnchor="start"
            fontFamily={FONT_CONDENSED}
            fontSize={12}
            letterSpacing={1}
            fontWeight={600}
            fill={COLORS.ledAmber}
          >
            WAITING FOR MASTER RUN
          </text>
        </g>
      )}
    </svg>
  );
}
