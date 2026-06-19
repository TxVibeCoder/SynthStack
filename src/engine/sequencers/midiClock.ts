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
  private lastTickTime = -1;
  private bpm = 120; // smoothed estimate

  /** Smoothed tempo estimate (BPM) from the incoming clock; 120 until enough ticks arrive. */
  get tempoBpm(): number {
    return this.bpm;
  }

  /**
   * A 0xF8 clock tick at audio time `t`. Updates the tempo estimate and the ÷6 divider, and returns
   * true when this tick lands on a 16th-note boundary AND the clock is running (Start received).
   */
  onTick(t: number): boolean {
    if (this.lastTickTime >= 0 && t > this.lastTickTime) {
      const inst = 60 / ((t - this.lastTickTime) * MIDI_PPQN);
      if (inst > 5 && inst < 1000) this.bpm += 0.2 * (inst - this.bpm); // light one-pole smoothing
    }
    this.lastTickTime = t;
    const isSixteenth = this.tickPhase === 0;
    this.tickPhase = (this.tickPhase + 1) % TICKS_PER_SIXTEENTH;
    return this.running && isSixteenth;
  }

  /** 0xFA Start: run from the top — the next tick is a 16th downbeat. */
  start(): void {
    this.running = true;
    this.tickPhase = 0;
    this.lastTickTime = -1;
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
    this.lastTickTime = -1;
    this.bpm = 120;
  }
}
