/**
 * Envelope generator core — pure DSP, one class for all three
 * modules, configured per instance:
 *
 * - Monarch: sustainMode 'on' (gate-hold; legato does not retrigger because the gate
 *   line stays high) or 'off' (A then immediately D; every rising edge retriggers).
 * - Anvil: decay-only — attackS 1 ms (or 100 ms for VCA SLOW), sustainMode 'off';
 *   velocity input scales peak and stretches decay (×(1+0.15·v/5)).
 * - Cascade: sustainMode 'gateHold', retrigInAttack false (documented quirk),
 *   attackCompletes true (a trigger pulse completes the Attack stage — manual p.34).
 * - Courier: sustainMode 'adsr' — a full four-stage envelope (attack, decay-to-SUSTAIN
 *   LEVEL, hold-at-sustain while gated, independent RELEASE after gate-off), with an
 *   optional ENV LOOP that re-attacks at the end of decay so the gated envelope free-runs
 *   as an LFO. The other three modes are untouched by the 'adsr' branch, so their behavior
 *   (and tests) are byte-for-byte unchanged.
 *
 * Exponential segments: one-pole toward target, time constant = time/4, so the
 * segment visibly completes (~98%) at the nominal time.
 */

import { GATE_THRESHOLD_VV } from '../units';

export type SustainMode = 'off' | 'on' | 'gateHold' | 'adsr';

export interface EgConfig {
  attackS: number;
  decayS: number;
  sustainMode: SustainMode;
  /** A rising gate edge during the Attack stage restarts/continues attack (true) or is ignored (false). */
  retrigInAttack: boolean;
  /** Gate-off during Attack: finish the attack first (true, Cascade) or release immediately (false, Monarch). */
  attackCompletes: boolean;
  peakVv: number; // 7.5 (Monarch) or 8 (Anvil/Cascade)
  /** ADSR only: held-decay target as a fraction of peak (0..1). Default 1 = no sustain drop (A-D feel). */
  sustainLevel?: number;
  /** ADSR only: release time (s) for the post-gate-off fall to 0. Default 0 ≈ instant. */
  releaseS?: number;
  /** ADSR only: loop the attack-decay segment while gated (envelope-as-LFO). Default false. */
  loop?: boolean;
}

// Single source of truth: the +2.5 vv rising-edge gate threshold lives in units.ts (D8). Kept over
// the manuals' "~+3.2 V" hardware figure — 2.5 is the clean half-amplitude of a 0/+5 gate, and both
// fire identically on a full-scale gate. (Was a duplicated local const here — deduped to units.ts.)
const GATE_THRESHOLD = GATE_THRESHOLD_VV;
const ATTACK_DONE = 0.99;
const IDLE_FLOOR = 1e-4;

type Stage = 'idle' | 'attack' | 'hold' | 'decay' | 'release';

export class EgCore {
  private readonly sampleRate: number;
  private cfg: EgConfig;
  private stage: Stage = 'idle';
  private level = 0;
  private gateHigh = false;
  /** Gate fell during attack while attackCompletes — remember to skip the hold stage. */
  private releasePending = false;
  private velocityScale = 1; // Anvil: peak scale 0..1
  private decayTimeScale = 1; // Anvil: velocity-stretched decay
  /** HELD mode (Cascade EG button): force max until released. */
  forceHeld = false;

  constructor(sampleRate: number, cfg: EgConfig) {
    this.sampleRate = sampleRate;
    this.cfg = { ...cfg };
  }

  configure(partial: Partial<EgConfig>): void {
    this.cfg = { ...this.cfg, ...partial };
  }

  /** Allocation-free time update — safe to call from worklet process(). releaseS is k-rate too
   *  (ADSR only); left untouched when omitted so the A-D voices need not pass it. */
  setTimes(attackS: number, decayS: number, releaseS?: number): void {
    this.cfg.attackS = attackS;
    this.cfg.decayS = decayS;
    if (releaseS !== undefined) this.cfg.releaseS = releaseS;
  }

  setVelocity(velocityVv: number): void {
    const v = velocityVv < 0 ? 0 : velocityVv > 5 ? 5 : velocityVv;
    this.velocityScale = v / 5;
    this.decayTimeScale = 1 + 0.15 * (v / 5);
  }

  get currentStage(): Stage {
    return this.stage;
  }

  reset(): void {
    this.stage = 'idle';
    this.level = 0;
    this.gateHigh = false;
    this.releasePending = false;
  }

