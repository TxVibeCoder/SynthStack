/**
 * COURIER jacks (patchbay tab) — Courier's 9 I/O jacks (4 in · 5 out) as ONE compact zone
 * docked below the consolidated jack field, beside the sampler-jacks cluster. Mounted by
 * App.tsx on the PATCHBAY tab inside the SAME `<main ref={stageRef}>` as the field + cables,
 * so it reads as a 4th voice zone and its jacks are patchable by the existing CableLayer for
 * free (the layer measures jack DOM positions live; the engine already wires every COU_ jack —
 * inputBus for the inputs, outputTap for the outputs — so routing works with no engine change).
 *
 * Courier was added as a voice after the 3-machine field was frozen (its zone keys are fixed at
 * cascade/anvil/monarch + an 88-jack invariant), so rather than re-flow that field this is a
 * self-contained band — the same pattern SamplerJacks uses. Reads its jack defs from the SAME
 * courier.json the engine does (single source); no duplicate jack-id markup exists.
 */

import { memo } from 'react';
import type { JackDef, ModuleDef } from '../../../data/schema';
import courierJson from '../../../data/courier.json';
import { COLORS, FONT_CONDENSED, GROUP_BORDER } from '../theme';
import { Jack } from '../controls/Jack';

const courier = courierJson as unknown as ModuleDef;
const jackById = new Map(courier.jacks.map((j) => [j.id, j as JackDef]));
const ACCENT = GROUP_BORDER.courier;

/** Compact panel viewBox (App.tsx frames COURIER_PATCH_BOX to this aspect). */
export const CJ_W = 410;
export const CJ_H = 150;

/** jackId → band-local centre. INPUTS block left, OUTPUTS block right, in courier.json order. */
export const COURIER_JACK_POS: Record<string, { x: number; y: number }> = {
  // inputs (left of the divider)
  COU_CLOCK_IN: { x: 46, y: 74 },
  COU_EXP_IN: { x: 108, y: 74 },
  COU_SUSTAIN_IN: { x: 46, y: 122 },
  COU_EXT_IN: { x: 108, y: 122 },
  // outputs (right of the divider)
  COU_AUDIO_OUT: { x: 212, y: 74 },
  COU_VCA_OUT: { x: 276, y: 74 },
  COU_GATE_OUT: { x: 340, y: 74 },
  COU_CV_OUT: { x: 212, y: 122 },
  COU_CLOCK_OUT: { x: 276, y: 122 },
};
const DIVIDER_X = 164;

export const CourierJacks = memo(function CourierJacks() {
  return (
    <svg
      className="panel"
      data-testid="courier-jacks"
      viewBox={`0 0 ${CJ_W} ${CJ_H}`}
      role="group"
      aria-label="Courier jacks"
    >
      {/* panel face */}
      <rect x={0.5} y={0.5} width={CJ_W - 1} height={CJ_H - 1} rx={8} fill={COLORS.panel} stroke={COLORS.panelEdge} strokeWidth={1} />

      {/* Courier-accent zone frame + title (mirrors the field zones) */}
      <rect x={4} y={4} width={CJ_W - 8} height={CJ_H - 8} rx={6} fill="none" stroke={ACCENT} strokeWidth={2} opacity={0.8} />
      <rect x={10} y={15} width={70} height={14} fill={COLORS.panel} />
      <text x={14} y={26} fontFamily={FONT_CONDENSED} fontSize={13} letterSpacing={2} fill={ACCENT}>
        COURIER
      </text>

      {/* IN / OUT sub-labels + divider */}
      <text x={78} y={50} textAnchor="middle" fontFamily={FONT_CONDENSED} fontSize={10} letterSpacing={2} fill={COLORS.legendDim}>
        INPUTS
      </text>
      <text x={278} y={50} textAnchor="middle" fontFamily={FONT_CONDENSED} fontSize={10} letterSpacing={2} fill={COLORS.legendDim}>
        OUTPUTS
      </text>
      <line x1={DIVIDER_X} x2={DIVIDER_X} y1={36} y2={CJ_H - 14} stroke={COLORS.panelEdge} strokeWidth={1} strokeDasharray="4 4" />

      {/* the 9 jacks — Jack renders circle[data-jack-id], patchable for free by the CableLayer */}
      {courier.jacks.map((def) => {
        const p = COURIER_JACK_POS[def.id];
        return p ? <Jack key={def.id} def={jackById.get(def.id)!} x={p.x} y={p.y} /> : null;
      })}
    </svg>
  );
});
