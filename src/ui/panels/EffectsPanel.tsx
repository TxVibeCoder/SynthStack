/**
 * EffectsPanel (Wave 2) — the UI-only FX tab. Three master effects (FLANGER · DELAY ·
 * REVERB), each an ON/OFF latch + param knobs, wired to the bridge's master-FX surface:
 *   ON          -> engineBridge.setMasterFxOn(id, on)               (engine + store)
 *   knob drag   -> engineBridge.setMasterFxParam(id, param, v)      (engine live, no store)
 *   knob release-> engineBridge.commitMasterFxParam(id, param, v)   (engine + store)
 * Reverb SIZE rebuilds the convolver IR, so it is COMMIT-ONLY (no live engine write on drag).
 *
 * Reads the store's `effects` slice via useSyncExternalStore (the single source of truth);
 * a drag re-renders nothing (no store write) — only an ON toggle / commit does. Plain-text
 * functional title + our own typography (no trade dress), matching the voice panels.
 *
 * LAYOUT (UX pass): three EQUAL columns, each effect a 2×2 knob grid under its ON toggle.
 * The canvas was 1200×380 (AR 3.16) — a wide letterboxed strip; it is now 1000×520 (AR
 * 1.92), which the per-tab fill-zoom renders width-bound at ~+16% scale on 1080p while
 * filling the vertical band instead of wasting it. Equal columns give every effect the same
 * frame; Reverb's 2 knobs simply sit in the top row.
 */

import { memo, useCallback, useSyncExternalStore } from 'react';
import type { ControlDef } from '../../../data/schema';
import type { EffectsState } from '../../state/studioState';
import type { MasterFxId } from '../../engine/fx/masterFxChain';
import { COLORS, FONT_CONDENSED } from '../theme';
import { Knob } from '../controls/Knob';
import { Button } from '../controls/Button';
import { engineBridge } from '../engineBridge';

/** Landscape canvas — the panel's own viewBox (App.tsx frames the FX tab to this). */
export const FX_W = 1000;
export const FX_H = 520;

interface ParamMeta {
  param: string;
  label: string;
  min: number;
  max: number;
  def: number;
  unit?: string;
  /** Reverb SIZE rebuilds the IR — apply on commit only (no per-frame engine write). */
  commitOnly?: boolean;
}

interface FxSection {
  id: MasterFxId;
  label: string;
  /** Section frame + on-toggle/knob anchors, viewBox units. */
  x: number;
  w: number;
  params: ParamMeta[];
}

/** Three EQUAL columns: 25 margin · 300 · 25 gap · 300 · 25 gap · 300 · 25 margin = 1000. */
const COL_W = 300;
const SECTIONS: FxSection[] = [
  {
    id: 'flanger',
    label: 'FLANGER',
    x: 25,
    w: COL_W,
    params: [
      { param: 'rate', label: 'RATE', min: 0.05, max: 8, def: 0.4, unit: 'Hz' },
      { param: 'depth', label: 'DEPTH', min: 0, max: 1, def: 0.5 },
      { param: 'feedback', label: 'FEEDBK', min: 0, max: 0.95, def: 0.3 },
      { param: 'mix', label: 'MIX', min: 0, max: 1, def: 0.5 },
    ],
  },
  {
    id: 'delay',
    label: 'DELAY',
    x: 350,
    w: COL_W,
    params: [
      { param: 'time', label: 'TIME', min: 0.02, max: 2, def: 0.3, unit: 's' },
      { param: 'feedback', label: 'FEEDBK', min: 0, max: 0.95, def: 0.35 },
      { param: 'mix', label: 'MIX', min: 0, max: 1, def: 0.4 },
    ],
  },
  {
    id: 'reverb',
    label: 'REVERB',
    x: 675,
    w: COL_W,
    params: [
      { param: 'size', label: 'SIZE', min: 0, max: 1, def: 0.6, commitOnly: true },
      { param: 'mix', label: 'MIX', min: 0, max: 1, def: 0.3 },
    ],
  },
];

const SEC_Y = 56;
const SEC_H = 440; // frame bottom = 496 (< FX_H 520)
const TOGGLE_Y = 120;
/** Two knob rows inside each section (2×2 grid). */
const KNOB_Y1 = 268;
const KNOB_Y2 = 398;

const subscribe = (cb: () => void) => engineBridge.store.subscribe(cb);
const getEffects = () => engineBridge.getEffects();
function useEffectsState(): EffectsState {
  return useSyncExternalStore(subscribe, getEffects);
}

