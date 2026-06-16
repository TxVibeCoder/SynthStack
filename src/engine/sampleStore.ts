/**
 * Sample byte store (feature: sampler pads, D10). Decoded AudioBuffers are NOT
 * serializable, so the state tree carries only a sampleId reference; the raw bytes
 * live here, keyed by that id. Two backends share one interface:
 *   - IndexedDbBackend: the browser store (DB 'synthstack', object store 'samples').
 *   - MemoryBackend: a Map fallback for non-browser / test contexts (no real IDB).
 * Both enforce the same per-sample size cap and id-generation rules so the engine
 * and unit tests behave identically.
 */

export interface SampleRecord {
  id: string;
  name: string;
  mime: string;
  bytes: ArrayBuffer;
  size: number;
  createdAt: number;
}

export interface SampleBackend {
  put(input: { id?: string; name: string; mime: string; bytes: ArrayBuffer }): Promise<SampleRecord>;
  get(id: string): Promise<SampleRecord | null>;
  delete(id: string): Promise<void>;
  list(): Promise<SampleRecord[]>;
}

/** Thrown by put() when a sample exceeds MAX_SAMPLE_BYTES — nothing is written. */
export class SampleTooLargeError extends Error {
  constructor(byteLength: number) {
    super(`sample is ${byteLength} bytes; max is ${MAX_SAMPLE_BYTES}`);
    this.name = 'SampleTooLargeError';
  }
}

/** Per-sample byte cap (~4 MB) — keeps IndexedDB usage and decode latency sane. */
export const MAX_SAMPLE_BYTES = 4 * 1024 * 1024; // 4194304

/** Guard called by every put() BEFORE writing; throws SampleTooLargeError if over cap. */
export function assertSampleSize(byteLength: number): void {
  if (byteLength > MAX_SAMPLE_BYTES) throw new SampleTooLargeError(byteLength);
}

let idCounter = 0;
/** Stable, collision-free sample id. Uses crypto.randomUUID when available. */
export function newSampleId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `samp-${Date.now()}-${idCounter++}`;
}

const DB_NAME = 'synthstack';
const STORE_NAME = 'samples';

/** IndexedDB-backed store (browser). Lazy-opens the DB on first use. */
export class IndexedDbBackend implements SampleBackend {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.dbPromise;
  }

  private tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    return this.open().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, mode);
          const req = run(tx.objectStore(STORE_NAME));
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        }),
    );
  }

  async put(input: { id?: string; name: string; mime: string; bytes: ArrayBuffer }): Promise<SampleRecord> {
    assertSampleSize(input.bytes.byteLength);
    const record: SampleRecord = {
      id: input.id ?? newSampleId(),
      name: input.name,
      mime: input.mime,
      bytes: input.bytes.slice(0), // own copy — caller's buffer stays usable (and isn't detached)
      size: input.bytes.byteLength,
      createdAt: Date.now(),
    };
    await this.tx('readwrite', (store) => store.put(record));
    return record;
  }

  async get(id: string): Promise<SampleRecord | null> {
    const rec = await this.tx<SampleRecord | undefined>('readonly', (store) => store.get(id));
    return rec ?? null;
  }

  async delete(id: string): Promise<void> {
    await this.tx('readwrite', (store) => store.delete(id));
  }

  async list(): Promise<SampleRecord[]> {
    return this.tx<SampleRecord[]>('readonly', (store) => store.getAll());
  }
}

/** In-memory store with the same contract — used when indexedDB is unavailable. */
export class MemoryBackend implements SampleBackend {
  private readonly records = new Map<string, SampleRecord>();

  async put(input: { id?: string; name: string; mime: string; bytes: ArrayBuffer }): Promise<SampleRecord> {
    assertSampleSize(input.bytes.byteLength);
    const record: SampleRecord = {
      id: input.id ?? newSampleId(),
      name: input.name,
      mime: input.mime,
      bytes: input.bytes.slice(0),
      size: input.bytes.byteLength,
      createdAt: Date.now(),
    };
    this.records.set(record.id, record);
    return record;
  }

  async get(id: string): Promise<SampleRecord | null> {
    return this.records.get(id) ?? null;
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }

  async list(): Promise<SampleRecord[]> {
    return [...this.records.values()];
  }
}

