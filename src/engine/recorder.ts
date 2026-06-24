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
  type RecordFormat,
} from './recordHelpers';
import { encodeWav } from './sampleEdit';

/** Auto-stop a take after 10 minutes to bound the in-RAM Blob — a marathon record otherwise
 *  accumulates chunks until the tab is discarded. The user still gets the capped file's download. */
export const MAX_RECORD_MS = 10 * 60 * 1000;

/** Lossless WAV bit depth. 16 is the shipped DEFAULT (a friendly, universally-playable file ~2/3
 *  the size of 24-bit); 24-bit lives in encodeWav for the operator to flip if "CAD-grade fidelity"
 *  wants it. EARS/DECISION: 16 vs 24 default is Will's by-ear/size call — flagged in the report. */
const WAV_BIT_DEPTH: 16 | 24 = 16;

export class MasterRecorder {
  private streamDest: MediaStreamAudioDestinationNode | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startEpochMs = 0;
  private mime = '';
  /** Auto-stop timer (UI timer, not an audio event); cleared on any stop. */
  private capTimer: ReturnType<typeof setTimeout> | null = null;
  /** Computed once: the runtime actually has MediaRecorder + createMediaStreamDestination. */
  private readonly webmSupported: boolean;
  /** Computed once: the runtime has AudioWorkletNode + createMediaStreamDestination (the WAV
   *  PCM-tap path). The pcm-tap module must also have loaded (it is registered in loadWorklets);
   *  if addModule failed, constructing the node throws and start() degrades to false. */
  private readonly wavSupported: boolean;

  /** Selected capture format. 'webm' (lossy MediaRecorder) is the DEFAULT; 'wav' is the lossless
   *  PCM-tap path. Runtime-only — never serialized. */
  private format: RecordFormat = 'webm';

  // ---- WAV (PCM-tap) path state ----
  /** The lazily-built PCM tap worklet node (additive edge off `tap`, parallel to streamDest). */
  private pcmNode: AudioWorkletNode | null = null;
  /** Accumulated per-channel blocks for the in-flight WAV take (concat only at stop()). */
  private wavChunks: Float32Array[][] = [];
  private wavChannelCount = 1;
  /** True between a successful wav start() and its stop(); the single in-flight guard for WAV. */
  private wavRecording = false;
  private wavStartEpochMs = 0;

  constructor(
    private readonly ctx: AudioContext,
    private readonly tap: AudioNode,
  ) {
    const hasStreamDest = typeof ctx.createMediaStreamDestination === 'function';
    this.webmSupported = typeof MediaRecorder !== 'undefined' && hasStreamDest;
    // The WAV path needs an AudioWorkletNode constructor + a real context with an audioWorklet.
    this.wavSupported =
      typeof AudioWorkletNode !== 'undefined' &&
      typeof (ctx as { audioWorklet?: unknown }).audioWorklet !== 'undefined';
  }

  /** Select the capture format for the NEXT take. Ignored mid-record (the in-flight take keeps
   *  its format); the new format applies to the next start(). */
  setFormat(format: RecordFormat): void {
    if (this.isRecording) return;
    this.format = format;
  }

  getFormat(): RecordFormat {
    return this.format;
  }

  /** Whether the SELECTED format can actually record in this runtime. */
  get isSupported(): boolean {
    return this.format === 'wav' ? this.wavSupported : this.webmSupported;
  }

  get isRecording(): boolean {
    if (this.format === 'wav') return this.wavRecording;
    return this.recorder !== null && this.recorder.state === 'recording';
  }

  getState(): { recording: boolean; elapsedMs: number } {
    if (!this.isRecording) return { recording: false, elapsedMs: 0 };
    const epoch = this.format === 'wav' ? this.wavStartEpochMs : this.startEpochMs;
    return { recording: true, elapsedMs: Math.round(this.nowMs() - epoch) };
  }

