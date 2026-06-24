/**
 * Shared offline-audio battery harness — SR, the AudioTestResult shape, the single-module build
 * helper, and a couple of measurement utilities used by battery.ts, normalsBattery.ts, and
 * recipeBattery.ts. Kept in its own module so the three battery files share these without a
 * circular import.
 *
 * `buildModule` wires the REAL router/registry (`applyAllNormals`) so normals are live exactly as in
 * production, and returns the `RouterBinding` so a test can break a normal the faithful way —
 * `binding.applyPatch({cables})` — rather than summing a second source onto the bus.
 */

import { loadWorklets } from '../../src/engine/context';
import { MonarchModule } from '../../src/engine/modules/monarch';
import { AnvilModule } from '../../src/engine/modules/anvil';
import { CascadeModule } from '../../src/engine/modules/cascade';
import { CourierModule } from '../../src/engine/modules/courier';
import { StudioEndpointRegistry } from '../../src/engine/modules/registry';
import { buildJackIndex, RouterBinding } from '../../src/engine/router';
import type { ModuleDef } from '../../data/schema';
import { rms } from '../helpers/spectral';

export const SR = 48000;

export interface AudioTestResult {
  name: string;
  pass: boolean;
  detail: string;
}

type Builder<M> = new (ctx: BaseAudioContext, def: ModuleDef) => M;

export async function buildModule<M extends MonarchModule | AnvilModule | CascadeModule | CourierModule>(
  seconds: number,
  Ctor: Builder<M>,
  def: unknown,
): Promise<{
  ctx: OfflineAudioContext;
  mod: M;
  binding: RouterBinding;
  render: () => Promise<Float32Array>;
}> {
  const ctx = new OfflineAudioContext(1, Math.ceil(seconds * SR), SR);
  await loadWorklets(ctx);
  const moduleDef = def as ModuleDef;
  const mod = new Ctor(ctx, moduleDef);
  const binding = new RouterBinding(buildJackIndex([moduleDef]), new StudioEndpointRegistry([mod]));
  binding.applyAllNormals();
  return {
    ctx,
    mod,
    binding,
    render: async () => (await ctx.startRendering()).getChannelData(0),
  };
}

/** RMS envelope in winS windows. */
export function envelope(buf: Float32Array, winS = 0.005): number[] {
  const win = Math.floor(winS * SR);
  const out: number[] = [];
  for (let off = 0; off + win <= buf.length; off += win) out.push(rms(buf, off, off + win));
  return out;
}

/** Sample indices of rising edges through the +2.5 vv gate threshold. */
export function risingEdges(buf: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 1; i < buf.length; i++) {
    if (buf[i - 1]! < 2.5 && buf[i]! >= 2.5) out.push(i);
  }
  return out;
}

/** Mean (DC) level over a window — for fixed-voltage normal checks (MIX1←0V vs MIX2←+5V). */
export function meanLevel(buf: Float32Array, start = 0, end = buf.length): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += buf[i]!;
  return sum / Math.max(1, end - start);
}

/** Count of mean-crossings of a series — a cheap periodicity measure for wobble/LFO tests. */
export function meanCrossings(series: number[]): number {
  if (series.length === 0) return 0;
  const mean = series.reduce((a, b) => a + b, 0) / series.length;
  let crossings = 0;
  for (let i = 1; i < series.length; i++) {
    if ((series[i - 1]! - mean) * (series[i]! - mean) < 0) crossings++;
  }
  return crossings;
}
