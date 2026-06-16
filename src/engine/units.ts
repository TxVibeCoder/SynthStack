/**
 * "Virtual volts" (vv) conventions and param adapter formulas.
 * Signals inside the engine carry the natural printed numeric values:
 * audio ±5, gates 0→+5, EGs 0→+7.5/+8, pitch CV 1 vv per octave.
 * This file is the ONLY place vv becomes Hz / seconds / gain.
 */

export const PITCH_REF_HZ = 261.63; // C4 at 0 vv
export const VV_TO_WEBAUDIO = 0.2; // module audio out (±5 vv) -> mixer channel (±1.0)
export const GATE_THRESHOLD_VV = 2.5; // rising-edge threshold (D8)
export const GATE_HIGH_VV = 5;

// Monarch accent (fixed internal level, unspecified — tunable)
export const ACCENT_CUTOFF_BOOST_VV = 1.5;
export const ACCENT_VCA_GAIN = 1.25;

export const DRIFT_MAX_VV = 0.0025; // ±3 cents

export function clamp(x: number, min: number, max: number): number {
  return x < min ? min : x > max ? max : x;
}

/** Map a 0..1 knob position onto an exponential range. */
export function expKnob(knob01: number, min: number, max: number): number {
  return min * Math.pow(max / min, clamp(knob01, 0, 1));
}

/** Inverse of expKnob: natural-unit value -> 0..1 knob position. */
export function expKnob01(value: number, min: number, max: number): number {
  return clamp(Math.log(value / min) / Math.log(max / min), 0, 1);
}

/** Monarch VCO: f = 261.63 × 2^(knob + kbCv + drift + modCv); FREQUENCY knob spans −1..+1 vv. */
export function monarchVcoHz(knobVv: number, kbCvVv: number, driftVv: number, modCvVv: number): number {
  return clamp(PITCH_REF_HZ * Math.pow(2, knobVv + kbCvVv + driftVv + modCvVv), 8, 8000);
}

/**
 * Filter cutoff (all three modules): knob exponential 20 Hz–20 kHz (≈10 octaves),
 * 1 vv = 1 octave of cutoff. f = 20 × 2^(10·knob01 + cv).
 */
export function cutoffHz(knob01: number, cvVv: number): number {
  return clamp(20 * Math.pow(2, 10 * clamp(knob01, 0, 1) + cvVv), 10, 24000);
}

/** Monarch resonance: knob01 + RES CV/10 (±5 vv = full sweep), clamp 0..1. */
export function resonance01(knob01: number, cvVv: number): number {
  return clamp(knob01 + cvVv / 10, 0, 1);
}

/** Monarch LFO rate: f = clamp(0.1 × 2^(11.77·knob01 + cv), 0.05, 600). */
export function lfoRateHz(knob01: number, cvVv: number): number {
  return clamp(0.1 * Math.pow(2, 11.77 * clamp(knob01, 0, 1) + cvVv), 0.05, 600);
}

/**
 * Pulse width: knob in [min,max], CV sums with ±5 vv = full span.
 * Width hitting the rails silences the pulse — authentic, allow it.
 */
export function pulseWidth01(knobPw: number, cvVv: number, min = 0.02, max = 0.98): number {
  const span = max - min;
  return clamp(knobPw + (cvVv * span) / 10, min, max);
}

/** EG times: exponential knob between minS and maxS. */
export function egTimeS(knob01: number, minS: number, maxS: number): number {
  return expKnob(knob01, minS, maxS);
}

/**
 * VCA gain in EG mode: perceptual curve (eg/7.5)^1.3, plus summed VCA CV.
 * Sum may exceed 1 — soft-clip with a tanh knee approaching 1.2.
 */
export function vcaGain(egVv: number, cvVv: number, peakVv = 7.5): number {
  const base = Math.pow(clamp(egVv, 0, peakVv) / peakVv, 1.3);
  const summed = base + clamp(cvVv, 0, 8) / peakVv;
  if (summed <= 1) return summed;
  return 1 + 0.2 * Math.tanh((summed - 1) / 0.2); // knee above 1.0, asymptote 1.2
}

