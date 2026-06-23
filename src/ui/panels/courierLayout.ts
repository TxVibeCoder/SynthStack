/**
 * Courier panel layout — a faithful full-face replica of the source unit's COMPUTER-EDITOR
 * control surface (the on-screen preset editor, which is itself the hardware face laid out for
 * a screen). Mirrors the editor's arrangement band-for-band, in SynthStack's OWN styling (dark
 * panel / cream legend / gold knobs / burnt-orange Courier accent) — NO logos, wordmarks, gray
 * trade-dress, or brand color scheme. Generic functional labels only.
 *
 * Bands, top → bottom (canvas coords; the editor's Y is shifted up EY=72 so the face starts near
 * the top with no app-chrome gap):
 *   1. IO label strip (silkscreen jack legend)
 *   2. CONTROL BAND — LFO 1 · OSCILLATORS · MIXER · FILTER · ENVELOPES · OUTPUT
 *      (two knob rows + a hero CUTOFF/VOLUME centre line + a switch/lamp-button row)
 *   3. SEQUENCER BAND — TEMPO + transport, CLOCK DIV/ARP/OCTAVE selectors, the 16-step lamp
 *      row, SWING + GATE LENGTH
 *   4. PERFORMANCE cluster (lower-left) — KB OCTAVE/HOLD, GLIDE, LFO 2 RATE, LFO 2 DESTINATION
 *   5. PRESET SETTINGS + MOD ASSIGN (faithful VISUAL placeholders — accounted for in the layout
 *      per the replica brief; Courier's real mod system is the long-press gesture, not a matrix)
 *   6. Wordmark ("COURIER", replacing the brand mark) + pitch/mod WHEELS (visual) + patch button
 *      row (visual)
 *   7. KEYBED — 32 keys (low C..G), playable for the Courier voice
 *
 * Geometry measured from the reference editor capture (1404×838) via PIL blob detection (knob
 * centres) + gridded crops (switches/buttons/labels); keybed key count from the reference photo.
 * Coordinates locate control CENTRES; sections give a top-left corner.
 *
 * Spacing invariant (test/unit/courierLayout.test.ts): knob centres ≥ 44 units apart, every
 * control centre ≥ 16 apart, all inside the viewBox.
 *
 * .ts extension: scripts/export-geometry.ts loads this layout straight in Node.
 */
import type { PanelLayout, KnobSize } from '../types.ts';

/** Landscape canvas — the panel's own viewBox (App.tsx frames the tab to this). */
export const COURIER_W = 1360;
export const COURIER_H = 690;

/** Editor→canvas vertical shift (the editor reserves y0..~90 for app chrome we drop). */
// (applied already in the literal Y values below; documented for re-measurement)

// Row baselines (canvas Y; = editor Y − 72).
const IO = 16; // IO label strip (kept clear of the section-frame labels at y≈41)
const SEC = 33; // section-frame top (label sits in the top-border gap at y≈41)
const TOP = 112; // upper knob / switch row
const HERO = 144; // hero-knob centre (CUTOFF, VOLUME)
const BOT = 176; // lower knob / switch row
const BTN = 243; // control-band switch / lamp-button row
const STEP = 315; // 16-step sequencer lamp row
const SWG = 305; // TEMPO / SWING / GATE LENGTH knobs (one row)
const SEQ_DD = 368; // CLOCK DIV / ARP PATTERN / ARP OCTAVE selectors
const DIRPG = 348; // DIRECTION / PAGE
const TEMPO_Y = 305; // TEMPO knob
const SEQARP = 286; // SEQ / ARP mode selector
const GL = 418; // GLIDE / LFO 2 RATE
const L2D = 467; // LFO 2 DESTINATION (PITCH/CUTOFF/AMP lamps)

