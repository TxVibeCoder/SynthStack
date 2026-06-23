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
 * and adds a clock divider + a FULL arpeggiator (13 patterns + octave span + programmable rhythm).
 *
 * ARP (C-FULL): arpMode spans the full pattern set (see CourierArpMode); arpOctave (1..4) expands
 * the authored-note set across octaves; arpRhythmIdx selects the arp's own clock division (the arp
 * runs independent of the seq grid). The whole pattern traversal is baked into arpList() so the
 * cursor walks it forward; RANDOM/RANDOM_WALK index a seeded-PRNG stash instead; CHORD sounds the
 * whole list at once. Composes with PROBABILITY (a skipped/ghost step suppresses pitch/gate).
 *
 * C-FULL scope (other extension points noted inline, not yet implemented):
 *   - per-step `lock` param-lock slot: emitStepEvents forwards it as a 'paramLock' event every
 *     step; the binder (studio.ts) owns base-capture + restore-on-diff (the seq stays pure).
 *   - programmable-rhythm per-arp-step on/off MASK + sub-step ratchet (rate is built; mask is not)
 *   - external clock follow (CLOCK IN) — one-line marker in pullEventsAt/advance
 *   - per-step accent
 *
 * PROBABILITY (C-FULL): per-step NOTE PROB / GATE PROB / NOTE POOL, made deterministic via a
 * SEEDED PRNG (mulberry32, reused from dsp/driftCore — NEVER Math.random, banned by repo
 * convention AND inside pullEventsAt). The rng is reseeded FROM `seed` in start()/reset(). ALL
 * draws happen in advanceStep (the sole mutation site, run once per scheduler boundary): for the
 * step it just LANDED on, rollStepDecisions draws four values and stashes them
 * (stepNoteFires/stepGateFires/stepPoolPick/arpRandomIdx). The pure pullEventsAt/emitStepEvents
 * only READ those stashes, so pullEventsAt stays read-only/idempotent given the PRNG state. Step 0
 * is rolled at the END of start() (before the first pull). All four are drawn EVERY step (unused
 * ones discarded) so the stream is positionally stable as more arp patterns land (arpRandomIdx is
 * the reserved slot for the full-arp RANDOM pattern, drawn now to fix the stream).
 */

import type { Transport, TransportEvent } from '../scheduler';
import { mulberry32 } from '../dsp/driftCore';
import { clamp, monarchStepDurS, swingOffsetS } from '../units';

export interface CourierStep {
  noteVv: number; // -1 = "no note authored" (rests/empty), else 1vv/oct, C5-relative
  gateLength: number; // 0.05..1.0; >=1 == TIE (carries gate into next step)
  rest: boolean; // REST = no gate, no pitch event (CV holds)
  glide: boolean; // per-step portamento on the pitch event
  lock: Record<string, number> | null; // per-step param-lock map (controlId -> engine-native value); null/empty = no locks. emitStepEvents forwards it as a paramLock event on every visited step.
  noteProb: number; // 0..1 chance the step's note sounds at all (1 = always)
  gateProb: number; // 0..1 chance the gate fires GIVEN the step sounds (1 = always)
  notePool: number[]; // candidate noteVv pool; empty = use noteVv, non-empty = one entry chosen per pass
}

export function defaultCourierStep(): CourierStep {
  return {
    noteVv: -1,
    gateLength: 0.5,
    rest: false,
    glide: false,
    lock: null,
    noteProb: 1,
    gateProb: 1,
    notePool: [],
  };
}

