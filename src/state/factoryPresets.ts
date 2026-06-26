/**
 * Factory preset recipes (feature: presets + save/load).
 *
 * Four curated starting-point setups, shipped as DATA. Each build() hand-authors only the
 * DELTA from defaults and funnels it through coalesceStudioState, which fills + clamps + forces
 * version 1 / power false / all running flags false. So a recipe can never produce an invalid or
 * spontaneously-sounding tree, and a stray out-of-range value self-heals (knobs clamp to JSON
 * min/max). ALL control ids below are VERIFIED present in data/*.json with the stated ranges.
 *
 * Names are ORIGINAL (no artist/track names). The UI (g4) imports listFactoryPresets DIRECTLY.
 */

import { coalesceStudioState } from './presets';
import {
  DRUM_STEPS,
  DRUM_TRACKS,
  defaultPad,
  type StudioState,
} from './studioState';

export interface FactoryPreset {
  id: string;
  name: string;
  description: string;
  build(): StudioState;
}

/** A FREQUENCY/12-spaced bassline figure (semitones around the Monarch FREQUENCY center). */
const CELLAR_DOOR_NOTES = [0, 0, 12, 0, 7, 0, 3, 5].map((semi) => semi / 12);

/** Build the Corner Store drum grid as a strict 8×16 boolean array (no ragged rows). */
function cornerStorePattern(): boolean[][] {
  const on: Record<number, number[]> = {
    0: [0, 4, 8, 12], // kick on every quarter
    1: [2, 6, 10, 14], // hat off-beats
    2: [7, 15], // tom fills
  };
  return Array.from({ length: DRUM_TRACKS }, (_, t) =>
    Array.from({ length: DRUM_STEPS }, (_, s) => (on[t] ?? []).includes(s)),
  );
}

/** Furnace Room bomber-bass riff — a driving, menacing 16-step Courier figure. `semi` = semitones
 *  from the root (noteVv = semi/12, since 1 vv = 1 octave); OSC 1 at 16' + the sub put it on the floor. */
const FURNACE_ROOM_RIFF: { semi: number; gate: number; rest?: boolean; glide?: boolean }[] = [
  { semi: 0, gate: 0.6 },
  { semi: 0, gate: 0.5, rest: true },
  { semi: 0, gate: 0.5 },
  { semi: 12, gate: 0.4 }, // octave pop
  { semi: 0, gate: 0.6 },
  { semi: 0, gate: 0.5, rest: true },
  { semi: 0, gate: 0.5 },
  { semi: 3, gate: 0.4 }, // minor third for menace
  { semi: 0, gate: 0.6 },
  { semi: 0, gate: 0.5, rest: true },
  { semi: 0, gate: 0.5 },
  { semi: 7, gate: 0.45, glide: true }, // slide up to the fifth
  { semi: 0, gate: 0.6 },
  { semi: -2, gate: 0.4 }, // dip below the root
  { semi: 10, gate: 0.4 }, // flat-seven stab
  { semi: 0, gate: 0.5, rest: true },
];

