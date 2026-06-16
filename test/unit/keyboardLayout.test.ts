/**
 * Layout invariants for the on-screen keyboard keybed (g4-ui-keyboard). The key
 * geometry is INDEXED (KEYS, derived from the engine's KEYBED_SHAPE), so these
 * checks mirror the per-panel layout tests in spirit: 25 keys (15 white + 10
 * black), blacks only after C/D/F/G/A (never after E/B), white keys tile the
 * keybed width without overlap, blacks centred on white boundaries and within
 * bounds, and every key rect inside the futureStrip viewBox (0..1805.19 /
 * 0..141.14). It asserts the panel CONSUMES KEYBED_SHAPE correctly — it never
 * re-authors the white/black pattern.
 */

import { describe, expect, it } from 'vitest';
import {
  KB_W,
  KB_H,
  KEYS,
  WHITE_KEYS,
  BLACK_KEYS,
  WHITE_W,
  BLACK_W,
  KEYBED_X0,
  KEYBED_X1,
  KEYBED_Y0,
  keyAtPoint,
  type KeyRect,
} from '../../src/ui/keyboard/keyboardLayout';
import { KEYBED_KEYS, KEYBED_SHAPE, keyToNote } from '../../src/engine/voice/keyMap';
import { REGIONS } from '../../src/ui/stage16x9';

/** Whites in their natural left-to-right order (the order the panel paints them). */
const whitesByX = [...WHITE_KEYS].sort((a, b) => a.x - b.x);

describe('keyboardLayout', () => {
  it('the panel viewBox is exactly the futureStrip band', () => {
    expect(KB_W).toBe(REGIONS.futureStrip.w);
    expect(KB_H).toBe(REGIONS.futureStrip.h);
  });

  it('places exactly 25 keys, 15 white + 10 black', () => {
    expect(KEYS).toHaveLength(KEYBED_KEYS);
    expect(KEYS).toHaveLength(25);
    expect(WHITE_KEYS).toHaveLength(15);
    expect(BLACK_KEYS).toHaveLength(10);
  });

  it('its key set is exactly KEYBED_SHAPE consumed in order (no re-authored pattern)', () => {
    // Each placed key carries its source shape's semitone + isBlack — and nothing
    // is invented or dropped relative to the engine shape.
    expect(KEYS.map((k) => k.i)).toEqual(KEYBED_SHAPE.map((_s, i) => i));
    for (let i = 0; i < KEYBED_SHAPE.length; i++) {
      const shape = KEYBED_SHAPE[i]!;
      const placed = KEYS.find((k) => k.i === i)!;
      expect(placed.semitone, `key ${i} semitone`).toBe(shape.semitone);
      expect(placed.isBlack, `key ${i} isBlack`).toBe(shape.isBlack);
    }
  });

  it('puts blacks only after C/D/F/G/A and never after E/B', () => {
    // Within an octave (semitone % 12) the black keys are 1,3,6,8,10 (C#,D#,F#,G#,A#)
    // and the white-only gaps (no black above) are 4->5 (E->F) and 11->0 (B->C).
    const BLACK_PCS = new Set([1, 3, 6, 8, 10]);
    for (const k of KEYS) {
      const pc = k.semitone % 12;
      expect(k.isBlack, `semitone ${k.semitone} (pc ${pc}) colour`).toBe(BLACK_PCS.has(pc));
    }
    // Explicitly: no black sits directly above E (pc 4) or B (pc 11).
    for (const k of BLACK_KEYS) {
      const pc = k.semitone % 12;
      expect(pc, 'a black landed on E').not.toBe(4);
      expect(pc, 'a black landed on B').not.toBe(11);
    }
  });

  it('tiles the white keys edge-to-edge across the keybed without overlap or gap', () => {
    expect(whitesByX[0]!.x).toBeCloseTo(KEYBED_X0, 6);
    for (let i = 0; i < whitesByX.length; i++) {
      const w = whitesByX[i]!;
      expect(w.w).toBeCloseTo(WHITE_W, 6);
      // each white starts exactly where the previous ended (no overlap / no gap)
      expect(w.x).toBeCloseTo(KEYBED_X0 + i * WHITE_W, 6);
    }
    const last = whitesByX[whitesByX.length - 1]!;
    expect(last.x + last.w).toBeCloseTo(KEYBED_X1, 6);
  });

  it('centres each black on the boundary between two adjacent white keys', () => {
    for (const b of BLACK_KEYS) {
      const center = b.x + b.w / 2;
      // the white immediately to the left of this black
      const leftWhite = whitesByX[b.whiteIndex]!;
      const boundary = leftWhite.x + leftWhite.w; // right edge of that white = the boundary
      expect(center, `black ${b.semitone} not centred on the white boundary`).toBeCloseTo(boundary, 6);
      expect(b.w).toBeCloseTo(BLACK_W, 6);
    }
  });

  it('keeps every key rect inside the futureStrip viewBox', () => {
    for (const k of KEYS) {
      expect(k.x, `key ${k.i} left`).toBeGreaterThanOrEqual(0);
      expect(k.x + k.w, `key ${k.i} right`).toBeLessThanOrEqual(KB_W);
      expect(k.y, `key ${k.i} top`).toBeGreaterThanOrEqual(0);
      expect(k.y + k.h, `key ${k.i} bottom`).toBeLessThanOrEqual(KB_H);
    }
  });

  it('keeps blacks shorter than whites and starting at the keybed top', () => {
    const whiteH = whitesByX[0]!.h;
    for (const b of BLACK_KEYS) {
      expect(b.y).toBe(KEYBED_Y0);
      expect(b.h, `black ${b.semitone} not shorter than the whites`).toBeLessThan(whiteH);
    }
  });

  it('keyAtPoint resolves the white slice under a low point and the black on top', () => {
    // A point deep in a white key (below the black overlap) returns that white.
    const firstWhite = whitesByX[0]!;
    const deepInWhite = keyAtPoint(firstWhite.x + firstWhite.w / 2, KEYBED_Y0 + firstWhite.h - 2);
    expect(deepInWhite).toBe(firstWhite.semitone);

    // The centre of any black (high in the bed) returns that black, not the white under it.
    const black = BLACK_KEYS[0]!;
    const onBlack = keyAtPoint(black.x + black.w / 2, black.y + black.h / 2);
    expect(onBlack).toBe(black.semitone);

    // Outside the bed -> null.
    expect(keyAtPoint(KEYBED_X0 - 5, KEYBED_Y0 + 5)).toBeNull();
    expect(keyAtPoint(KEYBED_X1 + 5, KEYBED_Y0 + 5)).toBeNull();
  });

  it('maps the on-screen semitone (octave 0) to the contract notes 48..72', () => {
    // The panel ALWAYS calls keyToNote(semitone, 0) — octave-free raw notes; the
    // bridge adds the octave. Assert the bed spans MIDI 48 (C3) .. 72 (C5).
    const notes = (KEYS as KeyRect[]).map((k) => keyToNote(k.semitone, 0)).sort((a, b) => a - b);
    expect(notes[0]).toBe(48);
    expect(notes[notes.length - 1]).toBe(72);
    expect(new Set(notes).size).toBe(25); // every key a distinct note
  });
});
