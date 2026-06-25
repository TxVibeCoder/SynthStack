/**
 * Serializable studio state tree (work order §3.6).
 * The audio engine lives OUTSIDE this store; the store is plain JSON-safe data.
 * getState()/setState() must round-trip through JSON from Phase 1 onward.
 */

// One-way import of the factory-kit MANIFESTs (the single source of truth lives in
// factorySamples.ts). FACTORY_KIT (the default kit's pads) + KIT_LIBRARY (all kits, G6) +
// DEFAULT_KIT_ID. We only read the {id,name} pad manifests + ids here — the render code
// (the only thing that touches OfflineAudioContext) lives in unreferenced function bodies
// that tree-shake away, so importing these values into this pure state core stays Node-safe.
import { FACTORY_KIT, KIT_LIBRARY, DEFAULT_KIT_ID } from '../engine/factorySamples';
// The modulatable-target allow-list is defined ONCE in modRouter.ts (the pure routing core)
// and re-exported here so coalesce + UI + engine share a single source of truth.
import { COURIER_MOD_TARGETS } from '../engine/modRouter';
export { COURIER_MOD_TARGETS } from '../engine/modRouter';

export interface CableState {
  id: string;
  from: string; // output jack id
  to: string; // input jack id
  color: string;
}

export interface MonarchStepState {
  noteVv: number;
  gateLength: number; // 0.05..1.0; 1.0 = tie
  accent: boolean;
  rest: boolean;
  glide: boolean;
  ratchet: 1 | 2 | 3 | 4;
}

export interface MonarchSequencerState {
  steps: MonarchStepState[]; // 32
  endStep: number; // 1..32
  swingPct: number; // 0..100
  running: boolean;
}

export interface AnvilStepState {
  pitchVv: number; // -5..+5
  velocityVv: number; // 0..+5
}

export interface AnvilSequencerState {
  steps: AnvilStepState[]; // 8
  running: boolean;
}

/** Loop-launch quantize grid (one global selector); byte-identical to SAMP_QUANTIZE.positions
 *  in data/sampler.json and to QUANT_CYCLE in src/engine/quantGrid.ts (lockstep-pinned by test). */
export type QuantizeDivision = 'OFF' | '1/16' | '1/8' | '1/4' | '1/2' | '1 BAR';
export const QUANTIZE_DIVISIONS: QuantizeDivision[] = ['OFF', '1/16', '1/8', '1/4', '1/2', '1 BAR'];

export interface PadState {
  sampleId: string | null; // IndexedDB key (user upload) OR factory id ('factory-kick'); null = empty
  sampleName: string | null; // display label; null = empty
  level: number; // 0..1, default 0.8
  tuneSemis: number; // integer semitones -24..+24, default 0
  loop: boolean; // continuous-loop arm; default false (tap launches, tap again stops)
}

/** Drum step sequencer geometry. track t = pad t (0..7); 16 steps = one bar of 16ths.
 *  DRUM_STEPS is fixed scope (one source of truth) — DELIBERATELY NOT stored in state. */
export const DRUM_TRACKS = 8;
export const DRUM_STEPS = 16;

export interface SamplerState {
  pads: PadState[]; // length 8
  kitId: string; // G6 selected kit id (membership-clamped to KIT_LIBRARY; default DEFAULT_KIT_ID)
  quantize: QuantizeDivision; // global launch grid, default '1 BAR'
  pattern: boolean[][]; // [8][16]; pattern[track][step] === step ON for pad `track`
  seqRunning: boolean; // drum-seq RUN/STOP, persisted, independent of SynthStack RUN ALL
  numSteps: number; // wrap length 1..16, default 16; columns >= numSteps are RETAINED but unplayed
  swingPct: number; // 0..100, default 50 (=no swing); offsets odd grid columns (state allows 0..100, UI caps at 75)
}

export interface CascadeSequencerState {
  playing: boolean;
}

/** On-screen / MIDI keyboard slice. `octave` is the ONLY persisted keyboard datum;
 *  MIDI-enabled + held keys are RUNTIME ONLY (never serialized). The bridge applies
 *  octave as +octave on the vv AFTER (note-60)/12 — the one place octave is applied. */