  private coef(timeS: number): number {
    const tau = Math.max(timeS, 0.0005) / 4;
    return 1 - Math.exp(-1 / (this.sampleRate * tau));
  }

  /** Advance one sample. gateVv is the gate/trigger input in vv. Returns EG level in vv. */
  processSample(gateVv: number): number {
    const rising = gateVv >= GATE_THRESHOLD && !this.gateHigh;
    const falling = gateVv < GATE_THRESHOLD && this.gateHigh;
    this.gateHigh = gateVv >= GATE_THRESHOLD;

    if (rising) {
      if (this.stage === 'attack') {
        // mid-attack retrigger ignored when retrigInAttack is false (Cascade quirk)
        if (this.cfg.retrigInAttack) this.releasePending = false;
      } else {
        this.stage = 'attack';
        this.releasePending = false;
      }
    }

    if (falling && this.stage !== 'idle') {
      const adsr = this.cfg.sustainMode === 'adsr';
      if (this.stage === 'hold') {
        this.stage = adsr ? 'release' : 'decay'; // ADSR has an independent release; others fall via decay
      } else if (this.stage === 'decay') {
        if (adsr) this.stage = 'release'; // gate fell mid-decay-to-sustain -> release toward 0
      } else if (this.stage === 'attack') {
        if (this.cfg.attackCompletes) this.releasePending = true;
        else if (adsr) this.stage = 'release';
        else if (this.cfg.sustainMode !== 'off') this.stage = 'decay';
        // sustainMode 'off': attack continues into decay on its own
      }
    }

    if (this.forceHeld) {
      // EG button HELD: run attack toward max, then pin there until exited
      const peak = this.cfg.peakVv;
      this.level += this.coef(this.cfg.attackS) * (peak * 1.02 - this.level);
      if (this.level > peak) this.level = peak;
      this.stage = 'hold';
      return this.level;
    }

    const peak = this.cfg.peakVv * this.velocityScale;

    switch (this.stage) {
      case 'idle':
        this.level = 0;
        break;
      case 'attack': {
        // aim 2% above peak so the one-pole actually reaches it
        this.level += this.coef(this.cfg.attackS) * (peak * 1.02 - this.level);
        if (this.level >= peak * ATTACK_DONE) {
          this.level = Math.min(this.level, peak);
          if (this.cfg.sustainMode === 'adsr') {
            // ADSR: attack always flows into the decay-to-sustain; a release that came due
            // mid-attack (attackCompletes) takes over once the peak is reached.
            this.stage = this.releasePending ? 'release' : 'decay';
          } else {
            const sustain =
              (this.cfg.sustainMode === 'on' || this.cfg.sustainMode === 'gateHold') &&
              this.gateHigh &&
              !this.releasePending;
            this.stage = sustain ? 'hold' : 'decay';
          }
          this.releasePending = false;
        }
        break;
      }
      case 'hold':
        if (this.cfg.sustainMode === 'adsr') {
          this.level = peak * (this.cfg.sustainLevel ?? 1);
          if (!this.gateHigh) this.stage = 'release';
        } else {
          this.level = peak;
          if (!this.gateHigh) this.stage = 'decay';
        }
        break;
      case 'decay': {
        if (this.cfg.sustainMode === 'adsr') {
          const looping = (this.cfg.loop ?? false) && this.gateHigh;
          // LOOP ignores SUSTAIN and falls to 0 so the gated envelope re-attacks as an LFO;
          // otherwise decay settles onto the sustain level and holds there.
          const target = looping ? 0 : peak * (this.cfg.sustainLevel ?? 1);
          this.level += this.coef(this.cfg.decayS * this.decayTimeScale) * (target - this.level);
          if (looping) {
            if (this.level < IDLE_FLOOR) {
              this.level = 0;
              this.stage = 'attack';
            }
          } else if (this.level <= target + IDLE_FLOOR) {
            this.level = target;
            this.stage = this.gateHigh ? 'hold' : 'release';
          }
        } else {
          this.level += this.coef(this.cfg.decayS * this.decayTimeScale) * (0 - this.level);
          if (this.level < IDLE_FLOOR) {
            this.level = 0;
            this.stage = 'idle';
          }
        }
        break;
      }
      case 'release': {
        // ADSR post-gate-off fall to 0 over RELEASE (releaseS ≈ 0 -> ~instant).
        this.level += this.coef(this.cfg.releaseS ?? 0) * (0 - this.level);
        if (this.level < IDLE_FLOOR) {
          this.level = 0;
          this.stage = 'idle';
        }
        break;
      }
    }

    return this.level;
  }
}
