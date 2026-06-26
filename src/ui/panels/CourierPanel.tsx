/**
 * Courier panel — a faithful FULL-FACE replica of the source unit's computer-editor control
 * surface (see courierLayout.ts for the band-by-band map + measurement provenance), rendered in
 * SynthStack's own palette. One SVG, viewBox = courierLayout.width × height, composing:
 *   IO legend · control band · sequencer band · performance cluster · PRESET SETTINGS / MOD
 *   ASSIGN placeholders · wordmark + pitch/mod wheels + patch row · the 32-key keybed.
 *
 * Real Courier controls (data/courier.json) are wired to the store via useControl and rendered
 * with the editor's SHAPES (illuminated lamp buttons / compact + caption-list selectors / seq
 * dropdowns / gold knobs); the editor's software-only blocks (preset settings, the 9-row mod
 * matrix, the patch-button row, the IO legend, the wheels) are faithful VISUAL placeholders —
 * accounted for in the layout, no engine wiring (Courier's real mod system is the long-press
 * gesture below, not a matrix).
 *
 * MOD MATRIX (Phase B, preserved): long-press a source host knob (~450 ms) to ARM, then drag a
 * supported target knob to scrub the bipolar depth; the one route commits on release via
 * engineBridge.setCourierModAssign. Arm state is panel-local React, never the store.
 *
 * The keybed plays the Courier voice: it forces engineBridge.keyboardTarget='courier' while
 * mounted (restored on unmount) so on-screen keys + MIDI sound Courier on this tab.
 */

import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react';
import type { ControlDef, ModuleDef } from '../../../data/schema';
import courierJson from '../../../data/courier.json';
import { COLORS, FONT_CONDENSED, GROUP_BORDER, KNOB_RADIUS } from '../theme';
import type { KnobSize, PanelSection } from '../types';
import { Knob } from '../controls/Knob';
import { useControl, useCourierModAssign, useCourierSeqSettings } from '../useStudio';
import { engineBridge } from '../engineBridge';
import { keyToNote } from '../../engine/voice/keyMap';
import { COURIER_MOD_TARGETS, type CourierModSource } from '../../state/studioState';
import {
  courierLayout,
  COURIER_LAMP_BUTTONS,
  COURIER_SELECTORS,
  COURIER_IO_LABELS,
  COURIER_IO_Y,
  COURIER_SILK,
  COURIER_LINES,
  COURIER_DECOR_KNOBS,
  COURIER_DECOR_BUTTONS,
  COURIER_DECOR_DROPDOWNS,
  COURIER_DECOR_TOGGLES,
  COURIER_WHEELS,
  COURIER_PATCH_BTNS,
  COURIER_PATCH_BTN_Y,
  COURIER_SEQ_STEPS,
  COURIER_SEQ_STEP_Y,
  COURIER_WHITE_KEYS,
  COURIER_BLACK_KEYS,
  COURIER_KEYBED,
  type CourierKey,
} from './courierLayout';
import {
  LampButton,
  SelectorBox,
  SelectorList,
  Dropdown,
  LampSelectorH,
  StepLamp,
  DecorKnob,
  DecorButton,
  DecorDropdown,
  DecorToggle,
  Wheel,
} from './courierControls';
import {
  courierIsRunning,
  courierReset,
  courierRun,
  courierStepPosition,
  courierStop,
  subscribeCourierStepPosition,
  subscribeStore,
  setCourierSeqField,
  ARP_POS_TO_VAL,
  ARP_VAL_TO_POS,
} from '../sequencer/courierSeqBridge';

const moduleDef = courierJson as unknown as ModuleDef;
const MODULE_ID = moduleDef.id; // 'courier'
const ACCENT = GROUP_BORDER.courier;
const TARGET_IDS = new Set(COURIER_MOD_TARGETS);
/** Smoke grey for the black-key buttons so they read against the dark panel (not panelShadow black). */
const BLACK_KEY = '#4e515a';

