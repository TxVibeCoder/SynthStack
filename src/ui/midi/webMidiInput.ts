/**
 * Thin Web MIDI input shell (feature: keyboard + MIDI). Two layers:
 *
 *  1. parseMidiMessage — PURE, exported, unit-tested in Node (NO MIDIAccess needed):
 *     decodes a raw MIDI status+data triplet into noteOn / noteOff / other. Channel is
 *     ignored (omni, v1). CC / pitch-bend / clock / active-sensing are 'other' and
 *     deferred (no clock sync in v1).
 *
 *  2. WebMidiInput — the THIN device shell (NOT unit-tested; the prompt + real-device
 *     delivery + hot-plug require a hardware checkpoint). It feature-
 *     detects navigator.requestMIDIAccess, requests access with the single permission
 *     prompt, enumerates inputs, and routes note-on / note-off through the SAME callbacks
 *     the on-screen keyboard uses (the bridge wires both to one MonoVoice). It DEGRADES
 *     GRACEFULLY: when Web MIDI is unsupported (Node / jsdom / Firefox / Safari / a non-
 *     secure context) or the prompt is denied, it RESOLVES a status — it never throws.
 *
 * Web MIDI types (MIDIAccess, MIDIInput, MIDIInputMap, MIDIMessageEvent,
 * MIDIConnectionEvent, Navigator.requestMIDIAccess) ship in lib.dom.d.ts (TS 5.9.3), so
 * this shell type-checks WITHOUT @types additions and WITHOUT a new npm dep. Three lib
 * facts shape the implementation and are called out inline below.
 */

/** Decoded message kind + payload. note/velocity are 0 for non-note kinds. */
export interface ParsedMidiMessage {
  type: 'noteOn' | 'noteOff' | 'clock' | 'start' | 'continue' | 'stop' | 'other';
  note: number;
  velocity: number;
}

/**
 * PURE decode of a MIDI message (channel ignored = omni, v1). noUncheckedIndexedAccess is
 * ON, so data[i] is number|undefined — we read into locals BEFORE indexing, never out of bounds.
 *   System real-time (SINGLE-byte, status >= 0xF8) is decoded FIRST, before the length-3 guard:
 *     0xF8 -> clock (24 PPQN), 0xFA -> start, 0xFB -> continue, 0xFC -> stop
 *   0x90 with velocity > 0           -> noteOn { note, velocity }
 *   0x80, OR 0x90 with velocity === 0 (running-status note-off-as-vel-0) -> noteOff
 *   anything else (CC 0xB0, bend 0xE0, active-sensing 0xFE, short/garbage) -> other
 */
export function parseMidiMessage(data: ArrayLike<number>): ParsedMidiMessage {
  const status = data[0];
  if (status === undefined) return { type: 'other', note: 0, velocity: 0 };
  // System real-time messages are single-byte — must be handled before the length-3 guard.
  if (status === 0xf8) return { type: 'clock', note: 0, velocity: 0 };
  if (status === 0xfa) return { type: 'start', note: 0, velocity: 0 };
  if (status === 0xfb) return { type: 'continue', note: 0, velocity: 0 };
  if (status === 0xfc) return { type: 'stop', note: 0, velocity: 0 };
  if (data.length < 3) return { type: 'other', note: 0, velocity: 0 };
  const note = data[1];
  const velocity = data[2];
  if (note === undefined || velocity === undefined) {
    return { type: 'other', note: 0, velocity: 0 };
  }
  const command = status & 0xf0;
  if (command === 0x90 && velocity > 0) {
    return { type: 'noteOn', note, velocity };
  }
  if (command === 0x80 || (command === 0x90 && velocity === 0)) {
    return { type: 'noteOff', note, velocity: 0 };
  }
  return { type: 'other', note: 0, velocity: 0 };
}

/** Optional MIDI transport-clock callbacks (24-PPQN clock + Start/Continue/Stop). */
export interface MidiClockHandlers {
  onClock?: () => void;
  onStart?: () => void;
  onContinue?: () => void;
  onStop?: () => void;
}

/** Runtime-only MIDI connection status (never persisted: the prompt needs a fresh gesture). */
export type MidiStatus = {
  state: 'unsupported' | 'disabled' | 'denied' | 'enabled';
  deviceCount: number;
  deviceNames: string[];
};

const DISABLED_STATUS: MidiStatus = { state: 'disabled', deviceCount: 0, deviceNames: [] };
const UNSUPPORTED_STATUS: MidiStatus = { state: 'unsupported', deviceCount: 0, deviceNames: [] };

type NoteOnHandler = (note: number, velocity: number) => void;
type NoteOffHandler = (note: number) => void;

export class WebMidiInput {
  private access: MIDIAccess | null = null;
  private statusValue: MidiStatus = DISABLED_STATUS;
  private onNoteOn: NoteOnHandler | null = null;
  private onNoteOff: NoteOffHandler | null = null;
  /** Bridge panic callback fired when a hot-unplug drops the live device count to 0. */
  private onAllNotesOff: (() => void) | null = null;
  /** Optional transport-clock callbacks (24-PPQN clock + Start/Continue/Stop). */
  private clock: MidiClockHandlers | null = null;
  /** Inputs we have attached onmidimessage to, so disable()/re-enumerate can detach cleanly. */
  private attached: MIDIInput[] = [];
  /** In-flight enable() (the permission prompt is async); concurrent calls share it. */
  private pending: Promise<MidiStatus> | null = null;

