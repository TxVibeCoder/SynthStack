import { describe, expect, it, beforeEach } from 'vitest';
import { SamplerModule } from '../../src/engine/modules/sampler';
import samplerDef from '../../data/sampler.json';
import type { ModuleDef } from '../../data/schema';

// The Node test env has no Web Audio, so we drive SamplerModule against a minimal
// BaseAudioContext stub that implements exactly the surface it (and ModuleBase /
// the gain helper) touch: createGain, createBufferSource, createBuffer, and node
// connect/disconnect/start. Real-context behaviour is proven by the audio battery
// (test/audio/battery.ts, samp-trigger) in a real browser.

class FakeAudioParam {
  value = 0;
}
class FakeAudioNode {
  readonly connections: FakeAudioNode[] = [];
  connect(dest: FakeAudioNode): FakeAudioNode {
    this.connections.push(dest);
    return dest;
  }
  disconnect(): void {
    this.connections.length = 0;
  }
}
class FakeGainNode extends FakeAudioNode {
  readonly gain = new FakeAudioParam();
}
class FakeBufferSourceNode extends FakeAudioNode {
  buffer: unknown = null;
  loop = false;
  readonly playbackRate = new FakeAudioParam();
  onended: (() => void) | null = null;
  started = false;
  startedAt = -1;
  stopped = false;
  stoppedAt = -1;
  start(time = 0): void {
    this.started = true;
    this.startedAt = time;
  }
  stop(time = 0): void {
    this.stopped = true;
    this.stoppedAt = time;
  }
}
class FakeAudioBuffer {
  private readonly data: Float32Array;
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.data = new Float32Array(length);
  }
  getChannelData(): Float32Array {
    return this.data;
  }
}
class FakeContext {
  readonly sources: FakeBufferSourceNode[] = [];
  createGain(): FakeGainNode {
    return new FakeGainNode();
  }
  createBufferSource(): FakeBufferSourceNode {
    const s = new FakeBufferSourceNode();
    this.sources.push(s);
    return s;
  }
  createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(channels, length, sampleRate);
  }
}

const def = samplerDef as unknown as ModuleDef;

