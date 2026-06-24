/**
 * MIDI clock divider — PURE. Standard MIDI clock is 24 PPQN (0xF8). The studio's sequencers step on
 * 16th notes, so one 16th = every 6th tick (24 PPQN ÷ 6 = 4 PPQN — also the Cascade's
 * documented MIDI clock rate). Start (0xFA) re-aligns the ÷6 phase so the next tick is a downbeat;
 * Continue (0xFB) resumes without realigning; Stop (0xFC) halts. A lightly-smoothed BPM estimate
 * drives the TEMPO LED / TEMPO LINK.
 *
 * Tick TIMES are stamped to the audio clock by the shell (the bridge: device event → currentTime +
 * lead); this class is purely the divider + run state + tempo estimate, so it is Node-testable with
 * no AudioContext.
 */

export const MIDI_PPQN = 24;
/** 24 PPQN ÷ 4 sixteenths-per-quarter = a 16th every 6 ticks. */
export const TICKS_PER_SIXTEENTH = 6;

export class MidiClock {
  running = false;
  private tickPhase = 0; // 0..5 — the ÷6 divider counter
  private _lastTickTime = -1;
  private bpm = 120; // smoothed estimate

  /** Smoothed tempo estimate (BPM) from the incoming clock; 120 until enough ticks arrive. */
  get tempoBpm(): number {
    return this.bpm;
  }

  /** Audio-clock time of the most recent 0xF8 tick, or -1 before any tick / after reset/start. */
  get lastTickTime(): number {
    return this._lastTickTime;
  }

  /**
   * PURE watchdog predicate. True when the clock is RUNNING and at least one tick has been seen
   * but none has arrived for `gapS` seconds (`now - lastTickTime >= gapS`). Used by the scheduler
   * pump to auto-release MIDI master when the upstream clock silently stalls (no 0xFC Stop). A
   * stopped clock or one that has not yet ticked (lastTickTime < 0) is never stale.
   */
  staleSince(now: number, gapS: number): boolean {
    if (!this.running || this._lastTickTime < 0) return false;
    return now - this._lastTickTime >= gapS;
  }

  /**
   * A 0xF8 clock tick at audio time `t`. Updates the tempo estimate and the ÷6 divider, and returns
   * true when this tick lands on a 16th-note boundary AND the clock is running (Start received).
   */
  onTick(t: number): boolean {
    if (this._lastTickTime >= 0 && t > this._lastTickTime) {
      const inst = 60 / ((t - this._lastTickTime) * MIDI_PPQN);
      if (inst > 5 && inst < 1000) this.bpm += 0.2 * (inst - this.bpm); // light one-pole smoothing
    }
    this._lastTickTime = t;
    const isSixteenth = this.tickPhase === 0;
    this.tickPhase = (this.tickPhase + 1) % TICKS_PER_SIXTEENTH;
    return this.running && isSixteenth;
  }

  /** 0xFA Start: run from the top — the next tick is a 16th downbeat. */
  start(): void {
    this.running = true;
    this.tickPhase = 0;
    this._lastTickTime = -1;
  }

  /** 0xFB Continue: resume, keeping the current ÷6 phase. */
  continue(): void {
    this.running = true;
  }

  /** 0xFC Stop. */
  stop(): void {
    this.running = false;
  }

  reset(): void {
    this.running = false;
    this.tickPhase = 0;
    this._lastTickTime = -1;
    this.bpm = 120;
  }
}
