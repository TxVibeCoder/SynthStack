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
export const FX_W = 1200;
export const FX_H = 380;

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

const SECTIONS: FxSection[] = [
  {
    id: 'flanger',
    label: 'FLANGER',
    x: 16,
    w: 540,
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
    x: 568,
    w: 372,
    params: [
      { param: 'time', label: 'TIME', min: 0.02, max: 2, def: 0.3, unit: 's' },
      { param: 'feedback', label: 'FEEDBK', min: 0, max: 0.95, def: 0.35 },
      { param: 'mix', label: 'MIX', min: 0, max: 1, def: 0.4 },
    ],
  },
  {
    id: 'reverb',
    label: 'REVERB',
    x: 952,
    w: 232,
    params: [
      { param: 'size', label: 'SIZE', min: 0, max: 1, def: 0.6, commitOnly: true },
      { param: 'mix', label: 'MIX', min: 0, max: 1, def: 0.3 },
    ],
  },
];

const SEC_Y = 44;
const SEC_H = 300;
const TOGGLE_Y = 108;
const KNOB_Y = 248;

const subscribe = (cb: () => void) => engineBridge.store.subscribe(cb);
const getEffects = () => engineBridge.getEffects();
function useEffectsState(): EffectsState {
  return useSyncExternalStore(subscribe, getEffects);
}

/** Evenly-spaced knob column centers across a section's inner width. */
function knobXs(x: number, w: number, n: number): number[] {
  const pad = 56;
  const span = w - pad * 2;
  if (n === 1) return [x + w / 2];
  return Array.from({ length: n }, (_, i) => x + pad + (span * i) / (n - 1));
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
}: {
  id: MasterFxId;
  meta: ParamMeta;
  value: number;
  x: number;
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
  return <Knob def={def} value={value} onInput={onInput} onCommit={onCommit} x={x} y={KNOB_Y} />;
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
        fontSize={14}
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
      <text x={12} y={28} fontFamily={FONT_CONDENSED} fontSize={18} letterSpacing={2} fill={COLORS.legend}>
        MASTER FX
      </text>

      {SECTIONS.map((s) => {
        const fx = effects.master[s.id] as unknown as Record<string, number | boolean>;
        const xs = knobXs(s.x, s.w, s.params.length);
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
            {s.params.map((meta, i) => (
              <ParamKnob key={meta.param} id={s.id} meta={meta} value={fx[meta.param] as number} x={xs[i]!} />
            ))}
          </g>
        );
      })}
    </svg>
  );
});
