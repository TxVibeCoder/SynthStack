/**
 * Courier sequencer (Phase C MVP) — pure step-state + event generation.
 * 64 steps (4 pages x 16). 1 step = a clock-divider multiple of a 1/16 base note.
 * Event types emitted:
 *   'step'      { stepIndex }          UI LED chase marker (feeds scheduler.uiQueue)
 *   'paramLock' { lock }               per-step lock map (emitted EVERY step, {} when none)
 *   'pitch'     { noteVv, glide }      (suppressed on rests — CV holds)
 *   'gateOn'    {}                     at the exact step time
 *   'gateOff'   {}                     scheduled, never timed out
 *
 * Pure state machine: no Web Audio types, no Date/Math.random — Node-testable through
 * the real Scheduler. Mirrors monarchseq.ts (minus ratchet/accent/ASSIGN/external clock)
 * and adds a clock divider + a minimal OFF/UP/DOWN arpeggiator.
 *
 * C-FULL scope (other extension points noted inline, not yet implemented):
 *   - per-step `lock` param-lock slot: emitStepEvents forwards it as a 'paramLock' event every
 *     step; the binder (studio.ts) owns base-capture + restore-on-diff (the seq stays pure).
 *   - arpMode widening to the full pattern set (arpDir/arpCursor scaffolding present)
 *   - external clock follow (CLOCK IN) — one-line marker in pullEventsAt/advance
 *   - per-step ratchet / accent / probability
 */

import type { Transport, TransportEvent } from '../scheduler';
import { clamp, monarchStepDurS, swingOffsetS } from '../units';

export interface CourierStep {
  noteVv: number; // -1 = "no note authored" (rests/empty), else 1vv/oct, C5-relative
  gateLength: number; // 0.05..1.0; >=1 == TIE (carries gate into next step)
  rest: boolean; // REST = no gate, no pitch event (CV holds)
  glide: boolean; // per-step portamento on the pitch event
  lock: Record<string, number> | null; // per-step param-lock map (controlId -> engine-native value); null/empty = no locks. emitStepEvents forwards it as a paramLock event on every visited step.
}

export function defaultCourierStep(): CourierStep {
  return { noteVv: -1, gateLength: 0.5, rest: false, glide: false, lock: null };
}

export type CourierArpMode = 'OFF' | 'UP' | 'DOWN';

/** Clock-divider positions. Index stored in clockDivIdx; default '1/16'. */
export const COURIER_CLOCK_DIVS = ['1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32'] as const;
// multiplier vs a 1/16 base step (1/16 == 1.0): 1/4=4, 1/8=2, 1/8T=4/3, 1/16=1, 1/16T=2/3, 1/32=0.5
const COURIER_DIV_MULT = [4, 2, 4 / 3, 1, 2 / 3, 0.5] as const;

/** Step duration in seconds = the 1/16 base (monarchStepDurS) times the divider multiplier. */
export function courierStepDurS(bpm: number, divIdx: number): number {
  const i = clamp(Math.round(divIdx), 0, COURIER_DIV_MULT.length - 1);
  return monarchStepDurS(bpm) * COURIER_DIV_MULT[i]!;
}

export class CourierSequencer implements Transport {
  readonly id = 'courierseq';
  running = false;
  nextEventTime = Infinity;

  steps: CourierStep[] = Array.from({ length: 64 }, defaultCourierStep);
  endStep = 16; // 1..64 (LENGTH)
  swingPct = 50; // 0..100
  tempoBpm = 120; // BPM (NOT Hz) — clean LINK parity with the Monarch clock
  clockDivIdx = 3; // index into COURIER_CLOCK_DIVS; default '1/16'
  gateLenScale = 1; // global GATE LENGTH multiplier 0.05..1 on top of per-step gateLength
  glideTimeS = 0; // mirrors Monarch; the module's setPitchAt reads its OWN this.glideTimeS
  holdActive = false; // arp/seq HOLD freeze (kept for parity)
  arpMode: CourierArpMode = 'OFF';
  transposeVv = 0; // key-transpose relative to C5, added into emitted pitch

  private stepIndex = 0;
  private tickCount = 0;
  private baseTime = 0;
  private prevTied = false;
  private arpDir = 1; // pendulum hook (C-FULL UPDOWN/PENDULUM); MVP UP/DOWN never flip it
  private arpCursor = 0; // walks the authored-note list while arp is active

  get currentStep(): number {
    return this.stepIndex;
  }

  /** RUN starts from step 1 (hardware restarts the pattern). */
  start(now: number): void {
    this.stepIndex = 0;
    this.tickCount = 0;
    this.baseTime = now;
    this.nextEventTime = now;
    this.prevTied = false;
    this.arpDir = 1;
    this.arpCursor = 0;
    this.running = true;
  }

  stop(): void {
    this.running = false;
    this.nextEventTime = Infinity;
  }

  /** RESET: back to step 1 (phase/tempo grid unaffected). */
  reset(): void {
    this.stepIndex = 0;
    this.prevTied = false;
    this.arpDir = 1;
    this.arpCursor = 0;
  }

