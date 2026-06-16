/**
 * Pure key-navigation logic for the Monarch step editor — no React, no DOM, no
 * engine imports (unit-tested in Node; see test/unit/monarchKeyNav.test.ts).
 *
 * Owns the three concerns the arrow-key note-editing feature names — key (+ Shift)
 * -> action mapping, semitone clamp, and next-selected/next-page — as plain numbers
 * plus a small discriminated union. The React shell (MonarchStepEditor.tsx) does ZERO
 * arithmetic of its own: it wires this helper + focus + preventDefault.
 *
 * Mapping (design-locked): ArrowUp/Down = +/-1 semitone (Shift = one octave),
 * ArrowLeft/Right = move the selected step -/+1 (Shift ignored), the page auto-flips
 * to floor(selected / 8) so the selected cell stays visible.
 */

/**
 * Mirrors of MonarchStepEditor.tsx NOTE_DEF.min / NOTE_DEF.max (lines 49-52). Importing
 * NOTE_DEF here would couple this pure module to the React component and break its
 * Node tests, so the rails are duplicated. Change together with NOTE_DEF or not at
 * all (same precedent as dragMath.ts mirroring theme.ts constants).
 */
export const NOTE_MIN_SEMI = -24; // = NOTE_DEF.min
export const NOTE_MAX_SEMI = 24; // = NOTE_DEF.max
export const STEP_MIN = 0;
export const STEP_MAX = 31; // 32 steps, 0..31
export const PAGE_SIZE = 8; // 8 cells/page, 4 pages
export const OCTAVE_SEMIS = 12; // Shift = one octave

/**
 * The two things an arrow key can do. `null` (returned by keyToMonarchAction) means the
 * key is unhandled, so the component returns WITHOUT preventDefault — non-arrow keys
 * like Tab still do their native thing.
 */
export type MonarchKeyAction =
  | { kind: 'note'; delta: number } // change selected step note by delta SEMITONES
  | { kind: 'select'; delta: number }; // move selected step by delta (-1 / +1)

/**
 * Key string + Shift -> action. Total and deterministic: any non-arrow key -> null.
 * Left/Right ignore Shift by design (the spec assigns Shift meaning only to the
 * Up/Down octave jump). `default: return null` is the noFallthroughCasesInSwitch-safe
 * exit (tsconfig has noFallthroughCasesInSwitch: true).
 */
export function keyToMonarchAction(key: string, shift: boolean): MonarchKeyAction | null {
  switch (key) {
    case 'ArrowUp':
      return { kind: 'note', delta: shift ? OCTAVE_SEMIS : 1 };
    case 'ArrowDown':
      return { kind: 'note', delta: shift ? -OCTAVE_SEMIS : -1 };
    case 'ArrowLeft':
      return { kind: 'select', delta: -1 };
    case 'ArrowRight':
      return { kind: 'select', delta: 1 };
    default:
      return null;
  }
}

/** Clamp a note (semitones) to the NOTE_DEF range [-24, 24]. Idempotent at/over the rails. */
export function clampSemis(semis: number): number {
  return Math.min(NOTE_MAX_SEMI, Math.max(NOTE_MIN_SEMI, semis));
}

/**
 * Apply a delta to the current note (semitones) and clamp. The component commits
 * editStep({ noteVv: nextNoteSemis(...) / 12 }) — byte-identical to onNote's
 * Math.round(v) / 12 contract (MonarchStepEditor.tsx line 159).
 */
export function nextNoteSemis(currentSemis: number, delta: number): number {
  return clampSemis(currentSemis + delta);
}

/** Clamp a step index to [0, 31] (no wrap). */
export function clampStep(index: number): number {
  return Math.min(STEP_MAX, Math.max(STEP_MIN, index));
}

/** The visible page (0..3) holding a given selected step (0..31). */
export function pageOf(selected: number): number {
  return Math.floor(selected / PAGE_SIZE);
}

/**
 * Move the selection by delta (clamped to [0, 31]) and derive the page that keeps
 * the selected cell visible. page is always === Math.floor(selected / 8).
 */
export function nextSelection(selected: number, delta: number): { selected: number; page: number } {
  const next = clampStep(selected + delta);
  return { selected: next, page: pageOf(next) };
}
