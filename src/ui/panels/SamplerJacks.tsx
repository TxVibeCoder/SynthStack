/**
 * SAMPLER pad jacks (Wave-1 3-tab split) — ONLY the 16 OUT/TRIG jacks of the 8 sampler
 * pads, rendered as one SVG that is 1:1 with the SAMPLER_REGION frame (viewBox
 * STAGE.w × PAD_SECTION_H). Mounted by App.tsx on the PATCHBAY tab inside the SAME
 * `<main ref={stageRef}>` as the jack field + cables, so it reads as the 4th patchbay
 * zone and its jacks are patchable by the existing CableLayer for free.
 *
 * The full sampler controls (pad faces, LEVEL/TUNE/LOOP/LOAD/KIT/QUANTIZE) live in
 * SamplerPanel on the SAMPLER tab; this component is jacks-only so the OUT/TRIG sockets
 * co-mount with the rest of the patch field. Both read the SAME padDefs from
 * samplerLayout.ts (single source) — no duplicate jack-id markup exists, because
 * SamplerPanel no longer renders its pad jacks.
 *
 * SAMP_MIX_OUT is intentionally excluded (padDefs only returns the per-pad OUT/TRIG),
 * preserving the 104-jack total + the mixer-ch3 wiring.
 */

import { memo } from 'react';
import { COLORS, FONT_CONDENSED } from '../theme';
import { Jack } from '../controls/Jack';
import { PADS, padDefs, samplerLayout } from './samplerLayout';

export const SamplerJacks = memo(function SamplerJacks() {
  return (
    <svg
      className="panel"
      data-testid="sampler-jacks"
      viewBox={`0 0 ${samplerLayout.width} ${samplerLayout.height}`}
      role="group"
      aria-label="Sampler pad jacks"
    >
      {/* panel face — mirrors SamplerPanel's frame so this reads as the 4th patchbay zone */}
      <rect
        x={0.5}
        y={0.5}
        width={samplerLayout.width - 1}
        height={samplerLayout.height - 1}
        rx={8}
        fill={COLORS.panel}
        stroke={COLORS.panelEdge}
        strokeWidth={1}
      />

      {/* plain-text functional title, top-left — no trade dress */}
      <text
        x={14}
        y={24}
        fontFamily={FONT_CONDENSED}
        fontSize={17}
        letterSpacing={2.5}
        fill={COLORS.legend}
      >
        SAMPLER
      </text>

      {/* the 16 pad jacks — OUT + TRIG per pad. Jack renders circle[data-jack-id],
          patchable for free by the CableLayer. */}
      {PADS.map((cell) => {
        const { out, trig } = padDefs(cell.index);
        return (
          <g key={cell.index}>
            <Jack def={out} x={cell.outX} y={cell.outY} />
            <Jack def={trig} x={cell.trigX} y={cell.trigY} />
          </g>
        );
      })}
    </svg>
  );
});
