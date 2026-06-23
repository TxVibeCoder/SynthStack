/**
 * Courier step editor — 64 steps in 4 pages of 16 (the wide param-lock-ready strip).
 * Its OWN landscape strip panel (COURIER_SEQ_STRIP 1300 × 170), mounted beneath the
 * Courier controls on the Courier tab.
 *
 * Phase-C MVP scope: a pure note sequencer. Per step: NOTE (C5-relative), GATE LENGTH
 * (0.05..1, >=1 == TIE), REST, GLIDE (per-step portamento). No accent / ratchet
 * (Courier has neither). TIE is DERIVED from gateLength >= 1 (no separate field), so the
 * wide cell row leaves room for the deferred C-FULL per-step param-lock knobs.
 *
 * Interaction mirrors the Monarch editor: click a cell to SELECT; click the already-
 * selected cell to toggle REST (non-destructive for plain selection); the selected step
 * is edited with the NOTE / GATE knobs + REST / GLIDE / TIE buttons in the bottom edit
 * row. Arrow keys edit/navigate (note ±1/±octave, select ∓1) via the pure courierKeyNav.
 *
 * Courier owns NO panel transport today, so this strip carries its own PLAY/STOP + RESET +
 * REC, mirroring how MonarchPanel mounts its transport (momentary buttons → bridge
 * transport actions, lit by the courierRunning flag). RUN ALL on the ribbon also covers
 * Courier (the engine's runAll/stopAll include the Courier sequencer).
 *
 * All edits are single store commits via courierSeqBridge; Studio.syncTransportConfig
 * pushes the courier.seq slice into the live CourierSequencer.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { useSyncExternalStore } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ControlDef, ModuleDef } from '../../../data/schema';
import courierJson from '../../../data/courier.json';
import type { CourierArpModeState, CourierStepState } from '../../state/studioState';
import { COLORS, FONT_CONDENSED, GROUP_BORDER } from '../theme';
import { Knob } from '../controls/Knob';
import { Switch } from '../controls/Switch';
import { Button } from '../controls/Button';
import { StepLed } from '../controls/StepLed';
import { useControl } from '../useStudio';
import { COURIER_CLOCK_DIVS } from '../../engine/sequencers/courierSeq';
import { COURIER_LOCKABLE } from '../../engine/modRouter';
import { keyToCourierAction, nextNoteSemis, nextSelection } from './courierKeyNav';
import {
  courierIsRunning,
  courierReset,
  courierRun,
  courierStepPosition,
  courierStop,
  readCourierSeq,
  readCourierSeqSettings,
  setCourierEndStep,
  setCourierRecordHandler,
  setCourierSeqField,
  subscribeCourierStepPosition,
  subscribeStore,
  updateCourierStep,
  type CourierSeqView,
} from './courierSeqBridge';

const moduleDef = courierJson as unknown as ModuleDef;
/** Look up a sequencer SETTINGS control def from the Courier JSON (single source of truth). */
function seqDef(id: string): ControlDef {
  const d = moduleDef.controls.find((c) => c.id === id);
  if (!d) throw new Error(`Courier seq control ${id} missing from data/courier.json`);
  return d;
}

/**
 * ARP MODE display<->state maps. The JSON `positions` carry human labels (with spaces);
 * the seq slice stores the underscored union values. The Switch shows the position label, so
 * the handler maps label->state on change and state->label for the rendered value. Anything
 * unrecognized falls back to OFF.
 */
const ARP_POS_TO_VAL: Record<string, CourierArpModeState> = {
  OFF: 'OFF',
  UP: 'UP',
  DOWN: 'DOWN',
  'UP-DN INC': 'UPDOWN_INC',
  'UP-DN EXC': 'UPDOWN_EXC',
  'DN-UP INC': 'DOWNUP_INC',
  'DN-UP EXC': 'DOWNUP_EXC',
  CONVERGE: 'CONVERGE',
  DIVERGE: 'DIVERGE',
  PENDULUM: 'PENDULUM',
  'AS PLAYED': 'AS_PLAYED',
  RANDOM: 'RANDOM',
  'RND WALK': 'RANDOM_WALK',
  CHORD: 'CHORD',
};
const ARP_VAL_TO_POS: Record<CourierArpModeState, string> = Object.fromEntries(
  Object.entries(ARP_POS_TO_VAL).map(([pos, val]) => [val, pos]),
) as Record<CourierArpModeState, string>;