export interface KeyboardState {
  octave: number; // integer octave shift, -3..+3; 0 = unshifted (low C = MIDI 48 / C3, middle C 60 in range)
  midiChannel: number; // MIDI input channel filter: -1 = OMNI (all channels); 0..15 = accept only that channel
  glideS: number; // SEPARATE keyboard/MIDI live-play glide time in seconds, 0..1; 0 = off (the seq keeps MON_GLIDE)
}

export interface TransportState {
  monarch: MonarchSequencerState;
  anvil: AnvilSequencerState;
  cascade: CascadeSequencerState;
}

/** Master effects (Wave 2). Each effect is {on} + numeric params; all plain JSON so the
 *  getState/setState round-trip holds. The engine graph (engine/fx) mirrors these. */
export interface FlangerState {
  on: boolean;
  rate: number; // LFO Hz, 0.05..8
  depth: number; // 0..1 sweep depth
  feedback: number; // 0..0.95
  mix: number; // 0..1 wet
}
export interface DelayState {
  on: boolean;
  time: number; // seconds, 0.02..2
  feedback: number; // 0..0.95
  mix: number; // 0..1 wet
}
export interface ReverbState {
  on: boolean;
  size: number; // 0..1 room/decay
  mix: number; // 0..1 wet
}
export interface MasterEffectsState {
  flanger: FlangerState;
  delay: DelayState;
  reverb: ReverbState;
}
/** The voices that carry their own insert-FX chain (same 3-effect shape as the master). */
export type VoiceFxId = 'cascade' | 'anvil' | 'monarch' | 'courier';
export const VOICE_FX_IDS: VoiceFxId[] = ['cascade', 'anvil', 'monarch', 'courier'];
export interface EffectsState {
  master: MasterEffectsState;
  /** Per-voice insert FX (flanger→delay→reverb on each voice→mixer edge). The voice's
   *  patchbay VCA-OUT jack stays dry — this chain is a mixer-channel insert. */
  voices: Record<VoiceFxId, MasterEffectsState>;
}

export interface StudioState {
  version: 1;
  power: boolean;
  /** moduleId -> controlId -> value (number for knobs, string for switch/button positions) */
  controls: Record<string, Record<string, number | string>>;
  cables: CableState[];
  transport: TransportState;
  mixer: {
    channelLevels: [number, number, number, number, number];
    masterVolume: number;
    tempoLink: boolean;
  };
  sampler: SamplerState;
  keyboard: KeyboardState;
  effects: EffectsState;
  /** Courier per-voice structured slice (namespaced so it can grow beyond modAssign). */
  courier: { modAssign: CourierModAssignState; seq: CourierSequencerState };
}

export function defaultMonarchStep(): MonarchStepState {
  return { noteVv: -1, gateLength: 0.5, accent: false, rest: false, glide: false, ratchet: 1 };
}

export function defaultPad(): PadState {
  return { sampleId: null, sampleName: null, level: 0.8, tuneSemis: 0, loop: false };
}

/**
 * A pad pre-loaded with the FACTORY_KIT entry at `kitIndex` (pad t = kit[t]).
 * Levels/tune stay at the default-pad values; only the sample reference is seeded so the
 * drum machine is instantly playable on first power-on. The buffer is resolved at runtime
 * from the engine's in-memory factoryBuffers map (factory ids carry no bytes).
 */
export function defaultFactoryPad(kitIndex: number): PadState {
  const entry = FACTORY_KIT[kitIndex]!;
  return { sampleId: entry.id, sampleName: entry.name, level: 0.8, tuneSemis: 0, loop: false };
}

/** A fresh 8×16 all-false drum pattern (no shared row refs). */
export function defaultPattern(): boolean[][] {
  return Array.from({ length: DRUM_TRACKS }, () => new Array(DRUM_STEPS).fill(false));
}

