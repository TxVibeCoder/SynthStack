/**
 * EffectsPanel (Wave 2) — the UI-only FX tab. A TARGET selector (MASTER · CASCADE · ANVIL ·
 * MONARCH) picks what the rack edits; the same four effects (FLANGER · DELAY · REVERB · FOLD),
 * each an ON/OFF latch + param knobs, then drive either the master bus or one voice's insert chain:
 *   ON           -> setMasterFxOn / setVoiceFxOn            (engine + store)
 *   knob drag    -> setMasterFxParam / setVoiceFxParam      (engine live, no store)
 *   knob release -> commitMasterFxParam / commitVoiceFxParam (engine + store)
 * Reverb SIZE rebuilds the convolver IR, so it is COMMIT-ONLY (no live engine write on drag).
 *
 * Per-voice FX is a mixer-channel insert (voice out → flanger→delay→reverb → mixer); the voice's
 * patchbay VCA-OUT jack stays dry. Master FX still sits at the master insertSlot.
 *
 * Reads the store's `effects` slice via useSyncExternalStore (the single source of truth);
 * a drag re-renders nothing (no store write) — only an ON toggle / commit / target switch does.
 *
 * LAYOUT (UX pass): a 2×2 grid of effect sections (FLANGER · DELAY / REVERB · FOLD), each an
 * ON toggle over a row of param knobs; a row of four target tabs sits in the header to the
 * right of the (target-named) title. The 2×2 grid keeps FX_W fixed (App.tsx frames to it).
 */

import { memo, useCallback, useState, useSyncExternalStore } from 'react';
import type { ControlDef } from '../../../data/schema';
import type { EffectsState, MasterEffectsState, VoiceFxId } from '../../state/studioState';
import type { MasterFxId } from '../../engine/fx/masterFxChain';
import { COLORS, FONT_CONDENSED } from '../theme';
import { Knob } from '../controls/Knob';
import { Button } from '../controls/Button';
import { engineBridge } from '../engineBridge';

/** Landscape canvas — the panel's own viewBox (App.tsx frames the FX tab to this). */
export const FX_W = 1000;
export const FX_H = 520;

/** What the FX rack edits: the master bus or one voice's insert chain. */
type FxTarget = 'master' | VoiceFxId;
const TARGETS: { id: FxTarget; label: string }[] = [
  { id: 'master', label: 'MASTER' },
  { id: 'cascade', label: 'CASCADE' },
  { id: 'anvil', label: 'ANVIL' },
  { id: 'monarch', label: 'MONARCH' },
];

// Route an on/param/commit to the master surface or the selected voice's surface.
const fxOn = (t: FxTarget, id: MasterFxId, on: boolean) =>
  t === 'master' ? engineBridge.setMasterFxOn(id, on) : engineBridge.setVoiceFxOn(t, id, on);
const fxParam = (t: FxTarget, id: MasterFxId, param: string, v: number) =>
  t === 'master' ? engineBridge.setMasterFxParam(id, param, v) : engineBridge.setVoiceFxParam(t, id, param, v);
const fxCommit = (t: FxTarget, id: MasterFxId, param: string, v: number) =>
  t === 'master' ? engineBridge.commitMasterFxParam(id, param, v) : engineBridge.commitVoiceFxParam(t, id, param, v);

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
  /** Section frame + on-toggle/knob anchors, viewBox units (assigned by the 2×2 grid below). */
  x: number;
  y: number;
  w: number;
  params: ParamMeta[];
}

/** 2×2 grid: 25 margin · 460 · 30 gap · 460 · 25 margin = 1000; two 210-tall rows. */
const COL_W = 460;
const GRID_X = [25, 25 + COL_W + 30]; // [25, 515]
const GRID_Y = [58, 282]; // row tops (row height 210, 14 gap; row2 bottom = 492)
const SEC_H = 210;

const SECTION_DEFS: { id: MasterFxId; label: string; params: ParamMeta[] }[] = [
  {
    id: 'flanger',
    label: 'FLANGER',
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
    params: [
      { param: 'time', label: 'TIME', min: 0.02, max: 2, def: 0.3, unit: 's' },
      { param: 'feedback', label: 'FEEDBK', min: 0, max: 0.95, def: 0.35 },
      { param: 'mix', label: 'MIX', min: 0, max: 1, def: 0.4 },
    ],
  },
  {
    id: 'reverb',
    label: 'REVERB',
    params: [
      { param: 'size', label: 'SIZE', min: 0, max: 1, def: 0.6, commitOnly: true },
      { param: 'mix', label: 'MIX', min: 0, max: 1, def: 0.3 },
    ],
  },
  {
    id: 'fold',
    label: 'FOLD',
    params: [
      // DRIVE + SYMM rebuild the fold curve (commit-only — see foldCore.ts); MIX stays live.
      // The drive=2 default + 1..8 range is the operator's-ears voicing default.
      { param: 'drive', label: 'DRIVE', min: 1, max: 8, def: 2, commitOnly: true },
      { param: 'symmetry', label: 'SYMM', min: -1, max: 1, def: 0, commitOnly: true },
      { param: 'mix', label: 'MIX', min: 0, max: 1, def: 0.5 },
    ],
  },
];

