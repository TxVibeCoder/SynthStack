/**
 * Sampler loop clock (feature: loop-quantize) — pure Transport, the 4th scheduler
 * citizen beside monarchseq/anvilseq/cascadeclock. Holds NO audio nodes: it only emits
 * schedulable loopStart/loopStop/loopRelaunch events; the studio binds those to
 * SamplerModule.startLoop/stopLoop/relaunchLoop.
 *
 * It is a SEPARATE transport (not bolted onto monarchseq) so the Monarch stays a
 * faithful Monarch — the sampler bar grid only READS the master's phase
 * (monarchseq.phaseRef()), it never alters it. There is ONE master, so ONE shared phase
 * (the studio refreshes it before every effect).
 *
 * NO-DRIFT (belt-and-suspenders): the loop voice runs
 * source.loop=true for seamless intra-bar continuity AND this clock re-launches it on
 * every bar boundary. Each re-launch time is the ABSOLUTE closed form
 *   firstLaunchTime + j·barPeriodS(phase)
 * — a multiply from a fixed origin captured when the loop actually started — so jitter
 * cannot accumulate (structurally identical to quantGrid.nextBoundary). barPeriodS is
 * re-read each pump (onPump pulls the live master phase before nextEventTime is read),
 * so a tempo change re-stretches FUTURE bars without retro-jitter, a STOP halts re-launch
 * from the next pump, and a stopped→running edge re-seats a sounding loop onto the now-
 * running bar grid — without waiting for another UI tap. AND, because the Monarch master
 * re-derives its bar-lattice anchor every pump (so a tempo change SHIFTS the master lattice
 * phase), onPump while a loop is sounding also re-snaps firstLaunchTime onto that LIVE lattice
 * (round() to the nearest bar, relaunchIndex untouched) — a no-op at constant tempo, a single
 * re-lock at a tempo change — so re-launches stay phase-locked to the master instead of drifting
 * a constant sub-bar offset (see onPump).
 *
 * running is PERMANENTLY true so the scheduler always pumps this clock
 * (scheduler.pump skips transports with running===false); when nothing is pending or
 * looping, nextEventTime sits at Infinity and the schedule loop never enters.
 */

import type { Transport, TransportEvent } from '../scheduler';
import { barPeriodS, nextBoundary, type PhaseRef } from '../quantGrid';

const PAD_COUNT = 8;
const EPS = 1e-9; // boundary equality tolerance (audio-clock seconds)

/** A neutral, stopped phase — used until the studio hands a live one in. */
function idlePhase(): PhaseRef {
  return { running: false, tempoBpm: 120, anchorTime: 0, sixteenthDurS: 60 / 120 / 4 };
}

interface PadLoopState {
  looping: boolean;
  pendingStart: number | null; // quantized launch time, or null
  pendingStop: number | null; // quantized stop time, or null
  firstLaunchTime: number; // absolute time of bar 0 of the current run (set at loopStart)
  relaunchIndex: number; // j: count of re-launches emitted so far this run
}

function defaultPadLoop(): PadLoopState {
  return { looping: false, pendingStart: null, pendingStop: null, firstLaunchTime: 0, relaunchIndex: 0 };
}

export class SamplerLoopClock implements Transport {
  readonly id = 'samplerloops';
  running = true; // permanently true: scheduler must always pump us (idles at Infinity)
  nextEventTime = Infinity;

  private readonly pads: PadLoopState[] = Array.from({ length: PAD_COUNT }, defaultPadLoop);
  /** The single master phase (one Monarch master); studio refreshes it before each effect. */
  private phase: PhaseRef = idlePhase();
  /** Live master-phase source (wired once by the studio to () => monarchSeq.phaseRef()); when
   *  set, onPump pulls the freshest phase EVERY pump so tempo/run-state changes are honored
   *  without a UI tap. null until wired — the clock then runs on its last setPhase snapshot. */
  private phaseProvider: (() => PhaseRef) | null = null;

