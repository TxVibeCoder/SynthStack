/**
 * SAMPLER panel (feature-sampler-pads) — the 8-pad section below the 16:9 fold,
 * rendered as ONE SVG inside the scaled stage container so its OUT/TRIG jacks are
 * patchable by the existing CableLayer for free. Mounted by App.tsx (g5) as
 * `<Region box={SAMPLER_REGION} testId="sampler-section"><SamplerPanel/></Region>`.
 *
 * Each pad is a memoized cell:
 *  - a click-to-audition face that is also a drag-and-drop target for a sample file
 *  - LEVEL + TUNE knobs (the existing coordinate-driven Knob control)
 *  - OUT + TRIG jacks (the existing Jack control — renders the data-jack-id hit
 *    circle the CableLayer hit-tests)
 *  - a sample-name label and a LOAD button (file picker)
 *
 * Data flow (CONVENTIONS.md): pad params live in
 * state.sampler.pads[n], NOT state.controls — so they go through the bridge's
 * pad API (setPadControl / commitPadControl), NEVER through useControl('sampler',
 * id) which would route them into applyState's controls loop (skipped for the
 * sampler) and lose them. Knob drags hit the engine imperatively via setPadControl
 * and commit the store once on release via commitPadControl, exactly like the
 * other panels' onInput/onCommit split. Click-to-audition and sample loading are
 * dedicated bridge actions.
 *
 * Pad meta (sampleName / level / tuneSemis) is subscribed via useSyncExternalStore
 * directly on engineBridge.store with a per-pad cached snapshot (the store clones
 * on every getState, so an uncached snapshot would loop) — the panel's only state
 * read; everything else flows imperatively through the bridge.
 */

import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { ControlDef, JackDef, ModuleDef } from '../../../data/schema';
import samplerJson from '../../../data/sampler.json';
import { COLORS, FONT_CONDENSED } from '../theme';
import { Knob } from '../controls/Knob';
import { Jack } from '../controls/Jack';
import { Switch } from '../controls/Switch';
import { engineBridge } from '../engineBridge';
import { SampleTooLargeError } from '../../engine/sampleStore';
import { FACTORY_KIT } from '../../engine/factorySamples';
import type { PadState, QuantizeDivision } from '../../state/studioState';
import { PADS, QUANT, samplerLayout, type PadCell } from './samplerLayout';

const samplerDef = samplerJson as unknown as ModuleDef;

// ---- per-pad control / jack defs (from sampler.json, by id) ----------------------------

const controlById = new Map<string, ControlDef>(samplerDef.controls.map((c) => [c.id, c]));
const jackById = new Map<string, JackDef>(samplerDef.jacks.map((j) => [j.id, j]));

/** Defs for pad n (1-based id suffix). Throws at module load if the JSON drifts. */
function padDefs(padIndex: number): {
  level: ControlDef;
  tune: ControlDef;
  loop: ControlDef;
  out: JackDef;
  trig: JackDef;
} {
  const n = padIndex + 1;
  const level = controlById.get(`SAMP_PAD${n}_LEVEL`);
  const tune = controlById.get(`SAMP_PAD${n}_TUNE`);
  const loop = controlById.get(`SAMP_PAD${n}_LOOP`);
  const out = jackById.get(`SAMP_PAD${n}_OUT`);
  const trig = jackById.get(`SAMP_PAD${n}_TRIG_IN`);
  if (!level || !tune || !loop || !out || !trig) {
    throw new Error(`sampler.json missing defs for pad ${n}`);
  }
  return { level, tune, loop, out, trig };
}

/** The single global QUANTIZE selector def. Throws at module load if the JSON drifts. */
const quantizeDef = (() => {
  const def = controlById.get('SAMP_QUANTIZE');
  if (!def) throw new Error('sampler.json missing SAMP_QUANTIZE def');
  return def;
})();

// ---- pad-meta subscription -------------------------------------------------------------
// useSyncExternalStore needs a STABLE snapshot when nothing changed (the store
// clones on every getState, so returning a fresh object each call would loop).
// Cache the last PadState per pad and only mint a new object when a field differs.

