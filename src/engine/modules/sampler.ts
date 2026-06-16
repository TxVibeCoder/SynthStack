/**
 * Sampler voice (feature: sampler pads). 8 pads, native nodes only — no worklets.
 * Each pad owns a persistent chain built once in the ctor (nodes are never
 * destroyed; patching only changes edges):
 *
 *   AudioBufferSource (single-use, per trigger) -> velGain -> levelGain[n]
 *     -> vvScale[n] (×5 vv lift) -> outputTap('SAMP_PAD{n}_OUT')
 *                                -> outputTap('SAMP_MIX_OUT')   (fan-out)
 *
 * A decoded sample is ±1.0 float; the ×5 lift lands it in the module-out ±5 vv
 * convention (D8). The mixer's VV_TO_WEBAUDIO (×0.2) then brings the un-patched mix
 * path back to ±1.0 of the raw sample.
 */

import type { ModuleDef } from '../../../data/schema';
import { ModuleBase } from './moduleBase';
import { gain } from './helpers';

const PAD_COUNT = 8;
const VV_SCALE = 5; // ±1.0 sample -> ±5 vv module-out convention (D8)

export class SamplerModule extends ModuleBase {
  private readonly levelGain: GainNode[] = [];
  private readonly vvScale: GainNode[] = [];
  private readonly buffers: (AudioBuffer | null)[] = [];
  private readonly tuneSemis: number[] = [];
  // Loop state (feature: loop-quantize): the per-pad LOOP flag + the retained sounding
  // loop voice (triggerPad's one-shot sources stay fire-and-forget; a held loop needs a
  // handle to stop / hard-restart on the bar grid).
  private readonly loopEnabled: boolean[] = new Array(PAD_COUNT).fill(false);
  private readonly loopVoice: (AudioBufferSourceNode | null)[] = new Array(PAD_COUNT).fill(null);

  constructor(ctx: BaseAudioContext, def: ModuleDef) {
    super(ctx, def);

    const mixOut = this.outputTap('SAMP_MIX_OUT');
    for (let n = 1; n <= PAD_COUNT; n++) {
      const i = n - 1;
      const level = gain(ctx, 0.8); // SAMP_PAD{n}_LEVEL default
      const scale = gain(ctx, VV_SCALE);
      level.connect(scale);
      scale.connect(this.outputTap(`SAMP_PAD${n}_OUT`)); // own OUT jack (patchable)
      scale.connect(mixOut); // and the summed MIX (audible un-patched)
      this.levelGain[i] = level;
      this.vvScale[i] = scale;
      this.buffers[i] = null;
      this.tuneSemis[i] = 0;
    }
  }

  /** Fire pad `padIndex` (0..7) at `time`; no-op if the pad has no sample loaded. */
  triggerPad(padIndex: number, time: number, velocity = 1): void {
    const buffer = this.buffers[padIndex];
    if (!buffer) return; // empty pad — silent no-op
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = Math.pow(2, this.tuneSemis[padIndex]! / 12);
    const velGain = gain(this.ctx, velocity);
    src.connect(velGain).connect(this.levelGain[padIndex]!);
    src.onended = () => {
      // mandatory: release both single-use nodes so fast retrigger never leaks
      try {
        src.disconnect();
        velGain.disconnect();
      } catch {
        /* already disconnected */
      }
    };
    src.start(time);
  }

  /** True if the pad's LOOP switch is ON (scheduler/bridge enumeration). */
  loopOn(padIndex: number): boolean {
    return this.loopEnabled[padIndex] ?? false;
  }

  /** True if a held loop is currently sounding on the pad (bridge/panel live read). */
  isLoopSounding(padIndex: number): boolean {
    return this.loopVoice[padIndex] != null;
  }

  /**
   * Mint a fresh looping source for `padIndex` at `time` through the same persistent
   * chain triggerPad uses (src -> velGain(1) -> levelGain[i] -> vvScale -> OUT + MIX).
   * source.loop=true gives seamless intra-bar continuity; the scheduler hard-restarts
   * it on the bar grid (relaunchLoop) so phase re-quantizes every bar. No-op on an
   * empty pad. Any prior loop voice is stopped at `time` first (overlap-free).
   */
  startLoop(padIndex: number, time: number): void {
    this.launchLoopVoice(padIndex, time);
  }

  /** Bar-grid re-launch: hard-stop the prior voice and mint a fresh one at `time`. */
  relaunchLoop(padIndex: number, time: number): void {
    this.launchLoopVoice(padIndex, time);
  }

  /** Stop the held loop at `time` (onended releases the nodes). No-op if silent. */
  stopLoop(padIndex: number, time: number): void {
    const v = this.loopVoice[padIndex];
    if (!v) return;
    try {
      v.stop(time);
    } catch {
      /* already stopped */
    }
    this.loopVoice[padIndex] = null;
  }

  /** Shared start/re-launch impl: stop any sounding voice, then mint + start a fresh one. */
  private launchLoopVoice(padIndex: number, time: number): void {
    const buffer = this.buffers[padIndex];
    if (!buffer) return; // empty pad — silent no-op
    const prev = this.loopVoice[padIndex];
    if (prev) {
      try {
        prev.stop(time);
      } catch {
        /* already stopped */
      }
      this.loopVoice[padIndex] = null;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.playbackRate.value = Math.pow(2, this.tuneSemis[padIndex]! / 12);
    const velGain = gain(this.ctx, 1);
    src.connect(velGain).connect(this.levelGain[padIndex]!);
    src.onended = () => {
      // release both single-use nodes so fast bar re-launches never leak
      try {
        src.disconnect();
        velGain.disconnect();
      } catch {
        /* already disconnected */
      }
    };
    src.start(time);
    this.loopVoice[padIndex] = src;
  }

  /** Assign a decoded buffer to a pad; no graph rebuild (trigger reads it live). */
  loadPadBuffer(padIndex: number, buffer: AudioBuffer): void {
    this.buffers[padIndex] = buffer;
  }

  /** Drop a pad's buffer (INIT / resetAll silences a stale pad), stopping a sounding loop. */
  clearPadBuffer(padIndex: number): void {
    const v = this.loopVoice[padIndex];
    if (v) {
      try {
        v.stop();
      } catch {
        /* already stopped */
      }
      this.loopVoice[padIndex] = null;
    }
    this.buffers[padIndex] = null;
  }

  hasSample(padIndex: number): boolean {
    return this.buffers[padIndex] != null;
  }

  setControl(id: string, value: number | string): void {
    const num = typeof value === 'number' ? value : 0;
    const m = /_PAD(\d)_/.exec(id);
    if (!m) return;
    const i = Number(m[1]!) - 1; // SAMP_PAD{n}_* (\d guarantees the group) -> array index n-1
    if (i < 0 || i >= PAD_COUNT) return;
    if (id.endsWith('_LEVEL')) {
      this.levelGain[i]!.gain.value = num;
    } else if (id.endsWith('_TUNE')) {
      this.tuneSemis[i] = num; // read at next trigger; no live retune of sounding voices
    } else if (id.endsWith('_LOOP')) {
      this.loopEnabled[i] = value === 'ON'; // pure flag set; launch timing is scheduler-driven
    }
  }
}
