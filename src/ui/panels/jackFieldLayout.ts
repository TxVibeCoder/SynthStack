/**
 * Consolidated jack field — the 16:9 redesign's big move:
 * ALL 88 jacks in one full-width patchbay below the control panels, zoned by
 * machine left→right Cascade / Anvil / Monarch, mirroring the control columns above.
 *
 * Coordinates are FIELD-LOCAL stage px: origin = the field region's top-left
 * (stage 0, 644.78 — REGIONS.jackField in stage16x9.ts), 1805.19 × 229.5.
 * The field's top edge steps DOWN 24 px right of x=1117.56 (the seq strip
 * reaches y=668.78 there), so the Monarch zone is 24 px shorter; the Anvil zone owns
 * the sliver between the step and the Monarch zone (jacks stay left of the step).
 *
 * Within each zone: INPUTS block left, OUTPUTS block right (the same
 * inputs-before-outputs zoning the per-panel patchbays used), jacks in module
 * JSON order, row-major. A dashed divider separates the blocks.
 *
 * Invariants (88 unique ids, ≥26-px spacing, zone containment) enforced by
 * test/unit/jackFieldLayout.test.ts.
 */

// .ts extension: scripts/export-geometry.ts loads this layout straight in Node
// (native type stripping), whose ESM resolver wants explicit extensions.
import type { Pt } from '../types.ts';
import { JACK_FIELD_STEP_X, JACK_ZONES, REGIONS } from '../stage16x9.ts';

export interface JackZoneChrome {
  /** Machine key, matches JACK_ZONES / GROUP_BORDER. */
  key: 'cascade' | 'anvil' | 'monarch';
  label: string;
  /** Zone frame outline, field-local, closed polygon (rect or stepped). */
  frame: ReadonlyArray<readonly [number, number]>;
  /** Where the frame's label gap sits (left end of the top edge). */
  labelAt: Pt;
  /** "INPUTS" / "OUTPUTS" sub-label centers. */
  inLabelAt: Pt;
  outLabelAt: Pt;
  /** Dashed divider between the IN and OUT blocks: x, y1→y2. */
  divider: { x: number; y1: number; y2: number };
}

/**
 * Patchbay field height — DECOUPLED from REGIONS.jackField.h (229.5) so the voice
 * jacks get vertical room to spread (bigger row pitch + bigger labels). The field
 * keeps the full STAGE width (REGIONS.jackField.w) so the CableLayer width÷STAGE.w
 * scale anchor still holds and cables measure correctly. App.tsx frames the patchbay
 * jack field to this height (JACKFIELD_BOX), not the stage region.
 */
export const FIELD_H = 690;

export const FIELD = {
  width: REGIONS.jackField.w,
  height: FIELD_H,
  /** Field-local x/y of the top-edge step (stage 1117.56 / 668.78). */
  stepX: JACK_FIELD_STEP_X - REGIONS.jackField.x,
  stepY: 668.78 - REGIONS.jackField.y, // = 24
} as const;

/** Field-local panel-face outline (the panel-face polygon). */
export const FIELD_FACE: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [FIELD.stepX, 0],
  [FIELD.stepX, FIELD.stepY],
  [FIELD.width, FIELD.stepY],
  [FIELD.width, FIELD.height],
  [0, FIELD.height],
];

/** Shared row centers for the Cascade and Anvil zones. The field now fills the patchbay's
 *  vertical band (FIELD_H 690), so the four rows spread on a generous ~180-px pitch — the
 *  jacks de-crowd and their labels get real breathing room. */
const ROW = [90, 270, 450, 630] as const;
/** Monarch zone rows: start below the seq-strip step, same generous pitch. */
const MON_ROW = [94, 272, 450, 628] as const;

// Column centers per zone block (56–64-px pitch; labels clamp at 48 wide).
const CAS_IN = [36, 92, 148, 204, 260] as const;
const CAS_OUT = [340, 396, 452, 508] as const;
const ANV_IN = [596, 656, 716, 776] as const;
const ANV_OUT = [884, 948, 1012] as const;
const MON_IN = [1222, 1278, 1334, 1390, 1446] as const;
const MON_OUT = [1538, 1594, 1650, 1706] as const;

