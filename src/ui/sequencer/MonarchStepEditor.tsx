/**
 * Monarch step editor: 32 steps in 4 pages of 8. Since the
 * 16:9 redesign this is its OWN strip panel (stage region seqStrip,
 * 687.63 × 158.8 — shifted over to the left of the Monarch column), no longer a
 * band inside the Monarch panel SVG.
 *
 * Interaction: click a cell to SELECT it; click the
 * already-selected cell to toggle REST (click-to-rest, made non-destructive
 * for plain selection); Shift-click toggles ACCENT anywhere. The selected step is
 * edited with the NOTE/GATE knobs and ACCENT/GLIDE/RATCHET/REST buttons below —
 * a per-step popover, kept simple, rendered as a fixed strip.
 *
 * All edits are single store commits via the bridge; Studio.syncTransportConfig
 * pushes the transport slice into the live sequencer.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import type { ControlDef } from '../../../data/schema';
import type { MonarchStepState } from '../../state/studioState';
import { COLORS, FONT_CONDENSED } from '../theme';
import { REGIONS } from '../stage16x9';
import { Knob } from '../controls/Knob';
import { Button } from '../controls/Button';
import { StepLed } from '../controls/StepLed';
import { engineBridge } from '../engineBridge';
import { useStepPosition, useTransportFlags } from '../useStudio';
import { keyToMonarchAction, nextNoteSemis, nextSelection } from './monarchKeyNav';

/** Strip-local origin (the old in-panel band offset is gone). */
const BAND_Y = 6;
const CELL_X0 = 200;
const CELL_PITCH = 60;
const CELL_W = 52;
const CELL_H = 60;
const CELL_Y = BAND_Y + 18;
const LED_Y = BAND_Y + 8;
const EDIT_Y = BAND_Y + 106;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** noteVv (1 vv/oct, 0 = C4) -> display like "C3", "A#2". */
function noteName(noteVv: number): string {
  const semis = Math.round(noteVv * 12);
  const idx = ((semis % 12) + 12) % 12;
  const oct = 4 + Math.floor(semis / 12);
  return `${NOTE_NAMES[idx]}${oct}`;
}

const NOTE_DEF: ControlDef = {
  id: 'MON_STEP_NOTE', panelLabel: 'NOTE', type: 'stepKnob',
  min: -24, max: 24, default: -12, taper: 'stepped', steps: 49, unit: 'st',
};
const GATE_DEF: ControlDef = {
  id: 'MON_STEP_GATE', panelLabel: 'GATE LEN', type: 'knob',
  min: 0.05, max: 1, default: 0.5, taper: 'lin',
};
const END_DEF: ControlDef = {
  id: 'MON_END_STEP', panelLabel: 'END STEP', type: 'stepKnob',
  min: 1, max: 32, default: 16, taper: 'stepped', steps: 32, unit: 'step',
};
const RATCHET_DEF: ControlDef = {
  id: 'MON_STEP_RATCHET', panelLabel: 'RATCHET', type: 'button', positions: ['1', '2', '3', '4'],
};
const mkToggle = (id: string, label: string): ControlDef => ({
  id, panelLabel: label, type: 'button', positions: ['OFF', 'ON'],
});
const REST_DEF = mkToggle('MON_STEP_REST', 'REST');
const ACCENT_DEF = mkToggle('MON_STEP_ACCENT', 'ACCENT');
const GLIDE_DEF = mkToggle('MON_STEP_GLIDE', 'GLIDE');
const REC_DEF = mkToggle('MON_REC', 'REC');

function readSeq(): { steps: MonarchStepState[]; endStep: number } {
  const t = engineBridge.store.getState().transport.monarch;
  return { steps: t.steps, endStep: t.endStep };
}

