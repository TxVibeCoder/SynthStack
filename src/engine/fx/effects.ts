/**
 * Master-bus effect builders (Wave 2). UNLIKE the voice DSP (pure cores + worklet
 * shells), these are small NATIVE Web Audio graphs — the design pass chose native nodes
 * for v1 (no new worklet / OfflineAudioContext friction). Each builder returns an FxUnit:
 * a fixed input→output sub-graph whose nodes are built ONCE; toggling an effect on/off and
 * moving its knobs only changes gain/param values (never create/destroy edges), so there
 * are no reconnect clicks.
 *
 * Topology per unit: input → dry(gain 1) → output  AND  input → [wet chain] → wet(gain) →
 * output. "off" sets the wet gain to 0 (dry-only = transparent bypass); the MIX knob sets
 * the wet level when on. The chain (masterFxChain.ts) wires the three units in series.
 *
 * All params are LIVE (plain AudioParam writes) except reverb SIZE, which rebuilds the
 * convolver IR — the EffectsPanel applies size on knob COMMIT, not per drag frame.
 */

import { clamp } from '../units';
import { buildFoldCurve, FOLD_DRIVE_MIN, FOLD_DRIVE_MAX } from '../dsp/foldCore';

/** One master effect: a fixed input→output sub-graph with an on-toggle + named params. */
export interface FxUnit {
  readonly input: GainNode;
  readonly output: GainNode;
  /** Wet on (effect audible) vs off (dry-only passthrough). */
  setOn(on: boolean): void;
  /** Set a named numeric parameter (see each builder for the param set + ranges). */
  setParam(name: string, value: number): void;
}

/** FLANGER — a short LFO-modulated delay with feedback, mixed against dry.
 *  params: rate (0.05..8 Hz), depth (0..1 → 0..3 ms sweep), feedback (0..0.95), mix (0..1). */
export function buildFlanger(ctx: BaseAudioContext): FxUnit {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  wet.gain.value = 0; // off until setOn(true)

  const delay = ctx.createDelay(0.05);
  delay.delayTime.value = 0.004; // ~4 ms center
  const feedback = ctx.createGain();
  feedback.gain.value = 0.3;
  const lfo = ctx.createOscillator();
  lfo.type = 'triangle';
  lfo.frequency.value = 0.4;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = 0.5 * 0.003; // depth → ± seconds of delay sweep

  // dry passthrough
  input.connect(dry).connect(output);
  // wet: input → delay → wet → output, with a feedback loop, LFO sweeping delay time
  input.connect(delay);
  delay.connect(feedback).connect(delay);
  delay.connect(wet).connect(output);
  lfo.connect(lfoDepth).connect(delay.delayTime);
  lfo.start();

  let mix = 0.5;
  let on = false;
  return {
    input,
    output,
    setOn(next) {
      on = next;
      wet.gain.value = on ? mix : 0;
    },
    setParam(name, value) {
      switch (name) {
        case 'rate':
          lfo.frequency.value = clamp(value, 0.05, 8); // canonical range (matches the UI knob)
          break;
        case 'depth':
          lfoDepth.gain.value = clamp(value, 0, 1) * 0.003;
          break;
        case 'feedback':
          feedback.gain.value = clamp(value, 0, 0.95);
          break;
        case 'mix':
          mix = clamp(value, 0, 1);
          if (on) wet.gain.value = mix;
          break;
      }
    },
  };
}

/** DELAY — a feedback delay line, mixed against dry.
 *  params: time (0.02..2 s), feedback (0..0.95), mix (0..1). */
export function buildDelay(ctx: BaseAudioContext): FxUnit {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  wet.gain.value = 0;

  const delay = ctx.createDelay(2.0);
  delay.delayTime.value = 0.3;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.35;
  // a gentle lowpass in the feedback loop so repeats darken (analogue-ish)
  const damp = ctx.createBiquadFilter();
  damp.type = 'lowpass';
  damp.frequency.value = 4000;

  input.connect(dry).connect(output);
  input.connect(delay);
  delay.connect(damp).connect(feedback).connect(delay);
  delay.connect(wet).connect(output);

  let mix = 0.4;
  let on = false;
  return {
    input,
    output,
    setOn(next) {
      on = next;
      wet.gain.value = on ? mix : 0;
    },
    setParam(name, value) {
      switch (name) {
        case 'time':
          delay.delayTime.value = clamp(value, 0.02, 2);
          break;
        case 'feedback':
          feedback.gain.value = clamp(value, 0, 0.95);
          break;
        case 'mix':
          mix = clamp(value, 0, 1);
          if (on) wet.gain.value = mix;
          break;
      }
    },
  };
}

