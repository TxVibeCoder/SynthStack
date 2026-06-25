/**
 * G5 sampler pop-out — samplerBridge unit tests (Node, no Web Audio).
 *
 *  - realSamplerBridge forwards each method 1:1 to the engineBridge singleton (spied; the
 *    methods are all safe unpowered);
 *  - the PROXY bridge (createProxySamplerBridge) posts the correct Msg for each action and serves
 *    getPadState / getQuantize / pattern from the last mirror — incl. the default PadState before
 *    the first mirror arrives.
 */
import { describe, expect, it, vi } from 'vitest';
import { engineBridge } from '../../src/ui/engineBridge';
import { realSamplerBridge } from '../../src/ui/sampler/samplerBridge';
import {
  createProxySamplerBridge,
  emptyPad,
  MirrorStore,
} from '../../src/ui/sampler/proxySamplerBridge';
import type { Msg, SamplerChannel, SamplerMirror } from '../../src/ui/sampler/samplerChannel';

// ---- realSamplerBridge — 1:1 forwarding ----------------------------------------------------

describe('realSamplerBridge forwards 1:1 to engineBridge', () => {
  it('routes each action verb to the matching engineBridge method', () => {
    const audition = vi.spyOn(engineBridge, 'auditionPad').mockImplementation(() => {});
    const setPad = vi.spyOn(engineBridge, 'setPadControl').mockImplementation(() => {});
    const commitPad = vi.spyOn(engineBridge, 'commitPadControl').mockImplementation(() => {});
    const setLoop = vi.spyOn(engineBridge, 'setPadLoop').mockImplementation(() => {});
    const assign = vi.spyOn(engineBridge, 'assignFactoryToPad').mockImplementation(() => {});
    const selectKit = vi.spyOn(engineBridge, 'selectKit').mockImplementation(() => {});
    const setQuant = vi.spyOn(engineBridge, 'setQuantize').mockImplementation(() => {});
    const toggle = vi.spyOn(engineBridge, 'toggleStep').mockImplementation(() => {});
    const run = vi.spyOn(engineBridge, 'drumRun').mockImplementation(() => {});
    const stop = vi.spyOn(engineBridge, 'drumStop').mockImplementation(() => {});
    const clear = vi.spyOn(engineBridge, 'clearDrumPattern').mockImplementation(() => {});
    const setLen = vi.spyOn(engineBridge, 'setDrumNumSteps').mockImplementation(() => {});
    const setSwing = vi.spyOn(engineBridge, 'setDrumSwing').mockImplementation(() => {});

    realSamplerBridge.auditionPad(2);
    realSamplerBridge.setPadControl(1, 'level', 0.5);
    realSamplerBridge.commitPadControl(1, 'tuneSemis', 3);
    realSamplerBridge.setPadLoop(4, true);
    realSamplerBridge.assignFactoryToPad(0, 'factory-kick');
    realSamplerBridge.selectKit('analog');
    realSamplerBridge.setQuantize('1/8');
    realSamplerBridge.toggleStep(2, 5);
    realSamplerBridge.drumRun();
    realSamplerBridge.drumStop();
    realSamplerBridge.clearDrumPattern();
    realSamplerBridge.setDrumNumSteps(8);
    realSamplerBridge.setDrumSwing(62);

    expect(audition).toHaveBeenCalledWith(2);
    expect(setPad).toHaveBeenCalledWith(1, 'level', 0.5);
    expect(commitPad).toHaveBeenCalledWith(1, 'tuneSemis', 3);
    expect(setLoop).toHaveBeenCalledWith(4, true);
    expect(assign).toHaveBeenCalledWith(0, 'factory-kick');
    expect(selectKit).toHaveBeenCalledWith('analog');
    expect(setQuant).toHaveBeenCalledWith('1/8');
    expect(toggle).toHaveBeenCalledWith(2, 5);
    expect(run).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(setLen).toHaveBeenCalledWith(8);
    expect(setSwing).toHaveBeenCalledWith(62);

    vi.restoreAllMocks();
  });

  it('serves snapshot getters from engineBridge', () => {
    const getPad = vi.spyOn(engineBridge, 'getPadState');
    const getQuant = vi.spyOn(engineBridge, 'getQuantize');
    const getKit = vi.spyOn(engineBridge, 'getKitId');
    const getPattern = vi.spyOn(engineBridge, 'getPattern');
    const getLen = vi.spyOn(engineBridge, 'getDrumNumSteps');
    const getSwing = vi.spyOn(engineBridge, 'getDrumSwing');

    realSamplerBridge.getPadState(0);
    realSamplerBridge.getQuantize();
    realSamplerBridge.getKitId();
    realSamplerBridge.getPattern();
    realSamplerBridge.getDrumNumSteps();
    realSamplerBridge.getDrumSwing();
    realSamplerBridge.getDrumRunning();
    realSamplerBridge.getMonarchRunning();

    expect(getPad).toHaveBeenCalledWith(0);
    expect(getQuant).toHaveBeenCalled();
    expect(getKit).toHaveBeenCalled();
    expect(getPattern).toHaveBeenCalled();
    expect(getLen).toHaveBeenCalled();
    expect(getSwing).toHaveBeenCalled();

    vi.restoreAllMocks();
  });
});

// ---- proxy bridge — posts + mirror reads ---------------------------------------------------