const padSnapshotCache: (PadState | null)[] = Array.from({ length: PADS.length }, () => null);

function padSnapshot(padIndex: number): PadState {
  const next = engineBridge.getPadState(padIndex);
  const prev = padSnapshotCache[padIndex];
  if (
    prev &&
    prev.sampleId === next.sampleId &&
    prev.sampleName === next.sampleName &&
    prev.level === next.level &&
    prev.tuneSemis === next.tuneSemis &&
    prev.loop === next.loop
  ) {
    return prev;
  }
  padSnapshotCache[padIndex] = next;
  return next;
}

const subscribeStore = (onChange: () => void) => engineBridge.store.subscribe(onChange);

/** Subscribe ONE pad's meta; re-renders that pad only when its slice changes. */
function usePad(padIndex: number): PadState {
  const getSnapshot = useCallback(() => padSnapshot(padIndex), [padIndex]);
  return useSyncExternalStore(subscribeStore, getSnapshot);
}

// getQuantize returns a stable string primitive (reference-stable across getState
// clones, unlike the pad object) so it needs no snapshot caching for the loop guard.
const getQuantizeSnapshot = () => engineBridge.getQuantize();

/** Subscribe the single global QUANTIZE selector. */
function useQuantize(): QuantizeDivision {
  return useSyncExternalStore(subscribeStore, getQuantizeSnapshot);
}

// ---- single pad cell -------------------------------------------------------------------

interface PadProps {
  cell: PadCell;
  /** Open the shared file picker targeted at this pad. */
  onLoadClick: (padIndex: number) => void;
  /** Open the factory-sound picker menu anchored on this pad's KIT trigger. */
  onKitClick: (padIndex: number, trigger: SVGGElement) => void;
  /** Surface a load error (too-large / decode) to the panel. */
  onError: (message: string) => void;
}

/** Map a load rejection to a short user-facing message. */
function loadErrorMessage(err: unknown): string {
  return err instanceof SampleTooLargeError ? 'Sample too large (max 4 MB)' : 'Load failed';
}

/** Clamp the sample-name label to the pad-face width so long names don't overflow. */
const NAME_MAX_W = 92;

