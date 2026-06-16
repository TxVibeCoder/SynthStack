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

import { memo, useEffect, useState } from 'react';
import type { ControlDef } from '../../../data/schema';
import { COLORS, FONT_CONDENSED } from '../theme';
import { Button } from '../controls/Button';
import { engineBridge } from '../engineBridge';
import { useStepPosition, useTransportFlags } from '../useStudio';
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

/** The panel's whole snapshot: the 8×16 pattern + per-row pad-name meta (for labels). */
interface DrumSnapshot {
  pattern: boolean[][];
  /** Row labels: the raw pad sample name, or null when the pad is empty (dims the label). */
  labels: (string | null)[];
}

function readSnapshot(): DrumSnapshot {
  const pattern = engineBridge.getPattern();
  const labels = Array.from({ length: TRACKS }, (_, t) => engineBridge.getPadState(t).sampleName);
  return { pattern, labels };
}

// ---- single cell -----------------------------------------------------------------------

interface DrumCellProps {
  track: number;
  step: number;
  on: boolean;
}

/**
 * One toggle. Memoized on (track, step, on) so a single click re-renders only the cell it
 * flipped — the 128-cell grid never redraws wholesale. The handler reads the bridge
 * directly (no per-cell callback prop) so the props stay primitive for the memo bailout.
 */
const DrumCell = memo(function DrumCell({ track, step, on }: DrumCellProps) {
  const r = cellRect(track, step);
  const beat = BEAT_COLS.has(step);
  return (
    <rect
      data-testid={`drum-cell-${track}-${step}`}
      role="button"
      tabIndex={0}
      aria-label={`Track ${track + 1} step ${step + 1}: ${on ? 'on' : 'off'}`}
      x={r.x}
      y={r.y}
      width={r.w}
      height={r.h}
      rx={4}
      fill={on ? COLORS.knob : beat ? COLORS.panelRaised : COLORS.panel}
      stroke={on ? COLORS.knobHi : COLORS.panelEdge}
      strokeWidth={beat ? 1.4 : 1}
      style={{ cursor: 'pointer' }}
      onPointerDown={() => engineBridge.toggleStep(track, step)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          engineBridge.toggleStep(track, step);
        }
      }}
    />
  );
});

// ---- panel -----------------------------------------------------------------------------

export function DrumMachinePanel() {
  const [snap, setSnap] = useState<DrumSnapshot>(readSnapshot);
  const pos = useStepPosition('drum');
  const { drumRunning } = useTransportFlags();

  // Whole-pattern + label subscription with a JSON dirty-key (MonarchStepEditor.readSeq idiom).
  // A fresh-array useSyncExternalStore getSnapshot would loop; this re-renders only when a
  // cell toggles or a sample loads.
  useEffect(() => {
    let last = JSON.stringify(readSnapshot());
    return engineBridge.store.subscribe(() => {
      const next = readSnapshot();
      const key = JSON.stringify(next);
      if (key !== last) {
        last = key;
        setSnap(next);
      }
    });
  }, []);

  const chaseActive = drumRunning && pos >= 0;

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
          fill={BEAT_COLS.has(s) ? COLORS.legend : COLORS.legendDim}
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
          <DrumCell key={`${t}-${s}`} track={t} step={s} on={snap.pattern[t]?.[s] ?? false} />
        )),
      )}

      {/* RUN/STOP lit latch — fires the opposite action on each click */}
      <g data-testid="drum-runstop">
        <Button
          def={RUNSTOP_DEF}
          value={drumRunning ? 'RUN' : 'STOP'}
          lit={drumRunning}
          onChange={() => (drumRunning ? engineBridge.drumStop() : engineBridge.drumRun())}
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
            if (pos === CLEAR_FIRE) engineBridge.clearDrumPattern();
          }}
          x={DRUM_TRANSPORT.clearX}
          y={DRUM_TRANSPORT.y}
        />
      </g>
    </svg>
  );
}
