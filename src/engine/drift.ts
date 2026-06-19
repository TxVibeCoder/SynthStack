/**
 * Per-VCO drift binding: a ConstantSourceNode nudged by the pure
 * DriftWalk via setTargetAtTime(τ = 1.0 s). One instance per oscillator; subs share
 * their parent's drift. The pump keeps a few seconds of automation queued ahead on
 * the audio clock — drift is param automation, not a musical event, so the
 * "no setInterval for audio events" rule is honored (the scheduler owns events;
 * this only tops up future automation).
 */

import { DriftWalk } from './dsp/driftCore';

export const DRIFT_ENABLED = true; // config

export class DriftSource {
  readonly output: ConstantSourceNode;
  private readonly walk: DriftWalk;
  private queuedUntil = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly ctx: BaseAudioContext, seed?: number) {
    this.output = ctx.createConstantSource();
    this.output.offset.value = 0;
    this.output.start();
    this.walk = new DriftWalk(seed ?? Math.floor(Math.random() * 2 ** 31));
  }

  /** Queue automation so at least `aheadS` seconds of drift are always scheduled. */
  topUp(aheadS = 5): void {
    if (!DRIFT_ENABLED) return;
    const now = this.ctx.currentTime;
    if (this.queuedUntil < now) this.queuedUntil = now;
    while (this.queuedUntil < now + aheadS) {
      const step = this.walk.next();
      this.output.offset.setTargetAtTime(step.targetVv, this.queuedUntil, 1.0);
      this.queuedUntil += step.intervalS;
    }
  }

  start(): void {
    if (!DRIFT_ENABLED) return; // no idle timer when drift is off (topUp would no-op anyway)
    if (this.timer) return;
    this.topUp();
    this.timer = setInterval(() => this.topUp(), 2000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