const Pad = memo(function Pad({ cell, onLoadClick, onKitClick, onError }: PadProps) {
  const { index } = cell;
  const pad = usePad(index);
  const { level, tune, loop, out, trig } = padDefs(index);

  const onDrop = (e: React.DragEvent<SVGRectElement>) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    e.preventDefault();
    engineBridge.loadPadSample(index, file).catch((err) => onError(loadErrorMessage(err)));
  };

  const name = pad.sampleName ?? 'EMPTY';
  const empty = pad.sampleName == null;

  return (
    <g className="control">
      {/* pad face — real (non-`none`) fill so onDrop fires reliably on an SVG rect */}
      <rect
        data-testid={`pad-${index}`}
        role="button"
        tabIndex={0}
        aria-label={`Pad ${index + 1} — audition / drop a sample`}
        x={cell.faceX - cell.faceW / 2}
        y={cell.faceY - cell.faceH / 2}
        width={cell.faceW}
        height={cell.faceH}
        rx={6}
        fill={COLORS.panelRaised}
        stroke={empty ? COLORS.panelEdge : COLORS.knob}
        strokeWidth={empty ? 1 : 1.5}
        onPointerDown={() => engineBridge.auditionPad(index)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
      />

      {/* big pad number, centered on the face */}
      <text
        x={cell.faceX}
        y={cell.faceY + 9}
        textAnchor="middle"
        fontFamily={FONT_CONDENSED}
        fontSize={28}
        letterSpacing={1}
        fill={COLORS.legendDim}
        pointerEvents="none"
      >
        {index + 1}
      </text>

      {/* sample-name label under the face (clamped like Jack.tsx for long names) */}
      <text
        x={cell.nameX}
        y={cell.nameY}
        textAnchor="middle"
        fontFamily={FONT_CONDENSED}
        fontSize={10}
        letterSpacing={0.5}
        fill={empty ? COLORS.legendDim : COLORS.legend}
        pointerEvents="none"
        {...(name.length * 5.6 > NAME_MAX_W
          ? { textLength: NAME_MAX_W, lengthAdjust: 'spacingAndGlyphs' as const }
          : {})}
      >
        {name.toUpperCase()}
      </text>

      {/* LOAD button (file picker) — its own data-testid for the e2e setInputFiles flow */}
      <g
        data-testid={`pad-${index}-load`}
        role="button"
        tabIndex={0}
        aria-label={`Load a sample into pad ${index + 1}`}
        style={{ cursor: 'pointer' }}
        onClick={() => onLoadClick(index)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onLoadClick(index);
          }
        }}
      >
        <rect
          x={cell.loadX - 28}
          y={cell.loadY - 11}
          width={56}
          height={22}
          rx={5}
          fill={COLORS.panelRaised}
          stroke={COLORS.panelEdge}
          strokeWidth={1}
        />
        <text
          x={cell.loadX}
          y={cell.loadY + 4}
          textAnchor="middle"
          fontFamily={FONT_CONDENSED}
          fontSize={11}
          letterSpacing={1}
          fill={COLORS.legend}
          pointerEvents="none"
        >
          LOAD
        </text>
      </g>

      {/* KIT factory-picker trigger — a small SVG button in the cell's top-right corner. Markup
          MIRRORS the LOAD <g> (hit area = the drawn ~34×14 rect, NO oversized transparent rect),
          so it never occludes the OUT/TRIG jack hit-circles below it (pinned by samplerLayout.test
          kitHitRect). Click captures the trigger element so the panel anchors the portaled menu to
          its on-screen (screen-pixel) rect. Enter/Space activate it for keyboard users. */}
      <g
        data-testid={`pad-${index}-kit`}
        role="button"
        tabIndex={0}
        aria-label={`Choose a factory sound for pad ${index + 1}`}
        aria-haspopup="listbox"
        style={{ cursor: 'pointer' }}
        onClick={(e) => onKitClick(index, e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onKitClick(index, e.currentTarget);
          }
        }}
      >
        <rect
          x={cell.kitX - 17}
          y={cell.kitY - 7}
          width={34}
          height={14}
          rx={4}
          fill={COLORS.panelRaised}
          stroke={COLORS.panelEdge}
          strokeWidth={1}
        />
        <text
          x={cell.kitX}
          y={cell.kitY + 3}
          textAnchor="middle"
          fontFamily={FONT_CONDENSED}
          fontSize={9}
          letterSpacing={1}
          fill={COLORS.legendDim}
          pointerEvents="none"
        >
          KIT
        </text>
      </g>

      {/* LEVEL + TUNE knobs — pad params route through the bridge's pad API, NOT
          useControl('sampler', id). onInput = immediate engine write (drag),
          onCommit = one store write (release). */}
      <Knob
        def={level}
        value={pad.level}
        onInput={(v) => engineBridge.setPadControl(index, 'level', v)}
        onCommit={(v) => engineBridge.commitPadControl(index, 'level', v)}
        x={cell.levelX}
        y={cell.levelY}
      />
      <Knob
        def={tune}
        value={pad.tuneSemis}
        onInput={(v) => engineBridge.setPadControl(index, 'tuneSemis', v)}
        onCommit={(v) => engineBridge.commitPadControl(index, 'tuneSemis', v)}
        x={cell.tuneX}
        y={cell.tuneY}
      />

      {/* OUT + TRIG jacks — Jack renders circle[data-jack-id], patchable for free */}
      <Jack def={out} x={cell.outX} y={cell.outY} />
      <Jack def={trig} x={cell.trigX} y={cell.trigY} />

      {/* per-pad LOOP toggle — Switch emits no data-testid of its own, so wrap it
          for the e2e click target. Declarative: setPadLoop only changes which path
          the NEXT pad tap takes (launch vs stop vs one-shot), it does NOT start audio. */}
      <g data-testid={`pad-${index}-loop`}>
        <Switch
          def={loop}
          value={pad.loop ? 'ON' : 'OFF'}
          onChange={(pos) => engineBridge.setPadLoop(index, pos === 'ON')}
          x={cell.loopX}
          y={cell.loopY}
        />
      </g>
    </g>
  );
});