  /** The next re-launch boundary for a looping pad, or Infinity when it can't re-launch. */
  private padRelaunchTime(p: PadLoopState): number {
    if (!p.looping || !this.phase.running) return Infinity;
    return p.firstLaunchTime + p.relaunchIndex * barPeriodS(this.phase);
  }

  /** The earliest actionable boundary across one pad (start/stop/relaunch). */
  private padNextTime(p: PadLoopState): number {
    return Math.min(p.pendingStart ?? Infinity, p.pendingStop ?? Infinity, this.padRelaunchTime(p));
  }

  private recompute(): void {
    let next = Infinity;
    for (const p of this.pads) {
      const t = this.padNextTime(p);
      if (t < next) next = t;
    }
    this.nextEventTime = next;
  }

  /** Hand in the freshest master phase (tempo + run state for barPeriodS / running). */
  setPhase(phase: PhaseRef): void {
    this.phase = phase;
    this.recompute();
  }

  /** Wire the live master-phase source once (studio.powerOn: () => monarchSeq.phaseRef()). */
  setPhaseProvider(provider: () => PhaseRef): void {
    this.phaseProvider = provider;
  }

  /**
   * Per-pump refresh (scheduler calls this with the pump's now, before reading
   * nextEventTime). Pulls the live master phase so a tempo change re-stretches FUTURE
   * bars and a STOP halts re-launch from this pump on. On a stopped→running edge it
   * re-seats every still-sounding loop onto the now-running bar grid — firstLaunchTime =
   * the first bar boundary at/after now — so bar-grid re-launch resumes for a loop that
   * was launched while the master was stopped. PURE given now() (no Date/Math.random).
   *
   * PHASE-LOCK (de-sync fix): the Monarch master re-derives its bar lattice anchor EVERY pump
   * (phaseRef().anchorTime advancing with the NEW tempo from a tempo-change boundary forward),
   * so a mid-run A→B tempo change SHIFTS the master bar lattice phase. A frozen firstLaunchTime
   * would hold the OLD lattice phase, leaving every later re-launch a constant sub-bar offset off
   * the live master. So for each still-sounding loop (and NOT on the run-edge re-seat above, which
   * already snaps a fresh origin), after the fresh phase we re-snap firstLaunchTime onto the CURRENT
   * bar lattice via round() to the NEAREST lattice point WITHOUT touching relaunchIndex — a no-op at
   * constant tempo (the nearest point IS firstLaunchTime, so it doesn't move; monotonicity preserved),
   * a single re-lock at a tempo change. A clamp keeps the next re-launch strictly ahead of now should a
   * tempo change snap it back (re-anchor never emits a past event).
   */
  onPump(now: number): void {
    if (!this.phaseProvider) return;
    const wasRunning = this.phase.running;
    const fresh = this.phaseProvider();
    this.phase = fresh;
    if (!wasRunning && fresh.running) {
      // master just started: re-anchor any sounding loop onto the live bar grid so it
      // re-launches in phase with the master (a stopped-launched loop was off-grid).
      const origin = nextBoundary(now, '1 BAR', fresh);
      for (const p of this.pads) {
        if (p.looping) {
          p.firstLaunchTime = origin;
          p.relaunchIndex = 1; // next re-launch is bar 1 (origin + 1·barPeriod)
        }
      }
    } else if (fresh.running) {
      // re-lock each sounding loop onto the master's LIVE bar lattice (no index change).
      const barPeriod = barPeriodS(fresh);
      for (const p of this.pads) {
        if (!p.looping) continue;
        p.firstLaunchTime =
          fresh.anchorTime + Math.round((p.firstLaunchTime - fresh.anchorTime) / barPeriod) * barPeriod;
        // a tempo change could snap the next re-launch to/just before now; advance the index by
        // whole bars so the scheduler never sees a stale/past boundary (re-anchor emits no past).
        while (p.firstLaunchTime + p.relaunchIndex * barPeriod < now) p.relaunchIndex++;
      }
    }
    this.recompute();
  }

