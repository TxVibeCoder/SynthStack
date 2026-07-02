/**
 * Direct-manipulation gestures for sequencer STEP CELLS (the Monarch + Courier step
 * editors share these semantics).
 *
 * The 2026-07 UX pass made the cells first-class controls (previously: click to select,
 * click AGAIN to rest, then tune pitch on the shared NOTE knob or via keyboard REC):
 *   - TAP a cell      → toggle the step audible/silent (on/off, one gesture)
 *   - DRAG vertically → tune the step's pitch in semitones, live (up = higher);
 *                       dragging a silent step also switches it on
 *   - every touch also SELECTS the cell, so the edit row (gate/glide/…) follows
 * Keyboard arrows, the edit-row NOTE knob, and REC step-record remain as before.
 *
 * The pure semantics (dragSemisFrom / tapPatch) are separated from the pointer plumbing
 * (useStepCellGesture) so they are unit-testable in Node (test/unit/stepCellEdit.test.ts).
 */

import { useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/** Screen pixels of vertical drag per semitone (matches knob drag feel at stage scale). */
export const PX_PER_SEMI = 7;

/** Travel dead-zone: a press that moves less than this is a TAP (on/off), not a drag. */
export const DRAG_THRESHOLD_PX = 5;

/** Both editors' NOTE rail (NOTE_DEF min/max: ±24 semitones = ±2 vv). */
export const SEMI_MIN = -24;
export const SEMI_MAX = 24;

/**
 * Pitch for a vertical drag: dyPx is pointer travel DOWN in screen px (clientY delta),
 * so dragging UP raises the pitch. Snapped to whole semitones, clamped to the NOTE rail.
 */
export function dragSemisFrom(startSemis: number, dyPx: number): number {
  const s = startSemis + Math.round(-dyPx / PX_PER_SEMI);
  return Math.max(SEMI_MIN, Math.min(SEMI_MAX, s));
}

/**
 * Store patch for a TAP — toggle the step audible/silent (a plain REST flip).
 *
 * Deliberately does NOT touch noteVv: negative notes are REAL in both editors (Monarch's
 * default step is C3 = −1 vv; Courier plays negative notes in seq mode — its "noteVv < 0
 * == unauthored blank" is a display/arp-pool convention, and an authored note below the
 * C5 anchor is negative too, so rewriting on tap would destroy authored pitches).
 */
export function tapPatch(step: { rest: boolean }): { rest: boolean } {
  return { rest: !step.rest };
}

export interface StepCellGestureOpts {
  /** Called on pointer-down — select the cell (and focus the editor for arrow keys). */
  onSelect: () => void;
  /** Called when the press ends without crossing the drag threshold — toggle on/off. */
  onTap: (shiftKey: boolean) => void;
  /** Called with the new semitone value while dragging (only when it changes). */
  onDragSemis: (semis: number) => void;
  /** The step's current pitch in semitones when the press starts (drag origin). */
  startSemis: () => number;
}

/** Pointer handlers implementing tap = on/off, vertical drag = pitch, for an SVG cell. */
export function useStepCellGesture(opts: StepCellGestureOpts): {
  onPointerDown: (e: ReactPointerEvent<SVGGElement>) => void;
  onPointerMove: (e: ReactPointerEvent<SVGGElement>) => void;
  onPointerUp: (e: ReactPointerEvent<SVGGElement>) => void;
  onPointerCancel: (e: ReactPointerEvent<SVGGElement>) => void;
} {
  const st = useRef({ id: -1, y0: 0, s0: 0, dragging: false, last: NaN });

  const release = (e: ReactPointerEvent<SVGGElement>) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    st.current.id = -1;
  };

  return {
    onPointerDown: (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.pointerType === 'touch' && !e.isPrimary) return; // second finger: leave pinch-zoom alone
      e.currentTarget.setPointerCapture(e.pointerId);
      st.current = { id: e.pointerId, y0: e.clientY, s0: opts.startSemis(), dragging: false, last: NaN };
      opts.onSelect();
      e.preventDefault();
    },
    onPointerMove: (e) => {
      const s = st.current;
      if (s.id !== e.pointerId) return;
      const dy = e.clientY - s.y0;
      if (!s.dragging && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
      s.dragging = true;
      const semis = dragSemisFrom(s.s0, dy);
      if (semis !== s.last) {
        s.last = semis;
        opts.onDragSemis(semis);
      }
    },
    onPointerUp: (e) => {
      const s = st.current;
      if (s.id !== e.pointerId) return;
      const wasDrag = s.dragging;
      release(e);
      if (!wasDrag) opts.onTap(e.shiftKey);
    },
    // cancel (capture lost, touch interrupted): abort silently — no tap, drag edits stand.
    onPointerCancel: release,
  };
}