const defById = new Map(moduleDef.controls.map((c) => [c.id, c]));

/** Short display strings for switch positions (compact boxes + caption lists). */
const POS_DISPLAY: Record<string, Record<string, string>> = {
  COU_LFO1_DEST: { CUTOFF: 'CUT', OSC2_FREQ: 'O2 FRQ', OSC1_WAVE: 'O1 WAV', SUB_WAVE: 'SUB' },
  COU_MOD_DEST: { FM_1_2: '1+2 FM', FENV_OSC2_FREQ: 'F→O2 FRQ', FENV_OSC2_WAVE: 'F→O2 WAV', FENV_SUB_WAVE: 'F→SUB' },
  COU_FILTER_MODE: { LP4: '4P LOW', LP2: '2P LOW', BP: 'BAND', HP: 'HIGH' },
  COU_OSC1_OCTAVE: { '16': "16'", '8': "8'", '4': "4'", '2': "2'" },
  COU_OSC2_OCTAVE: { '16': "16'", '8': "8'", '4': "4'", '2': "2'" },
  COU_LFO2_DEST: { PITCH: 'PITCH', CUTOFF: 'CUTOFF', AMP: 'AMP' },
};
const disp = (id: string, pos: string) => POS_DISPLAY[id]?.[pos] ?? pos;

/** Shortened selector labels for the tight LFO/OSC column (the OSC 1/2 numerals disambiguate). */
const SHORT_LABEL: Record<string, string> = {
  COU_OSC1_OCTAVE: 'OCTAVE',
  COU_OSC2_OCTAVE: 'OCTAVE',
  COU_LFO1_WAVE: 'WAVE',
  COU_LFO1_DEST: 'DEST',
};

/** Which panel control hosts each mod source's long-press affordance (kb has its own handle). */
const SOURCE_HOST: Record<Exclude<CourierModSource, 'kb'>, string> = {
  lfo1: 'COU_LFO1_RATE',
  fEnv: 'COU_EG_AMOUNT',
  aEnv: 'COU_A_SUSTAIN',
};
const HOST_SOURCE: Record<string, CourierModSource> = Object.fromEntries(
  Object.entries(SOURCE_HOST).map(([src, id]) => [id, src as CourierModSource]),
) as Record<string, CourierModSource>;
const SOURCE_TAG: Record<CourierModSource, string> = { kb: 'kb', fEnv: 'fEnv', aEnv: 'aEnv', lfo1: 'lfo1' };

// ---- assign-mode context (panel-local, ephemeral — never the store) -----------------------

interface CourierAssignCtx {
  armed: CourierModSource | null;
  arm: (source: CourierModSource) => void;
  disarm: () => void;
}
const CourierAssignContext = createContext<CourierAssignCtx>({ armed: null, arm: () => {}, disarm: () => {} });

// ---- fallbacks ---------------------------------------------------------------------------

function knobFallback(def: ControlDef): number {
  return typeof def.default === 'number' ? def.default : (def.min ?? 0);
}
function positionFallback(def: ControlDef): string {
  return typeof def.default === 'string' ? def.default : (def.positions?.[0] ?? 'OFF');
}

// ---- gold knob (mod-assign aware) --------------------------------------------------------

interface PlacedKnobProps {
  def: ControlDef;
  x: number;
  y: number;
  size?: KnobSize;
}