/** MIX crossfade position from knob + CV (±5 vv = full sweep at center knob). */
export function mixPosition01(knob01: number, cvVv: number): number {
  return clamp(knob01 + cvVv / 10, 0, 1);
}

/** Equal-power crossfade gains for the Monarch MIX / VC MIX. */
export function equalPowerXfade(x01: number): { a: number; b: number } {
  const x = clamp(x01, 0, 1);
  return { a: Math.cos((x * Math.PI) / 2), b: Math.sin((x * Math.PI) / 2) };
}

/** Anvil VCO pitch: f = 261.63 × 2^(knob + seqPitch·mask + egAmt·eg + cv + drift). */
export function anvilVcoHz(
  knobVv: number,
  seqPitchVv: number,
  seqMask: 0 | 1,
  egContributionVv: number,
  cvVv: number,
  driftVv: number,
): number {
  const vv = knobVv + seqPitchVv * seqMask + egContributionVv + cvVv + driftVv;
  return clamp(PITCH_REF_HZ * Math.pow(2, vv), 4, 16000);
}

/** Anvil tempo knob (0.7–700 Hz step rate) with 1 vv/oct CV. */
export function anvilStepRateHz(knob01: number, cvVv: number): number {
  return clamp(expKnob(knob01, 0.7, 700) * Math.pow(2, cvVv), 0.05, 4000);
}

/** Anvil velocity: scales EG peaks linearly; decays ×(1 + 0.15·vv/5). */
export function anvilVelocityPeakScale(velocityVv: number): number {
  return clamp(velocityVv, 0, 5) / 5;
}
export function anvilVelocityDecayScale(velocityVv: number): number {
  return 1 + 0.15 * (clamp(velocityVv, 0, 5) / 5);
}

/** Cascade VCO knob: exponential 262–4186 Hz (4 octaves, CCW = middle C). */
export function cascadeVcoKnobHz(knob01: number): number {
  return PITCH_REF_HZ * Math.pow(2, 4 * clamp(knob01, 0, 1));
}

/** Cascade sub divider: N = clamp(round(knob + seq + cv·scale), 1, 16). */
export function cascadeSubDivider(knobN: number, seqOffset: number, cvVv: number): number {
  return clamp(Math.round(knobN + seqOffset + cvVv * 1.5), 1, 16);
}

/** Cascade master tempo knob 0.333–50 Hz. */
export function cascadeTempoHz(knob01: number): number {
  return expKnob(knob01, 0.333, 50);
}

/** Cascade rhythm-generator division: d = clamp(round(knob + cv·1.5), 1, 16). */
export function cascadeRhythmDivision(knobN: number, cvVv: number): number {
  return clamp(Math.round(knobN + cvVv * 1.5), 1, 16);
}

/** SEQ OCT button position -> step-knob range in vv (±1/±2/±5 octaves). */
export function cascadeSeqOctRange(pos: 'OCT1' | 'OCT2' | 'OCT5'): number {
  return pos === 'OCT1' ? 1 : pos === 'OCT2' ? 2 : 5;
}

/** Sequencer step (±1 knob) -> sub-divider integer offset. */
export function cascadeSeqToSubOffset(stepVv: number): number {
  return Math.round(stepVv * 1.6);
}

/** Monarch sequencer swing offset for odd 16th ticks: (swing−50)/50 × 0.5 × stepDur. */
export function swingOffsetS(swingPct: number, stepDurS: number): number {
  return ((clamp(swingPct, 0, 100) - 50) / 50) * 0.5 * stepDurS;
}

/** Monarch tempo (BPM) -> 16th-note step duration in seconds. */
export function monarchStepDurS(bpm: number): number {
  return 60 / clamp(bpm, 20, 300) / 4;
}
