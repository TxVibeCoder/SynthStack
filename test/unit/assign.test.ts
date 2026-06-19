import { describe, expect, it } from 'vitest';
import { ASSIGN_SOURCES, assignSourceValue, type AssignFacts } from '../../src/engine/assign';

const facts = (over: Partial<AssignFacts> = {}): AssignFacts => ({
  stepIndex: 0,
  endStep: 8,
  tickCount: 0,
  accent: false,
  isStep1: true,
  ...over,
});

describe('Monarch ASSIGN source selection (Setup-mode page 1, 9 analog sources)', () => {
  it('lists exactly the 9 analog sources', () => {
    expect(ASSIGN_SOURCES).toHaveLength(9);
  });

  it('CLOCK pulses every step', () => {
    expect(assignSourceValue('CLOCK', facts({ tickCount: 0 }), 0)).toEqual({ kind: 'pulse' });
    expect(assignSourceValue('CLOCK', facts({ tickCount: 5 }), 0)).toEqual({ kind: 'pulse' });
  });

  it('CLOCK/2 and CLOCK/4 divide the step clock', () => {
    expect(assignSourceValue('CLOCK_2', facts({ tickCount: 0 }), 0).kind).toBe('pulse');
    expect(assignSourceValue('CLOCK_2', facts({ tickCount: 1 }), 0).kind).toBe('none');
    expect(assignSourceValue('CLOCK_2', facts({ tickCount: 2 }), 0).kind).toBe('pulse');
    expect(assignSourceValue('CLOCK_4', facts({ tickCount: 4 }), 0).kind).toBe('pulse');
    expect(assignSourceValue('CLOCK_4', facts({ tickCount: 2 }), 0).kind).toBe('none');
  });

  it('ACCENT pulses only on accented steps; STEP1 only on step 0', () => {
    expect(assignSourceValue('ACCENT', facts({ accent: true }), 0).kind).toBe('pulse');
    expect(assignSourceValue('ACCENT', facts({ accent: false }), 0).kind).toBe('none');
    expect(assignSourceValue('STEP1_TRIG', facts({ isStep1: true }), 0).kind).toBe('pulse');
    expect(assignSourceValue('STEP1_TRIG', facts({ isStep1: false }), 0).kind).toBe('none');
  });

  it('STEP RAMP rises 0→+5 across the pattern; SAW is its inverse', () => {
    expect(assignSourceValue('STEP_RAMP', facts({ stepIndex: 0, endStep: 8 }), 0)).toEqual({ kind: 'level', vv: 0 });
    expect(assignSourceValue('STEP_RAMP', facts({ stepIndex: 7, endStep: 8 }), 0)).toEqual({ kind: 'level', vv: 5 });
    expect(assignSourceValue('STEP_SAW', facts({ stepIndex: 0, endStep: 8 }), 0)).toEqual({ kind: 'level', vv: 5 });
  });

  it('STEP TRI peaks mid-pattern, troughs at the ends', () => {
    const mid = assignSourceValue('STEP_TRI', facts({ stepIndex: 4, endStep: 9 }), 0); // span 8, phase 0.5
    const end = assignSourceValue('STEP_TRI', facts({ stepIndex: 8, endStep: 9 }), 0);
    expect((mid as { vv: number }).vv).toBeCloseTo(5, 6);
    expect((end as { vv: number }).vv).toBeCloseTo(0, 6);
  });

  it('STEP RANDOM maps the injected rand to 0..+5 (randomness comes from the shell)', () => {
    expect(assignSourceValue('STEP_RANDOM', facts(), 0)).toEqual({ kind: 'level', vv: 0 });
    expect(assignSourceValue('STEP_RANDOM', facts(), 1)).toEqual({ kind: 'level', vv: 5 });
    expect((assignSourceValue('STEP_RANDOM', facts(), 0.5) as { vv: number }).vv).toBeCloseTo(2.5, 6);
  });
});
