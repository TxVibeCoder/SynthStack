/**
 * G5 sampler pop-out — samplerChannel unit tests (Node, no Web Audio).
 *
 * Covers:
 *  - every `Msg` discriminant narrows via isSamplerMsg; malformed / unknown messages are ignored;
 *  - the transport SELECTION: BroadcastChannel is preferred when present; a postMessage fallback
 *    is used when BroadcastChannel is absent — verified by mocking the globals.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSamplerChannel,
  isSamplerMsg,
  SAMPLER_CHANNEL,
  type Msg,
} from '../../src/ui/sampler/samplerChannel';

// A representative instance of EVERY message variant (one per `t`).
const ALL_MSGS: Msg[] = [
  { t: 'mirror', mirror: {
    pads: [], quantize: '1 BAR', kitId: 'k', pattern: [], drumNumSteps: 16, drumSwingPct: 50,
    drumRunning: false, monarchRunning: false,
  } },
  { t: 'hello' },
  { t: 'bye' },
  { t: 'audition', pad: 0 },
  { t: 'setPadControl', pad: 1, control: 'level', value: 0.5 },
  { t: 'commitPadControl', pad: 1, control: 'tuneSemis', value: 3 },
  { t: 'setPadLoop', pad: 2, on: true },
  { t: 'load', pad: 3, name: 'k.wav', mime: 'audio/wav', bytes: new ArrayBuffer(4) },
  { t: 'assignFactoryToPad', pad: 4, factoryId: 'factory-kick' },
  { t: 'selectKit', kitId: 'analog' },
  { t: 'setQuantize', division: '1/8' },
  { t: 'toggleStep', track: 0, step: 5 },
  { t: 'drumRun' },
  { t: 'drumStop' },
  { t: 'clearDrumPattern' },
  { t: 'setDrumNumSteps', n: 8 },
  { t: 'setDrumSwing', pct: 62 },
];

describe('isSamplerMsg', () => {
  it('narrows every Msg variant to true', () => {
    for (const msg of ALL_MSGS) expect(isSamplerMsg(msg)).toBe(true);
  });

  it('ignores malformed / unknown payloads', () => {
    expect(isSamplerMsg(null)).toBe(false);
    expect(isSamplerMsg(undefined)).toBe(false);
    expect(isSamplerMsg(42)).toBe(false);
    expect(isSamplerMsg('drumRun')).toBe(false);
    expect(isSamplerMsg({})).toBe(false);
    expect(isSamplerMsg({ t: 999 })).toBe(false);
    expect(isSamplerMsg({ t: 'notAMessage' })).toBe(false);
    expect(isSamplerMsg({ type: 'drumRun' })).toBe(false); // wrong key
  });
});

// ---- transport selection -------------------------------------------------------------------

/** A tiny BroadcastChannel stand-in that records construction + posts. */
class FakeBroadcastChannel {
  static instances: FakeBroadcastChannel[] = [];
  posted: unknown[] = [];
  closed = false;
  private listeners = new Set<(e: MessageEvent) => void>();
  constructor(public name: string) {
    FakeBroadcastChannel.instances.push(this);
  }
  postMessage(data: unknown) {
    this.posted.push(data);
  }
  addEventListener(_t: 'message', cb: (e: MessageEvent) => void) {
    this.listeners.add(cb);
  }
  removeEventListener(_t: 'message', cb: (e: MessageEvent) => void) {
    this.listeners.delete(cb);
  }
  close() {
    this.closed = true;
  }
  /** Test helper: deliver a message to subscribers. */
  emit(data: unknown) {
    for (const cb of this.listeners) cb({ data } as MessageEvent);
  }
}

describe('createSamplerChannel transport selection', () => {
  const origBC = globalThis.BroadcastChannel;

  afterEach(() => {
    globalThis.BroadcastChannel = origBC;
    FakeBroadcastChannel.instances = [];
    vi.restoreAllMocks();
  });

  it('prefers BroadcastChannel when available (named synthstack-sampler)', () => {
    globalThis.BroadcastChannel = FakeBroadcastChannel as unknown as typeof BroadcastChannel;
    const ch = createSamplerChannel();
    expect(FakeBroadcastChannel.instances).toHaveLength(1);
    const bc = FakeBroadcastChannel.instances[0]!;
    expect(bc.name).toBe(SAMPLER_CHANNEL);

    // post → BroadcastChannel.postMessage
    ch.post({ t: 'drumRun' });
    expect(bc.posted).toEqual([{ t: 'drumRun' }]);

    // subscribe receives valid messages, ignores malformed ones
    const seen: Msg[] = [];
    const unsub = ch.subscribe((m) => seen.push(m));
    bc.emit({ t: 'drumStop' });
    bc.emit({ t: 'garbage' }); // ignored by the guard
    expect(seen).toEqual([{ t: 'drumStop' }]);

    unsub();
    bc.emit({ t: 'drumRun' });
    expect(seen).toHaveLength(1); // unsubscribed

    ch.close();
    expect(bc.closed).toBe(true);
  });

  it('falls back to window.postMessage when BroadcastChannel is absent', () => {
    // Remove BroadcastChannel so the fallback branch is taken.
    // @ts-expect-error — deleting an optional global for the test
    delete globalThis.BroadcastChannel;

    const other = { postMessage: vi.fn() } as unknown as Window;
    const ch = createSamplerChannel(other);

    ch.post({ t: 'drumRun' });
    // The fallback wraps the message and posts to the counterpart window.
    expect((other.postMessage as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    const [payload] = (other.postMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(payload).toMatchObject({ __synthstackSampler: true, msg: { t: 'drumRun' } });

    // No BroadcastChannel instance was constructed.
    expect(FakeBroadcastChannel.instances).toHaveLength(0);
  });
});
