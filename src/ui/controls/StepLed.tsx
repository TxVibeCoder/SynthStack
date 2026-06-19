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
      {on && <circle r={LED_RADIUS * 2.4} fill={COLORS.ledRed} opacity={0.45} />}
      <circle
        r={LED_RADIUS}
        fill={on || dim ? COLORS.ledRed : COLORS.ledOff}
        opacity={!on && dim ? 0.4 : 1}
        stroke={COLORS.panelShadow}
        strokeWidth={1}
      />
      {/* Hot core on the current step: a bright center adds a brightness/shape cue on top of
       * color, so on-vs-off reads for low-vision / color-blind users (not color alone). */}
      {on && <circle r={LED_RADIUS * 0.5} fill={COLORS.ledRedHot} opacity={0.9} />}
    </g>
  );
});