/**
 * Full arpeggiator pattern set (C-FULL). OFF disables the arp (per-step authored notes play).
 * The 13 active patterns:
 *   UP / DOWN               — ascending / descending walk over the authored-note pool
 *   UPDOWN_INC / DOWNUP_INC — bounce hitting BOTH end notes twice (…2,2,1,0 / …0,0,1,2)
 *   UPDOWN_EXC / DOWNUP_EXC — bounce WITHOUT repeating the turnaround notes (…2,1 / …0,1)
 *   CONVERGE                — outside-in (lowest, highest, 2nd-lowest, 2nd-highest, …)
 *   DIVERGE                 — inside-out (middle outward) = CONVERGE reversed
 *   PENDULUM                — up-then-down hitting both ends (classic bounce; == UPDOWN_INC order)
 *   AS_PLAYED               — authored insertion order (NOT sorted)
 *   RANDOM                  — a fresh uniform pick each step (seeded PRNG, deterministic)
 *   RANDOM_WALK             — +/-1 random step from the previous index (seeded PRNG)
 *   CHORD                   — all pool notes sounded simultaneously on the step
 * Octave span (arpOctave 1..4) and a programmable rhythm (arpRhythmIdx, an independent clock
 * division) layer on top of every pattern. The whole traversal is baked into arpList() so the
 * cursor simply walks it forward; RANDOM/RANDOM_WALK index from the seeded-PRNG stash instead.
 */
export type CourierArpMode =
  | 'OFF'
  | 'UP'
  | 'DOWN'
  | 'UPDOWN_INC'
  | 'UPDOWN_EXC'
  | 'DOWNUP_INC'
  | 'DOWNUP_EXC'
  | 'CONVERGE'
  | 'DIVERGE'
  | 'PENDULUM'
  | 'AS_PLAYED'
  | 'RANDOM'
  | 'RANDOM_WALK'
  | 'CHORD';

/** Clock-divider positions. Index stored in clockDivIdx; default '1/16'. */
export const COURIER_CLOCK_DIVS = ['1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32'] as const;
/** ARP RHYTHM divisions — the arp clock runs on its own division (arpRhythmIdx), independent of
 *  the seq grid (clockDivIdx). Aliased to the same division table; default '1/16'. */
export const ARP_RHYTHMS = COURIER_CLOCK_DIVS;
// multiplier vs a 1/16 base step (1/16 == 1.0): 1/4=4, 1/8=2, 1/8T=4/3, 1/16=1, 1/16T=2/3, 1/32=0.5
const COURIER_DIV_MULT = [4, 2, 4 / 3, 1, 2 / 3, 0.5] as const;
/** Highest octave the arp spans above the authored notes (arpOctave). 1 = no expansion. */
const COURIER_ARP_MAX_OCTAVE = 4;
/** One octave up in vv (1vv/oct), used to duplicate the authored-note set across octaves. */
const ARP_OCTAVE_VV = 1.0;

/** CONVERGE traversal of an ascending run: outside-in pairs (lowest, highest, 2nd-lowest,
 *  2nd-highest, …, middle). Pure; DIVERGE is this reversed. e.g. [0,1,2,3] -> [0,3,1,2]. */
function convergeOrder(run: number[]): number[] {
  const out: number[] = [];
  let lo = 0;
  let hi = run.length - 1;
  while (lo <= hi) {
    out.push(run[lo]!);
    if (hi !== lo) out.push(run[hi]!);
    lo++;
    hi--;
  }
  return out;
}

/** Step duration in seconds = the 1/16 base (monarchStepDurS) times the divider multiplier. */
export function courierStepDurS(bpm: number, divIdx: number): number {
  const i = clamp(Math.round(divIdx), 0, COURIER_DIV_MULT.length - 1);
  return monarchStepDurS(bpm) * COURIER_DIV_MULT[i]!;
}

export class CourierSequencer implements Transport {
  readonly id = 'courierseq';
  running = false;
  nextEventTime = Infinity;

  /** When a cable is patched into COU_CLOCK_IN the internal lookahead clock is suppressed and the
   *  pattern is stepped by onExternalEdge() from the follower mechanism — exactly like the Monarch
   *  TEMPO IN, Anvil ADV/CLOCK and Cascade CLOCK in. studio.ts toggles this in rebuildFollowers. */
  externalClock = false;

