/**
 * Courier mod-matrix resolver (PURE — no Web Audio types, Node-unit-tested).
 *
 * Companion to ./modRouter.ts. That module owns the static target spec (which control ids are
 * modulatable, which engine bus each maps to, and the depth -> gain scale via `modGain`). THIS
 * module is the routing-math resolver: given a full CourierModAssignState plus the instantaneous
 * value of each of the 4 mod sources, it computes the additive contribution each (source -> target)
 * route applies to its engine bus, and sums all routes per bus.
 *
 * The engine wires the audio graph to mirror this exactly: each (source, target) pair has a
 * pre-built scale-gain whose `.gain.value` is `modGain(depth, spec)`, so the audio-rate sum onto a
 * bus equals `sum over routes of source_signal * modGain(depth, spec)`. Keeping the math here as a
 * pure function lets Node tests assert the routing/scaling/summation without an AudioContext.
 */

import {
  MOD_TARGETS,
  findModTarget,
  modGain,
  type ModBus,
  type ModTargetSpec,
} from './modRouter';
import type {
  CourierModAssignState,
  CourierModSource,
} from '../state/studioState';
import { COURIER_MOD_SOURCES } from '../state/studioState';

/** Instantaneous value of each mod source (the tapped signal feeding the scale-gains). */
export type ModSourceValues = Record<CourierModSource, number>;

/** Per-bus summed contribution (every supported bus present; 0 when nothing routes to it). */
export type ModBusContributions = Record<ModBus, number>;

/** The full set of engine buses, in spec order (one per supported target). */
export const MOD_BUSES: ModBus[] = MOD_TARGETS.map((t) => t.bus);

function zeroBusContributions(): ModBusContributions {
  const out = {} as ModBusContributions;
  for (const t of MOD_TARGETS) out[t.bus] = 0;
  return out;
}

/**
 * The scale-gain value the engine should write for a single (source, target) pair: `modGain` of
 * the route's depth when the route targets THIS spec, else 0 (unassigned / assigned elsewhere).
 * Mirrors `applyLfo1Dest` flipping the selected destination to its depth and the rest to 0.
 */
export function routeGainForTarget(
  entry: { controlId: string; depth: number } | null,
  spec: ModTargetSpec,
): number {
  if (!entry || entry.controlId !== spec.controlId) return 0;
  return modGain(entry.depth, spec);
}

/**
 * Resolve a whole mod-assign state into the additive bus contributions for the given source
 * signal values. For each assigned route: look up the target spec, multiply the source value by
 * `modGain(depth, spec)`, and add it onto that target's bus. Routes whose controlId is not a
 * supported target are ignored (a safe no-op). Unassigned sources contribute nothing.
 *
 * Returns a fresh object with EVERY supported bus present (0 if nothing routes to it). Never
 * produces NaN as long as the inputs are finite (callers/coalesce already clamp depth & drop
 * non-finite); a non-finite source value propagates only to the buses it actually feeds.
 */
export function resolveModContributions(
  state: CourierModAssignState,
  sources: ModSourceValues,
): ModBusContributions {
  const out = zeroBusContributions();
  for (const src of COURIER_MOD_SOURCES) {
    const entry = state.routes[src];
    if (!entry) continue;
    const spec = findModTarget(entry.controlId);
    if (!spec) continue; // unsupported target — safe no-op
    out[spec.bus] += sources[src] * modGain(entry.depth, spec);
  }
  return out;
}

export { MOD_TARGETS, findModTarget, modGain };
export type { ModBus, ModTargetSpec };
