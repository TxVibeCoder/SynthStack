/**
 * Sample-processor pure core (feature: sample processor). The UI (SampleProcessor.tsx) is a
 * thin shell: it decodes a file to an AudioBuffer, calls these PURE functions on the raw
 * Float32 channel data, and wraps the result back into an AudioBuffer / WAV File. Keeping the
 * math here (no Web Audio types) makes it Node-unit-testable, per the codebase convention.
 *
 * The point of the feature: drop an audio file, drag two handles to pick a region, get a
 * CLICK-FREE loop (short equal-length fades at both ends remove the boundary discontinuity),
 * and drop it onto a sampler pad.
 */

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Region [startFrac, endFrac] of `total` frames, ordered + clamped, min 2 frames. */
export function regionFrames(
  total: number,
  startFrac: number,
  endFrac: number,
): { start: number; end: number } {
  const lo = clamp01(Math.min(startFrac, endFrac));
  const hi = clamp01(Math.max(startFrac, endFrac));
  let start = Math.floor(lo * total);
  let end = Math.ceil(hi * total);
  if (end > total) end = total;
  if (start < 0) start = 0;
  if (end - start < 2) {
    end = Math.min(total, start + 2);
    if (end - start < 2) start = Math.max(0, end - 2);
  }
  return { start, end };
}

/**
 * Slice every channel to [startFrac, endFrac] and apply a linear fade of `fadeMs` at BOTH
 * ends (clamped to at most half the region, so the fades never overlap). Equal-length head
 * and tail fades make the loop seam continuous (out→in cross at zero), killing the click.
 * Pure: Float32 in, fresh Float32 out; the inputs are never mutated.
 */
export function trimAndFade(
  channels: Float32Array[],
  sampleRate: number,
  startFrac: number,
  endFrac: number,
  fadeMs: number,
): Float32Array[] {
  const total = channels[0]?.length ?? 0;
  if (total === 0) return channels.map(() => new Float32Array(0));
  const { start, end } = regionFrames(total, startFrac, endFrac);
  const len = end - start;
  const fadeN = Math.max(0, Math.min(Math.floor((Math.max(0, fadeMs) / 1000) * sampleRate), Math.floor(len / 2)));
  return channels.map((ch) => {
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) out[i] = ch[start + i] ?? 0;
    for (let i = 0; i < fadeN; i++) {
      const g = (i + 1) / (fadeN + 1); // 0<g<1, symmetric head/tail
      out[i] = (out[i] ?? 0) * g;
      out[len - 1 - i] = (out[len - 1 - i] ?? 0) * g;
    }
    return out;
  });
}

/**
 * Min/max peak pair per bucket for waveform rendering. `buckets` columns; each scans its
 * slice of the channel for the extreme negative and positive sample. Pure.
 */
export function peaks(channel: Float32Array, buckets: number): { min: Float32Array; max: Float32Array } {
  const min = new Float32Array(Math.max(0, buckets));
  const max = new Float32Array(Math.max(0, buckets));
  const n = channel.length;
  if (n === 0 || buckets <= 0) return { min, max };
  const per = n / buckets;
  for (let b = 0; b < buckets; b++) {
    const lo = Math.floor(b * per);
    const hi = Math.min(n, Math.max(lo + 1, Math.floor((b + 1) * per)));
    let mn = 0;
    let mx = 0;
    for (let i = lo; i < hi; i++) {
      const v = channel[i] ?? 0;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    min[b] = mn;
    max[b] = mx;
  }
  return { min, max };
}

/**
 * Encode Float32 channels as an interleaved signed PCM WAV. Pure, dependency-free — the one
 * place a processed buffer becomes persistable bytes (then wrapped in a File and fed through the
 * SAME bridge.loadPadSample path as any user sample, so it persists/exports/round-trips for free).
 * Samples are clamped to [-1, 1].
 *
 * `bitDepth` defaults to 16 so the existing SampleProcessor path + sampleEdit.test.ts stay
 * byte-identical. 24 selects a 3-byte little-endian signed branch (the lossless capture path the
 * master WAV recorder uses); blockAlign / byteRate / dataSize all derive from bytesPerSample.
 */
export function encodeWav(
  channels: Float32Array[],
  sampleRate: number,
  bitDepth: 16 | 24 = 16,
): ArrayBuffer {
  const numCh = Math.max(1, channels.length);
  const len = channels[0]?.length ?? 0;
  const bytesPerSample = bitDepth === 24 ? 3 : 2;
  const blockAlign = numCh * bytesPerSample;
  const dataSize = len * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format 1 = PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true); // bits per sample
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  let off = 44;
  if (bitDepth === 24) {
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < numCh; c++) {
        let s = channels[c]?.[i] ?? 0;
        s = s < -1 ? -1 : s > 1 ? 1 : s;
        // 24-bit signed range: [-0x800000, 0x7fffff]. Truncate to an integer, then emit the
        // three low bytes little-endian (a negative value's two's-complement low 24 bits).
        const v = Math.trunc(s < 0 ? s * 0x800000 : s * 0x7fffff);
        const u = v < 0 ? v + 0x1000000 : v; // map to the unsigned 24-bit pattern
        view.setUint8(off, u & 0xff);
        view.setUint8(off + 1, (u >> 8) & 0xff);
        view.setUint8(off + 2, (u >> 16) & 0xff);
        off += 3;
      }
    }
  } else {
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < numCh; c++) {
        let s = channels[c]?.[i] ?? 0;
        s = s < -1 ? -1 : s > 1 ? 1 : s;
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
      }
    }
  }
  return buffer;
}
