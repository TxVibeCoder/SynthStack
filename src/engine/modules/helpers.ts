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

// ODD sample count on purpose: makeCurve maps index → x = (i/(samples-1))*2 - 1, so an odd count
// puts a sample at EXACTLY x = 0 (the center index). With an even count there is no x=0 sample and
// WaveShaper interpolates across it — for a one-sided curve like the VCA soft-knee (0 for x≤0,
// rising for x>0) that leaves gain ≈ +5e-4 at input 0, i.e. the VCA never fully closes and the
// always-running oscillator bleeds through at idle (a faint power-on drone, worse once the filter
// is driven). An exact x=0 sample makes fn(0) land verbatim, so a closed gate is truly silent.
export function shaper(ctx: BaseAudioContext, fn: (x: number) => number, samples = 2049): WaveShaperNode {
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
