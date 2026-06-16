/**
 * Huovilainen nonlinear SynthStack ladder filter core — pure DSP.
 *
 * Ported from ddiakopoulos/SynthStackLadders `HuovilainenModel.h` (Unlicense / public
 * domain), the 2006 nonlinear model: tanh in the feedback path and between stages,
 * 2× oversampling, thermal scaling. Ported to TypeScript 2026-06-11; additions:
 * input drive, LP/HP mode (HP = input − LP4, which reproduces the documented Monarch
 * "non-resonant HP, resonance reintroduces bottom end" behavior for free),
 * cutoff smoothing, vv scaling, denormal flush, NaN guard.
 *
 * Signals in/out are ±5 vv (normalized to ±1 internally).
 */

const THERMAL = 0.000025;
const TWO_PI = Math.PI * 2;
const VV_NORM = 1 / 5;
const VV_DENORM = 5;
/**
 * The reference model's tanh stages saturate near |x·THERMAL| ≈ 0.7, i.e. x ≈ 28000.
 * Audio normalized to ±1 would never reach the nonlinearity (and self-oscillation
 * would grow enormous before being bounded). Scaling the signal up into the core and
 * back down on the way out places the saturation knee at musically sensible levels:
 * unity signal sits at tanh arg 0.25 (gentle warmth), drive > 1 pushes into clipping,
 * and self-oscillation settles around ±7 vv. Frequency response is unaffected
 * (linear scaling).
 */
const INPUT_SCALE = 1e4;

export type FilterMode = 'LP' | 'HP';

export class LadderCore {
  private readonly sampleRate: number;

  // ladder state (float64)
  private readonly stage = new Float64Array(4);
  private readonly stageTanh = new Float64Array(3);
  private readonly delay = new Float64Array(6);

  // coefficients
  private tune = 0;
  private acr = 0;
  private resQuad = 0;

  // params
  private cutoffTargetHz = 1000;
  private cutoffSmoothedHz = 1000;
  private resonanceKnob = 0; // 0..1 panel value
  drive = 1.0;
  mode: FilterMode = 'LP';

  private denormFlip = 1e-18;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.updateCoefficients(this.cutoffSmoothedHz);
  }

  setCutoffHz(hz: number): void {
    this.cutoffTargetHz = hz;
  }

  /** Panel resonance 0..1; self-oscillation in the top ~20% of the knob. */
  setResonance01(knob01: number): void {
    this.resonanceKnob = knob01 < 0 ? 0 : knob01 > 1 ? 1 : knob01;
  }

  reset(): void {
    this.stage.fill(0);
    this.stageTanh.fill(0);
    this.delay.fill(0);
  }

  private updateCoefficients(cutoffHz: number): void {
    const fs = this.sampleRate;
    let fc = cutoffHz / fs;
    const fcMax = 0.45; // clamp [10 Hz, 0.45·fs]
    if (fc > fcMax) fc = fcMax;
    if (fc < 10 / fs) fc = 10 / fs;
    const f = fc * 0.5; // oversampled rate
    const fc2 = fc * fc;
    const fc3 = fc2 * fc;
    const fcr = 1.873 * fc3 + 0.4955 * fc2 - 0.649 * fc + 0.9988;
    this.acr = -3.9364 * fc2 + 1.8409 * fc + 0.9968;
    this.tune = (1.0 - Math.exp(-TWO_PI * f * fcr)) / THERMAL;
    // map panel 0..1 -> internal 0..1.15 so robust self-oscillation begins ~0.87
    const res = this.resonanceKnob * 1.15;
    this.resQuad = 4.0 * res * this.acr;
  }

  /**
   * Process one block. `input`/`output` are vv buffers; `cutoffCvVv`, if present,
   * is 1 vv/octave applied per block using its first sample.
   */
  processBlock(input: Float32Array, output: Float32Array, n: number, cutoffCvVv?: Float32Array): void {
    // smooth the knob cutoff (~5 ms one-pole, coefficient scaled to the block
    // length so the time constant is honored regardless of block size)
    const smoothCoef = 1 - Math.exp(-n / (0.005 * this.sampleRate));
    this.cutoffSmoothedHz += smoothCoef * (this.cutoffTargetHz - this.cutoffSmoothedHz);
    const cv = cutoffCvVv !== undefined && cutoffCvVv.length > 0 ? cutoffCvVv[0]! : 0;
    const effHz = this.cutoffSmoothedHz * Math.pow(2, cv);
    this.updateCoefficients(effHz);

    const stage = this.stage;
    const stageTanh = this.stageTanh;
    const delay = this.delay;
    const tune = this.tune;
    const resQuad = this.resQuad;
    const drive = this.drive;
    const hp = this.mode === 'HP';

    let prevIn = this.lastInput;
    for (let i = 0; i < n; i++) {
      const raw = (input[i] ?? 0) * VV_NORM * drive * INPUT_SCALE + this.denormFlip;
      this.denormFlip = -this.denormFlip;

      // 2× oversampling: half-step (linear-interpolated input), then full step
      let outSample = 0;
      let hpSample = 0;
      for (let os = 0; os < 2; os++) {
        const x = os === 0 ? 0.5 * (prevIn + raw) : raw;
        const u = x - resQuad * delay[5]!; // ladder chain input (incl. feedback)
        let inp = u;
        stage[0] = delay[0]! + tune * (Math.tanh(inp * THERMAL) - stageTanh[0]!);
        delay[0] = stage[0]!;
        for (let k = 1; k < 4; k++) {
          inp = stage[k - 1]!;
          stageTanh[k - 1] = Math.tanh(inp * THERMAL);
          stage[k] =
            delay[k]! +
            tune * (stageTanh[k - 1]! - (k !== 3 ? stageTanh[k]! : Math.tanh(delay[k]! * THERMAL)));
          delay[k] = stage[k]!;
        }
        // 0.5-sample delay for phase compensation (per reference implementation)
        delay[5] = (stage[3]! + delay[4]!) * 0.5;
        delay[4] = stage[3]!;
        outSample = delay[5]!;
        // ladder-topology HP: (1−L)^4 expanded over the per-stage outputs.
        // The resonant LP core keeps running underneath, so raising resonance in
        // HP mode re-adds low-end — the authentic Monarch behavior.
        hpSample += 0.5 * (u - 4 * stage[0]! + 6 * stage[1]! - 4 * stage[2]! + stage[3]!);
      }
      prevIn = raw;

      let y = hp ? hpSample : outSample;
      if (!Number.isFinite(y)) {
        this.reset();
        y = 0;
      }
      output[i] = (y / INPUT_SCALE) * VV_DENORM;
    }
    this.lastInput = prevIn;
  }

  private lastInput = 0;
}