export function defaultSamplerState(): SamplerState {
  return {
    // Pre-load the 8 pads from the DEFAULT kit's manifest (pad t = kit[t]) so the kit
    // ships playable on first power-on + INIT. defaultPad() (empty) stays the coalesce
    // / bridge-replace default; an empty SAVED slot still coalesces to empty pads.
    pads: Array.from({ length: 8 }, (_, t) => defaultFactoryPad(t)),
    kitId: DEFAULT_KIT_ID,
    quantize: '1 BAR',
    pattern: defaultPattern(),
    seqRunning: false,
    numSteps: 16,
    swingPct: 50,
  };
}

/**
 * Normalize a possibly-partial / older-shape sampler slice to a complete SamplerState.
 * Shared by the engine bridge + studio.applyState so neither re-derives the defaults.
 * Pure: fills missing `loop` (-> false) and an absent/invalid `quantize` (-> '1 BAR') without
 * mutating `raw`. For an untouched store pad the result is byte-equal to defaultPad().
 *
 * The drum `pattern` is ALWAYS rebuilt as a fixed 8×16 strict-boolean grid (raw lengths are
 * never trusted): older trees with no pattern -> all-false; ragged/short/over-long rows or a
 * wrong track count -> clamped to exactly 8×16; `=== true` coerces 1/0/null/undefined to a
 * real boolean so JSON round-trips hold and the engine never indexes out of bounds.
 */
export function coalesceSamplerState(raw: Partial<SamplerState> | undefined): SamplerState {
  if (raw == null) return defaultSamplerState();
  const quantize = QUANTIZE_DIVISIONS.includes(raw.quantize as QuantizeDivision)
    ? (raw.quantize as QuantizeDivision)
    : '1 BAR';
  const pads = Array.from({ length: 8 }, (_, i) => {
    const p = raw.pads?.[i];
    // Validate EVERY field rather than spreading `...p` verbatim — a hand-edited bundle could
    // inject junk (e.g. tuneSemis: 1e308 -> setPadTune -> playbackRate = Infinity, or a numeric
    // sampleId). Clamp/guard each so every load path (import / slot / factory / power-on) is hard.
    const level = typeof p?.level === 'number' && Number.isFinite(p.level)
      ? Math.max(0, Math.min(1, p.level))
      : 0.8;
    const tuneSemis = typeof p?.tuneSemis === 'number' && Number.isFinite(p.tuneSemis)
      ? Math.max(-24, Math.min(24, Math.round(p.tuneSemis)))
      : 0;
    let sampleId = typeof p?.sampleId === 'string' ? p.sampleId : null;
    // The bare `factory-hat` id was split into closed/open (DECISIONS.md "Factory sounds"). Alias
    // any older preset/bundle still naming it so the pad resolves a buffer instead of going silent.
    if (sampleId === 'factory-hat') sampleId = 'factory-hat-closed';
    return {
      sampleId,
      sampleName: typeof p?.sampleName === 'string' ? p.sampleName : null,
      level,
      tuneSemis,
      loop: typeof p?.loop === 'boolean' ? p.loop : false,
    };
  });
  const pattern = Array.from({ length: DRUM_TRACKS }, (_, t) =>
    Array.from({ length: DRUM_STEPS }, (_, s) => raw.pattern?.[t]?.[s] === true),
  );
  const seqRunning = raw.seqRunning === true;
  // numSteps wrap length: finite -> round + clamp 1..16; else default 16.
  const numSteps =
    typeof raw.numSteps === 'number' && Number.isFinite(raw.numSteps)
      ? Math.max(1, Math.min(16, Math.round(raw.numSteps)))
      : 16;
  // swingPct: finite -> clamp 0..100; else default 50 (no swing). State allows the full 0..100;
  // the UI caps the knob at the musical 75 (see DrumMachinePanel SWING — flagged for the operator's ears).
  const swingPct =
    typeof raw.swingPct === 'number' && Number.isFinite(raw.swingPct)
      ? Math.max(0, Math.min(100, raw.swingPct))
      : 50;
  // kitId (G6): membership-clamp to the kit library; any unknown/garbage/missing id -> default.
  // The pad refs are independent (per-pad picker + user LOAD can diverge from kitId), so kitId
  // tracks the LAST whole-kit select; it is not re-derived from the pads.
  const kitId =
    typeof raw.kitId === 'string' && KIT_LIBRARY.some((k) => k.id === raw.kitId)
      ? raw.kitId
      : DEFAULT_KIT_ID;
  return { pads, kitId, quantize, pattern, seqRunning, numSteps, swingPct };
}

