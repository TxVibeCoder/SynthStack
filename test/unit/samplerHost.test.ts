/**
 * G5 sampler pop-out — samplerHost unit tests (Node, no Web Audio).
 *
 *  - applyMsg dispatches each pop-out ACTION verb to the matching engineBridge method;
 *  - a 'load' message reconstructs a File from the raw bytes (name + mime preserved) and forwards
 *    it to engineBridge.loadPadSample;
 *  - startSamplerHost broadcasts a mirror on a child 'hello' and on store changes, and applies
 *    incoming actions.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { engineBridge } from '../../src/ui/engineBridge';
import { applyMsg, readMirror, startSamplerHost } from '../../src/ui/sampler/samplerHost';
import {
  createSamplerChannel,
  registerSamplerChildWindow,
  type Msg,
  type SamplerChannel,
} from '../../src/ui/sampler/samplerChannel';

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

/**
 * Regression — BroadcastChannel-ABSENT fallback. The MAIN-window host starts its channel with NO
 * `other` (no pop-out exists yet) and its own window.opener is null. Before the fix the fallback
 * resolved its target as (other ?? window.opener ?? null) === null, so the host could NEVER post
 * the mirror/hello-reply to the pop-out — the child sat in 'connecting'. With a REGISTERED child
 * window the fallback now reaches it. This drives the REAL createSamplerChannel() (no `other`) so
 * it exercises the shipped fallback path, not the loopback stub.
 */
describe('startSamplerHost fallback delivers to a registered child window (no BroadcastChannel)', () => {
  const origBC = globalThis.BroadcastChannel;
  const origWindow = (globalThis as { window?: unknown }).window;

  afterEach(() => {
    globalThis.BroadcastChannel = origBC;
    registerSamplerChildWindow(null);
    if (origWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window?: unknown }).window = origWindow;
    vi.restoreAllMocks();
  });

  it('posts the hello-reply + store-change mirror to the registered child (target was null before the fix)', () => {
    // Force the postMessage fallback branch.
    // @ts-expect-error — deleting an optional global for the test
    delete globalThis.BroadcastChannel;

    // A MAIN-window with a null opener (exactly the host's context) and a stable origin.
    const childPosts: unknown[] = [];
    const child = {
      closed: false,
      postMessage: (data: unknown) => childPosts.push(data),
    } as unknown as Window;
    (globalThis as { window?: unknown }).window = {
      opener: null,
      location: { origin: 'http://localhost' },
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    // The host opens its channel with NO `other` (matching App -> startSamplerHost -> createSamplerChannel()).
    const channel: SamplerChannel = createSamplerChannel();
    registerSamplerChildWindow(() => child);

    const teardown = startSamplerHost(channel);

    // A store change makes the host broadcast a mirror. Via the postMessage fallback that mirror
    // must land on the REGISTERED child window. (Before the fix the fallback target was null, so
    // childPosts stayed empty and the pop-out never received state.)
    childPosts.length = 0;
    engineBridge.setQuantize('1/8');

    expect(childPosts.length).toBeGreaterThan(0);
    const wrapped = childPosts[childPosts.length - 1] as { __synthstackSampler?: boolean; msg?: Msg };
    expect(wrapped.__synthstackSampler).toBe(true);
    expect(wrapped.msg?.t).toBe('mirror');

    teardown();
    engineBridge.setQuantize('1 BAR');
  });
});