/** Options for buildFold (and, via MasterFxChain, the whole chain). */
export interface FoldOptions {
  /**
   * Pre-shaper gain that brings the incoming signal into the WaveShaper's [-1, 1] domain;
   * the post-shaper gain is its reciprocal (1/ioScale) to restore the original amplitude.
   * Pick this to match the operating point at THIS target:
   *  - per-voice insert: the signal is the raw ±5 vv voice tap (pre-mixer) → 0.2.
   *  - master chain: mixer.ts has already applied vvScale ×0.2 + level, so the signal is
   *    already ~±1 → ~1.0 (a fixed 0.2 here would fold ~5× too weakly).
   */
  readonly ioScale: number;
}

const DEFAULT_FOLD_IO_SCALE = 0.2;

/**
 * FOLD — a wavefolder (pure foldCore curve → WaveShaperNode), mixed against dry.
 *  params: drive (1..8), symmetry (-1..1) REBUILD the static fold curve (commit-only in the
 *  panel to avoid per-frame Float32Array GC thrash); mix (0..1) is a live wet-gain write.
 *
 * A WaveShaperNode's curve domain is [-1, 1], so the wet branch pre-gains the incoming signal
 * into that range (×ioScale) IN and post-gains it back (×1/ioScale) OUT around the shaper, or
 * the fold would collapse to a hard square. The right ioScale depends on WHERE the unit sits:
 * the per-voice insert sees the raw ±5 vv voice tap (ioScale 0.2 → ±5vv→±1), but the master
 * chain sits AFTER the mixer's own ×0.2 vvScale so its signal is already ~±1 (ioScale ~1.0).
 * MasterFxChain threads the per-target scale through. This is a within-shell graph detail
 * mirroring mixer.ts's own vvScale (NOT a units.ts conversion — it does not violate the
 * conversion-only rule).
 */
export function buildFold(ctx: BaseAudioContext, opts?: FoldOptions): FxUnit {
  const ioScale = opts?.ioScale ?? DEFAULT_FOLD_IO_SCALE;
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  wet.gain.value = 0;

  // ×ioScale into the shaper's [-1,1] domain, then ×1/ioScale back out.
  const preGain = ctx.createGain();
  preGain.gain.value = ioScale;
  const postGain = ctx.createGain();
  postGain.gain.value = 1 / ioScale;

  let drive = 2;
  let symmetry = 0;
  const shaper = ctx.createWaveShaper();
  shaper.curve = buildFoldCurve(drive, symmetry) as Float32Array<ArrayBuffer>;
  shaper.oversample = '4x'; // tame fold aliasing

  input.connect(dry).connect(output);
  input.connect(preGain).connect(shaper).connect(postGain).connect(wet).connect(output);

  let mix = 0.5;
  let on = false;
  return {
    input,
    output,
    setOn(next) {
      on = next;
      wet.gain.value = on ? mix : 0;
    },
    setParam(name, value) {
      switch (name) {
        case 'drive':
          drive = clamp(value, FOLD_DRIVE_MIN, FOLD_DRIVE_MAX);
          shaper.curve = buildFoldCurve(drive, symmetry) as Float32Array<ArrayBuffer>;
          break;
        case 'symmetry':
          symmetry = clamp(value, -1, 1);
          shaper.curve = buildFoldCurve(drive, symmetry) as Float32Array<ArrayBuffer>;
          break;
        case 'mix':
          mix = clamp(value, 0, 1);
          if (on) wet.gain.value = mix;
          break;
      }
    },
  };
}

/**
 * Generate a decaying-noise stereo impulse response. `size` 0..1 maps to ~0.3..3.0 s of
 * exponential-decay noise — longer + slower decay = bigger room. Pure buffer fill (no graph).
 * Math.random is fine here (UI-thread, one-shot on size change — not the resume-sensitive
 * scheduler path the workflow scripts ban it from).
 */
function buildReverbIr(ctx: BaseAudioContext, size: number): AudioBuffer {
  const s = clamp(size, 0, 1);
  const seconds = 0.3 + s * 2.7;
  const decay = 2.5 + s * 4; // higher = slower tail
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(seconds * rate));
  const ir = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const env = Math.pow(1 - i / len, decay);
      data[i] = (Math.random() * 2 - 1) * env;
    }
  }
  return ir;
}

/** REVERB — ConvolverNode with a generated decaying-noise IR, mixed against dry.
 *  params: size (0..1 → room/decay, rebuilds the IR), mix (0..1). */
export function buildReverb(ctx: BaseAudioContext): FxUnit {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const dry = ctx.createGain();
  const wet = ctx.createGain();
  wet.gain.value = 0;

  const convolver = ctx.createConvolver();
  convolver.buffer = buildReverbIr(ctx, 0.6);

  input.connect(dry).connect(output);
  input.connect(convolver).connect(wet).connect(output);

  let mix = 0.3;
  let on = false;
  return {
    input,
    output,
    setOn(next) {
      on = next;
      wet.gain.value = on ? mix : 0;
    },
    setParam(name, value) {
      switch (name) {
        case 'size':
          convolver.buffer = buildReverbIr(ctx, value);
          break;
        case 'mix':
          mix = clamp(value, 0, 1);
          if (on) wet.gain.value = mix;
          break;
      }
    },
  };
}