export function defaultKeyboardState(): KeyboardState {
  return { octave: 0, midiChannel: -1, glideS: 0 };
}

/**
 * Normalize a possibly-partial / older-shape keyboard slice to a complete KeyboardState.
 * Mirrors coalesceSamplerState: PURE, never mutates `raw`. The bridge is the ONLY consumer
 * (powerOn seed + setKeyboard* read-modify-write + getKeyboard* snapshots), so this is the sole
 * older-tree safety net — a pre-feature tree lacking `keyboard` -> the full default; a pre-G1 tree
 * with only `{octave}` heals to {octave, midiChannel:-1, glideS:0}.
 *   octave:      integer-guarded, clamped -3..+3 (matches the bridge clamp); non-integer / missing -> 0.
 *   midiChannel: integer-guarded, -1 (OMNI) or 0..15; any non-integer / out-of-range -> -1 (OMNI).
 *   glideS:      finite, clamped 0..1; non-finite (NaN / 'x' / missing) -> 0.
 */
export function coalesceKeyboardState(raw: Partial<KeyboardState> | undefined): KeyboardState {
  const o = raw?.octave;
  const octave = Number.isInteger(o) ? Math.max(-3, Math.min(3, o as number)) : 0;
  const c = raw?.midiChannel;
  const midiChannel = Number.isInteger(c) && (c as number) >= -1 && (c as number) <= 15 ? (c as number) : -1;
  const g = raw?.glideS;
  const glideS = typeof g === 'number' && Number.isFinite(g) ? Math.max(0, Math.min(1, g)) : 0;
  return { octave, midiChannel, glideS };
}

/** A fresh all-off 3-effect chain — the shared default shape for the master AND each voice. */
export function defaultFxChainState(): MasterEffectsState {
  return {
    flanger: { on: false, rate: 0.4, depth: 0.5, feedback: 0.3, mix: 0.5 },
    delay: { on: false, time: 0.3, feedback: 0.35, mix: 0.4 },
    reverb: { on: false, size: 0.6, mix: 0.3 },
  };
}

export function defaultEffectsState(): EffectsState {
  return {
    master: defaultFxChainState(),
    voices: {
      cascade: defaultFxChainState(),
      anvil: defaultFxChainState(),
      monarch: defaultFxChainState(),
      courier: defaultFxChainState(),
    },
  };
}

/** Clamp + finite-guard one numeric effect param, defaulting if junk. */
function num(v: unknown, def: number, lo: number, hi: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def;
}

/**
 * Normalize a possibly-partial / older-shape effects slice to a complete EffectsState.
 * Mirrors coalesceSamplerState: PURE, never mutates `raw`; a pre-feature tree lacking
 * `effects` -> all effects off at their default params. Every field is validated so a
 * hand-edited bundle can't inject junk into an AudioParam.
 */
/** Coalesce one 3-effect chain slice (master or a voice) against the default shape. */
function coalesceFxChain(
  raw: Partial<MasterEffectsState> | undefined,
  d: MasterEffectsState,
): MasterEffectsState {
  const flag = (v: unknown, def: boolean) => (typeof v === 'boolean' ? v : def);
  return {
    flanger: {
      on: flag(raw?.flanger?.on, d.flanger.on),
      rate: num(raw?.flanger?.rate, d.flanger.rate, 0.05, 8),
      depth: num(raw?.flanger?.depth, d.flanger.depth, 0, 1),
      feedback: num(raw?.flanger?.feedback, d.flanger.feedback, 0, 0.95),
      mix: num(raw?.flanger?.mix, d.flanger.mix, 0, 1),
    },
    delay: {
      on: flag(raw?.delay?.on, d.delay.on),
      time: num(raw?.delay?.time, d.delay.time, 0.02, 2),
      feedback: num(raw?.delay?.feedback, d.delay.feedback, 0, 0.95),
      mix: num(raw?.delay?.mix, d.delay.mix, 0, 1),
    },
    reverb: {
      on: flag(raw?.reverb?.on, d.reverb.on),
      size: num(raw?.reverb?.size, d.reverb.size, 0, 1),
      mix: num(raw?.reverb?.mix, d.reverb.mix, 0, 1),
    },
  };
}