  private stepDur(): number {
    return courierStepDurS(this.tempoBpm, this.clockDivIdx);
  }

  pullEventsAt(time: number): TransportEvent[] {
    // EXTENSION POINT (C-FULL): if external CLOCK IN is patched, suppress the internal clock here
    // and let edge events drive stepping (clone Monarch's externalClock/onExternalEdge). MVP: internal only.
    return this.emitStepEvents(time, this.stepDur());
  }

  /** Build the current authored note's effective pitch, applying the MVP arp (OFF/UP/DOWN). */
  private effectiveNoteVv(step: CourierStep): number {
    if (this.arpMode === 'OFF') return step.noteVv;
    const list = this.arpList();
    if (list.length === 0) return -1; // no authored notes in window -> treat as rest
    const idx = ((this.arpCursor % list.length) + list.length) % list.length;
    return list[idx]!;
  }

  /** Ordered authored noteVv list over the pattern window [0..endStep): ascending (UP) / descending (DOWN). */
  private arpList(): number[] {
    const end = clamp(this.endStep, 1, 64);
    const notes: number[] = [];
    for (let i = 0; i < end; i++) {
      const s = this.steps[i]!;
      if (!s.rest && s.noteVv >= 0) notes.push(s.noteVv);
    }
    notes.sort((a, b) => a - b);
    if (this.arpMode === 'DOWN') notes.reverse();
    return notes;
  }

  /** Build the current step's events at `time`, gate spaced by `dur`. Does NOT advance. */
  private emitStepEvents(time: number, dur: number): TransportEvent[] {
    const events: TransportEvent[] = [];
    const step = this.steps[this.stepIndex]!;

    // 1. UI LED chase marker (always emitted).
    events.push({ time, type: 'step', data: { stepIndex: this.stepIndex } });

    // 1b. Param-lock (Phase C-Full). Emit the step's lock map VERBATIM on EVERY visited step —
    //   even no-lock steps emit an empty {} — so the binder can drive restore-on-diff (a no-lock
    //   step's empty map tells it to release any still-active locks). This is the crux of the
    //   restore design: emit-on-every-step turns wrap/jump/unlock restore into a pure per-step
    //   set-diff in the shell, with NO separate restore event and NO wrap detection here. Fires
    //   BEFORE the rest return — a lock is a knob value, independent of the gate, so it applies on
    //   rests too. PURE: the seq forwards the map by reference; it does NOT validate control ids,
    //   clamp values, or know the lockable allow-list (that lives in the binder via findModTarget).
    events.push({ time, type: 'paramLock', data: { lock: step.lock ?? {} } });

    // 2. REST: no gate, no pitch (CV holds).
    if (step.rest) return events;

    // 3. Effective note via arp, then key-transpose (applied AFTER arp selection so transpose
    //    shifts seq + arp output uniformly). Arp with an empty authored window -> treat as rest.
    const selected = this.effectiveNoteVv(step);
    if (selected < 0 && this.arpMode !== 'OFF') return events; // arp yielded no note
    const noteVv = selected + this.transposeVv;

    // 4. Pitch event (glideTimeS omitted — the binder/module reads its own glideTimeS).
    events.push({ time, type: 'pitch', data: { noteVv, glide: step.glide } });

    // 5. Gate logic (Monarch minus ratchet/accent). TIE keys off the RAW per-step gateLength,
    //    not the scaled value; the gate-off offset uses the scaled gate length.
    const gateLength = clamp(step.gateLength, 0.05, 1) * clamp(this.gateLenScale, 0.05, 1);
    const tie = step.gateLength >= 1;

    if (this.prevTied) {
      // gate already high from the previous (tied) step: no retrigger
      if (!tie) events.push({ time: time + gateLength * dur, type: 'gateOff' });
      return events;
    }

    events.push({ time, type: 'gateOn' });
    if (!tie) events.push({ time: time + gateLength * dur, type: 'gateOff' });
    return events;
  }

  /** Step bookkeeping: tie carry, step index (frozen under HOLD), tick + baseTime, arp cursor. */
  private advanceStep(durForBaseTime: number): void {
    const step = this.steps[this.stepIndex]!;
    this.prevTied = !step.rest && step.gateLength >= 1;
    if (!this.holdActive) {
      this.stepIndex = (this.stepIndex + 1) % clamp(this.endStep, 1, 64);
    }
    if (this.arpMode !== 'OFF') {
      const len = this.arpList().length;
      if (len > 0) this.arpCursor = (this.arpCursor + this.arpDir + len) % len;
    }
    this.tickCount++;
    this.baseTime += durForBaseTime; // tempo changes take effect from the next boundary
  }

  advance(): void {
    // EXTENSION POINT (C-FULL): when external CLOCK IN drives stepping, freeze the internal clock here.
    this.advanceStep(this.stepDur());
    const swung = this.tickCount % 2 === 1 ? swingOffsetS(this.swingPct, this.stepDur()) : 0;
    this.nextEventTime = this.baseTime + swung;
  }
}
