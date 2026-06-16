/**
 * Cascade polyrhythm clock engine — PURE, heavily tested.
 *
 * Four rhythm generators divide ONE integer tick counter by d1..d4 ∈ 1..16; each
 * sequencer advances when ANY of its assigned RGs fires this tick (OR-combine:
 * coincident RGs = one advance, one trigger). Because everything derives from one
 * integer counter, polyrhythmic lines can never drift.
 *
 * Event types:
 *   'pitchUpdate'  { seq (0|1), stepIndex }
 *   'egTrigger'    {}                        coalesced: at most one per tick
 *   'seqClkPulse'  { seq }
 *   'clockOutPulse'{}                        only while playing
 *   'rgFired'      { rgs: number[] }         UI LEDs
 */

import type { Transport, TransportEvent } from '../scheduler';
import { clamp, cascadeRhythmDivision } from '../units';

export type EgMode = 'OFF' | 'ON' | 'HELD';

export class CascadeClock implements Transport {
  readonly id = 'cascadeclock';
  running = false; // = PLAY ('playing')
  nextEventTime = Infinity;

  /** Master tick rate in Hz (TEMPO knob via units.cascadeTempoHz; CLOCK-in overrides). */
  tempoHz = 2;
  /** RG divider knob values 1..16 (before CV). */
  divisions: [number, number, number, number] = [1, 2, 3, 4];
  /** CV offsets per RG in vv (from RHYTHM 1–4 inputs), applied at tick evaluation. */
  divisionCvVv: [number, number, number, number] = [0, 0, 0, 0];
  /** assign[rg][seq] — RG (0..3) drives sequencer (0..1). */
  assign: [boolean, boolean][] = [
    [true, false],
    [false, true],
    [false, false],
    [false, false],
  ];
  egMode: EgMode = 'ON';
  /** Held RESET: stay on step 1; EGs keep triggering; NEXT still advances. */
  resetHeld = false;
  /** True while something is patched into CLOCK in — internal tempo ignored. */
  externalClock = false;

  private tickIndex = 0;
  private seqStep: [number, number] = [-1, -1];

  get steps(): [number, number] {
    return [this.seqStep[0], this.seqStep[1]];
  }

  get currentTick(): number {
    return this.tickIndex;
  }

  start(now: number): void {
    this.running = true;
    this.nextEventTime = now;
  }

  stop(): void {
    this.running = false;
    this.nextEventTime = Infinity;
  }

  /** RESET: tick counter and RG phases to zero; first tick lands on step 1. */
  reset(): void {
    this.tickIndex = 0;
    this.seqStep = [-1, -1];
  }

  /** NEXT: advance assigned sequencer steps WITHOUT an EG retrigger. */
  next(time: number): TransportEvent[] {
    const events: TransportEvent[] = [];
    for (const s of [0, 1] as const) {
      this.seqStep[s] = (this.seqStep[s] + 1) % 4;
      events.push({ time, type: 'pitchUpdate', data: { seq: s, stepIndex: this.seqStep[s] } });
    }
    return events;
  }

  private effectiveDivision(rg: number): number {
    return cascadeRhythmDivision(
      clamp(Math.round(this.divisions[rg as 0 | 1 | 2 | 3]), 1, 16),
      this.divisionCvVv[rg as 0 | 1 | 2 | 3],
    );
  }

  /** The onTick, as a pure pull. */
  pullEventsAt(time: number): TransportEvent[] {
    if (this.externalClock) return []; // CLOCK-in replaces the internal clock
    return this.tick(time);
  }

  private tick(time: number): TransportEvent[] {
    const events: TransportEvent[] = [];
    const fired: number[] = [];
    for (let rg = 0; rg < 4; rg++) {
      if (this.tickIndex % this.effectiveDivision(rg) === 0) fired.push(rg);
    }
    if (fired.length > 0) events.push({ time, type: 'rgFired', data: { rgs: fired } });

    let egTriggered = false;
    for (const s of [0, 1] as const) {
      const drives = fired.some((rg) => this.assign[rg]![s]);
      if (!drives) continue; // a sequencer with no assigned RG never advances
      if (!this.resetHeld) {
        this.seqStep[s] = (this.seqStep[s] + 1) % 4;
      } else if (this.seqStep[s] < 0) {
        this.seqStep[s] = 0; // held reset pins step 1
      }
      events.push({ time, type: 'pitchUpdate', data: { seq: s, stepIndex: Math.max(0, this.seqStep[s]) } });
      events.push({ time, type: 'seqClkPulse', data: { seq: s } });
      egTriggered = true;
    }
    if (egTriggered && this.egMode === 'ON') {
      events.push({ time, type: 'egTrigger' }); // coalesced — EGs are shared
    }
    events.push({ time, type: 'clockOutPulse' }); // gated by `running` upstream
    return events;
  }

  advance(): void {
    if (!this.externalClock) this.tickIndex++;
    this.nextEventTime += 1 / clamp(this.tempoHz, 0.05, 200);
  }

  /** CLOCK-in rising edge (external clock replaces internal). */
  onExternalEdge(time: number): TransportEvent[] {
    const events = this.tick(time);
    this.tickIndex++;
    return events;
  }
}