function StepCell({
  step, globalIndex, selected, active, beyondEnd, onClick,
}: {
  step: MonarchStepState;
  globalIndex: number;
  selected: boolean;
  active: boolean;
  beyondEnd: boolean;
  onClick: (index: number, shift: boolean) => void;
}) {
  const x = CELL_X0 + (globalIndex % 8) * CELL_PITCH;
  const handle = (e: ReactMouseEvent<SVGGElement>) => onClick(globalIndex, e.shiftKey);
  const tie = step.gateLength >= 1 && step.ratchet === 1;
  return (
    <g className="control" data-testid={`monarch-cell-${globalIndex}`} onClick={handle} opacity={beyondEnd ? 0.35 : 1}>
      <StepLed x={x + CELL_W / 2} y={LED_Y} on={active} />
      <rect
        x={x} y={CELL_Y} width={CELL_W} height={CELL_H} rx={4}
        fill={step.rest ? COLORS.panelShadow : COLORS.panelRaised}
        stroke={selected ? COLORS.ledAmber : COLORS.panelEdge}
        strokeWidth={selected ? 1.8 : 1}
      />
      <text
        x={x + CELL_W / 2} y={CELL_Y + 18} textAnchor="middle"
        fontFamily={FONT_CONDENSED} fontSize={12}
        fill={step.rest ? COLORS.legendDim : COLORS.legend}
      >
        {step.rest ? '·' : noteName(step.noteVv)}
      </text>
      {/* gate-length bar (T = tie) */}
      <rect x={x + 6} y={CELL_Y + 26} width={(CELL_W - 12) * Math.min(step.gateLength, 1)} height={4} rx={2}
        fill={tie ? COLORS.ledAmber : COLORS.knob} opacity={step.rest ? 0.25 : 0.9} />
      <text x={x + CELL_W / 2} y={CELL_Y + 48} textAnchor="middle" fontFamily={FONT_CONDENSED}
        fontSize={8.5} letterSpacing={0.5} fill={COLORS.legendDim}>
        {[
          step.accent ? 'AC' : null,
          step.glide ? 'GL' : null,
          step.ratchet > 1 ? `x${step.ratchet}` : null,
          tie ? 'TIE' : null,
        ].filter(Boolean).join(' ') || `${globalIndex + 1}`}
      </text>
    </g>
  );
}