/**
 * Courier-local strip canvas — App.tsx reads this aspect to frame the seq region.
 * Grew (252 -> 330) for the Phase-C param-lock MATRIX band between the edit row and the
 * global SEQUENCER settings row; the stage frame reflows off this height automatically.
 */
export const COURIER_SEQ_STRIP = { w: 1300, h: 330 } as const;

/** Strip geometry: one row of 16 cells per page across the wide canvas. */
const BAND_Y = 6;
const CELL_X0 = 200;
const CELL_PITCH = 66; // (1300 - 200 - ~44 margin) / 16 ≈ 66
const CELL_W = 56;
const CELL_H = 60;
const CELL_Y = BAND_Y + 18;
const LED_Y = BAND_Y + 8;
const EDIT_Y = BAND_Y + 116;
/** Param-lock matrix band, between the per-step edit row and the global settings row. */
const MATRIX_Y = EDIT_Y + 70; // ~192
/** Global sequencer SETTINGS row, beneath the matrix band. */
const SET_Y = BAND_Y + 274;

const PAGE_CELLS = 16;
const ACCENT = GROUP_BORDER.courier;

// ---- param-lock matrix geometry (18-slot 9×2 grid) -----------------------------------------
/** The full 18 matrix slots. 6 are wired from the shared COURIER_LOCKABLE allow-list; the
 *  remaining 12 render as disabled placeholders — forward-compatible with part 2 widening the
 *  lockable set without a re-layout. The wired set can NEVER drift from the engine binder
 *  because both import COURIER_LOCKABLE (derived from MOD_TARGETS). */
