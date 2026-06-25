/**
 * G5 sampler pop-out — samplerHost unit tests (Node, no Web Audio).
 *
 *  - applyMsg dispatches each pop-out ACTION verb to the matching engineBridge method;
 *  - a 'load' message reconstructs a File from the raw bytes (name + mime preserved) and forwards
 *    it to engineBridge.loadPadSample;
 *  - startSamplerHost broadcasts a mirror on a child 'hello' and on store changes, and applies
 *    incoming actions.
 */
import { describe, expect, it, vi } from 'vitest';
import { engineBridge } from '../../src/ui/engineBridge';
import { applyMsg, readMirror, startSamplerHost } from '../../src/ui/sampler/samplerHost';
import type { Msg, SamplerChannel } from '../../src/ui/sampler/samplerChannel';

describe('samplerHost.applyMsg', () => {
  it('dispatches action verbs to engineBridge', () => {
    const audition = vi.spyOn(engineBridge, 'auditionPad').mockImplementation(() => {});
    const toggle = vi.spyOn(engineBridge, 'toggleStep').mockImplementation(() => {});
    const run = vi.spyOn(engineBridge, 'drumRun').mockImplementation(() => {});
    const setSwing = vi.spyOn(engineBridge, 'setDrumSwing').mockImplementation(() => {});

    applyMsg({ t: 'audition', pad: 5 });
    applyMsg({ t: 'toggleStep', track: 1, step: 2 });
    applyMsg({ t: 'drumRun' });
    applyMsg({ t: 'setDrumSwing', pct: 70 });

    expect(audition).toHaveBeenCalledWith(5);
    expect(toggle).toHaveBeenCalledWith(1, 2);
    expect(run).toHaveBeenCalledTimes(1);
    expect(setSwing).toHaveBeenCalledWith(70);

    vi.restoreAllMocks();
  });

  it("a 'load' reconstructs a File from the raw bytes and forwards it", () => {
    const load = vi.spyOn(engineBridge, 'loadPadSample').mockResolvedValue(undefined);
    const bytes = new Uint8Array([9, 8, 7]).buffer;
    applyMsg({ t: 'load', pad: 2, name: 'snare.wav', mime: 'audio/wav', bytes });

    expect(load).toHaveBeenCalledTimes(1);
    const [pad, file] = load.mock.calls[0]!;
    expect(pad).toBe(2);
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe('snare.wav');
    expect((file as File).type).toBe('audio/wav');
    expect((file as File).size).toBe(3);

    vi.restoreAllMocks();
  });

  it('ignores host-input verbs (mirror/hello/bye) as no-ops', () => {
    // None of these should throw or call an action.
    expect(() => applyMsg({ t: 'hello' })).not.toThrow();
    expect(() => applyMsg({ t: 'bye' })).not.toThrow();
  });
});

describe('samplerHost.readMirror', () => {
  it('reads a fully-populated serializable mirror from engineBridge', () => {
    const mirror = readMirror();
    expect(mirror.pads).toHaveLength(8);
    expect(typeof mirror.quantize).toBe('string');
    expect(typeof mirror.kitId).toBe('string');
    expect(mirror.pattern).toHaveLength(8);
    expect(mirror.pattern[0]).toHaveLength(16);
    expect(typeof mirror.drumNumSteps).toBe('number');
    expect(typeof mirror.drumSwingPct).toBe('number');
    expect(typeof mirror.drumRunning).toBe('boolean');
    expect(typeof mirror.monarchRunning).toBe('boolean');
    // The mirror is structured-cloneable: JSON round-trips without loss.
    expect(JSON.parse(JSON.stringify(mirror))).toEqual(mirror);
  });
});

/** A loopback channel: post() delivers to all subscribers synchronously. */
function loopbackChannel(): SamplerChannel & { posted: Msg[] } {
  const posted: Msg[] = [];
  const subs = new Set<(m: Msg) => void>();
  return {
    posted,
    post: (msg) => {
      posted.push(msg);
      for (const s of subs) s(msg);
    },
    subscribe: (handler) => {
      subs.add(handler);
      return () => subs.delete(handler);
    },
    close: () => subs.clear(),
  };
}

describe('startSamplerHost', () => {
  it("broadcasts a mirror on a child 'hello'", () => {
    const ch = loopbackChannel();
    const teardown = startSamplerHost(ch);
    ch.posted.length = 0; // ignore any startup posts

    // Simulate a child saying hello (the host subscribes to the SAME channel via loopback).
    ch.post({ t: 'hello' });
    // The host should have answered with at least one 'mirror'.
    expect(ch.posted.some((m) => m.t === 'mirror')).toBe(true);

    teardown();
  });

  it('applies an incoming action via the channel', () => {
    const run = vi.spyOn(engineBridge, 'drumRun').mockImplementation(() => {});
    const ch = loopbackChannel();
    const teardown = startSamplerHost(ch);
    ch.post({ t: 'drumRun' });
    expect(run).toHaveBeenCalled();
    teardown();
    vi.restoreAllMocks();
  });

  it('broadcasts a mirror when the store changes', () => {
    const ch = loopbackChannel();
    const teardown = startSamplerHost(ch);
    ch.posted.length = 0;
    // A store write (safe unpowered) should trigger a mirror broadcast.
    engineBridge.setQuantize('1/8');
    expect(ch.posted.some((m) => m.t === 'mirror')).toBe(true);
    teardown();
    // restore default to not bleed into sibling tests
    engineBridge.setQuantize('1 BAR');
  });
});
