/**
 * Per-voice ladder INPUT DRIVE — the "analog weight" lever.
 *
 * The Huovilainen ladder (ladderCore.ts) is a faithful nonlinear model: tanh between
 * all four stages AND on the feedback path, 2× oversampled. But its `drive` field was
 * never set by any voice, so it sat pinned at 1.0 — and at unity a full ±5 vv oscillator
 * only reaches a tanh argument of ~0.25 (≈0.5% THD). That is the LINEAR region of the
 * tanh: the stages never curve, so the filter behaves like a clean textbook 4-pole and
 * generates almost none of the odd-harmonic density above the fundamental that the ear
 * reads as analog "weight"/thickness. (Diagnosed 2026-06-26; the source hardware runs the
 * VCO/mixer HOT into the ladder so the differential pairs sit well up the curve.)
 *
 * `drive` here scales the signal into the existing tanh stages so they actually curve at
 * normal patch levels. This ADDS A HARMONIC SERIES, it is NOT an EQ/low-shelf.
 *
 * `makeup` is a post-ladder attenuation ≈ 1/drive. In the linear passband the ladder's
 * output level is proportional to `drive`, so without makeup, raising drive would just make
 * the voice louder (the loudness/EQ trap). makeup cancels that level change so the audible
 * delta is purely TIMBRAL — same loudness, more harmonic density. (tanh saturation compresses
 * the fundamental a little, so makeup = 1/drive lands a touch quieter than unity, which is the
 * safe direction for honest A/B comparison.)
 *
 * ALIASING CEILING (why these are moderate): the ladder runs at only 2× oversampling, so a
 * hard drive generates tanh harmonics past Nyquist that fold back as audible grit/crackle —
 * worst on harmonic-rich square waves and slow-beating low notes. The real hardware saturates
 * in ANALOG (alias-free), so we CANNOT match its drive depth digitally without more oversampling.
 * Hence Anvil (square VCOs) is kept the most conservative even though its source hardware is the
 * most overdriven — counterintuitive but correct for this model. (Initial 2026-06-26 values of 3–4
 * crackled; halved after reproducing the aliasing. A future >2× oversampled ladder could go hotter.)
 *
 * EARS: tunable starting points, not measured constants. Tune `drive` per voice against the
 * reference demos for "fat, not fuzzy"; if a sustained low note or a held chord grits/crackles,
 * the drive is too hot for the oversampling — back off. Keep makeup ≈ 1/drive unless you
 * deliberately want a level change.
 */
export interface LadderDriveProfile {
  /** Pre-tanh input gain into the ladder. 1.0 = the old near-linear behavior. */
  drive: number;
  /** Post-ladder makeup gain, ≈ 1/drive, so drive changes timbre without changing level. */
  makeup: number;
}

export type VoiceId = 'monarch' | 'anvil' | 'cascade' | 'courier';

export const LADDER_DRIVE: Record<VoiceId, LadderDriveProfile> = {
  // Monarch: saw/pulse — moderate warmth.
  monarch: { drive: 2.2, makeup: 1 / 2.2 },
  // Anvil: square VCOs alias the worst when driven, so the LIGHTEST drive (see note above).
  anvil: { drive: 1.8, makeup: 1 / 1.8 },
  // Cascade: already hot from the summed 2 VCOs + 4 subs, so the cleanest drive.
  cascade: { drive: 1.5, makeup: 1 / 1.5 },
  // Courier: morph waveshape — moderate warmth.
  courier: { drive: 1.9, makeup: 1 / 1.9 },
};
