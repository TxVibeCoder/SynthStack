/**
 * SAMPLER pad jacks (patchbay tab) — ONLY the 16 OUT/TRIG jacks of the 8 sampler pads,
 * rendered as one COMPACT SVG docked directly below the consolidated jack field. Mounted
 * by App.tsx on the PATCHBAY tab inside the SAME `<main ref={stageRef}>` as the jack field
 * + cables, so it reads as a small 4th patchbay cluster and its jacks are patchable by the
 * existing CableLayer for free (the layer measures jack DOM positions live).
 *
 * The full sampler controls (pad faces, LEVEL/TUNE/LOOP/LOAD/KIT/QUANTIZE) live in
 * SamplerPanel on the SAMPLER tab; this component is jacks-only. Both read the SAME
 * padDefs from samplerLayout.ts (single source) — no duplicate jack-id markup exists.
 * The 8 pads tile one compact row of columns, OUT over TRIG, instead of the old full-
 * width 4×2 pad spread (a quarter of the footprint).
 *
 * SAMP_MIX_OUT is intentionally excluded (padDefs only returns the per-pad OUT/TRIG),
 * preserving the 104-jack total + the mixer-ch3 wiring.
 */

import { memo } from 'react';
import { COLORS, FONT_CONDENSED } from '../theme';
import { Jack } from '../controls/Jack';
import { PADS, padDefs } from './samplerLayout';

/** Compact panel viewBox (App.tsx frames SAMPLER_PATCH_BOX to this aspect). */
const SJ_W = 660;
const SJ_H = 150;
/** Eight pad columns (one per pad), 81-unit pitch. */
const COL_X = [46, 127, 208, 289, 370, 451, 532, 613] as const;
/** OUT jack row over TRIG jack row. */
const OUT_Y = 62;
const TRIG_Y = 116;

export const SamplerJacks = memo(function SamplerJacks() {
  return (
    <svg
      className="panel"
      data-testid="sampler-jacks"
      viewBox={`0 0 ${SJ_W} ${SJ_H}`}
      role="group"
      aria-label="Sampler pad jacks"
    >
      {/* panel face — mirrors the other patchbay zones */}
      <rect
        x={0.5}
        y={0.5}
        width={SJ_W - 1}
        height={SJ_H - 1}
        rx={8}
        fill={COLORS.panel}
        stroke={COLORS.panelEdge}
        strokeWidth={1}
      />

      {/* plain-text functional title, top-left — no trade dress */}
      <text
        x={14}
        y={22}
        fontFamily={FONT_CONDENSED}
        fontSize={14}
        letterSpacing={2.5}
        fill={COLORS.legend}
      >
        SAMPLER
      </text>

      {/* the 16 pad jacks — OUT over TRIG per pad column. Jack renders
          circle[data-jack-id], patchable for free by the CableLayer. */}
      {PADS.map((cell) => {
        const { out, trig } = padDefs(cell.index);
        const x = COL_X[cell.index] ?? COL_X[0];
        return (
          <g key={cell.index}>
            <Jack def={out} x={x} y={OUT_Y} />
            <Jack def={trig} x={x} y={TRIG_Y} />
          </g>
        );
      })}
    </svg>
  );
});
