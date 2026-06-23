/**
 * Courier replica control SHAPES — the editor-faithful render primitives the CourierPanel
 * composes, in SynthStack's OWN palette (theme.ts COLORS): illuminated square LAMP buttons,
 * compact value-box + caption-list SELECTORS, dropdown boxes, a horizontal lamp selector, the
 * pitch/mod thumb-wheels, sequencer step lamps, and inert DECOR placeholders.
 *
 * All presentational: wired variants take value + a change callback (the panel binds them to
 * the store via useControl); decor variants are static (visual-only, "accounted for in the
 * layout"). Pointer/keyboard idioms mirror controls/{Switch,Button}.tsx (click advances, Shift
 * back, Enter/Space, tabIndex, role=button). No store/engine access here.
 */

import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { memo } from 'react';
import { COLORS, FONT_CONDENSED } from '../theme';

const LIT = COLORS.ledRed; // illuminated lamp fill (the editor lights its toggles warm)

// ---- illuminated square LAMP button (OFF/ON toggles) -------------------------------------

export const LampButton = memo(function LampButton({
  label,
  lit,
  onToggle,
  x,
  y,
  w = 30,
  h = 16,
  accent = LIT,
}: {
  label?: string;
  lit: boolean;
  onToggle: () => void;
  x: number;
  y: number;
  w?: number;
  h?: number;
  accent?: string;
}) {
  return (
    <g
      className="control"
      transform={`translate(${x} ${y})`}
      tabIndex={0}
      role="button"
      aria-pressed={lit}
      aria-label={label ?? 'toggle'}
      style={{ cursor: 'pointer' }}
      onClick={onToggle}
      onKeyDown={(e: ReactKeyboardEvent<SVGGElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      {lit && <rect x={-w / 2 - 2} y={-h / 2 - 2} width={w + 4} height={h + 4} rx={4} fill={accent} opacity={0.22} />}
      <rect
        x={-w / 2}
        y={-h / 2}
        width={w}
        height={h}
        rx={3.5}
        fill={lit ? accent : COLORS.panelRaised}
        stroke={lit ? accent : COLORS.panelEdge}
        strokeWidth={1.2}
      />
      {lit && <rect x={-w / 2 + 3} y={-h / 2 + 2} width={w - 6} height={3} rx={1.5} fill={COLORS.ledRedHot} opacity={0.7} />}
      {label != null && (
        <text
          y={h / 2 + 11}
          textAnchor="middle"
          fontFamily={FONT_CONDENSED}
          fontSize={9}
          letterSpacing={0.3}
          fill={COLORS.legend}
          {...(label.length * 5.2 > w + 22 ? { textLength: w + 22, lengthAdjust: 'spacingAndGlyphs' as const } : {})}
        >
          {label.toUpperCase()}
        </text>
      )}
    </g>
  );
});

// ---- compact value-box SELECTOR (in-band multi-pos switches) ------------------------------

export const SelectorBox = memo(function SelectorBox({
  label,
  display,
  count,
  idx,
  onStep,
  x,
  y,
  w = 40,
}: {
  label: string;
  display: string;
  count: number;
  idx: number;
  onStep: (dir: 1 | -1) => void;
  x: number;
  y: number;
  w?: number;
}) {
  return (
    <g
      className="control"
      transform={`translate(${x} ${y})`}
      tabIndex={0}
      role="button"
      aria-label={`${label}: ${display}`}
      style={{ cursor: 'pointer' }}
      onClick={(e: ReactMouseEvent<SVGGElement>) => onStep(e.shiftKey ? -1 : 1)}
      onKeyDown={(e: ReactKeyboardEvent<SVGGElement>) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onStep(1);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
          e.preventDefault();
          onStep(-1);
        }
      }}
    >
      <text y={-13} textAnchor="middle" fontFamily={FONT_CONDENSED} fontSize={8.5} letterSpacing={0.3} fill={COLORS.legend}>
        {label.toUpperCase()}
      </text>
      <rect x={-w / 2} y={-8} width={w} height={17} rx={3} fill={COLORS.panelShadow} stroke={COLORS.panelEdge} strokeWidth={1} />
      <text
        x={-2}
        y={4}
        textAnchor="middle"
        fontFamily={FONT_CONDENSED}
        fontSize={9.5}
        letterSpacing={0.2}
        fill={COLORS.focus}
        {...(display.length * 5.6 > w - 8 ? { textLength: w - 8, lengthAdjust: 'spacingAndGlyphs' as const } : {})}
      >
        {display.toUpperCase()}
      </text>
      {/* tiny dot ladder showing position */}
      {Array.from({ length: count }, (_, i) => (
        <circle key={i} cx={w / 2 - 4} cy={-4 + i * (12 / Math.max(count - 1, 1))} r={1.1} fill={i === idx ? COLORS.focus : COLORS.legendDim} />
      ))}
    </g>
  );
});