const PanelKnob = memo(function PanelKnob({ def, x, y, size }: PlacedKnobProps) {
  const [value, onInput, onCommit] = useControl<number>(MODULE_ID, def.id, knobFallback(def));
  const { armed, arm } = useContext(CourierAssignContext);
  const routes = useCourierModAssign().routes;

  const hostSource = HOST_SOURCE[def.id];
  const isTarget = TARGET_IDS.has(def.id);
  const assignMode =
    armed != null && isTarget ? 'depth-target' : hostSource != null && armed === hostSource ? 'source-armed' : 'idle';

  const myRoute = (Object.keys(routes) as CourierModSource[]).find((s) => routes[s]?.controlId === def.id);
  const myDepth = myRoute ? routes[myRoute]!.depth : undefined;

  const onLongPress = hostSource != null ? () => arm(hostSource) : undefined;
  const onAssignDepthCommit = useCallback(
    (depth: number) => {
      if (armed == null) return;
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

// ---- wired discrete controls (editor shapes) ---------------------------------------------

/** OFF/ON lamp button. */
const WiredLamp = memo(function WiredLamp({ def, x, y }: { def: ControlDef; x: number; y: number }) {
  const [value, , onCommit] = useControl<string>(MODULE_ID, def.id, positionFallback(def));
  const positions = def.positions ?? ['OFF', 'ON'];
  const idle = positions[0] ?? 'OFF';
  const active = positions[positions.length - 1] ?? 'ON';
  return <LampButton label={def.panelLabel} lit={value !== idle} onToggle={() => onCommit(value === active ? idle : active)} x={x} y={y} accent={ACCENT} />;
});

/** Compact value-box selector (in-band multi-position switch). */
const WiredSelectorBox = memo(function WiredSelectorBox({ def, x, y }: { def: ControlDef; x: number; y: number }) {
  const [value, , onCommit] = useControl<string>(MODULE_ID, def.id, positionFallback(def));
  const positions = def.positions ?? [];
  const idx = Math.max(0, positions.indexOf(value));
  const onStep = (dir: 1 | -1) => {
    const next = positions[(idx + dir + positions.length) % positions.length];
    if (next != null) onCommit(next);
  };
  return <SelectorBox label={SHORT_LABEL[def.id] ?? def.panelLabel} display={disp(def.id, value)} count={positions.length} idx={idx} onStep={onStep} x={x} y={y} />;
});

/** Caption-list selector (MODE / MOD DESTINATION). */
const WiredSelectorList = memo(function WiredSelectorList({ def, x, y }: { def: ControlDef; x: number; y: number }) {
  const [value, , onCommit] = useControl<string>(MODULE_ID, def.id, positionFallback(def));
  const positions = def.positions ?? [];
  const idx = Math.max(0, positions.indexOf(value));
  const onStep = (dir: 1 | -1) => {
    const next = positions[(idx + dir + positions.length) % positions.length];
    if (next != null) onCommit(next);
  };
  return <SelectorList label={def.panelLabel} displays={positions.map((p) => disp(def.id, p))} idx={idx} onStep={onStep} x={x} y={y} />;
});

/** Horizontal 3-lamp selector (LFO 2 DESTINATION). */
const WiredLampSelector = memo(function WiredLampSelector({ def, x, y }: { def: ControlDef; x: number; y: number }) {
  const [value, , onCommit] = useControl<string>(MODULE_ID, def.id, positionFallback(def));
  const positions = def.positions ?? [];
  const idx = Math.max(0, positions.indexOf(value));
  return <LampSelectorH displays={positions.map((p) => disp(def.id, p))} idx={idx} onPick={(i) => onCommit(positions[i] ?? value)} x={x} y={y} />;
});

// ---- seq-slice-backed controls (sequencer-band SETTINGS on the MAIN panel) -----------------
// These SETTINGS live on state.courier.seq (NOT state.controls.courier): Studio.syncTransportConfig
// reads the seq slice, so they MUST be written via setCourierSeqField — a plain useControl write to
// state.controls.courier never reaches the sequencer (the bug this fixes). They share the one seq
// slice with the step-editor settings row, so both surfaces stay in lockstep. Commit-only (onInput
// = no-op), matching the step editor. (TEMPO is the lone exception — it rides the ordinary useControl
// path; the engine now intercepts COU_TEMPO into courierSeq.tempoBpm on the LIVE path too.)

const noop = (): void => {};

/** SWING / GATE LENGTH — numeric seq-slice knobs. Clamp bounds come from the SAME ControlDef the
 *  Knob drags against (def.min/def.max), so the commit clamp can't drift from the JSON range. */
const SeqKnob = memo(function SeqKnob({
  def, x, y, size, field,
}: PlacedKnobProps & { field: 'swingPct' | 'gateLenScale' }) {
  const settings = useCourierSeqSettings();
  const lo = def.min ?? 0;
  const hi = def.max ?? 1;
  const onCommit = useCallback(
    (v: number) => setCourierSeqField(field, Math.max(lo, Math.min(hi, v))),
    [field, lo, hi],
  );
  return <Knob def={def} value={settings[field]} onInput={noop} onCommit={onCommit} size={size} accent={ACCENT} x={x} y={y} />;
});

/** CLOCK DIV — seq-slice dropdown; clockDivIdx is directly the index into def.positions. */
const SeqClockDivDropdown = memo(function SeqClockDivDropdown({ def, x, y, label, w }: { def: ControlDef; x: number; y: number; label: string; w?: number }) {
  const settings = useCourierSeqSettings();
  const positions = def.positions ?? [];
  const idx = positions.length ? Math.min(Math.max(0, settings.clockDivIdx), positions.length - 1) : 0;
  const onAdvance = (dir: 1 | -1) => {
    if (!positions.length) return;
    setCourierSeqField('clockDivIdx', (idx + dir + positions.length) % positions.length);
  };
  return <Dropdown label={label} value={positions[idx] ?? '1/16'} onAdvance={onAdvance} x={x} y={y} w={w} />;
});

/** ARP PATTERN — seq-slice dropdown; positions are display labels, stored as the arpMode union. */
const SeqArpModeDropdown = memo(function SeqArpModeDropdown({ def, x, y, label, w }: { def: ControlDef; x: number; y: number; label: string; w?: number }) {
  const settings = useCourierSeqSettings();
  const positions = def.positions ?? [];
  const curPos = ARP_VAL_TO_POS[settings.arpMode] ?? 'OFF';
  const idx = Math.max(0, positions.indexOf(curPos));
  const onAdvance = (dir: 1 | -1) => {
    const next = positions[(idx + dir + positions.length) % positions.length];
    if (next != null) setCourierSeqField('arpMode', ARP_POS_TO_VAL[next] ?? 'OFF');
  };
  return <Dropdown label={label} value={curPos} onAdvance={onAdvance} x={x} y={y} w={w} />;
});

/** ARP OCTAVE — seq-slice stepped dropdown (1..4). */
const SeqArpOctaveDropdown = memo(function SeqArpOctaveDropdown({ def, x, y, label, w }: { def: ControlDef; x: number; y: number; label: string; w?: number }) {
  const settings = useCourierSeqSettings();
  const lo = def.min ?? 1;
  const hi = def.max ?? 4;
  const v = Math.min(hi, Math.max(lo, Math.round(settings.arpOctave)));
  const onAdvance = (dir: 1 | -1) => {
    const span = hi - lo + 1;
    setCourierSeqField('arpOctave', lo + ((v - lo + dir + span) % span));
  };
  return <Dropdown label={label} value={`×${v}`} onAdvance={onAdvance} x={x} y={y} w={w} />;
});

/** SEQ MODE — seq-slice compact selector (SEQ / ARP). */
const SeqModeSelector = memo(function SeqModeSelector({ def, x, y }: { def: ControlDef; x: number; y: number }) {
  const settings = useCourierSeqSettings();
  const positions = def.positions ?? ['SEQ', 'ARP'];
  const idx = Math.max(0, positions.indexOf(settings.mode));
  const onStep = (dir: 1 | -1) => {
    const next = positions[(idx + dir + positions.length) % positions.length];
    if (next != null) setCourierSeqField('mode', next === 'ARP' ? 'ARP' : 'SEQ');
  };
  return <SelectorBox label={SHORT_LABEL[def.id] ?? def.panelLabel} display={disp(def.id, settings.mode)} count={positions.length} idx={idx} onStep={onStep} x={x} y={y} />;
});

// ---- control dispatch --------------------------------------------------------------------

function renderControl(id: string, placed: { x: number; y: number; size?: KnobSize }): ReactElement | null {
  const def = defById.get(id);
  if (!def) return null;
  const { x, y, size } = placed;
  if (id === 'COU_LFO2_DEST') return <WiredLampSelector key={id} def={def} x={x} y={y} />;
  // Sequencer-band SETTINGS write the seq slice (state.courier.seq) so they actually drive the
  // live sequencer — a plain useControl write to state.controls.courier never reaches it.
  if (id === 'COU_SEQ_MODE') return <SeqModeSelector key={id} def={def} x={x} y={y} />;
  if (id === 'COU_CLOCK_DIV') return <SeqClockDivDropdown key={id} def={def} x={x} y={y} label="CLOCK DIV" w={70} />;
  if (id === 'COU_ARP_MODE') return <SeqArpModeDropdown key={id} def={def} x={x} y={y} label="ARP PATTERN" w={84} />;
  if (id === 'COU_ARP_OCTAVE') return <SeqArpOctaveDropdown key={id} def={def} x={x} y={y} label="ARP OCTAVE" w={70} />;
  if (id === 'COU_SWING') return <SeqKnob key={id} def={def} x={x} y={y} size={size} field="swingPct" />;
  if (id === 'COU_GATE_LENGTH') return <SeqKnob key={id} def={def} x={x} y={y} size={size} field="gateLenScale" />;
  if (COURIER_LAMP_BUTTONS.has(id)) return <WiredLamp key={id} def={def} x={x} y={y} />;
  if (COURIER_SELECTORS.has(id)) {
    if (id === 'COU_MOD_DEST' || id === 'COU_FILTER_MODE') return <WiredSelectorList key={id} def={def} x={x} y={y} />;
    return <WiredSelectorBox key={id} def={def} x={x} y={y} />;
  }
  return <PanelKnob key={id} def={def} x={x} y={y} size={size} />;
}

// ---- kb-source long-press handle (KB TRACKING is a switch, so kb has no host knob) --------

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
      <text y={r + 13} textAnchor="middle" fontFamily={FONT_CONDENSED} fontSize={8.5} letterSpacing={0.4} fill={COLORS.legend}>
        KB MOD
      </text>
    </g>
  );
}

// ---- silkscreen --------------------------------------------------------------------------

function SectionFrame({ s }: { s: PanelSection }) {
  const textLen = Math.min(s.label.length * 8, s.w - 20);
  return (
    <g>
      <rect x={s.x} y={s.y} width={s.w} height={s.h} rx={6} fill="none" stroke={COLORS.panelEdge} strokeWidth={1} />
      <rect x={s.x + 8} y={s.y - 7} width={textLen + 12} height={14} fill={COLORS.panel} />
      <text x={s.x + 14} y={s.y + 4} fontFamily={FONT_CONDENSED} fontSize={12} letterSpacing={1.4} fill={COLORS.legend} textLength={textLen} lengthAdjust="spacingAndGlyphs">
        {s.label}
      </text>
    </g>
  );
}

// ---- sequencer step row (subscribes to the running position) -----------------------------

function SeqStepRow() {
  const pos = useSyncExternalStore(subscribeCourierStepPosition, courierStepPosition);
  const running = useSyncExternalStore(subscribeStore, courierIsRunning);
  const cur = running ? pos % COURIER_SEQ_STEPS.length : -1;
  return (
    <g>
      {COURIER_SEQ_STEPS.map((x, i) => (
        <StepLamp key={i} x={x} y={COURIER_SEQ_STEP_Y} on={i === cur} num={i + 1} />
      ))}
    </g>
  );
}

// ---- transport (PLAY/STOP + RESET, wired to the Courier sequencer) ------------------------

function Transport() {
  const running = useSyncExternalStore(subscribeStore, courierIsRunning);
  return (
    <g>
      <LampButton label="PLAY" lit={running} onToggle={() => (running ? courierStop() : courierRun())} x={212} y={318} accent={ACCENT} />
      <LampButton label="RESET" lit={false} onToggle={() => courierReset()} x={280} y={318} accent={ACCENT} />
    </g>
  );
}

// ---- KB OCTAVE cluster (wired to the shared keyboard octave) ------------------------------

const OCT_MIN = -3;
const OCT_MAX = 3;
function KbOctave({ x, y }: { x: number; y: number }) {
  const octave = useSyncExternalStore((cb) => engineBridge.store.subscribe(cb), () => engineBridge.getKeyboardOctave());
  const shift = (d: number) => {
    const n = Math.max(OCT_MIN, Math.min(OCT_MAX, octave + d));
    if (n !== octave) engineBridge.setKeyboardOctave(n);
  };
  return (
    <g>
      <LampButton label="" lit={false} onToggle={() => shift(-1)} x={x - 42} y={y} w={16} h={14} />
      <LampButton label="" lit={false} onToggle={() => shift(1)} x={x + 42} y={y} w={16} h={14} />
      <text x={x} y={y + 4} textAnchor="middle" fontFamily={FONT_CONDENSED} fontSize={11} letterSpacing={0.5} fill={COLORS.legend}>
        {`C${3 + octave}`}
      </text>
      <text x={x} y={y + 18} textAnchor="middle" fontFamily={FONT_CONDENSED} fontSize={7.5} letterSpacing={1} fill={COLORS.legendDim}>
        KB OCTAVE
      </text>
    </g>
  );
}

// ---- keybed (32 keys; plays the Courier voice) -------------------------------------------

/** One key-button (centre-positioned). White = light cap, black = dark cap, held = accent. */
const KeyView = memo(function KeyView({ k, held, onDown, onUp }: { k: CourierKey; held: boolean; onDown: (e: ReactPointerEvent<SVGGElement>, k: CourierKey) => void; onUp: (e: ReactPointerEvent<SVGGElement>) => void }) {
  return (
    <g className="control" role="button" tabIndex={0} aria-label={`Key ${k.semitone}`} style={{ cursor: 'pointer' }} onPointerDown={(e) => onDown(e, k)} onPointerUp={onUp} onPointerCancel={onUp}>
      <rect
        x={k.x - k.w / 2}
        y={k.y - k.h / 2}
        width={k.w}
        height={k.h}
        rx={3.5}
        fill={held ? COLORS.focus : k.isBlack ? BLACK_KEY : COLORS.legend}
        stroke={k.isBlack ? COLORS.panelShadow : COLORS.jackRingDark}
        strokeWidth={1.1}
      />
    </g>
  );
});

function CourierKeybed() {
  const [held, setHeld] = useState<ReadonlySet<number>>(() => new Set());
  const pointerNote = useRef<Map<number, number>>(new Map());

  // While mounted, route on-screen keys + MIDI to the Courier voice; restore on leave.
  useEffect(() => {
    const prev = engineBridge.getKeyboardTarget();
    if (prev !== 'courier') engineBridge.setKeyboardTarget('courier');
    return () => {
      if (engineBridge.getKeyboardTarget() === 'courier' && prev !== 'courier') engineBridge.setKeyboardTarget(prev);
    };
  }, []);

  const mark = useCallback((semi: number, on: boolean) => {
    setHeld((prev) => {
      if (on === prev.has(semi)) return prev;
      const next = new Set(prev);
      on ? next.add(semi) : next.delete(semi);
      return next;
    });
  }, []);

  const onDown = useCallback(
    (e: ReactPointerEvent<SVGGElement>, k: CourierKey) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      pointerNote.current.set(e.pointerId, k.semitone);
      engineBridge.noteOn(keyToNote(k.semitone, 0), 100);
      mark(k.semitone, true);
    },
    [mark],
  );
  const onUp = useCallback(
    (e: ReactPointerEvent<SVGGElement>) => {
      const cur = pointerNote.current.get(e.pointerId);
      if (cur == null) return;
      pointerNote.current.delete(e.pointerId);
      engineBridge.noteOff(keyToNote(cur, 0));
      mark(cur, false);
    },
    [mark],
  );

  const flush = useCallback(() => {
    for (const semi of pointerNote.current.values()) engineBridge.noteOff(keyToNote(semi, 0));
    pointerNote.current.clear();
    setHeld((p) => (p.size === 0 ? p : new Set()));
  }, []);
  useEffect(() => {
    window.addEventListener('blur', flush);
    return () => {
      window.removeEventListener('blur', flush);
      flush();
    };
  }, [flush]);

  const { x0, x1, blackRowY, whiteRowY, btnH } = COURIER_KEYBED;
  const top = blackRowY - btnH / 2 - 8;
  const bot = whiteRowY + btnH / 2 + 8;
  return (
    <g>
      <rect x={x0 - 6} y={top} width={x1 - x0 + 12} height={bot - top} rx={8} fill={COLORS.panelShadow} opacity={0.55} />
      {COURIER_WHITE_KEYS.map((k) => (
        <KeyView key={k.semitone} k={k} held={held.has(k.semitone)} onDown={onDown} onUp={onUp} />
      ))}
      {COURIER_BLACK_KEYS.map((k) => (
        <KeyView key={k.semitone} k={k} held={held.has(k.semitone)} onDown={onDown} onUp={onUp} />
      ))}
    </g>
  );
}

// ---- panel -------------------------------------------------------------------------------

export function CourierPanel() {
  const [armed, setArmed] = useState<CourierModSource | null>(null);
  // Mod-wheel position (0..1, holds). Runtime-only — not a preset value; resets to parked-down on
  // reload, matching the engine default and a physical wheel at rest. Pitch wheel is sprung (no state).
  const [modWheel, setModWheel] = useState(0);
  const arm = useCallback((source: CourierModSource) => setArmed((cur) => (cur === source ? null : source)), []);
  const disarm = useCallback(() => setArmed(null), []);
  const ctx = useMemo<CourierAssignCtx>(() => ({ armed, arm, disarm }), [armed, arm, disarm]);

  useEffect(() => {
    if (armed == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') disarm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [armed, disarm]);

  const kbSwitch = courierLayout.controls.COU_KB_TRACKING;

  return (
    <CourierAssignContext.Provider value={ctx}>
      <svg
        className="panel"
        viewBox={`0 0 ${courierLayout.width} ${courierLayout.height}`}
        xmlns="http://www.w3.org/2000/svg"
        role="group"
        aria-label={`${courierLayout.title} panel`}
        onClick={(e) => {
          if (armed != null && e.target === e.currentTarget) disarm();
        }}
      >
        {/* panel face */}
        <rect width={courierLayout.width} height={courierLayout.height} rx={10} fill={COLORS.panel} stroke={ACCENT} strokeWidth={1.5} />

        {/* assign-mode hint banner */}
        {armed != null && (
          <text x={courierLayout.width - 16} y={20} textAnchor="end" fontFamily={FONT_CONDENSED} fontSize={12} letterSpacing={1} fill={COLORS.focus}>
            {`ASSIGN ${SOURCE_TAG[armed].toUpperCase()} — DRAG A TARGET (CENTER = CLEAR · ESC = CANCEL)`}
          </text>
        )}

        {/* IO legend strip */}
        <g pointerEvents="none">
          {COURIER_IO_LABELS.map((l) => (
            <g key={l.text}>
              <circle cx={l.x} cy={COURIER_IO_Y - 6} r={2.2} fill={COLORS.legendDim} opacity={0.5} />
              <text x={l.x} y={COURIER_IO_Y + 6} textAnchor="middle" fontFamily={FONT_CONDENSED} fontSize={7} letterSpacing={0.3} fill={COLORS.legendDim}>
                {l.text}
              </text>
            </g>
          ))}
        </g>

        {/* section frames */}
        {courierLayout.sections.map((s) => (
          <SectionFrame key={s.label} s={s} />
        ))}

        {/* silkscreen text + lines */}
        <g pointerEvents="none">
          {COURIER_LINES.map((l, i) => (
            <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke={COLORS.panelEdge} strokeWidth={1} />
          ))}
          {COURIER_SILK.map((t, i) => (
            <text
              key={i}
              x={t.x}
              y={t.y}
              textAnchor={t.anchor ?? 'start'}
              fontFamily={FONT_CONDENSED}
              fontSize={t.size ?? 9}
              fontWeight={t.bold ? 700 : 400}
              letterSpacing={t.spacing ?? 0.3}
              fill={t.bold && t.size && t.size >= 20 ? ACCENT : t.dim ? COLORS.legendDim : COLORS.legend}
            >
              {t.text}
            </text>
          ))}
        </g>

        {/* all wired controls */}
        <g>{Object.entries(courierLayout.controls).map(([id, p]) => renderControl(id, p))}</g>

        {/* kb mod-source handle */}
        {kbSwitch && <KbSourceHandle x={kbSwitch.x + 40} y={kbSwitch.y} />}

        {/* sequencer band extras */}
        <SeqStepRow />
        <Transport />
        <KbOctave x={158} y={358} />
        <DecorButton x={235} y={358} label="HOLD" />

        {/* PRESET SETTINGS + MOD ASSIGN placeholders */}
        <g>
          {COURIER_DECOR_KNOBS.map((k, i) => (
            <DecorKnob key={`dk${i}`} x={k.x} y={k.y} label={k.label} r={k.size === 's' ? 11 : 13} />
          ))}
          {COURIER_DECOR_BUTTONS.map((b, i) => (
            <DecorButton key={`db${i}`} x={b.x} y={b.y} label={b.label} w={b.w} h={b.h} lit={b.lit} />
          ))}
          {COURIER_DECOR_DROPDOWNS.map((d, i) => (
            <DecorDropdown key={`dd${i}`} x={d.x} y={d.y} w={d.w} label={d.label} value={d.value} />
          ))}
          {COURIER_DECOR_TOGGLES.map((t, i) => (
            <DecorToggle key={`dt${i}`} x={t.x} y={t.y} label={t.label} positions={t.positions} idx={t.idx} />
          ))}
        </g>

        {/* pitch / mod wheels — PITCH bends all oscillators ±7 st then springs to center; MOD scales
            LFO 2 depth and holds. Both write the engine imperatively (runtime-only performance gestures). */}
        {COURIER_WHEELS.map((w, i) =>
          w.kind === 'mod' ? (
            <Wheel
              key={`w${i}`}
              x={w.x}
              y={w.y}
              w={w.w}
              h={w.h}
              kind="mod"
              value={modWheel}
              onInput={(v) => {
                setModWheel(v);
                engineBridge.setCourierModWheel(v);
              }}
              onCommit={(v) => {
                setModWheel(v);
                engineBridge.setCourierModWheel(v);
              }}
            />
          ) : (
            <Wheel
              key={`w${i}`}
              x={w.x}
              y={w.y}
              w={w.w}
              h={w.h}
              kind="pitch"
              value={0}
              onInput={(v) => engineBridge.setCourierPitchBend(v)}
              onCommit={(v) => engineBridge.setCourierPitchBend(v)}
            />
          ),
        )}

        {/* patch-button row (visual) */}
        <g pointerEvents="none">
          {COURIER_PATCH_BTNS.map((x, i) => (
            <rect key={i} x={x - 22} y={COURIER_PATCH_BTN_Y - 7} width={44} height={14} rx={3} fill={COLORS.panelRaised} stroke={COLORS.panelEdge} strokeWidth={1} opacity={0.85} />
          ))}
        </g>

        {/* keybed */}
        <CourierKeybed />
      </svg>
    </CourierAssignContext.Provider>
  );
}
