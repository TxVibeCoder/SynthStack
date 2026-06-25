/**
 * FOLD io-scale operating point (B fold-scale fix): the WaveShaper's curve domain is [-1, 1],
 * so the wet branch must pre-gain the incoming signal into that range and post-gain it back.
 * The RIGHT scale depends on WHERE the FOLD sits:
 *  - per-voice insert: fed the raw ±5 vv voice tap (pre-mixer) → pre-gain 0.2, post-gain 5.
 *  - master chain: fed the post-mixer signal (mixer already applied vvScale ×0.2 + level, so
 *    it's already ~±1) → pre-gain ~1.0, post-gain ~1.0.
 *
 * Regression lock: the old code hard-coded 0.2/5 for BOTH targets, so the master fold drove the
 * shaper at ~±0.16 (×0.2 of an already-±1 signal) and folded ~5× too weakly. These assertions
 * FAIL on that single-0.2 code and pass once the io scale is parameterized per target.
 *
 * Node has no Web Audio, so we drive the builders against a minimal BaseAudioContext stub that
 * records the gain graph (real-context behaviour is covered by the browser audio battery).
 */

import { describe, expect, it } from 'vitest';
import { buildFold } from '../../src/engine/fx/effects';
import { MasterFxChain } from '../../src/engine/fx/masterFxChain';

class FakeAudioParam {
  value = 0;
}
class FakeAudioNode {
  readonly outgoing: FakeAudioNode[] = [];
  connect(dest: FakeAudioNode): FakeAudioNode {
    this.outgoing.push(dest);
    return dest;
  }
  disconnect(): void {
    this.outgoing.length = 0;
  }
}
class FakeGainNode extends FakeAudioNode {
  readonly gain = new FakeAudioParam();
}
class FakeWaveShaperNode extends FakeAudioNode {
  curve: Float32Array | null = null;
  oversample: OverSampleType = 'none';
}
class FakeBiquadFilterNode extends FakeAudioNode {
  type: BiquadFilterType = 'lowpass';
  readonly frequency = new FakeAudioParam();
}
class FakeDelayNode extends FakeAudioNode {
  readonly delayTime = new FakeAudioParam();
}
class FakeOscillatorNode extends FakeAudioNode {
  type: OscillatorType = 'sine';
  readonly frequency = new FakeAudioParam();
  start(): void {}
}
class FakeConvolverNode extends FakeAudioNode {
  buffer: unknown = null;
}
class FakeAudioBuffer {
  private readonly chans: Float32Array[];
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.chans = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(ch: number): Float32Array {
    return this.chans[ch]!;
  }
}
class FakeContext {
  readonly sampleRate = 48000;
  readonly gains: FakeGainNode[] = [];
  readonly shapers: FakeWaveShaperNode[] = [];
  createGain(): FakeGainNode {
    const g = new FakeGainNode();
    this.gains.push(g);
    return g;
  }
  createWaveShaper(): FakeWaveShaperNode {
    const s = new FakeWaveShaperNode();
    this.shapers.push(s);
    return s;
  }
  createBiquadFilter(): FakeBiquadFilterNode {
    return new FakeBiquadFilterNode();
  }
  createDelay(): FakeDelayNode {
    return new FakeDelayNode();
  }
  createOscillator(): FakeOscillatorNode {
    return new FakeOscillatorNode();
  }
  createConvolver(): FakeConvolverNode {
    return new FakeConvolverNode();
  }
  createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(channels, length, sampleRate);
  }
}

/**
 * The FOLD wet branch is input → preGain → shaper → postGain → wet → output. Walk forward from
 * the shaper's single source (preGain) and single sink (postGain) to read the io scale, robust
 * to node ordering.
 */
function foldIoGains(ctx: FakeContext): { pre: number; post: number } {
  const shaper = ctx.shapers[0];
  if (!shaper) throw new Error('a WaveShaper must exist');
  // preGain is the gain node that connects INTO the shaper.
  const pre = ctx.gains.find((g) => g.outgoing.includes(shaper));
  // postGain is the gain node the shaper connects INTO.
  const post = shaper.outgoing.find((n): n is FakeGainNode => n instanceof FakeGainNode);
  expect(pre, 'a pre-gain must feed the shaper').toBeDefined();
  expect(post, 'a post-gain must follow the shaper').toBeDefined();
  return { pre: pre!.gain.value, post: post!.gain.value };
}

describe('FOLD io-scale operating point (B fold-scale)', () => {
  it('per-voice insert FOLD drives the shaper at ±5vv→±1 (pre 0.2, post 5)', () => {
    const ctx = new FakeContext();
    buildFold(ctx as unknown as BaseAudioContext, { ioScale: 0.2 });
    const { pre, post } = foldIoGains(ctx);
    expect(pre).toBeCloseTo(0.2, 6);
    expect(post).toBeCloseTo(5, 6);
  });

  it('master FOLD drives the already-±1 post-mixer signal at unity (pre ~1, post ~1)', () => {
    const ctx = new FakeContext();
    buildFold(ctx as unknown as BaseAudioContext, { ioScale: 1.0 });
    const { pre, post } = foldIoGains(ctx);
    expect(pre).toBeCloseTo(1.0, 6);
    expect(post).toBeCloseTo(1.0, 6);
  });

  it('post-gain is always the reciprocal of the pre-gain (amplitude restored around the shaper)', () => {
    for (const ioScale of [0.2, 0.5, 1.0]) {
      const ctx = new FakeContext();
      buildFold(ctx as unknown as BaseAudioContext, { ioScale });
      const { pre, post } = foldIoGains(ctx);
      expect(pre * post).toBeCloseTo(1.0, 6);
    }
  });

  it('the master and per-voice CHAINS construct FOLD with DIFFERENT io scales', () => {
    // Bug lock: on the old single-0.2 code these two reads are identical and this fails.
    const masterCtx = new FakeContext();
    new MasterFxChain(masterCtx as unknown as BaseAudioContext, 'master');
    const master = foldIoGains(masterCtx);

    const voiceCtx = new FakeContext();
    new MasterFxChain(voiceCtx as unknown as BaseAudioContext, 'voice');
    const voice = foldIoGains(voiceCtx);

    // master sees an already-±1 signal → unity-ish; voice sees ±5vv → 0.2.
    expect(master.pre).toBeCloseTo(1.0, 6);
    expect(voice.pre).toBeCloseTo(0.2, 6);
    expect(master.pre).not.toBeCloseTo(voice.pre, 2);
    // master drives the shaper ~5× hotter than the old (wrong) 0.2 master would have.
    expect(master.pre / voice.pre).toBeCloseTo(5, 6);
  });

  it('MasterFxChain defaults to the per-voice operating point when no target is given', () => {
    const ctx = new FakeContext();
    new MasterFxChain(ctx as unknown as BaseAudioContext);
    expect(foldIoGains(ctx).pre).toBeCloseTo(0.2, 6);
  });
});
