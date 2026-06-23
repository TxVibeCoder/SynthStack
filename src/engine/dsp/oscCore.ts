/**
 * PolyBLEP oscillator core — pure DSP, no Web Audio types.
 * One core serves every VCO in the studio: Monarch (saw/pulse + PWM), Anvil (tri/square +
 * hard sync + linear FM), Cascade (square with audio-rate PWM, saw subs), Courier
 * (continuous waveshape morph + wavefolder).
 *
 * PolyBLEP residual and waveform construction referenced from
 * martinfinke/PolyBLEP (zlib license; itself a C++ port of Tale's oscillator).
 * Ported to TypeScript and extended with hard sync, linear FM, and internal 2×
 * oversampling + half-band decimation (single-rate polyBLEP
 * measured ~−25 dB worst alias at 3 kHz, short of the −40 dB acceptance), 2026-06-11.
 * Extended 2026-06-22 with a continuous "waveshape" morph (CCW wavefolder ··· triangle ···
 * saw ··· square ··· narrow pulse) and a simpler sub-oscillator morph (tri → square → PWM).
 * Altered version — do not misrepresent origin.
 *
 * Outputs ±5 vv. Internal phase is float64 in [0,1).
 */

export const SHAPE_SAW = 0;
export const SHAPE_PULSE = 1;
export const SHAPE_TRIANGLE = 2;
export const SHAPE_SQUARE = 3;
export type OscShape = typeof SHAPE_SAW | typeof SHAPE_PULSE | typeof SHAPE_TRIANGLE | typeof SHAPE_SQUARE;

const OUT_SCALE = 5; // ±1 -> ±5 vv
const OVERSAMPLE = 2;

// 11-tap half-band decimator (odd taps zero except center); DC gain 1.
const HB = new Float64Array([0.006, 0, -0.051, 0, 0.295, 0.5, 0.295, 0, -0.051, 0, 0.006]);
const HB_LEN = HB.length;

// ---- continuous waveshape morph map (main oscillator) --------------------------------
// waveshape 0..1 sweeps:  0 = max fold ·· WS_TRI = triangle ·· WS_SAW = saw ··
// WS_SQUARE = square ·· 1 = narrow pulse. The CCW region [0, WS_TRI] is the WAVEFOLDER.
export const WS_TRI = 0.27; // morph position where the wave is a clean triangle (fold depth 0)
export const WS_SAW = 0.5; // morph position of a clean saw
export const WS_SQUARE = 0.6; // morph position of a clean square (50% pulse)
export const WS_PULSE_MIN_PW = 0.1; // pulse width at waveshape = 1 (narrowest pulse)

// ---- wavefolder shape (named so a later fidelity pass can tune it) -------------------
// Diode/transistor-style fold via an iterated sine-fold of a triangle core. As waveshape
// goes WS_TRI -> 0 the drive rises from 1 to FOLD_MAX_DRIVE, pushing the triangle past the
// ±1 rails so the sine reflects it back on itself FOLD_STAGES times. The sine keeps the
// output inherently within ±1, so no extra normalization is needed.
//
// Fidelity-pass tuning knobs:
//   FOLD_MAX_DRIVE — deeper fold = more reflections = brighter. 2.0 gives one clean fold at
//     full depth (monotonic harmonic growth, fundamental preserved). Raising it past ~2.6
//     starts cancelling the fundamental (a real folder trait) but breaks simple monotonicity.
//   FOLD_STAGES    — cascade more sine reflections for a more aggressive/ringing fold.
export const FOLD_MAX_DRIVE = 2.0; // peak pre-gain into the sine-fold at waveshape = 0
export const FOLD_STAGES = 1; // sine-fold reflections; 1 = a single clean monotonic fold
export const FOLD_OVERSAMPLE = 4; // extra oversample through the fold region to tame aliasing

/** Two-sample polynomial band-limited step correction. t = phase, dt = phase increment. */
function polyBlep(t: number, dt: number): number {
  if (dt <= 0) return 0;
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}

/**
 * Iterated sine-fold wavefolder. x is a roughly ±1 signal; drive >= 1 pushes it past the
 * ±1 rails and the sine reflects it back, producing the characteristic fold harmonics.
 * sin() bounds the result to ±1, so the output is rail-safe for the studio's ±5 vv scaling.
 */
function sineFold(x: number, drive: number): number {
  let y = x * drive;
  for (let s = 0; s < FOLD_STAGES; s++) {
    y = Math.sin((Math.PI / 2) * y);
  }
  return y;
}

