/**
 * Monarch panel layout — 16:9 redesign: CONTROLS-ONLY.
 * All 32 Monarch jacks moved to the consolidated jack field (jackFieldLayout.ts)
 * and the 32-step editor moved to its own strip below this panel
 * (src/ui/sequencer/MonarchStepEditor.tsx). The viewBox equals the
 * stage region (588.63 × 407.2) and renders 1:1 in stage px.
 *
 * Re-authored from the stage-2 rework for the narrower/shorter region: the
 * same four single-row bands (OSC, FILTER, ENV/VCA/VC-MIX, SEQUENCER) at
 * 94-unit pitch — knob labels render below (+~33) and switch labels above
 * (−~31), so adjacent bands still never share label space (94 ≥ 33 + 31 + a
 * 13-px section gap). x positions compress ~3% versus the old 880-wide panel.
 *
 * Spacing invariants enforced by test/unit/monarchLayout.test.ts.
 */

// .ts extension: scripts/export-geometry.ts loads this layout straight in Node
// (native type stripping), whose ESM resolver wants explicit extensions.
import type { PanelLayout } from '../types.ts';
import { REGIONS } from '../stage16x9.ts';

/** Control band row centers (94-unit pitch). */
const ROW = [74, 168, 262, 356] as const;
/** Section frame tops (90 high — bands end 13 units above the next frame). */
const SEC_Y = [28, 122, 216, 310] as const;

export const monarchLayout: PanelLayout = {
  width: REGIONS.monarchControls.w,
  height: REGIONS.monarchControls.h,
  title: 'Monarch',

  sections: [
    { label: 'OSCILLATOR', x: 8, y: SEC_Y[0], w: 446, h: 90 },
    { label: 'LFO', x: 462, y: SEC_Y[0], w: 118, h: 90 },
    { label: 'FILTER', x: 8, y: SEC_Y[1], w: 446, h: 90 },
    { label: 'MIX', x: 462, y: SEC_Y[1], w: 118, h: 90 },
    { label: 'ENVELOPE', x: 8, y: SEC_Y[2], w: 242, h: 90 },
    { label: 'VCA', x: 258, y: SEC_Y[2], w: 178, h: 90 },
    { label: 'VC MIX', x: 444, y: SEC_Y[2], w: 136, h: 90 },
    { label: 'SEQUENCER', x: 8, y: SEC_Y[3], w: 572, h: 90 },
  ],

  controls: {
    // OSCILLATOR band — one row: hero FREQUENCY, wave, PW, then the MOD trio
    MON_FREQUENCY: { x: 58, y: ROW[0], size: 'l' },
    MON_VCO_WAVE: { x: 130, y: ROW[0] },
    MON_PULSE_WIDTH: { x: 194, y: ROW[0] },
    MON_VCO_MOD_SOURCE: { x: 262, y: ROW[0] },
    MON_VCO_MOD_AMOUNT: { x: 326, y: ROW[0] },
    MON_VCO_MOD_DEST: { x: 392, y: ROW[0] },

    // LFO
    MON_LFO_RATE: { x: 498, y: ROW[0] },
    MON_LFO_WAVE: { x: 548, y: ROW[0] },

    // FILTER band — one row: hero CUTOFF, res, mode, then the MOD trio
    MON_VCF_CUTOFF: { x: 58, y: ROW[1], size: 'l' },
    MON_VCF_RESONANCE: { x: 130, y: ROW[1] },
    MON_VCF_MODE: { x: 194, y: ROW[1] },
    MON_VCF_MOD_SOURCE: { x: 262, y: ROW[1] },
    MON_VCF_MOD_AMOUNT: { x: 326, y: ROW[1] },
    MON_VCF_MOD_POLARITY: { x: 392, y: ROW[1] },

    // MIX (VCO ↔ noise/ext crossfade)
    MON_MIX: { x: 520, y: ROW[1] },

    // ENVELOPE
    MON_ATTACK: { x: 58, y: ROW[2] },
    MON_DECAY: { x: 126, y: ROW[2] },
    MON_SUSTAIN: { x: 194, y: ROW[2] },

    // VCA
    MON_VCA_MODE: { x: 304, y: ROW[2] },
    MON_VOLUME: { x: 380, y: ROW[2] },

    // VC MIX
    MON_VC_MIX: { x: 512, y: ROW[2] },

    // SEQUENCER band — knobs left, transport buttons right (the 32-step
    // editor itself lives in the strip panel below this region)
    MON_GLIDE: { x: 58, y: ROW[3] },
    MON_TEMPO: { x: 126, y: ROW[3] },
    MON_SWING: { x: 194, y: ROW[3] },
    MON_RUN_STOP: { x: 292, y: ROW[3] },
    MON_RESET: { x: 360, y: ROW[3] },
    MON_HOLD: { x: 428, y: ROW[3] },
  },

  /** Empty since the 16:9 redesign — all jacks live in jackFieldLayout.ts. */
  jacks: {},
};
