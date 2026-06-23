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
 * MOD MATRIX (Phase B UI): a per-patch routing layer. Four mod SOURCES — kb,
 * fEnv, aEnv, lfo1 — each map to ONE supported target control with a bipolar
 * depth. The gesture is LONG-PRESS-TO-ARM a source (a ~450 ms hold on its host
 * control), then DRAG a supported target knob to scrub the bipolar depth; the one
 * assignment commits on release via engineBridge.setCourierModAssign. All arm/
 * disarm state is panel-local React (CourierAssignContext) — never the store; only
 * the resolved route is committed. Supported targets are the modRouter allow-list.
 *
 * Switches and buttons-with-positions latch/cycle through the store. Courier's
 * 64-step param-lock sequencer / arp is deferred to a later phase, so this panel
 * has NO transport buttons, tempo knob, or step-LED row — only knobs and switches.
 *
 * Styling: dark-panel / cream-legend, machine-tinted plain-text title — no trade
 * dress.
 */

import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ControlDef, ModuleDef } from '../../../data/schema';
import courierJson from '../../../data/courier.json';
import { COLORS, FONT_CONDENSED, GROUP_BORDER, KNOB_RADIUS } from '../theme';
import type { KnobSize, PanelSection } from '../types';
import { Knob } from '../controls/Knob';
import { Switch } from '../controls/Switch';
import { Button } from '../controls/Button';
import { useControl, useCourierModAssign } from '../useStudio';
import { engineBridge } from '../engineBridge';
import { COURIER_MOD_TARGETS, type CourierModSource } from '../../state/studioState';
import { courierLayout } from './courierLayout';

const moduleDef = courierJson as unknown as ModuleDef;
const MODULE_ID = moduleDef.id; // 'courier'
/** Per-machine identity color (matches the patchbay group border + tab). */
const ACCENT = GROUP_BORDER.courier;
const TARGET_IDS = new Set(COURIER_MOD_TARGETS);

/**
 * Which panel control hosts each mod source's long-press affordance. The kb source has no
 * natural knob (KB TRACKING is a switch), so it gets a dedicated knob-style handle (below).
 */
const SOURCE_HOST: Record<Exclude<CourierModSource, 'kb'>, string> = {
  lfo1: 'COU_LFO1_RATE',
  fEnv: 'COU_EG_AMOUNT',
  aEnv: 'COU_A_SUSTAIN',
};
/** controlId -> the source it hosts (reverse of SOURCE_HOST), for the knob dispatch. */
const HOST_SOURCE: Record<string, CourierModSource> = Object.fromEntries(
  Object.entries(SOURCE_HOST).map(([src, id]) => [id, src as CourierModSource]),
) as Record<string, CourierModSource>;

/** Short display tag per source for the depth-arc glyph. */
const SOURCE_TAG: Record<CourierModSource, string> = { kb: 'kb', fEnv: 'fEnv', aEnv: 'aEnv', lfo1: 'lfo1' };

// ---- assign-mode context (panel-local, ephemeral — never the store) -----------------------

interface CourierAssignCtx {
  /** Currently armed source, or null when no assignment is in progress. */
  armed: CourierModSource | null;
  /** Arm a source (long-press); arming the already-armed source disarms it (toggle). */
  arm: (source: CourierModSource) => void;
  /** Clear the armed source (Escape / empty-panel click). */
  disarm: () => void;
}

const CourierAssignContext = createContext<CourierAssignCtx>({
  armed: null,
  arm: () => {},
  disarm: () => {},
});

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

/**
 * knob / stepKnob: onInput -> immediate engine write, onCommit -> one store write.
 *
 * Mod-matrix aware: if this knob hosts a source it long-presses to arm; if it is a supported
 * TARGET while a source is armed, a drag scrubs the bipolar assignment depth instead of the
 * knob's own value. When nothing is armed and it isn't a target, it drags exactly as before.
 */
