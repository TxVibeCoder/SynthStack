/**
 * On-screen piano keyboard (g4-ui-keyboard) — replaces the FutureStrip placeholder
 * in REGIONS.futureStrip. One <svg className="panel"> matching the FutureStrip /
 * UtilityStrip idiom; colours + fonts come ONLY from theme.ts, the Button from
 * controls/Button, the white/black layout from the engine's KEYBED_SHAPE (never
 * hard-coded here — keyboardLayout.ts turns it into rects).
 *
 * It plays the Monarch voice through engineBridge ONLY (the single React->engine
 * seam): every key press calls engineBridge.noteOn(keyToNote(semitone, 0), 100) and
 * release calls engineBridge.noteOff(note). The "0" is deliberate — the panel sends
 * OCTAVE-FREE raw notes (low C = MIDI 48); the bridge alone adds the keyboard octave
 * when it maps note->vv, so octave is applied in exactly ONE place (no double-shift,
 * see DECISIONS.md). On-screen velocity is a constant 100 (v1 maps velocity to gate
 * only; a velocity->VCA-CV map is BACKLOG).
 *
 * Mono + last-note priority is the bridge's MonoVoice; the on-screen keys and Web
 * MIDI share that ONE allocator, so this panel keeps no voice logic — only a Set of
 * physically-held keys to repaint them and to flush a hung gate on cancel/blur.
 *
 * OCTAVE is the only persisted datum (state.keyboard.octave), read via
 * useSyncExternalStore over engineBridge.store; ENABLE MIDI fires the one Web MIDI
 * permission prompt and the status LED polls engineBridge.getMidiStatus().
 */