export const MonarchStepEditor = memo(function MonarchStepEditor() {
  const [seq, setSeq] = useState(readSeq);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState(0);
  const [armed, setArmed] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);
  const pos = useStepPosition('monarch');
  const { monarchRunning } = useTransportFlags();

  useEffect(() => {
    let last = JSON.stringify(readSeq());
    return engineBridge.store.subscribe(() => {
      const next = readSeq();
      const key = JSON.stringify(next);
      if (key !== last) {
        last = key;
        setSeq(next);
      }
    });
  }, []);

  // Step-record: while REC is armed, register a handler the bridge calls on every keyboard /
  // MIDI note ON — it writes the cursor (selected) step + advances the cursor (wrapping at
  // END STEP), so playing the keyboard fills the pattern. Refs keep the handler reading the
  // LIVE cursor/end without re-registering on every move; the effect re-runs only on arm.
  const selectedRef = useRef(selected);
  const endStepRef = useRef(seq.endStep);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  useEffect(() => {
    endStepRef.current = seq.endStep;
  }, [seq.endStep]);
  useEffect(() => {
    if (!armed) return;
    engineBridge.setMonarchRecordHandler((noteVv) => {
      const cur = selectedRef.current;
      engineBridge.updateMonarchStep(cur, { noteVv, rest: false });
      const next = (cur + 1) % Math.max(1, endStepRef.current);
      setSelected(next);
      setPage(Math.floor(next / 8)); // follow the cursor onto the next page
    });
    return () => engineBridge.setMonarchRecordHandler(null);
  }, [armed]);

  const onCellClick = useCallback(
    (index: number, shift: boolean) => {
      const step = readSeq().steps[index]!;
      if (shift) {
        engineBridge.updateMonarchStep(index, { accent: !step.accent });
      } else if (index === selected) {
        engineBridge.updateMonarchStep(index, { rest: !step.rest }); // click-to-rest
      }
      setSelected(index);
      svgRef.current?.focus(); // focus the editor so arrows edit immediately
    },
    [selected],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<SVGSVGElement>) => {
      // CRITICAL bubbling guard: a focused child Knob/Button already handled this
      // arrow (its own onKeyDown preventDefault'd but did NOT stopPropagation), so it
      // bubbles here. Only the editor SVG itself acts — never double-edit a child key.
      if (e.target !== e.currentTarget) return;
      const action = keyToMonarchAction(e.key, e.shiftKey);
      if (!action) return; // non-arrow keys fall through untouched (Tab etc.)
      e.preventDefault(); // handled arrows never scroll the page
      if (action.kind === 'note') {
        const steps = readSeq().steps;
        const cur = Math.round((steps[selected] ?? steps[0]!).noteVv * 12);
        engineBridge.updateMonarchStep(selected, { noteVv: nextNoteSemis(cur, action.delta) / 12 });
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
    (patch: Partial<MonarchStepState>) => engineBridge.updateMonarchStep(selected, patch),
    [selected],
  );
  const noop = useCallback(() => undefined, []);
  const onNote = useCallback((v: number) => editStep({ noteVv: Math.round(v) / 12 }), [editStep]);
  const onGate = useCallback((v: number) => editStep({ gateLength: v }), [editStep]);
  const onEnd = useCallback((v: number) => engineBridge.setMonarchEndStep(v), []);

  return (
    <svg
      ref={svgRef}
      className="panel"
      viewBox={`0 0 ${REGIONS.seqStrip.w} ${REGIONS.seqStrip.h}`}
      xmlns="http://www.w3.org/2000/svg"
      role="group"
      aria-label="Monarch step editor"
      aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Shift+ArrowUp Shift+ArrowDown"
      data-testid="monarch-step-editor-svg"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      {/* strip face */}
      <rect
        x={0.5}
        y={0.5}
        width={REGIONS.seqStrip.w - 1}
        height={REGIONS.seqStrip.h - 1}
        rx={8}
        fill={COLORS.panel}
        stroke={COLORS.panelEdge}
        strokeWidth={1.5}
      />

      <g data-testid="monarch-step-editor">
      {/* strip caption — bottom-right corner, clear of the edit-row buttons */}
      <text
        x={REGIONS.seqStrip.w - 10}
        y={REGIONS.seqStrip.h - 7}
        textAnchor="end"
        fontFamily={FONT_CONDENSED}
        fontSize={10}
        letterSpacing={1.5}
        fill={COLORS.legendDim}
      >
        MONARCH · STEP EDITOR
      </text>

      {/* page tabs */}
      {[0, 1, 2, 3].map((p) => (
        <g key={p} className="control" onClick={() => setPage(p)} data-testid={`monarch-page-${p}`}>
          <rect x={26 + (p % 2) * 46} y={BAND_Y + 14 + Math.floor(p / 2) * 32} width={42} height={24} rx={4}
            fill={page === p ? COLORS.panelShadow : COLORS.panelRaised}
            stroke={page === p ? COLORS.ledAmber : COLORS.panelEdge} strokeWidth={1.2} />
          <text x={47 + (p % 2) * 46} y={BAND_Y + 30 + Math.floor(p / 2) * 32} textAnchor="middle"
            fontFamily={FONT_CONDENSED} fontSize={9.5} fill={COLORS.legend}>
            {`${p * 8 + 1}–${p * 8 + 8}`}
          </text>
        </g>
      ))}

      {/* end step */}
      <Knob def={END_DEF} value={seq.endStep} onInput={noop} onCommit={onEnd} x={146} y={BAND_Y + 40} />

      {/* the 8 visible cells */}
      {Array.from({ length: 8 }, (_, i) => {
        const gi = page * 8 + i;
        return (
          <StepCell
            key={gi}
            step={seq.steps[gi]!}
            globalIndex={gi}
            selected={gi === selected}
            active={monarchRunning && pos === gi}
            beyondEnd={gi >= seq.endStep}
            onClick={onCellClick}
          />
        );
      })}

      {/* selected-step strip */}
      {/* Selected-step caption doubles as the arrow-key live region: role=status +
          aria-live announces the new step + note to assistive tech on every arrow
          edit/navigation (the note name is also a nice visible readout). */}
      <text x={26} y={EDIT_Y + 4} fontFamily={FONT_CONDENSED} fontSize={10} letterSpacing={1.5}
        fill={COLORS.legendDim} role="status" aria-live="polite">
        {`STEP ${selected + 1} · ${sel.rest ? 'REST' : noteName(sel.noteVv)}`}
      </text>
      <Knob def={NOTE_DEF} value={Math.round(sel.noteVv * 12)} onInput={noop} onCommit={onNote}
        x={CELL_X0} y={EDIT_Y} />
      <Knob def={GATE_DEF} value={sel.gateLength} onInput={noop} onCommit={onGate}
        x={CELL_X0 + 70} y={EDIT_Y} />
      <Button def={ACCENT_DEF} value={sel.accent ? 'ON' : 'OFF'} lit={sel.accent}
        onChange={() => editStep({ accent: !sel.accent })} x={CELL_X0 + 144} y={EDIT_Y} />
      <Button def={GLIDE_DEF} value={sel.glide ? 'ON' : 'OFF'} lit={sel.glide}
        onChange={() => editStep({ glide: !sel.glide })} x={CELL_X0 + 210} y={EDIT_Y} />
      <Button def={RATCHET_DEF} value={String(sel.ratchet)} lit={sel.ratchet > 1}
        onChange={(p) => editStep({ ratchet: Number(p) as MonarchStepState['ratchet'] })}
        x={CELL_X0 + 276} y={EDIT_Y} />
      <Button def={REST_DEF} value={sel.rest ? 'ON' : 'OFF'} lit={sel.rest}
        onChange={() => editStep({ rest: !sel.rest })} x={CELL_X0 + 342} y={EDIT_Y} />
      {/* REC — step-record arm. While lit, keyboard/MIDI notes write the selected cell
          and advance it (the amber cursor IS the write position). */}
      <Button def={REC_DEF} value={armed ? 'ON' : 'OFF'} lit={armed}
        onChange={(p) => setArmed(p === 'ON')} x={CELL_X0 + 408} y={EDIT_Y} />
      </g>
    </svg>
  );
});
