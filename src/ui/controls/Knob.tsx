/**
 * SVG rotary knob — ergonomics per CONVENTIONS.md (Appendix D Tier 3):
 * vertical relative drag with pointer capture, Shift = x0.1 fine (re-baselined
 * per move, so toggling Shift mid-drag never jumps), double-click = reset to
 * def.default, stepped defs snap during drag, keyboard arrows/Home/End.
 *
 * Data flow: onInput fires on every move -> immediate
 * imperative engine write; onCommit fires once on release / double-click ->
 * single store write. The drag value is LOCAL state — only this knob
 * re-renders while dragging; parents are never forced to re-render.
 */

import { useEffect, useId, useRef, useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import type { KnobProps } from '../types';
import { COLORS, FONT_CONDENSED, FONT_STACK, KNOB_RADIUS } from '../theme';
import {
  clamp01,
  dragDelta,
  formatValue,
  normToAngle,
  normToValue,
  stepCount,
  valueToNorm,
} from './dragMath';

/** 270° tick arc at radius `rad` (knob angle convention: 0° = up, ±135° = rails). */
function arcPath(rad: number): string {
  const pt = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    return `${(rad * Math.sin(a)).toFixed(2)} ${(-rad * Math.cos(a)).toFixed(2)}`;
  };
  return `M ${pt(-135)} A ${rad} ${rad} 0 1 1 ${pt(135)}`;
}

interface InteractionState {
  /** Captured pointer id, -1 when no pointer drag is active. */
  pointerId: number;
  /** Current knob position in norm 0..1 space (single source while interacting). */
  norm: number;
  /** Last pointer clientY — per-move relative deltas re-baseline Shift for free. */
  lastY: number;
  /** True while a keyboard adjust session awaits its keyup commit. */
  kbActive: boolean;
}

/**
 * Knob legend: fontSize 10; wraps onto two lines at the most central space when
 * wider than the knob footprint (maxW), then width-clamps each line. Two short
 * lines beat one unreadably-squished one at the panels' 52–58-unit knob pitch.
 */
