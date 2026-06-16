/**
 * Cable layer — an absolutely-positioned SVG overlay spanning the
 * whole 16:9 stage, so cables can run between panels (the panels are separate SVGs).
 *
 * - Jack endpoints are measured from the DOM (`circle[data-jack-id]` hit circles the
 *   panels already render), container-relative IN STAGE UNITS: the stage renders
 *   through a uniform CSS scale (App.tsx), so screen-space measurements divide by
 *   the current scale (container width ÷ STAGE.w). Re-measured on resize and edits.
 * - Drag starts on pointerdown over any jack (document-level listener — the overlay
 *   itself is pointer-events:none so panels stay fully interactive). Valid targets
 *   highlight; dropping elsewhere snaps back (the pending cable vanishes). Dragging
 *   from an occupied INPUT unplugs that cable and re-drags it from its source.
 * - Click-to-arm: a press-and-release on a jack
 *   WITHOUT movement (< CLICK_ARM_PX) arms the cable instead — it follows the
 *   cursor; clicking a valid target completes it; Esc, empty space, or the
 *   source jack cancels. A travel threshold keeps both gestures coexisting.
 * - Click a patched cable (fat invisible hit stroke) to remove it.
 * - CABLE_COUNT budget with a remaining-count chip.
 *
 * All patch mutations go through engineBridge.commitCables (store + live router).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { engineBridge } from '../engineBridge';
import type { CableState } from '../../state/studioState';
import { CABLE_COLORS, CABLE_COUNT, COLORS, FONT_CONDENSED } from '../theme';
import { STAGE } from '../stage16x9';
import { cableColor, cablePath, nextCableId, sharedOutputOffset, type Pt } from './cableGeometry';

interface Pending {
  fromJack: string;
  pointer: Pt;
  validTargets: Set<string>;
  color: string;
  /** Where the starting pointerdown landed (stage units) — gesture classifier. */
  downAt: Pt;
  /** True once a no-travel release armed the cable (click-to-arm). */
  armed: boolean;
}

/** Pointer travel (stage px) below which a press-and-release is a CLICK (arms
 *  the cable) rather than a drag-and-drop. */
const CLICK_ARM_PX = 6;

function readCables(): CableState[] {
  return engineBridge.store.getState().cables;
}

