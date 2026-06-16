/**
 * Vertical lever switch (2 or 3 positions) — renders from def.positions, index 0
 * at the top. Click advances and wraps (Shift-click goes backward, CONVENTIONS.md);
 * Space/Enter does the same. Discrete change: onChange(pos) -> engine write +
 * store commit together, no debounce.
 */

import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';
import type { SwitchProps } from '../types';
import { COLORS, FONT_CONDENSED } from '../theme';

/** Vertical distance between adjacent lever notches (panel viewBox units). */
const NOTCH_SPACING = 16;
const SLOT_W = 10;

export function Switch({ def, value, onChange, x, y }: SwitchProps) {
  const positions = def.positions ?? [];
  const count = positions.length;
  const idx = Math.max(0, positions.indexOf(value));
  const yOf = (i: number) => (i - (count - 1) / 2) * NOTCH_SPACING;
  const slotH = Math.max(count - 1, 1) * NOTCH_SPACING + 14;

  const advance = (dir: 1 | -1) => {
    if (count < 2) return;
    const next = positions[(idx + dir + count) % count];
    if (next != null && next !== value) onChange(next);
  };

  const onClick = (e: ReactMouseEvent<SVGGElement>) => advance(e.shiftKey ? -1 : 1);

  const onKeyDown = (e: ReactKeyboardEvent<SVGGElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    advance(e.shiftKey ? -1 : 1);
  };

  return (
    <g
      className="control"
      transform={`translate(${x} ${y})`}
      tabIndex={0}
      role="button"
      aria-label={`${def.panelLabel}: ${value}`}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      {/* transparent hit area — the visible parts (a thin 10px slot + glyph-only
          captions) leave large gaps, so a centered click can fall on transparent
          space and pass through to whatever paints behind. This invisible rect
          spans the full control footprint (label above → slot bottom, slot →
          captions) so the whole control is a reliable click/hit target. Painted
          first so it sits behind the visuals; fill carries the hit. */}
      <rect
        x={-34}
        y={-(slotH / 2 + 18)}
        width={84}
        height={slotH / 2 + 18 + slotH / 2}
        fill="transparent"
      />

      {/* label above — fontSize 10 and width-clamped: at 54-unit row pitch an
          unclamped 11px label collides with the label of the row above */}
      <text
        y={-(slotH / 2 + 8)}
        textAnchor="middle"
        fontFamily={FONT_CONDENSED}
        fontSize={10}
        letterSpacing={0.5}
        fill={COLORS.legend}
        {...(def.panelLabel.length * 5.6 > 66
          ? { textLength: 66, lengthAdjust: 'spacingAndGlyphs' as const }
          : {})}
      >
        {def.panelLabel.toUpperCase()}
      </text>

      {/* recessed slot */}
      <rect
        x={-SLOT_W / 2}
        y={-slotH / 2}
        width={SLOT_W}
        height={slotH}
        rx={SLOT_W / 2}
        fill={COLORS.panelShadow}
        stroke={COLORS.panelEdge}
        strokeWidth={1}
      />

      {/* lever paddle at the active notch */}
      <rect
        x={-8}
        y={yOf(idx) - 6}
        width={16}
        height={12}
        rx={3}
        fill={COLORS.jackRing}
        stroke={COLORS.jackRingDark}
        strokeWidth={1}
      />
      <line x1={-5} x2={5} y1={yOf(idx)} y2={yOf(idx)} stroke={COLORS.jackRingDark} strokeWidth={1} />

      {/* position captions beside the lever; active one bright. Clamped to 36
          units so long position names ("FREQUENCY") can't invade the neighbor. */}
      {positions.map((pos, i) => (
        <text
          key={pos}
          x={13}
          y={yOf(i) + 3}
          fontFamily={FONT_CONDENSED}
          fontSize={8.5}
          letterSpacing={0.3}
          fill={i === idx ? COLORS.legend : COLORS.legendDim}
          {...(pos.length * 5 > 36 ? { textLength: 36, lengthAdjust: 'spacingAndGlyphs' as const } : {})}
        >
          {pos.toUpperCase()}
        </text>
      ))}
    </g>
  );
}