/** Place the four sections row-major into the 2×2 grid (col = i%2, row = floor(i/2)). */
const SECTIONS: FxSection[] = SECTION_DEFS.map((d, i) => ({
  ...d,
  x: GRID_X[i % 2]!,
  y: GRID_Y[Math.floor(i / 2)]!,
  w: COL_W,
}));

/** Anchors are RELATIVE to each section's y (added in the render). */
const TOGGLE_DY = 60;
/** Single knob row inside each section (wide column fits up to 4 knobs side by side). */
const KNOB_DY = 150;

// Target tabs in the header.
const TAB_W = 150;
const TAB_GAP = 8;
const TABS_X0 = FX_W - 25 - (TARGETS.length * TAB_W + (TARGETS.length - 1) * TAB_GAP); // right-aligned
const TAB_Y = 14;
const TAB_H = 26;

const subscribe = (cb: () => void) => engineBridge.store.subscribe(cb);
const getEffects = () => engineBridge.getEffects();
function useEffectsState(): EffectsState {
  return useSyncExternalStore(subscribe, getEffects);
}

/**
 * Knob center for param `i` of `n`, laid out in a single evenly-spaced row inside the wide
 * section (the 460-wide column fits up to 4 knobs). Slots are centered across the section width.
 */
function knobSlot(s: FxSection, i: number, n: number): { x: number; y: number } {
  const x = s.x + (s.w * (i + 1)) / (n + 1);
  return { x, y: s.y + KNOB_DY };
}

const FxToggle = memo(function FxToggle({
  id,
  on,
  x,
  y,
  target,
}: {
  id: MasterFxId;
  on: boolean;
  x: number;
  y: number;
  target: FxTarget;
}) {
  const def: ControlDef = { id: `FX_${id}_ON`, panelLabel: '', type: 'button', positions: ['OFF', 'ON'] };
  const onChange = useCallback((pos: string) => fxOn(target, id, pos === 'ON'), [id, target]);
  return <Button def={def} value={on ? 'ON' : 'OFF'} onChange={onChange} lit={on} x={x} y={y} />;
});

const ParamKnob = memo(function ParamKnob({
  id,
  meta,
  value,
  x,
  y,
  target,
}: {
  id: MasterFxId;
  meta: ParamMeta;
  value: number;
  x: number;
  y: number;
  target: FxTarget;
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
      if (!meta.commitOnly) fxParam(target, id, meta.param, v);
    },
    [id, meta.param, meta.commitOnly, target],
  );
  const onCommit = useCallback((v: number) => fxCommit(target, id, meta.param, v), [id, meta.param, target]);
  return <Knob def={def} value={value} onInput={onInput} onCommit={onCommit} x={x} y={y} />;
});

function SectionFrame({ s }: { s: FxSection }) {
  const gapW = s.label.length * 7.9 + 12;
  return (
    <g>
      <rect
        x={s.x}
        y={s.y}
        width={s.w}
        height={SEC_H}
        rx={8}
        fill="none"
        stroke={COLORS.panelEdge}
        strokeWidth={1}
      />
      <rect x={s.x + 12} y={s.y - 1.5} width={gapW} height={3} fill={COLORS.panel} />
      <text
        x={s.x + 18}
        y={s.y + 5}
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
  const [target, setTarget] = useState<FxTarget>('master');
  const chain: MasterEffectsState = target === 'master' ? effects.master : effects.voices[target];
  const title = target === 'master' ? 'MASTER FX' : `${target.toUpperCase()} FX`;
  return (
    <svg
      className="panel"
      viewBox={`0 0 ${FX_W} ${FX_H}`}
      xmlns="http://www.w3.org/2000/svg"
      role="group"
      aria-label="Effects panel"
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
        {title}
      </text>

      {/* target tabs: MASTER / CASCADE / ANVIL / MONARCH */}
      {TARGETS.map((t, i) => {
        const active = t.id === target;
        const tx = TABS_X0 + i * (TAB_W + TAB_GAP);
        return (
          <g
            key={t.id}
            transform={`translate(${tx} ${TAB_Y})`}
            style={{ cursor: 'pointer' }}
            onPointerDown={(e) => {
              e.preventDefault();
              setTarget(t.id);
            }}
            role="button"
            aria-pressed={active}
            aria-label={`${t.label} effects`}
          >
            <rect
              width={TAB_W}
              height={TAB_H}
              rx={5}
              fill={active ? COLORS.focus : COLORS.panelShadow}
              stroke={active ? COLORS.focus : COLORS.panelEdge}
              strokeWidth={1}
              opacity={active ? 0.95 : 0.85}
            />
            <text
              x={TAB_W / 2}
              y={18}
              textAnchor="middle"
              fontFamily={FONT_CONDENSED}
              fontSize={12}
              letterSpacing={1.5}
              fill={active ? COLORS.panel : COLORS.legend}
            >
              {t.label}
            </text>
          </g>
        );
      })}

      {SECTIONS.map((s) => {
        const fx = chain[s.id] as unknown as Record<string, number | boolean>;
        const n = s.params.length;
        return (
          <g key={s.id}>
            <SectionFrame s={s} />
            <FxToggle id={s.id} on={fx.on === true} x={s.x + s.w / 2} y={s.y + TOGGLE_DY} target={target} />
            <text
              x={s.x + s.w / 2}
              y={s.y + TOGGLE_DY + 34}
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
                  target={target}
                />
              );
            })}
          </g>
        );
      })}
    </svg>
  );
});