export function coalesceEffectsState(raw: Partial<EffectsState> | undefined): EffectsState {
  const d = defaultFxChainState();
  return {
    master: coalesceFxChain(raw?.master, d),
    voices: {
      cascade: coalesceFxChain(raw?.voices?.cascade, d),
      anvil: coalesceFxChain(raw?.voices?.anvil, d),
      monarch: coalesceFxChain(raw?.voices?.monarch, d),
      courier: coalesceFxChain(raw?.voices?.courier, d),
    },
  };
}

// ---------------------------------------------------------------------------
// Courier per-patch mod-matrix slice (Phase B). Each of the 4 mod SOURCES is assignable
// to ONE panel control with a BIPOLAR depth (-1..1). Additive slice — version stays 1.
// ---------------------------------------------------------------------------

/** The 4 assignable Courier mod sources (cover ids; one route each). */
export type CourierModSource = 'kb' | 'fEnv' | 'aEnv' | 'lfo1';
/** A single route: target control id + bipolar depth (-1..1). */
export interface ModAssignEntry {
  controlId: string;
  depth: number; // -1..1
}
/** One route per source (null = unassigned). Plain JSON (round-trip test enforces it). */
export interface CourierModAssignState {
  routes: Record<CourierModSource, ModAssignEntry | null>;
}
export const COURIER_MOD_SOURCES: CourierModSource[] = ['kb', 'fEnv', 'aEnv', 'lfo1'];

export function defaultCourierModAssignState(): CourierModAssignState {
  return { routes: { kb: null, fEnv: null, aEnv: null, lfo1: null } };
}

/**
 * Normalize a possibly-partial / older-shape mod-assign slice to a complete
 * CourierModAssignState. Mirrors coalesceKeyboardState/coalesceSamplerState: PURE, never
 * mutates `raw`. A pre-feature tree lacking `courier` -> all routes null. Drops garbage AND
 * any controlId not in the COURIER_MOD_TARGETS allow-list to null; clamps depth to [-1,1].
 */
