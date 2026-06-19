/**
 * Monarch ASSIGN output source selection (Setup-mode page 1) — PURE.
 *
 * The 9 ANALOG sources are modeled here. The 7 MIDI sources (MIDI VELOCITY / CHANNEL PRESSURE /
 * PITCH BEND / CC 1·2·4·7) need MIDI CC/bend decode that the project does not have yet and are
 * deferred. The ASSIGN jack range is 0..+5 V (data/monarch.json). Randomness for STEP RANDOM is
 * passed IN from the shell (studio.ts) — this stays pure/Node-testable.
 */

export type AssignSource =
  | 'ACCENT'
  | 'CLOCK'
  | 'CLOCK_2'
  | 'CLOCK_4'
  | 'STEP_RAMP'
  | 'STEP_SAW'
  | 'STEP_TRI'
  | 'STEP_RANDOM'
  | 'STEP1_TRIG';

export const ASSIGN_SOURCES: AssignSource[] = [
  'ACCENT', 'CLOCK', 'CLOCK_2', 'CLOCK_4', 'STEP_RAMP', 'STEP_SAW', 'STEP_TRI', 'STEP_RANDOM', 'STEP1_TRIG',
];

export interface AssignFacts {
  stepIndex: number; // 0 .. endStep-1
  endStep: number; // 1..32
  tickCount: number; // elapsed 16ths (monotonic — survives endStep/HOLD)
  accent: boolean; // this step is accented
  isStep1: boolean; // stepIndex === 0
}

export type AssignAction =
  | { kind: 'pulse' } // a +5 V trigger pulse this step (clock-type sources)
  | { kind: 'level'; vv: number } // a held CV level 0..+5 V (step-shape sources)
  | { kind: 'none' }; // emits nothing this step

const ASSIGN_MAX_VV = 5;

/** What the ASSIGN output should do on the current step for the selected source. */
export function assignSourceValue(source: AssignSource, f: AssignFacts, rand: number): AssignAction {
  const span = Math.max(1, f.endStep - 1);
  const phase = f.stepIndex / span; // 0..1 across the pattern
  const r = rand < 0 ? 0 : rand > 1 ? 1 : rand;
  switch (source) {
    case 'CLOCK':
      return { kind: 'pulse' };
    case 'CLOCK_2':
      return f.tickCount % 2 === 0 ? { kind: 'pulse' } : { kind: 'none' };
    case 'CLOCK_4':
      return f.tickCount % 4 === 0 ? { kind: 'pulse' } : { kind: 'none' };
    case 'ACCENT':
      return f.accent ? { kind: 'pulse' } : { kind: 'none' };
    case 'STEP1_TRIG':
      return f.isStep1 ? { kind: 'pulse' } : { kind: 'none' };
    case 'STEP_RAMP':
      return { kind: 'level', vv: phase * ASSIGN_MAX_VV };
    case 'STEP_SAW':
      return { kind: 'level', vv: (1 - phase) * ASSIGN_MAX_VV };
    case 'STEP_TRI':
      return { kind: 'level', vv: (1 - Math.abs(2 * phase - 1)) * ASSIGN_MAX_VV };
    case 'STEP_RANDOM':
      return { kind: 'level', vv: r * ASSIGN_MAX_VV };
  }
}
