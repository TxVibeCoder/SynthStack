import { describe, expect, it } from 'vitest';
import { MidiClock, MIDI_PPQN, TICKS_PER_SIXTEENTH } from '../../src/engine/sequencers/midiClock';

/** Feed `count` 24-PPQN ticks at `bpm`, return the audio times of the 16th-note edges (running). */
function run(clock: MidiClock, count: number, bpm: number, startAt = 0): number[] {
  const tickDur = 60 / (bpm * MIDI_PPQN);
  const edges: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = startAt + i * tickDur;
    if (clock.onTick(t)) edges.push(t);
  }
  return edges;
}

describe('MidiClock — 24-PPQN ÷6 → 16th notes', () => {
  it('TICKS_PER_SIXTEENTH is 24 PPQN ÷ 4 = 6 (= the Cascade 4 PPQN)', () => {
    expect(MIDI_PPQN).toBe(24);
    expect(TICKS_PER_SIXTEENTH).toBe(6);
  });

  it('fires a 16th edge every 6th tick once started', () => {
    const c = new MidiClock();
    c.start();
    const edges = run(c, 24, 120); // 24 ticks = 1 quarter = 4 sixteenths
    expect(edges).toHaveLength(4);
  });

  it('does not fire until Start (Stop halts firing)', () => {
    const c = new MidiClock();
    // ticks arriving before Start: divider counts but nothing fires
    expect(run(c, 12, 120)).toHaveLength(0);
    c.start();
    expect(run(c, 6, 120, 1.0)).toHaveLength(1);
    c.stop();
    expect(run(c, 12, 120, 2.0)).toHaveLength(0);
  });

  it('Start realigns the ÷6 phase to a downbeat; Continue keeps the phase', () => {
    const c = new MidiClock();
    c.start();
    c.onTick(0); // phase 0 → fires, advance to 1
    c.onTick(0.01); // phase 1
    // Start again: next tick must be a fresh downbeat
    c.start();
    expect(c.onTick(0.5)).toBe(true);
    // Continue does NOT realign: after a non-downbeat tick, the next is not a downbeat
    c.continue();
    c.onTick(0.51); // phase 1
    expect(c.onTick(0.52)).toBe(false);
  });

  it('estimates tempo from the inter-tick interval', () => {
    const c = new MidiClock();
    c.start();
    run(c, 96, 140); // settle the smoothed estimate over a few quarters
    expect(c.tempoBpm).toBeGreaterThan(132);
    expect(c.tempoBpm).toBeLessThan(148);
  });
});

describe('MidiClock — watchdog stale predicate (lastTickTime + staleSince)', () => {
  it('lastTickTime tracks the most recent tick and resets to -1 on start/reset', () => {
    const c = new MidiClock();
    expect(c.lastTickTime).toBe(-1);
    c.start();
    expect(c.lastTickTime).toBe(-1); // start re-arms — no tick seen yet
    c.onTick(0.5);
    expect(c.lastTickTime).toBe(0.5);
    c.onTick(0.6);
    expect(c.lastTickTime).toBeCloseTo(0.6);
    c.reset();
    expect(c.lastTickTime).toBe(-1);
  });

  it('a stopped clock is never stale (no Start, or after Stop)', () => {
    const c = new MidiClock();
    // never started
    expect(c.staleSince(100, 0.5)).toBe(false);
    c.start();
    c.onTick(0);
    c.stop();
    expect(c.staleSince(100, 0.5)).toBe(false); // huge gap but not running
  });

  it('a running clock with no tick yet is never stale', () => {
    const c = new MidiClock();
    c.start(); // running, but lastTickTime still -1
    expect(c.staleSince(100, 0.5)).toBe(false);
  });

  it('after ticks then a long gap reports stale; a fresh tick clears it', () => {
    const c = new MidiClock();
    c.start();
    run(c, 24, 120); // settle, last tick lands within the first beat
    const last = c.lastTickTime;
    expect(c.staleSince(last + 0.1, 0.5)).toBe(false); // small jitter, not stale
    expect(c.staleSince(last + 0.49, 0.5)).toBe(false); // just under the gap
    expect(c.staleSince(last + 0.5, 0.5)).toBe(true); // at the gap -> stale
    expect(c.staleSince(last + 2.0, 0.5)).toBe(true); // well past -> stale
    c.onTick(last + 2.0); // a fresh tick arrives
    expect(c.staleSince(last + 2.1, 0.5)).toBe(false); // cleared
  });
});