// ---- caption-list SELECTOR (the editor's MODE / MOD DESTINATION look) ---------------------

export const SelectorList = memo(function SelectorList({
  label,
  displays,
  idx,
  onStep,
  x,
  y,
}: {
  label?: string;
  displays: string[];
  idx: number;
  onStep: (dir: 1 | -1) => void;
  x: number;
  y: number;
}) {
  const count = displays.length;
  const lineH = 11;
  const top = -((count - 1) / 2) * lineH;
  return (
    <g
      className="control"
      transform={`translate(${x} ${y})`}
      tabIndex={0}
      role="button"
      aria-label={`${label ?? 'select'}: ${displays[idx]}`}
      style={{ cursor: 'pointer' }}
      onClick={(e: ReactMouseEvent<SVGGElement>) => onStep(e.shiftKey ? -1 : 1)}
      onKeyDown={(e: ReactKeyboardEvent<SVGGElement>) => {
        if (e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
          e.preventDefault();
          onStep(1);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
          e.preventDefault();
          onStep(-1);
        }
      }}
    >
      {/* housing with the active-notch indicator */}
      <rect x={-9} y={top - 4} width={12} height={count * lineH + 2} rx={3} fill={COLORS.panelShadow} stroke={COLORS.panelEdge} strokeWidth={1} />
      <rect x={-7} y={top + idx * lineH - 4} width={8} height={9} rx={2} fill={COLORS.focus} />
      {/* caption list */}
      {displays.map((d, i) => (
        <text
          key={i}
          x={8}
          y={top + i * lineH + 3}
          fontFamily={FONT_CONDENSED}
          fontSize={7.5}
          letterSpacing={0.2}
          fill={i === idx ? COLORS.legend : COLORS.legendDim}
          {...(d.length * 4.4 > 54 ? { textLength: 54, lengthAdjust: 'spacingAndGlyphs' as const } : {})}
        >
          {d.toUpperCase()}
        </text>
      ))}
    </g>
  );
});

// ---- dropdown box (seq selectors: CLOCK DIV / ARP / OCTAVE) -------------------------------

export const Dropdown = memo(function Dropdown({
  label,
  value,
  onAdvance,
  x,
  y,
  w = 76,
}: {
  label: string;
  value: string;
  onAdvance: (dir: 1 | -1) => void;
  x: number;
  y: number;
  w?: number;
}) {
  return (
    <g
      className="control"
      transform={`translate(${x} ${y})`}
      tabIndex={0}
      role="button"
      aria-label={`${label}: ${value}`}
      style={{ cursor: 'pointer' }}
      onClick={(e: ReactMouseEvent<SVGGElement>) => onAdvance(e.shiftKey ? -1 : 1)}
      onKeyDown={(e: ReactKeyboardEvent<SVGGElement>) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onAdvance(1);
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
          e.preventDefault();
          onAdvance(-1);
        }
      }}
    >
      <text y={-12} textAnchor="middle" fontFamily={FONT_CONDENSED} fontSize={8} letterSpacing={0.4} fill={COLORS.legendDim}>
        {label.toUpperCase()}
      </text>
      <rect x={-w / 2} y={-8} width={w} height={18} rx={3} fill={COLORS.panelShadow} stroke={COLORS.panelEdge} strokeWidth={1} />
      <text
        x={-w / 2 + 6}
        y={4}
        fontFamily={FONT_CONDENSED}
        fontSize={9.5}
        letterSpacing={0.2}
        fill={COLORS.legend}
        {...(value.length * 5.6 > w - 22 ? { textLength: w - 22, lengthAdjust: 'spacingAndGlyphs' as const } : {})}
      >
        {value}
      </text>
      <path d={`M ${w / 2 - 11} -2 L ${w / 2 - 5} -2 L ${w / 2 - 8} 3 Z`} fill={COLORS.legendDim} />
    </g>
  );
});

