import { describe, expect, it } from 'vitest';
import { AnvilSequencer } from '../../src/engine/sequencers/anvilseq';
import { Scheduler, type TransportEvent } from '../../src/engine/scheduler';

describe('Anvil sequencer (work order §10.2)', () => {
  it('running: fires current step then advances, 8-step wrap, exact spacing', () => {
    const seq = new AnvilSequencer();
    seq.rateHz = 10; // 100 ms steps
    seq.steps.forEach((s, i) => (s.pitchVv = i));
    let now = 0;
    const out: TransportEvent[] = [];
    const sched = new Scheduler(() => now, 0.1);
    sched.add(seq, (e) => out.push(e));
    seq.start(0);
    while (now < 1.0) {
      sched.pump();
      now += 0.025;
    }
    const steps = out.filter((e) => e.type === 'step' && e.time < 1.0 - 1e-6);
    const trigs = out.filter((e) => e.type === 'trigger' && e.time < 1.0 - 1e-6);
    expect(steps).toHaveLength(10);
    expect(trigs).toHaveLength(10); // every step triggers — no rests, no gates
    steps.forEach((e, k) => {
      expect(e.time).toBeCloseTo(k * 0.1, 10);
      expect(e.data?.['stepIndex']).toBe(k % 8); // wraps after 8
      expect(e.data?.['pitchVv']).toBe(k % 8);
    });
  });

  it('stopped: ADVANCE moves without trigger; TRIGGER fires without advancing', () => {
    const seq = new AnvilSequencer();
    expect(seq.currentStep).toBe(0);

    const adv = seq.manualAdvance(1.0);
    expect(seq.currentStep).toBe(1);
    expect(adv.some((e) => e.type === 'trigger')).toBe(false);
    expect(adv.some((e) => e.type === 'step')).toBe(true);

    const trig = seq.manualTrigger(2.0);
    expect(seq.currentStep).toBe(1); // did not advance
    expect(trig.some((e) => e.type === 'trigger')).toBe(true);
    expect(trig.find((e) => e.type === 'step')?.data?.['stepIndex']).toBe(1);
  });

  it('external clock: internal clock ignored, edges advance AND trigger', () => {
    const seq = new AnvilSequencer();
    seq.externalClock = true;
    seq.rateHz = 100;
    seq.start(0);
    expect(seq.pullEventsAt(seq.nextEventTime)).toEqual([]); // internal clock muted

    const e1 = seq.onExternalEdge(0.5);
    expect(seq.currentStep).toBe(1);
    expect(e1.some((e) => e.type === 'trigger')).toBe(true);
    const e2 = seq.onExternalEdge(0.9);
    expect(seq.currentStep).toBe(2);
    expect(e2.find((e) => e.type === 'step')?.time).toBe(0.9);
  });

  it('velocity rides every step event', () => {
    const seq = new AnvilSequencer();
    seq.steps[0]!.velocityVv = 2.5;
    const evs = seq.manualTrigger(0);
    expect(evs.find((e) => e.type === 'trigger')?.data?.['velocityVv']).toBe(2.5);
  });

  it('rate change takes effect from the next boundary', () => {
    const seq = new AnvilSequencer();
    seq.rateHz = 10;
    seq.start(0);
    seq.pullEventsAt(0);
    seq.advance();
    expect(seq.nextEventTime).toBeCloseTo(0.1, 10);
    seq.rateHz = 20;
    seq.pullEventsAt(0.1);
    seq.advance();
    expect(seq.nextEventTime).toBeCloseTo(0.15, 10);
  });
});
