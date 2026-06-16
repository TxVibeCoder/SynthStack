/**
 * Engine bridge (work order §14.8) — the singleton seam between React and the
 * audio engine. React NEVER touches the Studio class directly:
 *
 *   knob drag      -> applyControlInput()  : IMMEDIATE imperative engine write, NO store write
 *   release/reset  -> applyControlCommit() : engine write + one store commit
 *   buttons        -> monarchRun()/anvilAdvance()/cascadePlay()/... Studio passthroughs
 *
 * The Studio instance is created lazily; constructing it allocates no audio
 * resources (the AudioContext is created inside studio.powerOn(), which must run
 * from a user gesture). The store IS studio.store — single source of truth; this
 * module keeps no second copy of any state.
 *
 * ROUTING TABLE — most control ids belong to their module's setControl(); the
 * exceptions live on the pure transports (sequencers / polyrhythm clock), whose
 * values the scheduler consumes outside the audio graph. classifyControl() is the
 * PURE classification of that table (unit-tested in Node, no AudioContext):
 *
 *   MON_TEMPO            -> monarchSeq.tempoBpm        knob is calibrated in BPM (20–300);
 *                                                  also re-runs applyTempoLink (§12.1)
 *   MON_SWING            -> monarchSeq.swingPct        0–100 %; the persistent copy lives in
 *                                                  store.transport.monarch.swingPct, written on
 *                                                  commit (Studio.syncTransportConfig mirrors
 *                                                  the transport slice back on store changes)
 *   MON_GLIDE            -> module ('module')      MonarchModule.setControl owns glideTimeS
 *   ANV_TEMPO           -> anvilSeq.rateHz         knob is calibrated in Hz step rate
 *                                                  (0.7–700); rateHz consumes Hz directly —
 *                                                  TEMPO CV offsets ride the jack, not here
 *   ANV_SEQ_PITCH_n     -> anvilSeq.steps[n-1].pitchVv     (+ store.transport on commit)
 *   ANV_SEQ_VELOCITY_n  -> anvilSeq.steps[n-1].velocityVv  (+ store.transport on commit)
 *   CAS_TEMPO           -> cascadeClock.tempoHz      knob in Hz (0.333–50, 1 PPQ)
 *   CAS_RHYTHM_n        -> cascadeClock.divisions[n-1]   divider knob 1..16 (CV offsets ride
 *                                                  divisionCvVv separately)
 *   CAS_RHYTHMn_SEQm    -> cascadeClock.assign[n-1][m-1]  ON/OFF assign buttons
 *   CAS_EG              -> cascadeClock.egMode AND cascade.setControl — the one id with two
 *                                                  owners: the clock gates egTrigger events,
 *                                                  the module forwards forceHeld to the EGs
 *   CAS_QUANTIZE, CAS_SEQ_OCT, CAS_SEQn_STEP_m, CAS_SEQn_ASSIGN_*  -> module
 *                                                  (CascadeModule.setControl owns them)
 *   everything else      -> module.setControl
 *
 * ANV_SEQ_PITCH_MOD (a switch) deliberately does NOT match the step-knob patterns
 * and falls through to the module. Transport buttons (MON_RUN_STOP, ANV_ADVANCE,
 * CAS_PLAY, ...) never come through applyControlInput — they use the dedicated
 * transport methods below; if routed anyway they fall through to the module's
 * setControl default case, a no-op.
 */

import { Studio } from '../engine/studio';
import {
  coalesceKeyboardState,
  coalesceSamplerState,
  defaultStudioState,
  defaultPad,
  defaultPattern,
  defaultSamplerState,
  QUANTIZE_DIVISIONS,
  type CableState,
  type PadState,
  type QuantizeDivision,
  type StudioState,
  type StudioStore,
} from '../state/studioState';
import { MonoVoice, noteToVv, type VoiceAction } from '../engine/voice/monoVoice';
import { WebMidiInput, type MidiStatus } from './midi/webMidiInput';
import type { EgMode } from '../engine/sequencers/cascadeClock';
import { buildJackIndex, validateCable, type CableValidation, type JackIndex } from '../engine/router';
import {
  assertSampleSize,
  exportSamples,
  importSamples,
  IndexedDbBackend,
  MemoryBackend,
  type SampleBackend,
} from '../engine/sampleStore';
import {
  buildBundle,
  buildPresetFilename,
  coalesceStudioState,
  collectUserSampleIds,
  parseBundle,
  parseSlot,
  serializeSlot,
  slotStorageKey,
} from '../state/presets';
import { getFactoryPreset } from '../state/factoryPresets';
import { FACTORY_KIT } from '../engine/factorySamples';
import { MODULES, controlDefaultModules } from '../engine/modules/moduleConfig';

/**
 * Module-level sample backend singleton (created once, audio-free). Bytes for user
 * uploads + factory markers persist here; the decoded AudioBuffers live in the engine
 * (D10 — only sample REFERENCES live in state). Falls back to an in-memory Map when
 * IndexedDB is absent (Node unit tests, restricted contexts).
 */
let sampleBackend: SampleBackend =
  typeof indexedDB !== 'undefined' ? new IndexedDbBackend() : new MemoryBackend();

/**
 * TEST-ONLY seam: swap the module-private sample backend for a controlled MemoryBackend so the
 * reference-aware byte-deletion gate (FIX 1) is observable from unit tests (the production
 * backend is otherwise unreachable). Returns the previous backend so a test can restore it —
 * mirroring how the preset tests swap globalThis.localStorage. Not used by production code.
 */
export function __setSampleBackendForTests(backend: SampleBackend): SampleBackend {
  const prev = sampleBackend;
  sampleBackend = backend;
  return prev;
}

// ---- pure routing table ---------------------------------------------------------------

export type ControlRoute =
  | 'module'
  | 'monarchTempo'
  | 'monarchSwing'
  | 'anvilTempo'
  | 'anvilStepPitch'
  | 'anvilStepVelocity'
  | 'cascadeTempo'
  | 'cascadeRhythmDiv'
  | 'cascadeRhythmAssign'
  | 'cascadeEg';

interface ParsedRoute {
  route: ControlRoute;
  /** 0-based step / rhythm-generator index (indexed routes only; 0 otherwise). */
  index: number;
  /** 0-based sequencer index (cascadeRhythmAssign only; 0 otherwise). */
  seq: 0 | 1;
}

/** PURE: classify a control id (with its 0-based indices) against the routing table. */
export function parseControlRoute(controlId: string): ParsedRoute {
  switch (controlId) {
    case 'MON_TEMPO':
      return { route: 'monarchTempo', index: 0, seq: 0 };
    case 'MON_SWING':
      return { route: 'monarchSwing', index: 0, seq: 0 };
    case 'ANV_TEMPO':
      return { route: 'anvilTempo', index: 0, seq: 0 };
    case 'CAS_TEMPO':
      return { route: 'cascadeTempo', index: 0, seq: 0 };
    case 'CAS_EG':
      return { route: 'cascadeEg', index: 0, seq: 0 };
    default:
      break;
  }
  let m = /^ANV_SEQ_(PITCH|VELOCITY)_([1-8])$/.exec(controlId);
  if (m) {
    return {
      route: m[1] === 'PITCH' ? 'anvilStepPitch' : 'anvilStepVelocity',
      index: Number(m[2]) - 1,
      seq: 0,
    };
  }
  m = /^CAS_RHYTHM_([1-4])$/.exec(controlId);
  if (m) return { route: 'cascadeRhythmDiv', index: Number(m[1]) - 1, seq: 0 };
  m = /^CAS_RHYTHM([1-4])_SEQ([12])$/.exec(controlId);
  if (m) {
    return { route: 'cascadeRhythmAssign', index: Number(m[1]) - 1, seq: (Number(m[2]) - 1) as 0 | 1 };
  }
  return { route: 'module', index: 0, seq: 0 };
}

/** PURE: route classification only (the unit-tested surface). */
export function classifyControl(controlId: string): ControlRoute {
  return parseControlRoute(controlId).route;
}

// ---- bridge ----------------------------------------------------------------------------