/**
 * Knob center for param `i` of `n`, laid out row-major two-per-row inside a 300-wide section.
 * Left/right columns at x+90 / x+210; a lone trailing knob (odd count) centers at x+150.
 */
function knobSlot(s: FxSection, i: number, n: number): { x: number; y: number } {
  const row = Math.floor(i / 2);
  const y = row === 0 ? KNOB_Y1 : KNOB_Y2;
  const lastOdd = i === n - 1 && n % 2 === 1 && i % 2 === 0;
  const x = lastOdd ? s.x + s.w / 2 : i % 2 === 0 ? s.x + 90 : s.x + 210;
  return { x, y };
}

const FxToggle = memo(function FxToggle({ id, on, x }: { id: MasterFxId; on: boolean; x: number }) {
  const def: ControlDef = { id: `FX_${id}_ON`, panelLabel: '', type: 'button', positions: ['OFF', 'ON'] };
  const onChange = useCallback((pos: string) => engineBridge.setMasterFxOn(id, pos === 'ON'), [id]);
  return <Button def={def} value={on ? 'ON' : 'OFF'} onChange={onChange} lit={on} x={x} y={TOGGLE_Y} />;
});

const ParamKnob = memo(function ParamKnob({
  id,
  meta,
  value,
  x,
  y,
}: {
  id: MasterFxId;
  meta: ParamMeta;
  value: number;
  x: number;
  y: number;
}) {
  const def: ControlDef = {
    id: `FX_${id}_${meta.param}`,
    panelLabel: meta.label,
    type: 'knob',
    min: meta.min,
    max: meta.max,
    default: meta.def,
    ...(meta.unit ? { unit: meta.unit } : {}),
  };
  const onInput = useCallback(
    (v: number) => {
      if (!meta.commitOnly) engineBridge.setMasterFxParam(id, meta.param, v);
    },
    [id, meta.param, meta.commitOnly],
  );
  const onCommit = useCallback(
    (v: number) => engineBridge.commitMasterFxParam(id, meta.param, v),
    [id, meta.param],
  );
  return <Knob def={def} value={value} onInput={onInput} onCommit={onCommit} x={x} y={y} />;
});

function SectionFrame({ s }: { s: FxSection }) {
  const gapW = s.label.length * 7.9 + 12;
  return (
    <g>
      <rect
        x={s.x}
        y={SEC_Y}
        width={s.w}
        height={SEC_H}
        rx={8}
        fill="none"
        stroke={COLORS.panelEdge}
        strokeWidth={1}
      />
      <rect x={s.x + 12} y={SEC_Y - 1.5} width={gapW} height={3} fill={COLORS.panel} />
      <text
        x={s.x + 18}
        y={SEC_Y + 5}
        fontFamily={FONT_CONDENSED}
        fontSize={15}
        letterSpacing={2}
        fill={COLORS.legend}
      >
        {s.label}
      </text>
    </g>
  );
}

export const EffectsPanel = memo(function EffectsPanel() {
  const effects = useEffectsState();
  return (
    <svg
      className="panel"
      viewBox={`0 0 ${FX_W} ${FX_H}`}
      xmlns="http://www.w3.org/2000/svg"
      role="group"
      aria-label="Master effects panel"
    >
      <rect
        width={FX_W}
        height={FX_H}
        rx={8}
        fill={COLORS.panel}
        stroke={COLORS.panelEdge}
        strokeWidth={2}
      />
      <text x={16} y={34} fontFamily={FONT_CONDENSED} fontSize={20} letterSpacing={2} fill={COLORS.legend}>
        MASTER FX
      </text>

      {SECTIONS.map((s) => {
        const fx = effects.master[s.id] as unknown as Record<string, number | boolean>;
        const n = s.params.length;
        return (
          <g key={s.id}>
            <SectionFrame s={s} />
            <FxToggle id={s.id} on={fx.on === true} x={s.x + s.w / 2} />
            <text
              x={s.x + s.w / 2}
              y={TOGGLE_Y + 34}
              textAnchor="middle"
              fontFamily={FONT_CONDENSED}
              fontSize={10}
              letterSpacing={1.5}
              fill={COLORS.legendDim}
            >
              {fx.on ? 'ON' : 'OFF'}
            </text>
            {s.params.map((meta, i) => {
              const slot = knobSlot(s, i, n);
              return (
                <ParamKnob
                  key={meta.param}
                  id={s.id}
                  meta={meta}
                  value={fx[meta.param] as number}
                  x={slot.x}
                  y={slot.y}
                />
              );
            })}
          </g>
        );
      })}
    </svg>
  );
});
