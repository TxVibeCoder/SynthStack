import { describe, expect, it } from 'vitest';
import {
  NOTE_MAX_SEMI,
  NOTE_MIN_SEMI,
  OCTAVE_SEMIS,
  PAGE_SIZE,
  STEP_MAX,
  STEP_MIN,
  clampSemis,
  clampStep,
  keyToMonarchAction,
  nextNoteSemis,
  nextSelection,
  pageOf,
} from '../../src/ui/sequencer/monarchKeyNav';

describe('keyToMonarchAction mapping', () => {
  it('ArrowUp/Down (no shift) = note +/-1 semitone', () => {
    expect(keyToMonarchAction('ArrowUp', false)).toEqual({ kind: 'note', delta: 1 });
    expect(keyToMonarchAction('ArrowDown', false)).toEqual({ kind: 'note', delta: -1 });
  });

  it('Shift+ArrowUp/Down = note +/- one octave (12 semitones)', () => {
    expect(keyToMonarchAction('ArrowUp', true)).toEqual({ kind: 'note', delta: OCTAVE_SEMIS });
    expect(keyToMonarchAction('ArrowDown', true)).toEqual({ kind: 'note', delta: -OCTAVE_SEMIS });
    expect(OCTAVE_SEMIS).toBe(12);
  });

  it('ArrowLeft/Right = select -1/+1', () => {
    expect(keyToMonarchAction('ArrowLeft', false)).toEqual({ kind: 'select', delta: -1 });
    expect(keyToMonarchAction('ArrowRight', false)).toEqual({ kind: 'select', delta: 1 });
  });

  it('Shift is IGNORED on Left/Right (spec assigns Shift only to Up/Down octave)', () => {
    expect(keyToMonarchAction('ArrowLeft', true)).toEqual({ kind: 'select', delta: -1 });
    expect(keyToMonarchAction('ArrowRight', true)).toEqual({ kind: 'select', delta: 1 });
  });

  it('any non-arrow key -> null (total, so Tab etc. fall through untouched)', () => {
    for (const key of ['a', 'Enter', ' ', 'Tab', 'Home', 'End', 'ArrowUpUp', '']) {
      expect(keyToMonarchAction(key, false)).toBeNull();
      expect(keyToMonarchAction(key, true)).toBeNull();
    }
  });
});

describe('clampSemis / nextNoteSemis', () => {
  it('clamps to the NOTE_DEF range [-24, 24]', () => {
    expect(clampSemis(NOTE_MIN_SEMI)).toBe(-24);
    expect(clampSemis(NOTE_MAX_SEMI)).toBe(24);
    expect(clampSemis(0)).toBe(0);
    expect(clampSemis(7)).toBe(7);
  });

  it('is idempotent at and over the rails', () => {
    expect(clampSemis(-25)).toBe(-24);
    expect(clampSemis(99)).toBe(24);
    expect(clampSemis(clampSemis(99))).toBe(24);
    expect(clampSemis(clampSemis(-25))).toBe(-24);
  });

  it('nextNoteSemis applies a delta then clamps (octave jump never overshoots)', () => {
    expect(nextNoteSemis(20, 12)).toBe(24); // not 32
    expect(nextNoteSemis(-20, -12)).toBe(-24); // not -32
    expect(nextNoteSemis(0, 1)).toBe(1);
    expect(nextNoteSemis(-24, -1)).toBe(-24);
    expect(nextNoteSemis(24, 1)).toBe(24);
  });
});

describe('nextSelection bounds + page', () => {
  it('does not wrap past either end', () => {
    expect(nextSelection(0, -1)).toEqual({ selected: 0, page: 0 });
    expect(nextSelection(31, 1)).toEqual({ selected: 31, page: 3 });
  });

  it('flips the page so the selected cell stays visible', () => {
    expect(nextSelection(7, 1)).toEqual({ selected: 8, page: 1 });
    expect(nextSelection(8, -1)).toEqual({ selected: 7, page: 0 });
    expect(nextSelection(15, 1)).toEqual({ selected: 16, page: 2 });
    expect(nextSelection(23, 1)).toEqual({ selected: 24, page: 3 });
  });

  it('invariant for every step 0..31: page === Math.floor(selected / 8)', () => {
    for (let i = STEP_MIN; i <= STEP_MAX; i++) {
      const { selected, page } = nextSelection(i, 0);
      expect(selected).toBe(i);
      expect(page).toBe(Math.floor(i / PAGE_SIZE));
      expect(pageOf(i)).toBe(page);
      expect(clampStep(i)).toBe(i);
    }
  });
});