export interface TransportFlags {
  monarchRunning: boolean;
  anvilRunning: boolean;
  cascadePlaying: boolean;
  drumRunning: boolean;
}

/** Store mirror for continuous mixer/master drags — debounced ≥100 ms (CONVENTIONS.md). */
const STORE_MIRROR_DEBOUNCE_MS = 150;

/**
 * localStorage key holding the JSON string[] of saved slot names (g3-owned). It lives OUTSIDE
 * the SLOT_PREFIX ('synthstack-preset:') namespace — note the trailing HYPHEN, no colon — so
 * NO `slotStorageKey(name)` (== SLOT_PREFIX + name, always colon-prefixed) can ever equal it.
 * This is load-bearing: a user who names a slot '__index__' previously produced
 * slotStorageKey('__index__') === the old index key, so saveSlot('__index__') wrote a slot
 * wrapper over the index and dropped every other saved slot (data loss). With the key outside
 * the namespace, any slot name — '__index__' included — is just another harmless slot.
 */
const INDEX_KEY = 'synthstack-preset-index';

/** Per-slot localStorage payload (g3-owned wrapper around g1's StudioState codec). */
interface SlotWrapper {
  version: 1;
  savedAt: number;
  state: StudioState;
}

class EngineBridge {
  private studioInstance: Studio | null = null;
  private _powered = false;

  // ---- keyboard / Web MIDI live play (shared mono voice) ------------------------------
  // The on-screen piano AND Web MIDI input BOTH call noteOn/noteOff, so they share ONE
  // mono last-note stack (this.voice) and one Web MIDI connection (this.midi). Octave is
  // applied EXACTLY ONCE, here in applyVoiceAction, as +keyboardOctave on the vv after
  // (note-60)/12 — the panel sends raw notes (keyToNote(semitone, 0)), so no double-shift.
  private readonly voice = new MonoVoice();
  private readonly midi = new WebMidiInput();
  private keyboardOctave = 0;

  // pending debounced store mirrors for mixer drags (engine writes are immediate)
  private readonly pendingLevels: [number | null, number | null, number | null, number | null] = [
    null,
    null,
    null,
    null,
  ];
  private pendingMaster: number | null = null;
  private mirrorTimer: ReturnType<typeof setTimeout> | null = null;

  // Mid-drag (uncommitted) engine values for the transport-mirrored knobs.
  // Studio.syncTransportConfig reassigns monarchSeq.swingPct / anvilSeq.steps from the
  // last COMMITTED transport slice on EVERY store notification, so an unrelated
  // store write landing mid-drag (another control's commit, or the debounced mixer
  // mirror firing ~150 ms into a new drag) would snap the in-flight engine value
  // back to its stale committed value. Recorded on input, cleared on commit, and
  // re-applied by reapplyLiveTransport(), subscribed AFTER the Studio's listener
  // so every sync is immediately corrected.
  private liveSwingPct: number | null = null;
  private readonly livePitchVv: (number | null)[] = Array.from({ length: 8 }, () => null);
  private readonly liveVelocityVv: (number | null)[] = Array.from({ length: 8 }, () => null);
  private liveTransportGuardOn = false;

  /** Lazy Studio. Constructing it is audio-free; powerOn() makes the AudioContext. */
  private get studio(): Studio {
    if (!this.studioInstance) this.studioInstance = new Studio();
    return this.studioInstance;
  }

  /** THE store (studio.store) — single source of truth, available before power-on. */
  get store(): StudioStore {
    return this.studio.store;
  }

  get powered(): boolean {
    return this._powered;
  }

  /** Must be called from a user gesture. Builds the graph, then pushes the whole store tree in. */
  async powerOn(): Promise<void> {
    const studio = this.studio;
    await studio.powerOn();
    const state = studio.store.getState();
    state.power = true;
    // _powered is flipped BEFORE applyFullState (a deliberate, safe reordering vs the old
    // applyState-before-_powered): studio.applyState never reads bridge._powered, and
    // pushCascadeClockControls -> applyControlInput guards on _powered, so the powered branch
    // of applyFullState must run with _powered already true to route the clock-owned ids.
    this._powered = true;
    this.applyFullState(state); // store.setState + applyState + pushCascadeClockControls + keyboardOctave seed
    // Render the factory kit, then reload buffers. (An INIT double-clicked DURING this first-ever
    // render is a documented, self-healing minor: the pads' state stays correct and this very
    // reloadPadBuffers — running after the render with the captured default-kit state — repopulates
    // them; flipping _powered earlier to "fix" it only slows power-on and is not worth it.)
    await this.studio.loadFactorySamples(); // render + register factory buffers
    void this.studio.reloadPadBuffers(state.sampler, sampleBackend); // fire-and-forget; decode user samples
    this.startChase();
    if (!this.liveTransportGuardOn) {
      this.liveTransportGuardOn = true;
      // Subscribed after Studio.powerOn() registered syncTransportConfig, so this
      // listener runs after it on every notification (Set preserves insertion order).
      studio.store.subscribe(() => this.reapplyLiveTransport());
    }
  }

  async powerOff(): Promise<void> {
    // Drop any held keyboard/MIDI note first so power-off never strands the shared gate
    // high (a stuck gate would also block the sequencer voice). Runs while still powered
    // so the gateOff actually reaches the engine.
    this.releaseAllNotes();
    this._powered = false;
    this.stopChase();
    if (!this.studioInstance) return;
    const state = this.studioInstance.store.getState();
    state.power = false;
    this.studioInstance.store.setState(state);
    await this.studioInstance.powerOff();
  }

  // ---- control routing -------------------------------------------------------------

  /**
   * Knob-drag path: IMMEDIATE engine write, NO store write (work order §14.8 — drags
   * must not re-render the world). No-op while unpowered (commits still hit the store).
   */
  applyControlInput(moduleId: string, controlId: string, value: number | string): void {
    if (!this._powered) return;
    const studio = this.studio;
    const parsed = parseControlRoute(controlId);
    const num = typeof value === 'number' ? value : 0;
    switch (parsed.route) {
      case 'monarchTempo':
        // BPM knob; transports are scheduler-side, not module-side
        studio.monarchSeq.tempoBpm = num;
        studio.applyTempoLink(); // linked Anvil/Cascade re-slave to the new BPM (§12.1)
        return;
      case 'monarchSwing':
        this.liveSwingPct = num; // guard against syncTransportConfig until commit
        studio.monarchSeq.swingPct = num;
        return;
      case 'anvilTempo':
        // knob gives Hz step rate directly (data/anvil.json: 0.7–700 Hz, exp)
        studio.anvilSeq.rateHz = num;
        return;
      case 'anvilStepPitch':
        this.livePitchVv[parsed.index] = num; // guard against syncTransportConfig until commit
        studio.anvilSeq.steps[parsed.index]!.pitchVv = num;
        return;
      case 'anvilStepVelocity':
        this.liveVelocityVv[parsed.index] = num; // guard against syncTransportConfig until commit
        studio.anvilSeq.steps[parsed.index]!.velocityVv = num;
        return;
      case 'cascadeTempo':
        // knob gives Hz tick rate directly (data/cascade.json: 0.333–50 Hz)
        studio.cascadeClock.tempoHz = num;
        return;
      case 'cascadeRhythmDiv':
        studio.cascadeClock.divisions[parsed.index] = num;
        return;
      case 'cascadeRhythmAssign':
        studio.cascadeClock.assign[parsed.index]![parsed.seq] = value === 'ON';
        return;
      case 'cascadeEg': {
        // two owners: clock engine gates egTrigger events; module forwards forceHeld
        const mode: EgMode = value === 'OFF' ? 'OFF' : value === 'HELD' ? 'HELD' : 'ON';
        studio.cascadeClock.egMode = mode;
        studio.cascade.setControl(controlId, value);
        return;
      }
      case 'module':
        this.moduleFor(moduleId).setControl(controlId, value);
        return;
    }
  }