export const FACTORY_PRESETS: FactoryPreset[] = [
  {
    id: 'factory-preset-cellar-door',
    name: 'Cellar Door',
    description: 'Filtered acid bass on the Monarch',
    build: () =>
      coalesceStudioState({
        controls: {
          monarch: {
            MON_FREQUENCY: -0.3,
            MON_VCO_WAVE: 'SAW',
            MON_MIX: 0,
            MON_VCF_CUTOFF: 320,
            MON_VCF_RESONANCE: 0.78,
            MON_VCF_MODE: 'LP',
            MON_VCF_MOD_SOURCE: 'EG',
            MON_VCF_MOD_AMOUNT: 0.55,
            MON_VCF_MOD_POLARITY: 'PLUS',
            MON_ATTACK: 0.002,
            MON_DECAY: 0.22,
            MON_SUSTAIN: 'OFF',
            MON_VCA_MODE: 'EG',
            MON_VOLUME: 0.8,
            MON_GLIDE: 0.08,
            MON_TEMPO: 124,
          },
        },
        transport: {
          monarch: {
            endStep: 16,
            swingPct: 56,
            steps: CELLAR_DOOR_NOTES.map((noteVv, i) => ({
              noteVv,
              gateLength: 0.5,
              accent: i === 0 || i === 4,
              rest: i === 3,
              glide: i === 2 || i === 6,
              ratchet: 1 as const,
            })),
          },
        },
      }),
  },
  {
    id: 'factory-preset-iron-garden',
    name: 'Iron Garden',
    description: 'Percussive metallic Anvil groove',
    build: () =>
      coalesceStudioState({
        controls: {
          anvil: {
            ANV_VCO1_FREQUENCY: -1,
            ANV_VCO2_FREQUENCY: 1.5,
            ANV_VCO1_WAVE: 'SQ',
            ANV_VCO2_WAVE: 'SQ',
            ANV_HARD_SYNC: 'ON',
            ANV_FM_AMOUNT: 0.4,
            ANV_VCO1_EG_AMOUNT: 0.6,
            ANV_VCO2_EG_AMOUNT: 0.35,
            ANV_VCO_DECAY: 0.06,
            ANV_VCO1_LEVEL: 0.8,
            ANV_VCO2_LEVEL: 0.7,
            ANV_CUTOFF: 2400,
            ANV_RESONANCE: 0.3,
            ANV_VCF_MODE: 'LP',
            ANV_VCF_DECAY: 0.12,
            ANV_VCF_EG_AMOUNT: 0.5,
            ANV_VCA_EG_ATTACK: 'FAST',
            ANV_VCA_DECAY: 0.18,
            ANV_VOLUME: 0.8,
            ANV_TEMPO: 9.5,
          },
        },
        transport: {
          anvil: {
            steps: [
              { pitchVv: -2, velocityVv: 5 },
              { pitchVv: 3, velocityVv: 2 },
              { pitchVv: -2, velocityVv: 4 },
              { pitchVv: 5, velocityVv: 3 },
              { pitchVv: 0, velocityVv: 5 },
              { pitchVv: 3, velocityVv: 2 },
              { pitchVv: -1, velocityVv: 4 },
              { pitchVv: 2, velocityVv: 3 },
            ],
          },
        },
      }),
  },
  {
    id: 'factory-preset-tide-engine',
    name: 'Tide Engine',
    description: 'Cascade polyrhythm drone',
    build: () =>
      coalesceStudioState({
        controls: {
          cascade: {
            CAS_VCO1_FREQ: 261.63, // floor of the 261.63..4186 range
            CAS_VCO2_FREQ: 392,
            CAS_VCO1_WAVE: 'SAW',
            CAS_VCO2_WAVE: 'SAW',
            CAS_VCO1_SUB1_FREQ: 2,
            CAS_VCO1_SUB2_FREQ: 3,
            CAS_VCO2_SUB1_FREQ: 2,
            CAS_VCO2_SUB2_FREQ: 5,
            CAS_VCO1_LEVEL: 0.7,
            CAS_VCO1_SUB1_LEVEL: 0.6,
            CAS_VCO1_SUB2_LEVEL: 0.4,
            CAS_VCO2_LEVEL: 0.6,
            CAS_VCO2_SUB1_LEVEL: 0.5,
            CAS_VCO2_SUB2_LEVEL: 0.3,
            CAS_CUTOFF: 1400,
            CAS_RESONANCE: 0.25,
            CAS_VCF_EG_AMOUNT: 0.4,
            CAS_VCF_DECAY: 1.2,
            CAS_VCA_ATTACK: 0.4,
            CAS_VCA_DECAY: 1.8,
            CAS_QUANTIZE: 'ET12',
            CAS_SEQ_OCT: 'OCT2',
            CAS_TEMPO: 1.5,
            CAS_RHYTHM_1: 3,
            CAS_RHYTHM_2: 4,
            CAS_RHYTHM_3: 5,
            CAS_RHYTHM_4: 7,
            CAS_RHYTHM1_SEQ1: 'ON',
            CAS_RHYTHM2_SEQ2: 'ON',
            CAS_RHYTHM3_SEQ1: 'ON',
            CAS_RHYTHM4_SEQ2: 'ON',
            CAS_SEQ1_ASSIGN_OSC: 'ON',
            CAS_SEQ2_ASSIGN_OSC: 'ON',
            CAS_SEQ1_ASSIGN_SUB1: 'ON',
            CAS_SEQ2_ASSIGN_SUB1: 'ON',
            CAS_SEQ1_STEP_2: 0.5,
            CAS_SEQ1_STEP_4: -0.5,
            CAS_SEQ2_STEP_3: 0.5,
          },
        },
      }),
  },
  {
    id: 'factory-preset-corner-store',
    name: 'Corner Store',
    description: 'Sampler + drum beat (factory sounds)',
    build: () =>
      coalesceStudioState({
        controls: {
          monarch: {
            MON_TEMPO: 120, // drum grid syncs to the Monarch master 16ths
          },
        },
        sampler: {
          pads: [
            { sampleId: 'factory-kick', sampleName: 'Kick', level: 0.85, tuneSemis: 0, loop: false },
            { sampleId: 'factory-hat-closed', sampleName: 'Closed Hat', level: 0.7, tuneSemis: 0, loop: false },
            { sampleId: 'factory-tom', sampleName: 'Low Tom', level: 0.75, tuneSemis: -2, loop: false },
            defaultPad(),
            defaultPad(),
            defaultPad(),
            defaultPad(),
            defaultPad(),
          ],
          quantize: '1 BAR',
          pattern: cornerStorePattern(),
          seqRunning: false,
        },
      }),
  },
  {
    id: 'factory-preset-furnace-room',
    name: 'Furnace Room',
    description: 'Bomber deep bass on the Courier',
    build: () =>
      coalesceStudioState({
        controls: {
          courier: {
            // DEEP STACK: OSC 1 an octave down (16' = -1 vv) + a hot sub one octave below that
            // (-2 vv floor), OSC 2 an octave up (8') for presence/bite.
            COU_OSC1_OCTAVE: '16',
            COU_OSC2_OCTAVE: '8',
            COU_OSC2_FREQ: 0.2, // a hair of detune = width without mud
            COU_OSC1_WAVESHAPE: 0.5, // wavefold grit
            COU_OSC2_WAVESHAPE: 0.62,
            COU_SUB_WAVE: 0.15, // keep the sub mostly pure for weight
            // DYNAMIC GRIT: the filter EG drives OSC 2's wavefold on every hit (aggressive attack).
            COU_MOD_DEST: 'FENV_OSC2_WAVE',
            COU_MOD_AMOUNT: 0.3,
            // HOT MIXER = warm drive into the ladder.
            COU_MIX_OSC1: 0.95,
            COU_MIX_OSC2: 0.85,
            COU_MIX_SUB: 0.7,
            // FAT 4-POLE LADDER, resonant growl, bass-compensated so the low end survives resonance.
            COU_FILTER_MODE: 'LP4',
            COU_CUTOFF: 240,
            COU_RESONANCE: 0.62,
            COU_RES_BASS: 'ON',
            COU_EG_AMOUNT: 0.7, // strong filter-EG punch per note
            COU_F_ENV_VEL: 'ON', // play harder = more bite
            COU_F_ATTACK: 0.003,
            COU_F_DECAY: 0.22,
            COU_F_SUSTAIN: 0.25,
            COU_F_RELEASE: 0.12,
            // TIGHT, SUSTAINED amp env; retrigger the EGs on every note so each hit re-punches.
            COU_A_ATTACK: 0.003,
            COU_A_DECAY: 0.18,
            COU_A_SUSTAIN: 0.9,
            COU_A_RELEASE: 0.1,
            COU_MULTI_TRIG: 'ON',
            COU_VOLUME: 0.85,
            COU_GLIDE: 0.02, // a touch of swagger on the glide steps
            COU_TEMPO: 112,
          },
        },
        courier: {
          seq: {
            endStep: 16,
            swingPct: 54,
            clockDivIdx: 3, // '1/16'
            mode: 'SEQ',
            steps: FURNACE_ROOM_RIFF.map((n) => ({
              noteVv: n.semi / 12,
              gateLength: n.gate,
              rest: n.rest ?? false,
              glide: n.glide ?? false,
            })),
          },
        },
      }),
  },
];

/** Resolve a factory preset to a built StudioState. Unknown id -> null (no throw). */
export function getFactoryPreset(id: string): StudioState | null {
  return FACTORY_PRESETS.find((p) => p.id === id)?.build() ?? null;
}

/** The read accessor the UI imports DIRECTLY for the FACTORY section (NOT a bridge method). */
export function listFactoryPresets(): { id: string; name: string; description: string }[] {
  return FACTORY_PRESETS.map(({ id, name, description }) => ({ id, name, description }));
}
