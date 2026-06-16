/**
 * Sequencer step LED. `on` = current step (bright + glow), `dim` = page-visible-
 * but-not-current ghosting, otherwise unlit lens. Memoized: step chasing re-renders
 * come from the scheduler's uiQueue via rAF (CONVENTIONS.md), so only the LEDs whose
 * props actually flip should redraw.
 */

import { memo } from 'react';
import type { StepLedProps } from '../types';
import { COLORS, LED_RADIUS } from '../theme';

export const StepLed = memo(function StepLed({ x, y, on, dim }: StepLedProps) {
  return (
    <g transform={`translate(${x} ${y})`}>
      {on && <circle r={LED_RADIUS * 2} fill={COLORS.ledRed} opacity={0.28} />}
      <circle
        r={LED_RADIUS}
        fill={on || dim ? COLORS.ledRed : COLORS.ledOff}
        opacity={!on && dim ? 0.4 : 1}
        stroke={COLORS.panelShadow}
        strokeWidth={1}
      />
    </g>
  );
});
