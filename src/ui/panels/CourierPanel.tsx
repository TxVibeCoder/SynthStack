/**
 * Courier panel — the densest voice control field, CONTROLS-ONLY (its jacks live
 * in panels/JackFieldPanel.tsx). One SVG, viewBox = courierLayout.width × height,
 * rendering every control from data/courier.json at its courierLayout position.
 *
 * Data flow (CONVENTIONS.md): each control sits in its own memoized subcomponent
 * subscribing via useControl('courier', id), so a store write re-renders only the
 * control it changed and a knob drag re-renders only the dragged knob (engine
 * writes ride applyControlInput imperatively; the single store commit lands on
 * release via applyControlCommit).
 *
 * Switches and buttons-with-positions latch/cycle through the store. Courier's
 * 64-step param-lock sequencer / arp is deferred to a later phase, so this panel
 * has NO transport buttons, tempo knob, or step-LED row — only knobs and switches.
 *
 * Styling: dark-panel / cream-legend, machine-tinted plain-text title — no trade
 * dress.
 */

import { memo } from 'react';
import type { ReactElement } from 'react';
import type { ControlDef, ModuleDef } from '../../../data/schema';
import courierJson from '../../../data/courier.json';
import { COLORS, FONT_CONDENSED, GROUP_BORDER } from '../theme';
import type { KnobSize, PanelSection } from '../types';
import { Knob } from '../controls/Knob';
import { Switch } from '../controls/Switch';
import { Button } from '../controls/Button';
import { useControl } from '../useStudio';
import { courierLayout } from './courierLayout';

const moduleDef = courierJson as unknown as ModuleDef;
const MODULE_ID = moduleDef.id; // 'courier'
/** Per-machine identity color (matches the patchbay group border + tab). */
const ACCENT = GROUP_BORDER.courier;

// ---- fallbacks (store value wins; JSON default otherwise) -------------------------------

function knobFallback(def: ControlDef): number {
  return typeof def.default === 'number' ? def.default : (def.min ?? 0);
}

function positionFallback(def: ControlDef): string {
  return typeof def.default === 'string' ? def.default : (def.positions?.[0] ?? 'OFF');
}

// ---- one memoized subcomponent per control type ------------------------------------------

interface PlacedKnobProps {
  def: ControlDef;
  x: number;
  y: number;
  size?: KnobSize;
}

interface PlacedProps {
  def: ControlDef;
  x: number;
  y: number;
}

/** knob / stepKnob: onInput -> immediate engine write, onCommit -> one store write. */
const PanelKnob = memo(function PanelKnob({ def, x, y, size }: PlacedKnobProps) {
  const [value, onInput, onCommit] = useControl<number>(MODULE_ID, def.id, knobFallback(def));
  return (
    <Knob def={def} value={value} onInput={onInput} onCommit={onCommit} size={size} accent={ACCENT} x={x} y={y} />
  );
});

/** switch: discrete — engine write + store commit together (no debounce). */
const PanelSwitch = memo(function PanelSwitch({ def, x, y }: PlacedProps) {
  const [value, , onCommit] = useControl<string>(MODULE_ID, def.id, positionFallback(def));
  return <Switch def={def} value={value} onChange={onCommit} x={x} y={y} />;
});

/** Latching button (def.positions): click cycles, commits immediately; lamp lit off-idle. */
const PanelLatchButton = memo(function PanelLatchButton({ def, x, y }: PlacedProps) {
  const [value, , onCommit] = useControl<string>(MODULE_ID, def.id, positionFallback(def));
  const idle = def.positions?.[0] ?? 'OFF';
  return <Button def={def} value={value} onChange={onCommit} lit={value !== idle} x={x} y={y} />;
});

// ---- silkscreen ---------------------------------------------------------------------------

/** Section frame: rounded rect with the label sitting in a gap in the top border. */
function SectionFrame({ s }: { s: PanelSection }) {
  // Condensed 13px uppercase + 1.5 letter-spacing ≈ 8/char; clamp into the box width.
  const textLen = Math.min(s.label.length * 8, s.w - 28);
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
      {/* gap in the top border under the label */}
      <rect x={s.x + 8} y={s.y - 7} width={textLen + 12} height={14} fill={COLORS.panel} />
      <text
        x={s.x + 14}
        y={s.y + 4}
        fontFamily={FONT_CONDENSED}
        fontSize={13}
        letterSpacing={1.5}
        fill={COLORS.legend}
        textLength={textLen}
        lengthAdjust="spacingAndGlyphs"
      >
        {s.label}
      </text>
    </g>
  );
}

// ---- JSON -> component dispatch -------------------------------------------------------------

function renderControl(def: ControlDef): ReactElement | null {
  const placed = courierLayout.controls[def.id];
  if (!placed) return null;
  const { x, y } = placed;
  switch (def.type) {
    case 'knob':
    case 'stepKnob':
      return <PanelKnob key={def.id} def={def} x={x} y={y} size={placed.size} />;
    case 'switch':
      return <PanelSwitch key={def.id} def={def} x={x} y={y} />;
    case 'button':
      if (def.positions && def.positions.length > 0) {
        return <PanelLatchButton key={def.id} def={def} x={x} y={y} />;
      }
      return null;
  }
}

// ---- panel ----------------------------------------------------------------------------------

export function CourierPanel() {
  return (
    <svg
      className="panel"
      viewBox={`0 0 ${courierLayout.width} ${courierLayout.height}`}
      xmlns="http://www.w3.org/2000/svg"
      role="group"
      aria-label={`${courierLayout.title} panel`}
    >
      {/* panel face */}
      <rect
        width={courierLayout.width}
        height={courierLayout.height}
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
        {courierLayout.title.toUpperCase()}
      </text>

      {courierLayout.sections.map((s) => (
        <SectionFrame key={s.label} s={s} />
      ))}

      <g>{moduleDef.controls.map(renderControl)}</g>
    </svg>
  );
}
