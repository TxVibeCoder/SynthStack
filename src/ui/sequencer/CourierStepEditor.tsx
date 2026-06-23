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
import type { CourierStepState } from '../../state/studioState';
import { COLORS, FONT_CONDENSED, GROUP_BORDER } from '../theme';
import { Knob } from '../controls/Knob';
import { Switch } from '../controls/Switch';
import { Button } from '../controls/Button';
import { StepLed } from '../controls/StepLed';
import { useControl } from '../useStudio';
import { COURIER_CLOCK_DIVS } from '../../engine/sequencers/courierSeq';
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

/** Courier-local strip canvas — App.tsx reads this aspect to frame the seq region. */
export const COURIER_SEQ_STRIP = { w: 1300, h: 252 } as const;

/** Strip geometry: one row of 16 cells per page across the wide canvas. */
const BAND_Y = 6;
const CELL_X0 = 200;
const CELL_PITCH = 66; // (1300 - 200 - ~44 margin) / 16 ≈ 66
const CELL_W = 56;
const CELL_H = 60;
const CELL_Y = BAND_Y + 18;
const LED_Y = BAND_Y + 8;
const EDIT_Y = BAND_Y + 116;
/** Global sequencer SETTINGS row, beneath the per-step edit row. */
const SET_Y = BAND_Y + 196;

const PAGE_CELLS = 16;
const ACCENT = GROUP_BORDER.courier;

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

/** A step counts as a TIE when its gate length reaches/exceeds 1 (no separate field in MVP). */
function isTie(step: CourierStepState): boolean {
  return step.gateLength >= 1;
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
  // -1 noteVv == unauthored (rest-like blank). Show a dash; rests show the rest glyph.
  const blank = step.noteVv < 0 && !step.rest;
  return (
    <g className="control" data-testid={`courier-cell-${globalIndex}`} onClick={handle} opacity={beyondEnd ? 0.35 : 1}>
      <StepLed x={x + CELL_W / 2} y={LED_Y} on={active} />
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

  // TIE toggles the gate length to its tie value (>=1) / back to a normal sustain (0.5).
  const selTie = isTie(sel);
  const onTie = useCallback(() => editStep({ gateLength: selTie ? 0.5 : 1 }), [editStep, selTie]);

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
    (pos: string) => setCourierSeqField('arpMode', pos === 'UP' ? 'UP' : pos === 'DOWN' ? 'DOWN' : 'OFF'),
    [],
  );
  const clockDivPos = COURIER_CLOCK_DIVS[settings.clockDivIdx] ?? '1/16';

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
          {`STEP ${selected + 1} · ${sel.rest ? 'REST' : sel.noteVv < 0 ? 'EMPTY' : noteName(sel.noteVv)}`}
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

        {/* per-strip transport (Courier has no panel transport): PLAY/STOP + RESET + REC. */}
        <Button def={PLAY_DEF} value={running ? 'ON' : 'OFF'} lit={running} momentary
          onChange={(p) => { if (p === 'ON') togglePlay(); }} x={CELL_X0 + 372} y={EDIT_Y} />
        <Button def={RESET_DEF} value="OFF" momentary
          onChange={(p) => { if (p === 'ON') courierReset(); }} x={CELL_X0 + 438} y={EDIT_Y} />
        {/* REC — step/live record arm. While lit, keyboard/MIDI notes (with Courier as the
            keyboard target) write the selected cell and advance it. */}
        <Button def={REC_DEF} value={armed ? 'ON' : 'OFF'} lit={armed}
          onChange={(p) => setArmed(p === 'ON')} x={CELL_X0 + 504} y={EDIT_Y} />

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
        <Switch def={seqDef('COU_ARP_MODE')} value={settings.arpMode} onChange={onArpMode}
          x={560} y={SET_Y} />
      </g>
    </svg>
  );
});