export const courierLayout: PanelLayout = {
  width: COURIER_W,
  height: COURIER_H,
  title: 'Courier',

  // Silkscreen section frames (rounded rect + label in a gap in the top border).
  sections: [
    { label: 'LFO 1', x: 88, y: SEC, w: 106, h: 244 },
    { label: 'OSCILLATORS', x: 196, y: SEC, w: 314, h: 244 },
    { label: 'MIXER', x: 520, y: SEC, w: 200, h: 244 },
    { label: 'FILTER', x: 728, y: SEC, w: 160, h: 244 },
    { label: 'ENVELOPES', x: 898, y: SEC, w: 330, h: 244 },
    { label: 'OUTPUT', x: 1234, y: SEC, w: 92, h: 244 },
  ],

  controls: {
    // ===== LFO 1 ============================================================
    COU_LFO1_RATE: { x: 139, y: TOP, size: 'm' },
    COU_LFO1_WAVE: { x: 184, y: TOP },
    COU_LFO1_DEPTH: { x: 139, y: BOT, size: 'm' },
    COU_LFO1_DEST: { x: 184, y: BOT },
    COU_LFO1_SYNC: { x: 139, y: BTN },
    COU_LFO1_KB_RESET: { x: 203, y: BTN },

    // ===== OSCILLATORS — OSC 1 (top row) / OSC 2 (bottom row) ===============
    COU_OSC1_OCTAVE: { x: 230, y: TOP },
    COU_TUNE: { x: 347, y: TOP, size: 'm' },
    COU_SUB_WAVE: { x: 411, y: TOP, size: 'm' },
    COU_OSC1_WAVESHAPE: { x: 475, y: TOP, size: 'm' },

    COU_OSC2_OCTAVE: { x: 230, y: BOT },
    COU_OSC2_FREQ: { x: 347, y: BOT, size: 'm' },
    COU_MOD_AMOUNT: { x: 411, y: BOT, size: 'm' },
    COU_OSC2_WAVESHAPE: { x: 475, y: BOT, size: 'm' },

    COU_SYNC: { x: 318, y: BTN },
    COU_MOD_DEST: { x: 415, y: BTN },

    // ===== MIXER — OSC1/SUB/FB·EXT (top) · OSC2/NOISE/OSC2→CUT (bottom) =====
    COU_MIX_OSC1: { x: 553, y: TOP, size: 'm' },
    COU_MIX_SUB: { x: 617, y: TOP, size: 'm' },
    COU_MIX_FB_EXT: { x: 695, y: TOP, size: 'm' },
    COU_MIX_OSC2: { x: 553, y: BOT, size: 'm' },
    COU_MIX_NOISE: { x: 617, y: BOT, size: 'm' },
    COU_OSC2_CUTOFF: { x: 695, y: BOT, size: 's' },
    COU_KB_TRACKING: { x: 596, y: BTN },

    // ===== FILTER — CUTOFF hero, EG AMOUNT / RESONANCE stacked right ========
    COU_CUTOFF: { x: 770, y: HERO, size: 'l' },
    COU_EG_AMOUNT: { x: 846, y: TOP, size: 'm' },
    COU_RESONANCE: { x: 847, y: BOT, size: 'm' },
    COU_FILTER_MODE: { x: 770, y: BTN },
    COU_RES_BASS: { x: 847, y: BTN },

    // ===== ENVELOPES — FILTER ADSR (top) / AMP ADSR (bottom) ===============
    COU_F_ATTACK: { x: 990, y: TOP, size: 'm' },
    COU_F_DECAY: { x: 1054, y: TOP, size: 'm' },
    COU_F_SUSTAIN: { x: 1120, y: TOP, size: 'm' },
    COU_F_RELEASE: { x: 1185, y: TOP, size: 'm' },

    COU_A_ATTACK: { x: 990, y: BOT, size: 'm' },
    COU_A_DECAY: { x: 1054, y: BOT, size: 'm' },
    COU_A_SUSTAIN: { x: 1120, y: BOT, size: 'm' },
    COU_A_RELEASE: { x: 1185, y: BOT, size: 'm' },

    COU_MULTI_TRIG: { x: 925, y: BTN },
    COU_F_ENV_VEL: { x: 990, y: BTN },
    COU_F_ENV_LOOP: { x: 1055, y: BTN },
    COU_A_ENV_VEL: { x: 1120, y: BTN },
    COU_A_ENV_LOOP: { x: 1185, y: BTN },

    // ===== OUTPUT ==========================================================
    COU_VOLUME: { x: 1262, y: HERO, size: 'm' },

    // ===== SEQUENCER BAND (real controls surfaced from the seq settings) ====
    COU_TEMPO: { x: 138, y: TEMPO_Y, size: 'm' },
    COU_SEQ_MODE: { x: 215, y: SEQARP }, // SEQ / ARP
    COU_CLOCK_DIV: { x: 320, y: SEQ_DD },
    COU_ARP_MODE: { x: 432, y: SEQ_DD },
    COU_ARP_OCTAVE: { x: 525, y: SEQ_DD },
    COU_SWING: { x: 1184, y: SWG, size: 'm' },
    COU_GATE_LENGTH: { x: 1263, y: SWG, size: 'm' },

    // ===== PERFORMANCE cluster (lower-left) =================================
    COU_GLIDE: { x: 158, y: GL, size: 'm' },
    COU_LFO2_RATE: { x: 237, y: GL, size: 'm' },
    COU_LFO2_DEST: { x: 237, y: L2D }, // PITCH / CUTOFF / AMP lamp selector
  },

  /** Empty — all jacks live in jackFieldLayout.ts (the patchbay tab). */
  jacks: {},
};

