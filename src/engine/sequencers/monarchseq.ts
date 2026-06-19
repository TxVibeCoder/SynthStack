/**
 * Monarch sequencer v1 — pure step-state + event generation.
 * 1 step = 16th note fixed in v1. Event types emitted:
 *   'pitch'      { noteVv, glide, glideTimeS }   (suppressed on rests — CV holds)
 *   'gateOn'     { accent }                       at exact step/ratchet times
 *   'gateOff'    {}                               scheduled, never timed out
 *   'accentOn' / 'accentOff'
 *   'assignPulse' {}                              ASSIGN out mode 2: 1 pulse per step
 *   'step'       { stepIndex }                    UI LED chase marker
 */

import type { Transport, TransportEvent } from '../scheduler';
import type { PhaseRef } from '../quantGrid';
import { clamp, monarchStepDurS, swingOffsetS } from '../units';

export interface MonarchStep {
  noteVv: number;
  gateLength: number; // 0.05..1.0; 1.0 (with ratchet 1) = tie
  accent: boolean;
  rest: boolean;
  glide: boolean;
  ratchet: 1 | 2 | 3 | 4;
}

export function defaultStep(): MonarchStep {
  return { noteVv: -1, gateLength: 0.5, accent: false, rest: false, glide: false, ratchet: 1 };
}

export class MonarchSequencer implements Transport {
  readonly id = 'monarchseq';
  running = false;
  nextEventTime = Infinity;

  steps: MonarchStep[] = Array.from({ length: 32 }, defaultStep);
  endStep = 16; // 1..32
  swingPct = 50;
  tempoBpm = 120;
  glideTimeS = 0;
  holdActive = false;
  /** True while something is patched into MON_TEMPO IN — internal clock suppressed, edges step it
   *  (Monarch TEMPO "Single Clock Advance" default mode). The module binding flips this and calls
   *  onExternalEdge() from the follower mechanism, exactly like Anvil ADV/CLOCK & Cascade CLOCK in. */
  externalClock = false;

  private stepIndex = 0;
  private tickCount = 0;
  private baseTime = 0;
  private prevTied = false;

  get currentStep(): number {
    return this.stepIndex;
  }

  /**
   * Master bar/beat phase for the sampler quantize grid (loop-quantize feature).
   * PURE read of the run state — no field/behavior change. anchorTime is the audio
   * time of the CURRENT bar's downbeat (a 16-sixteenth bar, 4/4), derived from the
   * un-swung baseTime + the true elapsed-16th tickCount so the grid is swing-immune
   * and stays absolute under HOLD / any endStep. The sampler reads this; the Monarch
   * itself never consumes it. See quantGrid.ts.
   */
  phaseRef(): PhaseRef {
    const sixteenthDurS = monarchStepDurS(this.tempoBpm);
    const anchorTime = this.baseTime - (this.tickCount % 16) * sixteenthDurS;
    return { running: this.running, tempoBpm: this.tempoBpm, anchorTime, sixteenthDurS };
  }

  /** RUN starts from step 1 (hardware restarts the pattern). */
  start(now: number): void {
    this.stepIndex = 0;
    this.tickCount = 0;
    this.baseTime = now;
    this.nextEventTime = now;
    this.prevTied = false;
    this.running = true;
  }

  stop(): void {
    this.running = false;
    this.nextEventTime = Infinity;
  }

  /** RESET: back to step 1 (phase/tempo grid unaffected). */
  reset(): void {
    this.stepIndex = 0;
    this.prevTied = false; // mirror start(): a RESET after a tied step must re-arm step 1's gate
  }

  private stepDur(): number {
    return monarchStepDurS(this.tempoBpm);
  }

  pullEventsAt(time: number): TransportEvent[] {
    if (this.externalClock) return []; // MON_TEMPO edges drive stepping; internal clock suppressed
    return this.emitStepEvents(time, this.stepDur());
  }

