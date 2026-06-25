/**
 * Studio external-MIDI-clock MASTER + watchdog (AudioContext-free).
 *
 * The Studio constructor is audio-free, but onMidiClockStart / the watchdog guard on the private
 * `built` flag (normally flipped by powerOn, which needs an AudioContext) and read
 * context.audioContext.currentTime on the resume path. We therefore construct a Studio, force
 * `built` true, and stub `context.audioContext` with a minimal { currentTime } — exactly the two
 * seams the master/watchdog code touches — so the divider→follower routing is testable in Node.
 */

import { describe, expect, it, vi } from 'vitest';
import { Studio } from '../../src/engine/studio';

interface StudioPrivates {
  built: boolean;
  midiClockMaster: boolean;
  monarchTempoPatched: boolean;
  routeMidiEdge(t: number): void;
  bindCascadeEvent(e: unknown): void;
  bindMonarchEvent(e: unknown): void;
}

/**
 * A Studio with `built` forced and a fake audio clock, ready for MIDI-master tests. The audio
 * MODULES (this.cascade / this.monarch) are only constructed by powerOn (needs an AudioContext),
 * so we stub the two event binders to no-ops: the divider→external-edge ROUTING (tickIndex, the
 * externalClock flags, master state) is what we assert here; sample-accurate binding is proven
 * headlessly by the audio battery (B3 midiClockDrivesCascade).
 */
function armedStudio(): Studio {
  const studio = new Studio();
  const priv = studio as unknown as StudioPrivates;
  priv.built = true;
  // Stub the audioContext seam the resume path reads (currentTime + 0.03).
  Object.defineProperty(studio.context, 'audioContext', {
    configurable: true,
    get: () => ({ currentTime: 1.0 }) as unknown as AudioContext,
  });
  priv.bindCascadeEvent = () => {};
  priv.bindMonarchEvent = () => {};
  return studio;
}

describe('Studio — external MIDI clock master', () => {
  it('onMidiClockStart sets master and flips cascadeClock.externalClock true', () => {
    const studio = armedStudio();
    expect(studio.isMidiClockMaster()).toBe(false);
    expect(studio.cascadeClock.externalClock).toBe(false);

    studio.onMidiClockStart();

    expect(studio.isMidiClockMaster()).toBe(true);
    expect(studio.cascadeClock.externalClock).toBe(true);
    // Monarch follows MIDI (no analog TEMPO cable patched).
    expect(studio.monarchSeq.externalClock).toBe(true);
  });

  it('onMidiClockTick advances the Cascade one step every 6 ticks while master', () => {
    const studio = armedStudio();
    studio.onMidiClockStart();
    const before = studio.cascadeClock.currentTick;
    // 6 ticks = one 16th = one external edge to the Cascade.
    for (let i = 0; i < 6; i++) studio.onMidiClockTick(i * 0.02);
    expect(studio.cascadeClock.currentTick).toBe(before + 1);
    // 6 more ticks -> another edge.
    for (let i = 6; i < 12; i++) studio.onMidiClockTick(i * 0.02);
    expect(studio.cascadeClock.currentTick).toBe(before + 2);
  });

  it('onMidiClockStop releases master and recomputes follower priority', () => {
    const studio = armedStudio();
    studio.onMidiClockStart();
    expect(studio.isMidiClockMaster()).toBe(true);

    studio.onMidiClockStop();

    expect(studio.isMidiClockMaster()).toBe(false);
    expect(studio.cascadeClock.externalClock).toBe(false);
    expect(studio.monarchSeq.externalClock).toBe(false);
  });
});

describe('Studio — analog MON_TEMPO IN priority over MIDI master (U5 hardening)', () => {
  // Pins the one untested branch in routeMidiEdge: when an analog cable is in MON_TEMPO_IN, the
  // Monarch follows the ANALOG edge (analog > MIDI > internal), so a MIDI master edge must NOT also
  // advance it (double-clocking). Both clocks can be "active" at once — externalClock stays true
  // (it is OR'd from analog|MIDI) but only the analog edge steps the Monarch.
  it('with MON_TEMPO_IN patched under a MIDI master, the Monarch is externally clocked but routeMidiEdge does NOT advance it', () => {
    const studio = armedStudio();
    const priv = studio as unknown as StudioPrivates;

    // Monarch running so an edge WOULD advance it if it consumed the MIDI tick.
    studio.monarchSeq.running = true;
    studio.onMidiClockStart(); // become MIDI master
    expect(studio.isMidiClockMaster()).toBe(true);

    // Simulate rebuildRouting's outcome with a cable in MON_TEMPO_IN: analog patched, and the
    // Monarch's externalClock is the OR of analog|MIDI (here both) — still externally clocked.
    priv.monarchTempoPatched = true;
    studio.monarchSeq.externalClock = true;
    expect(studio.monarchSeq.externalClock).toBe(true);

    const before = studio.monarchSeq.currentStep;
    const cascadeBefore = studio.cascadeClock.currentTick;
    priv.routeMidiEdge(0.05);

    // MIDI drives the Cascade as usual...
    expect(studio.cascadeClock.currentTick).toBe(cascadeBefore + 1);
    // ...but the analog-patched Monarch is left for its own analog edge — no double-clock.
    expect(studio.monarchSeq.currentStep).toBe(before);
  });

  it('without the analog cable, the MIDI master edge DOES advance the Monarch (control case)', () => {
    const studio = armedStudio();
    const priv = studio as unknown as StudioPrivates;
    studio.monarchSeq.running = true;
    studio.onMidiClockStart();
    priv.monarchTempoPatched = false; // no analog cable -> Monarch follows MIDI

    const before = studio.monarchSeq.currentStep;
    priv.routeMidiEdge(0.05);
    expect(studio.monarchSeq.currentStep).not.toBe(before);
  });
});

describe('Studio — MIDI clock watchdog (graceful fallback)', () => {
  it('checkMidiClockWatchdog is a no-op when not master', () => {
    const studio = armedStudio();
    const rebuild = vi.spyOn(studio.monarchSeq, 'resumeInternal');
    studio.checkMidiClockWatchdog(100); // not master
    expect(studio.isMidiClockMaster()).toBe(false);
    expect(rebuild).not.toHaveBeenCalled();
  });

  it('does NOT drop master under normal tick jitter (gap below the watchdog window)', () => {
    const studio = armedStudio();
    studio.onMidiClockStart();
    studio.onMidiClockTick(0.0);
    // a small jitter gap well under MIDI_CLOCK_WATCHDOG_GAP_S
    studio.checkMidiClockWatchdog(0.0 + 0.1);
    expect(studio.isMidiClockMaster()).toBe(true);
  });

  it('auto-releases master after a long pulse stall (no Stop) and re-anchors a running Monarch', () => {
    const studio = armedStudio();
    studio.onMidiClockStart();
    studio.onMidiClockTick(0.0);
    // Simulate the Monarch running on the MIDI master (so the resume branch is exercised).
    studio.monarchSeq.running = true;
    const resume = vi.spyOn(studio.monarchSeq, 'resumeInternal');

    // A long stall: now is well past the last tick + the watchdog gap.
    studio.checkMidiClockWatchdog(0.0 + Studio.MIDI_CLOCK_WATCHDOG_GAP_S + 0.5);

    expect(studio.isMidiClockMaster()).toBe(false);
    expect(studio.monarchSeq.externalClock).toBe(false); // back to internal
    expect(resume).toHaveBeenCalledTimes(1); // re-anchored
  });
});
