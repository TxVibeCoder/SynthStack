/**
 * Keybed geometry + note mapping (feature: keyboard + MIDI) — PURE, Web-Audio-free and
 * React-free, Node-testable. Shared by the bridge tests AND the on-screen KeyboardPanel
 * so the white/black layout and the semitone -> MIDI-note mapping are defined ONCE and
 * never duplicated.
 *
 * The on-screen keybed is 2 octaves + a top C = 25 keys. Semitone 0 (the low C) maps to
 * MIDI note 48 (C3) at octaveShift 0, so MIDI note 60 (middle C) sits at semitone 12 —
 * inside the bed at the unshifted octave.
 *
 * DOUBLE-SHIFT RESOLUTION (design-locked): octave lives in EXACTLY ONE place — the
 * BRIDGE, applied on the vv after (note-60)/12. The panel ALWAYS calls keyToNote(semitone,
 * 0) (octave-free raw note 48+semitone); keyToNote keeps its octaveShift parameter purely
 * for unit tests (semitone 12 @ shift 0 -> 60; +1 shift -> +12).
 */

/** Total keys in the on-screen bed: 2 octaves + the top C. */
export const KEYBED_KEYS = 25;

/** MIDI note of semitone 0 (low C) at octaveShift 0 = C3. Middle C (60) is semitone 12. */
export const KEYBED_LOW_C_NOTE_AT_OCTAVE0 = 48;

/** One key in the bed: its semitone offset (0..24 from the low C) and whether it is black. */
export interface KeyShape {
  /** 0..24, semitones above the low C. */
  semitone: number;
  /** true for the 5 sharps per octave (after C, D, F, G, A); false for the 7 naturals. */
  isBlack: boolean;
}

/** Black keys sit after C, D, F, G, A within an octave (semitones 1,3,6,8,10); none after E or B. */
const BLACK_SEMITONES_IN_OCTAVE = new Set([1, 3, 6, 8, 10]);

/** Fixed 25-entry white/black layout (semitone 0..24, blacks after C/D/F/G/A only). */
export const KEYBED_SHAPE: KeyShape[] = Array.from({ length: KEYBED_KEYS }, (_, semitone) => ({
  semitone,
  isBlack: BLACK_SEMITONES_IN_OCTAVE.has(semitone % 12),
}));

/**
 * Map a key's semitone offset (0..24) + an octave shift to a raw MIDI note number:
 *   48 + 12·octaveShift + semitoneOffset
 * The panel passes octaveShift = 0 (octave-free); the bridge adds keyboardOctave on the
 * vv side. The octaveShift parameter is retained for unit tests.
 */
export function keyToNote(semitoneOffset: number, octaveShift: number): number {
  return KEYBED_LOW_C_NOTE_AT_OCTAVE0 + 12 * octaveShift + semitoneOffset;
}