/** A channel stub that records every posted message (+ transfer list). */
function fakeChannel(): SamplerChannel & { posted: Msg[]; transfers: (Transferable[] | undefined)[] } {
  const posted: Msg[] = [];
  const transfers: (Transferable[] | undefined)[] = [];
  return {
    posted,
    transfers,
    post: (msg, transfer) => {
      posted.push(msg);
      transfers.push(transfer);
    },
    subscribe: () => () => {},
    close: () => {},
  };
}

const FULL_MIRROR: SamplerMirror = {
  pads: Array.from({ length: 8 }, (_, i) => ({
    sampleId: `s${i}`,
    sampleName: `NAME ${i}`,
    level: 0.5,
    tuneSemis: i,
    loop: i % 2 === 0,
  })),
  quantize: '1/4',
  kitId: 'analog',
  pattern: Array.from({ length: 8 }, (_, t) => Array.from({ length: 16 }, (_, s) => (t + s) % 3 === 0)),
  drumNumSteps: 12,
  drumSwingPct: 58,
  drumRunning: true,
  monarchRunning: true,
};

describe('proxy sampler bridge', () => {
  it('serves the DEFAULT PadState before the first mirror arrives', () => {
    const ch = fakeChannel();
    const bridge = createProxySamplerBridge(new MirrorStore(), ch);
    expect(bridge.getPadState(0)).toEqual(emptyPad());
    expect(bridge.getQuantize()).toBe('1 BAR');
    expect(bridge.getDrumNumSteps()).toBe(16);
    expect(bridge.getDrumRunning()).toBe(false);
    expect(bridge.getDrumStepPosition()).toBe(-1); // control-only v1: no chase in the pop-out
  });

  it('serves snapshots from the last mirror', () => {
    const ch = fakeChannel();
    const store = new MirrorStore();
    const bridge = createProxySamplerBridge(store, ch);
    store.set(FULL_MIRROR);
    expect(bridge.getPadState(3)).toEqual(FULL_MIRROR.pads[3]);
    expect(bridge.getQuantize()).toBe('1/4');
    expect(bridge.getKitId()).toBe('analog');
    expect(bridge.getPattern()).toEqual(FULL_MIRROR.pattern);
    expect(bridge.getDrumNumSteps()).toBe(12);
    expect(bridge.getDrumSwing()).toBe(58);
    expect(bridge.getDrumRunning()).toBe(true);
    expect(bridge.getMonarchRunning()).toBe(true);
  });

  it('posts the correct Msg for each action', () => {
    const ch = fakeChannel();
    const bridge = createProxySamplerBridge(new MirrorStore(), ch);

    bridge.auditionPad(2);
    bridge.setPadControl(1, 'level', 0.5);
    bridge.commitPadControl(1, 'tuneSemis', 3);
    bridge.setPadLoop(4, true);
    bridge.assignFactoryToPad(0, 'factory-kick');
    bridge.selectKit('analog');
    bridge.setQuantize('1/8');
    bridge.toggleStep(2, 5);
    bridge.drumRun();
    bridge.drumStop();
    bridge.clearDrumPattern();
    bridge.setDrumNumSteps(8);
    bridge.setDrumSwing(62);

    expect(ch.posted).toEqual([
      { t: 'audition', pad: 2 },
      { t: 'setPadControl', pad: 1, control: 'level', value: 0.5 },
      { t: 'commitPadControl', pad: 1, control: 'tuneSemis', value: 3 },
      { t: 'setPadLoop', pad: 4, on: true },
      { t: 'assignFactoryToPad', pad: 0, factoryId: 'factory-kick' },
      { t: 'selectKit', kitId: 'analog' },
      { t: 'setQuantize', division: '1/8' },
      { t: 'toggleStep', track: 2, step: 5 },
      { t: 'drumRun' },
      { t: 'drumStop' },
      { t: 'clearDrumPattern' },
      { t: 'setDrumNumSteps', n: 8 },
      { t: 'setDrumSwing', pct: 62 },
    ]);
  });

  it('load posts a transferable ArrayBuffer (not a File) and caps at 4 MB', async () => {
    const ch = fakeChannel();
    const bridge = createProxySamplerBridge(new MirrorStore(), ch);

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const file = new File([bytes], 'kick.wav', { type: 'audio/wav' });
    await bridge.loadPadSample(3, file);

    const msg = ch.posted[0]!;
    expect(msg.t).toBe('load');
    if (msg.t === 'load') {
      expect(msg.pad).toBe(3);
      expect(msg.name).toBe('kick.wav');
      expect(msg.mime).toBe('audio/wav');
      expect(msg.bytes).toBeInstanceOf(ArrayBuffer);
      expect(new Uint8Array(msg.bytes)).toEqual(bytes);
    }
    // the bytes are passed as the transfer list
    expect(ch.transfers[0]).toHaveLength(1);
    expect(ch.transfers[0]![0]).toBeInstanceOf(ArrayBuffer);

    // an over-cap file rejects locally (no post)
    const big = { size: 5 * 1024 * 1024, name: 'big.wav', type: 'audio/wav' } as File;
    await expect(bridge.loadPadSample(0, big)).rejects.toThrow(/too large/i);
    expect(ch.posted).toHaveLength(1); // still just the first load
  });

  it('mirror updates notify subscribers (drives useSyncExternalStore)', () => {
    const ch = fakeChannel();
    const store = new MirrorStore();
    createProxySamplerBridge(store, ch);
    const onChange = vi.fn();
    const unsub = store.subscribe(onChange);
    store.set(FULL_MIRROR);
    expect(onChange).toHaveBeenCalledTimes(1);
    unsub();
    store.set(FULL_MIRROR);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
