/**
 * Cascade panel layout — WIDE landscape re-flow, three-column control field.
 * CONTROLS-ONLY: all 32 Cascade jacks live in the consolidated jack field
 * (jackFieldLayout.ts), on the Patchbay tab. This panel is its own landscape
 * canvas (1180 × 640), decoupled from the stage16x9 regions — App.tsx frames
 * the Cascade tab to these dims directly (no geometry move in stage16x9.ts).
 *
 * Three columns, left→right, following the unit's signal flow:
 *   - LEFT  — sequencing & rhythm: two 4-step sequencer rows, a 4×3 rhythm-
 *             divider grid (divider knob + two assign buttons stacked beneath
 *             each), then the transport cluster (TEMPO hero + RESET/EG/NEXT and
 *             PLAY/TRIGGER).
 *   - CENTER — sound sources: the two oscillators (FREQ hero + WAVE switch) with
 *             a shared SEQ-OCT button between them; the four sub dividers; the
 *             per-sequencer assign buttons and QUANTIZE; oscillator + sub levels.
 *   - RIGHT — filter / VCA / output: CUTOFF & VOLUME heroes up top, then
 *             RESONANCE / VCF-EG-AMT, the VCF envelope, and the VCA envelope.
 *
 * Knob labels render below, switch/button labels above; no row shares vertical
 * label space with its neighbour. Spacing invariants enforced by
 * test/unit/cascadeLayout.test.ts (control centers >= 40 units apart).
 */

// .ts extension: scripts/export-geometry.ts loads this layout straight in Node
// (native type stripping), whose ESM resolver wants explicit extensions.
import type { PanelLayout } from '../types.ts';

/** Landscape canvas — the panel's own viewBox (App.tsx frames the tab to this). */
export const CASCADE_W = 1110;
export const CASCADE_H = 580;

export const cascadeLayout: PanelLayout = {
  width: CASCADE_W,
  height: CASCADE_H,
  title: 'Cascade',

  sections: [],

  controls: {
    // ===== LEFT column — sequencers / rhythm / transport =====================
    // Two 4-step sequencer rows (small step knobs).
    CAS_SEQ1_STEP_1: { x: 70, y: 78, size: 'm' },
    CAS_SEQ1_STEP_2: { x: 138, y: 78, size: 'm' },
    CAS_SEQ1_STEP_3: { x: 206, y: 78, size: 'm' },
    CAS_SEQ1_STEP_4: { x: 274, y: 78, size: 'm' },
    CAS_SEQ2_STEP_1: { x: 70, y: 184, size: 'm' },
    CAS_SEQ2_STEP_2: { x: 138, y: 184, size: 'm' },
    CAS_SEQ2_STEP_3: { x: 206, y: 184, size: 'm' },
    CAS_SEQ2_STEP_4: { x: 274, y: 184, size: 'm' },

    // Rhythm grid: four divider knobs, each over a SEQ1/SEQ2 assign-button stack.
    CAS_RHYTHM_1: { x: 70, y: 300 },
    CAS_RHYTHM1_SEQ1: { x: 70, y: 348 },
    CAS_RHYTHM1_SEQ2: { x: 70, y: 390 },
    CAS_RHYTHM_2: { x: 146, y: 300 },
    CAS_RHYTHM2_SEQ1: { x: 146, y: 348 },
    CAS_RHYTHM2_SEQ2: { x: 146, y: 390 },
    CAS_RHYTHM_3: { x: 222, y: 300 },
    CAS_RHYTHM3_SEQ1: { x: 222, y: 348 },
    CAS_RHYTHM3_SEQ2: { x: 222, y: 390 },
    CAS_RHYTHM_4: { x: 298, y: 300 },
    CAS_RHYTHM4_SEQ1: { x: 298, y: 348 },
    CAS_RHYTHM4_SEQ2: { x: 298, y: 390 },

    // Transport: hero TEMPO + RESET/EG/NEXT row and PLAY/TRIGGER row.
    CAS_TEMPO: { x: 90, y: 500, size: 'l' },
    CAS_RESET: { x: 180, y: 470 },
    CAS_EG: { x: 230, y: 470 },
    CAS_NEXT: { x: 280, y: 470 },
    CAS_PLAY: { x: 195, y: 532 },
    CAS_TRIGGER_BTN: { x: 265, y: 532 },

    // ===== CENTER column — oscillators =======================================
    // Two oscillators: FREQ hero + WAVE switch, shared SEQ OCT between them.
    CAS_VCO1_FREQ: { x: 420, y: 96, size: 'l' },
    CAS_VCO1_WAVE: { x: 500, y: 96 },
    CAS_VCO2_FREQ: { x: 640, y: 96, size: 'l' },
    CAS_VCO2_WAVE: { x: 720, y: 96 },
    CAS_SEQ_OCT: { x: 570, y: 112 },

    // Sub dividers (two per oscillator).
    CAS_VCO1_SUB1_FREQ: { x: 410, y: 200 },
    CAS_VCO1_SUB2_FREQ: { x: 480, y: 200 },
    CAS_VCO2_SUB1_FREQ: { x: 630, y: 200 },
    CAS_VCO2_SUB2_FREQ: { x: 700, y: 200 },

    // Per-sequencer assign buttons + shared QUANTIZE.
    CAS_SEQ1_ASSIGN_OSC: { x: 392, y: 290 },
    CAS_SEQ1_ASSIGN_SUB1: { x: 444, y: 290 },
    CAS_SEQ1_ASSIGN_SUB2: { x: 496, y: 290 },
    CAS_QUANTIZE: { x: 570, y: 290 },
    CAS_SEQ2_ASSIGN_OSC: { x: 622, y: 290 },
    CAS_SEQ2_ASSIGN_SUB1: { x: 674, y: 290 },
    CAS_SEQ2_ASSIGN_SUB2: { x: 726, y: 290 },

    // Mixer: oscillator levels + sub levels (small caps).
    CAS_VCO1_LEVEL: { x: 448, y: 372 },
    CAS_VCO2_LEVEL: { x: 660, y: 372 },
    CAS_VCO1_SUB1_LEVEL: { x: 410, y: 470, size: 's' },
    CAS_VCO1_SUB2_LEVEL: { x: 480, y: 470, size: 's' },
    CAS_VCO2_SUB1_LEVEL: { x: 630, y: 470, size: 's' },
    CAS_VCO2_SUB2_LEVEL: { x: 700, y: 470, size: 's' },

    // ===== RIGHT column — filter / VCA / output ==============================
    CAS_CUTOFF: { x: 880, y: 96, size: 'l' },
    CAS_VOLUME: { x: 1060, y: 96, size: 'l' },
    CAS_RESONANCE: { x: 880, y: 210 },
    CAS_VCF_EG_AMOUNT: { x: 1060, y: 210 },
    CAS_VCF_ATTACK: { x: 880, y: 330 },
    CAS_VCF_DECAY: { x: 1060, y: 330 },
    CAS_VCA_ATTACK: { x: 880, y: 450 },
    CAS_VCA_DECAY: { x: 1060, y: 450 },
  },

  /** Empty — all jacks live in jackFieldLayout.ts. */
  jacks: {},
};