  steps: CourierStep[] = Array.from({ length: 64 }, defaultCourierStep);
  endStep = 16; // 1..64 (LENGTH)
  swingPct = 50; // 0..100
  tempoBpm = 120; // BPM (NOT Hz) — clean LINK parity with the Monarch clock
  clockDivIdx = 3; // index into COURIER_CLOCK_DIVS; default '1/16'
  gateLenScale = 1; // global GATE LENGTH multiplier 0.05..1 on top of per-step gateLength
  glideTimeS = 0; // mirrors Monarch; the module's setPitchAt reads its OWN this.glideTimeS
  holdActive = false; // arp/seq HOLD freeze (kept for parity)
  arpMode: CourierArpMode = 'OFF';
  arpOctave = 1; // 1..4 — arp spans N octaves of the authored-note set (1 = no expansion)
  arpRhythmIdx = 3; // index into ARP_RHYTHMS; the arp's own clock division when mode is ARP (default '1/16')
  transposeVv = 0; // key-transpose relative to C5, added into emitted pitch
  seed = 1; // PRNG seed (persisted, never force-defaulted); reseeds rng in start()/reset()

  private stepIndex = 0;
  private tickCount = 0;
  private baseTime = 0;
  private prevTied = false;
  private arpDir = 1; // walk direction; the pendulum/up-down family flip it at the list ends
  private arpCursor = 0; // walks the (baked) arp traversal list forward while the arp is active

