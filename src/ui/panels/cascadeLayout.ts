/**
 * Cascade panel layout — 16:9 redesign: the panel
 * is now CONTROLS-ONLY; all 32 Cascade jacks moved to the consolidated jack field
 * (jackFieldLayout.ts). The viewBox equals the stage region (620.6 × 644.78)
 * and renders 1:1 in stage px.
 *
 * The control arrangement is unchanged from the stage-2 typography rework —
 * the region is sized to hold it at full size: five
 * single-purpose bands; knob labels (below) and switch/button labels never
 * share vertical space across rows. Grouping stays "in the spirit of" the
 * hardware: VCOs, mixer, filter/VCA across the top;
 * sequencers, rhythm generators, transport along the bottom.
 *
 * Spacing invariants enforced by test/unit/cascadeLayout.test.ts.
 */

// .ts extension: scripts/export-geometry.ts loads this layout straight in Node
// (native type stripping), whose ESM resolver wants explicit extensions.
import type { PanelLayout } from '../types.ts';
import { REGIONS } from '../stage16x9.ts';

/** Control band row centers. */
const ROW = [90, 202, 310] as const;
/** Sequencer band: step-knob row + assign-button row. */
const SEQ_KNOB_Y = 408;
const SEQ_BTN_Y = 472;
/** Rhythm band: divider knobs + stacked assign buttons; transport rows. */
const RHY_KNOB_Y = 568;
const RHY_BTN_Y1 = 548;
const RHY_BTN_Y2 = 592;

