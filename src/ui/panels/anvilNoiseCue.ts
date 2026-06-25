/**
 * "Normal is live" cue for the Anvil's two pattern-2 normalled inputs.
 *
 * Both ANV_VCF_MOD_IN and ANV_EXT_AUDIO_IN are normalled to the internal NOISE
 * source, and EACH shares its attenuator knob with the patched cable:
 *   - ANV_VCF_MOD_IN   ← ANV_NOISE_VCF_MOD   knob
 *   - ANV_EXT_AUDIO_IN ← ANV_NOISE_EXT_LEVEL knob
 *
 * So when the knob is turned up and NO cable is patched into the jack, the
 * internal noise is still routed through at the knob's level — authentic
 * semi-modular behaviour, but easy to mistake for a stuck patch when you unplug
 * a cable and the sound "doesn't come back". This cue marks those jacks as
 * "noise is live here" precisely when both conditions hold, and hides once a
 * cable carries the signal or the knob is back at 0.
 *
 * Pure (no React / DOM) so the show-condition is unit-testable in Node — the
 * JackFieldPanel feeds it the live knob value + cable presence.
 */

/** jackId → the shared attenuator knob (controlId) that also gates its noise normal. */
export const ANVIL_NOISE_NORMAL_JACKS: Readonly<Record<string, string>> = {
  ANV_VCF_MOD_IN: 'ANV_NOISE_VCF_MOD',
  ANV_EXT_AUDIO_IN: 'ANV_NOISE_EXT_LEVEL',
} as const;

/**
 * Show the "noise is live" cue for a pattern-2 jack when BOTH:
 *   (1) the shared attenuator knob is above 0, AND
 *   (2) no cable is patched INTO that jack (so the noise normal is what's routed).
 * Hidden when a cable is patched (it carries the signal) or the knob is 0.
 */
export function isNoiseNormalLive(knobValue: number, hasCableIn: boolean): boolean {
  return knobValue > 0 && !hasCableIn;
}