export function coalesceCourierModAssignState(
  raw: Partial<CourierModAssignState> | undefined,
): CourierModAssignState {
  const out = defaultCourierModAssignState();
  const rr = (raw?.routes ?? {}) as Record<string, unknown>;
  for (const src of COURIER_MOD_SOURCES) {
    const r = rr[src];
    if (r && typeof r === 'object') {
      const cid = (r as Record<string, unknown>).controlId;
      const depth = (r as Record<string, unknown>).depth;
      if (
        typeof cid === 'string' &&
        COURIER_MOD_TARGETS.includes(cid) &&
        typeof depth === 'number' &&
        Number.isFinite(depth)
      ) {
        out.routes[src] = { controlId: cid, depth: Math.max(-1, Math.min(1, depth)) };
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Courier sequencer slice (Phase C MVP). 64 steps (4 pages x 16) of per-step note +
// gate + tie + rest, with a forward-compatible param-lock slot. Lives under
// state.courier.seq (NOT state.transport) so all Courier persistence stays on the
// one coalesce path Phase B owns. Additive slice — version stays 1.
// ---------------------------------------------------------------------------

export type CourierSeqMode = 'SEQ' | 'ARP';

/** Full arp pattern set (state mirror of the engine CourierArpMode). OFF + 13 patterns. */
export const COURIER_ARP_MODES = [
  'OFF',
  'UP',
  'DOWN',
  'UPDOWN_INC',
  'UPDOWN_EXC',
  'DOWNUP_INC',
  'DOWNUP_EXC',
  'CONVERGE',
  'DIVERGE',
  'PENDULUM',
  'AS_PLAYED',
  'RANDOM',
  'RANDOM_WALK',
  'CHORD',
] as const;
export type CourierArpModeState = (typeof COURIER_ARP_MODES)[number];
/** ARP RHYTHM divisions — the arp's own clock-division table, aliased to the seq clock divisions. */
export const ARP_RHYTHMS = ['1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32'] as const;

export interface CourierStepState {
  noteVv: number; // -1 = unauthored; else 1vv/oct relative to C5
  gateLength: number; // 0.05..1.0; >=1 == TIE
  rest: boolean;
  glide: boolean;
  lock: Record<string, number> | null; // per-step param-lock map (controlId->value); null/empty = no locks. Authored by the param-record matrix; applied by the bind layer.
  noteProb: number; // 0..1 chance the step's note sounds (1 = always)
  gateProb: number; // 0..1 chance the gate fires given the note sounds (1 = always)
  notePool: number[]; // candidate noteVv pool; empty = use noteVv, non-empty replaces it (one chosen per pass)
}

export interface CourierSequencerState {
  steps: CourierStepState[]; // exactly 64 (4 pages x 16)
  endStep: number; // 1..64 (LENGTH)
  swingPct: number; // 0..100
  gateLenScale: number; // 0.05..1.0 global GATE LENGTH
  clockDivIdx: number; // 0..5 index into COURIER_CLOCK_DIVS
  mode: CourierSeqMode; // 'SEQ' | 'ARP'
  arpMode: CourierArpModeState; // OFF + the 13 full arp patterns (see COURIER_ARP_MODES)
  arpOctave: number; // 1..4 — arp spans N octaves of the authored-note set
  arpRhythmIdx: number; // 0..5 index into ARP_RHYTHMS; the arp's own clock division
  running: boolean; // FORCED false on every load path
  seed: number; // uint32 PRNG seed for probability (note/gate prob + note pool); persisted, never force-defaulted
}

export function defaultCourierStep(): CourierStepState {
  return {
    noteVv: -1,
    gateLength: 0.5,
    rest: false,
    glide: false,
    lock: null,
    noteProb: 1,
    gateProb: 1,
    notePool: [],
  };
}

export function defaultCourierSequencerState(): CourierSequencerState {
  return {
    steps: Array.from({ length: 64 }, defaultCourierStep),
    endStep: 16,
    swingPct: 50,
    gateLenScale: 1,
    clockDivIdx: 3,
    mode: 'SEQ',
    arpMode: 'OFF',
    arpOctave: 1,
    arpRhythmIdx: 3, // '1/16'
    running: false,
    seed: 1,
  };
}

/**
 * Normalize a possibly-partial / older-shape Courier sequencer slice to a complete
 * CourierSequencerState. Mirrors coalesceCourierModAssignState: PURE, never mutates `raw`.
 * Steps are ALWAYS rebuilt as a strict 64-entry array (raw lengths never trusted); every
 * field is validated/clamped so a hand-edited bundle can't inject junk into an AudioParam.
 * A non-null `lock` is preserved (forward-compatible with C-FULL param-locks). `running`
 * is ALWAYS forced false (a restored preset never spontaneously sounds).
 */
export function coalesceCourierSequencerState(
  raw: Partial<CourierSequencerState> | undefined,
): CourierSequencerState {
  const d = defaultCourierSequencerState();
  const rs = Array.isArray(raw?.steps) ? raw!.steps : [];
  const steps = Array.from({ length: 64 }, (_, i) => {
    const s = rs[i] as Partial<CourierStepState> | undefined;
    const ds = defaultCourierStep();
    if (s == null || typeof s !== 'object') return ds;
    return {
      noteVv: typeof s.noteVv === 'number' && Number.isFinite(s.noteVv) ? s.noteVv : ds.noteVv,
      gateLength:
        typeof s.gateLength === 'number' && Number.isFinite(s.gateLength)
          ? Math.max(0.05, Math.min(1, s.gateLength))
          : ds.gateLength,
      rest: typeof s.rest === 'boolean' ? s.rest : ds.rest,
      glide: typeof s.glide === 'boolean' ? s.glide : ds.glide,
      // preserve a C-FULL param-lock map if a future tree carries one; else null
      lock: s.lock && typeof s.lock === 'object' ? (s.lock as Record<string, number>) : null,
      // probability: clamp 0..1 like gateLength; a pre-feature step (missing field) -> 1 (always)
      noteProb:
        typeof s.noteProb === 'number' && Number.isFinite(s.noteProb)
          ? Math.max(0, Math.min(1, s.noteProb))
          : ds.noteProb,
      gateProb:
        typeof s.gateProb === 'number' && Number.isFinite(s.gateProb)
          ? Math.max(0, Math.min(1, s.gateProb))
          : ds.gateProb,
      // note pool: keep only finite numbers; junk/missing -> empty (falls back to noteVv)
      notePool: Array.isArray(s.notePool)
        ? s.notePool.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
        : ds.notePool,
    };
  });
  const clampInt = (v: unknown, lo: number, hi: number, dv: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.max(lo, Math.min(hi, v))) : dv;
  return {
    steps,
    endStep: clampInt(raw?.endStep, 1, 64, d.endStep),
    swingPct:
      typeof raw?.swingPct === 'number' && Number.isFinite(raw.swingPct)
        ? Math.max(0, Math.min(100, raw.swingPct))
        : d.swingPct,
    gateLenScale:
      typeof raw?.gateLenScale === 'number' && Number.isFinite(raw.gateLenScale)
        ? Math.max(0.05, Math.min(1, raw.gateLenScale))
        : d.gateLenScale,
    clockDivIdx: clampInt(raw?.clockDivIdx, 0, 5, d.clockDivIdx),
    mode: raw?.mode === 'ARP' ? 'ARP' : 'SEQ',
    // widened arp mode: any of the 14 round-trips; a stale/junk value (e.g. SIDEWAYS) -> OFF.
    arpMode: COURIER_ARP_MODES.includes(raw?.arpMode as CourierArpModeState)
      ? (raw!.arpMode as CourierArpModeState)
      : 'OFF',
    arpOctave: clampInt(raw?.arpOctave, 1, 4, d.arpOctave),
    arpRhythmIdx: clampInt(raw?.arpRhythmIdx, 0, ARP_RHYTHMS.length - 1, d.arpRhythmIdx),
    running: false, // ALWAYS false on load (a restored preset never spontaneously sounds)
    // seed is preserved as a uint32 (NOT force-reset like `running`): same seed -> same run.
    seed:
      typeof raw?.seed === 'number' && Number.isFinite(raw.seed) ? raw.seed >>> 0 : d.seed,
  };
}

export function defaultStudioState(): StudioState {
  return {
    version: 1,
    power: false,
    controls: { monarch: {}, anvil: {}, cascade: {}, sampler: {}, courier: {} },
    cables: [],
    transport: {
      monarch: {
        steps: Array.from({ length: 32 }, defaultMonarchStep),
        endStep: 16,
        swingPct: 50,
        running: false,
      },
      anvil: {
        steps: Array.from({ length: 8 }, () => ({ pitchVv: 0, velocityVv: 4 })),
        running: false,
      },
      cascade: { playing: false },
    },
    mixer: { channelLevels: [0.8, 0.8, 0.8, 0.8, 0.8], masterVolume: 0.8, tempoLink: false },
    sampler: defaultSamplerState(),
    keyboard: defaultKeyboardState(),
    effects: defaultEffectsState(),
    courier: { modAssign: defaultCourierModAssignState(), seq: defaultCourierSequencerState() },
  };
}

type Listener = (state: StudioState) => void;

/** Plain-data store. The engine subscribes; React reads it via its own debounced adapter later. */
export class StudioStore {
  private state: StudioState;
  private listeners = new Set<Listener>();

  constructor(initial?: StudioState) {
    this.state = initial ?? defaultStudioState();
  }

  getState(): StudioState {
    return JSON.parse(JSON.stringify(this.state)) as StudioState;
  }

  setState(next: StudioState): void {
    this.state = JSON.parse(JSON.stringify(next)) as StudioState;
    for (const l of this.listeners) l(this.state);
  }

  setControl(moduleId: string, controlId: string, value: number | string): void {
    const mod = (this.state.controls[moduleId] ??= {});
    mod[controlId] = value;
    for (const l of this.listeners) l(this.state);
  }

  getControl(moduleId: string, controlId: string): number | string | undefined {
    return this.state.controls[moduleId]?.[controlId];
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
