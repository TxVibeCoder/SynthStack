/**
 * Monarch step-record (Wave 2): keyboard / MIDI note ON, while REC is armed, must write the
 * cursor step and let the editor advance — eliminating manual per-step note entry. The bridge
 * contract: noteOn forwards the PLAYED vv (note→vv + keyboard octave) to the registered record
 * handler; velocity 0 (running-status note-off) does NOT record; clearing the handler stops it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { engineBridge } from '../../src/ui/engineBridge';
import { noteToVv } from '../../src/engine/voice/monoVoice';

describe('Monarch step-record', () => {
  beforeEach(() => {
    engineBridge.setKeyboardOctave(0);
    engineBridge.setMonarchRecordHandler(null);
  });
  afterEach(() => engineBridge.setMonarchRecordHandler(null));

  it('forwards each keyboard noteOn to the record handler as the played vv', () => {
    const seen: number[] = [];
    engineBridge.setMonarchRecordHandler((vv) => seen.push(vv));
    engineBridge.noteOn(60, 100); // middle C
    engineBridge.noteOn(64, 100); // E
    expect(seen).toEqual([noteToVv(60), noteToVv(64)]);
  });

  it('applies the keyboard octave to the recorded vv (what you hear is what is written)', () => {
    const seen: number[] = [];
    engineBridge.setKeyboardOctave(1);
    engineBridge.setMonarchRecordHandler((vv) => seen.push(vv));
    engineBridge.noteOn(60, 100);
    expect(seen).toEqual([noteToVv(60) + 1]);
  });

  it('does NOT record a velocity-0 note (that is a note-off)', () => {
    const seen: number[] = [];
    engineBridge.setMonarchRecordHandler((vv) => seen.push(vv));
    engineBridge.noteOn(60, 0);
    expect(seen).toEqual([]);
  });

  it('a step-record handler writes the cursor step + advances (full editor contract)', () => {
    let cursor = 0;
    const endStep = 4;
    engineBridge.setMonarchEndStep(endStep);
    engineBridge.updateMonarchStep(0, { rest: true }); // prove rest is cleared on record
    engineBridge.setMonarchRecordHandler((vv) => {
      engineBridge.updateMonarchStep(cursor, { noteVv: vv, rest: false });
      cursor = (cursor + 1) % endStep;
    });
    engineBridge.noteOn(60, 100);
    engineBridge.noteOn(62, 100);
    const steps = engineBridge.store.getState().transport.monarch.steps;
    expect(steps[0]!.noteVv).toBe(noteToVv(60));
    expect(steps[0]!.rest).toBe(false);
    expect(steps[1]!.noteVv).toBe(noteToVv(62));
    expect(cursor).toBe(2);
  });

  it('clearing the handler stops recording', () => {
    const seen: number[] = [];
    engineBridge.setMonarchRecordHandler((vv) => seen.push(vv));
    engineBridge.setMonarchRecordHandler(null);
    engineBridge.noteOn(60, 100);
    expect(seen).toEqual([]);
  });
});
