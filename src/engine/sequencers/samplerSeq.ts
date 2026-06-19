/**
 * Sampler step sequencer (feature: drum machine) — pure Transport, the 5th scheduler
 * citizen beside monarchseq/anvilseq/cascadeclock/samplerloops. Holds NO audio nodes: it only
 * emits schedulable 'drumStep' (one UI column marker) + 'drumHit' (one ONE-SHOT per ON
 * cell) events; the studio binds 'drumHit' to SamplerModule.triggerPad(pad, time) — the
 * SAME fire-and-forget one-shot path as the SAMP_PAD{n}_TRIG_IN edge follower and the
 * pad audition, NEVER routed through launchPad / SamplerLoopClock and NEVER re-quantized.
 *
 * An 8-track × 16-step on/off pattern (track t = pad t). When RUNNING it advances one
 * column per master 16th, locked to the Monarch master grid it READS (monarchSeq.phaseRef()) —
 * it never alters the master. There is ONE master, so ONE shared phase.
 *
 * RUNNING MODEL (mirrors SamplerLoopClock): `running` is PERMANENTLY true so the scheduler
 * always pumps us (scheduler.pump skips transports with running===false — which would also
 * skip onPump, so we could never re-seat on the master run edge). The user-facing RUN/STOP
 * is the SEPARATE private `playing` flag. nextStepTime() returns Infinity when !playing OR
 * !phase.running, so a stopped/armed grid idles at nextEventTime=Infinity exactly like an
 * idle loop clock and the schedule loop never enters.
 *
 * NO-DRIFT ANCHOR MODEL (the EXACT samplerLoops pattern, not a re-derivation): `origin`
 * is a FIXED 16th-grid boundary captured at start()/on the run edge; the k-th step time is
 * the ABSOLUTE closed form
 *   origin + stepCounter · phase.sixteenthDurS
 * — a multiply from a fixed origin — so jitter cannot accumulate (structurally identical to
 * samplerLoops' firstLaunchTime + j·barPeriodS). sixteenthDurS is re-pulled live every
 * onPump, so a mid-run TEMPO change re-stretches FUTURE steps from the fixed origin with NO
 * accumulated per-step error. AND, because the Monarch master re-derives its 16th-lattice anchor
 * every pump (so a tempo change SHIFTS the master lattice phase), onPump while actively emitting
 * also re-snaps origin onto that LIVE lattice (round() to the nearest lattice point, stepCounter
 * untouched) — a no-op at constant tempo, a single re-lock at a tempo change — so the grid stays
 * phase-locked to the master instead of drifting a constant sub-step offset (see onPump).
 *
 * SCHEDULER-MONOTONICITY GUARD: scheduler.pump throws 'transport did not advance' if
 * nextEventTime <= the just-pulled boundary after advance(). With the closed form, advancing
 * stepCounter by 1 adds exactly sixteenthDurS (> 0 for any real tempo), so nextEventTime
 * strictly increases AS LONG AS sixteenthDurS stays fixed across the pull/advance pair.
 * onPump runs BEFORE the pull each pump (so any tempo change is absorbed before the boundary
 * is read), and advance() does NOT re-pull phase — it only does stepCounter++ then recompute()
 * using the SAME this.phase. Therefore within a single pump's pull/advance loop sixteenthDurS
 * is constant and monotonicity holds. (This is why advance() must NOT call phaseProvider —
 * only onPump may.)
 *
 * MASTER-STOPPED BEHAVIOR (v1, locked): the grid only EMITS while the Monarch master is running
 * (nextStepTime()=Infinity while !phase.running). start() while the master is stopped sets
 * playing=true + origin=now but emits nothing until the master runs, at which point onPump's
 * run-edge re-seat snaps origin onto the live 16th grid — no re-press needed. This matches
 * samplerLoops' "no running master ⇒ no relaunch" and keeps ONE tempo source.
 *
 * NO runAll/stopAll auto-start in v1 (independent machine). start/stop are exposed so the
 * studio COULD start/stop us from runAll/stopAll later (a one-line change).
 */

import type { Transport, TransportEvent } from '../scheduler';
import { nextBoundary, type PhaseRef } from '../quantGrid';

