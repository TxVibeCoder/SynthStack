/**
 * Panel button — latching (click cycles def.positions, Shift-click backward) or
 * momentary (`momentary: true`, e.g. HOLD: onChange(active) on pointerdown,
 * onChange(idle) on pointerup/pointercancel; active/idle = last/first position).
 * `lit` (when provided) renders an LED lamp above the cap with a glow while lit.
 * Multi-state buttons show the active position caption on the cap.
 * Discrete change: onChange -> engine write + store commit together, no debounce.
 */

import { useState } from 'react';
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from 'react';
import type { ButtonProps } from '../types';
import { COLORS, FONT_CONDENSED, LED_RADIUS } from '../theme';

const CAP_W = 32;
const CAP_H = 18;

export function Button({ def, value, onChange, lit, momentary, x, y }: ButtonProps) {
  const positions = def.positions && def.positions.length > 0 ? def.positions : ['OFF', 'ON'];
  const idle = positions[0] ?? 'OFF';
  const active = positions[positions.length - 1] ?? 'ON';
  /** Visual pressed state only — never forces parents to re-render. */
  const [pressed, setPressed] = useState(false);
  const hasLamp = lit != null;

  const cycle = (dir: 1 | -1) => {
    if (positions.length < 2) return;
    const i = positions.indexOf(value);
    const next = positions[((i < 0 ? 0 : i) + dir + positions.length) % positions.length];
    if (next != null) onChange(next);
  };

  const press = () => {
    setPressed(true);
    if (momentary) onChange(active);
  };

  const release = () => {
    if (!pressed) return;
    setPressed(false);
    if (momentary) onChange(idle);
  };

  const onPointerDown = (e: ReactPointerEvent<SVGGElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.pointerType === 'touch' && !e.isPrimary) return; // 2nd+ finger: let the browser pinch-zoom, don't latch the button
    e.currentTarget.setPointerCapture(e.pointerId); // momentary release fires even off-cap
    e.currentTarget.focus();
    press();
  };

  const onClick = (e: ReactMouseEvent<SVGGElement>) => {
    if (!momentary) cycle(e.shiftKey ? -1 : 1); // latching: advance + wrap
  };

  const onKeyDown = (e: ReactKeyboardEvent<SVGGElement>) => {
    // Latching buttons step with arrows too (APG / knob parity); momentary buttons don't.
    if (!momentary && (e.key === 'ArrowRight' || e.key === 'ArrowUp')) {
      e.preventDefault();
      cycle(1);
      return;
    }
    if (!momentary && (e.key === 'ArrowLeft' || e.key === 'ArrowDown')) {
      e.preventDefault();
      cycle(-1);
      return;
    }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    if (e.repeat) return;
    if (momentary) {
      press();
    } else {
      setPressed(true);
      cycle(e.shiftKey ? -1 : 1);
    }
  };

  const onKeyUp = (e: ReactKeyboardEvent<SVGGElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    release();
  };

  return (
    <g
      className="control"
      transform={`translate(${x} ${y})`}
      tabIndex={0}
      role="button"
      aria-label={`${def.panelLabel}: ${value}`}
      aria-pressed={momentary ? pressed : positions.length === 2 ? value === active : undefined}
      onPointerDown={onPointerDown}
      onPointerUp={release}
      onPointerCancel={release}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onBlur={release}
    >
      {/* LED lamp above the cap (rendered only when the lit prop is wired) */}
      {hasLamp && (
        <g transform={`translate(0 ${-(CAP_H / 2 + 10)})`}>
          {lit && <circle r={LED_RADIUS * 2.2} fill={COLORS.ledRed} opacity={0.3} />}
          <circle
            r={LED_RADIUS}
            fill={lit ? COLORS.ledRed : COLORS.ledOff}
            stroke={COLORS.panelShadow}
            strokeWidth={1}
          />
          {lit && <circle r={LED_RADIUS * 0.45} cx={-1} cy={-1.2} fill={COLORS.legend} opacity={0.6} />}
        </g>
      )}

      {/* cap, nudged down 1 unit while pressed */}
      <g transform={pressed ? 'translate(0 1)' : undefined}>
        <rect
          x={-CAP_W / 2}
          y={-CAP_H / 2}
          width={CAP_W}
          height={CAP_H}
          rx={4}
          fill={pressed ? COLORS.panelShadow : COLORS.panelRaised}
          stroke={COLORS.panelEdge}
          strokeWidth={1.2}
        />
        {/* active position caption (multi-state readout) */}
        {def.positions != null && def.positions.length > 0 && (
          <text
            y={3}
            textAnchor="middle"
            fontFamily={FONT_CONDENSED}
            fontSize={9.5}
            letterSpacing={0.5}
            fill={COLORS.legend}
            {...(value.length * 6 > 28
              ? { textLength: 28, lengthAdjust: 'spacingAndGlyphs' as const }
              : {})}
          >
            {value.toUpperCase()}
          </text>
        )}
      </g>

      {/* label under the cap, cream — clamped so adjacent buttons at 56–70-unit
          pitch ("RUN/STOP", "ADVANCE", "TRIGGER") never run together */}
      <text
        y={CAP_H / 2 + 13}
        textAnchor="middle"
        fontFamily={FONT_CONDENSED}
        fontSize={10}
        letterSpacing={0.5}
        fill={COLORS.legend}
        {...(def.panelLabel.length * 5.6 > 54
          ? { textLength: 54, lengthAdjust: 'spacingAndGlyphs' as const }
          : {})}
      >
        {def.panelLabel.toUpperCase()}
      </text>
    </g>
  );
}