export interface OscSampleIn {
  /** Base frequency in Hz (from the panel knob, via units.ts). */
  baseHz: number;
  /** Exponential pitch CV in vv (1 vv = 1 octave). */
  pitchCvVv: number;
  /** Linear FM input in vv. */
  linFmVv: number;
  /** Linear FM depth, Hz per vv. */
  linFmDepthHzPerVv: number;
  /** Hard-sync input: a rising edge (>= 2.5) resets phase. */
  syncIn: number;
  /** Pulse width 0.01..0.99. */
  pulseWidth: number;
  shape: OscShape;
  /**
   * Continuous main-oscillator morph, 0..1 (optional — legacy callers use `shape`).
   * 0 = max fold ·· WS_TRI = triangle ·· WS_SAW = saw ·· WS_SQUARE = square ·· 1 = narrow pulse.
   * When omitted (undefined), the discrete `shape` path is used (backward compatible).
   */
  waveshape?: number;
  /**
   * Sub-oscillator morph, 0..1 (optional). 0 = triangle ·· 0.5 = square ·· 1 = PWM
   * (narrow pulse). No fold. When omitted, the sub path is inactive (returns 0).
   */
  subWave?: number;
}

export class OscCore {
  private phase = 0;
  private subPhase = 0;
  private tri = 0; // leaky-integrator state for the discrete SHAPE_TRIANGLE path
  private lastSyncIn = 0;
  private readonly sampleRate: number;
  private readonly ring = new Float64Array(HB_LEN);
  private ringPos = 0;

  constructor(sampleRate: number, initialPhase = 0) {
    this.sampleRate = sampleRate;
    this.phase = initialPhase;
  }

  reset(phase = 0): void {
    this.phase = phase;
    this.subPhase = 0;
    this.tri = 0;
    this.lastSyncIn = 0;
    this.ring.fill(0);
    this.ringPos = 0;
  }

  /** Band-limited 50% square at the current phase. */
  private blSquare(t: number, dt: number): number {
    let sq = t < 0.5 ? 1 : -1;
    sq += polyBlep(t, dt);
    sq -= polyBlep((t + 0.5) % 1, dt);
    return sq;
  }

  private generate(dt: number, pw: number, shape: OscShape): number {
    const t = this.phase;
    let v: number;
    switch (shape) {
      case SHAPE_SAW: {
        v = 2 * t - 1 - polyBlep(t, dt);
        break;
      }
      case SHAPE_TRIANGLE: {
        // leaky integration of the band-limited 50% square (standard technique)
        const sq = this.blSquare(t, dt);
        const leak = 1 - 0.05 * dt; // tau ~ 20 periods, frequency-proportional
        this.tri = this.tri * leak + 4 * dt * sq;
        v = this.tri;
        break;
      }
      case SHAPE_PULSE:
      case SHAPE_SQUARE: {
        v = t < pw ? 1 : -1;
        v += polyBlep(t, dt);
        v -= polyBlep((t - pw + 1) % 1, dt);
        break;
      }
    }
    return v;
  }

  /**
   * Continuous main-oscillator sub-sample for the morph path. Produces a ~±1 value at the
   * current phase blending fold ·· triangle ·· saw ·· square ·· narrow pulse.
   *
   * Uses a DC-free, unit-amplitude NAIVE triangle (the leaky integrator used by the discrete
   * SHAPE_TRIANGLE path carries DC + non-unit gain and is unsuited to morphing/folding). The
   * naive triangle has no discontinuity, so it aliases negligibly; the saw/pulse edges are
   * still polyBLEP-corrected and the whole path is oversampled (4× extra in the fold region).
   */
  private generateMorph(dt: number, ws: number): number {
    const t = this.phase;
    // naive unit triangle, DC-free: +1 at t=0, -1 at t=0.5, back to +1 at t=1
    const tri = 1 - 4 * Math.abs(t - 0.5);

    if (ws <= WS_TRI) {
      // ---- WAVEFOLDER region [0, WS_TRI]: fold the unit triangle ----
      // frac 0 at WS_TRI (no fold) -> 1 at ws=0 (max fold)
      const frac = WS_TRI > 0 ? (WS_TRI - ws) / WS_TRI : 0;
      const drive = 1 + frac * (FOLD_MAX_DRIVE - 1);
      return sineFold(tri, drive);
    }

    if (ws < WS_SAW) {
      // ---- triangle -> saw ----
      const m = (ws - WS_TRI) / (WS_SAW - WS_TRI);
      const sawV = 2 * t - 1 - polyBlep(t, dt);
      return tri * (1 - m) + sawV * m;
    }

    if (ws < WS_SQUARE) {
      // ---- saw -> square (50% pulse) ----
      const m = (ws - WS_SAW) / (WS_SQUARE - WS_SAW);
      const sawV = 2 * t - 1 - polyBlep(t, dt);
      const sq = this.blSquare(t, dt);
      return sawV * (1 - m) + sq * m;
    }

    // ---- square -> narrow pulse: shrink pulse width from 0.5 to WS_PULSE_MIN_PW ----
    const m = (ws - WS_SQUARE) / (1 - WS_SQUARE);
    const pw = 0.5 + m * (WS_PULSE_MIN_PW - 0.5);
    let pulseV = t < pw ? 1 : -1;
    pulseV += polyBlep(t, dt);
    pulseV -= polyBlep((t - pw + 1) % 1, dt);
    return pulseV;
  }