export const cascadeLayout: PanelLayout = {
  width: REGIONS.cascadeControls.w,
  height: REGIONS.cascadeControls.h,
  title: 'Cascade',

  sections: [
    // ---- top bands: sound sources & shaping --------------------------------
    { label: 'VCO 1', x: 8, y: 36, w: 300, h: 104 },
    { label: 'VCO 2', x: 316, y: 36, w: 292, h: 104 },
    { label: 'MIXER', x: 8, y: 148, w: 400, h: 104 },
    { label: 'TUNE & TEMPO', x: 416, y: 148, w: 192, h: 104 },
    { label: 'FILTER', x: 8, y: 256, w: 336, h: 104 },
    { label: 'VCA', x: 352, y: 256, w: 256, h: 104 },
    // ---- sequencing bands ----------------------------------------------------
    { label: 'SEQUENCER 1', x: 8, y: 368, w: 288, h: 136 },
    { label: 'SEQUENCER 2', x: 304, y: 368, w: 288, h: 136 },
    { label: 'RHYTHM', x: 8, y: 512, w: 428, h: 120 },
    { label: 'TRANSPORT', x: 444, y: 512, w: 164, h: 120 },
  ],

  controls: {
    // VCO 1 — hero FREQ, two sub dividers, wave switch
    CAS_VCO1_FREQ: { x: 56, y: ROW[0], size: 'l' },
    CAS_VCO1_SUB1_FREQ: { x: 126, y: ROW[0] },
    CAS_VCO1_SUB2_FREQ: { x: 192, y: ROW[0] },
    CAS_VCO1_WAVE: { x: 254, y: ROW[0] },
    // VCO 2
    CAS_VCO2_FREQ: { x: 364, y: ROW[0], size: 'l' },
    CAS_VCO2_SUB1_FREQ: { x: 432, y: ROW[0] },
    CAS_VCO2_SUB2_FREQ: { x: 496, y: ROW[0] },
    CAS_VCO2_WAVE: { x: 556, y: ROW[0] },
    // MIXER — six levels in one row (small caps, two-line labels)
    CAS_VCO1_LEVEL: { x: 44, y: ROW[1], size: 's' },
    CAS_VCO1_SUB1_LEVEL: { x: 108, y: ROW[1], size: 's' },
    CAS_VCO1_SUB2_LEVEL: { x: 172, y: ROW[1], size: 's' },
    CAS_VCO2_LEVEL: { x: 236, y: ROW[1], size: 's' },
    CAS_VCO2_SUB1_LEVEL: { x: 300, y: ROW[1], size: 's' },
    CAS_VCO2_SUB2_LEVEL: { x: 364, y: ROW[1], size: 's' },
    // TUNE & TEMPO — quantize/oct buttons stacked, hero tempo
    CAS_QUANTIZE: { x: 468, y: 180 },
    CAS_SEQ_OCT: { x: 468, y: 226 },
    CAS_TEMPO: { x: 552, y: ROW[1], size: 'l' },
    // FILTER
    CAS_CUTOFF: { x: 56, y: ROW[2], size: 'l' },
    CAS_RESONANCE: { x: 124, y: ROW[2] },
    CAS_VCF_EG_AMOUNT: { x: 188, y: ROW[2] },
    CAS_VCF_ATTACK: { x: 252, y: ROW[2] },
    CAS_VCF_DECAY: { x: 316, y: ROW[2] },
    // VCA — envelope, volume, EG-mode button
    CAS_VCA_ATTACK: { x: 400, y: ROW[2] },
    CAS_VCA_DECAY: { x: 464, y: ROW[2] },
    CAS_VOLUME: { x: 528, y: ROW[2] },
    CAS_EG: { x: 586, y: ROW[2] },
    // SEQUENCER 1 — four step knobs, assign buttons beneath
    CAS_SEQ1_STEP_1: { x: 48, y: SEQ_KNOB_Y },
    CAS_SEQ1_STEP_2: { x: 112, y: SEQ_KNOB_Y },
    CAS_SEQ1_STEP_3: { x: 176, y: SEQ_KNOB_Y },
    CAS_SEQ1_STEP_4: { x: 240, y: SEQ_KNOB_Y },
    CAS_SEQ1_ASSIGN_OSC: { x: 76, y: SEQ_BTN_Y },
    CAS_SEQ1_ASSIGN_SUB1: { x: 148, y: SEQ_BTN_Y },
    CAS_SEQ1_ASSIGN_SUB2: { x: 220, y: SEQ_BTN_Y },
    // SEQUENCER 2
    CAS_SEQ2_STEP_1: { x: 344, y: SEQ_KNOB_Y },
    CAS_SEQ2_STEP_2: { x: 408, y: SEQ_KNOB_Y },
    CAS_SEQ2_STEP_3: { x: 472, y: SEQ_KNOB_Y },
    CAS_SEQ2_STEP_4: { x: 536, y: SEQ_KNOB_Y },
    CAS_SEQ2_ASSIGN_OSC: { x: 372, y: SEQ_BTN_Y },
    CAS_SEQ2_ASSIGN_SUB1: { x: 444, y: SEQ_BTN_Y },
    CAS_SEQ2_ASSIGN_SUB2: { x: 516, y: SEQ_BTN_Y },
    // RHYTHM — four dividers, each with SEQ1/SEQ2 assigns stacked to its right
    CAS_RHYTHM_1: { x: 52, y: RHY_KNOB_Y },
    CAS_RHYTHM1_SEQ1: { x: 104, y: RHY_BTN_Y1 },
    CAS_RHYTHM1_SEQ2: { x: 104, y: RHY_BTN_Y2 },
    CAS_RHYTHM_2: { x: 154, y: RHY_KNOB_Y },
    CAS_RHYTHM2_SEQ1: { x: 206, y: RHY_BTN_Y1 },
    CAS_RHYTHM2_SEQ2: { x: 206, y: RHY_BTN_Y2 },
    CAS_RHYTHM_3: { x: 256, y: RHY_KNOB_Y },
    CAS_RHYTHM3_SEQ1: { x: 308, y: RHY_BTN_Y1 },
    CAS_RHYTHM3_SEQ2: { x: 308, y: RHY_BTN_Y2 },
    CAS_RHYTHM_4: { x: 358, y: RHY_KNOB_Y },
    CAS_RHYTHM4_SEQ1: { x: 410, y: RHY_BTN_Y1 },
    CAS_RHYTHM4_SEQ2: { x: 410, y: RHY_BTN_Y2 },
    // TRANSPORT (2×2)
    CAS_PLAY: { x: 492, y: RHY_BTN_Y1 },
    CAS_TRIGGER_BTN: { x: 560, y: RHY_BTN_Y1 },
    CAS_RESET: { x: 492, y: RHY_BTN_Y2 },
    CAS_NEXT: { x: 560, y: RHY_BTN_Y2 },
  },

  /** Empty since the 16:9 redesign — all jacks live in jackFieldLayout.ts. */
  jacks: {},
};
