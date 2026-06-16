/**
 * Anvil sequencer — pure. 8 steps, no rests, no gates: every step
 * fires a ~1 ms trigger into all three EGs at that step's velocity and updates the
 * PITCH/VELOCITY CV buses. Event types:
 *   'step'    { stepIndex, pitchVv, velocityVv }  (CV bus updates + LED)
 *   'trigger' { velocityVv }                       (1 ms +5 pulse to the EGs)
 *
 * Transport: RUN/STOP advances on the internal clock. Stopped: ADVANCE moves one
 * step WITHOUT triggering; TRIGGER fires the current step WITHOUT advancing.
 * Order on the clock: fire current step, then advance.
 * With ADV/CLOCK patched the internal clock is ignored — the module binding flips
 * `externalClock` and calls onExternalEdge() from the follower mechanism.
 */

import type { Transport, TransportEvent } from '../scheduler';
import { clamp } from '../units';

export interface AnvilStep {
  pitchVv: number; // -5..+5
  velocityVv: number; // 0..+5
}

export class AnvilSequencer implements Transport {
  readonly id = 'anvilseq';
  running = false;
  nextEventTime = Infinity;

  steps: AnvilStep[] = Array.from({ length: 8 }, () => ({ pitchVv: 0, velocityVv: 4 }));
  /** Step rate in Hz (TEMPO knob + CV via units.anvilStepRateHz). */
  rateHz = 8;
  /** True while something is patched into ADV/CLOCK — internal clock ignored. */
  externalClock = false;

  private stepIndex = 0;

  get currentStep(): number {
    return this.stepIndex;
  }

  start(now: number): void {
    this.running = true;
    this.nextEventTime = now;
  }

  stop(): void {
    this.running = false;
    this.nextEventTime = Infinity;
  }

  private stepEvents(time: number, withTrigger: boolean): TransportEvent[] {
    const step = this.steps[this.stepIndex]!;
    const events: TransportEvent[] = [
      {
        time,
        type: 'step',
        data: { stepIndex: this.stepIndex, pitchVv: step.pitchVv, velocityVv: step.velocityVv },
      },
    ];
    if (withTrigger) {
      events.push({ time, type: 'trigger', data: { velocityVv: step.velocityVv } });
    }
    return events;
  }

  pullEventsAt(time: number): TransportEvent[] {
    if (this.externalClock) return []; // internal clock ignored while ADV/CLOCK is patched
    return this.stepEvents(time, true);
  }

  advance(): void {
    if (!this.externalClock) {
      this.stepIndex = (this.stepIndex + 1) % 8;
    }
    this.nextEventTime += 1 / clamp(this.rateHz, 0.05, 4000);
  }

  /** ADVANCE button (stopped): move one step without triggering. */
  manualAdvance(time: number): TransportEvent[] {
    this.stepIndex = (this.stepIndex + 1) % 8;
    return this.stepEvents(time, false);
  }

  /** TRIGGER button (stopped): fire the current step without advancing. */
  manualTrigger(time: number): TransportEvent[] {
    return this.stepEvents(time, true);
  }

  /** ADV/CLOCK rising edge: advance one step AND trigger it (external clocking). */
  onExternalEdge(time: number): TransportEvent[] {
    this.stepIndex = (this.stepIndex + 1) % 8;
    return this.stepEvents(time, true);
  }
}