// ===========================================================================
// Replica chrome (visual) — silkscreen, placeholders, wheels, steps, keybed.
// These are NOT engine controls; they make the face read as an exact replica.
// ===========================================================================

/** Control ids rendered as illuminated square LAMP buttons (the editor's OFF/ON toggles). */
export const COURIER_LAMP_BUTTONS = new Set<string>([
  'COU_LFO1_SYNC',
  'COU_LFO1_KB_RESET',
  'COU_SYNC',
  'COU_KB_TRACKING',
  'COU_RES_BASS',
  'COU_MULTI_TRIG',
  'COU_F_ENV_VEL',
  'COU_F_ENV_LOOP',
  'COU_A_ENV_VEL',
  'COU_A_ENV_LOOP',
]);

/** Multi-position switches rendered as the editor's compact caption-list SELECTOR. */
export const COURIER_SELECTORS = new Set<string>([
  'COU_LFO1_WAVE',
  'COU_LFO1_DEST',
  'COU_OSC1_OCTAVE',
  'COU_OSC2_OCTAVE',
  'COU_MOD_DEST',
  'COU_FILTER_MODE',
]);

/** Seq selectors rendered as faithful dropdown boxes. */
export const COURIER_DROPDOWNS = new Set<string>(['COU_CLOCK_DIV', 'COU_ARP_MODE', 'COU_ARP_OCTAVE']);

/** Top IO legend (jack names) — evenly spread silkscreen, purely cosmetic. */
export const COURIER_IO_LABELS: { x: number; text: string }[] = [
  { x: 300, text: 'POWER' },
  { x: 372, text: 'USB' },
  { x: 432, text: 'MIDI OUT' },
  { x: 512, text: 'MIDI IN' },
  { x: 584, text: 'GATE OUT' },
  { x: 660, text: 'CV OUT' },
  { x: 726, text: 'GATE IN' },
  { x: 786, text: 'CV IN' },
  { x: 852, text: 'CLOCK OUT' },
  { x: 936, text: 'CLOCK IN' },
  { x: 1024, text: 'EXPR' },
  { x: 1086, text: 'SUSTAIN' },
  { x: 1156, text: 'EXT IN' },
  { x: 1226, text: 'PHONES' },
  { x: 1300, text: 'AUDIO OUT' },
];
export const COURIER_IO_Y = IO;

/** Static silkscreen text (sub-captions, row labels, numerals, wordmark). */
export interface SilkText {
  x: number;
  y: number;
  text: string;
  size?: number;
  dim?: boolean;
  anchor?: 'start' | 'middle' | 'end';
  spacing?: number;
  bold?: boolean;
}
export const COURIER_SILK: SilkText[] = [
  // OSC big numerals
  { x: 256, y: TOP + 6, text: '1', size: 20, bold: true, anchor: 'middle' },
  { x: 256, y: BOT + 6, text: '2', size: 20, bold: true, anchor: 'middle' },
  // ENVELOPES row labels (left of the ADSR knobs)
  { x: 906, y: TOP - 5, text: 'FILTER', size: 8, dim: true, anchor: 'start' },
  { x: 906, y: TOP + 5, text: 'ENVELOPE', size: 8, dim: true, anchor: 'start' },
  { x: 906, y: BOT - 5, text: 'AMPLIFIER', size: 8, dim: true, anchor: 'start' },
  { x: 906, y: BOT + 5, text: 'ENVELOPE', size: 8, dim: true, anchor: 'start' },
  // sub-captions
  { x: 415, y: BTN + 30, text: 'MOD DESTINATION', size: 8, dim: true, anchor: 'middle' },
  { x: 770, y: BTN + 30, text: 'MODE', size: 8, dim: true, anchor: 'middle' },
  // TEMPO caption (below the knob's own label)
  { x: 138, y: TEMPO_Y + 47, text: '(SETTINGS VALUE)', size: 7.5, dim: true, anchor: 'middle' },
  // seq band header
  { x: 770, y: STEP - 22, text: 'STEP MUTE', size: 8, dim: true, anchor: 'middle' },
  // LFO 2 destination caption (below the PITCH/CUTOFF/AMP lamp labels)
  { x: 237, y: L2D + 38, text: 'DESTINATION', size: 7.5, dim: true, anchor: 'middle' },
  // section headers for the placeholder blocks
  { x: 430, y: 400, text: 'PRESET SETTINGS', size: 11, anchor: 'middle', spacing: 1.5 },
  { x: 1010, y: 400, text: 'MOD ASSIGN', size: 11, anchor: 'middle', spacing: 1.5 },
  // wordmark (replaces the brand mark) — our identity, plain type; sits above the keybed
  { x: 300, y: 614, text: 'COURIER', size: 26, bold: true, anchor: 'start', spacing: 4 },
  // wheel labels
  { x: 125, y: 634, text: 'PITCH', size: 9, dim: true, anchor: 'middle' },
  { x: 210, y: 634, text: 'MOD', size: 9, dim: true, anchor: 'middle' },
];