const MATRIX_SLOTS = 18;
const MATRIX_COLS = 9;
const MATRIX_X0 = 60;
const MATRIX_PITCH_X = 64;
const MATRIX_PITCH_Y = 40;
const matrixSlotX = (i: number) => MATRIX_X0 + (i % MATRIX_COLS) * MATRIX_PITCH_X;
const matrixSlotY = (i: number) => MATRIX_Y + Math.floor(i / MATRIX_COLS) * MATRIX_PITCH_Y;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * noteVv (1 vv/oct) -> display like "C5", "A#3". The Courier sequence is C5-relative
 * (transpose anchor is C5), so noteVv 0 == C5 — the octave base is 5 (vs Monarch's 4).
 */
function noteName(noteVv: number): string {
  const semis = Math.round(noteVv * 12);
  const idx = ((semis % 12) + 12) % 12;
  const oct = 5 + Math.floor(semis / 12);
  return `${NOTE_NAMES[idx]}${oct}`;
}

const NOTE_DEF: ControlDef = {
  id: 'COU_STEP_NOTE', panelLabel: 'NOTE', type: 'stepKnob',
  min: -24, max: 24, default: 0, taper: 'stepped', steps: 49, unit: 'st',
};
const GATE_DEF: ControlDef = {
  id: 'COU_STEP_GATE', panelLabel: 'GATE LEN', type: 'knob',
  min: 0.05, max: 1, default: 0.5, taper: 'lin',
};
// Per-step probability — authored on CourierStepState (NOT in courier.json; these are step
// fields, not global seq scalars). N PROB = chance the step's note sounds; G PROB = chance the
// gate fires given the note sounds. Both 0..1, default 1 (a 1 step behaves exactly as before).
const NOTE_PROB_DEF: ControlDef = {
  id: 'COU_STEP_NOTE_PROB', panelLabel: 'N PROB', type: 'knob',
  min: 0, max: 1, default: 1, taper: 'lin',
};
const GATE_PROB_DEF: ControlDef = {
  id: 'COU_STEP_GATE_PROB', panelLabel: 'G PROB', type: 'knob',
  min: 0, max: 1, default: 1, taper: 'lin',
};
const END_DEF: ControlDef = {
  id: 'COU_END_STEP', panelLabel: 'END STEP', type: 'stepKnob',
  min: 1, max: 64, default: 16, taper: 'stepped', steps: 64, unit: 'step',
};
const mkToggle = (id: string, label: string): ControlDef => ({
  id, panelLabel: label, type: 'button', positions: ['OFF', 'ON'],
});
const REST_DEF = mkToggle('COU_STEP_REST', 'REST');
const GLIDE_DEF = mkToggle('COU_STEP_GLIDE', 'GLIDE');
const TIE_DEF = mkToggle('COU_STEP_TIE', 'TIE');
const REC_DEF = mkToggle('COU_REC', 'REC');
const PLAY_DEF: ControlDef = { id: 'COU_RUN_STOP', panelLabel: 'PLAY', type: 'button' };
const RESET_DEF: ControlDef = { id: 'COU_RESET', panelLabel: 'RESET', type: 'button' };

/**
 * Resolve a lockable param's ControlDef (min/max/taper/default) from data/courier.json — the
 * single source of truth for ranges. Used to build the per-step lock-value Knob so the locked
 * value is authored in engine-native units (Hz / semitones / 0..1 morph) the binder applies
 * verbatim. The panelLabel is overridden with the short matrix caption for the edit-row knob.
 */
function lockParamDef(controlId: string, cap: string): ControlDef {
  return { ...seqDef(controlId), panelLabel: cap };
}

const CLR_DEF: ControlDef = { id: 'COU_LOCK_CLR', panelLabel: 'CLR', type: 'button' };

/** A step counts as a TIE when its gate length reaches/exceeds 1 (no separate field in MVP). */
function isTie(step: CourierStepState): boolean {
  return step.gateLength >= 1;
}

/** Does this step lock any parameter? (drives the per-cell lock pip + status suffix.) */
function lockCount(step: CourierStepState): number {
  return step.lock ? Object.keys(step.lock).length : 0;
}

function StepCell({
  step, globalIndex, selected, active, beyondEnd, onClick,
}: {
  step: CourierStepState;
  globalIndex: number;
  selected: boolean;
  active: boolean;
  beyondEnd: boolean;
  onClick: (index: number) => void;
}) {
  const x = CELL_X0 + (globalIndex % PAGE_CELLS) * CELL_PITCH;
  const handle = () => onClick(globalIndex);
  const tie = isTie(step);
  const locks = lockCount(step);
  // -1 noteVv == unauthored (rest-like blank). Show a dash; rests show the rest glyph.
  const blank = step.noteVv < 0 && !step.rest;
  return (
    <g className="control" data-testid={`courier-cell-${globalIndex}`} onClick={handle} opacity={beyondEnd ? 0.35 : 1}>
      <StepLed x={x + CELL_W / 2} y={LED_Y} on={active} />
      {/* lock pip — burnt-orange dot in the top-right corner when the step locks any param. */}
      {locks > 0 && (
        <circle data-testid={`courier-cell-lock-${globalIndex}`} cx={x + CELL_W - 7} cy={CELL_Y + 7} r={3} fill={ACCENT} />
      )}
      {/* probability pip — hollow dot in the top-left when the step is below full note-prob. */}
      {step.noteProb < 1 && (
        <circle data-testid={`courier-cell-prob-${globalIndex}`} cx={x + 7} cy={CELL_Y + 7} r={3}
          fill="none" stroke={ACCENT} strokeWidth={1} />
      )}
      <rect
        x={x} y={CELL_Y} width={CELL_W} height={CELL_H} rx={4}
        fill={step.rest ? COLORS.panelShadow : COLORS.panelRaised}
        stroke={selected ? ACCENT : COLORS.panelEdge}
        strokeWidth={selected ? 1.8 : 1}
      />
      <text
        x={x + CELL_W / 2} y={CELL_Y + 18} textAnchor="middle"
        fontFamily={FONT_CONDENSED} fontSize={12}
        fill={step.rest || blank ? COLORS.legendDim : COLORS.legend}
      >
        {step.rest ? '·' : blank ? '–' : noteName(step.noteVv)}
      </text>
      {/* gate-length bar (TIE = amber, full width) */}
      <rect x={x + 6} y={CELL_Y + 26} width={(CELL_W - 12) * Math.min(step.gateLength, 1)} height={4} rx={2}
        fill={tie ? ACCENT : COLORS.knob} opacity={step.rest ? 0.25 : 0.9} />
      <text x={x + CELL_W / 2} y={CELL_Y + 48} textAnchor="middle" fontFamily={FONT_CONDENSED}
        fontSize={8.5} letterSpacing={0.5} fill={COLORS.legendDim}>
        {[step.glide ? 'GL' : null, tie ? 'TIE' : null].filter(Boolean).join(' ') || `${globalIndex + 1}`}
      </text>
    </g>
  );
}

/** Live Courier running flag, polled off the bridge (matches useTransportFlags cadence). */
function useCourierRunning(): boolean {
  const [running, setRunning] = useState(courierIsRunning);
  useEffect(() => {
    const id = setInterval(() => {
      const next = courierIsRunning();
      setRunning((prev) => (prev === next ? prev : next));
    }, 250);
    return () => clearInterval(id);
  }, []);
  return running;
}

/** Courier step-LED chase position via the shared step-position channel. */
function useCourierStepPosition(): number {
  const subscribe = useCallback((cb: () => void) => subscribeCourierStepPosition(cb), []);
  return useSyncExternalStore(subscribe, courierStepPosition);
}

// ---- global sequencer SETTINGS row ----------------------------------------------------------
// These mirror state.courier.seq.* (NOT state.controls.courier): Studio.syncTransportConfig
// reads the seq slice directly, so each must write the slice (via setCourierSeqField). The lone
// exception is TEMPO, which the engine intercepts off state.controls.courier into
// courierSeq.tempoBpm — so it uses the ordinary useControl store path.

/**
 * Snapshot of the seq-settings scalars, re-read on store change (JSON-diffed so a settings
 * write re-renders the row but unrelated store traffic doesn't). Same pattern as the per-step
 * seq mirror below.
 */
function useCourierSeqSettings(): ReturnType<typeof readCourierSeqSettings> {
  const [snap, setSnap] = useState(readCourierSeqSettings);
  useEffect(() => {
    let last = JSON.stringify(readCourierSeqSettings());
    return subscribeStore(() => {
      const next = readCourierSeqSettings();
      const key = JSON.stringify(next);
      if (key !== last) {
        last = key;
        setSnap(next);
      }
    });
  }, []);
  return snap;
}

/** TEMPO — ordinary control store knob (engine maps COU_TEMPO -> courierSeq.tempoBpm). */
const TempoKnob = memo(function TempoKnob({ x, y }: { x: number; y: number }) {
  const def = seqDef('COU_TEMPO');
  const fallback = typeof def.default === 'number' ? def.default : 120;
  const [value, onInput, onCommit] = useControl<number>('courier', 'COU_TEMPO', fallback);
  return <Knob def={def} value={value} onInput={onInput} onCommit={onCommit} accent={ACCENT} x={x} y={y} />;
});

export const CourierStepEditor = memo(function CourierStepEditor() {
  const [seq, setSeq] = useState<CourierSeqView>(readCourierSeq);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState(0);
  const [armed, setArmed] = useState(false);
  /** The lockable param currently armed for per-step value authoring (null = none). Distinct
   *  from the REC note-record `armed` flag above. */
  const [armedParam, setArmedParam] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const pos = useCourierStepPosition();
  const running = useCourierRunning();
  const settings = useCourierSeqSettings();

  // Mirror the courier.seq slice into local state via a JSON-diffed store subscription.
  useEffect(() => {
    let last = JSON.stringify(readCourierSeq());
    return subscribeStore(() => {
      const next = readCourierSeq();
      const key = JSON.stringify(next);
      if (key !== last) {
        last = key;
        setSeq(next);
      }
    });
  }, []);

  // STEP/LIVE record: while REC is armed, register a handler the bridge calls on every
  // keyboard/MIDI note ON while keyboardTarget==='courier' — it writes the cursor step +
  // advances (wrapping at END STEP), so playing the keyboard fills the pattern. Refs keep
  // the handler reading the LIVE cursor/end without re-registering on every move.
  const selectedRef = useRef(selected);
  const endStepRef = useRef(seq.endStep);
  useEffect(() => { selectedRef.current = selected; }, [selected]);
  useEffect(() => { endStepRef.current = seq.endStep; }, [seq.endStep]);
  useEffect(() => {
    if (!armed) return;
    setCourierRecordHandler((noteVv) => {
      const cur = selectedRef.current;
      updateCourierStep(cur, { noteVv, rest: false });
      const next = (cur + 1) % Math.max(1, endStepRef.current);
      setSelected(next);
      setPage(Math.floor(next / PAGE_CELLS)); // follow the cursor onto the next page
    });
    return () => setCourierRecordHandler(null);
  }, [armed]);

  const onCellClick = useCallback(
    (index: number) => {
      const step = readCourierSeq().steps[index];
      if (step && index === selected) {
        updateCourierStep(index, { rest: !step.rest }); // click-to-rest
      }
      setSelected(index);
      svgRef.current?.focus(); // focus the editor so arrows edit immediately
    },
    [selected],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<SVGSVGElement>) => {
      // CRITICAL bubbling guard: a focused child Knob/Button already handled this arrow
      // (preventDefault'd but did NOT stopPropagation), so it bubbles here. Only the editor
      // SVG itself acts — never double-edit a child key.
      if (e.target !== e.currentTarget) return;
      const action = keyToCourierAction(e.key, e.shiftKey);
      if (!action) return; // non-arrow keys fall through untouched (Tab etc.)
      e.preventDefault();
      if (action.kind === 'note') {
        const steps = readCourierSeq().steps;
        const curStep = steps[selected] ?? steps[0];
        const cur = curStep ? Math.round(curStep.noteVv * 12) : 0;
        updateCourierStep(selected, { noteVv: nextNoteSemis(cur, action.delta) / 12, rest: false });
      } else {
        const { selected: nextSel, page: nextPage } = nextSelection(selected, action.delta);
        setSelected(nextSel);
        setPage(nextPage); // page auto-flips so the selected cell stays visible
      }
    },
    [selected],
  );

  const sel = seq.steps[selected] ?? seq.steps[0]!;
  const editStep = useCallback(
    (patch: Partial<CourierStepState>) => updateCourierStep(selected, patch),
    [selected],
  );
  const noop = useCallback(() => undefined, []);
  const onNote = useCallback((v: number) => editStep({ noteVv: Math.round(v) / 12, rest: false }), [editStep]);
  const onGate = useCallback((v: number) => editStep({ gateLength: v }), [editStep]);
  const onEnd = useCallback((v: number) => setCourierEndStep(v), []);
  // Per-step probability (clamped to 0..1; the slice coalesce clamps again on round-trip).
  const onNoteProb = useCallback(
    (v: number) => editStep({ noteProb: Math.max(0, Math.min(1, v)) }),
    [editStep],
  );
  const onGateProb = useCallback(
    (v: number) => editStep({ gateProb: Math.max(0, Math.min(1, v)) }),
    [editStep],
  );

  // TIE toggles the gate length to its tie value (>=1) / back to a normal sustain (0.5).
  const selTie = isTie(sel);
  const onTie = useCallback(() => editStep({ gateLength: selTie ? 0.5 : 1 }), [editStep, selTie]);

  // --- per-step PARAM LOCK authoring ---------------------------------------------------------
  // Merge-write one lock key on the selected step. Always reads the LIVE lock off the store and
  // writes a FRESH object (never mutates in place) so the JSON-diff subscription re-renders.
  const setLockValue = useCallback(
    (controlId: string, value: number) => {
      const prev = readCourierSeq().steps[selected]?.lock ?? null;
      updateCourierStep(selected, { lock: { ...(prev ?? {}), [controlId]: value } });
    },
    [selected],
  );
  // Clear ONE lock key on the selected step; canonicalize an emptied map to null (keeps the
  // emitStepEvents `?? {}` fast-path + the cell-pip check consistent).
  const clearLockValue = useCallback(
    (controlId: string) => {
      const prev = readCourierSeq().steps[selected]?.lock ?? null;
      if (!prev || !(controlId in prev)) return;
      const next: Record<string, number> = { ...prev };
      delete next[controlId];
      updateCourierStep(selected, { lock: Object.keys(next).length > 0 ? next : null });
    },
    [selected],
  );
  // The live ControlDef + current value of the armed param's lock on the selected step.
  const armedCap = armedParam
    ? COURIER_LOCKABLE.find((p) => p.controlId === armedParam)?.cap ?? armedParam
    : null;
  const armedDef = armedParam ? lockParamDef(armedParam, armedCap!) : null;
  const armedLockValue =
    armedParam && armedDef
      ? sel.lock?.[armedParam] ?? (typeof armedDef.default === 'number' ? armedDef.default : 0)
      : 0;
  const selLockCount = lockCount(sel);

  const togglePlay = useCallback(() => {
    if (courierIsRunning()) courierStop();
    else courierRun();
  }, []);

  // --- SETTINGS-row handlers: write the seq slice directly (syncTransportConfig reads it). ---
  const onLength = useCallback((v: number) => setCourierEndStep(v), []); // LENGTH === endStep
  const onGateScale = useCallback(
    (v: number) => setCourierSeqField('gateLenScale', Math.max(0.05, Math.min(1, v))),
    [],
  );
  const onSwing = useCallback(
    (v: number) => setCourierSeqField('swingPct', Math.max(0, Math.min(100, v))),
    [],
  );
  const onClockDiv = useCallback((pos: string) => {
    const idx = COURIER_CLOCK_DIVS.indexOf(pos as (typeof COURIER_CLOCK_DIVS)[number]);
    if (idx >= 0) setCourierSeqField('clockDivIdx', idx);
  }, []);
  const onSeqMode = useCallback(
    (pos: string) => setCourierSeqField('mode', pos === 'ARP' ? 'ARP' : 'SEQ'),
    [],
  );
  const onArpMode = useCallback(
    (pos: string) => setCourierSeqField('arpMode', ARP_POS_TO_VAL[pos] ?? 'OFF'),
    [],
  );
  // ARP OCTAVE — stepped 1..4 octave span.
  const onArpOctave = useCallback(
    (v: number) => setCourierSeqField('arpOctave', Math.max(1, Math.min(4, Math.round(v)))),
    [],
  );
  // ARP RHYTHM — cycling clock-division button; index <-> COURIER_CLOCK_DIVS via arpRhythmIdx.
  const onArpRhythm = useCallback((pos: string) => {
    const idx = COURIER_CLOCK_DIVS.indexOf(pos as (typeof COURIER_CLOCK_DIVS)[number]);
    if (idx >= 0) setCourierSeqField('arpRhythmIdx', idx);
  }, []);
  const clockDivPos = COURIER_CLOCK_DIVS[settings.clockDivIdx] ?? '1/16';
  const arpModePos = ARP_VAL_TO_POS[settings.arpMode] ?? 'OFF';
  const arpRhythmPos = COURIER_CLOCK_DIVS[settings.arpRhythmIdx] ?? '1/16';

  return (
    <svg
      ref={svgRef}
      className="panel"
      viewBox={`0 0 ${COURIER_SEQ_STRIP.w} ${COURIER_SEQ_STRIP.h}`}
      xmlns="http://www.w3.org/2000/svg"
      role="group"
      aria-label="Courier step editor"
      aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowUp Shift+ArrowDown"
      data-testid="courier-step-editor-svg"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      {/* strip face */}
      <rect
        x={0.5} y={0.5}
        width={COURIER_SEQ_STRIP.w - 1} height={COURIER_SEQ_STRIP.h - 1}
        rx={8} fill={COLORS.panel} stroke={ACCENT} strokeWidth={1.5}
      />

      <g data-testid="courier-step-editor">
        {/* strip caption — bottom-right corner, clear of the edit-row buttons */}
        <text
          x={COURIER_SEQ_STRIP.w - 10} y={COURIER_SEQ_STRIP.h - 7} textAnchor="end"
          fontFamily={FONT_CONDENSED} fontSize={10} letterSpacing={1.5} fill={COLORS.legendDim}
        >
          COURIER · STEP EDITOR
        </text>

        {/* page tabs — 4 pages of 16 (1–16 / 17–32 / 33–48 / 49–64) */}
        {[0, 1, 2, 3].map((p) => (
          <g key={p} className="control" onClick={() => setPage(p)} data-testid={`courier-page-${p}`}>
            <rect x={26 + (p % 2) * 50} y={BAND_Y + 14 + Math.floor(p / 2) * 32} width={46} height={24} rx={4}
              fill={page === p ? COLORS.panelShadow : COLORS.panelRaised}
              stroke={page === p ? ACCENT : COLORS.panelEdge} strokeWidth={1.2} />
            <text x={49 + (p % 2) * 50} y={BAND_Y + 30 + Math.floor(p / 2) * 32} textAnchor="middle"
              fontFamily={FONT_CONDENSED} fontSize={9.5} fill={COLORS.legend}>
              {`${p * PAGE_CELLS + 1}–${p * PAGE_CELLS + PAGE_CELLS}`}
            </text>
          </g>
        ))}

        {/* end step */}
        <Knob def={END_DEF} value={seq.endStep} onInput={noop} onCommit={onEnd} accent={ACCENT}
          x={146} y={BAND_Y + 44} />

        {/* the 16 visible cells */}
        {Array.from({ length: PAGE_CELLS }, (_, i) => {
          const gi = page * PAGE_CELLS + i;
          const step = seq.steps[gi];
          if (!step) return null;
          return (
            <StepCell
              key={gi}
              step={step}
              globalIndex={gi}
              selected={gi === selected}
              active={running && pos === gi}
              beyondEnd={gi >= seq.endStep}
              onClick={onCellClick}
            />
          );
        })}

        {/* selected-step caption doubles as the arrow-key live region (role=status + aria-live
            announces the new step + note on every arrow edit/navigation). */}
        <text x={26} y={EDIT_Y + 4} fontFamily={FONT_CONDENSED} fontSize={10} letterSpacing={1.5}
          fill={COLORS.legendDim} role="status" aria-live="polite">
          {`STEP ${selected + 1} · ${sel.rest ? 'REST' : sel.noteVv < 0 ? 'EMPTY' : noteName(sel.noteVv)}` +
            (selLockCount > 0 ? ` · ${selLockCount} LOCK${selLockCount > 1 ? 'S' : ''}` : '')}
        </text>

        <Knob def={NOTE_DEF} value={Math.round(sel.noteVv * 12)} onInput={noop} onCommit={onNote}
          accent={ACCENT} x={CELL_X0} y={EDIT_Y} />
        <Knob def={GATE_DEF} value={sel.gateLength} onInput={noop} onCommit={onGate}
          accent={ACCENT} x={CELL_X0 + 70} y={EDIT_Y} />
        <Button def={REST_DEF} value={sel.rest ? 'ON' : 'OFF'} lit={sel.rest}
          onChange={() => editStep({ rest: !sel.rest })} x={CELL_X0 + 144} y={EDIT_Y} />
        <Button def={GLIDE_DEF} value={sel.glide ? 'ON' : 'OFF'} lit={sel.glide}
          onChange={() => editStep({ glide: !sel.glide })} x={CELL_X0 + 210} y={EDIT_Y} />
        <Button def={TIE_DEF} value={selTie ? 'ON' : 'OFF'} lit={selTie}
          onChange={onTie} x={CELL_X0 + 276} y={EDIT_Y} />

        {/* per-step PROBABILITY — note-prob (step sounds) + gate-prob (gate fires given it sounds).
            In the gap between TIE and the transport cluster (which shifts +112 to clear them). */}
        <Knob def={NOTE_PROB_DEF} value={sel.noteProb} onInput={noop} onCommit={onNoteProb}
          accent={ACCENT} x={CELL_X0 + 320} y={EDIT_Y} />
        <Knob def={GATE_PROB_DEF} value={sel.gateProb} onInput={noop} onCommit={onGateProb}
          accent={ACCENT} x={CELL_X0 + 374} y={EDIT_Y} />

        {/* per-strip transport (Courier has no panel transport): PLAY/STOP + RESET + REC. */}
        <Button def={PLAY_DEF} value={running ? 'ON' : 'OFF'} lit={running} momentary
          onChange={(p) => { if (p === 'ON') togglePlay(); }} x={CELL_X0 + 484} y={EDIT_Y} />
        <Button def={RESET_DEF} value="OFF" momentary
          onChange={(p) => { if (p === 'ON') courierReset(); }} x={CELL_X0 + 550} y={EDIT_Y} />
        {/* REC — step/live record arm. While lit, keyboard/MIDI notes (with Courier as the
            keyboard target) write the selected cell and advance it. */}
        <Button def={REC_DEF} value={armed ? 'ON' : 'OFF'} lit={armed}
          onChange={(p) => setArmed(p === 'ON')} x={CELL_X0 + 616} y={EDIT_Y} />

        {/* ===== armed-param LOCK-VALUE editor (only while a matrix slot is armed) =====
            Reuses the full Knob ergonomics stack (drag/fine-Shift/wheel/+−/dbl-click-default)
            seeded from the param's ControlDef; onCommit merge-writes the lock on the selected
            step. CLR deletes the armed key (canonicalizing an emptied map to null). */}
        {armedParam && armedDef && (
          <g data-testid="courier-lock-editor">
            <text x={CELL_X0 + 686} y={EDIT_Y - 28} textAnchor="middle" fontFamily={FONT_CONDENSED}
              fontSize={9} letterSpacing={1} fill={ACCENT}>
              {`LOCK · ${armedCap}`}
            </text>
            <Knob def={armedDef} value={armedLockValue} onInput={noop}
              onCommit={(v) => setLockValue(armedParam, v)} accent={ACCENT}
              x={CELL_X0 + 686} y={EDIT_Y} />
            <Button def={CLR_DEF} value="OFF" momentary
              onChange={(p) => { if (p === 'ON') clearLockValue(armedParam); }}
              x={CELL_X0 + 752} y={EDIT_Y} />
          </g>
        )}

        {/* ===== PARAM-RECORD MATRIX (18-slot 9×2 grid) =====
            Arm a lockable param, then author its per-step value with the lock-value knob above.
            All 18 slots are wired from the shared COURIER_LOCKABLE allow-list (cannot drift from
            the engine binder): the six mod targets (slots 0-5) plus twelve lock-only continuous
            controls (slots 6-17). The disabled-placeholder branch below is a no-op safety net for
            any future short list. A burnt-orange dot overlays any wired slot the SELECTED step
            locks. */}
        <text x={26} y={MATRIX_Y - 16} fontFamily={FONT_CONDENSED} fontSize={10} letterSpacing={1.5}
          fill={COLORS.legendDim}>
          PARAM REC
        </text>
        {Array.from({ length: MATRIX_SLOTS }, (_, i) => {
          const entry = COURIER_LOCKABLE[i];
          const sx = matrixSlotX(i);
          const sy = matrixSlotY(i);
          if (!entry) {
            // disabled placeholder slot (forward-compatible layout for part 2)
            return (
              <g key={`ph-${i}`} data-testid={`courier-matrix-empty-${i}`} opacity={0.25}>
                <rect x={sx - 16} y={sy - 9} width={32} height={18} rx={4}
                  fill={COLORS.panel} stroke={COLORS.panelEdge} strokeWidth={1} strokeDasharray="2 2" />
              </g>
            );
          }
          const id = entry.controlId;
          const isArmed = armedParam === id;
          const stepLocks = sel.lock?.[id] != null;
          return (
            <g key={id} data-testid={`courier-matrix-${id}`}>
              <Button def={mkToggle(id, entry.cap)} value={isArmed ? 'ON' : 'OFF'} lit={isArmed}
                onChange={() => setArmedParam((p) => (p === id ? null : id))} x={sx} y={sy} />
              {/* "this param is locked on the SELECTED step" dot — distinct from the arm LED. */}
              {stepLocks && (
                <circle data-testid={`courier-matrix-locked-${id}`} cx={sx + 13} cy={sy - 9} r={3}
                  fill={ACCENT} stroke={COLORS.panelShadow} strokeWidth={0.75} />
              )}
            </g>
          );
        })}

        {/* ===== GLOBAL SEQUENCER SETTINGS row (Phase C MVP) =====
            TEMPO (control store), CLOCK DIV / LENGTH / GATE LENGTH / SWING / SEQ MODE / ARP MODE
            (the seq slice). Rendered from the data/courier.json defs (single source of truth). */}
        <text x={26} y={SET_Y - 22} fontFamily={FONT_CONDENSED} fontSize={10} letterSpacing={1.5}
          fill={COLORS.legendDim}>
          SEQUENCER
        </text>
        <TempoKnob x={40} y={SET_Y} />
        {/* CLOCK DIV — cycling positions button; index <-> COURIER_CLOCK_DIVS via seq.clockDivIdx */}
        <Button def={seqDef('COU_CLOCK_DIV')} value={clockDivPos} lit={false}
          onChange={onClockDiv} x={130} y={SET_Y} />
        <Knob def={seqDef('COU_SEQ_LENGTH')} value={settings.endStep} onInput={noop} onCommit={onLength}
          accent={ACCENT} x={210} y={SET_Y} />
        <Knob def={seqDef('COU_GATE_LENGTH')} value={settings.gateLenScale} onInput={noop} onCommit={onGateScale}
          accent={ACCENT} x={290} y={SET_Y} />
        <Knob def={seqDef('COU_SWING')} value={settings.swingPct} onInput={noop} onCommit={onSwing}
          accent={ACCENT} x={370} y={SET_Y} />
        <Switch def={seqDef('COU_SEQ_MODE')} value={settings.mode} onChange={onSeqMode}
          x={460} y={SET_Y} />
        {/* ARP MODE — display label <-> underscored state value via the ARP_*_TO_* tables. */}
        <Switch def={seqDef('COU_ARP_MODE')} value={arpModePos} onChange={onArpMode}
          x={560} y={SET_Y} />
        {/* ARP OCTAVE (stepped 1..4) + ARP RHYTHM (the arp's own clock division). */}
        <Knob def={seqDef('COU_ARP_OCTAVE')} value={settings.arpOctave} onInput={noop} onCommit={onArpOctave}
          accent={ACCENT} x={660} y={SET_Y} />
        <Button def={seqDef('COU_ARP_RHYTHM')} value={arpRhythmPos} lit={false}
          onChange={onArpRhythm} x={740} y={SET_Y} />
      </g>
    </svg>
  );
});