const PanelKnob = memo(function PanelKnob({ def, x, y, size }: PlacedKnobProps) {
  const [value, onInput, onCommit] = useControl<number>(MODULE_ID, def.id, knobFallback(def));
  const { armed, arm } = useContext(CourierAssignContext);
  const routes = useCourierModAssign().routes;

  const hostSource = HOST_SOURCE[def.id];
  const isTarget = TARGET_IDS.has(def.id);
  const assignMode =
    armed != null && isTarget ? 'depth-target' : hostSource != null && armed === hostSource ? 'source-armed' : 'idle';

  // This knob's stored route (the source assigned to it, if any) drives the depth indicator.
  const myRoute = (Object.keys(routes) as CourierModSource[]).find(
    (s) => routes[s]?.controlId === def.id,
  );
  const myDepth = myRoute ? routes[myRoute]!.depth : undefined;

  const onLongPress = hostSource != null ? () => arm(hostSource) : undefined;
  const onAssignDepthCommit = useCallback(
    (depth: number) => {
      if (armed == null) return;
      // Center (depth 0) clears the route; otherwise assign source -> this target at depth.
      engineBridge.setCourierModAssign(armed, depth === 0 ? null : { controlId: def.id, depth });
    },
    [armed, def.id],
  );

  return (
    <Knob
      def={def}
      value={value}
      onInput={onInput}
      onCommit={onCommit}
      size={size}
      accent={ACCENT}
      x={x}
      y={y}
      onLongPress={onLongPress}
      assignMode={assignMode}
      assignDepth={myDepth}
      assignTag={myRoute ? SOURCE_TAG[myRoute] : undefined}
      assignColor={ACCENT}
      onAssignDepthCommit={onAssignDepthCommit}
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

// ---- kb-source long-press handle (KB TRACKING is a switch, so kb has no host knob) ---------

/**
 * A small knob-style handle that arms the `kb` (keyboard CV) mod source. Sits beside the
 * KB TRACKING switch. Long-press (~450 ms hold, cancelled on travel) arms; tapping the armed
 * handle disarms — same gesture as a source-host knob, minus any value of its own.
 */
function KbSourceHandle({ x, y }: { x: number; y: number }) {
  const { armed, arm, disarm } = useContext(CourierAssignContext);
  const isArmed = armed === 'kb';
  const r = KNOB_RADIUS.s;
  const holdTimer = useRef<number | null>(null);
  const travel = useRef(0);
  const lastY = useRef(0);

  useEffect(() => () => { if (holdTimer.current != null) clearTimeout(holdTimer.current); }, []);

  const clear = () => {
    if (holdTimer.current != null) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
  };

  return (
    <g
      className="control control--knob"
      transform={`translate(${x} ${y})`}
      tabIndex={0}
      role="button"
      aria-label="KB CV mod source — long-press to assign"
      style={{ cursor: 'pointer' }}
      onPointerDown={(e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        travel.current = 0;
        lastY.current = e.clientY;
        clear();
        holdTimer.current = window.setTimeout(() => {
          holdTimer.current = null;
          arm('kb');
        }, 450);
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        travel.current += Math.abs(lastY.current - e.clientY);
        lastY.current = e.clientY;
        if (travel.current > 4) clear();
      }}
      onPointerUp={(e) => {
        clear();
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={clear}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          isArmed ? disarm() : arm('kb');
        }
      }}
    >
      <circle r={r + 4} fill="transparent" />
      <circle r={r} fill={COLORS.panelRaised} stroke={isArmed ? COLORS.focus : COLORS.panelEdge} strokeWidth={isArmed ? 2 : 1.2} />
      {isArmed && (
        <circle r={r + 6} fill="none" stroke={COLORS.focus} strokeWidth={2} pointerEvents="none">
          <animate attributeName="opacity" values="0.95;0.4;0.95" dur="1.1s" repeatCount="indefinite" />
        </circle>
      )}
      <text
        y={r + 14}
        textAnchor="middle"
        fontFamily={FONT_CONDENSED}
        fontSize={9}
        letterSpacing={0.5}
        fill={COLORS.legend}
      >
        KB MOD
      </text>
    </g>
  );
}

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
  const [armed, setArmed] = useState<CourierModSource | null>(null);

  const arm = useCallback(
    (source: CourierModSource) => setArmed((cur) => (cur === source ? null : source)),
    [],
  );
  const disarm = useCallback(() => setArmed(null), []);
  const ctx = useMemo<CourierAssignCtx>(() => ({ armed, arm, disarm }), [armed, arm, disarm]);

  // Escape disarms while an assignment is in progress.
  useEffect(() => {
    if (armed == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') disarm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [armed, disarm]);

  // KB-source handle sits beside the KB TRACKING switch.
  const kbSwitch = courierLayout.controls.COU_KB_TRACKING;

  return (
    <CourierAssignContext.Provider value={ctx}>
      <svg
        className="panel"
        viewBox={`0 0 ${courierLayout.width} ${courierLayout.height}`}
        xmlns="http://www.w3.org/2000/svg"
        role="group"
        aria-label={`${courierLayout.title} panel`}
        // Clicking empty panel space disarms (controls stopPropagation via pointer capture, so a
        // click that lands on the bare face — not a knob — clears the in-progress assignment).
        onClick={(e) => {
          if (armed != null && e.target === e.currentTarget) disarm();
        }}
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

        {/* assign-mode hint banner: tells the player what to do while a source is armed */}
        {armed != null && (
          <text
            x={courierLayout.width - 14}
            y={24}
            textAnchor="end"
            fontFamily={FONT_CONDENSED}
            fontSize={13}
            letterSpacing={1}
            fill={COLORS.focus}
          >
            {`ASSIGN ${SOURCE_TAG[armed].toUpperCase()} — DRAG A TARGET (CENTER = CLEAR · ESC = CANCEL)`}
          </text>
        )}

        {courierLayout.sections.map((s) => (
          <SectionFrame key={s.label} s={s} />
        ))}

        <g>{moduleDef.controls.map(renderControl)}</g>

        {/* kb mod-source handle (KB TRACKING is a switch, so kb gets its own affordance) */}
        {kbSwitch && <KbSourceHandle x={kbSwitch.x + 42} y={kbSwitch.y} />}
      </svg>
    </CourierAssignContext.Provider>
  );
}
