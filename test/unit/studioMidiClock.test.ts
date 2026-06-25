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
