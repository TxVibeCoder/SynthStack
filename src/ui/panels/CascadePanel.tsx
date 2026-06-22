/**
 * Cascade panel — CONTROLS-ONLY since the 16:9 redesign (its 32 jacks
 * live in panels/JackFieldPanel.tsx). One SVG, viewBox = the stage region
 * (cascadeLayout.width × height, 1:1 stage px), rendering every control from
 * data/cascade.json at its cascadeLayout position.
 *
 * Data flow (CONVENTIONS.md): each control sits in its own
 * memoized subcomponent subscribing via useControl('cascade', id), so a
 * store write re-renders only the control it changed and a knob drag re-renders
 * only the dragged knob (engine writes ride applyControlInput imperatively;
 * the single store commit lands on release via applyControlCommit).
 *
 * Buttons WITH def.positions latch/cycle through the store like switches.
 * Plain transport buttons (PLAY / TRIGGER / RESET / NEXT) are momentary and call
 * the bridge transport methods directly: PLAY toggles cascadePlay/cascadeStop on the
 * down edge; TRIGGER brackets cascadeTriggerButton(true/false); RESET brackets
 * cascadeReset(true/false) (press-and-hold pins step 1 — a quick click is
 * still a one-shot reset); NEXT fires cascadeNext on the down edge.
 *
 * Styling: original dark-panel/cream-legend work, plain-text title — no trade
 * dress.
 */

import { memo, useCallback } from 'react';
import type { ReactElement } from 'react';
import type { ControlDef, ModuleDef } from '../../../data/schema';
import cascadeJson from '../../../data/cascade.json';
import { COLORS, FONT_CONDENSED, GROUP_BORDER } from '../theme';
import type { KnobSize, PanelSection } from '../types';
import { Knob } from '../controls/Knob';
import { Switch } from '../controls/Switch';
import { Button } from '../controls/Button';
import { engineBridge } from '../engineBridge';
import { useControl, useStepPosition, useTransportFlags } from '../useStudio';
import { cascadeLayout } from './cascadeLayout';
import { StepLed } from '../controls/StepLed';

/** Chase LEDs above each sequencer's step knobs (stage 3 uiQueue/rAF drain). */
const CascadeLedRow = memo(function CascadeLedRow({ seq }: { seq: 0 | 1 }) {
  const pos = useStepPosition('cascade', seq);
  const { cascadePlaying } = useTransportFlags();
  const xs = [1, 2, 3, 4]
    .map((n) => cascadeLayout.controls[`CAS_SEQ${seq + 1}_STEP_${n}`])
    .filter((p): p is NonNullable<typeof p> => p != null);
  return (
    <g>
      {xs.map((p, i) => (
        <StepLed
          key={p.x}
          x={p.x}
          y={p.y - 38}
          on={cascadePlaying && i === pos}
          dim={!cascadePlaying && i === pos}
        />
      ))}
    </g>
  );
});

const moduleDef = cascadeJson as unknown as ModuleDef;
const MODULE_ID = moduleDef.id; // 'cascade'
/** Per-machine identity color (matches the patchbay group border + tab). */
const ACCENT = GROUP_BORDER.cascade;

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

/** CAS_TEMPO is a tick-RATE knob in Hz (1 PPQ); surface its tempo (tickHz × 60 = BPM) as a live
 *  dim sub-label under the knob, so a BPM-thinking player isn't stuck reading Hz. */
const CAS_TEMPO_BPM = 60;
const TempoKnob = memo(function TempoKnob({ def, x, y, size }: PlacedKnobProps) {
  const [value, onInput, onCommit] = useControl<number>(MODULE_ID, def.id, knobFallback(def));
  const bpm = Math.round((value || 0) * CAS_TEMPO_BPM);
  return (
    <Knob
      def={def}
      value={value}
      onInput={onInput}
      onCommit={onCommit}
      size={size}
      accent={ACCENT}
      subLabel={`≈ ${bpm} BPM`}
      x={x}
      y={y}
    />
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

/**
 * PLAY: momentary cap, toggles the transport on the down edge ('ON' = pointerdown,
 * 'OFF' = release — ignored). Lamp follows the polled transport flag.
 */
const CascadePlayButton = memo(function CascadePlayButton({ def, x, y }: PlacedProps) {
  const { cascadePlaying } = useTransportFlags();
  const onChange = useCallback((pos: string) => {
    if (pos !== 'ON') return; // act on the down edge only
    // fresh read — the polled hook value may lag up to 250 ms
    if (engineBridge.getTransportFlags().cascadePlaying) engineBridge.cascadeStop();
    else engineBridge.cascadePlay();
  }, []);
  return (
    <Button
      def={def}
      value={cascadePlaying ? 'ON' : 'OFF'}
      onChange={onChange}
      momentary
      lit={cascadePlaying}
      x={x}
      y={y}
    />
  );
});

/** Plain momentary transport buttons -> bridge actions (down on 'ON', up on 'OFF'). */
const TRANSPORT_ACTIONS: Readonly<Record<string, { down: () => void; up?: () => void }>> = {
  CAS_TRIGGER_BTN: {
    down: () => engineBridge.cascadeTriggerButton(true),
    up: () => engineBridge.cascadeTriggerButton(false),
  },
  // press-and-hold pins step 1; a quick click is still a one-shot reset
  CAS_RESET: {
    down: () => engineBridge.cascadeReset(true),
    up: () => engineBridge.cascadeReset(false),
  },
  CAS_NEXT: { down: () => engineBridge.cascadeNext() },
};

const CascadeMomentaryButton = memo(function CascadeMomentaryButton({ def, x, y }: PlacedProps) {
  const onChange = useCallback(
    (pos: string) => {
      const action = TRANSPORT_ACTIONS[def.id];
      if (!action) return;
      if (pos === 'ON') action.down();
      else action.up?.();
    },
    [def.id],
  );
  return <Button def={def} value="OFF" onChange={onChange} momentary x={x} y={y} />;
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
  const placed = cascadeLayout.controls[def.id];
  if (!placed) return null;
  const { x, y } = placed;
  switch (def.type) {
    case 'knob':
    case 'stepKnob':
      if (def.id === 'CAS_TEMPO') {
        return <TempoKnob key={def.id} def={def} x={x} y={y} size={placed.size} />;
      }
      return <PanelKnob key={def.id} def={def} x={x} y={y} size={placed.size} />;
    case 'switch':
      return <PanelSwitch key={def.id} def={def} x={x} y={y} />;
    case 'button':
      if (def.positions && def.positions.length > 0) {
        return <PanelLatchButton key={def.id} def={def} x={x} y={y} />;
      }
      if (def.id === 'CAS_PLAY') return <CascadePlayButton key={def.id} def={def} x={x} y={y} />;
      return <CascadeMomentaryButton key={def.id} def={def} x={x} y={y} />;
  }
}

// ---- panel ----------------------------------------------------------------------------------

export function CascadePanel() {
  return (
    <svg
      className="panel"
      viewBox={`0 0 ${cascadeLayout.width} ${cascadeLayout.height}`}
      xmlns="http://www.w3.org/2000/svg"
      role="group"
      aria-label={`${cascadeLayout.title} panel`}
    >
      {/* panel face */}
      <rect
        width={cascadeLayout.width}
        height={cascadeLayout.height}
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
        {cascadeLayout.title.toUpperCase()}
      </text>

      {cascadeLayout.sections.map((s) => (
        <SectionFrame key={s.label} s={s} />
      ))}

      <g>{moduleDef.controls.map(renderControl)}</g>
      <CascadeLedRow seq={0} />
      <CascadeLedRow seq={1} />
    </svg>
  );
}
