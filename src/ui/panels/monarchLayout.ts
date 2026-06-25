/**
 * Monarch panel layout — WIDE hardware re-flow (landscape control panel).
 * CONTROLS-ONLY: all Monarch jacks live in the consolidated jack field
 * (jackFieldLayout.ts), on the Patchbay tab. This panel is a landscape canvas
 * (1480 × 408) decoupled from the stage16x9 regions — App.tsx frames the Monarch
 * tab to these dims directly (no geometry move in stage16x9.ts).
 *
 * Arrangement follows the real unit's signal flow as three full-width knob rows,
 * eight columns each (left→right):
 *   - row 1: oscillator + filter + VCA + output stage
 *       FREQUENCY · VCO WAVE · PULSE WIDTH · MIX │ CUTOFF · RESONANCE ·
 *       VCA MODE · VOLUME
 *   - row 2: modulation routing for oscillator and filter
 *       GLIDE · VCO MOD SRC · VCO MOD AMT · VCO MOD DEST │ VCF MODE ·
 *       VCF MOD SRC · VCF MOD AMT · VCF MOD POLARITY
 *   - row 3: clock / LFO / envelope / voltage-controlled mixer
 *       TEMPO · SWING · LFO RATE · LFO WAVE │ ATTACK · DECAY · SUSTAIN · VC MIX
 * A short transport row (RUN/STOP · RESET · HOLD) sits below the first three
 * columns. The 32-step editor and on-screen keyboard are composed separately by
 * App.tsx BELOW this panel — they are not part of this layout.
 *
 * Spacing invariants enforced by test/unit/monarchLayout.test.ts.
 */

// .ts extension: scripts/export-geometry.ts loads this layout straight in Node
// (native type stripping), whose ESM resolver wants explicit extensions.
import type { PanelLayout } from '../types.ts';

/** Landscape canvas — the panel's own viewBox (App.tsx frames the tab to this).
 *  Wide + short so the tab fills the viewport width (bigger knobs/text, no side gaps). */
export const MONARCH_W = 1480;
export const MONARCH_H = 408;

/** Three control-row centers (110-unit pitch). */
const ROW = [90, 200, 310] as const;
/** Eight column centers (184-unit pitch — spread across the wide canvas). */
const C = [100, 284, 468, 652, 836, 1020, 1204, 1388] as const;
/** Transport button row, tucked directly below the third control row. */
const TR_Y = 372;
/** ASSIGN-source 9-position lever — centered low in the right gutter so its tall body
 *  (~142u) stays inside the 408u canvas (337 ± 71 = 266..408). */
const ASSIGN_Y = 337;

export const monarchLayout: PanelLayout = {
  width: MONARCH_W,
  height: MONARCH_H,
  title: 'Monarch',

  sections: [],

  controls: {
    // ---- Row 1: oscillator → filter → VCA → output ----
    MON_FREQUENCY: { x: C[0], y: ROW[0], size: 'l' },
    MON_VCO_WAVE: { x: C[1], y: ROW[0] },
    MON_PULSE_WIDTH: { x: C[2], y: ROW[0] },
    MON_MIX: { x: C[3], y: ROW[0] },
    MON_VCF_CUTOFF: { x: C[4], y: ROW[0], size: 'l' },
    MON_VCF_RESONANCE: { x: C[5], y: ROW[0] },
    MON_VCA_MODE: { x: C[6], y: ROW[0] },
    MON_VOLUME: { x: C[7], y: ROW[0], size: 'l' },

    // ---- Row 2: oscillator + filter modulation routing ----
    MON_GLIDE: { x: C[0], y: ROW[1] },
    MON_VCO_MOD_SOURCE: { x: C[1], y: ROW[1] },
    MON_VCO_MOD_AMOUNT: { x: C[2], y: ROW[1] },
    MON_VCO_MOD_DEST: { x: C[3], y: ROW[1] },
    MON_VCF_MODE: { x: C[4], y: ROW[1] },
    MON_VCF_MOD_SOURCE: { x: C[5], y: ROW[1] },
    MON_VCF_MOD_AMOUNT: { x: C[6], y: ROW[1] },
    MON_VCF_MOD_POLARITY: { x: C[7], y: ROW[1] },

    // ---- Row 3: clock / LFO / envelope / VC mix ----
    MON_TEMPO: { x: C[0], y: ROW[2], size: 'l' },
    MON_SWING: { x: C[1], y: ROW[2] },
    MON_LFO_RATE: { x: C[2], y: ROW[2], size: 'l' },
    MON_LFO_WAVE: { x: C[3], y: ROW[2] },
    MON_ATTACK: { x: C[4], y: ROW[2] },
    MON_DECAY: { x: C[5], y: ROW[2] },
    MON_SUSTAIN: { x: C[6], y: ROW[2] },
    MON_VC_MIX: { x: C[7], y: ROW[2] },

    // ---- Transport row ----
    MON_RUN_STOP: { x: C[0], y: TR_Y },
    MON_RESET: { x: C[1], y: TR_Y },
    MON_HOLD: { x: C[2], y: TR_Y },

    // ---- Setup: ASSIGN out source selector ----
    // Real-hardware Setup-mode page-1 parameter (no front-panel pot on the unit); the emulator
    // surfaces it as a 9-position selector so a running patch can pick the ASSIGN source. The
    // 9-position lever is tall (~142u), so it sits in the open right-hand gutter beside the
    // transport row, vertically centered low enough to stay inside the 408u canvas yet clear of
    // the row-3 knobs (MON_SUSTAIN / MON_VC_MIX) by > 40u.
    MON_ASSIGN_SOURCE: { x: 1300, y: ASSIGN_Y },
  },

  /** Empty — all jacks live in jackFieldLayout.ts. */
  jacks: {},
};
