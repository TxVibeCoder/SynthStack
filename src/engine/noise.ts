/**
 * White noise source: looped AudioBufferSourceNode of pre-rendered
 * white noise, >= 2 s, random each load. Output ±5 vv.
 */

export function fillWhiteNoise(target: Float32Array, rng: () => number = Math.random): void {
  for (let i = 0; i < target.length; i++) target[i] = (rng() * 2 - 1) * 5;
}

export interface NoiseSource {
  node: AudioBufferSourceNode;
  output: GainNode;
}

export function createNoiseSource(ctx: BaseAudioContext, seconds = 2): NoiseSource {
  const buffer = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate);
  fillWhiteNoise(buffer.getChannelData(0));
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.loop = true;
  const output = ctx.createGain();
  node.connect(output);
  node.start(); // sources must be started or they output silence
  return { node, output };
}
