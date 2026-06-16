/**
 * Anvil panel layout — 16:9 redesign: CONTROLS-ONLY;
 * all 24 Anvil jacks moved to the consolidated jack field (jackFieldLayout.ts).
 * The viewBox equals the stage region (595.96 × 509.98) and
 * renders 1:1 in stage px.
 *
 * Control arrangement unchanged from the stage-2 typography rework — the
 * region is sized to hold it at full size: four single-row
 * control bands plus a roomy sequencer band; knob labels (below) and switch
 * labels (above) from adjacent bands cannot collide. Arrangement stays "in the
 * spirit of" the hardware: VCOs, VCO EG, Mixer, VCA, VCF,
 * then the 8-step sequencer along the bottom.
 *
 * Step LEDs: the panel renders the chase row centered between the PITCH and
 * VELOCITY rows — keep SEQ_LED_Y clear of labels.
 *
 * Spacing invariants enforced by test/unit/anvilLayout.test.ts.
 */

// .ts extension: scripts/export-geometry.ts loads this layout straight in Node
// (native type stripping), whose ESM resolver wants explicit extensions.
import type { PanelLayout } from '../types.ts';
import { REGIONS } from '../stage16x9.ts';

/** Control band row centers. */
const ROW = [90, 202, 310] as const;
/** Sequencer band rows. */
const SEQ_PITCH_Y = 404;
const SEQ_VEL_Y = 466;
/** y for the panel's step-LED chase row (between PITCH labels and VELOCITY caps). */
export const SEQ_LED_Y = 438;
/** Step column centers (8 columns, 56-unit pitch). */
const STEP_X = [150, 206, 262, 318, 374, 430, 486, 542] as const;

export const anvilLayout: PanelLayout = {
  width: REGIONS.anvilControls.w,
  height: REGIONS.anvilControls.h,
  title: 'Anvil',

  sections: [
    { label: 'OSCILLATORS', x: 8, y: 36, w: 580, h: 104 },
    { label: 'VCO EG', x: 8, y: 148, w: 248, h: 104 },
    { label: 'MIXER', x: 264, y: 148, w: 196, h: 104 },
    { label: 'VCA', x: 468, y: 148, w: 120, h: 104 },
    { label: 'FILTER', x: 8, y: 260, w: 420, h: 104 },
    { label: 'OUTPUT', x: 436, y: 260, w: 152, h: 104 },
    { label: 'SEQUENCER', x: 8, y: 372, w: 580, h: 130 },
  ],

  controls: {
    // OSCILLATORS — one row: VCO1, VCO2, sync/FM/seq-mod
    ANV_VCO1_FREQUENCY: { x: 56, y: ROW[0], size: 'l' },
    ANV_VCO1_WAVE: { x: 126, y: ROW[0] },
    ANV_VCO2_FREQUENCY: { x: 198, y: ROW[0], size: 'l' },
    ANV_VCO2_WAVE: { x: 268, y: ROW[0] },
    ANV_HARD_SYNC: { x: 334, y: ROW[0] },
    ANV_FM_AMOUNT: { x: 402, y: ROW[0] },
    ANV_SEQ_PITCH_MOD: { x: 472, y: ROW[0] },

    // VCO EG
    ANV_VCO_DECAY: { x: 56, y: ROW[1] },
    ANV_VCO1_EG_AMOUNT: { x: 126, y: ROW[1] },
    ANV_VCO2_EG_AMOUNT: { x: 196, y: ROW[1] },

    // MIXER
    ANV_VCO1_LEVEL: { x: 310, y: ROW[1] },
    ANV_NOISE_EXT_LEVEL: { x: 372, y: ROW[1] },
    ANV_VCO2_LEVEL: { x: 434, y: ROW[1] },

    // VCA (attack switch + decay; VOLUME lives in OUTPUT)
    ANV_VCA_EG_ATTACK: { x: 500, y: ROW[1] },
    ANV_VCA_DECAY: { x: 562, y: ROW[1] },

    // FILTER
    ANV_CUTOFF: { x: 58, y: ROW[2], size: 'l' },
    ANV_RESONANCE: { x: 130, y: ROW[2] },
    ANV_VCF_MODE: { x: 196, y: ROW[2] },
    ANV_VCF_DECAY: { x: 258, y: ROW[2] },
    ANV_VCF_EG_AMOUNT: { x: 326, y: ROW[2] },
    ANV_NOISE_VCF_MOD: { x: 394, y: ROW[2] },

    // OUTPUT
    ANV_VOLUME: { x: 500, y: ROW[2], size: 'l' },

    // SEQUENCER — tempo + transports left, 8 step columns right
    ANV_TEMPO: { x: 46, y: SEQ_PITCH_Y, size: 'l' },
    ANV_TRIGGER: { x: 104, y: SEQ_PITCH_Y },
    ANV_RUN_STOP: { x: 40, y: SEQ_VEL_Y },
    ANV_ADVANCE: { x: 104, y: SEQ_VEL_Y },

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

  /** Empty since the 16:9 redesign — all jacks live in jackFieldLayout.ts. */
  jacks: {},
};
