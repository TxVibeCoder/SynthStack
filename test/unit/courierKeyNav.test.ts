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
  keyToCourierAction,
  nextNoteSemis,
  nextSelection,
  pageOf,
} from '../../src/ui/sequencer/courierKeyNav';

describe('keyToCourierAction mapping', () => {
  it('ArrowUp/Down (no shift) = note +/-1 semitone', () => {
    expect(keyToCourierAction('ArrowUp', false)).toEqual({ kind: 'note', delta: 1 });
    expect(keyToCourierAction('ArrowDown', false)).toEqual({ kind: 'note', delta: -1 });
  });

  it('Shift+ArrowUp/Down = note +/- one octave (12 semitones)', () => {
    expect(keyToCourierAction('ArrowUp', true)).toEqual({ kind: 'note', delta: OCTAVE_SEMIS });
    expect(keyToCourierAction('ArrowDown', true)).toEqual({ kind: 'note', delta: -OCTAVE_SEMIS });
    expect(OCTAVE_SEMIS).toBe(12);
  });

  it('ArrowLeft/Right = select -1/+1', () => {
    expect(keyToCourierAction('ArrowLeft', false)).toEqual({ kind: 'select', delta: -1 });
    expect(keyToCourierAction('ArrowRight', false)).toEqual({ kind: 'select', delta: 1 });
  });

  it('Shift is IGNORED on Left/Right (spec assigns Shift only to Up/Down octave)', () => {
    expect(keyToCourierAction('ArrowLeft', true)).toEqual({ kind: 'select', delta: -1 });
    expect(keyToCourierAction('ArrowRight', true)).toEqual({ kind: 'select', delta: 1 });
  });

  it('any non-arrow key -> null (total, so Tab etc. fall through untouched)', () => {
    for (const key of ['a', 'Enter', ' ', 'Tab', 'Home', 'End', 'ArrowUpUp', '']) {
      expect(keyToCourierAction(key, false)).toBeNull();
      expect(keyToCourierAction(key, true)).toBeNull();
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

describe('nextSelection bounds + page (64 steps / 4 pages of 16)', () => {
  it('does not wrap past either end', () => {
    expect(nextSelection(0, -1)).toEqual({ selected: 0, page: 0 });
    expect(nextSelection(63, 1)).toEqual({ selected: 63, page: 3 });
  });

  it('flips the page so the selected cell stays visible (page boundaries at 16/32/48)', () => {
    expect(nextSelection(15, 1)).toEqual({ selected: 16, page: 1 });
    expect(nextSelection(16, -1)).toEqual({ selected: 15, page: 0 });
    expect(nextSelection(31, 1)).toEqual({ selected: 32, page: 2 });
    expect(nextSelection(47, 1)).toEqual({ selected: 48, page: 3 });
  });

  it('invariant for every step 0..63: page === Math.floor(selected / 16)', () => {
    for (let i = STEP_MIN; i <= STEP_MAX; i++) {
      const { selected, page } = nextSelection(i, 0);
      expect(selected).toBe(i);
      expect(page).toBe(Math.floor(i / PAGE_SIZE));
      expect(pageOf(i)).toBe(page);
      expect(clampStep(i)).toBe(i);
    }
  });

  it('STEP_MAX is 63 and PAGE_SIZE is 16 (4 pages x 16)', () => {
    expect(STEP_MAX).toBe(63);
    expect(PAGE_SIZE).toBe(16);
  });
});
