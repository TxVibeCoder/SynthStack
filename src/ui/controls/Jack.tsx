/**
 * 3.5mm-style jack socket (stage 1: static — cables are stage 2).
 * - Outer hex nut + ferrule ring + dark bore. Inputs read bright-ring-on-dark-nut,
 *   outputs dark-ring-on-bright-nut (ring-tone distinction, CONVENTIONS.md).
 * - Normalled-but-unpatched inputs get a subtle dashed ring (learn-the-normals).
 * - Tooltip (<title>): `panelLabel · IN|OUT · signal`, plus `normalled from X`
 *   where X is the source jack's panelLabel or `<name> (internal)`.
 * - The invisible hit circle (r = JACK_RADIUS.hit) AND the group both carry
 *   data-jack-id={def.id} — the stage-2 CableLayer hit-tests through it.
 */

import { memo } from 'react';
import type { JackDef, ModuleDef } from '../../../data/schema';
import type { JackProps } from '../types';
import { COLORS, FONT_CONDENSED, JACK_RADIUS } from '../theme';
import monarchDef from '../../../data/monarch.json';
import anvilDef from '../../../data/anvil.json';
import cascadeDef from '../../../data/cascade.json';

/** jackId -> panelLabel across all three modules, built lazily on first tooltip. */
let jackLabelById: Map<string, string> | null = null;

function sourceLabel(ref: string): string {
  if (ref.startsWith('INTERNAL:')) return `${ref.slice('INTERNAL:'.length)} (internal)`;
  if (jackLabelById == null) {
    jackLabelById = new Map();
    const defs = [monarchDef, anvilDef, cascadeDef] as unknown as ModuleDef[];
    for (const m of defs) {
      for (const j of m.jacks) jackLabelById.set(j.id, j.panelLabel);
    }
  }
  return jackLabelById.get(ref) ?? ref;
}

function jackTooltip(def: JackDef): string {
  const dir = def.direction === 'in' ? 'IN' : 'OUT';
  let tip = `${def.panelLabel} · ${dir} · ${def.signal}`;
  if (def.normalledTo != null) tip += ` · normalled from ${sourceLabel(def.normalledTo)}`;
  return tip;
}

/** Flat-top hexagon outline at radius `r` (center 0,0). */
function hexPoints(r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 180) * (60 * i + 30);
    pts.push(`${(r * Math.cos(a)).toFixed(2)},${(r * Math.sin(a)).toFixed(2)}`);
  }
  return pts.join(' ');
}

const HEX = hexPoints(JACK_RADIUS.ring + 3);

/** Widest a jack label may render (patchbay cell pitch minus breathing room). */
const JACK_LABEL_MAX_W = 56;

export const Jack = memo(function Jack({ def, x, y }: JackProps) {
  const isOut = def.direction === 'out';
  const nutFill = isOut ? COLORS.jackRing : COLORS.jackRingDark;
  const ringFill = isOut ? COLORS.jackRingDark : COLORS.jackRing;

  return (
    <g className="control" transform={`translate(${x} ${y})`} data-jack-id={def.id}>
      <title>{jackTooltip(def)}</title>

      {/* normalled-input affordance: subtle dashed ring */}
      {def.normalledTo != null && (
        <circle
          r={JACK_RADIUS.ring + 5}
          fill="none"
          stroke={COLORS.legendDim}
          strokeWidth={1}
          strokeDasharray="3 3"
          opacity={0.55}
        />
      )}

      {/* hex nut, ferrule ring, bore */}
      <polygon points={HEX} fill={nutFill} stroke={COLORS.panelShadow} strokeWidth={1} />
      <circle
        r={JACK_RADIUS.ring}
        fill={ringFill}
        stroke={COLORS.panelShadow}
        strokeWidth={1}
      />
      <circle
        r={JACK_RADIUS.hole}
        fill={COLORS.jackHole}
        stroke={COLORS.jackRingDark}
        strokeWidth={1}
      />

      {/* label under — clamped to the patchbay cell pitch so long names
          (e.g. "VC MIX CTRL") compress instead of colliding with neighbors */}
      <text
        y={JACK_RADIUS.ring + 13}
        textAnchor="middle"
        fontFamily={FONT_CONDENSED}
        fontSize={10.5}
        letterSpacing={0.5}
        fill={COLORS.legend}
        {...(def.panelLabel.length * 5.6 > JACK_LABEL_MAX_W
          ? { textLength: JACK_LABEL_MAX_W, lengthAdjust: 'spacingAndGlyphs' as const }
          : {})}
      >
        {def.panelLabel.toUpperCase()}
      </text>

      {/* invisible hit area — MUST carry data-jack-id (stage-2 CableLayer hit-tests it) */}
      <circle r={JACK_RADIUS.hit} fill="transparent" data-jack-id={def.id} />
    </g>
  );
});
