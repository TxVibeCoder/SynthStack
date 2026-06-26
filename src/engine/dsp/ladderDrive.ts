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
 * EARS: these are tunable starting points, not measured constants. Per-voice character partly
 * comes from how hard each source circuit drives its ladder: Anvil is the most overdriven,
 * Cascade already sums many hot sources so it stays cleaner. Tune `drive` per voice against
 * the reference demos for "fat, not fuzzy"; watch for aliasing at the hottest settings (only
 * 2× oversampling) and back off if a sustained low note grits up instead of thickening. Keep
 * makeup ≈ 1/drive unless you deliberately want a level change.
 */
export interface LadderDriveProfile {
  /** Pre-tanh input gain into the ladder. 1.0 = the old near-linear behavior. */
  drive: number;
  /** Post-ladder makeup gain, ≈ 1/drive, so drive changes timbre without changing level. */
  makeup: number;
}

export type VoiceId = 'monarch' | 'anvil' | 'cascade' | 'courier';

export const LADDER_DRIVE: Record<VoiceId, LadderDriveProfile> = {
  // Monarch: musically hot.
  monarch: { drive: 3.0, makeup: 1 / 3.0 },
  // Anvil: the most overdriven source unit — hottest.
  anvil: { drive: 4.0, makeup: 1 / 4.0 },
  // Cascade: already hot from the summed 2 VCOs + 4 subs, so a cleaner drive.
  cascade: { drive: 1.8, makeup: 1 / 1.8 },
  // Courier: musically hot.
  courier: { drive: 2.5, makeup: 1 / 2.5 },
};