function KnobLabel({ label, r }: { label: string; r: number }) {
  const maxW = 2 * r + 26;
  const text = label.toUpperCase();
  const estW = (s: string) => s.length * 5.6;
  const clamp = (s: string) =>
    estW(s) > maxW ? { textLength: maxW, lengthAdjust: 'spacingAndGlyphs' as const } : {};

  let lines: string[] = [text];
  if (estW(text) > maxW && text.includes(' ')) {
    const mid = text.length / 2;
    let best = -1;
    for (let i = text.indexOf(' '); i !== -1; i = text.indexOf(' ', i + 1)) {
      if (best === -1 || Math.abs(i - mid) < Math.abs(best - mid)) best = i;
    }
    lines = [text.slice(0, best), text.slice(best + 1)];
  }

  return (
    <text
      y={r + 16}
      textAnchor="middle"
      fontFamily={FONT_CONDENSED}
      fontSize={10}
      letterSpacing={0.5}
      fill={COLORS.legend}
    >
      {lines.map((line, i) => (
        <tspan key={i} x={0} dy={i === 0 ? 0 : 10} {...clamp(line)}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

export function Knob({ def, value, onInput, onCommit, size = 'm', accent, x, y }: KnobProps) {
  // useId may contain ':' which breaks url(#...) references — strip to a safe id.
  const gradId = `knob-grad-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  /** Live value while dragging / keyboard-adjusting; null = render from props. */
  const [live, setLive] = useState<number | null>(null);
  /** Reveal the value readout at rest while the pointer is over / the knob is focused. */
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const drag = useRef<InteractionState>({ pointerId: -1, norm: 0, lastY: 0, kbActive: false });
  const gRef = useRef<SVGGElement | null>(null);
  const wheelTimer = useRef<number | null>(null);
  /** Always-current props for the once-attached native wheel listener (avoids staleness). */
  const latest = useRef({ value, def, detents: stepCount(def), onInput, onCommit });

  const r = KNOB_RADIUS[size];
  /** Knob-rim "skirt": machine accent when the panel supplies one, else the gold shade. */
  const skirt = accent ?? COLORS.knobLo;
  const shown = live ?? value;
  const angle = normToAngle(valueToNorm(shown, def));
  const detents = stepCount(def);
  latest.current = { value, def, detents, onInput, onCommit };

  // Mouse-wheel adjust: scroll over a knob to nudge it (the cursor is already ns-resize, so
  // users reach for the wheel). Native non-passive listener — React's onWheel is passive and
  // cannot preventDefault the page scroll. Reuses the keyboard inc; commits once idle (350 ms).
  useEffect(() => {
    const el = gRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const cur = latest.current;
      const s = drag.current;
      const base = s.kbActive || s.pointerId !== -1 ? s.norm : valueToNorm(cur.value, cur.def);
      const inc = cur.detents != null ? 1 / (cur.detents - 1) : e.shiftKey ? 0.001 : 0.01;
      const target = clamp01(base + (e.deltaY < 0 ? inc : -inc)); // wheel up = increase
      if (target === base) return; // at a rail — let the page scroll instead
      e.preventDefault();
      s.norm = target;
      s.kbActive = true;
      const v = normToValue(target, cur.def);
      setLive(v);
      cur.onInput(v);
      if (wheelTimer.current != null) clearTimeout(wheelTimer.current);
      wheelTimer.current = window.setTimeout(() => {
        wheelTimer.current = null;
        const s2 = drag.current;
        if (!s2.kbActive) return;
        s2.kbActive = false;
        setLive(null);
        latest.current.onCommit(normToValue(s2.norm, latest.current.def));
      }, 350);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      if (wheelTimer.current != null) clearTimeout(wheelTimer.current);
    };
  }, []);

  const onPointerDown = (e: ReactPointerEvent<SVGGElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.pointerType === 'touch' && !e.isPrimary) return; // 2nd+ finger: let the browser pinch-zoom, don't grab a knob drag
    const s = drag.current;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    s.pointerId = e.pointerId;
    s.lastY = e.clientY;
    s.norm = valueToNorm(value, def);
    s.kbActive = false;
    setLive(normToValue(s.norm, def));
    e.preventDefault();
  };

  const onPointerMove = (e: ReactPointerEvent<SVGGElement>) => {
    const s = drag.current;
    if (s.pointerId !== e.pointerId) return;
    const upPx = s.lastY - e.clientY; // up = increase
    s.lastY = e.clientY;
    s.norm = clamp01(s.norm + dragDelta(upPx, e.shiftKey));
    const v = normToValue(s.norm, def); // stepped defs snap here, during the drag
    setLive(v); // React bails out when v is unchanged (stepped between detents)
    onInput(v);
  };

  const endDrag = (e: ReactPointerEvent<SVGGElement>) => {
    const s = drag.current;
    if (s.pointerId !== e.pointerId) return;
    s.pointerId = -1;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    setLive(null);
    onCommit(normToValue(s.norm, def));
  };

  const onDoubleClick = () => {
    if (typeof def.default !== 'number') return;
    const v = normToValue(valueToNorm(def.default, def), def); // canonical (snapped)
    onInput(v);
    onCommit(v);
  };

  const onKeyDown = (e: ReactKeyboardEvent<SVGGElement>) => {
    const s = drag.current;
    const base = s.kbActive || s.pointerId !== -1 ? s.norm : valueToNorm(value, def);
    // 1% of range per arrow (Shift = 0.1%); stepped knobs move one whole detent.
    const inc = detents != null ? 1 / (detents - 1) : e.shiftKey ? 0.001 : 0.01;
    let target: number;
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        target = clamp01(base + inc);
        break;
      case 'ArrowDown':
      case 'ArrowLeft':
        target = clamp01(base - inc);
        break;
      case 'Home':
        target = 0;
        break;
      case 'End':
        target = 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    s.norm = target;
    s.kbActive = true;
    const v = normToValue(target, def);
    setLive(v);
    onInput(v);
  };

  /**
   * Commit a pending keyboard adjust: on key up (CONVENTIONS.md) and on blur —
   * if focus leaves mid-hold (Tab, click elsewhere) the keyup lands on another
   * element; without the blur commit the readout sticks and the engine holds a
   * value the store never received (mirrors Button.tsx onBlur={release}).
   */
  const commitKeyboard = () => {
    const s = drag.current;
    if (!s.kbActive) return;
    s.kbActive = false;
    setLive(null);
    onCommit(normToValue(s.norm, def));
  };

  /**
   * Discrete +/- step from the focused stepper buttons. One detent for stepped knobs, else 1%
   * of range (Shift = 0.1%). Reuses the wheel's session + idle-commit so rapid clicks accumulate
   * and commit once when the user stops (the value prop can lag a commit; the session is authoritative).
   */
  const nudge = (dir: 1 | -1, fine: boolean) => {
    const s = drag.current;
    const base = s.kbActive || s.pointerId !== -1 ? s.norm : valueToNorm(value, def);
    const inc = detents != null ? 1 / (detents - 1) : fine ? 0.001 : 0.01;
    const target = clamp01(base + dir * inc);
    if (target === base) return; // already at a rail
    s.norm = target;
    s.kbActive = true;
    const v = normToValue(target, def);
    setLive(v);
    onInput(v);
    if (wheelTimer.current != null) clearTimeout(wheelTimer.current);
    wheelTimer.current = window.setTimeout(() => {
      wheelTimer.current = null;
      const s2 = drag.current;
      if (!s2.kbActive) return;
      s2.kbActive = false;
      setLive(null);
      latest.current.onCommit(normToValue(s2.norm, latest.current.def));
    }, 350);
  };

  // Dial ticks: one per detent for stepped knobs (when legible), else min/center/max.
  const tickAngles =
    detents != null && detents <= 24
      ? Array.from({ length: detents }, (_, i) => normToAngle(i / (detents - 1)))
      : [normToAngle(0), normToAngle(0.5), normToAngle(1)];

  // Shown while interacting AND on hover / keyboard focus, so any knob's value is one
  // point-or-tab away (not only mid-drag). Sources `shown` (= live ?? value).
  const readout = live != null || hovered || focused ? formatValue(shown, def) : null;
  const readoutW = readout != null ? readout.length * 6.4 + 14 : 0;

  return (
    <g
      className="control control--knob"
      ref={gRef}
      transform={`translate(${x} ${y})`}
      tabIndex={0}
      role="slider"
      aria-label={def.panelLabel}
      aria-valuemin={def.min ?? 0}
      aria-valuemax={def.max ?? 1}
      aria-valuenow={shown}
      aria-valuetext={formatValue(shown, def)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
      onKeyUp={commitKeyboard}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        commitKeyboard();
      }}
    >
      <defs>
        <radialGradient id={gradId} cx="0.35" cy="0.3" r="0.85">
          <stop offset="0%" stopColor={COLORS.knobHi} />
          <stop offset="60%" stopColor={COLORS.knob} />
          <stop offset="100%" stopColor={COLORS.knobLo} />
        </radialGradient>
      </defs>

      {/* Enlarged invisible hit target: 's' knobs paint at r=13 but should grab from r>=16,
          so trimmers / step knobs aren't a sub-target. Transparent fill still hit-tests;
          events bubble to the <g> handlers. */}
      <circle r={Math.max(r, 16)} fill="transparent" />

      {/* 270° tick arc + tick marks */}
      <path
        d={arcPath(r + 6)}
        fill="none"
        stroke={COLORS.legendDim}
        strokeWidth={1.2}
        strokeLinecap="round"
        opacity={0.7}
      />
      {tickAngles.map((a) => (
        <line
          key={a}
          transform={`rotate(${a})`}
          y1={-(r + 3.5)}
          y2={-(r + 8.5)}
          stroke={COLORS.legendDim}
          strokeWidth={1}
          opacity={0.8}
        />
      ))}

      {/* cap (shadow skirt + gold body + dark pointer line) */}
      <circle r={r + 2} fill={COLORS.panelShadow} />
      <circle r={r} fill={`url(#${gradId})`} stroke={skirt} strokeWidth={accent ? 1.5 : 1} />
      <g transform={`rotate(${angle})`}>
        <line
          y1={-(r - 2.5)}
          y2={-r * 0.3}
          stroke={COLORS.knobPointer}
          strokeWidth={2.5}
          strokeLinecap="round"
        />
      </g>

      {/* label under, cream — long legends wrap to two lines at the last space
          (e.g. "VCO 1 EG AMOUNT"), then clamp, so neighbors never collide */}
      <KnobLabel label={def.panelLabel} r={r} />

      {/* floating value readout, only while interacting */}
      {readout != null && (
        <g pointerEvents="none">
          <rect
            x={-readoutW / 2}
            y={-(r + 36)}
            width={readoutW}
            height={17}
            rx={4}
            fill={COLORS.panelShadow}
            stroke={COLORS.panelEdge}
            strokeWidth={1}
            opacity={0.95}
          />
          <text
            y={-(r + 24)}
            textAnchor="middle"
            fontFamily={FONT_STACK}
            fontSize={11}
            fill={COLORS.focus}
          >
            {readout}
          </text>
        </g>
      )}

      {/* +/- steppers: revealed once the knob is focused/clicked (a stable target, unlike a
          hover overlay the pointer would leave on the way up). Flank the readout pill; each
          click nudges one step. stopPropagation so the press never starts a knob drag. */}
      {focused &&
        ([-1, 1] as const).map((dir) => (
          <g
            key={dir}
            className="knob-stepper"
            transform={`translate(${dir < 0 ? -(readoutW / 2) - 10 : readoutW / 2 + 10} ${-(r + 27)})`}
            style={{ cursor: 'pointer' }}
            onPointerDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
              nudge(dir, e.shiftKey);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            role="button"
            aria-label={`${dir < 0 ? 'decrease' : 'increase'} ${def.panelLabel}`}
          >
            <rect
              x={-8}
              y={-8.5}
              width={16}
              height={17}
              rx={4}
              fill={COLORS.panelShadow}
              stroke={COLORS.panelEdge}
              strokeWidth={1}
              opacity={0.95}
            />
            <line x1={-4} y1={0} x2={4} y2={0} stroke={COLORS.focus} strokeWidth={1.5} strokeLinecap="round" />
            {dir > 0 && (
              <line x1={0} y1={-4} x2={0} y2={4} stroke={COLORS.focus} strokeWidth={1.5} strokeLinecap="round" />
            )}
          </g>
        ))}
    </g>
  );
}