  /**
   * Release path: engine write + ONE store commit. Controls whose engine value is
   * mirrored from store.transport (Monarch swing, Anvil step rows — see
   * Studio.syncTransportConfig) update that transport slice in the SAME setState,
   * otherwise the next store notification would clobber the engine write — and they
   * clear their live-drag record first (the committed slice now carries the value).
   * A DIFFERENT control still mid-drag survives this notification because
   * reapplyLiveTransport() re-asserts its live value right after the sync.
   */
  applyControlCommit(moduleId: string, controlId: string, value: number | string): void {
    this.applyControlInput(moduleId, controlId, value);
    const parsed = parseControlRoute(controlId);
    const num = typeof value === 'number' ? value : 0;
    switch (parsed.route) {
      case 'monarchSwing': {
        this.liveSwingPct = null;
        const s = this.store.getState();
        (s.controls[moduleId] ??= {})[controlId] = value;
        s.transport.monarch.swingPct = num;
        this.store.setState(s);
        return;
      }
      case 'anvilStepPitch': {
        this.livePitchVv[parsed.index] = null;
        const s = this.store.getState();
        (s.controls[moduleId] ??= {})[controlId] = value;
        s.transport.anvil.steps[parsed.index]!.pitchVv = num;
        this.store.setState(s);
        return;
      }
      case 'anvilStepVelocity': {
        this.liveVelocityVv[parsed.index] = null;
        const s = this.store.getState();
        (s.controls[moduleId] ??= {})[controlId] = value;
        s.transport.anvil.steps[parsed.index]!.velocityVv = num;
        this.store.setState(s);
        return;
      }
      default:
        this.store.setControl(moduleId, controlId, value);
    }
  }

  private moduleFor(moduleId: string): { setControl(id: string, value: number | string): void } {
    const s = this.studio;
    return moduleId === 'monarch' ? s.monarch : moduleId === 'anvil' ? s.anvil : s.cascade;
  }

  /**
   * Re-assert mid-drag engine values after Studio.syncTransportConfig re-applied the
   * committed transport slice (it runs on EVERY store notification — see the field
   * comments above). Engine-field writes only; no store writes, so no recursion.
   */
  private reapplyLiveTransport(): void {
    const studio = this.studioInstance;
    if (!studio) return;
    if (this.liveSwingPct != null) studio.monarchSeq.swingPct = this.liveSwingPct;
    for (let i = 0; i < 8; i++) {
      const step = studio.anvilSeq.steps[i];
      if (!step) continue;
      const pitch = this.livePitchVv[i];
      if (pitch != null) step.pitchVv = pitch;
      const velocity = this.liveVelocityVv[i];
      if (velocity != null) step.velocityVv = velocity;
    }
  }

  /**
   * Studio.applyState routes control values through module.setControl (plus the three
   * TEMPO special cases) — it never touches studio.cascadeClock. RHYTHM dividers, the
   * assign matrix and the clock half of CAS_EG edited while unpowered (commits hit
   * the store; engine writes are no-ops) would otherwise keep the polyrhythm clock's
   * constructor defaults after power-on. Re-push those families through the bridge's
   * own routing table. Must run with _powered already true.
   */
  private pushCascadeClockControls(state: StudioState): void {
    const controls = state.controls['cascade'];
    if (!controls) return;
    for (const [controlId, value] of Object.entries(controls)) {
      const route = classifyControl(controlId);
      if (route === 'cascadeRhythmDiv' || route === 'cascadeRhythmAssign' || route === 'cascadeEg') {
        this.applyControlInput('cascade', controlId, value);
      }
    }
  }

  // ---- transport actions (all no-ops while unpowered) -------------------------------

  monarchRun(): void {
    if (this._powered) this.studio.monarchRun();
  }

  monarchStop(): void {
    if (this._powered) this.studio.monarchStop();
  }

  monarchReset(): void {
    if (this._powered) this.studio.monarchReset();
  }

  /** HOLD: down=true on pointerdown, false on release. */
  monarchHold(down: boolean): void {
    if (this._powered) this.studio.monarchHold(down);
  }

  anvilRun(): void {
    if (this._powered) this.studio.anvilRun();
  }

  anvilStop(): void {
    if (this._powered) this.studio.anvilStop();
  }

  /** ADVANCE: one step, no trigger. */
  anvilAdvance(): void {
    if (this._powered) this.studio.anvilManualAdvance();
  }

  /** TRIGGER: fire current step, no advance. */
  anvilTrigger(): void {
    if (this._powered) this.studio.anvilManualTrigger();
  }

  cascadePlay(): void {
    if (this._powered) this.studio.cascadePlay();
  }

  cascadeStop(): void {
    if (this._powered) this.studio.cascadeStop();
  }

  /** RESET: no arg = one-shot; held=true/false brackets a press-and-hold (pins step 1). */
  cascadeReset(held?: boolean): void {
    if (this._powered) this.studio.cascadeReset(held);
  }

  /** NEXT: advance without EG retrigger. */
  cascadeNext(): void {
    if (this._powered) this.studio.cascadeNext();
  }

  /** TRIGGER button (momentary): behavior depends on the current EG mode (C.3). */
  cascadeTriggerButton(down: boolean): void {
    if (this._powered) this.studio.cascadeTriggerButton(down);
  }

  runAll(): void {
    if (this._powered) this.studio.runAll();
  }

  stopAll(): void {
    if (this._powered) this.studio.stopAll();
  }

  /** TEMPO LINK is a discrete switch: engine write + immediate store commit. */
  setTempoLink(on: boolean): void {
    if (this._powered) this.studio.setTempoLink(on);
    const s = this.store.getState();
    s.mixer.tempoLink = on;
    this.store.setState(s);
  }

  /** Mixer channel level: immediate engine write; store mirror debounced (drag-safe). */
  setMixerLevel(channel: number, level01: number): void {
    if (channel < 0 || channel > 3) return;
    if (this._powered) this.studio.setMixerLevel(channel, level01);
    this.pendingLevels[channel as 0 | 1 | 2 | 3] = level01;
    this.scheduleStoreMirror();
  }

  /** Master volume: immediate engine write; store mirror debounced (drag-safe). */
  setMasterVolume(v01: number): void {
    if (this._powered) this.studio.setMasterVolume(v01);
    this.pendingMaster = v01;
    this.scheduleStoreMirror();
  }

  // ---- recording (feature: recording; consumed by UtilityStrip RECORD button) ----------
  // The recorder lives in StudioContext (it needs the private AudioContext + softClip — the
  // final audible node); the bridge ONLY forwards. It owns NO recorder state of its own.
  // The master chain still feeds ctx.destination, so monitoring continues while recording.
  // Auto-stop+flush on power-off rides StudioContext.powerOff (awaited via powerOff above) —
  // there is NO bridge-level stop, and resetAll deliberately does NOT stop recording
  // (recording is runtime-only, orthogonal to INIT, which leaves the context running).

  /**
   * Start capturing the master output. No-op while unpowered (the engine recorder only
   * exists post-power-on inside StudioContext). The boolean studio.startRecording() returns
   * is discarded at the seam — the UI reads truth from getRecordingState(). Never throws
   * (the engine recorder degrades to false when MediaRecorder is unavailable).
   */
  startRecording(): void {
    if (this._powered) this.studio.startRecording();
  }

  /**
   * Stop the in-flight recording. Fire-and-forget: blob assembly + the <a download> trigger
   * ride inside the recorder's onstop, so the returned Promise is voided here. No-op while
   * unpowered. Never throws.
   */
  stopRecording(): void {
    if (this._powered) void this.studio.stopRecording();
  }

  /**
   * Recording snapshot for the UI poll (useRecordingState). Reads this.studioInstance
   * DIRECTLY (not the lazy `this.studio` getter) so a poll BEFORE first power-on never
   * constructs a Studio; returns the idle default {recording:false, elapsedMs:0} when no
   * Studio exists yet (and a fresh StudioContext returns the same default anyway).
   */
  getRecordingState(): { recording: boolean; elapsedMs: number } {
    return this.studioInstance
      ? this.studioInstance.getRecordingState()
      : { recording: false, elapsedMs: 0 };
  }