// ---- horizontal 3-lamp selector (LFO 2 DESTINATION: PITCH / CUTOFF / AMP) -----------------

export const LampSelectorH = memo(function LampSelectorH({
  displays,
  idx,
  onPick,
  x,
  y,
  pitch = 56,
}: {
  displays: string[];
  idx: number;
  onPick: (i: number) => void;
  x: number;
  y: number;
  pitch?: number;
}) {
  const n = displays.length;
  const x0 = -((n - 1) / 2) * pitch;
  return (
    <g transform={`translate(${x} ${y})`}>
      {displays.map((d, i) => {
        const lit = i === idx;
        return (
          <g
            key={d}
            className="control"
            transform={`translate(${x0 + i * pitch} 0)`}
            tabIndex={0}
            role="button"
            aria-pressed={lit}
            aria-label={`destination ${d}`}
            style={{ cursor: 'pointer' }}
            onClick={() => onPick(i)}
            onKeyDown={(e: ReactKeyboardEvent<SVGGElement>) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onPick(i);
              }
            }}
          >
            {lit && <rect x={-22} y={-9} width={44} height={18} rx={4} fill={LIT} opacity={0.22} />}
            <rect x={-20} y={-7} width={40} height={14} rx={3} fill={lit ? LIT : COLORS.panelRaised} stroke={lit ? LIT : COLORS.panelEdge} strokeWidth={1.1} />
            <text y={20} textAnchor="middle" fontFamily={FONT_CONDENSED} fontSize={8.5} letterSpacing={0.3} fill={COLORS.legend}>
              {d.toUpperCase()}
            </text>
          </g>
        );
      })}
    </g>
  );
});

// ---- sequencer step lamp -----------------------------------------------------------------

export const StepLamp = memo(function StepLamp({ x, y, on, num }: { x: number; y: number; on: boolean; num: number }) {
  return (
    <g transform={`translate(${x} ${y})`} pointerEvents="none">
      {on && <rect x={-17} y={-8} width={34} height={16} rx={4} fill={LIT} opacity={0.3} />}
      <rect x={-15} y={-6} width={30} height={12} rx={3} fill={on ? LIT : COLORS.panelRaised} stroke={on ? LIT : COLORS.panelEdge} strokeWidth={1} />
      <text y={20} textAnchor="middle" fontFamily={FONT_CONDENSED} fontSize={8} fill={COLORS.legendDim}>
        {num}
      </text>
    </g>
  );
});

// ---- inert DECOR placeholders ------------------------------------------------------------

export const DecorKnob = memo(function DecorKnob({ x, y, label, r = 13 }: { x: number; y: number; label: string; r?: number }) {
  return (
    <g transform={`translate(${x} ${y})`} pointerEvents="none" opacity={0.92}>
      <circle r={r + 2} fill={COLORS.panelShadow} />
      <circle r={r} fill={COLORS.knob} stroke={COLORS.knobLo} strokeWidth={1} />
      <line y1={-(r - 2)} y2={-r * 0.3} stroke={COLORS.knobPointer} strokeWidth={2} strokeLinecap="round" transform="rotate(-30)" />
      <text y={r + 12} textAnchor="middle" fontFamily={FONT_CONDENSED} fontSize={8} letterSpacing={0.2} fill={COLORS.legendDim}>
        {label.toUpperCase()}
      </text>
    </g>
  );
});

