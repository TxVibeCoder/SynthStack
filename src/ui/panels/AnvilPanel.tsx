/**
 * Anvil panel — CONTROLS-ONLY since the 16:9 redesign (its 24 jacks live in
 * panels/JackFieldPanel.tsx). Renders every control in data/anvil.json at its
 * anvilLayout position inside one SVG (viewBox = the stage region, 1:1 px).
 *
 * Data flow (CONVENTIONS.md): each control is a small memoized
 * subcomponent subscribing to ITS value via useControl('anvil', id) — knob drags hit
 * the engine imperatively through onInput and commit the store once on release;
 * switches and state-cycling buttons commit immediately; plain transport buttons
 * (no def.positions) are momentary and call the bridge's transport actions
 * (ANV_RUN_STOP toggles run/stop, ANV_ADVANCE/ANV_TRIGGER fire on press).
 *
 * The 8 step LEDs chase from the scheduler uiQueue via rAF, never store
 * writes.
 */

import { memo } from 'react';
import type { ControlDef, ModuleDef } from '../../../data/schema';
import anvilJson from '../../../data/anvil.json';
import { COLORS, FONT_CONDENSED, GROUP_BORDER } from '../theme';
import type { KnobSize, PanelSection } from '../types';
import { Knob } from '../controls/Knob';
import { Switch } from '../controls/Switch';
import { Button } from '../controls/Button';
import { StepLed } from '../controls/StepLed';
import { useControl, useStepPosition, useTransportFlags } from '../useStudio';
import { engineBridge } from '../engineBridge';
import { anvilLayout, SEQ_LED_Y } from './anvilLayout';

const MODULE_ID = 'anvil';
const anvilDef = anvilJson as unknown as ModuleDef;
/** Per-machine identity color (matches the patchbay group border + tab). */
const ACCENT = GROUP_BORDER.anvil;

// ---- value fallbacks (store value wins; JSON default otherwise) -----------------------

function numericDefault(def: ControlDef): number {
  return typeof def.default === 'number' ? def.default : 0;
}

function positionDefault(def: ControlDef): string {
  if (typeof def.default === 'string') return def.default;
  return def.positions?.[0] ?? 'OFF';
}

// ---- transport actions (plain buttons without def.positions; fire on press) -----------

const TRANSPORT_ACTIONS: Record<string, () => void> = {
  ANV_RUN_STOP: () => {
    if (engineBridge.getTransportFlags().anvilRunning) engineBridge.anvilStop();
    else engineBridge.anvilRun();
  },
  ANV_ADVANCE: () => engineBridge.anvilAdvance(), // stopped: one step, no trigger
  ANV_TRIGGER: () => engineBridge.anvilTrigger(), // stopped: fire step, no advance
};

// ---- one memoized subcomponent per control type ----------------------------------------
// A drag/click re-renders only the touched control: useControl snapshots are primitives
// (Object.is bailout) and the parent panel is stateless, so it never re-renders.

interface PlacedControl {
  def: ControlDef;
  x: number;
  y: number;
}

/** knob / stepKnob — onInput = immediate engine write, onCommit = one store write. */
const PanelKnob = memo(function PanelKnob({
  def,
  x,
  y,
  size,
}: PlacedControl & { size?: KnobSize }) {
  const [value, onInput, onCommit] = useControl<number>(MODULE_ID, def.id, numericDefault(def));
  return (
    <Knob def={def} value={value} onInput={onInput} onCommit={onCommit} size={size} accent={ACCENT} x={x} y={y} />
  );
});

/** switch — discrete: engine write + store commit together (no debounce). */
const PanelSwitch = memo(function PanelSwitch({ def, x, y }: PlacedControl) {
  const [value, , onCommit] = useControl<string>(MODULE_ID, def.id, positionDefault(def));
  return <Switch def={def} value={value} onChange={onCommit} x={x} y={y} />;
});

/** state-cycling button (has def.positions) — commits immediately, like a switch. */
const PanelLatchButton = memo(function PanelLatchButton({ def, x, y }: PlacedControl) {
  const [value, , onCommit] = useControl<string>(MODULE_ID, def.id, positionDefault(def));
  return <Button def={def} value={value} onChange={onCommit} x={x} y={y} />;
});

/** plain transport button — momentary cap; bridge action fires on the press edge. */
const TransportButton = memo(function TransportButton({ def, x, y }: PlacedControl) {
  const onChange = (pos: string) => {
    if (pos === 'ON') TRANSPORT_ACTIONS[def.id]?.(); // 'ON' = momentary active position
  };
  return <Button def={def} value="OFF" onChange={onChange} momentary x={x} y={y} />;
});