  // ---- keyboard / Web MIDI note surface (feature: keyboard; consumed by KeyboardPanel) --
  // The on-screen piano AND Web MIDI both call noteOn/noteOff so they share ONE mono
  // last-note stack (this.voice). The allocator runs UNCONDITIONALLY (so the held-note
  // stack stays correct across a power toggle, exactly like setPadLoop/drumRun keep the
  // store correct unpowered); only the engine WRITE is guarded by _powered, inside
  // applyVoiceAction. Octave is applied ONCE there as +keyboardOctave on the vv.

  /**
   * Note ON from the keyboard / MIDI (velocity v1 maps to gate only — a velocity->VCA-CV
   * map is a documented BACKLOG follow-up). velocity === 0 is the MIDI running-status
   * note-off convention, so re-route it to noteOff (mirrors the shell's parser, but guards
   * the on-screen path too). Drives the mono allocator -> applyVoiceAction.
   */
  noteOn(noteNumber: number, velocity: number): void {
    if (velocity === 0) return this.noteOff(noteNumber);
    this.applyVoiceAction(this.voice.noteOn(noteNumber));
  }

  /** Note OFF from the keyboard / MIDI. Drives the mono allocator -> applyVoiceAction. */
  noteOff(noteNumber: number): void {
    this.applyVoiceAction(this.voice.noteOff(noteNumber));
  }

  /**
   * OCTAVE shift (-3..+3, clamped to match coalesceKeyboardState). The store commit goes
   * through coalesceKeyboardState so the persisted slice is always a complete, clamped
   * KeyboardState. Does NOT re-pitch a currently-held note — the new octave takes effect on
   * the NEXT keypress (hardware-like; documented). Safe unpowered (store-only).
   */
  setKeyboardOctave(n: number): void {
    const octave = coalesceKeyboardState({ octave: n }).octave;
    this.keyboardOctave = octave;
    const s = this.store.getState();
    s.keyboard = coalesceKeyboardState({ octave });
    this.store.setState(s);
  }

  /** Current keyboard octave (KeyboardPanel snapshot source). Coalesce-safe before power-on. */
  getKeyboardOctave(): number {
    return coalesceKeyboardState(this.store.getState().keyboard).octave;
  }

  /**
   * Enable Web MIDI (the ONE permission prompt). Wires the shell's note callbacks to THIS
   * bridge's noteOn/noteOff so MIDI shares the same mono voice as the on-screen keyboard —
   * a MIDI note-on/off and an on-screen key press feed the identical last-note stack. The
   * shell's third (panic) callback fires releaseAllNotes() on a hot-unplug-to-zero: a device
   * yanked mid-note can no longer deliver its note-off, so without this the shared kbGate
   * stays high and also jams the sequencer voice — this is the documented hung-gate path #3,
   * alongside power-off / INIT / panel blur. Idempotent (a second call while enabled returns
   * the current status without re-prompting; a call while the prompt is in flight shares it).
   * Resolves { state:'unsupported' } (never throws) when navigator.requestMIDIAccess is absent
   * (Node / jsdom / non-secure context).
   */
  enableMidi(): Promise<MidiStatus> {
    return this.midi.enable(
      (note, velocity) => this.noteOn(note, velocity),
      (note) => this.noteOff(note),
      () => this.releaseAllNotes(),
    );
  }

  /** Web MIDI connection status (KeyboardPanel poll source). Initial { state:'disabled', ... }. */
  getMidiStatus(): MidiStatus {
    return this.midi.status;
  }

  /**
   * Panic: drop every held note + gate (the shared voice means a stranded gate also blocks
   * the sequencer). Called by the panel on pointercancel/blur, by the MIDI shell on a
   * hot-unplug-to-zero, and by powerOff + resetAll.
   */
  releaseAllNotes(): void {
    this.applyVoiceAction(this.voice.allNotesOff());
  }

  /**
   * Apply one allocator VoiceAction to the Monarch voice. The allocator has ALREADY run (the
   * held-note stack is correct regardless of power), so this only performs the engine WRITE,
   * and only when powered. Octave is applied HERE — the ONLY place — as +keyboardOctave on
   * the vv AFTER noteToVv((note-60)/12), so the panel's raw notes never double-shift.
   *   gate 'on'        -> studio.monarchNoteOn(noteToVv(note)+octave, retrigger)
   *   gate 'off'       -> studio.monarchNoteOff()
   *   gate 'unchanged' -> nothing (a held lower note released; the voice did not change)
   */
  private applyVoiceAction(a: VoiceAction): void {
    if (!this._powered) return;
    if (a.gate === 'on' && a.note != null) {
      this.studio.monarchNoteOn(noteToVv(a.note) + this.keyboardOctave, a.retrigger);
    } else if (a.gate === 'off') {
      this.studio.monarchNoteOff();
    }
    // a.gate === 'unchanged': no engine write
  }

  /** Polled by useTransportFlags (stage 1) — reads the pure transports, no store. */
  getTransportFlags(): TransportFlags {
    const s = this.studio;
    return {
      monarchRunning: s.monarchSeq.running,
      anvilRunning: s.anvilSeq.running,
      cascadePlaying: s.cascadeClock.running,
      // samplerSeq is an eagerly-constructed readonly field (like monarchSeq); isPlaying() is
      // false on the fresh instance, so this is safe to read before power-on.
      drumRunning: s.samplerSeq.isPlaying(),
    };
  }

  // ---- step-LED chase (stage 3, work order §9.1 rAF drain) ----------------------------

  private readonly stepPositions = { monarch: -1, anvil: -1, cascade: [-1, -1] as [number, number], drum: -1 };
  private readonly stepListeners = new Set<() => void>();
  private rafId: number | null = null;

  /** Current chase position for a machine (−1 = none yet). Stable primitives. */
  getStepPosition(machine: 'monarch' | 'anvil' | 'drum'): number;
  getStepPosition(machine: 'cascade', seq: 0 | 1): number;
  getStepPosition(machine: 'monarch' | 'anvil' | 'cascade' | 'drum', seq?: 0 | 1): number {
    if (machine === 'cascade') return this.stepPositions.cascade[seq ?? 0];
    return this.stepPositions[machine];
  }

  subscribeStepPositions(listener: () => void): () => void {
    this.stepListeners.add(listener);
    return () => this.stepListeners.delete(listener);
  }

  /**
   * rAF pump: pops UI events whose audio time has arrived (§9.1 — the scheduler
   * queues them when scheduling; the chase only READS, never times audio).
   * The two 'step' event emitters are distinguished by payload: the Anvil step
   * carries pitchVv/velocityVv, the Monarch step does not.
   */
  private chase = (): void => {
    const studio = this.studioInstance;
    if (studio && this._powered) {
      const due = studio.scheduler.drainUi(studio.context.audioContext.currentTime);
      let changed = false;
      for (const e of due) {
        if (e.type === 'step') {
          const idx = e.data?.['stepIndex'] as number;
          if (e.data && 'pitchVv' in e.data) {
            if (this.stepPositions.anvil !== idx) {
              this.stepPositions.anvil = idx;
              changed = true;
            }
          } else if (this.stepPositions.monarch !== idx) {
            this.stepPositions.monarch = idx;
            changed = true;
          }
        } else if (e.type === 'pitchUpdate') {
          const seq = e.data?.['seq'] as 0 | 1;
          const idx = e.data?.['stepIndex'] as number;
          if (this.stepPositions.cascade[seq] !== idx) {
            this.stepPositions.cascade[seq] = idx;
            changed = true;
          }
        } else if (e.type === 'drumStep') {
          // The drum column marker (distinct type — no payload-sniff collision with the
          // monarch/anvil 'step' disambiguation). The co-queued 'drumHit' events have no branch
          // here; drainUi already popped them, so they neither leak nor accumulate.
          const idx = e.data?.['stepIndex'] as number;
          if (this.stepPositions.drum !== idx) {
            this.stepPositions.drum = idx;
            changed = true;
          }
        }
      }
      if (changed) for (const l of this.stepListeners) l();
    }
    this.rafId = requestAnimationFrame(this.chase);
  };

  private startChase(): void {
    if (this.rafId === null && typeof requestAnimationFrame !== 'undefined') {
      this.rafId = requestAnimationFrame(this.chase);
    }
  }

