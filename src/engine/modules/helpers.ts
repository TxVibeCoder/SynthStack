/**
 * Small graph-construction helpers shared by the module builders.
 * All control-rate values ride audio-rate nodes (CV is audio).
 */

/** A started ConstantSourceNode — the standard way to put a knob value on a bus. */
export function constant(ctx: BaseAudioContext, value: number): ConstantSourceNode {
  const c = ctx.createConstantSource();
  c.offset.value = value;
  c.start();
  return c;
}

/** Gain stage with fixed multiplier. */
export function gain(ctx: BaseAudioContext, value: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

function makeCurve(samples: number, fn: (x: number) => number): Float32Array {
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    curve[i] = fn((i / (samples - 1)) * 2 - 1);
  }
  return curve;
}

export function shaper(ctx: BaseAudioContext, fn: (x: number) => number, samples = 2048): WaveShaperNode {
  const s = ctx.createWaveShaper();
  s.curve = makeCurve(samples, fn) as Float32Array<ArrayBuffer>;
  return s;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Equal-power crossfade driven by an audio-rate position signal (0..1).
 * position -> cos/sin shapers -> the two branch gains (whose .gain.value is 0).
 * Returns the bus the position signal should feed.
 */
export interface Crossfade {
  positionBus: GainNode; // feed knob constant + CV here (values 0..1)
  aIn: GainNode; // CCW branch input
  bIn: GainNode; // CW branch input
  out: GainNode;
}

export function equalPowerCrossfade(ctx: BaseAudioContext): Crossfade {
  const positionBus = gain(ctx, 1);
  const aIn = gain(ctx, 0);
  const bIn = gain(ctx, 0);
  const out = gain(ctx, 1);
  const cosShaper = shaper(ctx, (x) => Math.cos((clamp01(x) * Math.PI) / 2));
  const sinShaper = shaper(ctx, (x) => Math.sin((clamp01(x) * Math.PI) / 2));
  positionBus.connect(cosShaper).connect(aIn.gain);
  positionBus.connect(sinShaper).connect(bIn.gain);
  aIn.connect(out);
  bIn.connect(out);
  return { positionBus, aIn, bIn, out };
}