export const JACK_ZONE_CHROME: readonly JackZoneChrome[] = [
  {
    key: 'cascade',
    label: 'CASCADE',
    frame: [
      [4, 4],
      [JACK_ZONES.cascade.w - 4, 4],
      [JACK_ZONES.cascade.w - 4, FIELD.height - 4],
      [4, FIELD.height - 4],
    ],
    labelAt: { x: 14, y: 6 },
    inLabelAt: { x: 148, y: 60 },
    outLabelAt: { x: 424, y: 60 },
    divider: { x: 300, y1: 14, y2: FIELD.height - 14 },
  },
  {
    key: 'anvil',
    label: 'ANVIL',
    frame: [
      [JACK_ZONES.anvil.x + 4, 4],
      [FIELD.stepX - 4, 4],
      [FIELD.stepX - 4, FIELD.stepY + 4],
      [JACK_ZONES.anvil.x + JACK_ZONES.anvil.w - 4, FIELD.stepY + 4],
      [JACK_ZONES.anvil.x + JACK_ZONES.anvil.w - 4, FIELD.height - 4],
      [JACK_ZONES.anvil.x + 4, FIELD.height - 4],
    ],
    labelAt: { x: JACK_ZONES.anvil.x + 14, y: 6 },
    inLabelAt: { x: 686, y: 60 },
    outLabelAt: { x: 948, y: 60 },
    divider: { x: 830, y1: 14, y2: FIELD.height - 14 },
  },
  {
    key: 'monarch',
    label: 'MONARCH',
    frame: [
      [JACK_ZONES.monarch.x + 4, FIELD.stepY + 4],
      [FIELD.width - 4, FIELD.stepY + 4],
      [FIELD.width - 4, FIELD.height - 4],
      [JACK_ZONES.monarch.x + 4, FIELD.height - 4],
    ],
    labelAt: { x: JACK_ZONES.monarch.x + 14, y: FIELD.stepY + 4 },
    inLabelAt: { x: 1334, y: 64 },
    outLabelAt: { x: 1622, y: 64 },
    divider: { x: 1492, y1: FIELD.stepY + 14, y2: FIELD.height - 14 },
  },
];

/**
 * jackId → field-local center. Module JSON order, row-major inside each
 * machine's IN block then OUT block.
 */
