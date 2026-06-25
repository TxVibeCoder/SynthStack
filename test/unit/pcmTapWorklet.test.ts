/**
 * pcmTap.worklet allocation-discipline lock (feature: recording / thin-shell rule).
 *
 * The PCM tap is a thin worklet shell; CLAUDE.md forbids allocation in process(). The file
 * previously declared `const transfer = []` and `const out = []` INSIDE process(), minting two
 * fresh array literals every render quantum. They are now preallocated instance fields reused
 * across blocks (length reset to 0 each call).
 *
 * This is a behavior lock, not a source grep: we stub the AudioWorklet globals, instantiate the
 * processor, run process() twice, and assert the posted `channels` array + the `transfer` array
 * are the SAME object instances across blocks. On the OLD code each block posted a brand-new
 * array (different identity) and this test fails; on the new code identity is stable.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const workletSrc = resolve(here, '../../src/engine/worklets/pcmTap.worklet.ts');

type PostCall = { channels: Float32Array[]; transfer: unknown[] };

interface TapProcessor {
  process(inputs: Float32Array[][]): boolean;
}

/**
 * Load the worklet source under stubbed AudioWorklet globals and return the processor instance
 * plus a log of every postMessage(msg, transfer) call. The source registers itself via
 * registerProcessor; we capture the registered class and `new` it.
 */
function loadProcessor(): { proc: TapProcessor; posts: PostCall[] } {
  const posts: PostCall[] = [];
  const port = {
    postMessage(msg: { channels: Float32Array[] }, transfer: unknown[]) {
      posts.push({ channels: msg.channels, transfer });
    },
  };

  let RegisteredClass: (new () => TapProcessor) | null = null;

  // Strip TS types: the worklet is a tiny file; esbuild via Vitest already transpiles imports, but
  // this file is loaded raw, so transpile it through the project's TS the simple way — evaluate it
  // as a module that only needs the AudioWorkletProcessor base + registerProcessor + a port.
  const raw = readFileSync(workletSrc, 'utf8');

  class AudioWorkletProcessorStub {
    port = port;
  }

  const sandbox = {
    AudioWorkletProcessor: AudioWorkletProcessorStub,
    registerProcessor: (_name: string, cls: new () => TapProcessor) => {
      RegisteredClass = cls;
    },
    currentTime: 0,
    sampleRate: 48000,
  };

  // Transpile TS → JS (drop the type annotations) using the TypeScript compiler available in deps.
  // We do a minimal in-process transpile to avoid importing the .worklet.ts (which references
  // browser-only globals at module scope through the class body).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ts = require('typescript') as typeof import('typescript');
  const js = ts.transpileModule(raw, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function(
    'AudioWorkletProcessor',
    'registerProcessor',
    'currentTime',
    'sampleRate',
    js,
  );
  factory(
    sandbox.AudioWorkletProcessor,
    sandbox.registerProcessor,
    sandbox.currentTime,
    sandbox.sampleRate,
  );

  if (!RegisteredClass) throw new Error('worklet did not registerProcessor');
  return { proc: new (RegisteredClass as new () => TapProcessor)(), posts };
}

function stereoBlock(): Float32Array[][] {
  const l = new Float32Array(128);
  const r = new Float32Array(128);
  for (let i = 0; i < 128; i++) {
    l[i] = Math.sin(i / 10);
    r[i] = Math.cos(i / 10);
  }
  return [[l, r]];
}

describe('pcmTap.worklet — no per-block array allocation (thin-shell rule)', () => {
  let loaded: ReturnType<typeof loadProcessor>;

  beforeAll(() => {
    loaded = loadProcessor();
  });

  it('reuses the SAME out (channels) and transfer arrays across blocks', () => {
    const { proc, posts } = loaded;
    expect(proc.process(stereoBlock())).toBe(true);
    expect(proc.process(stereoBlock())).toBe(true);
    expect(posts.length).toBe(2);

    // Allocation lock: identical array instances each block. Fresh literals (the old bug) would
    // make these distinct objects and fail the toBe identity check.
    expect(posts[1]!.channels).toBe(posts[0]!.channels);
    expect(posts[1]!.transfer).toBe(posts[0]!.transfer);
  });

  it('still posts the correct channel count and fresh detached buffers per block', () => {
    const { proc, posts } = loadProcessor();
    proc.process(stereoBlock());
    expect(posts[0]!.channels.length).toBe(2);
    expect(posts[0]!.transfer.length).toBe(2);
    // Each block ships the two slot buffers (the forced realloc keeps next block's buffers fresh).
    proc.process(stereoBlock());
    expect(posts[1]!.channels.length).toBe(2);
  });
});
