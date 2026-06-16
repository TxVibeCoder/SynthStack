import { describe, expect, it } from 'vitest';
import {
  MemoryBackend,
  SampleTooLargeError,
  MAX_SAMPLE_BYTES,
  assertSampleSize,
  newSampleId,
  arrayBufferToBase64,
  base64ToArrayBuffer,
  exportSamples,
  importSamples,
  type SampleBundleEntry,
} from '../../src/engine/sampleStore';

// MemoryBackend only: the Node test env has no real IndexedDB (jsdom-free, no deps).
// IndexedDbBackend shares the same interface + size-cap + id helpers; its real-DB
// behaviour is covered by the deferred browser e2e.

describe('sampleStore (feature: sampler pads)', () => {
  it('put() returns a record with id, size, and createdAt', async () => {
    const be = new MemoryBackend();
    const before = Date.now();
    const rec = await be.put({ name: 'kick.wav', mime: 'audio/wav', bytes: new ArrayBuffer(8) });
    expect(rec.id).toBeTruthy();
    expect(rec.name).toBe('kick.wav');
    expect(rec.mime).toBe('audio/wav');
    expect(rec.size).toBe(8);
    expect(rec.bytes.byteLength).toBe(8);
    expect(rec.createdAt).toBeGreaterThanOrEqual(before);
  });

  it('get() round-trips name, mime, and byteLength', async () => {
    const be = new MemoryBackend();
    const rec = await be.put({ name: 'snare.wav', mime: 'audio/wav', bytes: new ArrayBuffer(16) });
    const got = await be.get(rec.id);
    expect(got).not.toBeNull();
    expect(got!.name).toBe('snare.wav');
    expect(got!.mime).toBe('audio/wav');
    expect(got!.bytes.byteLength).toBe(16);
  });

  it('get() of an unknown id returns null', async () => {
    const be = new MemoryBackend();
    expect(await be.get('nope')).toBeNull();
  });

  it('list() returns all stored records', async () => {
    const be = new MemoryBackend();
    await be.put({ name: 'a', mime: 'audio/wav', bytes: new ArrayBuffer(4) });
    await be.put({ name: 'b', mime: 'audio/wav', bytes: new ArrayBuffer(4) });
    const all = await be.list();
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.name).sort()).toEqual(['a', 'b']);
  });

  it('delete() removes the record (get -> null afterwards)', async () => {
    const be = new MemoryBackend();
    const rec = await be.put({ name: 'tmp', mime: 'audio/wav', bytes: new ArrayBuffer(4) });
    await be.delete(rec.id);
    expect(await be.get(rec.id)).toBeNull();
    expect(await be.list()).toHaveLength(0);
  });

  it('put() over MAX_SAMPLE_BYTES throws SampleTooLargeError and writes nothing', async () => {
    const be = new MemoryBackend();
    const huge = new ArrayBuffer(MAX_SAMPLE_BYTES + 1);
    await expect(
      be.put({ name: 'huge', mime: 'audio/wav', bytes: huge }),
    ).rejects.toBeInstanceOf(SampleTooLargeError);
    expect(await be.list()).toHaveLength(0);
  });

  it('put() with an explicit id overwrites (factory stable-key behaviour)', async () => {
    const be = new MemoryBackend();
    await be.put({ id: 'factory-kick', name: 'Kick v1', mime: 'audio/internal', bytes: new ArrayBuffer(0) });
    await be.put({ id: 'factory-kick', name: 'Kick v2', mime: 'audio/internal', bytes: new ArrayBuffer(0) });
    const all = await be.list();
    expect(all).toHaveLength(1);
    expect(all[0]!.name).toBe('Kick v2');
  });

  it('a 0-byte buffer (factory marker) is accepted', async () => {
    const be = new MemoryBackend();
    const rec = await be.put({ id: 'factory-hat', name: 'Hat', mime: 'audio/internal', bytes: new ArrayBuffer(0) });
    expect(rec.size).toBe(0);
  });

  it('stored bytes are an independent copy (caller buffer stays usable)', async () => {
    const be = new MemoryBackend();
    const src = new Uint8Array([1, 2, 3, 4]);
    const rec = await be.put({ name: 'copy', mime: 'audio/wav', bytes: src.buffer });
    src[0] = 99; // mutate the caller's buffer after the put
    const got = await be.get(rec.id);
    expect(new Uint8Array(got!.bytes)[0]).toBe(1); // store kept its own slice
  });

  it('assertSampleSize: at cap ok, over cap throws', () => {
    expect(() => assertSampleSize(MAX_SAMPLE_BYTES)).not.toThrow();
    expect(() => assertSampleSize(MAX_SAMPLE_BYTES + 1)).toThrow(SampleTooLargeError);
    expect(() => assertSampleSize(0)).not.toThrow();
  });

  it('newSampleId() is distinct on repeat calls', () => {
    const ids = new Set([newSampleId(), newSampleId(), newSampleId()]);
    expect(ids.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Sample portability (feature: presets + save/load). base64 codec + the
// export/import gather/restore seam, all against MemoryBackend (Node-clean).
// ---------------------------------------------------------------------------

function bufOf(...vals: number[]): ArrayBuffer {
  return new Uint8Array(vals).buffer;
}

function bytesOf(buf: ArrayBuffer): number[] {
  return [...new Uint8Array(buf)];
}

describe('sample portability (base64 + export/import)', () => {
  it('base64 round-trips an empty buffer', () => {
    expect(arrayBufferToBase64(new ArrayBuffer(0))).toBe('');
    expect(base64ToArrayBuffer('').byteLength).toBe(0);
    expect(bytesOf(base64ToArrayBuffer(arrayBufferToBase64(new ArrayBuffer(0))))).toEqual([]);
  });

  it('base64 round-trips 1/2/3-byte padding boundaries byte-identical', () => {
    const one = bufOf(0xf0);
    const two = bufOf(0xf0, 0x0f);
    const three = bufOf(0xde, 0xad, 0xbe);
    // padding shapes: 1 byte -> '==', 2 bytes -> '=', 3 bytes -> no pad
    expect(arrayBufferToBase64(one).endsWith('==')).toBe(true);
    expect(arrayBufferToBase64(two).endsWith('=')).toBe(true);
    expect(arrayBufferToBase64(two).endsWith('==')).toBe(false);
    expect(arrayBufferToBase64(three).endsWith('=')).toBe(false);
    expect(bytesOf(base64ToArrayBuffer(arrayBufferToBase64(one)))).toEqual([0xf0]);
    expect(bytesOf(base64ToArrayBuffer(arrayBufferToBase64(two)))).toEqual([0xf0, 0x0f]);
    expect(bytesOf(base64ToArrayBuffer(arrayBufferToBase64(three)))).toEqual([0xde, 0xad, 0xbe]);
  });

  it('base64 round-trips all byte values 0..255', () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    const back = new Uint8Array(base64ToArrayBuffer(arrayBufferToBase64(all.buffer)));
    expect(back.length).toBe(256);
    for (let i = 0; i < 256; i++) expect(back[i]).toBe(i);
  });

  it('base64 matches a reference encoding ("Man" -> "TWFu")', () => {
    const man = new TextEncoder().encode('Man').buffer;
    expect(arrayBufferToBase64(man)).toBe('TWFu');
    expect(new TextDecoder().decode(base64ToArrayBuffer('TWFu'))).toBe('Man');
  });

  it('base64 round-trips a ~MAX_SAMPLE_BYTES random buffer byte-identical (no overflow)', () => {
    const src = new Uint8Array(MAX_SAMPLE_BYTES);
    // deterministic pseudo-random fill — avoids a flaky test while exercising the chunked path
    let seed = 0x9e3779b9;
    for (let i = 0; i < src.length; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      src[i] = seed & 0xff;
    }
    const encoded = arrayBufferToBase64(src.buffer);
    const back = new Uint8Array(base64ToArrayBuffer(encoded));
    expect(back.length).toBe(src.length);
    // spot-check boundaries + a fast direct byte scan (vitest's recursive toEqual is
    // pathologically slow on a 4M-element typed array; a tight loop is byte-identical
    // and ~instant).
    expect(back[0]).toBe(src[0]);
    expect(back[src.length - 1]).toBe(src[src.length - 1]);
    let mismatch = -1;
    for (let i = 0; i < src.length; i++) {
      if (back[i] !== src[i]) {
        mismatch = i;
        break;
      }
    }
    expect(mismatch).toBe(-1);
  }, 20000);

  it('base64 decoder tolerates whitespace and never throws on garbage', () => {
    const three = bufOf(0xde, 0xad, 0xbe);
    const enc = arrayBufferToBase64(three);
    const withWs = enc.slice(0, 2) + '\n ' + enc.slice(2);
    expect(bytesOf(base64ToArrayBuffer(withWs))).toEqual([0xde, 0xad, 0xbe]);
    // illegal chars / impossible length -> empty buffer, no throw
    expect(base64ToArrayBuffer('@@@@').byteLength).toBe(0);
    expect(base64ToArrayBuffer('A').byteLength).toBe(0); // len %4 === 1
    expect(base64ToArrayBuffer('====').byteLength).toBe(0);
  });

  it('exportSamples gathers only user ids; skips factory/null/dangling', async () => {
    const be = new MemoryBackend();
    await be.put({ id: 'user-1', name: 'one', mime: 'audio/wav', bytes: bufOf(1, 2, 3) });
    await be.put({ id: 'user-2', name: 'two', mime: 'audio/wav', bytes: bufOf(4, 5) });
    await be.put({ id: 'factory-kick', name: 'Kick', mime: 'audio/internal', bytes: new ArrayBuffer(0) });
    // 'user-3' is referenced but never stored (dangling); 'factory-hat' + '' are excluded by predicate
    const entries = await exportSamples(be, ['user-1', 'factory-kick', 'user-2', 'user-3', 'factory-hat', '', 'user-1']);
    const ids = entries.map((e) => e.id).sort();
    expect(ids).toEqual(['user-1', 'user-2']); // de-duped, factory + dangling + empty dropped
    const one = entries.find((e) => e.id === 'user-1')!;
    expect(one.name).toBe('one');
    expect(one.mime).toBe('audio/wav');
    expect(bytesOf(base64ToArrayBuffer(one.bytesBase64))).toEqual([1, 2, 3]);
  });

  it('exportSamples of a factory-only set yields []', async () => {
    const be = new MemoryBackend();
    await be.put({ id: 'factory-kick', name: 'Kick', mime: 'audio/internal', bytes: new ArrayBuffer(0) });
    expect(await exportSamples(be, ['factory-kick', 'factory-hat'])).toEqual([]);
  });

  it('importSamples writes bundle bytes under the SAME id (pad refs resolve)', async () => {
    const be = new MemoryBackend();
    const entries: SampleBundleEntry[] = [
      { id: 'user-1', name: 'one', mime: 'audio/wav', bytesBase64: arrayBufferToBase64(bufOf(9, 8, 7)) },
    ];
    await importSamples(be, entries);
    const got = await be.get('user-1');
    expect(got).not.toBeNull();
    expect(got!.name).toBe('one');
    expect(got!.mime).toBe('audio/wav');
    expect(bytesOf(got!.bytes)).toEqual([9, 8, 7]);
    expect(got!.size).toBe(3); // size re-derived by put()
  });

  it('importSamples OVERWRITES an existing id (re-import wins over stale bytes)', async () => {
    const be = new MemoryBackend();
    await be.put({ id: 'user-1', name: 'stale', mime: 'audio/wav', bytes: bufOf(0, 0) });
    await importSamples(be, [
      { id: 'user-1', name: 'fresh', mime: 'audio/wav', bytesBase64: arrayBufferToBase64(bufOf(1, 2, 3, 4)) },
    ]);
    const got = await be.get('user-1');
    expect(got!.name).toBe('fresh');
    expect(bytesOf(got!.bytes)).toEqual([1, 2, 3, 4]);
  });

  it('importSamples round-trips through export (export -> import -> get byte-identical)', async () => {
    const src = new MemoryBackend();
    await src.put({ id: 'user-a', name: 'a', mime: 'audio/wav', bytes: bufOf(10, 20, 30, 40, 50) });
    const entries = await exportSamples(src, ['user-a']);
    const dest = new MemoryBackend();
    await importSamples(dest, entries);
    const got = await dest.get('user-a');
    expect(bytesOf(got!.bytes)).toEqual([10, 20, 30, 40, 50]);
  });

  it('importSamples skips malformed + over-cap entries while importing the rest', async () => {
    const be = new MemoryBackend();
    const overCap: SampleBundleEntry = {
      id: 'too-big',
      name: 'huge',
      mime: 'audio/wav',
      bytesBase64: arrayBufferToBase64(new ArrayBuffer(MAX_SAMPLE_BYTES + 1)),
    };
    const good: SampleBundleEntry = {
      id: 'good-1',
      name: 'good',
      mime: 'audio/wav',
      bytesBase64: arrayBufferToBase64(bufOf(7, 7, 7)),
    };
    const corruptB64: SampleBundleEntry = {
      id: 'corrupt',
      name: 'bad',
      mime: 'audio/wav',
      bytesBase64: '@@@not-base64@@@', // decodes to empty from a non-empty source -> skipped
    };
    const malformed = { id: 5, name: 'x' } as unknown as SampleBundleEntry; // wrong types
    await importSamples(be, [overCap, good, corruptB64, malformed, null, 'nope']);
    expect(await be.get('too-big')).toBeNull(); // over cap dropped
    expect(await be.get('corrupt')).toBeNull(); // bad base64 dropped
    const got = await be.get('good-1');
    expect(got).not.toBeNull(); // the valid one still imported
    expect(bytesOf(got!.bytes)).toEqual([7, 7, 7]);
  });

  it('importSamples never throws on non-array / garbage input', async () => {
    const be = new MemoryBackend();
    await expect(importSamples(be, undefined)).resolves.toBeUndefined();
    await expect(importSamples(be, 'not-an-array')).resolves.toBeUndefined();
    await expect(importSamples(be, { id: 'x' })).resolves.toBeUndefined();
    expect(await be.list()).toHaveLength(0);
  });

  it('a zero-byte (factory-marker) entry imports as an empty buffer', async () => {
    const be = new MemoryBackend();
    // bytesBase64 '' from a genuinely empty source -> 0 bytes is the intended value, NOT a decode failure
    await importSamples(be, [{ id: 'empty-1', name: 'e', mime: 'audio/internal', bytesBase64: '' }]);
    const got = await be.get('empty-1');
    expect(got).not.toBeNull();
    expect(got!.bytes.byteLength).toBe(0);
  });
});
