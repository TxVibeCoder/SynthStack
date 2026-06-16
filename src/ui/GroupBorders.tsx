/**
 * Color-coded group borders — 16:9 layout: a thick
 * outline unifies each machine's controls with its jack-field zone ("these
 * jacks go with these controls"). Yellow = Cascade, Green = Anvil (two outlines —
 * the mixer knobs sit between its halves), Blue = Monarch,
 * violet = mixer (also two outlines: knob block + utility strip).
 *
 * One non-interactive SVG overlay spanning the stage, under the cable layer.
 * Outlines are the layout polygons (stage16x9.GROUP_OUTLINES) inset by
 * GROUP_BORDER_INSET so two groups sharing a seam line (e.g. Cascade|Anvil at
 * x=620.6) render as clean parallel strokes instead of overpainting.
 */

import { memo } from 'react';
import { GROUP_BORDER, GROUP_BORDER_INSET, GROUP_BORDER_WIDTH } from './theme';
import { GROUP_OUTLINES, insetRectilinear, polygonPath, STAGE } from './stage16x9';

const PATHS = GROUP_OUTLINES.map((o) => ({
  group: o.group,
  d: polygonPath(insetRectilinear(o.points, GROUP_BORDER_INSET)),
}));

export const GroupBorders = memo(function GroupBorders() {
  return (
    <svg
      className="group-borders"
      viewBox={`0 0 ${STAGE.w} ${STAGE.h}`}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {PATHS.map(({ group, d }, i) => (
        <path
          key={`${group}-${i}`}
          d={d}
          fill="none"
          stroke={GROUP_BORDER[group]}
          strokeWidth={GROUP_BORDER_WIDTH}
          strokeLinejoin="round"
          opacity={0.85}
        />
      ))}
    </svg>
  );
});
