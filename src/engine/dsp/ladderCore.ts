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

/**
 * Internal oversampling factor for the nonlinear ladder (Huovilainen 2× minimum). The tanh
 * stages generate harmonics above the audio band; the boxcar (averaging) decimation in the
 * process loop is the anti-alias filter that keeps them from folding back as grit/crackle when
 * driven. Kept at 2× because the empirical cutoff/resonance coefficients (fcr/acr) and the
 * 0.5-sample phase comp are tuned for it — raising it shifts the self-oscillation frequency out
 * of its ±4% gate (test-locked) and would require re-deriving those, so a higher factor is a
 * deliberate retuning task, not a knob flip.
 */
const OVERSAMPLE = 2;

/**
 * Filter response mode. `'LP'` is the 4-pole (24 dB/oct) ladder lowpass and is the
 * default; the multimode taps are derived from the same ladder stages via pole-mixing:
 *   - `'LP'`  — LP4, 24 dB/oct (stage 4 output, the classic ladder)
 *   - `'LP2'` — LP2, 12 dB/oct (2-pole tap)
 *   - `'BP'`  — 2-pole band-pass (difference of the LP2 and LP4 taps)
 *   - `'HP'`  — HP4, the (1−L)^4 pole-mix (non-resonant HP; resonance re-adds bottom)
 */
export type FilterMode = 'LP' | 'HP' | 'LP2' | 'BP';

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
  private resApplied = 0; // internal resonance (knob·resScale), used to scale RES BASS re-inject

  // params
  private cutoffTargetHz = 1000;
  private cutoffSmoothedHz = 1000;
  private resonanceKnob = 0; // 0..1 panel value
  /**
   * Per-module resonance scale: maps panel 0..1 -> internal 0..resScale, so robust
   * self-oscillation begins at knob ≈ 1/resScale. The default 1.15 puts the onset at
   * ~0.87 ("above 3 o'clock"), matching the Monarch and Anvil. A unit that self-
   * oscillates earlier (the Cascade, "above two o'clock" per the measured reference)
   * sets a larger scale via the worklet's `resScale` processorOption.
   */
  private resScale = 1.15;
  drive = 1.0;
  mode: FilterMode = 'LP';

  /**
   * RES BASS (bass-preserve) flag. A resonant ladder thins out the low end as the
   * feedback subtracts in-band energy; the source hardware's "RES BASS" switch
   * compensates by re-injecting a resonance-proportional amount of the pre-filter
   * low-frequency content. Off by default (false) so LP4/res behavior is unchanged.
   */
  resBass = false;

  private denormFlip = 1e-18;

  // RES BASS one-pole low-pass state, on the (scaled) pre-filter input. Re-injected in
  // proportion to resonance to replace the low end the resonant feedback subtracts.
  private bassLpState = 0;

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

  /** Per-module resonance scale (see the field doc). Guards against a non-positive value. */
  setResonanceScale(scale: number): void {
    this.resScale = Number.isFinite(scale) && scale > 0 ? scale : 1.15;
  }

  reset(): void {
    this.stage.fill(0);
    this.stageTanh.fill(0);
    this.delay.fill(0);
    this.bassLpState = 0;
  }

  private updateCoefficients(cutoffHz: number): void {
    const fs = this.sampleRate;
    let fc = cutoffHz / fs;
    const fcMax = 0.45; // clamp [10 Hz, 0.45·fs]
    if (fc > fcMax) fc = fcMax;
    if (fc < 10 / fs) fc = 10 / fs;
    const f = fc / OVERSAMPLE; // per-oversample-step normalized rate
    const fc2 = fc * fc;
    const fc3 = fc2 * fc;
    const fcr = 1.873 * fc3 + 0.4955 * fc2 - 0.649 * fc + 0.9988;
    this.acr = -3.9364 * fc2 + 1.8409 * fc + 0.9968;
    this.tune = (1.0 - Math.exp(-TWO_PI * f * fcr)) / THERMAL;
    // map panel 0..1 -> internal 0..resScale so robust self-oscillation begins ~1/resScale
    const res = this.resonanceKnob * this.resScale;
    this.resQuad = 4.0 * res * this.acr;
    this.resApplied = res;
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
    const mode = this.mode;

    // RES BASS: re-inject a resonance-proportional amount of the low-passed input so the
    // resonant feedback's bass-thinning is compensated. One-pole LP at ~120 Hz (per
    // audio sample). Gain rises with internal resonance; capped so it stays a "preserve",
    // not a boost. Only active when the flag is set AND the mode keeps low end (LP*/BP).
    const bassActive = this.resBass && mode !== 'HP';
    const bassCoef = bassActive ? 1 - Math.exp((-TWO_PI * 120) / this.sampleRate) : 0;
    const bassGain = bassActive ? Math.min(this.resApplied * 0.6, 1.2) : 0;

    let prevIn = this.lastInput;
    for (let i = 0; i < n; i++) {
      const raw = (input[i] ?? 0) * VV_NORM * drive * INPUT_SCALE + this.denormFlip;
      this.denormFlip = -this.denormFlip;

      // OVERSAMPLE× oversampling with linear-interpolated input and boxcar (averaging)
      // decimation on every tap — the averaging is the anti-alias filter that keeps the
      // driven-tanh harmonics from folding back (the old code PICKED the last sub-sample for
      // LP4, which aliased once the filter was driven).
      let lp4Sample = 0; // LP4: stage 4 output (24 dB/oct ladder)
      let lp2Sample = 0; // LP2: 2-pole tap (12 dB/oct)
      let bpSample = 0; //  BP:  2-pole band-pass (LP2 − LP4)
      let hpSample = 0; //  HP4: (1−L)^4 pole-mix
      const invOS = 1 / OVERSAMPLE;
      for (let os = 0; os < OVERSAMPLE; os++) {
        // linearly interpolate the input across the oversample steps (prevIn → raw)
        const x = prevIn + (raw - prevIn) * ((os + 1) * invOS);
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
        // Pole-mix taps over [u, stage0, stage1, stage2, stage3]:
        //   LP4 = stage 4 output (phase-compensated); LP2 = 2-pole tap (stage[1]);
        //   BP  = LP2 − LP4 (band centered near cutoff); HP = (1−L)^4 = u − 4s0 + 6s1 − 4s2 + s3.
        // The resonant LP core keeps running underneath every tap, so raising resonance in
        // HP/BP mode re-adds low-end — the authentic source-hardware behavior.
        lp4Sample += invOS * delay[5]!;
        lp2Sample += invOS * stage[1]!;
        bpSample += invOS * (stage[1]! - delay[5]!);
        hpSample += invOS * (u - 4 * stage[0]! + 6 * stage[1]! - 4 * stage[2]! + stage[3]!);
      }
      prevIn = raw;

      let y =
        mode === 'HP'
          ? hpSample
          : mode === 'LP2'
            ? lp2Sample
            : mode === 'BP'
              ? bpSample
              : lp4Sample;

      // RES BASS re-inject (LP of the pre-filter input, scaled by resonance).
      if (bassActive) {
        this.bassLpState += bassCoef * (raw - this.bassLpState);
        y += bassGain * this.bassLpState;
      }

      if (!Number.isFinite(y)) {
        this.reset();
        prevIn = 0; // also sanitize the cross-sample interpolation history (and lastInput below)
        y = 0;
      }
      output[i] = (y / INPUT_SCALE) * VV_DENORM;
    }
    this.lastInput = prevIn;
  }

  private lastInput = 0;
}