// ---- factory-sound picker menu ---------------------------------------------------------
// A compact dropdown of the 8 FACTORY_KIT sounds, opened from a pad's KIT trigger. It is
// plain HTML (NOT SVG) portaled to document.body — like the PresetPicker overlay it MUST live
// OUTSIDE the transform:scale stage, so it is screen-pixel sized rather than console-scaled and
// positions itself from the trigger's getBoundingClientRect (captured at open). A row click
// routes through engineBridge.assignFactoryToPad (the ONLY write path — it reference-gates the
// freeing of any replaced user sample) then closes. Backdrop click + Escape close; the menu is
// focused on open so Esc has a target; focus returns to the trigger on close (handled by the
// panel). One menu is open at a time (the panel holds a single openPad).

/** Inline style tokens reuse the existing :root CSS custom properties (no new color props). */
const KIT_MENU_Z = 45; // below the PresetPicker .preset-overlay (z-index 50)

interface KitMenuProps {
  /** The pad the menu assigns to (0..7). */
  padIndex: number;
  /** The KIT trigger's screen rect, for fixed positioning. */
  anchorRect: DOMRect;
  /** Assign a factory sound to the pad and close. */
  onAssign: (padIndex: number, factoryId: string) => void;
  /** Close without assigning (backdrop / Escape / after a pick). */
  onClose: () => void;
}

function KitMenu({ padIndex, anchorRect, onAssign, onClose }: KitMenuProps) {
  const pad = usePad(padIndex);
  const listRef = useRef<HTMLUListElement | null>(null);

  // Focus the list on open so Escape (and arrow scrolling) has a keyboard target.
  useEffect(() => {
    listRef.current?.focus();
  }, []);

  // Position the fixed menu just below the trigger, clamped to stay on-screen. The menu is
  // ~160px wide; nudge left if the trigger is near the right viewport edge.
  const MENU_W = 168;
  const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - MENU_W - 8));
  const top = anchorRect.bottom + 4;

  return createPortal(
    <div
      className="kit-menu-backdrop"
      style={{ position: 'fixed', inset: 0, zIndex: KIT_MENU_Z }}
      onClick={onClose}
    >
      <ul
        ref={listRef}
        className="kit-menu"
        role="listbox"
        tabIndex={-1}
        aria-label={`Factory sound for pad ${padIndex + 1}`}
        data-testid={`pad-${padIndex}-kit-menu`}
        style={{
          position: 'fixed',
          left,
          top,
          width: MENU_W,
          margin: 0,
          padding: 4,
          listStyle: 'none',
          background: 'var(--color-panel-raised)',
          border: '1px solid var(--color-panel-edge)',
          borderRadius: 6,
          boxShadow: '0 8px 28px rgba(0, 0, 0, 0.55)',
          fontFamily: 'var(--font-condensed)',
          maxHeight: '60vh',
          overflowY: 'auto',
        }}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      >
        {FACTORY_KIT.map((entry) => {
          const selected = pad.sampleId === entry.id;
          return (
            <li
              key={entry.id}
              role="option"
              aria-selected={selected}
              data-testid={`pad-kit-option-${entry.id}`}
              tabIndex={0}
              onClick={() => onAssign(padIndex, entry.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onAssign(padIndex, entry.id);
                }
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
                fontSize: 13,
                letterSpacing: 0.5,
                color: selected ? 'var(--color-legend)' : 'var(--color-legend-dim)',
                borderRadius: 4,
                cursor: 'pointer',
              }}
            >
              <span
                aria-hidden="true"
                style={{ width: 12, flex: '0 0 auto', color: 'var(--color-focus)' }}
              >
                {selected ? '✓' : ''}
              </span>
              <span>{entry.name}</span>
            </li>
          );
        })}
      </ul>
    </div>,
    document.body,
  );
}