  private stopChase(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  // ---- Monarch step editing (stage 3, work order §9.3) -------------------------------------
  // One store commit per edit; Studio.syncTransportConfig mirrors the transport
  // slice into the live sequencer on every store notification, so no direct
  // engine write is needed here.

  updateMonarchStep(index: number, patch: Partial<StudioState['transport']['monarch']['steps'][number]>): void {
    if (index < 0 || index > 31) return;
    const s = this.store.getState();
    const step = s.transport.monarch.steps[index];
    if (!step) return;
    Object.assign(step, patch);
    this.store.setState(s);
  }

  setMonarchEndStep(endStep: number): void {
    const s = this.store.getState();
    s.transport.monarch.endStep = Math.min(32, Math.max(1, Math.round(endStep)));
    this.store.setState(s);
  }

  // ---- patching (stage 2, work order §8.2) -------------------------------------------

  /** Lazy jack index over the module JSONs (validation only — no audio). Includes
   *  samplerDef so CableLayer's validatePatch/isOutputJack accept SAMP_* jacks — this
   *  cache is separate from the engine's router index built in studio.ts. */
  private get jackIndex(): JackIndex {
    if (!this.jackIndexCache) {
      // ALL four defs (incl. sampler) — derived from the MODULES registry so this stays in
      // lockstep with the build. The sampler def is required so CableLayer accepts SAMP_* jacks.
      this.jackIndexCache = buildJackIndex(MODULES.map((m) => m.def));
    }
    return this.jackIndexCache;
  }
  private jackIndexCache: JackIndex | null = null;

  /** out→in only; one cable per input; signal warnings (router rules). */
  validatePatch(from: string, to: string): CableValidation {
    return validateCable(from, to, this.jackIndex, { cables: this.store.getState().cables });
  }

  isOutputJack(jackId: string): boolean {
    return this.jackIndex.outputs.has(jackId);
  }

  /** Replace the cable set: one store commit + live router rewire when powered. */
  commitCables(cables: CableState[]): void {
    const s = this.store.getState();
    s.cables = cables.map((c) => ({ ...c }));
    this.store.setState(s);
    if (this._powered) this.studio.patch(s.cables);
  }

  // ---- sampler pads (feature-sampler-pads; consumed by SamplerPanel) -------------------
  // Pad LEVEL/TUNE live in state.sampler.pads[n] — NOT state.controls — so they go
  // through setPadControl/commitPadControl, never useControl('sampler', id). The
  // sampler.json knobs exist ONLY for validation + Knob rendering and are never routed
  // through parseControlRoute/applyControlInput (applyState's controls loop skips the
  // 'sampler' module id). All engine writes are no-ops while unpowered.

  /**
   * Click-to-audition a pad. Forwards to studio.launchPad, which decides
   * one-shot-vs-loop-launch-vs-loop-stop and quantizes to the SAMP_QUANTIZE grid.
   * With the master stopped (or QUANTIZE OFF) this is the immediate one-shot of old.
   * No-op when unpowered.
   */
  auditionPad(padIndex: number): void {
    if (this._powered) this.studio.launchPad(padIndex);
  }

  /**
   * Load a user sample onto a pad: persist bytes to the backend (size-capped) and
   * commit the pad's {sampleId, sampleName} ref to the store. When powered, also decode
   * the bytes and write the buffer into the engine. Throws SampleTooLargeError (caught
   * by the panel) before any read if the file exceeds MAX_SAMPLE_BYTES. While unpowered
   * the bytes + ref still persist; reloadPadBuffers picks the buffer up on next power-on.
   */
  async loadPadSample(padIndex: number, file: File): Promise<void> {
    assertSampleSize(file.size); // early reject before reading (throws SampleTooLargeError)
    const bytes = await file.arrayBuffer();
    // Decode BEFORE persisting so a non-audio drop (drag-drop bypasses accept="audio/*")
    // stores nothing — decodeAudioData rejects here and we never reach put(). decodeAudioData
    // detaches its buffer, so feed it a private slice and keep `bytes` for the backend.
    let decoded: AudioBuffer | null = null;
    if (this._powered) {
      decoded = await this.studio.audioContextForDecode().decodeAudioData(bytes.slice(0));
    }
    const rec = await sampleBackend.put({
      name: file.name,
      mime: file.type || 'application/octet-stream',
      bytes,
    });
    if (decoded) this.studio.loadPadBuffer(padIndex, decoded);
    const s = this.store.getState();
    s.sampler ??= defaultSamplerState(); // coalesce a missing slice (older saved trees)
    const prev = s.sampler.pads[padIndex] ?? defaultPad();
    const prevId = prev.sampleId;
    s.sampler.pads[padIndex] = { ...prev, sampleId: rec.id, sampleName: file.name };
    this.store.setState(s);
    // Free the replaced sample's bytes — BUT only when truly unreferenced (FIX 1): the SAME
    // sample may still sit on another pad in the POST-COMMIT store state (`s`), or be referenced
    // by a saved slot the user never reopened. The reference gate blocks the delete in either
    // case (and always blocks empty/factory ids), so growth-control stays correct without
    // stranding a shared sample. `s` already carries the new id on `padIndex`.
    if (prevId && prevId !== rec.id && this.isUserSampleUnreferenced(prevId, [s])) {
      void sampleBackend.delete(prevId);
    }
  }

  /**
   * Knob-drag path: IMMEDIATE engine write only, NO store write (mirrors
   * applyControlInput). No-op while unpowered.
   */
  setPadControl(padIndex: number, control: 'level' | 'tuneSemis', value: number): void {
    if (!this._powered) return;
    if (control === 'level') this.studio.setPadLevel(padIndex, value);
    else this.studio.setPadTune(padIndex, value);
  }

  /** Release path: engine write + ONE store commit (mirrors applyControlCommit). */
  commitPadControl(padIndex: number, control: 'level' | 'tuneSemis', value: number): void {
    this.setPadControl(padIndex, control, value);
    const s = this.store.getState();
    s.sampler ??= defaultSamplerState(); // coalesce a missing slice (older saved trees)
    const prev = s.sampler.pads[padIndex] ?? defaultPad();
    s.sampler.pads[padIndex] = { ...prev, [control]: value };
    this.store.setState(s);
  }

  /**
   * Per-pad LOOP toggle (loop-quantize feature). A discrete switch: immediate engine
   * write + ONE store commit (mirrors setTempoLink). Toggling LOOP does NOT itself
   * launch/stop audio — it changes which path the NEXT auditionPad tap takes
   * (declarative; "tap launches, tap again stops"). Engine write is a no-op unpowered.
   */
  setPadLoop(padIndex: number, on: boolean): void {
    if (this._powered) this.studio.setPadLoop(padIndex, on);
    const s = this.store.getState();
    s.sampler = coalesceSamplerState(s.sampler);
    s.sampler.pads[padIndex] = { ...(s.sampler.pads[padIndex] ?? defaultPad()), loop: on };
    this.store.setState(s);
  }

  /**
   * Per-pad FACTORY picker (factory-sounds feature). Assign any FACTORY_KIT sound to a pad:
   * write the in-memory ±1.0 buffer into the engine (when powered), then commit the pad's
   * {sampleId, sampleName} ref to the store. This is the picker's ONLY write path — a direct
   * store write would bypass the reference-gated free below and could orphan the bytes of a
   * user sample this pad previously held. Drag-drop a user file still overrides (loadPadSample,
   * last-action-wins). Factory ids carry no bytes, so there is NO sampleBackend.put here.
   */
  assignFactoryToPad(padIndex: number, factoryId: string): void {
    if (padIndex < 0 || padIndex > 7) return; // guard the pad index
    // Guard the id against the manifest; a non-manifest/unknown id (incl. any user id) is a no-op.
    const entry = FACTORY_KIT.find((e) => e.id === factoryId);
    if (!entry) return;
    // Immediate engine write when powered (no-op unpowered) — resolves factoryBuffers in-memory.
    if (this._powered) this.studio.loadPadBufferFromFactory(padIndex, factoryId);
    const s = this.store.getState();
    s.sampler = coalesceSamplerState(s.sampler);
    const prev = s.sampler.pads[padIndex] ?? defaultPad();
    const prevId = prev.sampleId;
    s.sampler.pads[padIndex] = { ...prev, sampleId: entry.id, sampleName: entry.name };
    this.store.setState(s);
    // Free the REPLACED user sample's bytes — but only when truly unreferenced (FIX 1). A
    // factory/empty prevId frees nothing (isUserSampleUnreferenced returns false for them), and a
    // user id still on another pad in `s` or referenced by a saved slot is kept. `s` already
    // carries the new (factory) id on padIndex, so the gate sees the post-commit live state.
    if (prevId && prevId !== entry.id && this.isUserSampleUnreferenced(prevId, [s])) {
      void sampleBackend.delete(prevId);
    }
  }

  /**
   * Global QUANTIZE selector (loop-quantize feature). The launch-alignment grid for
   * UI taps + loop re-launch/stop, synced to the Monarch master. Immediate engine write +
   * ONE store commit. Engine write is a no-op unpowered.
   */
  setQuantize(division: QuantizeDivision): void {
    if (!QUANTIZE_DIVISIONS.includes(division)) return; // defensive
    if (this._powered) this.studio.setSamplerQuantize(division);
    const s = this.store.getState();
    s.sampler = coalesceSamplerState(s.sampler);
    s.sampler.quantize = division;
    this.store.setState(s);
  }

  /** Current QUANTIZE division (SamplerPanel snapshot source). Coalesces missing slice. */
  getQuantize(): QuantizeDivision {
    return coalesceSamplerState(this.store.getState().sampler).quantize;
  }

  /** Live LOOP-sounding read for the panel LED (runtime audio state, never serialized). */
  isPadLoopSounding(padIndex: number): boolean {
    return this._powered && this.studio.samplerLoopSounding(padIndex);
  }

  /** Current pad meta (SamplerPanel snapshot source). Coalesces missing slice/pad. */
  getPadState(padIndex: number): PadState {
    return coalesceSamplerState(this.store.getState().sampler).pads[padIndex] ?? defaultPad();
  }

  // ---- drum step sequencer (feature: drum machine; consumed by DrumMachinePanel) -------
  // An 8x16 on/off pattern (track t = pad t) stepped one column per master 16th by the
  // SamplerStepSeq citizen. Mirrors the pad LOOP/QUANTIZE bridge idiom EXACTLY: immediate
  // engine write when powered (no-op unpowered), then ONE store commit through
  // coalesceSamplerState so the persisted slice is always a complete 8x16 strict-boolean grid.

  /** RUN: start the grid (engine, when powered) + persist seqRunning=true. */
  drumRun(): void {
    if (this._powered) this.studio.drumRun();
    const s = this.store.getState();
    s.sampler = coalesceSamplerState(s.sampler);
    s.sampler.seqRunning = true;
    this.store.setState(s);
  }

  /** STOP: stop the grid (engine, when powered) + persist seqRunning=false. */
  drumStop(): void {
    if (this._powered) this.studio.drumStop();
    const s = this.store.getState();
    s.sampler = coalesceSamplerState(s.sampler);
    s.sampler.seqRunning = false;
    this.store.setState(s);
  }

  /**
   * Set one cell (track = pad 0..7, step 0..15). Bounds-guarded (mirror updateMonarchStep) so
   * an out-of-range index is a no-op and never produces a ragged write. Immediate engine
   * write + ONE coalesced store commit — coalesce guarantees row [track] is a full 16-len
   * array, so [step]! is index-safe.
   */
  setDrumStep(track: number, step: number, on: boolean): void {
    if (track < 0 || track > 7 || step < 0 || step > 15) return;
    if (this._powered) this.studio.setDrumStep(track, step, on);
    const s = this.store.getState();
    s.sampler = coalesceSamplerState(s.sampler);
    s.sampler.pattern[track]![step] = on;
    this.store.setState(s);
  }

  /** Flip one cell (read current via coalesce, write the inverse through setDrumStep). */
  toggleStep(track: number, step: number): void {
    if (track < 0 || track > 7 || step < 0 || step > 15) return;
    const cur = coalesceSamplerState(this.store.getState().sampler).pattern[track]?.[step] ?? false;
    this.setDrumStep(track, step, !cur); // single coalesced commit happens inside setDrumStep
  }

  /** CLEAR: zero the whole grid (engine, when powered) + persist an all-false 8x16 pattern. */
  clearDrumPattern(): void {
    if (this._powered) this.studio.clearDrumPattern();
    const s = this.store.getState();
    s.sampler = coalesceSamplerState(s.sampler);
    s.sampler.pattern = defaultPattern();
    this.store.setState(s);
  }

  /** Whole 8x16 pattern (DrumMachinePanel snapshot source). Coalesces a missing/older slice. */
  getPattern(): boolean[][] {
    return coalesceSamplerState(this.store.getState().sampler).pattern;
  }

  /** One cell read-back (false when the slice/row/cell is absent). */
  getStep(track: number, step: number): boolean {
    return this.getPattern()[track]?.[step] ?? false;
  }

  /** Persisted RUN/STOP flag (NOT the live engine playing flag — that is getTransportFlags). */
  getDrumSeqRunning(): boolean {
    return coalesceSamplerState(this.store.getState().sampler).seqRunning;
  }

  // ---- reference-aware user-sample-byte freeing (FIX 1: never delete bytes still in use) ----
  // EVERY user-sample-byte delete (loadPadSample replace, resetAll/INIT, applyPreset load) is
  // gated through isUserSampleUnreferenced so we never free bytes a LIVE state or ANY saved slot
  // still references. The blocker this prevents: applyPreset = resetAll + restoreFullState, and
  // resetAll's outgoing-id delete(X) would erase from IndexedDB a sample the INCOMING preset (or
  // another saved slot) names — leaving that pad permanently silent. Slots reference ids only
  // (bytes stay in IndexedDB), so a delete here can strand a slot the user never touched.

  /**
   * User (non-factory) sample ids a state references — the SAME predicate as
   * collectUserSampleIds. Coalesces the sampler slice so a partial/garbage tree can't throw.
   */
  private currentUserSampleIds(state: StudioState): string[] {
    const pads = coalesceSamplerState(state.sampler).pads;
    const ids: string[] = [];
    for (const p of pads) {
      const id = p.sampleId;
      if (id && !id.startsWith('factory-')) ids.push(id);
    }
    return ids;
  }

  /**
   * Union of currentUserSampleIds over EVERY saved slot's state. Reads each slot through the
   * existing slot read path (parseSlot of the wrapper.state). Mirrors the slot code's
   * localStorage guards: an absent / blocked / corrupt localStorage yields an empty set and
   * NEVER throws — so a free is only ever blocked by a slot we could actually read.
   */
  private slotReferencedSampleIds(): Set<string> {
    const referenced = new Set<string>();
    try {
      if (typeof localStorage === 'undefined') return referenced;
      for (const name of this.readSlotIndex()) {
        try {
          const raw = localStorage.getItem(slotStorageKey(name));
          if (raw == null) continue;
          const wrapper = JSON.parse(raw) as Partial<SlotWrapper>;
          const state = parseSlot(JSON.stringify(wrapper.state));
          for (const id of this.currentUserSampleIds(state)) referenced.add(id);
        } catch {
          /* skip a single malformed slot; keep scanning the rest */
        }
      }
    } catch {
      /* absent / blocked localStorage — treat as no slot references (never throw) */
    }
    return referenced;
  }

  /**
   * Safe-to-free test for a user sample id: TRUE only when nothing keeps it alive. FALSE for an
   * empty/factory id (never freeable), FALSE if any `liveStates` entry references it (still on a
   * pad), FALSE if any saved slot references it; otherwise TRUE.
   */
  private isUserSampleUnreferenced(id: string, liveStates: StudioState[]): boolean {
    if (!id || id.startsWith('factory-')) return false;
    for (const state of liveStates) {
      if (this.currentUserSampleIds(state).includes(id)) return false;
    }
    if (this.slotReferencedSampleIds().has(id)) return false;
    return true;
  }

  /**
   * INIT: stop all transports, clear every cable,
   * return every control on all three machines + mixer to factory defaults.
   *
   * `keepReferencedBy` (FIX 1): extra live states whose user-sample ids must NOT be freed even
   * though INIT clears the pads — applyPreset/importSetup pass the INCOMING coalesced state so a
   * sample the new setup references is never deleted by the reset that precedes its restore. The
   * outgoing-orphan free is gated through isUserSampleUnreferenced, so a sample still on a pad in
   * any kept state, or referenced by ANY saved slot, survives; only truly-unreferenced bytes go.
   * Existing zero-arg callers (the INIT button) get the default [] and the slot-aware gate alone.
   */
  resetAll(keepReferencedBy: StudioState[] = []): void {
    // stopAll BEFORE building/applying the fresh state so INIT halts the transports first
    // (releaseAllNotes + the live-guard clear now ride inside applyFullState below).
    if (this._powered) this.studio.stopAll();
    // Capture the user samples this state referenced, BEFORE replacing it, so their bytes
    // can be freed from the backend (INIT clears the pad refs; without this the bytes orphan).
    const orphanedIds = (this.store.getState().sampler?.pads ?? [])
      .map((p) => p?.sampleId)
      .filter((id): id is string => !!id && !id.startsWith('factory-'));
    const state = defaultStudioState();
    state.power = this._powered;
    // Seed control defaults for the control-bearing modules ONLY (monarch/anvil/cascade) —
    // derived from the registry via controlDefaultModules. The sampler is excluded
    // (ownsControlDefaults:false) because its pad params live in state.sampler, not state.controls.
    for (const m of controlDefaultModules) {
      const mod = (state.controls[m.def.id] ??= {});
      for (const c of m.def.controls) {
        if (c.default !== undefined) mod[c.id] = c.default as number | string;
      }
    }
    // The shared re-apply: clears the live-drag guards, drops any held note (clearing a hung
    // gate before INIT), seeds keyboardOctave from state.keyboard (defaultStudioState -> 0),
    // store.setState(state), and when powered studio.applyState + pushCascadeClockControls.
    this.applyFullState(state);
    if (this._powered) {
      // defaultStudioState now PRE-LOADS the 8-piece factory kit on its pads (g2), so INIT
      // returns to the playable kit rather than silence. Clear every previously-loaded buffer
      // FIRST (drops user samples + any stale assignment), then reload the kit SECOND so the
      // pads the default state references sound again. The factory branch of reloadPadBuffers
      // (studio.ts) is fully synchronous for an all-factory sampler (no await — it resolves the
      // in-memory factoryBuffers map), so this fire-and-forget reload runs to completion before
      // its promise settles and cannot interleave with applyPreset's later awaited restore
      // (incoming wins, running strictly after resetAll returns).
      this.studio.clearPadBuffers();
      // INIT stops a running drum grid (parity with stopAll + clearPadBuffers). The store
      // already holds defaultStudioState (seqRunning=false) from applyFullState above; this
      // halts the LIVE samplerSeq.playing flag, which is independent of the store.
      this.studio.drumStop();
      void this.studio.reloadPadBuffers(defaultStudioState().sampler, sampleBackend);
    }
    // Free the orphaned sample bytes — BUT only the truly-unreferenced ones (FIX 1). INIT clears
    // the pads, so the post-op live state is defaultStudioState(); add any caller-kept incoming
    // states. A byte still on a kept pad, or referenced by ANY saved slot, is NEVER freed here.
    const liveStates = [defaultStudioState(), ...keepReferencedBy];
    for (const id of orphanedIds) {
      if (this.isUserSampleUnreferenced(id, liveStates)) void sampleBackend.delete(id);
    }
  }

  // ---- presets + save/load (feature: presets) ----------------------------------------
  // A preset is a serialized StudioState snapshot. EVERY load path
  // (loadFactoryPreset / loadSlot / importSetup) funnels through coalesceStudioState (the
  // never-throwing normalizer) then through the SAME re-apply tail that powerOn/resetAll use
  // (applyFullState), then an AWAITED reloadPadBuffers — so no feature is dropped on restore.
  // Slots live in localStorage and reference sample ids ONLY (bytes stay in IndexedDB
  // locally); the exported .json bundle carries USER sample bytes (base64) so it is portable.

  /**
   * THE shared re-apply tail extracted from powerOn + resetAll. Pushes a complete StudioState
   * into the live engine + store EXACTLY the way both call sites used to inline:
   *   - clear the live-drag transport guards (mirrors resetAll's old 969-971),
   *   - releaseAllNotes() (mirrors resetAll's old 953 / a clean gate before re-apply),
   *   - seed keyboardOctave from the (coalesce-safe) keyboard slice — applyState NEVER restores
   *     octave, so this is the one place it lands (mirrors powerOn's old 223),
   *   - store.setState(state) FIRST (applyState re-sets the store harmlessly at studio.ts:696 —
   *     the intentional double-setState that mirrors resetAll's old 972+974 order),
   *   - when powered: studio.applyState(state) (controls/cables/mixer/transport/sampler params +
   *     drum pattern) + pushCascadeClockControls(state) (RHYTHM dividers + assign matrix + the clock
   *     half of CAS_EG — the families applyState cannot route).
   * Buffer (de)coding is NOT here (the caller decides fire-and-forget vs awaited reload).
   */
  private applyFullState(state: StudioState): void {
    this.liveSwingPct = null;
    this.livePitchVv.fill(null);
    this.liveVelocityVv.fill(null);
    this.releaseAllNotes();
    this.keyboardOctave = coalesceKeyboardState(state.keyboard).octave;
    this.store.setState(state);
    if (this._powered) {
      this.studio.applyState(state);
      this.pushCascadeClockControls(state);
    }
  }

  /**
   * Coalesce a (possibly partial / older / hand-edited) tree, re-apply it through the shared
   * applyFullState tail, then AWAIT reloadPadBuffers so every pad's referenced buffer (factory
   * from the in-memory map, user from the backend) is re-resolved before this resolves. Carries
   * NO resetAll of its own — the import path owns the reset+import ordering (see importSetup).
   * No-throw (coalesceStudioState never throws; reloadPadBuffers guards each pad).
   */
  private async restoreFullState(state: StudioState): Promise<void> {
    const safe = coalesceStudioState(state); // version 1; running/playing/seqRunning false; power false
    safe.power = this._powered; // power from the LIVE bridge (parity with resetAll's state.power)
    this.applyFullState(safe);
    if (this._powered) await this.studio.reloadPadBuffers(safe.sampler, sampleBackend);
  }

  /**
   * Load a slot / factory preset: INIT to a clean slate, then restore the preset's state +
   * awaited buffer reload. No-throw.
   *
   * FIX 1 (blocker): a slot/factory load can reference the SAME user-sample ids the outgoing
   * setup did (re-loading a slot that shares a sample with the live pads, or two slots sharing a
   * kit). resetAll's outgoing-orphan free would otherwise erase those bytes from IndexedDB before
   * restoreFullState re-resolves the pad — leaving the pad permanently silent. We pass the
   * INCOMING coalesced state as a kept live state so resetAll never frees a byte the new setup
   * (or any saved slot) still references.
   */
  async applyPreset(state: StudioState): Promise<void> {
    const incoming = coalesceStudioState(state);
    this.resetAll([incoming]);
    await this.restoreFullState(incoming);
  }

  // ---- localStorage slots (g3 owns the index key + the savedAt wrapper) ----------------
  // FIRST localStorage consumer in the app — EVERY read/write is try/catch-wrapped so an
  // absent (Node/SSR), blocked, quota-full, or malformed localStorage degrades gracefully
  // (listSlots -> [], the mutators -> no-op) and NEVER throws. Per-slot key = slotStorageKey
  // (g1's SLOT_PREFIX + name); the index lists slot names under the same prefix namespace.

  /** Save the current StudioState to a named slot + upsert the slot-name index. No-throw. */
  saveSlot(name: string): void {
    const slotName = name.trim();
    if (!slotName) return;
    try {
      if (typeof localStorage === 'undefined') return;
      // serializeSlot (g1) stringifies the StudioState; we embed that JSON in the g3 wrapper
      // (version + savedAt metadata) so loadSlot can read wrapper.state back through parseSlot.
      const stateJson = serializeSlot(this.store.getState());
      const wrapper = `{"version":1,"savedAt":${Date.now()},"state":${stateJson}}`;
      localStorage.setItem(slotStorageKey(slotName), wrapper);
      const names = this.readSlotIndex();
      if (!names.includes(slotName)) {
        names.push(slotName);
        localStorage.setItem(INDEX_KEY, JSON.stringify(names));
      }
    } catch {
      /* absent / quota / blocked localStorage — degrade silently */
    }
  }

  /** Saved slot names, sorted (a fresh copy). [] when localStorage is absent/corrupt. */
  listSlots(): string[] {
    return [...this.readSlotIndex()].sort();
  }

  /** Load a saved slot (coalesce-safe) through applyPreset. Missing/corrupt slot = no-op. */
  async loadSlot(name: string): Promise<void> {
    try {
      if (typeof localStorage === 'undefined') return;
      const raw = localStorage.getItem(slotStorageKey(name));
      if (raw == null) return;
      const wrapper = JSON.parse(raw) as Partial<SlotWrapper>;
      // Route wrapper.state through parseSlot for the coalesce safety net (its arg is the
      // slot's JSON, exactly what serializeSlot produced on save). A missing/corrupt state
      // yields the default tree from parseSlot, never a throw.
      await this.applyPreset(parseSlot(JSON.stringify(wrapper.state)));
    } catch {
      /* malformed slot / unavailable localStorage — silent no-op */
    }
  }

  /** Delete a saved slot + drop its name from the index. No-throw. */
  deleteSlot(name: string): void {
    try {
      if (typeof localStorage === 'undefined') return;
      localStorage.removeItem(slotStorageKey(name));
      const names = this.readSlotIndex().filter((n) => n !== name);
      localStorage.setItem(INDEX_KEY, JSON.stringify(names));
    } catch {
      /* unavailable localStorage — silent no-op */
    }
  }

  /** Read the slot-name index ([] when absent/corrupt/not-an-array-of-strings). No-throw. */
  private readSlotIndex(): string[] {
    try {
      if (typeof localStorage === 'undefined') return [];
      const raw = localStorage.getItem(INDEX_KEY);
      if (raw == null) return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((n): n is string => typeof n === 'string');
    } catch {
      return [];
    }
  }

  // ---- portable .json bundle (export / import) ----------------------------------------

  /**
   * Build the portable bundle ({ kind, version:1, state, samples:[base64 USER bytes] }) for the
   * current setup and trigger a browser download (the recorder's <a download> idiom). Factory
   * sample ids carry no bytes (resolved on load); only USER pad samples are bundled. Env-guarded
   * no-op without DOM / URL.createObjectURL (Node/headless). Never throws.
   */
  async exportSetup(name?: string): Promise<void> {
    try {
      const state = this.store.getState();
      const ids = collectUserSampleIds(state); // g1: distinct non-factory pad ids
      const entries = await exportSamples(sampleBackend, ids); // g2: gather + base64 (never throws)
      const bundle = buildBundle(state, entries); // g1: assemble the envelope
      const text = JSON.stringify(bundle);
      const filename = buildPresetFilename(name ?? 'setup', this.timestampNow());
      this.triggerJsonDownload(text, filename);
    } catch {
      /* serialize / encode / DOM failure — silent no-op (export is best-effort) */
    }
  }

  /**
   * Import a portable .json bundle and restore the WHOLE setup. ORDERING (load-bearing):
   *   1. parseBundle (g1) — null on bad/foreign JSON (wrong `kind`) -> { ok:false }.
   *   2. resetAll([parsed.state]) — clean slate; frees the OUTGOING setup's user-sample ids
   *      FIRST, but the reference gate (FIX 1) is told to KEEP the incoming bundle's ids, so an
   *      id shared between the outgoing and incoming setups is never deleted. (importSamples in
   *      step 3 re-puts the bundle bytes anyway; the gate just makes a colliding id doubly safe.)
   *      Doing the reset BEFORE the import sequences any surviving colliding-id delete(X) in
   *      IndexedDB creation-order BEFORE the put(X) below, so the re-imported byte is the LAST
   *      write on key X and can never be clobbered.
   *   3. importSamples (g2) — re-put the bundle's sample ids VERBATIM (overwrite), so the
   *      restored pad refs resolve. AWAITED so the bytes land BEFORE reloadPadBuffers reads them.
   *   4. restoreFullState — coalesce + applyFullState + AWAITED reloadPadBuffers (NO second
   *      resetAll; restoreFullState carries none, so step 2's reset is the only one).
   * Resolves { ok:false, error } on a bad file or any thrown step — never a raw throw to the UI.
   */
  async importSetup(file: File): Promise<{ ok: boolean; error?: string }> {
    try {
      const text = await file.text();
      const parsed = parseBundle(text); // g1: { state, samples } | null (kind-checked)
      if (!parsed) return { ok: false, error: 'Could not read that file' };
      this.resetAll([parsed.state]); // (2) clean slate; keep the incoming ids from the orphan free
      // Import ONLY sample entries the bundle's OWN state references — a hand-edited bundle can
      // carry extra unreferenced blobs that would otherwise leak storage under ids no pad names.
      const wanted = new Set(collectUserSampleIds(parsed.state));
      await importSamples(
        sampleBackend,
        parsed.samples.filter((e) => wanted.has(e.id)),
      ); // (3) re-put referenced bundle ids AFTER reset
      await this.restoreFullState(parsed.state); // (4) coalesce + apply + awaited buffer reload
      return { ok: true };
    } catch {
      return { ok: false, error: 'Import failed' };
    }
  }

  /** Load a factory preset recipe by id (unknown id -> no-op). No bundled bytes — the recipes
   *  reference only factory-kick/hat/tom, resolved from the in-memory factoryBuffers. No-throw. */
  async loadFactoryPreset(id: string): Promise<void> {
    const state = getFactoryPreset(id); // g1: StudioState | null
    if (state) await this.applyPreset(state);
  }

  /** The ONE wall-clock read for the export filename (mirrors recorder.ts:135-137). */
  private timestampNow(): string {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  /**
   * Fire a temporary <a download> for the bundle JSON (the recorder.ts triggerDownload idiom).
   * Env-guarded no-op without a DOM / URL.createObjectURL (Node / headless). The cleanup
   * setTimeout is a UI timer, NOT an audio event (allowed by the scheduler rule).
   */
  private triggerJsonDownload(text: string, filename: string): void {
    if (
      typeof document === 'undefined' ||
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function'
    ) {
      return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 0);
  }

  /** Trailing-edge debounce: one setState carrying every pending mixer/master value. */
  private scheduleStoreMirror(): void {
    if (this.mirrorTimer !== null) return;
    this.mirrorTimer = setTimeout(() => {
      this.mirrorTimer = null;
      const s = this.store.getState();
      for (let i = 0 as 0 | 1 | 2 | 3; i < 4; i = (i + 1) as 0 | 1 | 2 | 3) {
        const v = this.pendingLevels[i];
        if (v !== null) s.mixer.channelLevels[i] = v;
        this.pendingLevels[i] = null;
      }
      if (this.pendingMaster !== null) {
        s.mixer.masterVolume = this.pendingMaster;
        this.pendingMaster = null;
      }
      this.store.setState(s);
    }, STORE_MIRROR_DEBOUNCE_MS);
  }
}

export type { EngineBridge };
export type { MidiStatus } from './midi/webMidiInput';

/** The singleton the UI imports. Never construct a second bridge. */
export const engineBridge = new EngineBridge();

// e2e smoke handle (work order: expose the bridge for the browser smoke test)
declare global {
  interface Window {
    __synthstackStudio?: EngineBridge;
  }
}

if (typeof window !== 'undefined') {
  window.__synthstackStudio = engineBridge;
}