  /** The one runtime clock read for the elapsed timer (performance.now with a Date.now
   *  fallback). The pure core makes NO clock call. */
  private nowMs(): number {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  /**
   * Start recording the master mix in the SELECTED format. Single in-flight guard regardless of
   * format (isRecording covers both paths). Returns false (never throws) when unsupported,
   * already recording, or any wiring step throws.
   */
  start(): boolean {
    if (this.isRecording) return false;
    return this.format === 'wav' ? this.startWav() : this.startWebm();
  }

  /**
   * webm path: lazily creates the streamDest fan-out off softClip exactly once (the ADDITIVE
   * edge — softClip->destination is untouched, monitoring continues), mints a FRESH MediaRecorder
   * per record (MediaRecorder is single-use), and starts it.
   */
  private startWebm(): boolean {
    if (!this.webmSupported) return false;
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
        this.clearCapTimer();
      };
      this.recorder.start(); // no timeslice — one final dataavailable on stop()
      this.startEpochMs = this.nowMs();
      // Bound RAM: auto-stop (assemble + download) after MAX_RECORD_MS; a manual stop cancels it.
      this.capTimer = setTimeout(() => void this.stop(), MAX_RECORD_MS);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * wav (lossless) path: lazily builds the PCM-tap AudioWorkletNode off `tap` (an ADDITIVE edge
   * parallel to streamDest — softClip->destination still untouched, monitoring continues), then
   * accumulates each posted per-channel block. The node stays connected across takes; chunks are
   * cleared at start and concatenated only at stop(). Returns false (never throws) when the
   * worklet isn't available (e.g. addModule failed) or any wiring step throws.
   */
  private startWav(): boolean {
    if (!this.wavSupported) return false;
    try {
      if (this.pcmNode === null) {
        this.pcmNode = new AudioWorkletNode(this.ctx, 'synthstack-pcm-tap', {
          numberOfInputs: 1,
          numberOfOutputs: 0,
        });
        this.pcmNode.port.onmessage = (e: MessageEvent) => {
          // Drop late blocks once a take has ended (stop() set wavRecording false) so a final
          // in-flight message never re-grows the freed buffer.
          if (!this.wavRecording) return;
          const data = e.data as { channels?: Float32Array[]; channelCount?: number };
          const chans = data.channels;
          if (!chans || chans.length === 0) return;
          this.wavChannelCount = data.channelCount ?? chans.length;
          this.wavChunks.push(chans);
        };
        this.tap.connect(this.pcmNode);
      }
      this.wavChunks = [];
      this.wavChannelCount = 1;
      this.wavRecording = true;
      this.wavStartEpochMs = this.nowMs();
      this.capTimer = setTimeout(() => void this.stop(), MAX_RECORD_MS);
      return true;
    } catch {
      this.wavRecording = false;
      return false;
    }
  }

  /**
   * Stop recording in whichever format is in flight, trigger the browser download, and resolve
   * the Blob (null when not recording / on error). The promise is what StudioContext.powerOff
   * awaits — blob assembly + download must complete BEFORE the context is suspended.
   */
  stop(): Promise<Blob | null> {
    this.clearCapTimer(); // a manual stop (or the auto-stop firing) cancels the cap timer
    if (this.format === 'wav') return this.stopWav();
    if (!this.isRecording || this.recorder === null) return Promise.resolve(null);
    return new Promise<Blob | null>((resolve) => {
      const rec = this.recorder!;
      // Replace the start()-era onerror (which never resolves): if the recorder fires 'error'
      // instead of 'stop' after rec.stop(), settle the promise so powerOff (which awaits this)
      // can never hang. Single-slot handler assignment ensures only one resolver path runs.
      rec.onerror = () => {
        this.chunks = [];
        this.recorder = null;
        resolve(null);
      };
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

  /**
   * Stop the WAV take: stop accepting blocks, concat the accumulated per-channel chunks into one
   * Float32Array per channel, encodeWav() them, download, and resolve the Blob. Disconnects + nulls
   * the PCM node so a later format switch / power-off leaves no live edge. Resolves null when not
   * recording or on any error (never throws — powerOff awaits this).
   *
   * The final in-flight partial block is already flushed: the worklet posts EVERY processed block
   * (including the last one before disconnect), and onmessage appended each up to the moment
   * wavRecording flips false here.
   */
  private stopWav(): Promise<Blob | null> {
    if (!this.wavRecording) return Promise.resolve(null);
    this.wavRecording = false; // gate onmessage: any late block is dropped from here on
    try {
      const nCh = Math.max(1, this.wavChannelCount);
      const total = this.wavChunks.reduce((sum, blk) => sum + (blk[0]?.length ?? 0), 0);
      const channels: Float32Array[] = [];
      for (let c = 0; c < nCh; c++) {
        const out = new Float32Array(total);
        let off = 0;
        for (const blk of this.wavChunks) {
          // A block may carry fewer channels than nCh (a mono moment); fall back to channel 0 so
          // the interleave stays aligned rather than leaving a silent gap.
          const src = blk[c] ?? blk[0];
          if (src) out.set(src, off);
          off += blk[0]?.length ?? 0;
        }
        channels.push(out);
      }
      this.wavChunks = [];
      const buf = encodeWav(channels, this.ctx.sampleRate, WAV_BIT_DEPTH);
      const blob = new Blob([buf], { type: 'audio/wav' });
      const filename = buildRecordingFilename(this.timestampNow(), 'wav');
      this.triggerDownload(blob, filename);
      this.disconnectPcmNode();
      return Promise.resolve(blob);
    } catch {
      this.wavChunks = [];
      this.disconnectPcmNode();
      return Promise.resolve(null);
    }
  }

  private disconnectPcmNode(): void {
    if (this.pcmNode !== null) {
      try {
        this.pcmNode.port.onmessage = null;
        this.pcmNode.disconnect();
      } catch {
        /* non-fatal */
      }
      this.pcmNode = null;
    }
  }

  private clearCapTimer(): void {
    if (this.capTimer !== null) {
      clearTimeout(this.capTimer);
      this.capTimer = null;
    }
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
