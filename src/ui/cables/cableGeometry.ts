/**
 * Cable geometry — pure math, unit-tested in Node.
 * Cables are cubic Béziers with gravity sag: control points dropped by
 * 0.15·distance + 30 px.
 */

export interface Pt {
  x: number;
  y: number;
}

export function cableSag(a: Pt, b: Pt): number {
  return 0.15 * Math.hypot(b.x - a.x, b.y - a.y) + 30;
}

export function cablePath(a: Pt, b: Pt): string {
  const sag = cableSag(a, b);
  const c1x = a.x + (b.x - a.x) * 0.25;
  const c2x = a.x + (b.x - a.x) * 0.75;
  const c1y = a.y + (b.y - a.y) * 0.25 + sag;
  const c2y = a.y + (b.y - a.y) * 0.75 + sag;
  return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}

/** Color for the n-th cable patched (cycles the palette). */
export function cableColor(n: number, palette: readonly string[]): string {
  return palette[((n % palette.length) + palette.length) % palette.length]!;
}

/**
 * Slight x-offset for the k-th cable sharing one output jack, so stacked
 * plugs stay readable: 0, +4, −4, +8, −8 …
 */
export function sharedOutputOffset(k: number): number {
  if (k <= 0) return 0;
  return (k % 2 === 1 ? 1 : -1) * Math.ceil(k / 2) * 4;
}

/** Next unique cable id ("c1", "c2", …) above any existing numeric suffix. */
export function nextCableId(existing: ReadonlyArray<{ id: string }>): string {
  let max = 0;
  for (const c of existing) {
    const m = /^c(\d+)$/.exec(c.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `c${max + 1}`;
}
