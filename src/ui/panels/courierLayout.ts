/**
 * Courier panel layout — WIDE landscape re-flow, the densest voice control field.
 * CONTROLS-ONLY: all Courier jacks live in the consolidated jack field
 * (jackFieldLayout.ts), on the Patchbay tab. This panel is its own landscape
 * canvas (1300 × 620), decoupled from the stage16x9 regions — App.tsx frames
 * the Courier tab to these dims directly (no geometry move in stage16x9.ts).
 *
 * Columns, left→right, following the unit's signal flow:
 *   - LFO 1 / left-hand — the modulation LFO + the left-hand performance LFO 2,
 *     glide and volume (the player's left-hand controls live with the master out).
 *   - OSCILLATORS — OSC 1 (octave / tune / waveshape) + the sub, OSC 2 (octave /
 *     freq / waveshape), sync, and the OSC-mod amount/dest pair.
 *   - MIXER — the five source levels (OSC 1, OSC 2, SUB, NOISE, FB/EXT).
 *   - FILTER — CUTOFF / RESONANCE heroes, EG amount, OSC2→cutoff, the mode/track
 *     switches.
 *   - FILTER ENV + AMP ENV — the two ADSRs, each with its VEL / LOOP switches,
 *     plus the global MULTI TRIG.
 *
 * Knob labels render below, switch labels above; no row shares vertical label
 * space with its neighbour. Spacing invariants enforced by
 * test/unit/courierLayout.test.ts (control centers >= 40 units apart).
 */

// .ts extension: scripts/export-geometry.ts loads this layout straight in Node
// (native type stripping), whose ESM resolver wants explicit extensions.
import type { PanelLayout } from '../types.ts';

/** Landscape canvas — the panel's own viewBox (App.tsx frames the tab to this). */
export const COURIER_W = 1300;
export const COURIER_H = 620;

export const courierLayout: PanelLayout = {
  width: COURIER_W,
  height: COURIER_H,
  title: 'Courier',

  sections: [],

  controls: {
    // ===== COLUMN 1 — LFO 1 + left-hand performance ==========================
    COU_LFO1_RATE: { x: 70, y: 90, size: 'm' },
    COU_LFO1_DEPTH: { x: 158, y: 90, size: 'm' },
    COU_LFO1_WAVE: { x: 70, y: 200 },
    COU_LFO1_DEST: { x: 158, y: 200 },
    COU_LFO1_SYNC: { x: 70, y: 300 },
    COU_LFO1_KB_RESET: { x: 158, y: 300 },

    // Left-hand performance cluster (LFO 2 + glide + volume).
    COU_LFO2_RATE: { x: 70, y: 420, size: 'm' },
    COU_GLIDE: { x: 158, y: 420, size: 'm' },
    COU_LFO2_DEST: { x: 70, y: 530 },
    COU_VOLUME: { x: 158, y: 530, size: 'l' },

    // ===== COLUMN 2 — oscillators ============================================
    COU_OSC1_OCTAVE: { x: 270, y: 90 },
    COU_TUNE: { x: 348, y: 90, size: 'm' },
    COU_OSC1_WAVESHAPE: { x: 270, y: 200, size: 'm' },
    COU_SUB_WAVE: { x: 348, y: 200, size: 'm' },

    COU_OSC2_OCTAVE: { x: 270, y: 320 },
    COU_OSC2_FREQ: { x: 348, y: 320, size: 'm' },
    COU_OSC2_WAVESHAPE: { x: 270, y: 430, size: 'm' },
    COU_SYNC: { x: 348, y: 430 },

    COU_MOD_AMOUNT: { x: 270, y: 540, size: 'm' },
    COU_MOD_DEST: { x: 348, y: 540 },

    // ===== COLUMN 3 — mixer ==================================================
    COU_MIX_OSC1: { x: 470, y: 100, size: 'm' },
    COU_MIX_OSC2: { x: 470, y: 200, size: 'm' },
    COU_MIX_SUB: { x: 470, y: 300, size: 'm' },
    COU_MIX_NOISE: { x: 470, y: 400, size: 'm' },
    COU_MIX_FB_EXT: { x: 470, y: 500, size: 'm' },

    // ===== COLUMN 4 — filter =================================================
    COU_CUTOFF: { x: 620, y: 100, size: 'l' },
    COU_RESONANCE: { x: 740, y: 100, size: 'l' },
    COU_EG_AMOUNT: { x: 620, y: 230, size: 'm' },
    COU_OSC2_CUTOFF: { x: 740, y: 230, size: 'm' },
    COU_FILTER_MODE: { x: 620, y: 350 },
    COU_RES_BASS: { x: 700, y: 350 },
    COU_KB_TRACKING: { x: 770, y: 350 },

    // ===== COLUMN 5 — FILTER ENV (ADSR) ======================================
    COU_F_ATTACK: { x: 880, y: 100, size: 'm' },
    COU_F_DECAY: { x: 960, y: 100, size: 'm' },
    COU_F_SUSTAIN: { x: 880, y: 210, size: 'm' },
    COU_F_RELEASE: { x: 960, y: 210, size: 'm' },
    COU_F_ENV_VEL: { x: 880, y: 320 },
    COU_F_ENV_LOOP: { x: 960, y: 320 },

    // ===== COLUMN 6 — AMP ENV (ADSR) =========================================
    COU_A_ATTACK: { x: 1090, y: 100, size: 'm' },
    COU_A_DECAY: { x: 1170, y: 100, size: 'm' },
    COU_A_SUSTAIN: { x: 1090, y: 210, size: 'm' },
    COU_A_RELEASE: { x: 1170, y: 210, size: 'm' },
    COU_A_ENV_VEL: { x: 1090, y: 320 },
    COU_A_ENV_LOOP: { x: 1170, y: 320 },
    COU_MULTI_TRIG: { x: 1130, y: 420 },
  },

  /** Empty — all jacks live in jackFieldLayout.ts. */
  jacks: {},
};