/** Bracket / divider lines (e.g. the LFO 2 DESTINATION bracket under PITCH/CUTOFF/AMP). */
export interface SilkLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export const COURIER_LINES: SilkLine[] = [
  // band divider under the control band
  { x1: 30, y1: 292, x2: 1330, y2: 292 },
  // bracket grouping the LFO 2 destination lamps
  { x1: 168, y1: L2D + 14, x2: 168, y2: L2D + 8 },
  { x1: 168, y1: L2D + 8, x2: 306, y2: L2D + 8 },
  { x1: 306, y1: L2D + 8, x2: 306, y2: L2D + 14 },
];

/** Faithful inert placeholder controls (accounted for in the layout; no engine wiring). */
export interface DecorKnob {
  x: number;
  y: number;
  label: string;
  size?: KnobSize;
}
export interface DecorButton {
  x: number;
  y: number;
  w?: number;
  h?: number;
  label?: string;
  lit?: boolean;
}
export interface DecorDropdown {
  x: number;
  y: number;
  w: number;
  label: string;
  value: string;
}
export interface DecorToggle {
  x: number;
  y: number;
  label: string;
  positions: string[];
  idx?: number;
}

const PR = 428; // preset settings row 1
const PR2 = 466; // row 2
const PR3 = 502; // row 3
const MR = 448; // mod-assign row 1 (knobs)
const MR2 = 514; // mod-assign row 2 (knobs)

export const COURIER_DECOR_KNOBS: DecorKnob[] = [
  { x: 499, y: 447, label: 'LFO FADE', size: 's' },
  // MOD ASSIGN amount knobs (small) — each paired with a destination dropdown above it
  { x: 758, y: MR, label: 'LFO 1 AMT', size: 's' },
  { x: 872, y: MR, label: 'KB AMT', size: 's' },
  { x: 986, y: MR, label: 'F ENV AMT', size: 's' },
  { x: 1099, y: MR, label: 'A ENV AMT', size: 's' },
  { x: 1212, y: MR, label: 'MOD WHL', size: 's' },
  { x: 758, y: MR2, label: 'KB S+H', size: 's' },
  { x: 872, y: MR2, label: 'VEL AMT', size: 's' },
  { x: 986, y: MR2, label: 'AFTCH', size: 's' },
  { x: 1099, y: MR2, label: 'EXPR AMT', size: 's' },
];

export const COURIER_DECOR_BUTTONS: DecorButton[] = [
  // PRESET SETTINGS buttons
  { x: 345, y: PR, label: 'DUOPHONIC' },
  { x: 432, y: PR, label: 'LEGATO GL' },
  { x: 432, y: PR2, label: 'GATED GL' },
  { x: 585, y: PR, label: 'F ENV RST' },
  { x: 585, y: PR2, label: 'A ENV RST' },
  { x: 605, y: PR3, label: 'A EG ADD' },
  { x: 660, y: PR, label: 'ARP SKIP' },
  { x: 660, y: PR3, label: 'SEQ PLAY' },
  // DIRECTION / PAGE (seq band, left of the step row)
  { x: 318, y: DIRPG, w: 30, h: 14, label: 'DIR' },
  { x: 378, y: DIRPG, w: 30, h: 14, label: 'PAGE' },
];