// ---- panel -----------------------------------------------------------------------------

export function SamplerPanel() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** Pad the hidden picker currently targets (set just before input.click()). */
  const activePadRef = useRef<number>(0);
  const [error, setError] = useState<string | null>(null);
  const quantize = useQuantize();

  /** Factory-picker menu: the pad it targets (null = closed) + its trigger's screen rect. */
  const [kitMenu, setKitMenu] = useState<{ padIndex: number; anchorRect: DOMRect } | null>(null);
  /** The KIT trigger that opened the menu — focus returns to it on close. */
  const kitTriggerRef = useRef<SVGGElement | null>(null);

  const onLoadClick = useCallback((padIndex: number) => {
    activePadRef.current = padIndex;
    setError(null);
    const input = fileInputRef.current;
    if (input) {
      input.value = ''; // allow re-picking the same file (onChange fires on equal value otherwise never)
      input.click();
    }
  }, []);

  const onKitClick = useCallback((padIndex: number, trigger: SVGGElement) => {
    kitTriggerRef.current = trigger;
    setKitMenu({ padIndex, anchorRect: trigger.getBoundingClientRect() });
  }, []);

  const closeKitMenu = useCallback(() => {
    setKitMenu(null);
    // Return focus to the trigger so keyboard users land back where they were.
    kitTriggerRef.current?.focus();
    kitTriggerRef.current = null;
  }, []);

  const onKitAssign = useCallback(
    (padIndex: number, factoryId: string) => {
      engineBridge.assignFactoryToPad(padIndex, factoryId);
      closeKitMenu();
    },
    [closeKitMenu],
  );

  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    engineBridge
      .loadPadSample(activePadRef.current, file)
      .catch((err) => setError(err instanceof SampleTooLargeError ? 'Sample too large (max 4 MB)' : 'Load failed'));
  }, []);

  return (
    <>
      {/* one React-managed hidden picker shared by all 8 LOAD buttons (e2e setInputFiles target) */}
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        data-testid="sampler-file-input"
        style={{ display: 'none' }}
        onChange={onFileChange}
      />

      <svg
        className="panel"
        data-testid="sampler-panel"
        viewBox={`0 0 ${samplerLayout.width} ${samplerLayout.height}`}
        role="group"
        aria-label={`${samplerLayout.title} panel`}
      >
        {/* panel face */}
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
          {samplerLayout.title.toUpperCase()}
        </text>

        {/* transient load-error message, top-right */}
        {error != null && (
          <text
            x={samplerLayout.width - 14}
            y={24}
            textAnchor="end"
            fontFamily={FONT_CONDENSED}
            fontSize={12}
            letterSpacing={0.5}
            fill={COLORS.ledRed}
          >
            {error.toUpperCase()}
          </text>
        )}

        {/* single global launch-quantize selector, header top-right (synced to the
            Monarch master tempo by the engine). Wrapped for the e2e click target. */}
        <g data-testid="sampler-quantize">
          <Switch
            def={quantizeDef}
            value={quantize}
            onChange={(pos) => engineBridge.setQuantize(pos as QuantizeDivision)}
            x={QUANT.x}
            y={QUANT.y}
          />
        </g>

        {PADS.map((cell) => (
          <Pad
            key={cell.index}
            cell={cell}
            onLoadClick={onLoadClick}
            onKitClick={onKitClick}
            onError={setError}
          />
        ))}
      </svg>

      {/* factory-sound picker — portaled to document.body (OUTSIDE the scaled stage), so it is
          screen-pixel sized and positioned from the KIT trigger's screen rect. Unmounted at rest
          so the 16:9 console stays pixel-identical. */}
      {kitMenu && (
        <KitMenu
          padIndex={kitMenu.padIndex}
          anchorRect={kitMenu.anchorRect}
          onAssign={onKitAssign}
          onClose={closeKitMenu}
        />
      )}
    </>
  );
}
