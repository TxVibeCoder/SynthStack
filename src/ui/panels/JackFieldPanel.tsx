/**
 * Consolidated jack field (16:9 redesign) — ONE panel holding all 88 jacks,
 * zoned Cascade / Anvil / Monarch left→right. Each zone frames
 * an INPUTS block and an OUTPUTS block with a dashed divider, jacks in module
 * JSON order — the same ordering the per-panel patchbays used, so nothing
 * changes about WHICH jack is which, only where the patchbay lives.
 *
 * Jacks render via <Jack> exactly as before: tooltips, IN/OUT ring-tone
 * distinction, normalled dashed rings, and the data-jack-id contract the
 * CableLayer hit-tests through — cables work here with zero cable-code changes.
 *
 * The panel face is the panel-face polygon: full width, with the top edge
 * stepping down 24 px right of x=1117.56 where the seq strip reaches lower.
 */

import { memo } from 'react';
import type { JackDef, ModuleDef } from '../../../data/schema';
import monarchJson from '../../../data/monarch.json';
import anvilJson from '../../../data/anvil.json';
import cascadeJson from '../../../data/cascade.json';
import { COLORS, FONT_CONDENSED, GROUP_BORDER } from '../theme';
import { Jack } from '../controls/Jack';
import { FIELD, FIELD_FACE, JACK_ZONE_CHROME, jackFieldJacks } from './jackFieldLayout';

const MODULES = [
  cascadeJson,
  anvilJson,
  monarchJson,
] as unknown as ModuleDef[];

function polyPoints(points: ReadonlyArray<readonly [number, number]>): string {
  return points.map(([x, y]) => `${x},${y}`).join(' ');
}

function renderJack(def: JackDef) {
  const p = jackFieldJacks[def.id];
  if (!p) return null;
  return <Jack key={def.id} def={def} x={p.x} y={p.y} />;
}

export const JackFieldPanel = memo(function JackFieldPanel() {
  return (
    // panel--field: pointer-events pass through the UNPAINTED notch above the
    // stepped top edge (x > 1117.56), where this svg overlaps the seq strip's
    // bottom band — see styles.css
    <svg
      className="panel panel--field"
      viewBox={`0 0 ${FIELD.width} ${FIELD.height}`}
      xmlns="http://www.w3.org/2000/svg"
      role="group"
      aria-label="Patchbay — all inputs and outputs"
    >
      {/* stepped panel face outline */}
      <polygon
        points={polyPoints(FIELD_FACE)}
        fill={COLORS.panel}
        stroke={COLORS.panelEdge}
        strokeWidth={1.5}
      />

      {/* zone chrome: frame, machine label, IN/OUT sub-labels, divider */}
      {JACK_ZONE_CHROME.map((zone) => (
        <g key={zone.key}>
          <polygon
            points={polyPoints(zone.frame)}
            fill="none"
            stroke={GROUP_BORDER[zone.key]}
            strokeWidth={2}
            opacity={0.8}
          />
          {/* label in a gap on the frame's top border (SectionFrame idiom) */}
          <rect
            x={zone.labelAt.x - 4}
            y={zone.labelAt.y - 7}
            width={zone.label.length * 8 + 12}
            height={14}
            fill={COLORS.panel}
          />
          <text
            x={zone.labelAt.x}
            y={zone.labelAt.y + 4}
            fontFamily={FONT_CONDENSED}
            fontSize={13}
            letterSpacing={1.5}
            fill={GROUP_BORDER[zone.key]}
          >
            {zone.label}
          </text>
          <text
            x={zone.inLabelAt.x}
            y={zone.inLabelAt.y}
            textAnchor="middle"
            fontFamily={FONT_CONDENSED}
            fontSize={10}
            letterSpacing={2}
            fill={COLORS.legendDim}
          >
            INPUTS
          </text>
          <text
            x={zone.outLabelAt.x}
            y={zone.outLabelAt.y}
            textAnchor="middle"
            fontFamily={FONT_CONDENSED}
            fontSize={10}
            letterSpacing={2}
            fill={COLORS.legendDim}
          >
            OUTPUTS
          </text>
          <line
            x1={zone.divider.x}
            x2={zone.divider.x}
            y1={zone.divider.y1}
            y2={zone.divider.y2}
            stroke={COLORS.panelEdge}
            strokeWidth={1}
            strokeDasharray="4 4"
          />
        </g>
      ))}

      {/* all 88 jacks */}
      {MODULES.map((m) => (
        <g key={m.id}>{m.jacks.map(renderJack)}</g>
      ))}

      {/* on-canvas patch hint (discoverability) — sits in the band below the last jack row */}
      <text
        x={FIELD.width / 2}
        y={FIELD.height - 8}
        textAnchor="middle"
        fontFamily={FONT_CONDENSED}
        fontSize={11}
        letterSpacing={1.5}
        fill={COLORS.legendDim}
        opacity={0.75}
        pointerEvents="none"
      >
        DRAG ONE JACK TO ANOTHER TO PATCH · CLICK A CABLE TO REMOVE IT
      </text>
    </svg>
  );
});