/** RUN/STOP — TransportButton plus the running lamp (polled transport flags). */
const RunStopButton = memo(function RunStopButton({ def, x, y }: PlacedControl) {
  const { anvilRunning } = useTransportFlags();
  const onChange = (pos: string) => {
    if (pos === 'ON') TRANSPORT_ACTIONS[def.id]?.();
  };
  return (
    <Button
      def={def}
      value={anvilRunning ? 'RUN' : 'STOP'}
      onChange={onChange}
      lit={anvilRunning}
      momentary
      x={x}
      y={y}
    />
  );
});

// ---- silkscreen ------------------------------------------------------------------------

/** ~viewBox width of a section legend at fontSize 13 condensed + 1.5 tracking. */
function legendWidth(label: string): number {
  return label.length * 8 + 10;
}

/** Section frame: 1-unit panelEdge rounded rect, legend sitting in a top-border gap. */
const SectionFrame = memo(function SectionFrame({ s }: { s: PanelSection }) {
  const labelX = s.x + 14;
  return (
    <g>
      <rect
        x={s.x}
        y={s.y}
        width={s.w}
        height={s.h}
        rx={6}
        fill="none"
        stroke={COLORS.panelEdge}
        strokeWidth={1}
      />
      {/* panel-colored mask cuts the gap in the top border for the legend */}
      <rect x={labelX - 5} y={s.y - 8} width={legendWidth(s.label)} height={16} fill={COLORS.panel} />
      <text
        x={labelX}
        y={s.y + 4.5}
        fontFamily={FONT_CONDENSED}
        fontSize={13}
        letterSpacing={1.5}
        fill={COLORS.legend}
      >
        {s.label.toUpperCase()}
      </text>
    </g>
  );
});

// ---- main export -----------------------------------------------------------------------

/** Step-LED chase row sits between the PITCH and VELOCITY rows (anvilLayout keeps it clear). */
const STEP_LED_Y = SEQ_LED_Y;

/** Chase row: lit at the playing step while running, ghost of the last step when stopped. */
const AnvilLedRow = memo(function AnvilLedRow() {
  const pos = useStepPosition('anvil');
  const { anvilRunning } = useTransportFlags();
  return (
    <g>
      {stepLedXs.map((x, i) => (
        <StepLed key={x} x={x} y={STEP_LED_Y} on={anvilRunning && i === pos} dim={!anvilRunning && i === pos} />
      ))}
    </g>
  );
});
const stepLedXs: number[] = [];
for (let i = 1; i <= 8; i += 1) {
  const p = anvilLayout.controls[`ANV_SEQ_PITCH_${i}`];
  if (p) stepLedXs.push(p.x);
}

function renderControl(def: ControlDef) {
  const pos = anvilLayout.controls[def.id];
  if (!pos) return null;
  switch (def.type) {
    case 'knob':
    case 'stepKnob':
      return <PanelKnob key={def.id} def={def} x={pos.x} y={pos.y} size={pos.size} />;
    case 'switch':
      return <PanelSwitch key={def.id} def={def} x={pos.x} y={pos.y} />;
    case 'button':
      if (def.positions != null && def.positions.length > 0) {
        return <PanelLatchButton key={def.id} def={def} x={pos.x} y={pos.y} />;
      }
      return def.id === 'ANV_RUN_STOP' ? (
        <RunStopButton key={def.id} def={def} x={pos.x} y={pos.y} />
      ) : (
        <TransportButton key={def.id} def={def} x={pos.x} y={pos.y} />
      );
  }
}

export function AnvilPanel() {
  return (
    <svg
      className="panel"
      viewBox={`0 0 ${anvilLayout.width} ${anvilLayout.height}`}
      role="group"
      aria-label={`${anvilLayout.title} panel`}
    >
      {/* panel face */}
      <rect
        x={0.5}
        y={0.5}
        width={anvilLayout.width - 1}
        height={anvilLayout.height - 1}
        rx={8}
        fill={COLORS.panel}
        stroke={ACCENT}
        strokeWidth={1.5}
      />

      {/* plain-text functional title, machine-tinted — no trade dress */}
      <text
        x={14}
        y={24}
        fontFamily={FONT_CONDENSED}
        fontSize={18}
        letterSpacing={2.5}
        fill={ACCENT}
      >
        {anvilLayout.title.toUpperCase()}
      </text>

      {anvilLayout.sections.map((s) => (
        <SectionFrame key={s.label} s={s} />
      ))}

      {/* step-LED chase row (stage 3: scheduler uiQueue -> rAF drain) */}
      <AnvilLedRow />

      {anvilDef.controls.map(renderControl)}
    </svg>
  );
}