// ---------------------------------------------------------------------------
// Sample portability (feature: presets + save/load). The portable .json bundle
// must carry the USER sample BYTES so a kit opens on another machine. Bytes are
// base64-encoded here (the ONLY place base64 lives); factory ids carry NO bytes
// (resolved from in-memory factoryBuffers on load), so they are never exported.
// Everything below is dependency-free, pure/total, and NEVER throws on bad input.
// ---------------------------------------------------------------------------

/**
 * One portable sample record inside a preset bundle. Bytes are base64; size is
 * re-derived from the decoded byteLength and createdAt re-stamped by put() on
 * import, so neither is carried here.
 */
export interface SampleBundleEntry {
  id: string;
  name: string;
  mime: string;
  bytesBase64: string;
}

/** Alias so the preset module (g1) and the bridge bundle (g3) agree on the name. */
export type SampleBlob = SampleBundleEntry;

/** Predicate shared by exportSamples + g1.collectUserSampleIds + the bridge orphan
 *  capture: only NON-factory, non-empty ids carry portable bytes. */
function isUserSampleId(id: string): boolean {
  return !!id && !id.startsWith('factory-');
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Reverse lookup table for decoding (char code -> 6-bit value, -1 if invalid). */
const BASE64_LOOKUP: Int8Array = (() => {
  const table = new Int8Array(256).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i++) {
    table[BASE64_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

/**
 * Encode an ArrayBuffer to a standard base64 string. PURE, total, never throws.
 * Accumulates output in fixed-size chunks (never String.fromCharCode(...wholeArray),
 * which stack-overflows around 4 MB). 3-byte -> 4-char groups with '=' padding.
 */
export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const len = bytes.length;
  if (len === 0) return '';
  let out = '';
  let chunk = '';
  const CHUNK_FLUSH = 8192; // flush the working string well before it grows unbounded
  let i = 0;
  for (; i + 2 < len; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    chunk +=
      BASE64_ALPHABET[(n >> 18) & 63]! +
      BASE64_ALPHABET[(n >> 12) & 63]! +
      BASE64_ALPHABET[(n >> 6) & 63]! +
      BASE64_ALPHABET[n & 63]!;
    if (chunk.length >= CHUNK_FLUSH) {
      out += chunk;
      chunk = '';
    }
  }
  // Tail: 1 or 2 remaining bytes -> '=' padding.
  const rem = len - i;
  if (rem === 1) {
    const b0 = bytes[i] ?? 0;
    const n = b0 << 16;
    chunk += BASE64_ALPHABET[(n >> 18) & 63]! + BASE64_ALPHABET[(n >> 12) & 63]! + '==';
  } else if (rem === 2) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const n = (b0 << 16) | (b1 << 8);
    chunk +=
      BASE64_ALPHABET[(n >> 18) & 63]! +
      BASE64_ALPHABET[(n >> 12) & 63]! +
      BASE64_ALPHABET[(n >> 6) & 63]! +
      '=';
  }
  out += chunk;
  return out;
}

/**
 * Decode a standard base64 string to an ArrayBuffer. PURE, total, never throws.
 * Strips all whitespace; ignores a trailing run of '='; returns an empty buffer
 * on any structural error (cleaned length %4 === 1) or any non-alphabet char, so
 * the caller simply drops that sample.
 */
export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  if (typeof b64 !== 'string' || b64.length === 0) return new ArrayBuffer(0);
  // Strip whitespace and any trailing '=' padding (count it to recover the tail length).
  const stripped = b64.replace(/\s+/g, '');
  let end = stripped.length;
  let pad = 0;
  while (end > 0 && stripped.charCodeAt(end - 1) === 61 /* '=' */) {
    end--;
    pad++;
  }
  const cleanLen = end;
  // A trailing run of '=' in the middle, or a length %4 === 1, is malformed.
  if (cleanLen % 4 === 1) return new ArrayBuffer(0);
  // Validate every remaining char is in the alphabet (any '=' before `end` is illegal).
  for (let i = 0; i < cleanLen; i++) {
    if (BASE64_LOOKUP[stripped.charCodeAt(i)] === -1) return new ArrayBuffer(0);
  }
  // Output length: every 4 input chars -> 3 bytes; the final partial group yields
  // 1 byte (2 chars) or 2 bytes (3 chars).
  const fullGroups = Math.floor(cleanLen / 4);
  const remChars = cleanLen - fullGroups * 4;
  let outLen = fullGroups * 3;
  if (remChars === 2) outLen += 1;
  else if (remChars === 3) outLen += 2;
  void pad; // padding only informed where the data stops; outLen already accounts for it
  const out = new Uint8Array(outLen);
  let o = 0;
  let i = 0;
  for (; i + 3 < cleanLen; i += 4) {
    const c0 = BASE64_LOOKUP[stripped.charCodeAt(i)]!;
    const c1 = BASE64_LOOKUP[stripped.charCodeAt(i + 1)]!;
    const c2 = BASE64_LOOKUP[stripped.charCodeAt(i + 2)]!;
    const c3 = BASE64_LOOKUP[stripped.charCodeAt(i + 3)]!;
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    out[o++] = (n >> 16) & 0xff;
    out[o++] = (n >> 8) & 0xff;
    out[o++] = n & 0xff;
  }
  if (remChars === 2) {
    const c0 = BASE64_LOOKUP[stripped.charCodeAt(i)]!;
    const c1 = BASE64_LOOKUP[stripped.charCodeAt(i + 1)]!;
    const n = (c0 << 18) | (c1 << 12);
    out[o++] = (n >> 16) & 0xff;
  } else if (remChars === 3) {
    const c0 = BASE64_LOOKUP[stripped.charCodeAt(i)]!;
    const c1 = BASE64_LOOKUP[stripped.charCodeAt(i + 1)]!;
    const c2 = BASE64_LOOKUP[stripped.charCodeAt(i + 2)]!;
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6);
    out[o++] = (n >> 16) & 0xff;
    out[o++] = (n >> 8) & 0xff;
  }
  return out.buffer;
}

