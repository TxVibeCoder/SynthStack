/**
 * Courier panel layout — a faithful re-flow of the source hardware's synth-control
 * band: six labelled sections left→right following the signal path
 *   LFO 1 · OSCILLATORS · MIXER · FILTER · ENVELOPES · OUTPUT
 * plus a lower-left LFO 2 / GLIDE performance cluster (the source unit's left-hand
 * controls sit below the LFO area). Sequencer transport + jacks live elsewhere
 * (the step-editor strip and the patchbay), exactly as the hardware splits its
 * face into a control band, a sequencer row, and a keyboard.
 *
 * Geometry is measured from the reference photo (control centres, relative knob
 * sizes, two knob rows + a switch/toggle row per section) and scaled to this
 * wide-short canvas. CUTOFF is the hero knob (size 'l'); section knobs are 'm'.
 * Coordinates locate control CENTRES; sections give a top-left corner + size.
 *
 * Spacing invariant (test/unit/courierLayout.test.ts): control centres ≥ 40 units
 * apart, everything inside the viewBox. Styling stays SynthStack's own (dark panel /
 * cream legend / gold knobs) — NO logos, wordmarks, or trade dress.
 *
 * .ts extension: scripts/export-geometry.ts loads this layout straight in Node.
 */
import type { PanelLayout } from '../types.ts';

/** Landscape canvas — the panel's own viewBox (App.tsx frames the tab to this). */
export const COURIER_W = 1300;
export const COURIER_H = 470;

// Row baselines (control centres). Two knob rows, a hero-knob centre line between
// them, a switch/toggle row beneath, and the lower-left performance cluster. The
// rows clear the section-header band (frames open at y 84) so switch labels-above
// never collide with a section title.
const TOP = 150; // upper knob / switch row
const BIG = 195; // hero-knob centre (CUTOFF, VOLUME) — sits between the two rows
const BOT = 248; // lower knob / switch row
const BTN = 320; // toggle / mode-switch row
const PERF = 392; // GLIDE / LFO 2 RATE
const PERF_SW = 434; // LFO 2 DESTINATION

export const courierLayout: PanelLayout = {
  width: COURIER_W,
  height: COURIER_H,
  title: 'Courier',

  // Silkscreen section frames (rounded rect + label in a gap in the top border).
  sections: [
    { label: 'LFO 1', x: 46, y: 84, w: 164, h: 272 },
    { label: 'OSCILLATORS', x: 212, y: 84, w: 268, h: 272 },
    { label: 'MIXER', x: 482, y: 84, w: 190, h: 272 },
    { label: 'FILTER', x: 674, y: 84, w: 202, h: 272 },
    { label: 'ENVELOPES', x: 898, y: 84, w: 286, h: 272 },
    { label: 'OUTPUT', x: 1186, y: 84, w: 96, h: 272 },
    { label: 'LFO 2', x: 46, y: 372, w: 200, h: 96 },
  ],

  controls: {
    // ===== LFO 1 ============================================================
    COU_LFO1_RATE: { x: 88, y: TOP, size: 'm' },
    COU_LFO1_WAVE: { x: 150, y: TOP },
    COU_LFO1_DEPTH: { x: 88, y: BOT, size: 'm' },
    COU_LFO1_DEST: { x: 150, y: BOT },
    COU_LFO1_SYNC: { x: 78, y: BTN },
    COU_LFO1_KB_RESET: { x: 152, y: BTN },

    // ===== OSCILLATORS — OSC 1 (top row) / OSC 2 (bottom row) ===============
    COU_OSC1_OCTAVE: { x: 236, y: TOP },
    COU_TUNE: { x: 296, y: TOP, size: 'm' },
    COU_SUB_WAVE: { x: 358, y: TOP, size: 'm' },
    COU_OSC1_WAVESHAPE: { x: 421, y: TOP, size: 'm' },

    COU_OSC2_OCTAVE: { x: 236, y: BOT },
    COU_OSC2_FREQ: { x: 296, y: BOT, size: 'm' },
    COU_MOD_AMOUNT: { x: 358, y: BOT, size: 'm' },
    COU_OSC2_WAVESHAPE: { x: 421, y: BOT, size: 'm' },

    COU_SYNC: { x: 256, y: BTN },
    COU_MOD_DEST: { x: 360, y: BTN },

    // ===== MIXER — OSC1/SUB/FB·EXT (top) · OSC2/NOISE/OSC2→CUT (bottom) =====
    COU_MIX_OSC1: { x: 500, y: TOP, size: 'm' },
    COU_MIX_SUB: { x: 564, y: TOP, size: 'm' },
    COU_MIX_FB_EXT: { x: 640, y: TOP, size: 'm' },
    COU_MIX_OSC2: { x: 500, y: BOT, size: 'm' },
    COU_MIX_NOISE: { x: 564, y: BOT, size: 'm' },
    COU_OSC2_CUTOFF: { x: 640, y: BOT, size: 's' },
    COU_KB_TRACKING: { x: 600, y: BTN },

    // ===== FILTER — CUTOFF hero, EG AMOUNT / RESONANCE stacked right ========
    COU_CUTOFF: { x: 716, y: BIG, size: 'l' },
    COU_EG_AMOUNT: { x: 792, y: TOP, size: 'm' },
    COU_RESONANCE: { x: 792, y: BOT, size: 'm' },
    COU_FILTER_MODE: { x: 700, y: BTN },
    COU_RES_BASS: { x: 792, y: BTN },

    // ===== ENVELOPES — FILTER ADSR (top) / AMP ADSR (bottom) ===============
    COU_F_ATTACK: { x: 931, y: TOP, size: 'm' },
    COU_F_DECAY: { x: 995, y: TOP, size: 'm' },
    COU_F_SUSTAIN: { x: 1059, y: TOP, size: 'm' },
    COU_F_RELEASE: { x: 1123, y: TOP, size: 'm' },

    COU_A_ATTACK: { x: 931, y: BOT, size: 'm' },
    COU_A_DECAY: { x: 995, y: BOT, size: 'm' },
    COU_A_SUSTAIN: { x: 1059, y: BOT, size: 'm' },
    COU_A_RELEASE: { x: 1123, y: BOT, size: 'm' },

    COU_MULTI_TRIG: { x: 931, y: BTN },
    COU_F_ENV_VEL: { x: 991, y: BTN },
    COU_F_ENV_LOOP: { x: 1051, y: BTN },
    COU_A_ENV_VEL: { x: 1111, y: BTN },
    COU_A_ENV_LOOP: { x: 1171, y: BTN },

    // ===== OUTPUT ==========================================================
    COU_VOLUME: { x: 1234, y: BIG, size: 'm' },

    // ===== LFO 2 / GLIDE (left-hand performance cluster) ====================
    COU_GLIDE: { x: 90, y: PERF, size: 'm' },
    COU_LFO2_RATE: { x: 162, y: PERF, size: 'm' },
    COU_LFO2_DEST: { x: 120, y: PERF_SW },
  },

  /** Empty — all jacks live in jackFieldLayout.ts. */
  jacks: {},
};