  /**
   * Sub-oscillator sub-sample for the subWave morph (tri -> square -> PWM). ~±1.
   * `subDt` is the sub-osc phase increment (it runs an octave below the main osc).
   */
  private generateSub(subDt: number, sw: number): number {
    const t = this.subPhase;
    const tri = 1 - 4 * Math.abs(t - 0.5); // DC-free unit triangle

    if (sw < 0.5) {
      // triangle -> square (50%)
      const m = sw / 0.5;
      const sq = this.subBlSquare(t, subDt);
      return tri * (1 - m) + sq * m;
    }
    // square -> PWM (narrow pulse, 0.5 -> 0.1 duty)
    const m = (sw - 0.5) / 0.5;
    const pw = 0.5 + m * (0.1 - 0.5);
    let pulseV = t < pw ? 1 : -1;
    pulseV += polyBlep(t, subDt);
    pulseV -= polyBlep((t - pw + 1) % 1, subDt);
    return pulseV;
  }

  /** Band-limited 50% square at the sub-osc phase (separate so subDt drives its polyBLEP). */
  private subBlSquare(t: number, subDt: number): number {
    let s = t < 0.5 ? 1 : -1;
    s += polyBlep(t, subDt);
    s -= polyBlep((t + 0.5) % 1, subDt);
    return s;
  }

  /** Returns the audio sample (±5 vv) and a sync pulse (+5 on the sample the phase wrapped). */
  processSample(inp: OscSampleIn): { out: number; syncOut: number } {
    // hard sync: rising edge resets phase (true phase-reset sync; a slaved VCO below
    // the master's pitch nearly vanishes — authentic, falls out naturally).
    // Edge timing is quantized to the output rate (≤1 sample jitter).
    if (inp.syncIn >= 2.5 && this.lastSyncIn < 2.5) {
      this.phase = 0;
    }
    this.lastSyncIn = inp.syncIn;

    let f = inp.baseHz * Math.pow(2, inp.pitchCvVv) + inp.linFmVv * inp.linFmDepthHzPerVv;
    if (f < 0) f = 0; // not through-zero
    const maxF = 0.45 * this.sampleRate; // keep musical content below the OUTPUT Nyquist
    if (f > maxF) f = maxF;

    const useMorph = inp.waveshape !== undefined;
    const useSub = inp.subWave !== undefined;
    const ws = useMorph ? (inp.waveshape! < 0 ? 0 : inp.waveshape! > 1 ? 1 : inp.waveshape!) : 0;
    const sw = useSub ? (inp.subWave! < 0 ? 0 : inp.subWave! > 1 ? 1 : inp.subWave!) : 0;

    // In the fold region the wave is harmonically rich — run a deeper internal oversample
    // (FOLD_OVERSAMPLE) so fold aliases fold up out of the audible band before decimation.
    const inFold = useMorph && ws < WS_TRI;
    const os = inFold ? OVERSAMPLE * FOLD_OVERSAMPLE : OVERSAMPLE;
    const osRate = this.sampleRate * os;
    const dt = f / osRate;
    // f clamped to 0 (deep negative linear FM) ⇒ the oscillator is silent; output 0 and settle
    // the triangle integrators so no DC offset is held while silenced (shape-agnostic).
    if (dt === 0) {
      this.tri = 0;
      return { out: 0, syncOut: 0 };
    }

    const pw =
      inp.shape === SHAPE_SQUARE ? 0.5 : inp.pulseWidth < 0.01 ? 0.01 : inp.pulseWidth > 0.99 ? 0.99 : inp.pulseWidth;

    // generate `os` sub-samples; average each consecutive group of `os/OVERSAMPLE` so the
    // half-band decimator ring always receives exactly OVERSAMPLE sub-samples per output
    // sample (box-average pre-decimation for the deeper fold oversample — cheap and keeps
    // the existing half-band stage unchanged).
    const group = os / OVERSAMPLE; // = 1 normally, = FOLD_OVERSAMPLE in the fold region
    let syncOut = 0;
    for (let s = 0; s < OVERSAMPLE; s++) {
      let sum = 0;
      const subDt = dt * 0.5; // sub-osc one octave below the main osc
      for (let g = 0; g < group; g++) {
        let v: number;
        if (useMorph) v = this.generateMorph(dt, ws);
        else v = this.generate(dt, pw, inp.shape);
        // Mix the sub at half level so main + sub stays within ~±1 (→ ±5 vv).
        if (useSub) v = v * 0.5 + this.generateSub(subDt, sw) * 0.5;
        sum += v;
        this.phase += dt;
        if (this.phase >= 1) {
          this.phase -= 1;
          syncOut = 5;
        }
        if (useSub) {
          this.subPhase += subDt;
          if (this.subPhase >= 1) this.subPhase -= 1;
        }
      }
      const v = sum / group;
      this.ring[this.ringPos] = v;
      this.ringPos = (this.ringPos + 1) % HB_LEN;
    }

    // half-band FIR (only even taps + center are nonzero)
    let acc = 0;
    for (let k = 0; k < HB_LEN; k++) {
      const h = HB[k]!;
      if (h !== 0) acc += h * this.ring[(this.ringPos + k) % HB_LEN]!;
    }

    return { out: acc * OUT_SCALE, syncOut };
  }
}