export const COURIER_DECOR_DROPDOWNS: DecorDropdown[] = [
  { x: 345, y: PR2, w: 70, label: 'PB UP', value: '+7 st' },
  { x: 345, y: PR3, w: 70, label: 'PB DN', value: '-7 st' },
  // MOD ASSIGN destination dropdowns — to the RIGHT of each amount knob (knob_x + 60), same row.
  { x: 818, y: MR, w: 54, label: 'DEST', value: 'None' },
  { x: 932, y: MR, w: 54, label: 'DEST', value: 'None' },
  { x: 1046, y: MR, w: 54, label: 'DEST', value: 'None' },
  { x: 1159, y: MR, w: 54, label: 'DEST', value: 'None' },
  { x: 1272, y: MR, w: 54, label: 'DEST', value: 'None' },
  { x: 818, y: MR2, w: 54, label: 'DEST', value: 'OSC2' },
  { x: 932, y: MR2, w: 54, label: 'DEST', value: 'WAVE' },
  { x: 1046, y: MR2, w: 54, label: 'DEST', value: 'LFO1' },
  { x: 1159, y: MR2, w: 54, label: 'DEST', value: 'CUT' },
];

export const COURIER_DECOR_TOGGLES: DecorToggle[] = [
  { x: 466, y: PR3, label: 'GLIDE TYPE', positions: ['EXP', 'LCT', 'LOG'] },
  { x: 540, y: PR3, label: 'LFO RANGE', positions: ['LO', 'MID', 'HI'] },
];

/** Pitch / mod thumb-wheels (visual only). */
export interface Wheel {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: 'pitch' | 'mod';
}
export const COURIER_WHEELS: Wheel[] = [
  { x: 125, y: 588, w: 40, h: 78, kind: 'pitch' },
  { x: 210, y: 588, w: 40, h: 78, kind: 'mod' },
];

/** Bottom patch-button row — omitted (ambiguous preset-bank chrome; the keybed fills the base). */
export const COURIER_PATCH_BTN_Y = 558;
export const COURIER_PATCH_BTNS: number[] = [];

/** 16-step sequencer lamp row positions (canvas X; Y = STEP). */
export const COURIER_SEQ_STEPS: number[] = Array.from({ length: 16 }, (_, i) => 434 + i * 44.8);
export const COURIER_SEQ_STEP_Y = STEP;

// ===========================================================================
// KEYBED — 32 keys (low C..G), 19 white + 13 black, rendered as the editor's
// BUTTON keyboard: a lower row of light white-key buttons + an upper row of dark
// black-key buttons (piano 2-3 grouping). Playable for the Courier voice.
// ===========================================================================

export const COURIER_KEYBED_KEYS = 32;
const KEYBED_X0 = 298; // left edge (first white centre sits half a pitch in)
const KEYBED_X1 = 1318; // right edge
const WHITE_ROW_Y = 662; // white-key button centres (lower row)
const BLACK_ROW_Y = 635; // black-key button centres (upper row)
const KEY_BTN_H = 18;
export const COURIER_KEYBED = { x0: KEYBED_X0, x1: KEYBED_X1, whiteRowY: WHITE_ROW_Y, blackRowY: BLACK_ROW_Y, btnH: KEY_BTN_H };

/** Black semitones within an octave (after C, D, F, G, A). */
const BLACK_IN_OCT = new Set([1, 3, 6, 8, 10]);

export interface CourierKey {
  semitone: number;
  isBlack: boolean;
  /** Button CENTRE. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Build the 32 key-buttons: whites tile the lower row; blacks centre on white boundaries above. */
function buildKeybed(): CourierKey[] {
  const shape = Array.from({ length: COURIER_KEYBED_KEYS }, (_, s) => ({
    semitone: s,
    isBlack: BLACK_IN_OCT.has(s % 12),
  }));
  const whiteCount = shape.filter((k) => !k.isBlack).length; // 19
  const whiteW = (KEYBED_X1 - KEYBED_X0) / whiteCount;
  const whiteBtnW = whiteW - 5; // gap between adjacent white buttons
  const blackBtnW = whiteW * 0.74;
  const out: CourierKey[] = [];
  let whiteSeen = 0;
  for (const k of shape) {
    if (!k.isBlack) {
      out.push({ ...k, x: KEYBED_X0 + whiteSeen * whiteW + whiteW / 2, y: WHITE_ROW_Y, w: whiteBtnW, h: KEY_BTN_H });
      whiteSeen += 1;
    } else {
      // boundary = left edge of the next white = midpoint between the flanking white centres
      const boundary = KEYBED_X0 + whiteSeen * whiteW;
      out.push({ ...k, x: boundary, y: BLACK_ROW_Y, w: blackBtnW, h: KEY_BTN_H });
    }
  }
  return out;
}

export const COURIER_KEYS: readonly CourierKey[] = buildKeybed();
export const COURIER_WHITE_KEYS = COURIER_KEYS.filter((k) => !k.isBlack);
export const COURIER_BLACK_KEYS = COURIER_KEYS.filter((k) => k.isBlack);