export function CableLayer({ container }: { container: React.RefObject<HTMLElement | null> }) {
  const [cables, setCables] = useState<CableState[]>(readCables);
  const [positions, setPositions] = useState<Map<string, Pt>>(new Map());
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;

  // ---- store mirror (guarded against the store's clone-per-getState) ----------------
  useEffect(() => {
    let last = JSON.stringify(readCables());
    return engineBridge.store.subscribe(() => {
      const next = readCables();
      const key = JSON.stringify(next);
      if (key !== last) {
        last = key;
        setCables(next);
      }
    });
  }, []);

  // ---- jack-position measurement (screen px → stage units via ÷scale) -----------------
  const measure = useCallback(() => {
    const host = container.current;
    if (!host) return;
    const crect = host.getBoundingClientRect();
    // WIDTH-ONLY scale anchor (load-bearing): the stage HEIGHT grows to host the
    // SAMPLER pad section below the 16:9 fold (App.tsx sets the inline height to
    // STAGE.h + PAD_SECTION_H), but the WIDTH stays STAGE.w, so width÷STAGE.w
    // stays the true uniform scale and pad jacks measure correctly under scroll.
    const scale = crect.width / STAGE.w || 1;
    const map = new Map<string, Pt>();
    host.querySelectorAll('circle[data-jack-id]').forEach((el) => {
      const r = el.getBoundingClientRect();
      map.set(el.getAttribute('data-jack-id')!, {
        x: (r.left + r.width / 2 - crect.left) / scale,
        y: (r.top + r.height / 2 - crect.top) / scale,
      });
    });
    setPositions(map);
  }, [container]);

  useEffect(() => {
    measure();
    const host = container.current;
    const ro = host ? new ResizeObserver(measure) : null;
    if (host && ro) ro.observe(host);
    window.addEventListener('resize', measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [measure, container]);

  // re-measure after cable edits (plug rendering can nudge layout? cheap either way)
  useEffect(() => {
    measure();
  }, [cables.length, measure]);

  // ---- drag interaction (document-level; overlay never blocks the panels) -------------
  useEffect(() => {
    const host = container.current;
    if (!host) return;

    const toLocal = (e: PointerEvent): Pt => {
      const crect = host.getBoundingClientRect();
      const scale = crect.width / STAGE.w || 1;
      return { x: (e.clientX - crect.left) / scale, y: (e.clientY - crect.top) / scale };
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      suppressCableClickRef.current = false;
      // armed cable: this press is the COMPLETING click — onUp decides; never
      // start a second pending (or unplug anything) underneath it
      if (pendingRef.current?.armed) return;
      const jackEl = (e.target as Element | null)?.closest?.('[data-jack-id]');
      if (!jackEl) return;
      const jackId = jackEl.getAttribute('data-jack-id')!;
      const current = readCables();

      let fromJack = jackId;
      let next = current;
      const occupying = current.find((c) => c.to === jackId);
      if (occupying) {
        // unplug and re-drag from its source output
        fromJack = occupying.from;
        next = current.filter((c) => c.id !== occupying.id);
        engineBridge.commitCables(next);
      } else if (current.length >= CABLE_COUNT) {
        return; // no cables left in the box
      }

      const fromIsOut = engineBridge.isOutputJack(fromJack);
      const valid = new Set<string>();
      for (const id of positionsRef.current.keys()) {
        if (id === fromJack) continue;
        const v = fromIsOut ? engineBridge.validatePatch(fromJack, id) : engineBridge.validatePatch(id, fromJack);
        if (v.ok) valid.add(id);
      }
      const pt = toLocal(e);
      setPending({
        fromJack,
        pointer: pt,
        validTargets: valid,
        color: occupying?.color ?? cableColor(next.length, CABLE_COLORS),
        downAt: pt,
        armed: false,
      });
      e.preventDefault();
    };

    const onMove = (e: PointerEvent) => {
      if (!pendingRef.current) return;
      e.preventDefault();
      const pt = toLocal(e);
      setPending((p) => (p ? { ...p, pointer: pt } : p));
    };

    const onUp = (e: PointerEvent) => {
      const p = pendingRef.current;
      if (!p) return;
      const pt = toLocal(e);
      // click-to-arm: a release without meaningful travel keeps
      // the cable live and cursor-following instead of snapping back
      if (!p.armed && Math.hypot(pt.x - p.downAt.x, pt.y - p.downAt.y) < CLICK_ARM_PX) {
        setPending({ ...p, pointer: pt, armed: true });
        return;
      }
      setPending(null);
      const targetEl = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-jack-id]');
      const targetId = targetEl?.getAttribute('data-jack-id');
      if (!targetId || !p.validTargets.has(targetId)) {
        // canceling an ARMED cable with a click must not double as a
        // cable-removal click when the release lands on a curve's hit stroke
        if (p.armed) suppressCableClickRef.current = true;
        return; // snap back
      }
      const fromIsOut = engineBridge.isOutputJack(p.fromJack);
      const from = fromIsOut ? p.fromJack : targetId;
      const to = fromIsOut ? targetId : p.fromJack;
      if (!engineBridge.validatePatch(from, to).ok) return;
      const current = readCables();
      engineBridge.commitCables([...current, { id: nextCableId(current), from, to, color: p.color }]);
    };

    const onKeyDown = (ev: KeyboardEvent) => {
      // Esc abandons the pending cable (armed or mid-drag)
      if (ev.key === 'Escape' && pendingRef.current) setPending(null);
    };

    document.addEventListener('pointerdown', onDown);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [container]);

  // positions in a ref so the drag handlers (bound once) always see fresh values
  const positionsRef = useRef(positions);
  positionsRef.current = positions;

  /** Set when canceling an ARMED cable, so that click can't also remove a cable. */
  const suppressCableClickRef = useRef(false);

  const removeCable = useCallback((id: string) => {
    if (suppressCableClickRef.current) {
      suppressCableClickRef.current = false;
      return;
    }
    engineBridge.commitCables(readCables().filter((c) => c.id !== id));
  }, []);

  // ---- render -------------------------------------------------------------------------
  const outputUse = new Map<string, number>(); // per-output stacking for plug offsets
  const free = CABLE_COUNT - cables.length;

  return (
    <>
      <svg className="cable-layer" aria-hidden="true">
        {cables.map((c) => {
          const k = outputUse.get(c.from) ?? 0;
          outputUse.set(c.from, k + 1);
          const a0 = positions.get(c.from);
          const b = positions.get(c.to);
          if (!a0 || !b) return null;
          const a = { x: a0.x + sharedOutputOffset(k), y: a0.y };
          const d = cablePath(a, b);
          return (
            <g key={c.id}>
              <path d={d} fill="none" stroke={COLORS.panelShadow} strokeWidth={6} opacity={0.55} />
              <path d={d} fill="none" stroke={c.color} strokeWidth={4} strokeLinecap="round" opacity={0.92} />
              {/* plugs */}
              <circle cx={a.x} cy={a.y} r={7} fill={c.color} stroke={COLORS.panelShadow} strokeWidth={2} />
              <circle cx={b.x} cy={b.y} r={7} fill={c.color} stroke={COLORS.panelShadow} strokeWidth={2} />
              {/* fat invisible hit path: click to remove (≥12 px) */}
              <path
                d={d}
                fill="none"
                stroke="transparent"
                strokeWidth={14}
                style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                onClick={() => removeCable(c.id)}
              >
                <title>{`${c.from} → ${c.to} — click to remove`}</title>
              </path>
            </g>
          );
        })}

        {pending && (
          <g>
            {/* valid-target halos */}
            {Array.from(pending.validTargets, (id) => {
              const pt = positions.get(id);
              return pt ? (
                <circle
                  key={id}
                  cx={pt.x}
                  cy={pt.y}
                  r={13}
                  fill="none"
                  stroke={COLORS.ledAmber}
                  strokeWidth={2}
                  opacity={0.75}
                />
              ) : null;
            })}
            {(() => {
              const a = positions.get(pending.fromJack);
              if (!a) return null;
              const d = cablePath(a, pending.pointer);
              return (
                <g>
                  <path d={d} fill="none" stroke={pending.color} strokeWidth={4} strokeLinecap="round" opacity={0.85} />
                  <circle cx={a.x} cy={a.y} r={7} fill={pending.color} stroke={COLORS.panelShadow} strokeWidth={2} />
                  {/* armed: the free plug rides the cursor until the next click */}
                  {pending.armed && (
                    <circle
                      cx={pending.pointer.x}
                      cy={pending.pointer.y}
                      r={7}
                      fill={pending.color}
                      stroke={COLORS.panelShadow}
                      strokeWidth={2}
                    />
                  )}
                </g>
              );
            })()}
          </g>
        )}
      </svg>

      {/* remaining-cable chip */}
      <div className="cable-chip" data-testid="cable-chip" style={{ fontFamily: FONT_CONDENSED }}>
        CABLES {free}/{CABLE_COUNT}
      </div>
    </>
  );
}
