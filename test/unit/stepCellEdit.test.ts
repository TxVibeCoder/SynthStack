/**
 * Pure semantics of the step-cell direct-manipulation gestures (stepCellEdit.ts):
 * tap = toggle the step on/off (plain REST flip, pitch untouched), vertical drag =
 * pitch in semitones. Shared by the Monarch + Courier step editors.
 */
import { describe, expect, it } from 'vitest';
import {
  DRAG_THRESHOLD_PX,
  PX_PER_SEMI,
  SEMI_MAX,
  SEMI_MIN,
  dragSemisFrom,
  tapPatch,
} from '../../src/ui/sequencer/stepCellEdit';

describe('stepCellEdit — dragSemisFrom (vertical drag = pitch)', () => {
  it('dragging UP (negative dy) raises the pitch, one semitone per PX_PER_SEMI', () => {
    expect(dragSemisFrom(0, -PX_PER_SEMI)).toBe(1);
    expect(dragSemisFrom(0, -3 * PX_PER_SEMI)).toBe(3);
  });

  it('dragging DOWN (positive dy) lowers the pitch', () => {
    expect(dragSemisFrom(0, 2 * PX_PER_SEMI)).toBe(-2);
  });

  it('starts from the step origin, not zero', () => {
    expect(dragSemisFrom(5, -PX_PER_SEMI)).toBe(6);
    expect(dragSemisFrom(-12, PX_PER_SEMI)).toBe(-13);
  });

  it('snaps to whole semitones (round, not floor)', () => {
    // just under half a detent stays put; just over rounds to the next semitone
    expect(dragSemisFrom(0, -(PX_PER_SEMI / 2 - 0.6))).toBe(0);
    expect(dragSemisFrom(0, -(PX_PER_SEMI / 2 + 0.6))).toBe(1);
  });

  it('clamps to the shared NOTE rail (±24 semitones)', () => {
    expect(dragSemisFrom(20, -100 * PX_PER_SEMI)).toBe(SEMI_MAX);
    expect(dragSemisFrom(-20, 100 * PX_PER_SEMI)).toBe(SEMI_MIN);
  });

  it('threshold is reachable: crossing the dead-zone can already move one semitone', () => {
    // a drag that just crossed DRAG_THRESHOLD_PX must be able to register an edit soon
    expect(DRAG_THRESHOLD_PX).toBeLessThan(PX_PER_SEMI * 1.5);
  });
});

describe('stepCellEdit — tapPatch (tap = on/off)', () => {
  it('flips REST and returns ONLY the rest field — pitch is never touched', () => {
    expect(tapPatch({ rest: false })).toEqual({ rest: true });
    expect(tapPatch({ rest: true })).toEqual({ rest: false });
  });

  it('negative notes survive a tap untouched (Monarch default C3 = −1 vv; Courier below-anchor notes)', () => {
    // the patch has no noteVv key, so a store merge cannot rewrite an authored pitch
    const patch = tapPatch({ rest: false });
    expect('noteVv' in patch).toBe(false);
  });
});
