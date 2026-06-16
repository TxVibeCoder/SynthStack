/**
 * Recording helpers (feature: master-output recording) — PURE, Web-Audio-free, and
 * with NO wall-clock call inside. Unit-tested in Node in the quantGrid.ts style.
 *
 * The shell (recorder.ts) injects the side effects: MediaRecorder.isTypeSupported is
 * passed into pickRecorderMimeType, and the filename timestamp is passed into
 * buildRecordingFilename. That keeps every function here a deterministic mapping —
 * no Date/now, no global lookups — so they round-trip under plain Node unit tests.
 *
 * formatElapsed is the ONE m:ss implementation in the codebase: imported here by
 * recorder.ts and by src/ui/UtilityStrip.tsx (the RECORD elapsed readout). The UI
 * never reimplements it.
 */

/**
 * Pick the MediaRecorder mime type, preferring Opus-in-WebM, falling back to plain
 * WebM, else '' (the empty string doubles as the "use the browser default" sentinel —
 * MediaRecorder is then constructed with no mimeType). The support predicate is
 * INJECTED (shell: `(t) => MediaRecorder.isTypeSupported(t)`; tests: a stub), so this
 * stays 100% pure.
 */
export function pickRecorderMimeType(isSupported: (type: string) => boolean): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm'];
  for (const t of candidates) {
    if (isSupported(t)) return t;
  }
  return '';
}

/** Elapsed milliseconds -> m:ss. Minutes uncapped, seconds always 2 digits; clamps
 *  negative input to 0:00. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Build the download filename. The timestamp string is INJECTED (the shell makes the
 *  one wall-clock read and passes it in) so this is pure. */
export function buildRecordingFilename(timestamp: string, ext: string): string {
  return `synthstack-${timestamp}.${ext}`;
}

/** Map a recorder mime type to a file extension (default 'audio' for an unknown type). */
export function recordingExtForMime(mime: string): string {
  return mime.includes('webm') ? 'webm' : mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'mp4' : 'audio';
}