export const DecorButton = memo(function DecorButton({
  x,
  y,
  label,
  w = 30,
  h = 16,
  lit = false,
}: {
  x: number;
  y: number;
  label?: string;
  w?: number;
  h?: number;
  lit?: boolean;
}) {
  return (
    <g transform={`translate(${x} ${y})`} pointerEvents="none" opacity={0.92}>
      <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={3.5} fill={lit ? LIT : COLORS.panelRaised} stroke={lit ? LIT : COLORS.panelEdge} strokeWidth={1.1} />
      {label != null && (
        <text
          y={h / 2 + 10}
          textAnchor="middle"
          fontFamily={FONT_CONDENSED}
          fontSize={7.5}
          letterSpacing={0.2}
          fill={COLORS.legendDim}
          {...(label.length * 4.4 > w + 22 ? { textLength: w + 22, lengthAdjust: 'spacingAndGlyphs' as const } : {})}
        >
          {label.toUpperCase()}
        </text>
      )}
    </g>
  );
});

export const DecorDropdown = memo(function DecorDropdown({ x, y, w, label, value }: { x: number; y: number; w: number; label: string; value: string }) {
  return (
    <g transform={`translate(${x} ${y})`} pointerEvents="none" opacity={0.92}>
      <text y={-11} textAnchor="middle" fontFamily={FONT_CONDENSED} fontSize={7} letterSpacing={0.3} fill={COLORS.legendDim}>
        {label.toUpperCase()}
      </text>
      <rect x={-w / 2} y={-7} width={w} height={16} rx={3} fill={COLORS.panelShadow} stroke={COLORS.panelEdge} strokeWidth={1} />
      <text x={-w / 2 + 5} y={4} fontFamily={FONT_CONDENSED} fontSize={8.5} fill={COLORS.legendDim}>
        {value}
      </text>
      <path d={`M ${w / 2 - 10} -2 L ${w / 2 - 5} -2 L ${w / 2 - 7.5} 2 Z`} fill={COLORS.legendDim} />
    </g>
  );
});

export const DecorToggle = memo(function DecorToggle({ x, y, label, positions, idx = 0 }: { x: number; y: number; label: string; positions: string[]; idx?: number }) {
  const lineH = 10;
  const top = -((positions.length - 1) / 2) * lineH;
  return (
    <g transform={`translate(${x} ${y})`} pointerEvents="none" opacity={0.92}>
      <rect x={-8} y={top - 3} width={10} height={positions.length * lineH} rx={2.5} fill={COLORS.panelShadow} stroke={COLORS.panelEdge} strokeWidth={1} />
      <circle cx={-3} cy={top + idx * lineH + 1.5} r={2} fill={COLORS.focus} />
      {positions.map((p, i) => (
        <text key={p} x={7} y={top + i * lineH + 4} fontFamily={FONT_CONDENSED} fontSize={7} fill={i === idx ? COLORS.legend : COLORS.legendDim}>
          {p}
        </text>
      ))}
      <text x={0} y={top + positions.length * lineH + 8} textAnchor="middle" fontFamily={FONT_CONDENSED} fontSize={7} letterSpacing={0.2} fill={COLORS.legendDim}>
        {label.toUpperCase()}
      </text>
    </g>
  );
});

// ---- pitch / mod thumb-wheel (visual only) -----------------------------------------------

export const Wheel = memo(function Wheel({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const ridges = Math.floor(h / 8);
  return (
    <g transform={`translate(${x} ${y})`} pointerEvents="none">
      {/* well */}
      <rect x={-w / 2 - 2} y={-h / 2 - 2} width={w + 4} height={h + 4} rx={w / 2 + 2} fill={COLORS.panelShadow} />
      {/* wheel face */}
      <rect x={-w / 2} y={-h / 2} width={w} height={h} rx={w / 2} fill={COLORS.panelRaised} stroke={COLORS.panelEdge} strokeWidth={1} />
      {/* centre ridge highlight + ridges to read as a wheel */}
      {Array.from({ length: ridges }, (_, i) => {
        const ry = -h / 2 + 6 + i * 8;
        const t = Math.abs(ry) / (h / 2);
        return <line key={i} x1={-w / 2 + 4} x2={w / 2 - 4} y1={ry} y2={ry} stroke={COLORS.legendDim} strokeWidth={1} opacity={0.18 + 0.5 * (1 - t)} />;
      })}
      <line x1={-w / 2 + 3} x2={w / 2 - 3} y1={0} y2={0} stroke={COLORS.legend} strokeWidth={1.5} opacity={0.55} />
    </g>
  );
});