/**
 * Gather the portable bytes for a set of pad sample ids. De-dupes; drops factory
 * and empty ids (the EXACT predicate the bridge + g1.collectUserSampleIds use);
 * skips dangling refs (a deleted sample a pad still names). Never throws — a bad
 * backend or missing record simply yields fewer entries.
 */
export async function exportSamples(
  backend: SampleBackend,
  ids: readonly string[],
): Promise<SampleBundleEntry[]> {
  const entries: SampleBundleEntry[] = [];
  try {
    const unique = [...new Set(ids)].filter(isUserSampleId);
    for (const id of unique) {
      try {
        const rec = await backend.get(id);
        if (!rec) continue; // dangling ref — pad names a sample that no longer exists
        entries.push({
          id: rec.id,
          name: rec.name,
          mime: rec.mime,
          bytesBase64: arrayBufferToBase64(rec.bytes),
        });
      } catch {
        // skip this id; keep gathering the rest
      }
    }
  } catch {
    // unreachable in practice; belt-and-suspenders so export never throws
  }
  return entries;
}

/**
 * Restore portable sample bytes into the backend before pad buffers reload.
 * Accepts `unknown` defensively (a hand-edited bundle can't crash the loader).
 * Each entry is written under its EXACT bundled id (OVERWRITE, not skip-if-exists)
 * so the restored state tree's pad refs still resolve. Per-entry try/catch: a
 * malformed entry, a failed decode, or an over-cap sample (put() throws
 * SampleTooLargeError) drops only that one sample; the rest still import. The
 * single awaited Promise lets the bridge sequence this AFTER resetAll and BEFORE
 * reloadPadBuffers. Never throws.
 */
export async function importSamples(
  backend: SampleBackend,
  entries: readonly SampleBundleEntry[] | unknown,
): Promise<void> {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    try {
      if (
        !entry ||
        typeof entry !== 'object' ||
        typeof (entry as SampleBundleEntry).id !== 'string' ||
        typeof (entry as SampleBundleEntry).name !== 'string' ||
        typeof (entry as SampleBundleEntry).mime !== 'string' ||
        typeof (entry as SampleBundleEntry).bytesBase64 !== 'string'
      ) {
        continue;
      }
      const e = entry as SampleBundleEntry;
      const bytes = base64ToArrayBuffer(e.bytesBase64);
      // A non-empty source that decodes to zero bytes means the base64 was corrupt
      // — skip it rather than restoring an empty pad under a real id.
      if (bytes.byteLength === 0 && e.bytesBase64.length > 0) continue;
      await backend.put({ id: e.id, name: e.name, mime: e.mime, bytes });
    } catch {
      // over-cap (SampleTooLargeError) or any backend failure — drop this one, continue
    }
  }
}