const PAD_COUNT = 8;
const DEFAULT_STEPS = 16;
// NB: sibling clocks (samplerLoops) keep an EPS=1e-9 boundary tolerance for their
// pending-target equality test; SamplerStepSeq has no pending targets — the step counter
// advances ONLY in advance() and pull is keyed off the scheduler boundary directly — so no
// EPS comparison is needed here (declaring an unused one would trip noUnusedLocals).

/** A neutral, stopped phase — used until the studio hands a live one in. */
function idlePhase(): PhaseRef {
  return { running: false, tempoBpm: 120, anchorTime: 0, sixteenthDurS: 60 / 120 / 4 };
}

export class SamplerStepSeq implements Transport {
  readonly id = 'samplerseq';
  running = true; // permanently true: scheduler must always pump us (idles at Infinity)
  nextEventTime = Infinity;

  private pattern: boolean[][] = Array.from({ length: PAD_COUNT }, () => new Array(DEFAULT_STEPS).fill(false));
  private numSteps = DEFAULT_STEPS; // 1..16 wrap length (v1 always 16)
  private playing = false; // user RUN/STOP
  /** The single master phase (one Monarch master); studio refreshes it before each effect. */
  private phase: PhaseRef = idlePhase();
  /** Live master-phase source (wired once by the studio to () => monarchSeq.phaseRef()). */
  private phaseProvider: (() => PhaseRef) | null = null;
  /** Absolute time of col 0 of the current run — the fixed no-drift anchor (a 16th boundary). */
  private origin = 0;
  /** Free-running 16th index since origin (drives both step time AND col via modulo). */
  private stepCounter = 0;

  /** Wire the live master-phase source once (studio.powerOn: () => monarchSeq.phaseRef()). */
  setPhaseProvider(provider: () => PhaseRef): void {
    this.phaseProvider = provider;
  }

  /** Hand in the freshest master phase (tempo + run state for the 16th grid). */
  setPhase(phase: PhaseRef): void {
    this.phase = phase;
    this.recompute();
  }

  /** Wrap length (1..16). v1 never calls it; present for a future var-length item. */
  setNumSteps(n: number): void {
    this.numSteps = Math.min(16, Math.max(1, Math.round(n)));
    this.recompute();
  }

  /** Toggle one cell. Out-of-range is a no-op. Pattern is read at the boundary, so no recompute. */
  setStep(track: number, col: number, on: boolean): void {
    if (track < 0 || track >= PAD_COUNT || col < 0 || col >= DEFAULT_STEPS) return;
    this.pattern[track]![col] = on;
  }

  /** Replace the whole grid (applyState path): deep-copy + clamp to exactly 8×16 strict booleans. */
  setPattern(pattern: boolean[][]): void {
    this.pattern = Array.from({ length: PAD_COUNT }, (_, t) =>
      Array.from({ length: DEFAULT_STEPS }, (_, s) => pattern?.[t]?.[s] === true),
    );
    this.recompute();
  }

  /** Zero the grid — rebuild a fresh 8×16 all-false (never mutate a shared ref in place). */
  clear(): void {
    this.pattern = Array.from({ length: PAD_COUNT }, () => new Array(DEFAULT_STEPS).fill(false));
  }

  /** Live RUN/STOP read for the latch lamp + getTransportFlags. */
  isPlaying(): boolean {
    return this.playing;
  }

  /**
   * RUN. Anchors origin to the first 16th boundary at/after now when the master is running
   * (nextBoundary degrades to `now` while the master is stopped — onPump re-seats on the run
   * edge). Resets the step counter; recompute() lifts nextEventTime off Infinity iff running.
   */
  start(now: number): void {
    // Refresh the master phase from the live provider before anchoring (one master ⇒ one
    // phase; the studio's other manual transports likewise re-read monarchSeq.phaseRef() right
    // before any effect — see launchPad's setPhase). Without this, a RUN issued between
    // pumps would anchor against a stale snapshot; the next onPump's run-edge re-seat would
    // still recover it, but seating correctly here keeps start() self-sufficient.
    if (this.phaseProvider) this.phase = this.phaseProvider();
    this.playing = true;
    this.origin = this.phase.running ? nextBoundary(now, '1/16', this.phase) : now;
    this.stepCounter = 0;
    this.recompute();
  }

  /** STOP. nextEventTime -> Infinity from the next read. */
  stop(): void {
    this.playing = false;
    this.recompute();
  }