  // Seeded PRNG (mulberry32) + per-step decision stashes. Reseeded from `seed` in start()/reset().
  // rollStepDecisions(idx) draws into these in advanceStep (and once for step 0 at end of start);
  // emitStepEvents READS them for the current step. pullEventsAt never draws (stays pure).
  private rng: () => number = mulberry32(this.seed >>> 0);
  private stepNoteFires = true; // did the just-landed step win its noteProb roll?
  private stepGateFires = true; // did it win its gateProb roll (given it sounds)?
  private stepPoolPick = 0; // index into the step's notePool chosen this pass
  // Arp-random stashes (drawn in rollStepDecisions from the same per-step stream; read on the next
  // pull). arpRandomIdx = the RANDOM pattern's fresh uniform index into the arp list; arpWalkRoll =
  // the raw [0,1) roll the RANDOM_WALK pattern uses to step +/-1 from the previous index. Drawn every
  // step (discarded unless the active pattern is RANDOM/RANDOM_WALK) so the PRNG stream is stable.
  private arpRandomIdx = 0;
  private arpWalkRoll = 0;

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
    this.rng = mulberry32(this.seed >>> 0); // deterministic re-seed: same seed -> same pattern
    this.rollStepDecisions(0); // roll step 0 BEFORE the first pull (scheduler pulls then advances)
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
    this.rng = mulberry32(this.seed >>> 0); // re-seed so RESET reproduces the run
    this.rollStepDecisions(0);
  }

  /**
   * Draw the four probability/random decisions for step `idx` and stash them. Called ONLY from
   * advanceStep (and once for step 0 at the end of start/reset). ALWAYS draws all four (discarding
   * any unused) so the PRNG stream is positionally stable. PURE w.r.t. the caller — the only side
   * effect is advancing `this.rng` and writing the stashes. Clamps every derived value finite.
   */
  private rollStepDecisions(idx: number): void {
    const step = this.steps[clamp(idx, 0, 63)]!;
    const rNote = this.rng();
    const rGate = this.rng();
    const rPool = this.rng();
    const rArp = this.rng(); // 4th draw — the full-arp RANDOM index + RANDOM_WALK step (else discarded)
    // note sounds if its roll is under noteProb (noteProb 1 -> always; 0 -> never)
    this.stepNoteFires = rNote < clamp(step.noteProb, 0, 1);
    // gate fires (given the note sounds) if its roll is under gateProb
    this.stepGateFires = rGate < clamp(step.gateProb, 0, 1);
    // pool pick: floor(roll * poolLen), clamped into range (poolLen 0 -> 0, unused)
    const poolLen = step.notePool.length;
    this.stepPoolPick = poolLen > 0 ? clamp(Math.floor(rPool * poolLen), 0, poolLen - 1) : 0;
    // arp RANDOM index: a fresh uniform pick over the current arp list (length unused when OFF).
    const arpLen = this.arpList().length;
    this.arpRandomIdx = arpLen > 0 ? clamp(Math.floor(rArp * arpLen), 0, arpLen - 1) : 0;
    this.arpWalkRoll = rArp; // raw roll for the RANDOM_WALK +/-1 decision
  }

  /** True when the arp is supplying notes (any non-OFF pattern). */
  private arpActive(): boolean {
    return this.arpMode !== 'OFF';
  }

  private stepDur(): number {
    // The arp runs on its OWN clock division (arpRhythmIdx) independent of the seq grid
    // (clockDivIdx) — a one-line swap gated on the arp being active. PROGRAMMABLE RHYTHM extension
    // point: a per-arp-step boolean rhythm mask (skip/play per tick) and sub-step ratchet (cf.
    // monarchseq) would layer here; not built this phase.
    const divIdx = this.arpActive() ? this.arpRhythmIdx : this.clockDivIdx;
    return courierStepDurS(this.tempoBpm, divIdx);
  }

  pullEventsAt(time: number): TransportEvent[] {
    if (this.externalClock) return []; // COU_CLOCK_IN edges drive stepping; internal clock suppressed
    return this.emitStepEvents(time, this.stepDur());
  }

  /** The step's base note BEFORE the arp: the chosen NOTE POOL entry (if any) replaces noteVv.
   *  The pool pick is the per-pass index stashed by rollStepDecisions (deterministic). */
  private baseNoteVv(step: CourierStep): number {
    if (step.notePool.length > 0) {
      const i = clamp(this.stepPoolPick, 0, step.notePool.length - 1);
      return step.notePool[i]!;
    }
    return step.noteVv;
  }

  /** Build the current authored note's effective pitch, applying the full arp.
   *  PURE read: indexes the baked arp traversal (arpList) by the live cursor (UP/DOWN/UPDOWN/
   *  DOWNUP/CONVERGE/DIVERGE/PENDULUM/AS_PLAYED) or by the stashed seeded-PRNG index (RANDOM/
   *  RANDOM_WALK). CHORD is handled separately in emitStepEvents (it sounds the whole list at once). */
  private effectiveNoteVv(step: CourierStep): number {
    if (this.arpMode === 'OFF') return this.baseNoteVv(step);
    const list = this.arpList();
    if (list.length === 0) return -1; // no authored notes in window -> treat as rest
    const idx = this.arpIndex(list.length);
    return list[idx]!;
  }

  /** Resolve the current arp index into a list of `len`. Forward-walk patterns read the cursor;
   *  RANDOM/RANDOM_WALK read the seeded-PRNG stash. Always returns a finite, in-range index. */
  private arpIndex(len: number): number {
    const wrap = (i: number) => ((i % len) + len) % len;
    if (this.arpMode === 'RANDOM') return wrap(this.arpRandomIdx);
    if (this.arpMode === 'RANDOM_WALK') return wrap(this.arpCursor);
    return wrap(this.arpCursor);
  }

  /** The base authored-note set for the window [0..endStep) (every non-rest authored step). `sorted`
   *  ascending for every pattern except AS_PLAYED, which keeps authored insertion order. */
  private arpBaseNotes(sorted: boolean): number[] {
    const end = clamp(this.endStep, 1, 64);
    const notes: number[] = [];
    for (let i = 0; i < end; i++) {
      const s = this.steps[i]!;
      if (!s.rest && s.noteVv >= 0) notes.push(s.noteVv);
    }
    if (sorted) notes.sort((a, b) => a - b);
    return notes;
  }

  /** Octave-expand a base note set across arpOctave octaves BEFORE ordering: the run, then the run
   *  +1 octave, … (+ (arpOctave-1) octaves). One octave == 1.0 vv. */
  private octaveExpand(base: number[]): number[] {
    const oct = clamp(Math.round(this.arpOctave), 1, COURIER_ARP_MAX_OCTAVE);
    const out: number[] = [];
    for (let o = 0; o < oct; o++) {
      for (const n of base) out.push(n + o * ARP_OCTAVE_VV);
    }
    return out;
  }

  /**
   * Build the full arp TRAVERSAL list for the current pattern (octave-expanded). The cursor walks
   * this forward and wraps; the entire pattern shape (bounce, converge, etc.) is baked in here so
   * effectiveNoteVv stays a trivial index. RANDOM/RANDOM_WALK/CHORD all index the plain ascending
   * (octave-expanded) run — their motion comes from the index, not the list order.
   */
  private arpList(): number[] {
    const asPlayed = this.arpMode === 'AS_PLAYED';
    const run = this.octaveExpand(this.arpBaseNotes(!asPlayed)); // ascending (or insertion-order) run
    const m = run.length;
    if (m === 0) return run;
    const rev = run.slice().reverse();
    switch (this.arpMode) {
      case 'DOWN':
        return rev;
      case 'UPDOWN_INC': // …last, last, … (repeat both turnaround notes): up then full reverse
      case 'PENDULUM': // classic bounce hitting both ends == UPDOWN_INC traversal
        return m > 1 ? run.concat(rev) : run.slice();
      case 'UPDOWN_EXC': // bounce WITHOUT repeating the ends: up, then inner reverse
        return m > 1 ? run.concat(rev.slice(1, m - 1)) : run.slice();
      case 'DOWNUP_INC':
        return m > 1 ? rev.concat(run) : run.slice();
      case 'DOWNUP_EXC':
        return m > 1 ? rev.concat(run.slice(1, m - 1)) : run.slice();
      case 'CONVERGE':
        return convergeOrder(run);
      case 'DIVERGE':
        return convergeOrder(run).reverse();
      case 'UP':
      case 'AS_PLAYED':
      case 'RANDOM':
      case 'RANDOM_WALK':
      case 'CHORD':
      default:
        return run; // plain ascending / insertion-order run
    }
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
    //   clamp values, or know the lockable allow-list (that lives in the binder via isCourierLockable).
    events.push({ time, type: 'paramLock', data: { lock: step.lock ?? {} } });

    // 2. REST: no gate, no pitch (CV holds).
    if (step.rest) return events;

    // 2b. NOTE PROB: the step's note lost its roll this pass -> a TRANSIENT rest. The step marker
    //   and paramLock already fired (knob locks are gate-independent); we emit no pitch/gate and
    //   return BEFORE the pitch/gate-on logic, so a skipped step starts no NEW gate (and never a
    //   tie — advanceStep gates prevTied on stepNoteFires). An INCOMING tie must still complete its
    //   gate-off here though: the previous step left the gate high, and this skipped step is where
    //   it falls (unless this step itself ties, in which case the hold carries on).
    if (!this.stepNoteFires) {
      const skipTie = step.gateLength >= 1;
      if (this.prevTied && !skipTie) {
        const gl = clamp(step.gateLength, 0.05, 1) * clamp(this.gateLenScale, 0.05, 1);
        events.push({ time: time + gl * dur, type: 'gateOff' });
      }
      return events;
    }

    // 3. Effective note(s) via arp/pool, then key-transpose (applied AFTER selection so transpose
    //    shifts seq + arp + pool output uniformly). Arp with an empty authored window -> treat as rest.
    //    CHORD sounds the WHOLE octave-expanded list at once (N simultaneous pitches); every other
    //    pattern (and OFF) emits a single note via effectiveNoteVv.
    const pitches: number[] = [];
    if (this.arpMode === 'CHORD') {
      const list = this.arpList();
      if (list.length === 0) return events; // no authored notes -> rest
      for (const n of list) pitches.push(n + this.transposeVv);
    } else {
      const selected = this.effectiveNoteVv(step);
      if (selected < 0 && this.arpMode !== 'OFF') return events; // arp yielded no note
      pitches.push(selected + this.transposeVv);
    }

    // 4. Pitch event(s) (glideTimeS omitted — the binder/module reads its own glideTimeS). Always
    //    emitted when the step sounds so the CV/glide tracks even on a GATE-suppressed (ghost) note.
    for (const noteVv of pitches) {
      events.push({ time, type: 'pitch', data: { noteVv, glide: step.glide } });
    }

    // 5. Gate logic (Monarch minus ratchet/accent). TIE keys off the RAW per-step gateLength,
    //    not the scaled value; the gate-off offset uses the scaled gate length. A CHORD fires ONE
    //    shared gate for the simultaneous notes.
    const gateLength = clamp(step.gateLength, 0.05, 1) * clamp(this.gateLenScale, 0.05, 1);
    const tie = step.gateLength >= 1;

    if (this.prevTied) {
      // gate already high from the previous (tied) step: no retrigger
      if (!tie) events.push({ time: time + gateLength * dur, type: 'gateOff' });
      return events;
    }

    // 5b. GATE PROB: the note sounds (pitch tracked above) but the gate lost its roll -> a GHOST
    //   note. Suppress gate-on AND gate-off; a TIE is unaffected by gateProb (handled by prevTied
    //   composition in advanceStep, which only carries a tie when the step both sounded and gated).
    if (!this.stepGateFires && !tie) return events;

    events.push({ time, type: 'gateOn' });
    if (!tie) events.push({ time: time + gateLength * dur, type: 'gateOff' });
    return events;
  }

  /** Step bookkeeping: tie carry, step index (frozen under HOLD), tick + baseTime, arp cursor. */
  private advanceStep(durForBaseTime: number): void {
    const step = this.steps[this.stepIndex]!;
    // prevTied carries only when the step has an AUTHORED tie AND it SOUNDED (won noteProb): a
    // skipped (note-prob-lost) or rested step never starts a tie. A tie's gate is unaffected by
    // gateProb (emitStepEvents always gate-ons a sounding tie), so "gated" is implicit for ties —
    // we don't gate prevTied on stepGateFires here. An incoming tie that lands on a skipped step
    // still completes its gate-off there (prevTied stays true -> next sounding step gate-offs).
    this.prevTied = !step.rest && step.gateLength >= 1 && this.stepNoteFires;
    if (!this.holdActive) {
      this.stepIndex = (this.stepIndex + 1) % clamp(this.endStep, 1, 64);
    }
    if (this.arpMode !== 'OFF') {
      const len = this.arpList().length;
      if (len > 0) {
        if (this.arpMode === 'RANDOM_WALK') {
          // RANDOM_WALK steps the cursor +/-1 (seeded), so it meanders adjacent list entries
          // instead of jumping uniformly like RANDOM. arpDir is unused here.
          const delta = this.arpWalkRoll < 0.5 ? -1 : 1;
          this.arpCursor = (this.arpCursor + delta + len) % len;
        } else {
          // Every other pattern's full traversal (incl. bounce/converge) is baked into arpList, so
          // the cursor just walks forward and wraps. arpDir stays +1 (kept as a pendulum hook).
          this.arpCursor = (this.arpCursor + this.arpDir + len) % len;
        }
      }
    }
    // Roll the just-landed step's decisions (read on the NEXT pull). HOLD freezes stepIndex but
    // advanceStep still runs, so a held step deliberately RE-ROLLS its probability each repeat.
    this.rollStepDecisions(this.stepIndex);
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
   * COU_CLOCK_IN rising edge ("Rising edges replace the internal clock", Courier p.20): emit the
   * current step's events at `time` — gate/tie spacing keyed to the MEASURED external interval so
   * gate lengths scale to the incoming clock rate — then advance one step. `intervalS` is the gap
   * since the previous edge; the first edge falls back to the internal step duration. Order matches
   * Monarch/Anvil/Cascade: fire the current step, then advance. Swing is NOT applied (the external
   * clock owns the timing grid). Re-rolls per-step probability via advanceStep, same as internal.
   */
  onExternalEdge(time: number, intervalS?: number): TransportEvent[] {
    const dur = intervalS !== undefined && intervalS > 0 ? intervalS : this.stepDur();
    const events = this.emitStepEvents(time, dur);
    this.advanceStep(dur);
    return events;
  }

  /** Re-anchor the internal clock to `now` (e.g. the COU_CLOCK_IN cable was unplugged while running)
   *  without disturbing the current step — so the lookahead clock resumes instead of freezing. */
  resumeInternal(now: number): void {
    this.baseTime = now;
    this.nextEventTime = now;
    this.prevTied = false;
  }
}