export const jackFieldJacks: Record<string, Pt> = {
  // ---- CASCADE inputs (17) -------------------------------------------
  CAS_VCO1_IN: { x: CAS_IN[0], y: ROW[0] },
  CAS_VCO1_SUB_IN: { x: CAS_IN[1], y: ROW[0] },
  CAS_VCO1_PWM_IN: { x: CAS_IN[2], y: ROW[0] },
  CAS_VCA_IN: { x: CAS_IN[3], y: ROW[0] },
  CAS_VCO2_IN: { x: CAS_IN[4], y: ROW[0] },
  CAS_VCO2_SUB_IN: { x: CAS_IN[0], y: ROW[1] },
  CAS_VCO2_PWM_IN: { x: CAS_IN[1], y: ROW[1] },
  CAS_CUTOFF_IN: { x: CAS_IN[2], y: ROW[1] },
  CAS_PLAY_IN: { x: CAS_IN[3], y: ROW[1] },
  CAS_RESET_IN: { x: CAS_IN[4], y: ROW[1] },
  CAS_TRIGGER_IN: { x: CAS_IN[0], y: ROW[2] },
  CAS_RHYTHM_1_IN: { x: CAS_IN[1], y: ROW[2] },
  CAS_RHYTHM_2_IN: { x: CAS_IN[2], y: ROW[2] },
  CAS_RHYTHM_3_IN: { x: CAS_IN[3], y: ROW[2] },
  CAS_RHYTHM_4_IN: { x: CAS_IN[4], y: ROW[2] },
  CAS_MIDI_IN: { x: CAS_IN[0], y: ROW[3] },
  CAS_CLOCK_IN: { x: CAS_IN[1], y: ROW[3] },
  // ---- CASCADE outputs (15) ------------------------------------------
  CAS_VCA_OUT: { x: CAS_OUT[0], y: ROW[0] },
  CAS_VCO1_OUT: { x: CAS_OUT[1], y: ROW[0] },
  CAS_VCO1_SUB1_OUT: { x: CAS_OUT[2], y: ROW[0] },
  CAS_VCO1_SUB2_OUT: { x: CAS_OUT[3], y: ROW[0] },
  CAS_VCO2_OUT: { x: CAS_OUT[0], y: ROW[1] },
  CAS_VCO2_SUB1_OUT: { x: CAS_OUT[1], y: ROW[1] },
  CAS_VCO2_SUB2_OUT: { x: CAS_OUT[2], y: ROW[1] },
  CAS_VCA_EG_OUT: { x: CAS_OUT[3], y: ROW[1] },
  CAS_VCF_EG_OUT: { x: CAS_OUT[0], y: ROW[2] },
  CAS_SEQ1_OUT: { x: CAS_OUT[1], y: ROW[2] },
  CAS_SEQ1_CLK_OUT: { x: CAS_OUT[2], y: ROW[2] },
  CAS_SEQ2_OUT: { x: CAS_OUT[3], y: ROW[2] },
  CAS_SEQ2_CLK_OUT: { x: CAS_OUT[0], y: ROW[3] },
  CAS_CLOCK_OUT: { x: CAS_OUT[1], y: ROW[3] },
  CAS_TRIGGER_OUT: { x: CAS_OUT[2], y: ROW[3] },

  // ---- Anvil inputs (15) ----------------------------------------------------
  ANV_TRIGGER_IN: { x: ANV_IN[0], y: ROW[0] },
  ANV_VCA_CV_IN: { x: ANV_IN[1], y: ROW[0] },
  ANV_VELOCITY_IN: { x: ANV_IN[2], y: ROW[0] },
  ANV_VCA_DECAY_IN: { x: ANV_IN[3], y: ROW[0] },
  ANV_EXT_AUDIO_IN: { x: ANV_IN[0], y: ROW[1] },
  ANV_VCF_DECAY_IN: { x: ANV_IN[1], y: ROW[1] },
  ANV_NOISE_LEVEL_IN: { x: ANV_IN[2], y: ROW[1] },
  ANV_VCO_DECAY_IN: { x: ANV_IN[3], y: ROW[1] },
  ANV_VCF_MOD_IN: { x: ANV_IN[0], y: ROW[2] },
  ANV_VCO1_CV_IN: { x: ANV_IN[1], y: ROW[2] },
  ANV_FM_AMT_IN: { x: ANV_IN[2], y: ROW[2] },
  ANV_VCO2_CV_IN: { x: ANV_IN[3], y: ROW[2] },
  ANV_TEMPO_IN: { x: ANV_IN[0], y: ROW[3] },
  ANV_RUN_STOP_IN: { x: ANV_IN[1], y: ROW[3] },
  ANV_ADV_CLOCK_IN: { x: ANV_IN[2], y: ROW[3] },
  // ---- Anvil outputs (9) ----------------------------------------------------
  ANV_VCA_OUT: { x: ANV_OUT[0], y: ROW[0] },
  ANV_VCA_EG_OUT: { x: ANV_OUT[1], y: ROW[0] },
  ANV_VCF_EG_OUT: { x: ANV_OUT[2], y: ROW[0] },
  ANV_VCO_EG_OUT: { x: ANV_OUT[0], y: ROW[1] },
  ANV_VCO1_OUT: { x: ANV_OUT[1], y: ROW[1] },
  ANV_VCO2_OUT: { x: ANV_OUT[2], y: ROW[1] },
  ANV_TRIGGER_OUT: { x: ANV_OUT[0], y: ROW[2] },
  ANV_VELOCITY_OUT: { x: ANV_OUT[1], y: ROW[2] },
  ANV_PITCH_OUT: { x: ANV_OUT[2], y: ROW[2] },

  // ---- MONARCH inputs (18) -----------------------------------------------
  MON_EXT_AUDIO_IN: { x: MON_IN[0], y: MON_ROW[0] },
  MON_MIX_CV_IN: { x: MON_IN[1], y: MON_ROW[0] },
  MON_VCA_CV_IN: { x: MON_IN[2], y: MON_ROW[0] },
  MON_VCF_CUTOFF_IN: { x: MON_IN[3], y: MON_ROW[0] },
  MON_VCF_RES_IN: { x: MON_IN[4], y: MON_ROW[0] },
  MON_VCO_1VOCT_IN: { x: MON_IN[0], y: MON_ROW[1] },
  MON_VCO_LIN_FM_IN: { x: MON_IN[1], y: MON_ROW[1] },
  MON_VCO_MOD_IN: { x: MON_IN[2], y: MON_ROW[1] },
  MON_LFO_RATE_IN: { x: MON_IN[3], y: MON_ROW[1] },
  MON_MIX1_IN: { x: MON_IN[4], y: MON_ROW[1] },
  MON_MIX2_IN: { x: MON_IN[0], y: MON_ROW[2] },
  MON_VC_MIX_CTRL_IN: { x: MON_IN[1], y: MON_ROW[2] },
  MON_MULT_IN: { x: MON_IN[2], y: MON_ROW[2] },
  MON_GATE_IN: { x: MON_IN[3], y: MON_ROW[2] },
  MON_TEMPO_IN: { x: MON_IN[4], y: MON_ROW[2] },
  MON_RUN_STOP_IN: { x: MON_IN[0], y: MON_ROW[3] },
  MON_RESET_IN: { x: MON_IN[1], y: MON_ROW[3] },
  MON_HOLD_IN: { x: MON_IN[2], y: MON_ROW[3] },
  // ---- MONARCH outputs (14) ----------------------------------------------
  MON_VCA_OUT: { x: MON_OUT[0], y: MON_ROW[0] },
  MON_NOISE_OUT: { x: MON_OUT[1], y: MON_ROW[0] },
  MON_VCF_OUT: { x: MON_OUT[2], y: MON_ROW[0] },
  MON_VCO_SAW_OUT: { x: MON_OUT[3], y: MON_ROW[0] },
  MON_VCO_PULSE_OUT: { x: MON_OUT[0], y: MON_ROW[1] },
  MON_LFO_TRI_OUT: { x: MON_OUT[1], y: MON_ROW[1] },
  MON_LFO_SQ_OUT: { x: MON_OUT[2], y: MON_ROW[1] },
  MON_VC_MIX_OUT: { x: MON_OUT[3], y: MON_ROW[1] },
  MON_MULT1_OUT: { x: MON_OUT[0], y: MON_ROW[2] },
  MON_MULT2_OUT: { x: MON_OUT[1], y: MON_ROW[2] },
  MON_ASSIGN_OUT: { x: MON_OUT[2], y: MON_ROW[2] },
  MON_EG_OUT: { x: MON_OUT[3], y: MON_ROW[2] },
  MON_KB_OUT: { x: MON_OUT[0], y: MON_ROW[3] },
  MON_GATE_OUT: { x: MON_OUT[1], y: MON_ROW[3] },
};