  /** Build the current step's events at `time`, gate/ratchet spaced by `dur` (the internal step
   *  duration, or the measured external clock interval). Does NOT advance. */
  private emitStepEvents(time: number, dur: number): TransportEvent[] {
    const events: TransportEvent[] = [];
    const step = this.steps[this.stepIndex]!;

    events.push({ time, type: 'step', data: { stepIndex: this.stepIndex } });
    // ASSIGN out fires once per step; the data lets the binder realize ANY of the 9 analog ASSIGN
    // sources (clock dividers, step ramp/saw/tri/random, accent, step-1 trigger) without the pure
    // seq touching audio. The pulse-count tests stay green (one assignPulse per step, as before).
    events.push({
      time,
      type: 'assignPulse',
      data: {
        stepIndex: this.stepIndex,
        endStep: clamp(this.endStep, 1, 32),
        tickCount: this.tickCount,
        accent: step.accent,
        isStep1: this.stepIndex === 0,
      },
    });

    if (step.rest) {
      // rest: no gate, pitch CV holds (no pitch event)
      return events;
    }

    events.push({
      time,
      type: 'pitch',
      data: { noteVv: step.noteVv, glide: step.glide, glideTimeS: this.glideTimeS },
    });

    const gateLength = clamp(step.gateLength, 0.05, 1);
    const tie = gateLength >= 1 && step.ratchet === 1;

    if (this.prevTied) {
      // gate is already high from the previous step: no retrigger
      if (!tie) {
        events.push({ time: time + gateLength * dur, type: 'gateOff' });
        if (step.accent) {
          events.push({ time, type: 'accentOn' });
          events.push({ time: time + gateLength * dur, type: 'accentOff' });
        }
      }
      return events;
    }

    if (step.accent) {
      events.push({ time, type: 'accentOn' });
      events.push({ time: time + (tie ? dur : gateLength * dur), type: 'accentOff' });
    }

    const n = step.ratchet;
    const subDur = dur / n;
    for (let r = 0; r < n; r++) {
      const on = time + r * subDur;
      events.push({ time: on, type: 'gateOn', data: { accent: step.accent } });
      if (!tie) {
        events.push({ time: on + gateLength * subDur, type: 'gateOff' });
      }
    }
    return events;
  }

  /** Step bookkeeping shared by the internal clock (advance) and external clocking (onExternalEdge):
   *  tie carry-over, step index (frozen under HOLD), tick count, and baseTime (by `durForBaseTime`). */
  private advanceStep(durForBaseTime: number): void {
    const step = this.steps[this.stepIndex]!;
    this.prevTied = !step.rest && clamp(step.gateLength, 0.05, 1) >= 1 && step.ratchet === 1;
    if (!this.holdActive) {
      this.stepIndex = (this.stepIndex + 1) % clamp(this.endStep, 1, 32);
    }
    this.tickCount++;
    this.baseTime += durForBaseTime; // tempo changes take effect from the next boundary
  }

  advance(): void {
    if (this.externalClock) {
      this.nextEventTime = Infinity; // stepped by onExternalEdge, never the lookahead clock
      return;
    }
    this.advanceStep(this.stepDur());
    const swung = this.tickCount % 2 === 1 ? swingOffsetS(this.swingPct, this.stepDur()) : 0;
    this.nextEventTime = this.baseTime + swung;
  }

  /**
   * MON_TEMPO IN rising edge — the Monarch TEMPO default "Single Clock Advance" mode: emit the
   * current step's events at `time` (ratchets/gate spaced by the MEASURED external interval, per the
   * manual: "Ratchets performed in synchronization with the incoming clock"), then advance one step.
   * `intervalS` is the gap since the previous edge; the first edge falls back to the internal step
   * duration. Order matches Anvil/Cascade: fire the current step, then advance.
   */
  onExternalEdge(time: number, intervalS?: number): TransportEvent[] {
    const dur = intervalS !== undefined && intervalS > 0 ? intervalS : this.stepDur();
    const events = this.emitStepEvents(time, dur);
    this.advanceStep(dur);
    return events;
  }

  /** Re-anchor the internal clock to `now` (e.g. the MON_TEMPO cable was unplugged while running)
   *  without disturbing the current step — so the lookahead clock resumes instead of freezing. */
  resumeInternal(now: number): void {
    this.baseTime = now;
    this.nextEventTime = now;
    this.prevTied = false;
  }
}
