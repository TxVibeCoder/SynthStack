import { describe, expect, it } from 'vitest';
import {
  pickRecorderMimeType,
  formatElapsed,
  buildRecordingFilename,
  recordingExtForMime,
} from '../../src/engine/recordHelpers';
import { MasterRecorder } from '../../src/engine/recorder';

describe('recordHelpers — pure recording core (feature: recording)', () => {
  it('pickRecorderMimeType prefers audio/webm;codecs=opus when supported', () => {
    expect(pickRecorderMimeType(() => true)).toBe('audio/webm;codecs=opus');
  });

  it('pickRecorderMimeType falls back to audio/webm when only it is supported', () => {
    const support = (t: string) => t === 'audio/webm';
    expect(pickRecorderMimeType(support)).toBe('audio/webm');
  });

  it("pickRecorderMimeType returns '' (browser-default sentinel) when nothing is supported", () => {
    expect(pickRecorderMimeType(() => false)).toBe('');
  });

  it('pickRecorderMimeType asks the predicate in preference order, opus first', () => {
    const asked: string[] = [];
    pickRecorderMimeType((t) => {
      asked.push(t);
      return false;
    });
    expect(asked).toEqual(['audio/webm;codecs=opus', 'audio/webm']);
  });

  it('formatElapsed renders m:ss with 2-digit seconds and uncapped minutes', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(65000)).toBe('1:05');
    expect(formatElapsed(600000)).toBe('10:00');
    expect(formatElapsed(9000)).toBe('0:09');
  });

  it('formatElapsed clamps negative input to 0:00', () => {
    expect(formatElapsed(-500)).toBe('0:00');
  });

  it('buildRecordingFilename injects the timestamp verbatim', () => {
    expect(buildRecordingFilename('2026-06-15T14-03-22-000Z', 'webm')).toBe(
      'synthstack-2026-06-15T14-03-22-000Z.webm',
    );
    expect(buildRecordingFilename('2026-06-15T14-03-22-000Z', 'ogg')).toBe(
      'synthstack-2026-06-15T14-03-22-000Z.ogg',
    );
  });

  it('recordingExtForMime maps webm/ogg/mp4 and defaults to audio', () => {
    expect(recordingExtForMime('audio/webm;codecs=opus')).toBe('webm');
    expect(recordingExtForMime('audio/webm')).toBe('webm');
    expect(recordingExtForMime('audio/ogg')).toBe('ogg');
    expect(recordingExtForMime('video/mp4')).toBe('mp4');
    expect(recordingExtForMime('')).toBe('audio');
    expect(recordingExtForMime('application/octet-stream')).toBe('audio');
  });
});

describe('MasterRecorder — graceful degradation under Node (no MediaRecorder)', () => {
  // Node has no global MediaRecorder and ctx={} as any has no createMediaStreamDestination,
  // so `supported` is false. Every method must be a no-throw no-op returning the idle shape.
  it('isSupported is false and nothing throws', () => {
    const rec = new MasterRecorder({} as unknown as AudioContext, {} as unknown as AudioNode);
    expect(rec.isSupported).toBe(false);
  });

  it('start() returns false without throwing', () => {
    const rec = new MasterRecorder({} as unknown as AudioContext, {} as unknown as AudioNode);
    expect(() => rec.start()).not.toThrow();
    expect(rec.start()).toBe(false);
  });

  it('isRecording is false and getState() is {recording:false,elapsedMs:0}', () => {
    const rec = new MasterRecorder({} as unknown as AudioContext, {} as unknown as AudioNode);
    rec.start();
    expect(rec.isRecording).toBe(false);
    expect(rec.getState()).toEqual({ recording: false, elapsedMs: 0 });
  });

  it('stop() resolves null without throwing', async () => {
    const rec = new MasterRecorder({} as unknown as AudioContext, {} as unknown as AudioNode);
    await expect(rec.stop()).resolves.toBeNull();
  });
});