describe('SamplerModule (feature: sampler pads)', () => {
  let ctx: FakeContext;
  let mod: SamplerModule;

  beforeEach(() => {
    ctx = new FakeContext();
    mod = new SamplerModule(ctx as unknown as BaseAudioContext, def);
  });

  it('builds per-pad OUT taps and the MIX tap without throwing', () => {
    for (let n = 1; n <= 8; n++) {
      expect(() => mod.outputTap(`SAMP_PAD${n}_OUT`)).not.toThrow();
    }
    expect(() => mod.outputTap('SAMP_MIX_OUT')).not.toThrow();
  });

  it('exposes the 8 TRIG input buses', () => {
    for (let n = 1; n <= 8; n++) {
      expect(() => mod.inputBus(`SAMP_PAD${n}_TRIG_IN`)).not.toThrow();
    }
  });

  it('setControl parses the pad index for LEVEL and TUNE', () => {
    expect(() => mod.setControl('SAMP_PAD1_LEVEL', 0.5)).not.toThrow();
    expect(() => mod.setControl('SAMP_PAD8_LEVEL', 0.25)).not.toThrow();
    expect(() => mod.setControl('SAMP_PAD3_TUNE', 12)).not.toThrow();
  });

  it('hasSample reflects loadPadBuffer / clearPadBuffer', () => {
    expect(mod.hasSample(0)).toBe(false);
    mod.loadPadBuffer(0, ctx.createBuffer(1, 480, 48000) as unknown as AudioBuffer);
    expect(mod.hasSample(0)).toBe(true);
    mod.clearPadBuffer(0);
    expect(mod.hasSample(0)).toBe(false);
  });

  it('triggerPad is a silent no-op on an empty pad (no source created)', () => {
    mod.triggerPad(1, 0); // pad index 1 (PAD 2) is empty
    expect(ctx.sources).toHaveLength(0);
  });

  it('triggerPad fires a started source on a loaded pad', () => {
    mod.loadPadBuffer(0, ctx.createBuffer(1, 480, 48000) as unknown as AudioBuffer);
    mod.triggerPad(0, 0.1);
    expect(ctx.sources).toHaveLength(1);
    const src = ctx.sources[0]!;
    expect(src.started).toBe(true);
    expect(src.startedAt).toBe(0.1);
  });

  it('TUNE sets playbackRate at the next trigger (+12 semis = 2× rate)', () => {
    mod.loadPadBuffer(0, ctx.createBuffer(1, 480, 48000) as unknown as AudioBuffer);
    mod.setControl('SAMP_PAD1_TUNE', 12);
    mod.triggerPad(0, 0);
    expect(ctx.sources[0]!.playbackRate.value).toBeCloseTo(2, 6);
  });

  it('a fresh source is created per trigger (single-use nodes)', () => {
    mod.loadPadBuffer(0, ctx.createBuffer(1, 480, 48000) as unknown as AudioBuffer);
    mod.triggerPad(0, 0);
    mod.triggerPad(0, 0.2);
    expect(ctx.sources).toHaveLength(2);
    expect(ctx.sources[0]).not.toBe(ctx.sources[1]);
  });

  it('source.onended disconnects without throwing (no node leak)', () => {
    mod.loadPadBuffer(0, ctx.createBuffer(1, 480, 48000) as unknown as AudioBuffer);
    mod.triggerPad(0, 0);
    const src = ctx.sources[0]!;
    expect(src.onended).toBeTypeOf('function');
    expect(() => src.onended!()).not.toThrow();
  });

  // --- loop-quantize additions ---

  it("setControl('SAMP_PAD1_LOOP','ON') flips loopOn for that pad only", () => {
    expect(mod.loopOn(0)).toBe(false);
    mod.setControl('SAMP_PAD1_LOOP', 'ON');
    expect(mod.loopOn(0)).toBe(true);
    expect(mod.loopOn(1)).toBe(false);
    mod.setControl('SAMP_PAD1_LOOP', 'OFF');
    expect(mod.loopOn(0)).toBe(false);
  });

  it('startLoop mints a started looping source and marks the pad sounding', () => {
    mod.loadPadBuffer(0, ctx.createBuffer(1, 480, 48000) as unknown as AudioBuffer);
    expect(mod.isLoopSounding(0)).toBe(false);
    mod.startLoop(0, 0.5);
    expect(ctx.sources).toHaveLength(1);
    const src = ctx.sources[0]!;
    expect(src.loop).toBe(true);
    expect(src.started).toBe(true);
    expect(src.startedAt).toBe(0.5);
    expect(mod.isLoopSounding(0)).toBe(true);
  });

  it('startLoop is a silent no-op on an empty pad', () => {
    mod.startLoop(2, 0); // pad index 2 has no buffer
    expect(ctx.sources).toHaveLength(0);
    expect(mod.isLoopSounding(2)).toBe(false);
  });

  it('relaunchLoop hard-stops the prior voice and mints a fresh looping source', () => {
    mod.loadPadBuffer(0, ctx.createBuffer(1, 480, 48000) as unknown as AudioBuffer);
    mod.startLoop(0, 0);
    const first = ctx.sources[0]!;
    mod.relaunchLoop(0, 1.0);
    expect(first.stopped).toBe(true);
    expect(first.stoppedAt).toBe(1.0);
    expect(ctx.sources).toHaveLength(2);
    const second = ctx.sources[1]!;
    expect(second).not.toBe(first);
    expect(second.loop).toBe(true);
    expect(second.startedAt).toBe(1.0);
    expect(mod.isLoopSounding(0)).toBe(true);
  });

  it('stopLoop stops the voice at the given time and clears sounding state', () => {
    mod.loadPadBuffer(0, ctx.createBuffer(1, 480, 48000) as unknown as AudioBuffer);
    mod.startLoop(0, 0);
    const src = ctx.sources[0]!;
    mod.stopLoop(0, 2.5);
    expect(src.stopped).toBe(true);
    expect(src.stoppedAt).toBe(2.5);
    expect(mod.isLoopSounding(0)).toBe(false);
  });

  it('stopLoop is a no-op when nothing is sounding', () => {
    expect(() => mod.stopLoop(0, 0)).not.toThrow();
    expect(mod.isLoopSounding(0)).toBe(false);
  });

  it('clearPadBuffer stops a sounding loop and empties the pad', () => {
    mod.loadPadBuffer(0, ctx.createBuffer(1, 480, 48000) as unknown as AudioBuffer);
    mod.startLoop(0, 0);
    const src = ctx.sources[0]!;
    mod.clearPadBuffer(0);
    expect(src.stopped).toBe(true);
    expect(mod.isLoopSounding(0)).toBe(false);
    expect(mod.hasSample(0)).toBe(false);
  });

  it('triggerPad stays a non-looping one-shot (loop flag never set on its source)', () => {
    mod.loadPadBuffer(0, ctx.createBuffer(1, 480, 48000) as unknown as AudioBuffer);
    mod.triggerPad(0, 0);
    expect(ctx.sources[0]!.loop).toBe(false);
    expect(mod.isLoopSounding(0)).toBe(false); // one-shot is never registered as a loop voice
  });
});
