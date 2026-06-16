/**
 * Mono voice allocator (feature: keyboard + MIDI) — PURE state machine, Web-Audio-free
 * and Web-MIDI-free, Node-testable. Modeled on the pure-state idiom of
 * sequencers/samplerLoops.ts: no AudioContext, no currentTime, no Date/Math.random.
 *
 * The Monarch is a single-VCO MONOPHONIC voice (one kbCv / kbGate ConstantSource —
 * verified in modules/monarch.ts), so on-screen-keyboard + Web-MIDI play must be mono
 * with LAST-NOTE priority, exactly like the hardware. This allocator owns the held-note
 * STACK and decides, per note-on / note-off, what the engine should do — but it deals
 * ONLY in raw MIDI note numbers 0..127: it NEVER applies octave, NEVER computes vv,
 * NEVER touches currentTime. Octave + (note-60)/12 vv mapping + the +0.03 schedule lead
 * are the bridge's / studio's job (see ui/engineBridge.ts). One MonoVoice instance is
 * shared by the on-screen keyboard AND the MIDI shell so both feed ONE last-note stack.
 *
 * SEMANTICS (design-locked classic-SynthStack last-note priority over an ordered held-note
 * STACK = most-recent at the top):
 *  - noteOn(note): drop any existing copy of note (dedup vs key auto-repeat / MIDI
 *    running-status resend), push to the top.
 *      * stack WAS empty   -> { gate:'on',  note, retrigger:true }   (fresh attack, EG fires)
 *      * stack was NON-empty-> { gate:'on',  note, retrigger:false }  (legato: pitch moves,
 *                                                                      gate stays high, NO re-attack)
 *  - noteOff(note): remove note from anywhere in the stack.
 *      * note was NOT the top (a held lower note released) -> { gate:'unchanged', note:null,
 *        retrigger:false }                                          (no engine write)
 *      * note WAS the top, stack now NON-empty -> { gate:'on', note:newTop, retrigger:false }
 *        (fall back to the next held note, gate stays high, pitch moves)
 *      * note WAS the top, stack now EMPTY     -> { gate:'off', note:null, retrigger:false }
 *      * note absent entirely                  -> { gate:'unchanged', note:null, retrigger:false }
 *        (defensive: a stray note-off for an un-held note)
 *  - allNotesOff(): panic — clears the stack -> { gate:'off', note:null, retrigger:false }.
 */

/** What the bridge should do with the engine after one allocator transition. */
export interface VoiceAction {
  /** 'on' = drive pitch + (if retrigger) raise the gate; 'off' = drop the gate; 'unchanged' = no engine write. */
  gate: 'on' | 'off' | 'unchanged';
  /** The note to pitch to (raw MIDI number) when gate is 'on'; null otherwise. */
  note: number | null;
  /** true only on a fresh attack into an empty stack (re-fire the EG); false on legato / fall-back. */
  retrigger: boolean;
}

export class MonoVoice {
  /** Held-note stack, ordered oldest-first; the LAST element is the sounding note. */
  private readonly stack: number[] = [];

  /** Press a note: dedup, push to the top, return the resulting engine action. */
  noteOn(note: number): VoiceAction {
    const wasEmpty = this.stack.length === 0;
    const existing = this.stack.indexOf(note);
    if (existing !== -1) this.stack.splice(existing, 1);
    this.stack.push(note);
    return { gate: 'on', note, retrigger: wasEmpty };
  }

  /** Release a note: remove it; fall back to the next held note, or gate off if empty. */
  noteOff(note: number): VoiceAction {
    const idx = this.stack.indexOf(note);
    if (idx === -1) {
      // a stray release for a note we never registered as held
      return { gate: 'unchanged', note: null, retrigger: false };
    }
    const wasTop = idx === this.stack.length - 1;
    this.stack.splice(idx, 1);
    if (!wasTop) {
      // a held lower note released — the sounding note is unchanged
      return { gate: 'unchanged', note: null, retrigger: false };
    }
    const newTop = this.stack[this.stack.length - 1];
    if (newTop === undefined) {
      // released the last held note — gate off
      return { gate: 'off', note: null, retrigger: false };
    }
    // fall back to the next-most-recent held note; gate stays high, pitch moves
    return { gate: 'on', note: newTop, retrigger: false };
  }

  /** Panic: clear all held notes and gate off (dropped note-off / power-off / reset). */
  allNotesOff(): VoiceAction {
    this.stack.length = 0;
    return { gate: 'off', note: null, retrigger: false };
  }

  /** Number of currently-held notes (for tests + diagnostics). */
  get heldCount(): number {
    return this.stack.length;
  }
}

/**
 * Pure note -> pitch CV (vv) mapping: 1 vv per octave, 0 vv = MIDI note 60 (middle C),
 * matching the Monarch kbCv convention (modules/monarch.ts). Octave shift is NOT applied
 * here — the bridge adds keyboardOctave to this result, so octave lives in exactly one
 * place. Exported for tests + the bridge.
 */
export function noteToVv(note: number): number {
  return (note - 60) / 12;
}
