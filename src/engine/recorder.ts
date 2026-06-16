/**
 * Master-output recorder (feature: recording) — a THIN shell over MediaRecorder.
 * Owned by StudioContext (it needs the private ctx + softClip; the bridge cannot
 * reach them). The DSP-free decisions (mime pick / m:ss / filename) live in the pure
 * recordHelpers core; this file only does the Web Audio / MediaRecorder / Blob / DOM
 * wiring — the part that CANNOT be validated headlessly (a human
 * records in Chrome/Edge and confirms the .webm plays and contains the full mix).
 *
 * The tap is an ADDITIVE fan-out: `tap.connect(streamDest)` where `tap` is the master
 * softClip WaveShaperNode (context.ts — the final audible node before destination).
 * softClip.connect(ctx.destination) is a SEPARATE edge built at power-on and NEVER
 * touched here, so monitoring continues — you keep HEARING the studio while recording.
 *
 * Graceful degradation: with no global MediaRecorder, or a context lacking
 * createMediaStreamDestination (Node / OfflineAudioContext / old browsers), `supported`
 * is false; start() returns false, stop() resolves null, getState() is {false,0} — and
 * nothing throws. The Node unit test exercises exactly this with `{} as any` for ctx.
 */

import {
  pickRecorderMimeType,
  buildRecordingFilename,
  recordingExtForMime,
} from './recordHelpers';

export class MasterRecorder {
  private streamDest: MediaStreamAudioDestinationNode | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startEpochMs = 0;
  private mime = '';
  /** Computed once: the runtime actually has MediaRecorder + createMediaStreamDestination. */
  private readonly supported: boolean;

  constructor(
    private readonly ctx: AudioContext,
    private readonly tap: AudioNode,
  ) {
    this.supported =
      typeof MediaRecorder !== 'undefined' && typeof ctx.createMediaStreamDestination === 'function';
  }

  get isSupported(): boolean {
    return this.supported;
  }

  get isRecording(): boolean {
    return this.recorder !== null && this.recorder.state === 'recording';
  }

  getState(): { recording: boolean; elapsedMs: number } {
    return {
      recording: this.isRecording,
      elapsedMs: this.isRecording ? Math.round(this.nowMs() - this.startEpochMs) : 0,
    };
  }

  /** The one runtime clock read for the elapsed timer (performance.now with a Date.now
   *  fallback). The pure core makes NO clock call. */
  private nowMs(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  /**
   * Start recording the master mix. Lazily creates the streamDest fan-out off softClip
   * exactly once (the ADDITIVE edge — softClip->destination is untouched, monitoring
   * continues), mints a FRESH MediaRecorder per record (MediaRecorder is single-use),
   * and starts it. Returns false (never throws) when unsupported, already recording, or
   * any wiring step throws.
   */
  start(): boolean {
    if (!this.supported || this.isRecording) return false;
    try {
      if (this.streamDest === null) {
        this.streamDest = this.ctx.createMediaStreamDestination();
        this.tap.connect(this.streamDest);
      }
      this.mime = pickRecorderMimeType((t) => MediaRecorder.isTypeSupported(t));
      this.recorder = this.mime
        ? new MediaRecorder(this.streamDest.stream, { mimeType: this.mime })
        : new MediaRecorder(this.streamDest.stream);
      this.chunks = [];
      this.recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.chunks.push(e.data);
      };
      // Self-heal on a runtime recorder error (e.g. a marathon take exhausts RAM): some UAs
      // fire 'error' and never fire 'onstop', which would strand getState() at {recording:true}
      // and leave the RECORD lamp stuck lit. Drop the recorder so the next poll reads idle.
      this.recorder.onerror = () => {
        this.chunks = [];
        this.recorder = null;
      };
      this.recorder.start(); // no timeslice — one final dataavailable on stop()
      this.startEpochMs = this.nowMs();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stop recording, assemble the Blob in onstop (so the final dataavailable has fired),
   * trigger the browser download, and resolve the Blob. Resolves null when not recording
   * or if stop() throws. The promise is what StudioContext.powerOff awaits — the onstop
   * blob assembly + download must complete BEFORE the context is suspended.
   */
  stop(): Promise<Blob | null> {
    if (!this.isRecording || this.recorder === null) return Promise.resolve(null);
    return new Promise<Blob | null>((resolve) => {
      const rec = this.recorder!;
      rec.onstop = () => {
        const type = rec.mimeType || this.mime;
        const blob = new Blob(this.chunks, type ? { type } : undefined);
        this.chunks = [];
        this.recorder = null;
        const ext = recordingExtForMime(type);
        const filename = buildRecordingFilename(this.timestampNow(), ext);
        this.triggerDownload(blob, filename);
        resolve(blob);
      };
      try {
        rec.stop();
      } catch {
        this.chunks = [];
        this.recorder = null;
        resolve(null);
      }
    });
  }

  /** The wall-clock read for the filename, isolated in the shell and PASSED INTO the
   *  pure builder (e.g. '2026-06-15T14-03-22-000Z'). */
  private timestampNow(): string {
    return new Date().toISOString().replace(/[:.]/g, '-');
  }

  /**
   * Fire a temporary <a download> to save the Blob. A no-op (not an error) in a runtime
   * without a DOM / URL.createObjectURL (Node / headless). The cleanup setTimeout is a UI
   * timer, NOT an audio event — allowed by CLAUDE.md's "never setInterval/setTimeout for
   * AUDIO events" rule.
   */
  private triggerDownload(blob: Blob, filename: string): void {
    if (
      typeof document === 'undefined' ||
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function'
    ) {
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 0);
  }
}
