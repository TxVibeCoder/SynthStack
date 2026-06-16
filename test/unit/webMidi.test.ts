import { describe, expect, it } from 'vitest';
import { parseMidiMessage } from '../../src/ui/midi/webMidiInput';

// Only the PURE parseMidiMessage decoder is unit-tested here. requestMIDIAccess, the
// permission prompt, real-device onmidimessage delivery, and onstatechange hot-plug are
// real-hardware-only (a manual checkpoint) and are
// intentionally NOT tested — no MIDIAccess is constructed in this suite.
describe('parseMidiMessage — pure MIDI decode (channel omni)', () => {
  it('decodes a note-on (0x90, velocity > 0)', () => {
    expect(parseMidiMessage([0x90, 60, 100])).toEqual({ type: 'noteOn', note: 60, velocity: 100 });
  });

  it('passes velocity through on note-on', () => {
    expect(parseMidiMessage([0x90, 64, 1]).velocity).toBe(1);
    expect(parseMidiMessage([0x90, 64, 127]).velocity).toBe(127);
  });

  it('decodes a note-off (0x80)', () => {
    expect(parseMidiMessage([0x80, 60, 64])).toEqual({ type: 'noteOff', note: 60, velocity: 0 });
  });

  it('treats 0x90 with velocity 0 as a note-off (running-status note-off-as-vel-0)', () => {
    expect(parseMidiMessage([0x90, 60, 0])).toEqual({ type: 'noteOff', note: 60, velocity: 0 });
  });

  it('ignores the channel nibble (omni): 0x9F and 0x8C still decode', () => {
    expect(parseMidiMessage([0x9f, 72, 80])).toEqual({ type: 'noteOn', note: 72, velocity: 80 });
    expect(parseMidiMessage([0x8c, 48, 10])).toEqual({ type: 'noteOff', note: 48, velocity: 0 });
  });

  it('maps CC / pitch-bend / clock / active-sensing to "other"', () => {
    expect(parseMidiMessage([0xb0, 7, 100]).type).toBe('other'); // control change (volume)
    expect(parseMidiMessage([0xe0, 0, 64]).type).toBe('other'); // pitch bend
    expect(parseMidiMessage([0xf8, 0, 0]).type).toBe('other'); // timing clock
    expect(parseMidiMessage([0xfe, 0, 0]).type).toBe('other'); // active sensing
  });

  it('maps short / empty / garbage messages to "other" WITHOUT throwing (length < 3 guard)', () => {
    expect(() => parseMidiMessage([])).not.toThrow();
    expect(parseMidiMessage([])).toEqual({ type: 'other', note: 0, velocity: 0 });
    expect(parseMidiMessage([0x90])).toEqual({ type: 'other', note: 0, velocity: 0 });
    expect(parseMidiMessage([0x90, 60])).toEqual({ type: 'other', note: 0, velocity: 0 });
  });

  it('accepts a real Uint8Array (the shape onmidimessage delivers)', () => {
    const data = new Uint8Array([0x90, 67, 90]);
    expect(parseMidiMessage(data)).toEqual({ type: 'noteOn', note: 67, velocity: 90 });
  });
});
