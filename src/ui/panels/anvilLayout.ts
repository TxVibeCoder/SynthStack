/**
 * Anvil panel layout — WIDE hardware re-flow (matches the drum-voice front panel).
 * CONTROLS-ONLY: all 24 Anvil jacks live in the consolidated jack field
 * (jackFieldLayout.ts), on the Patchbay tab. This panel is a landscape canvas
 * (1180 × 590) decoupled from the stage16x9 regions — App.tsx frames the Anvil tab
 * to these dims directly (no geometry move in stage16x9.ts).
 *
 * Arrangement follows the real unit's signal flow, left→right:
 *   - Top control field, two knob rows:
 *       row A: VCO DECAY · SEQ-PITCH-MOD · VCO1 EG · VCO1 FREQ · VCO1 WAVE │ VCF mode ·
 *              CUTOFF · RESONANCE · VCA-EG · VOLUME
 *       row B: 1→2 FM AMT · HARD SYNC · VCO2 EG · VCO2 FREQ · VCO2 WAVE │ VCF DECAY ·
 *              VCF EG AMT · NOISE/VCF MOD · VCA DECAY
 *     with the level trio (VCO1 / NOISE-EXT / VCO2 LEVEL) stacked vertically between the
 *     oscillator and filter blocks, exactly like the hardware.
 *   - Full-width 8-step SEQUENCER along the bottom: TRIGGER · TEMPO (+ RUN/STOP, ADVANCE)
 *     then 8 columns of PITCH (top) / step-LED / VELOCITY (bottom).
 *
 * Spacing invariants enforced by test/unit/anvilLayout.test.ts.
 */

// .ts extension: scripts/export-geometry.ts loads this layout straight in Node
// (native type stripping), whose ESM resolver wants explicit extensions.
import type { PanelLayout } from '../types.ts';

/** Landscape canvas — the panel's own viewBox (App.tsx frames the tab to this). */
export const ANVIL_W = 1180;
export const ANVIL_H = 520;

/** Top control-field row centers. */
const ROW_A = 96;
const ROW_B = 224;
/** Level-knob vertical trio (VCO1 / NOISE-EXT / VCO2), spread to clear 2-line labels. */
const LVL_X = 600;
const LVL_Y = [84, 160, 236] as const;

/** Sequencer band rows. */
const SEQ_PITCH_Y = 350;
const SEQ_VEL_Y = 444;
/** y for the panel's step-LED chase row (between PITCH labels and VELOCITY caps). */
export const SEQ_LED_Y = 397;
/** Step column centers (8 columns, 92-unit pitch). */
const STEP_X = [458, 550, 642, 734, 826, 918, 1010, 1102] as const;

export const anvilLayout: PanelLayout = {
  width: ANVIL_W,
  height: ANVIL_H,
  title: 'Anvil',

  sections: [
    { label: 'SEQUENCER', x: 8, y: 296, w: 1164, h: 208 },
  ],

  controls: {
    // ---- OSCILLATORS / VCO EG (left, two rows) ----
    ANV_VCO_DECAY: { x: 100, y: ROW_A },
    ANV_FM_AMOUNT: { x: 100, y: ROW_B },
    ANV_SEQ_PITCH_MOD: { x: 188, y: ROW_A },
    ANV_HARD_SYNC: { x: 188, y: ROW_B },
    ANV_VCO1_EG_AMOUNT: { x: 280, y: ROW_A },
    ANV_VCO2_EG_AMOUNT: { x: 280, y: ROW_B },
    ANV_VCO1_FREQUENCY: { x: 412, y: ROW_A, size: 'l' },
    ANV_VCO2_FREQUENCY: { x: 412, y: ROW_B, size: 'l' },
    ANV_VCO1_WAVE: { x: 506, y: ROW_A },
    ANV_VCO2_WAVE: { x: 506, y: ROW_B },

    // ---- MIXER level trio (stacked, between oscillators and filter) ----
    ANV_VCO1_LEVEL: { x: LVL_X, y: LVL_Y[0], size: 's' },
    ANV_NOISE_EXT_LEVEL: { x: LVL_X, y: LVL_Y[1], size: 's' },
    ANV_VCO2_LEVEL: { x: LVL_X, y: LVL_Y[2], size: 's' },

    // ---- FILTER / VCA / OUTPUT (right block, two rows) ----
    ANV_VCF_MODE: { x: 692, y: ROW_A },
    ANV_VCF_DECAY: { x: 692, y: ROW_B },
    ANV_CUTOFF: { x: 794, y: ROW_A, size: 'l' },
    ANV_VCF_EG_AMOUNT: { x: 794, y: ROW_B },
    ANV_RESONANCE: { x: 912, y: ROW_A, size: 'l' },
    ANV_NOISE_VCF_MOD: { x: 912, y: ROW_B },
    ANV_VCA_EG_ATTACK: { x: 1020, y: ROW_A },
    ANV_VCA_DECAY: { x: 1020, y: ROW_B },
    ANV_VOLUME: { x: 1116, y: ROW_A, size: 'l' },

    // ---- SEQUENCER — transports left, 8 step columns right ----
    ANV_TRIGGER: { x: 84, y: 336 },
    ANV_TEMPO: { x: 206, y: 364, size: 'l' },
    ANV_RUN_STOP: { x: 168, y: 450 },
    ANV_ADVANCE: { x: 266, y: 450 },

    ANV_SEQ_PITCH_1: { x: STEP_X[0], y: SEQ_PITCH_Y },
    ANV_SEQ_PITCH_2: { x: STEP_X[1], y: SEQ_PITCH_Y },
    ANV_SEQ_PITCH_3: { x: STEP_X[2], y: SEQ_PITCH_Y },
    ANV_SEQ_PITCH_4: { x: STEP_X[3], y: SEQ_PITCH_Y },
    ANV_SEQ_PITCH_5: { x: STEP_X[4], y: SEQ_PITCH_Y },
    ANV_SEQ_PITCH_6: { x: STEP_X[5], y: SEQ_PITCH_Y },
    ANV_SEQ_PITCH_7: { x: STEP_X[6], y: SEQ_PITCH_Y },
    ANV_SEQ_PITCH_8: { x: STEP_X[7], y: SEQ_PITCH_Y },

    ANV_SEQ_VELOCITY_1: { x: STEP_X[0], y: SEQ_VEL_Y },
    ANV_SEQ_VELOCITY_2: { x: STEP_X[1], y: SEQ_VEL_Y },
    ANV_SEQ_VELOCITY_3: { x: STEP_X[2], y: SEQ_VEL_Y },
    ANV_SEQ_VELOCITY_4: { x: STEP_X[3], y: SEQ_VEL_Y },
    ANV_SEQ_VELOCITY_5: { x: STEP_X[4], y: SEQ_VEL_Y },
    ANV_SEQ_VELOCITY_6: { x: STEP_X[5], y: SEQ_VEL_Y },
    ANV_SEQ_VELOCITY_7: { x: STEP_X[6], y: SEQ_VEL_Y },
    ANV_SEQ_VELOCITY_8: { x: STEP_X[7], y: SEQ_VEL_Y },
  },

  /** Empty — all jacks live in jackFieldLayout.ts. */
  jacks: {},
};