  /**
   * PANIC: clear every pad's loop + pending start/stop so nothing re-launches. The held
   * loop VOICES are stopped by the studio (sampler.stopLoop); this wipes the SCHEDULE so a
   * queued launch or per-bar re-launch can't resurrect a loop. Idles at Infinity afterwards.
   */
  panicAll(): void {
    for (const p of this.pads) {
      p.looping = false;
      p.pendingStart = null;
      p.pendingStop = null;
      p.relaunchIndex = 0;
    }
    this.recompute();
  }

  /** Declarative LOOP-flag mirror — does NOT start/stop audio (launch is tap-driven). */
  setLoopEnabled(_padIndex: number, _on: boolean): void {
    // The held-loop run is driven entirely by request*/pullEventsAt; the enabled flag
    // lives on SamplerModule (loopOn) and only decides which path the next tap takes.
    // Kept for the studio's declarative call symmetry; intentionally a no-op here.
  }

  /** Queue a quantized launch (last-tap-wins: clears any pending stop on this pad). */
  requestLaunch(padIndex: number, target: number, phase: PhaseRef): void {
    const p = this.pads[padIndex];
    if (!p) return;
    this.phase = phase;
    p.pendingStart = target;
    p.pendingStop = null;
    this.recompute();
  }

  /** Queue a quantized stop (last-tap-wins: clears any pending start on this pad). */
  requestStop(padIndex: number, target: number, phase: PhaseRef): void {
    const p = this.pads[padIndex];
    if (!p) return;
    this.phase = phase;
    p.pendingStop = target;
    p.pendingStart = null;
    this.recompute();
  }

  pullEventsAt(time: number): TransportEvent[] {
    const events: TransportEvent[] = [];
    for (let pad = 0; pad < PAD_COUNT; pad++) {
      const p = this.pads[pad]!;

      if (p.pendingStop != null && Math.abs(p.pendingStop - time) <= EPS) {
        events.push({ time, type: 'loopStop', data: { pad } });
        p.looping = false;
        p.pendingStop = null;
        // firstLaunchTime left stale — unused while not looping
        continue; // a stop and a relaunch can't co-fire (stop wins this boundary)
      }

      if (p.pendingStart != null && Math.abs(p.pendingStart - time) <= EPS) {
        events.push({ time, type: 'loopStart', data: { pad } });
        p.looping = true;
        p.pendingStart = null;
        p.firstLaunchTime = time; // fixed origin for the no-drift re-launch series
        p.relaunchIndex = 1; // next re-launch is bar 1 (firstLaunchTime + 1·barPeriod)
        continue;
      }

      const relaunch = this.padRelaunchTime(p);
      if (relaunch !== Infinity && Math.abs(relaunch - time) <= EPS) {
        events.push({ time, type: 'loopRelaunch', data: { pad } });
        p.relaunchIndex++;
      }
    }
    return events;
  }

  advance(): void {
    // Advancing past the current boundary: expire any pending start/stop sitting at/before it.
    // In the normal schedule loop pullEventsAt() has already cleared the target at this boundary,
    // so this is a no-op there; in the scheduler's stale fast-forward loop (a throttled tab whose
    // quantized launch went past with no pump to catch it) this DROPS the stale target so
    // recompute() makes progress instead of pinning nextEventTime at a past value forever (the
    // scheduler's "drop stale events, don't burst-schedule them" contract).
    const boundary = this.nextEventTime;
    for (const p of this.pads) {
      if (p.pendingStart != null && p.pendingStart <= boundary + EPS) p.pendingStart = null;
      if (p.pendingStop != null && p.pendingStop <= boundary + EPS) p.pendingStop = null;
    }
    this.recompute();
  }
}
