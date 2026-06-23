/**
 * Serializable studio state tree (work order §3.6).
 * The audio engine lives OUTSIDE this store; the store is plain JSON-safe data.
 * getState()/setState() must round-trip through JSON from Phase 1 onward.
 */

// One-way import of the factory-kit MANIFEST (the single source of truth lives in
// factorySamples.ts). FACTORY_KIT is a plain {id,name}[] literal with ZERO Web Audio
// types, so importing it into this pure state core is Node-safe — it does NOT pull in
// OfflineAudioContext (only renderFactorySamples does, and that tree-shakes away here).
import { FACTORY_KIT } from '../engine/factorySamples';

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
  quantize: QuantizeDivision; // global launch grid, default '1 BAR'
  pattern: boolean[][]; // [8][16]; pattern[track][step] === step ON for pad `track`
  seqRunning: boolean; // drum-seq RUN/STOP, persisted, independent of SynthStack RUN ALL
}

export interface CascadeSequencerState {
  playing: boolean;
}

/** On-screen / MIDI keyboard slice. `octave` is the ONLY persisted keyboard datum;
 *  MIDI-enabled + held keys are RUNTIME ONLY (never serialized). The bridge applies
 *  octave as +octave on the vv AFTER (note-60)/12 — the one place octave is applied. */
export interface KeyboardState {
  octave: number; // integer octave shift, -3..+3; 0 = unshifted (low C = MIDI 48 / C3, middle C 60 in range)
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
    // Pre-load the 8 pads from the FACTORY_KIT manifest (pad t = kit[t]) so the kit
    // ships playable on first power-on + INIT. defaultPad() (empty) stays the coalesce
    // / bridge-replace default; an empty SAVED slot still coalesces to empty pads.
    pads: Array.from({ length: 8 }, (_, t) => defaultFactoryPad(t)),
    quantize: '1 BAR',
    pattern: defaultPattern(),
    seqRunning: false,
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
  return { pads, quantize, pattern, seqRunning };
}

export function defaultKeyboardState(): KeyboardState {
  return { octave: 0 };
}

/**
 * Normalize a possibly-partial / older-shape keyboard slice to a complete KeyboardState.
 * Mirrors coalesceSamplerState: PURE, never mutates `raw`. The bridge is the ONLY consumer
 * (powerOn seed + setKeyboardOctave read-modify-write + getKeyboardOctave snapshot), so this
 * is the sole older-tree safety net — a pre-feature tree lacking `keyboard` -> {octave:0}.
 * Integer-guards the octave and clamps to -3..+3 (matches the bridge clamp); any non-integer
 * (3.5 / 'x' / NaN) or missing value defaults to 0.
 */
export function coalesceKeyboardState(raw: Partial<KeyboardState> | undefined): KeyboardState {
  const o = raw?.octave;
  const octave = Number.isInteger(o) ? Math.max(-3, Math.min(3, o as number)) : 0;
  return { octave };
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
