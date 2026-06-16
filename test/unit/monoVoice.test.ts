import { describe, expect, it } from 'vitest';
import { MonoVoice, noteToVv, type VoiceAction } from '../../src/engine/voice/monoVoice';
import {
  KEYBED_KEYS,
  KEYBED_LOW_C_NOTE_AT_OCTAVE0,
  KEYBED_SHAPE,
  keyToNote,
} from '../../src/engine/voice/keyMap';

describe('MonoVoice — last-note priority allocator', () => {
  it('single note on -> fresh attack (gate on, retrigger), then off -> gate off', () => {
    const v = new MonoVoice();
    expect(v.noteOn(60)).toEqual<VoiceAction>({ gate: 'on', note: 60, retrigger: true });
    expect(v.heldCount).toBe(1);
    expect(v.noteOff(60)).toEqual<VoiceAction>({ gate: 'off', note: null, retrigger: false });
    expect(v.heldCount).toBe(0);
  });

  it('legato stacking: second note-on does NOT retrigger; pitch follows the new top', () => {
    const v = new MonoVoice();
    expect(v.noteOn(60)).toEqual<VoiceAction>({ gate: 'on', note: 60, retrigger: true });
    // second note over the first: gate stays high, pitch moves, NO re-attack
    expect(v.noteOn(64)).toEqual<VoiceAction>({ gate: 'on', note: 64, retrigger: false });
    expect(v.noteOn(67)).toEqual<VoiceAction>({ gate: 'on', note: 67, retrigger: false });
    expect(v.heldCount).toBe(3);
  });

  it('release the TOP note falls back to the next held note (gate on, no retrigger)', () => {
    const v = new MonoVoice();
    v.noteOn(60);
    v.noteOn(64);
    v.noteOn(67); // stack: [60, 64, 67], top = 67
    expect(v.noteOff(67)).toEqual<VoiceAction>({ gate: 'on', note: 64, retrigger: false });
    expect(v.noteOff(64)).toEqual<VoiceAction>({ gate: 'on', note: 60, retrigger: false });
    expect(v.noteOff(60)).toEqual<VoiceAction>({ gate: 'off', note: null, retrigger: false });
  });

  it('releasing a held NON-top note leaves the sounding note unchanged (no engine write)', () => {
    const v = new MonoVoice();
    v.noteOn(60);
    v.noteOn(64); // top = 64, 60 held underneath
    expect(v.noteOff(60)).toEqual<VoiceAction>({ gate: 'unchanged', note: null, retrigger: false });
    expect(v.heldCount).toBe(1);
    // releasing the still-sounding top now gates off (60 was removed from the stack)
    expect(v.noteOff(64)).toEqual<VoiceAction>({ gate: 'off', note: null, retrigger: false });
  });

  it('a stray note-off for an un-held note is a defensive no-op', () => {
    const v = new MonoVoice();
    expect(v.noteOff(72)).toEqual<VoiceAction>({ gate: 'unchanged', note: null, retrigger: false });
    v.noteOn(60);
    expect(v.noteOff(72)).toEqual<VoiceAction>({ gate: 'unchanged', note: null, retrigger: false });
    expect(v.heldCount).toBe(1);
  });

  it('duplicate note-on dedups (auto-repeat / running-status resend) and re-tops without re-attack', () => {
    const v = new MonoVoice();
    v.noteOn(60); // [60]
    v.noteOn(64); // [60, 64]
    // re-press 60 while held: dedup the old copy, push to top; stack non-empty -> no retrigger
    expect(v.noteOn(60)).toEqual<VoiceAction>({ gate: 'on', note: 60, retrigger: false });
    expect(v.heldCount).toBe(2); // not 3 — the old 60 was removed
    // releasing 60 (now the top) falls back to 64
    expect(v.noteOff(60)).toEqual<VoiceAction>({ gate: 'on', note: 64, retrigger: false });
  });

  it('allNotesOff clears the stack and gates off', () => {
    const v = new MonoVoice();
    v.noteOn(60);
    v.noteOn(64);
    v.noteOn(67);
    expect(v.allNotesOff()).toEqual<VoiceAction>({ gate: 'off', note: null, retrigger: false });
    expect(v.heldCount).toBe(0);
    // a fresh press after panic is a clean attack again
    expect(v.noteOn(62)).toEqual<VoiceAction>({ gate: 'on', note: 62, retrigger: true });
  });
});

describe('noteToVv — 1 vv/octave, 0 vv = note 60', () => {
  it('maps middle C and octave boundaries', () => {
    expect(noteToVv(60)).toBe(0); // middle C = 0 vv
    expect(noteToVv(72)).toBe(1); // +1 octave
    expect(noteToVv(48)).toBe(-1); // -1 octave
    expect(noteToVv(61)).toBeCloseTo(1 / 12, 12); // one semitone
  });
});

describe('keyToNote / KEYBED_SHAPE — pure keybed geometry', () => {
  it('semitone 0 @ octave 0 is the low C (48); semitone 12 is middle C (60)', () => {
    expect(KEYBED_LOW_C_NOTE_AT_OCTAVE0).toBe(48);
    expect(keyToNote(0, 0)).toBe(48);
    expect(keyToNote(12, 0)).toBe(60);
    expect(keyToNote(24, 0)).toBe(72); // top C of the 2-octave bed
  });

  it('octave shift moves the whole bed by 12 semitones', () => {
    expect(keyToNote(0, 1)).toBe(60);
    expect(keyToNote(0, -1)).toBe(36);
    expect(keyToNote(12, 1)).toBe(72);
  });

  it('KEYBED_SHAPE is 25 keys: 15 white + 10 black, blacks after C/D/F/G/A only', () => {
    expect(KEYBED_SHAPE).toHaveLength(KEYBED_KEYS);
    expect(KEYBED_KEYS).toBe(25);
    const whites = KEYBED_SHAPE.filter((k) => !k.isBlack);
    const blacks = KEYBED_SHAPE.filter((k) => k.isBlack);
    expect(whites).toHaveLength(15);
    expect(blacks).toHaveLength(10);
    // blacks are at semitones 1,3,6,8,10 within each octave; none after E (4/11→0) or B
    for (const k of KEYBED_SHAPE) {
      const inOctave = k.semitone % 12;
      const expectBlack = [1, 3, 6, 8, 10].includes(inOctave);
      expect(k.isBlack).toBe(expectBlack);
    }
  });
});