import { memo, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { ControlDef } from '../../../data/schema';
import { COLORS, FONT_CONDENSED } from '../theme';
import { Button } from '../controls/Button';
import { engineBridge, type MidiStatus } from '../engineBridge';
import { keyToNote } from '../../engine/voice/keyMap';
import {
  KB_W,
  KB_H,
  KEYS,
  WHITE_KEYS,
  BLACK_KEYS,
  keyAtPoint,
  CLUSTER_W,
  OCT_DOWN,
  OCT_READOUT,
  OCT_UP,
  ENABLE_MIDI,
  MIDI_STATUS_LED,
  MIDI_STATUS_TEXT,
  CLOCK_MASTER_LED,
  CLOCK_MASTER_TEXT,
  PC_KEYS,
  type KeyRect,
} from './keyboardLayout';

/** On-screen velocity (v1: gate-only — the value is passed through but unused). */
const SCREEN_VELOCITY = 100;
/** Octave clamp — mirrors the bridge/state clamp (-3..+3). */
const OCT_MIN = -3;
const OCT_MAX = 3;

const OCT_DOWN_DEF: ControlDef = { id: 'KB_OCT_DOWN', panelLabel: 'OCT-', type: 'button' };
const OCT_UP_DEF: ControlDef = { id: 'KB_OCT_UP', panelLabel: 'OCT+', type: 'button' };
const ENABLE_MIDI_DEF: ControlDef = { id: 'KB_ENABLE_MIDI', panelLabel: 'ENABLE MIDI', type: 'button' };
const PC_KEYS_DEF: ControlDef = {
  id: 'KB_PC_KEYS',
  panelLabel: 'PC KEYS',
  type: 'button',
  positions: ['OFF', 'ON'],
  default: 'OFF',
};

/**
 * Computer-key layout (standard one-and-a-half-octave "tracker" map): the home row
 * carries the white notes, the QWERTY row the sharps, so a chromatic run reads
 *   a w s e d f t g y h u j k o l p ; '  ->  semitones 0..17
 * (low C up to the F a perfect fourth above the next C). The home-row whites run
 * right up to the keys flanking Enter — k l ; ' — with the next C on k; the sharps
 * o (C#) and p (D#) sit on the QWERTY row above them, mirroring w/e in the first
 * octave. Only wired while the PC KEYS latch is ON. Octave is still added in the bridge.
 *
 * Keys are matched after e.key.toLowerCase(); ';' and ''' lower-case to themselves.
 */
const PC_KEY_MAP: Record<string, number> = {
  a: 0, // C
  w: 1, // C#
  s: 2, // D
  e: 3, // D#
  d: 4, // E
  f: 5, // F
  t: 6, // F#
  g: 7, // G
  y: 8, // G#
  h: 9, // A
  u: 10, // A#
  j: 11, // B
  k: 12, // C (octave up)
  o: 13, // C#
  l: 14, // D
  p: 15, // D#
  ';': 16, // E
  "'": 17, // F
};

/**
 * Reverse map semitone -> the keycap printed on that key as an on-screen hint. Built
 * from PC_KEY_MAP (upper-cased letters; the two punctuation keys print as themselves)
 * so the printed label and the live binding can never drift. Semitones with no binding
 * (18..24, past the keys between J and Enter) simply get no label.
 */
const SEMITONE_KEYCAP: Record<number, string> = Object.fromEntries(
  Object.entries(PC_KEY_MAP).map(([key, semitone]) => [semitone, key.toUpperCase()]),
);

// ---- octave snapshot (persisted; subscribe the store) ---------------------------------

const subscribeStore = (onChange: () => void) => engineBridge.store.subscribe(onChange);
const getOctaveSnapshot = () => engineBridge.getKeyboardOctave();

function useKeyboardOctave(): number {
  return useSyncExternalStore(subscribeStore, getOctaveSnapshot);
}

// ---- MIDI status (RUNTIME only — not in the store; poll a light interval) --------------

const MIDI_POLL_MS = 600;

function midiCaption(status: MidiStatus): { color: string; text: string } {
  switch (status.state) {
    case 'enabled': {
      const first = status.deviceNames[0];
      const text = first ?? (status.deviceCount > 0 ? `${status.deviceCount} DEVICES` : 'NO DEVICES');
      return { color: COLORS.ledGreen, text };
    }
    case 'denied':
      return { color: COLORS.ledRed, text: 'DENIED' };
    case 'unsupported':
      return { color: COLORS.ledRed, text: 'NO MIDI' };
    case 'disabled':
    default:
      return { color: COLORS.ledOff, text: 'MIDI OFF' };
  }
}

function useMidiStatus(): MidiStatus {
  const [status, setStatus] = useState<MidiStatus>(() => engineBridge.getMidiStatus());
  useEffect(() => {
    // getMidiStatus is runtime (never in the store), so a small interval keeps the
    // LED honest across hot-plug / a resolved enable() without a store notification.
    const id = setInterval(() => {
      const next = engineBridge.getMidiStatus();
      setStatus((prev) =>
        prev.state === next.state &&
        prev.deviceCount === next.deviceCount &&
        prev.deviceNames.join(' ') === next.deviceNames.join(' ')
          ? prev
          : next,
      );
    }, MIDI_POLL_MS);
    return () => clearInterval(id);
  }, []);
  return status;
}

/**
 * CLOCK MASTER poll — true while external MIDI clock (0xFA Start) is driving the studio. RUNTIME
 * only (implicit enable; no store field), so it shares the MIDI_POLL_MS interval idiom. Master is
 * released by a 0xFC Stop OR the studio watchdog (a stalled/unplugged upstream clock).
 */
function useMidiClockMaster(): boolean {
  const [master, setMaster] = useState<boolean>(() => engineBridge.isMidiClockMaster());
  useEffect(() => {
    const id = setInterval(() => {
      const next = engineBridge.isMidiClockMaster();
      setMaster((prev) => (prev === next ? prev : next));
    }, MIDI_POLL_MS);
    return () => clearInterval(id);
  }, []);
  return master;
}

// ---- one key (white or black <g role="button">) ---------------------------------------

interface KeyProps {
  k: KeyRect;
  held: boolean;
  onDown: (e: ReactPointerEvent<SVGGElement>, k: KeyRect) => void;
  onUp: (e: ReactPointerEvent<SVGGElement>) => void;
  onMove: (e: ReactPointerEvent<SVGGElement>) => void;
}

const Key = memo(function Key({ k, held, onDown, onUp, onMove }: KeyProps) {
  const baseFill = k.isBlack ? COLORS.panelShadow : COLORS.legend;
  return (
    <g
      className="control"
      role="button"
      tabIndex={0}
      aria-label={`Key ${k.semitone}`}
      data-testid={`key-${k.i}`}
      onPointerDown={(e) => onDown(e, k)}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onPointerMove={onMove}
    >
      <rect
        x={k.x}
        y={k.y}
        width={k.w}
        height={k.h}
        rx={3}
        fill={held ? COLORS.focus : baseFill}
        stroke={COLORS.panelEdge}
        strokeWidth={k.isBlack ? 1 : 1.2}
      />
    </g>
  );
});

// ---- panel -----------------------------------------------------------------------------

export function KeyboardPanel() {
  const octave = useKeyboardOctave();
  const midiStatus = useMidiStatus();
  const clockMaster = useMidiClockMaster();

  /** Physically-held semitone indices (drives the amber repaint). */
  const [held, setHeld] = useState<ReadonlySet<number>>(() => new Set());
  /** Pointer-id -> the semitone index that pointer is currently sounding (glissando). */
  const pointerNote = useRef<Map<number, number>>(new Map());
  /** PC-key char -> the semitone it is sounding (so keyup releases the right note). */
  const pcKeyNote = useRef<Map<string, number>>(new Map());
  const [pcKeysOn, setPcKeysOn] = useState(false);

  const mark = useCallback((semitone: number, on: boolean) => {
    setHeld((prev) => {
      if (on === prev.has(semitone)) return prev;
      const next = new Set(prev);
      if (on) next.add(semitone);
      else next.delete(semitone);
      return next;
    });
  }, []);

  /** Per-semitone holder count — the SAME pitch can be held by a pointer AND a PC key (and a
   *  glissando slide). The shared MonoVoice + lamp toggle ONLY on the 0<->1 transition, so
   *  releasing one source never silences a still-held other source or desyncs the lamp (B8). */
  const holders = useRef<Map<number, number>>(new Map());

  const acquireNote = useCallback(
    (semitone: number) => {
      const n = (holders.current.get(semitone) ?? 0) + 1;
      holders.current.set(semitone, n);
      if (n === 1) {
        engineBridge.noteOn(keyToNote(semitone, 0), SCREEN_VELOCITY);
        mark(semitone, true);
      }
    },
    [mark],
  );

  const releaseNote = useCallback(
    (semitone: number) => {
      const cur = holders.current.get(semitone) ?? 0;
      if (cur <= 0) return;
      if (cur === 1) {
        holders.current.delete(semitone);
        engineBridge.noteOff(keyToNote(semitone, 0));
        mark(semitone, false);
      } else {
        holders.current.set(semitone, cur - 1);
      }
    },
    [mark],
  );

  // ---- on-screen key pointer handling (with glissando) --------------------------------

  const startNote = useCallback((semitone: number) => acquireNote(semitone), [acquireNote]);
  const stopNote = useCallback((semitone: number) => releaseNote(semitone), [releaseNote]);

  const onKeyDown = useCallback(
    (e: ReactPointerEvent<SVGGElement>, k: KeyRect) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      // Capture so moves + the up event route to THIS key even off-rect (glissando).
      e.currentTarget.setPointerCapture(e.pointerId);
      pointerNote.current.set(e.pointerId, k.semitone);
      startNote(k.semitone);
    },
    [startNote],
  );

  const onKeyUp = useCallback(
    (e: ReactPointerEvent<SVGGElement>) => {
      const cur = pointerNote.current.get(e.pointerId);
      if (cur == null) return;
      pointerNote.current.delete(e.pointerId);
      stopNote(cur);
    },
    [stopNote],
  );

  const onKeyMove = useCallback(
    (e: ReactPointerEvent<SVGGElement>) => {
      const cur = pointerNote.current.get(e.pointerId);
      if (cur == null) return; // not a pressed pointer
      // The capturing <g> is in viewBox-local units already (the panel SVG maps 1:1
      // to its scaled region), so nativeEvent.offset would be relative to the <g>;
      // recover keybed-local coordinates from the SVG's own CTM instead.
      const svg = e.currentTarget.ownerSVGElement;
      if (!svg) return;
      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const ctm = svg.getScreenCTM();
      if (!ctm) return;
      const local = pt.matrixTransform(ctm.inverse());
      const target = keyAtPoint(local.x, local.y);
      if (target == null || target === cur) return;
      // Slid into a new key: release old, sound new (the allocator's last-note stack
      // handles the legato cleanly). Re-point this pointer at the new note.
      stopNote(cur);
      pointerNote.current.set(e.pointerId, target);
      startNote(target);
    },
    [startNote, stopNote],
  );

  /** Flush EVERY held pointer/PC note — guards a hung gate (the shared voice means a
   *  stranded gate also blocks the sequencer). Wired to blur + unmount + power changes. */
  const flushAll = useCallback(() => {
    for (const semitone of pointerNote.current.values()) releaseNote(semitone);
    pointerNote.current.clear();
    for (const semitone of pcKeyNote.current.values()) releaseNote(semitone);
    pcKeyNote.current.clear();
    holders.current.clear(); // drop any residual counts so a later acquire starts clean (B8)
    setHeld((prev) => (prev.size === 0 ? prev : new Set()));
  }, [releaseNote]);

  // Flush held notes when the window loses focus (alt-tab / click-away mid-hold) and
  // on unmount, so a dropped pointerup can't leave kbGate stuck high.
  useEffect(() => {
    window.addEventListener('blur', flushAll);
    return () => {
      window.removeEventListener('blur', flushAll);
      flushAll();
    };
  }, [flushAll]);

  // ---- octave shift -------------------------------------------------------------------

  const shiftOctave = useCallback(
    (delta: number) => {
      const next = Math.max(OCT_MIN, Math.min(OCT_MAX, octave + delta));
      if (next !== octave) engineBridge.setKeyboardOctave(next);
    },
    [octave],
  );

  const onOctDown = useCallback((pos: string) => {
    if (pos === 'ON') shiftOctave(-1);
  }, [shiftOctave]);
  const onOctUp = useCallback((pos: string) => {
    if (pos === 'ON') shiftOctave(1);
  }, [shiftOctave]);

  // ---- ENABLE MIDI --------------------------------------------------------------------

  const onEnableMidi = useCallback((pos: string) => {
    if (pos !== 'ON') return;
    // Fires the one Web MIDI permission prompt; the status LED interval picks up the
    // resolved state. The shell never throws (unsupported/denied resolve cleanly).
    void engineBridge.enableMidi().catch(() => undefined);
  }, []);

  // ---- PC KEYS latch + window keydown/keyup listener ----------------------------------

  const onPcKeysToggle = useCallback((pos: string) => {
    setPcKeysOn(pos === 'ON');
  }, []);

  useEffect(() => {
    if (!pcKeysOn) return;
    const isTextTarget = () => {
      const el = document.activeElement;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || (el as HTMLElement).isContentEditable === true;
    };
    const down = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTextTarget()) return;
      const semitone = PC_KEY_MAP[e.key.toLowerCase()];
      if (semitone == null) return;
      if (pcKeyNote.current.has(e.key.toLowerCase())) return; // already sounding (held)
      e.preventDefault();
      pcKeyNote.current.set(e.key.toLowerCase(), semitone);
      acquireNote(semitone);
    };
    const up = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const semitone = pcKeyNote.current.get(key);
      if (semitone == null) return;
      pcKeyNote.current.delete(key);
      releaseNote(semitone);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      // Releasing the latch (or unmount) must drop any keys still down.
      for (const semitone of pcKeyNote.current.values()) releaseNote(semitone);
      pcKeyNote.current.clear();
    };
  }, [pcKeysOn, acquireNote, releaseNote]);

  // ---- render -------------------------------------------------------------------------

  const status = midiCaption(midiStatus);
  // Low-C octave readout: octave 0 -> the low C is MIDI 48 = C3 (keyToNote semitone 0).
  const lowCLabel = `C${3 + octave}`;

  return (
    <svg
      className="panel"
      data-testid="keyboard-panel"
      viewBox={`0 0 ${KB_W} ${KB_H}`}
      xmlns="http://www.w3.org/2000/svg"
      role="group"
      aria-label="On-screen keyboard"
    >
      {/* panel face */}
      <rect
        x={0.5}
        y={0.5}
        width={KB_W - 1}
        height={KB_H - 1}
        rx={8}
        fill={COLORS.panel}
        stroke={COLORS.panelEdge}
        strokeWidth={1}
      />

      {/* divider between the control cluster and the keybed */}
      <line
        x1={CLUSTER_W}
        y1={10}
        x2={CLUSTER_W}
        y2={KB_H - 10}
        stroke={COLORS.panelEdge}
        strokeWidth={1}
      />

      {/* ---- left control cluster ---- */}

      {/* OCTAVE shift: OCT- / readout / OCT+. Buttons emit no data-testid of their
          own, so wrap each for the e2e click target (mirrors SamplerPanel). */}
      <g data-testid="octave-down">
        <Button def={OCT_DOWN_DEF} value="OFF" onChange={onOctDown} momentary x={OCT_DOWN.x} y={OCT_DOWN.y} />
      </g>
      <text
        data-testid="octave-readout"
        x={OCT_READOUT.x}
        y={OCT_READOUT.y + 4}
        textAnchor="middle"
        fontFamily={FONT_CONDENSED}
        fontSize={16}
        letterSpacing={1}
        fill={COLORS.legend}
      >
        {lowCLabel}
      </text>
      <text
        x={OCT_READOUT.x}
        y={OCT_READOUT.y + 22}
        textAnchor="middle"
        fontFamily={FONT_CONDENSED}
        fontSize={8}
        letterSpacing={1.5}
        fill={COLORS.legendDim}
      >
        OCTAVE
      </text>
      <g data-testid="octave-up">
        <Button def={OCT_UP_DEF} value="OFF" onChange={onOctUp} momentary x={OCT_UP.x} y={OCT_UP.y} />
      </g>

      {/* ENABLE MIDI + status LED/caption */}
      <g data-testid="enable-midi">
        <Button
          def={ENABLE_MIDI_DEF}
          value="OFF"
          onChange={onEnableMidi}
          momentary
          x={ENABLE_MIDI.x}
          y={ENABLE_MIDI.y}
        />
      </g>
      <g data-testid="midi-status">
        <circle
          cx={MIDI_STATUS_LED.x}
          cy={MIDI_STATUS_LED.y}
          r={5}
          fill={status.color}
          stroke={COLORS.panelShadow}
          strokeWidth={1}
        />
        <text
          x={MIDI_STATUS_TEXT.x}
          y={MIDI_STATUS_TEXT.y + 4}
          fontFamily={FONT_CONDENSED}
          fontSize={10}
          letterSpacing={1}
          fill={COLORS.legendDim}
          {...(status.text.length * 5.6 > 140
            ? { textLength: 140, lengthAdjust: 'spacingAndGlyphs' as const }
            : {})}
        >
          {status.text.toUpperCase()}
        </text>
      </g>

      {/* CLOCK MASTER indicator: amber LED + caption while external MIDI clock drives the studio.
          EARS: the panel TEMPO readout intentionally still shows the internal value while MIDI
          silently overrides timing (do not drive the readout from external tempo) — see report. */}
      <g data-testid="midi-clock-master" aria-label={clockMaster ? 'MIDI clock master' : 'Internal clock'}>
        <circle
          cx={CLOCK_MASTER_LED.x}
          cy={CLOCK_MASTER_LED.y}
          r={5}
          fill={clockMaster ? COLORS.ledAmber : COLORS.ledOff}
          stroke={COLORS.panelShadow}
          strokeWidth={1}
        />
        <text
          x={CLOCK_MASTER_TEXT.x}
          y={CLOCK_MASTER_TEXT.y + 4}
          fontFamily={FONT_CONDENSED}
          fontSize={10}
          letterSpacing={1}
          fill={clockMaster ? COLORS.ledAmber : COLORS.legendDim}
        >
          {clockMaster ? 'CLOCK MASTER' : 'INT CLOCK'}
        </text>
      </g>

      {/* PC KEYS latch */}
      <g data-testid="pc-keys">
        <Button
          def={PC_KEYS_DEF}
          value={pcKeysOn ? 'ON' : 'OFF'}
          onChange={onPcKeysToggle}
          lit={pcKeysOn}
          x={PC_KEYS.x}
          y={PC_KEYS.y}
        />
      </g>

      {/* ---- keybed: whites first, blacks painted on top ---- */}
      {WHITE_KEYS.map((k) => (
        <Key key={k.i} k={k} held={held.has(k.semitone)} onDown={onKeyDown} onUp={onKeyUp} onMove={onKeyMove} />
      ))}
      {BLACK_KEYS.map((k) => (
        <Key key={k.i} k={k} held={held.has(k.semitone)} onDown={onKeyDown} onUp={onKeyUp} onMove={onKeyMove} />
      ))}

      {/* ---- PC-key hint labels (which computer key plays each note) ----
          Painted last so they sit on top of the keys; a separate layer (not inside the
          memoized Key) so toggling the latch never re-renders the keybed. pointerEvents
          off so a click where a label sits still hits the key beneath it. Full strength
          while PC KEYS is live, dimmed when the labels are just documentation. Whites get
          a dark cap near their (black-free) lower end; blacks a light cap near their tip. */}
      <g style={{ pointerEvents: 'none' }} opacity={pcKeysOn ? 1 : 0.5}>
        {KEYS.filter((k) => SEMITONE_KEYCAP[k.semitone] != null).map((k) => (
          <text
            key={k.i}
            x={k.x + k.w / 2}
            y={k.y + k.h - (k.isBlack ? 6 : 8)}
            textAnchor="middle"
            fontFamily={FONT_CONDENSED}
            fontSize={11}
            fill={k.isBlack ? COLORS.legend : COLORS.panelShadow}
          >
            {SEMITONE_KEYCAP[k.semitone]}
          </text>
        ))}
      </g>
    </svg>
  );
}
