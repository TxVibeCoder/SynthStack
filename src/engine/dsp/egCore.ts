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
 *
 * Exponential segments: one-pole toward target, time constant = time/4, so the
 * segment visibly completes (~98%) at the nominal time.
 */

export type SustainMode = 'off' | 'on' | 'gateHold';

export interface EgConfig {
  attackS: number;
  decayS: number;
  sustainMode: SustainMode;
  /** A rising gate edge during the Attack stage restarts/continues attack (true) or is ignored (false). */
  retrigInAttack: boolean;
  /** Gate-off during Attack: finish the attack first (true, Cascade) or release immediately (false, Monarch). */
  attackCompletes: boolean;
  peakVv: number; // 7.5 (Monarch) or 8 (Anvil/Cascade)
}

const GATE_THRESHOLD = 2.5;
const ATTACK_DONE = 0.99;
const IDLE_FLOOR = 1e-4;

type Stage = 'idle' | 'attack' | 'hold' | 'decay';

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

  /** Allocation-free time update — safe to call from worklet process(). */
  setTimes(attackS: number, decayS: number): void {
    this.cfg.attackS = attackS;
    this.cfg.decayS = decayS;
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
      if (this.stage === 'hold') {
        this.stage = 'decay';
      } else if (this.stage === 'attack') {
        if (this.cfg.attackCompletes) this.releasePending = true;
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
          const sustain =
            (this.cfg.sustainMode === 'on' || this.cfg.sustainMode === 'gateHold') &&
            this.gateHigh &&
            !this.releasePending;
          this.stage = sustain ? 'hold' : 'decay';
          this.releasePending = false;
        }
        break;
      }
      case 'hold':
        this.level = peak;
        if (!this.gateHigh) this.stage = 'decay';
        break;
      case 'decay': {
        this.level += this.coef(this.cfg.decayS * this.decayTimeScale) * (0 - this.level);
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
