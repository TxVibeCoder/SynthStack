/**
 * PolyBLEP oscillator core — pure DSP, no Web Audio types.
 * One core serves every VCO in the studio: Monarch (saw/pulse + PWM), Anvil (tri/square +
 * hard sync + linear FM), Cascade (square with audio-rate PWM, saw subs).
 *
 * PolyBLEP residual and waveform construction referenced from
 * martinfinke/PolyBLEP (zlib license; itself a C++ port of Tale's oscillator).
 * Ported to TypeScript and extended with hard sync, linear FM, and internal 2×
 * oversampling + half-band decimation (single-rate polyBLEP
 * measured ~−25 dB worst alias at 3 kHz, short of the −40 dB acceptance), 2026-06-11.
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
}

export class OscCore {
  private phase = 0;
  private tri = 0; // leaky-integrator state for triangle
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
    this.tri = 0;
    this.lastSyncIn = 0;
    this.ring.fill(0);
    this.ringPos = 0;
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
        let sq = t < 0.5 ? 1 : -1;
        sq += polyBlep(t, dt);
        sq -= polyBlep((t + 0.5) % 1, dt);
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
    const osRate = this.sampleRate * OVERSAMPLE;
    const maxF = 0.45 * this.sampleRate; // keep musical content below the OUTPUT Nyquist
    if (f > maxF) f = maxF;
    const dt = f / osRate;
    // f clamped to 0 (deep negative linear FM) ⇒ the oscillator is silent; output 0 and settle
    // the triangle integrator so no DC offset is held while silenced (shape-agnostic).
    if (dt === 0) {
      this.tri = 0;
      return { out: 0, syncOut: 0 };
    }

    const pw =
      inp.shape === SHAPE_SQUARE ? 0.5 : inp.pulseWidth < 0.01 ? 0.01 : inp.pulseWidth > 0.99 ? 0.99 : inp.pulseWidth;

    // generate OVERSAMPLE sub-samples into the decimator ring
    let syncOut = 0;
    for (let os = 0; os < OVERSAMPLE; os++) {
      const v = this.generate(dt, pw, inp.shape);
      this.ring[this.ringPos] = v;
      this.ringPos = (this.ringPos + 1) % HB_LEN;
      this.phase += dt;
      if (this.phase >= 1) {
        this.phase -= 1;
        syncOut = 5;
      }
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
