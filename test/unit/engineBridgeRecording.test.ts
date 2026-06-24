/**
 * Engine-bridge recording seam (PURE / store-level — unpowered, so the engine recorder is
 * never constructed and every method is a no-throw no-op). This file is DISJOINT from
 * test/unit/engineBridge.test.ts so the recording slice's tests never collide with the
 * routing / sampler / keyboard suites that share the same singleton bridge.
 *
 * What is provable headlessly: the three forwarders (startRecording / stopRecording /
 * getRecordingState) are safe before power-on — getRecordingState() returns the idle
 * default WITHOUT lazily constructing a Studio (it reads the private studioInstance
 * directly), start/stop never throw, and none of them leak into store.controls. The REAL
 * captured bytes are a manual checkpoint (no MediaRecorder under Node — see the engine
 * group's recordHelpers/recorder degradation test for the unsupported-branch coverage).
 */

import { describe, expect, it } from 'vitest';
import { engineBridge } from '../../src/ui/engineBridge';

/** Reach the private studioInstance to prove an idle poll does NOT construct a Studio. */
interface BridgePrivates {
  studioInstance: unknown | null;
  _powered: boolean;
}

describe('engineBridge recording seam (store-level, unpowered)', () => {
  const priv = engineBridge as unknown as BridgePrivates;

  it('getRecordingState() returns the idle default before power-on', () => {
    expect(engineBridge.getRecordingState()).toEqual({ recording: false, elapsedMs: 0 });
  });

  it('getRecordingState() does NOT construct a Studio on an idle poll', () => {
    // This case relies on running before anything in this file touches `engineBridge.store`
    // (the lazy Studio getter). Reading the recording state must not flip studioInstance
    // from null — it reads the field directly, returning the {false,0} default when absent.
    const before = priv.studioInstance;
    engineBridge.getRecordingState();
    engineBridge.getRecordingState();
    expect(priv.studioInstance).toBe(before);
    if (before === null) expect(priv.studioInstance).toBeNull();
  });

  it('startRecording() / stopRecording() are no-throw no-ops while unpowered', () => {
    expect(priv._powered).toBe(false); // sanity: this suite never powers on
    expect(() => {
      engineBridge.startRecording();
      engineBridge.stopRecording();
      engineBridge.startRecording();
      engineBridge.stopRecording();
    }).not.toThrow();
    // still idle afterward — no recorder could have started while unpowered
    expect(engineBridge.getRecordingState()).toEqual({ recording: false, elapsedMs: 0 });
  });

  it('setRecordFormat is an unpowered no-op on the engine, but updates the UI snapshot', () => {
    // Default selection is the lossy webm container.
    expect(engineBridge.getRecordFormat()).toBe('webm');
    expect(priv._powered).toBe(false); // sanity: never powers on
    expect(() => {
      engineBridge.setRecordFormat('wav');
      engineBridge.setRecordFormat('webm');
      engineBridge.setRecordFormat('wav');
    }).not.toThrow();
    // The selection is held on the bridge (runtime-only UI source of truth) even unpowered.
    expect(engineBridge.getRecordFormat()).toBe('wav');
    // The poll is still idle — selecting a format never starts a recorder.
    expect(engineBridge.getRecordingState()).toEqual({ recording: false, elapsedMs: 0 });
    // restore the default so test ordering can't leak the WAV pick into a later case
    engineBridge.setRecordFormat('webm');
    expect(engineBridge.getRecordFormat()).toBe('webm');
  });

  it('setRecordFormat never leaks into store.controls or the serialized tree', () => {
    engineBridge.setRecordFormat('wav');
    const controls = engineBridge.store.getState().controls;
    for (const mod of Object.values(controls)) {
      for (const id of Object.keys(mod)) {
        expect(id).not.toContain('FORMAT');
        expect(id).not.toContain('RECORD');
      }
    }
    engineBridge.setRecordFormat('webm');
  });

  it('recording calls never leak into store.controls', () => {
    // Touching store lazily constructs the (audio-free) Studio, but that is orthogonal to
    // the recorder, which only exists post-power-on inside StudioContext. After the calls,
    // no recording id may appear under any module's controls map.
    engineBridge.startRecording();
    engineBridge.stopRecording();
    const controls = engineBridge.store.getState().controls;
    expect(controls['sampler'] ?? {}).toEqual({});
    expect(controls['keyboard'] ?? undefined).toBeUndefined();
    for (const mod of Object.values(controls)) {
      for (const id of Object.keys(mod)) {
        expect(id).not.toContain('RECORD');
      }
    }
  });
});