  /**
   * Per-pump refresh (scheduler calls this with the pump's now, BEFORE reading nextEventTime).
   * Pulls the live master phase so a mid-run tempo change re-stretches FUTURE steps and a master
   * STOP halts emission from this pump on. On a stopped→running master edge (while we are playing)
   * it re-seats origin onto the now-running 16th grid + resets stepCounter, so an armed grid snaps
   * in without a re-press — mirrors samplerLoops.onPump. PURE given now() (no Date/Math.random).
   *
   * PHASE-LOCK (de-sync fix): the Monarch master re-derives its 16th lattice anchor EVERY pump
   * (phaseRef().anchorTime = baseTime − (tickCount%16)·sixteenthDurS, advancing with the NEW tempo
   * from a tempo-change boundary forward), so after a mid-run A→B tempo change the master lattice
   * SHIFTS PHASE. Our frozen origin would otherwise hold the OLD lattice phase, leaving a constant
   * sub-step offset for the rest of the run. So while we are ACTIVELY EMITTING (playing &&
   * phase.running, and NOT on the run-edge re-seat which already snaps a fresh origin), after the
   * fresh phase we re-snap origin onto the CURRENT master lattice via round() to the NEAREST lattice
   * point WITHOUT touching stepCounter — at constant tempo (consistent anchorTime) the nearest point
   * IS origin, so it does not move (no behavior change, monotonicity preserved); at a tempo change it
   * re-locks to the new lattice exactly once. The closed form origin + stepCounter·sixteenthDurS then
   * tracks the live lattice. A clamp keeps the next boundary strictly ahead of now should a tempo
   * change momentarily snap it back (re-anchor never emits a past event).
   */
  onPump(now: number): void {
    if (!this.phaseProvider) return;
    const wasRunning = this.phase.running;
    this.phase = this.phaseProvider();
    if (this.playing && !wasRunning && this.phase.running) {
      this.origin = nextBoundary(now, '1/16', this.phase);
      this.stepCounter = 0;
    } else if (this.playing && this.phase.running) {
      // re-lock the frozen anchor onto the master's LIVE 16th lattice (no counter change).
      const step = this.phase.sixteenthDurS;
      this.origin =
        this.phase.anchorTime + Math.round((this.origin - this.phase.anchorTime) / step) * step;
      // a tempo change could snap the next boundary to/just before now; advance the no-drift TIME
      // cursor (origin) by whole steps — NOT stepCounter — so the scheduler never sees a stale/past
      // boundary while the column sequence (col = stepCounter % numSteps) stays contiguous. origin
      // is already lattice-aligned, so adding a whole step keeps phase-lock; a stepCounter bump
      // would skip a drum column at the tempo change.
      while (this.origin + this.stepCounter * step < now) this.origin += step;
    }
    this.recompute();
  }

  /**
   * PURE: events for the boundary at `time`. Emits, IN THIS ORDER: ONE 'drumStep' UI marker
   * (the LED-chase column), then one 'drumHit' per ON cell in the current column (track order).
   * No field writes — the step counter advances ONLY in advance(), keeping pull idempotent for
   * the in-window boundary. Empty-pad ON cells still emit a 'drumHit' (triggerPad no-ops silently
   * when the pad has no buffer — correct, not a bug).
   */
  pullEventsAt(time: number): TransportEvent[] {
    const events: TransportEvent[] = [];
    const col = this.stepCounter % this.numSteps;
    events.push({ time, type: 'drumStep', data: { stepIndex: col } });
    for (let t = 0; t < PAD_COUNT; t++) {
      if (this.pattern[t]?.[col]) events.push({ time, type: 'drumHit', data: { pad: t } });
    }
    return events;
  }

  /** PURE: advance one 16th. O(1), NO phase pull (see the scheduler-monotonicity guard). */
  advance(): void {
    this.stepCounter++;
    this.recompute();
  }

  /** Next step time, or Infinity when stopped or the master isn't running. */
  private nextStepTime(): number {
    return !this.playing || !this.phase.running
      ? Infinity
      : this.origin + this.stepCounter * this.phase.sixteenthDurS;
  }

  private recompute(): void {
    this.nextEventTime = this.nextStepTime();
  }
}
