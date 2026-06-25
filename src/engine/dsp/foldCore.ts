/**
 * PURE wavefolder core for the FOLD FX unit (G8). NO Web Audio types — fully Node-testable.
 *
 * A wavefolder pushes a signal past the ±1 rails and "folds" it back on itself with an
 * iterated sine reflection, generating fold harmonics that brighten as drive rises. This is
 * the FX-rack cousin of oscCore's osc-path fold (oscCore.ts `sineFold` + FOLD_MAX_DRIVE):
 * the math is the same single sine-fold, but here it is baked into a static transfer curve
 * (buildFoldCurve) for a native WaveShaperNode rather than evaluated per-sample in a worklet.
 *
 * The whole curve is rebuilt only when DRIVE or SYMMETRY change (commit-only in the panel);
 * MIX is a live wet-gain write in the shell, so it never rebuilds the curve.
 *
 * ---- fidelity tuning knobs (named so a later by-ear pass can tune them) --------------------
 * The fold CHARACTER is a sonic-flavor call for the operator's ears. The objective properties
 * (odd symmetry at symmetry=0, ±1 rail-safety, monotonic harmonic enrichment with drive, even
 * harmonics from symmetry) are locked by foldCore.test.ts; only the VOICING below is by-ear:
 *
 *   FOLD_DRIVE_MIN / FOLD_DRIVE_MAX — the DRIVE knob (1..8) maps linearly onto the sine-fold
 *     pre-gain. At pre-gain 1 the sine is a near-identity (gentle saturation, no fold). Around
 *     pre-gain ~2.4 there is one clean fold; past ~2.6 the fundamental starts cancelling (a
 *     real folder trait) so the higher reaches of the 1..8 range are deliberately "extreme".
 *     The operator may prefer a narrower musical range — structure is independent of the choice.
 *   FOLD_STAGES — number of cascaded sine reflections; 1 = a single clean monotonic fold.
 *   SYMMETRY — pre-fold DC bias (asymmetry → even harmonics) with post-fold mean removal so the
 *     output stays centered. symmetry=0 → odd-symmetric (odd harmonics only).
 */

/** DRIVE knob range. The knob value (1..8) is the literal sine-fold pre-gain. */
export const FOLD_DRIVE_MIN = 1;
export const FOLD_DRIVE_MAX = 8;
/** Sine-fold reflections; 1 = a single clean monotonic fold (matches oscCore FOLD_STAGES). */
export const FOLD_STAGES = 1;

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/**
 * Iterated sine-fold of a single sample. `y` is a roughly ±1 value pre-scaled by drive; the
 * sine reflects anything past ±1 back on itself FOLD_STAGES times. sin() inherently bounds the
 * result to ±1 (rail-safe). Shared shape with oscCore.sineFold.
 */
function sineFold(y: number): number {
  let v = y;
  for (let s = 0; s < FOLD_STAGES; s++) {
    v = Math.sin((Math.PI / 2) * v);
  }
  return v;
}

/**
 * Wavefolder transfer function. Maps one input sample x∈[-1,1] to a folded output ∈[-1,1].
 *   drive    1..8  — sine-fold pre-gain (deeper fold = brighter). Clamped to FOLD_DRIVE_*.
 *   symmetry -1..1 — DC bias added BEFORE the fold (breaks the odd symmetry → even harmonics),
 *                    with the bias's own folded value removed AFTER so the curve stays centered
 *                    (a constant input maps the asymmetry to a stable offset, not a DC runaway).
 * Output is hard-clamped to ±1 so the curve is rail-safe regardless of inputs (the WaveShaper
 * curve domain is itself [-1,1], but clamp keeps the math defensive).
 */
export function foldTransfer(x: number, drive: number, symmetry: number): number {
  const d = clamp(drive, FOLD_DRIVE_MIN, FOLD_DRIVE_MAX);
  const sym = clamp(symmetry, -1, 1);
  // Pre-fold DC bias: a fraction of a rail. At sym=0 this is 0 → pure odd symmetry.
  const bias = sym * 0.5;
  const folded = sineFold((x + bias) * d);
  // Post-fold mean removal: subtract the fold of the bias alone so a centered input stays
  // centered (removes the DC the bias would otherwise inject). At sym=0 this term is 0.
  const center = sineFold(bias * d);
  return clamp(folded - center, -1, 1);
}

/**
 * Build a static WaveShaper transfer curve for the given DRIVE + SYMMETRY. `samples` points
 * span the input domain [-1, 1] inclusive. Returned Float32Array is consumed directly by a
 * native WaveShaperNode.curve in the effects shell (buildFold).
 */
export function buildFoldCurve(drive: number, symmetry: number, samples = 2048): Float32Array {
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = foldTransfer(x, drive, symmetry);
  }
  return curve;
}