  /**
   * Request access (one permission prompt) and start routing note events. Idempotent: a
   * second call while already enabled returns the current status without re-prompting.
   * Resolves (never rejects) with a status describing the outcome.
   *
   * @param onAllNotesOff optional panic callback fired on a hot-unplug-to-zero (the shared
   *        mono voice means a stranded gate also blocks the sequencer — clear it).
   */
  async enable(
    onNoteOn: NoteOnHandler,
    onNoteOff: NoteOffHandler,
    onAllNotesOff?: () => void,
    clock?: MidiClockHandlers,
  ): Promise<MidiStatus> {
    this.onNoteOn = onNoteOn;
    this.onNoteOff = onNoteOff;
    this.onAllNotesOff = onAllNotesOff ?? null;
    this.clock = clock ?? null;

    // Idempotent: already enabled -> return current status, no second prompt.
    if (this.access && this.statusValue.state === 'enabled') {
      return this.statusValue;
    }
    // A prompt is already in flight (e.g. a rapid double-click on ENABLE MIDI): share it,
    // so we never fire a second requestMIDIAccess() or race two MIDIAccess objects (which
    // would orphan onmidimessage listeners on the losing access).
    if (this.pending) return this.pending;

    this.pending = this.requestAccess();
    try {
      return await this.pending;
    } finally {
      this.pending = null;
    }
  }

  /** The actual request + wiring; serialized behind `pending` so it runs at most once at a time. */
  private async requestAccess(): Promise<MidiStatus> {
    // FEATURE DETECT (lint-clean): requestMIDIAccess is a NON-optional method in
    // lib.dom.d.ts, so `=== undefined` would be flagged as always-false. Use typeof.
    // At RUNTIME it is undefined in Node / jsdom / Firefox / Safari / non-secure context.
    if (typeof navigator === 'undefined' || typeof navigator.requestMIDIAccess !== 'function') {
      this.statusValue = UNSUPPORTED_STATUS;
      return this.statusValue;
    }

    let access: MIDIAccess;
    try {
      access = await navigator.requestMIDIAccess({ sysex: false });
    } catch {
      // user rejected the prompt, or the browser refused access
      this.statusValue = { state: 'denied', deviceCount: 0, deviceNames: [] };
      return this.statusValue;
    }

    this.access = access;
    access.onstatechange = () => this.reenumerate();
    this.reenumerate();
    return this.statusValue;
  }

  /** (Re)attach onmidimessage to every input and recompute the status snapshot. */
  private reenumerate(): void {
    const access = this.access;
    if (!access) return;
    this.detachInputs();
    const names: string[] = [];
    // MIDIInputMap types ONLY forEach() in this lib (no Symbol.iterator / .size / .values),
    // so deviceCount + deviceNames are collected INSIDE forEach.
    access.inputs.forEach((input) => {
      input.onmidimessage = (e) => this.handleMessage(e);
      this.attached.push(input);
      names.push(input.name ?? input.id);
    });
    const deviceCount = this.attached.length;
    this.statusValue = { state: 'enabled', deviceCount, deviceNames: names };
    // Hot-unplug-to-zero: clear any hung gate on the shared mono voice.
    if (deviceCount === 0) this.onAllNotesOff?.();
  }

  private handleMessage(e: MIDIMessageEvent): void {
    // MIDIMessageEvent.data is Uint8Array<ArrayBuffer> | null in this lib — guard first.
    if (!e.data) return;
    const msg = parseMidiMessage(e.data);
    if (msg.type === 'noteOn') this.onNoteOn?.(msg.note, msg.velocity);
    else if (msg.type === 'noteOff') this.onNoteOff?.(msg.note);
    else if (msg.type === 'clock') this.clock?.onClock?.();
    else if (msg.type === 'start') this.clock?.onStart?.();
    else if (msg.type === 'continue') this.clock?.onContinue?.();
    else if (msg.type === 'stop') this.clock?.onStop?.();
    // 'other' (CC / bend / active-sensing / garbage) -> ignored
  }

  private detachInputs(): void {
    for (const input of this.attached) input.onmidimessage = null;
    this.attached = [];
  }

  /** Detach every handler so a later re-enable doesn't double-fire; status -> 'disabled'. */
  disable(): void {
    if (this.access) this.access.onstatechange = null;
    this.detachInputs();
    // Release any gate held on a device at teardown — once detached, that device's
    // note-off can no longer be delivered, so flush before dropping access.
    this.onAllNotesOff?.();
    this.access = null;
    this.statusValue = DISABLED_STATUS;
  }

  /** Current runtime status (initial 'disabled'). */
  get status(): MidiStatus {
    return this.statusValue;
  }
}
