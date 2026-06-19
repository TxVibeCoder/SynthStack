/**
 * Monarch panel — CONTROLS-ONLY since the 16:9 redesign: its 32 jacks live in
 * panels/JackFieldPanel.tsx and the 32-step editor in its own strip panel
 * (src/ui/sequencer/MonarchStepEditor.tsx, rendered by App.tsx in the seq-strip
 * region).
 *
 * Renders one <svg> (viewBox = the stage region, 1:1 px) from monarchLayout +
 * data/monarch.json: background, section frames with titled legends, every
 * control at its layout position by type.
 *
 * Data flow (CONVENTIONS.md): each control sits in its own
 * memoized subcomponent subscribed via useControl('monarch', id) — a store
 * write or knob drag re-renders ONLY that control, never the panel. Knobs:
 * onInput -> bridge applyControlInput (immediate engine write, no store);
 * onCommit -> applyControlCommit (one store commit). Switches and latching
 * buttons commit immediately. Plain transport buttons (no def.positions:
 * RUN/STOP, RESET, HOLD) render momentary and call the bridge's dedicated
 * transport methods — they never go through applyControlInput.
 *
 * Styling: plain-text functional title, original typography — no logos
 * or trade dress.
 */

import { memo } from 'react';
import type { ReactElement } from 'react';
import type { ControlDef, ModuleDef } from '../../../data/schema';
import type { KnobSize, PanelSection } from '../types';
import { COLORS, FONT_CONDENSED, GROUP_BORDER } from '../theme';
import { Knob } from '../controls/Knob';
import { Switch } from '../controls/Switch';
import { Button } from '../controls/Button';
import { engineBridge } from '../engineBridge';
import { useControl, useTransportFlags } from '../useStudio';
import { monarchLayout } from './monarchLayout';
import monarchJson from '../../../data/monarch.json';

const MODULE_ID = 'monarch';
const moduleDef = monarchJson as unknown as ModuleDef;
/** Per-machine identity color (matches the patchbay group border + tab). */
const ACCENT = GROUP_BORDER.monarch;

// ---- per-control-type subcomponents (each memoized; each re-renders alone) -------------

/** knob / stepKnob — store value (JSON default fallback), engine-only writes mid-drag. */
const PanelKnob = memo(function PanelKnob({
  def,
  x,
  y,
  size,
}: {
  def: ControlDef;
  x: number;
  y: number;
  size?: KnobSize;
}) {
  const fallback = typeof def.default === 'number' ? def.default : (def.min ?? 0);
  const [value, onInput, onCommit] = useControl<number>(MODULE_ID, def.id, fallback);
  return (
    <Knob def={def} value={value} onInput={onInput} onCommit={onCommit} size={size} accent={ACCENT} x={x} y={y} />
  );
});

/** switch — discrete: onChange lands engine write + store commit together (no debounce). */
const PanelSwitch = memo(function PanelSwitch({
  def,
  x,
  y,
}: {
  def: ControlDef;
  x: number;
  y: number;
}) {
  const fallback = typeof def.default === 'string' ? def.default : (def.positions?.[0] ?? '');
  const [value, , onCommit] = useControl<string>(MODULE_ID, def.id, fallback);
  return <Switch def={def} value={value} onChange={onCommit} x={x} y={y} />;
});

/** button WITH def.positions — latching state-cycler, committed like a switch. */
const LatchingButton = memo(function LatchingButton({
  def,
  x,
  y,
}: {
  def: ControlDef;
  x: number;
  y: number;
}) {
  const fallback = typeof def.default === 'string' ? def.default : (def.positions?.[0] ?? '');
  const [value, , onCommit] = useControl<string>(MODULE_ID, def.id, fallback);
  return <Button def={def} value={value} onChange={onCommit} x={x} y={y} />;
});

/**
 * Plain transport button (no def.positions) -> matching bridge transport action.
 * Rendered momentary: Button fires onChange('ON') on pointerdown, 'OFF' on release.
 */
function transportAction(controlId: string, down: boolean): void {
  switch (controlId) {
    case 'MON_RUN_STOP': // toggles run/stop on press; release ignored
      if (down) {
        if (engineBridge.getTransportFlags().monarchRunning) engineBridge.monarchStop();
        else engineBridge.monarchRun();
      }
      return;
    case 'MON_RESET': // one-shot on press
      if (down) engineBridge.monarchReset();
      return;
    case 'MON_HOLD': // held while pressed
      engineBridge.monarchHold(down);
      return;
    default:
      return;
  }
}

const TransportButton = memo(function TransportButton({
  def,
  x,
  y,
}: {
  def: ControlDef;
  x: number;
  y: number;
}) {
  // Poll-driven lamp (bails out between transitions); RUN/STOP is the only lit one.
  const flags = useTransportFlags();
  const isRunStop = def.id === 'MON_RUN_STOP';
  return (
    <Button
      def={def}
      value={isRunStop && flags.monarchRunning ? 'ON' : 'OFF'}
      lit={isRunStop ? flags.monarchRunning : undefined}
      momentary
      onChange={(pos) => transportAction(def.id, pos === 'ON')}
      x={x}
      y={y}
    />
  );
});

// ---- static panel furniture -------------------------------------------------------------

/** Section frame: rounded rect with its legend sitting in a gap in the top border. */
function SectionFrame({ s }: { s: PanelSection }) {
  const label = s.label.toUpperCase();
  // Approximate condensed-cap advance (~6.4u) + letter-spacing (1.5u) per char.
  const gapW = label.length * 7.9 + 12;
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
      {/* mask a gap in the top border for the legend to sit in */}
      <rect x={s.x + 10} y={s.y - 1.5} width={gapW} height={3} fill={COLORS.panel} />
      <text
        x={s.x + 16}
        y={s.y + 4.5}
        fontFamily={FONT_CONDENSED}
        fontSize={13}
        letterSpacing={1.5}
        fill={COLORS.legend}
      >
        {label}
      </text>
    </g>
  );
}

/** Dispatch one ControlDef to its subcomponent at its layout position. */
function controlNode(def: ControlDef): ReactElement | null {
  const pos = monarchLayout.controls[def.id];
  if (!pos) return null;
  switch (def.type) {
    case 'knob':
    case 'stepKnob':
      return <PanelKnob key={def.id} def={def} x={pos.x} y={pos.y} size={pos.size} />;
    case 'switch':
      return <PanelSwitch key={def.id} def={def} x={pos.x} y={pos.y} />;
    case 'button':
      return def.positions != null && def.positions.length > 0 ? (
        <LatchingButton key={def.id} def={def} x={pos.x} y={pos.y} />
      ) : (
        <TransportButton key={def.id} def={def} x={pos.x} y={pos.y} />
      );
    default:
      return null;
  }
}

// ---- panel ------------------------------------------------------------------------------

export const MonarchPanel = memo(function MonarchPanel() {
  return (
    <svg
      className="panel"
      viewBox={`0 0 ${monarchLayout.width} ${monarchLayout.height}`}
      xmlns="http://www.w3.org/2000/svg"
      role="group"
      aria-label={`${monarchLayout.title} panel`}
    >
      {/* panel face */}
      <rect
        width={monarchLayout.width}
        height={monarchLayout.height}
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
        {monarchLayout.title.toUpperCase()}
      </text>

      {/* section frames + legends */}
      {monarchLayout.sections.map((s) => (
        <SectionFrame key={s.label} s={s} />
      ))}

      {/* controls (each its own memoized subscriber) */}
      {moduleDef.controls.map(controlNode)}
    </svg>
  );
});
