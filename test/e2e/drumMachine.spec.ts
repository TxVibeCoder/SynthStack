/**
 * Drum machine e2e (feature-sampler-pads) — runs in the installed
 * Chrome (playwright.config.ts `channel: 'chrome'`; no downloaded browsers)
 * against the Vite dev server. Mirrors sampler.spec.ts's scroll idiom + its
 * tinyWav helper.
 *
 * The drum machine is an 8-track × 16-step grid (track t triggers sample pad t),
 * stepped one column per master 16th by the 5th scheduler citizen samplerSeq. It
 * lives in the SAME scroll-down section as the pads, directly BELOW them
 * (DRUM_REGION tiles under SAMPLER_REGION), rendered inside the same scaled
 * <main>. This spec proves the g1→g5 wiring end-to-end:
 *   a. the 16:9 console testids stay ABOVE the fold (pixel-stable at 1920×1080) —
 *      growing the scroll section for the drum grid does NOT disturb the console
 *   b. the DRUM MACHINE panel lives BELOW the fold and is reached by scrolling the
 *      .stage-viewport (scrollIntoViewIfNeeded)
 *   c. toggling drum-cell-0-0 round-trips into state.sampler.pattern[0][0] (the
 *      bridge toggleStep → coalesced store commit)
 *   d. with a tiny WAV on pad-0 + the master RUNNING (RUN ALL) then drum RUN
 *      (drum-runstop), the grid plays with ZERO console errors (the drumHit
 *      one-shots fire sampler.triggerPad; an empty-pad cell is a silent no-op)
 *   e. CLEAR (drum-clear) zeroes the pattern back to all-false
 *
 * The existing sampler.spec.ts (+ patch/clock/smoke e2e + the audio battery) must
 * still pass unchanged — the drum feature is purely additive.
 */

import { expect, test, type Page } from '@playwright/test';
// window.__synthstackStudio is typed by src/ui/engineBridge.ts's global declaration

/**
 * A minimal valid mono 16-bit PCM WAV (44-byte header + a few sample frames),
 * built in Node so the test needs no on-disk fixture — identical to the helper
 * sampler.spec.ts uses. decodeAudioData accepts canonical WAV, so loadPadSample
 * resolves to a real (tiny) AudioBuffer.
 */
function tinyWav(): Buffer {
  const sampleRate = 8000;
  const frames = 64; // ~8 ms — well under the 4 MB cap
  const dataBytes = frames * 2; // mono, 16-bit
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(Math.round(Math.sin((i / frames) * Math.PI * 2) * 8000), 44 + i * 2);
  }
  return buf;
}

/** The whole 8×16 pattern straight off the store (booleans, JSON round-trips). */
const pattern = (page: Page) =>
  page.evaluate(() => window.__synthstackStudio!.store.getState().sampler.pattern as boolean[][]);

test('drum machine: below the fold, cell round-trips, RUN plays, CLEAR zeroes', async ({
  page,
}) => {
  // the 16:9 stage's design target — the console fills the viewport, the sampler
  // section (pads + drum grid) scrolls.
  await page.setViewportSize({ width: 1920, height: 1080 });
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.location().url.includes('favicon')) errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');
  await page.getByTestId('power').click();

  // ---- a. the 16:9 console sits above the fold (pixel-stable, no scroll) -----------
  // growing the scroll section for the drum grid must not push the console tiers.
  for (const tier of ['tier-cascade', 'tier-anvil', 'tier-monarch', 'tier-mixer']) {
    await expect(page.getByTestId(tier)).toBeVisible();
  }
  // the drum section is laid out BELOW the pad section, so well past the fold.
  const drumBoxBefore = await page.getByTestId('drum-section').boundingBox();
  expect(drumBoxBefore, 'drum-section is laid out (below the fold)').not.toBeNull();
  expect(drumBoxBefore!.y, 'drum-section starts below the fold').toBeGreaterThanOrEqual(1000);

  // ---- b. scroll the viewport down → the DRUM MACHINE panel comes into view --------
  await page.getByTestId('drum-section').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('drum-machine-panel')).toBeVisible();
  await expect(page.getByTestId('drum-cell-0-0')).toBeVisible();

  // ---- c. toggle cell (0,0) → it round-trips into state.sampler.pattern[0][0] ------
  expect((await pattern(page))[0]![0], 'pattern[0][0] starts OFF').toBe(false);
  await page.getByTestId('drum-cell-0-0').click();
  await expect.poll(async () => (await pattern(page))[0]![0]).toBe(true);
  // toggling again flips it back (idempotent pair)
  await page.getByTestId('drum-cell-0-0').click();
  await expect.poll(async () => (await pattern(page))[0]![0]).toBe(false);

  // ---- d. arm pad-0 with a tiny WAV, set a couple of cells, RUN ALL + drum RUN -----
  // load a real (tiny) buffer into pad 0 so the track-0 hits aren't silent no-ops.
  await page.getByTestId('sampler-section').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('sampler-panel')).toBeVisible();
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles({ name: 'kick.wav', mimeType: 'audio/wav', buffer: tinyWav() });
  await expect
    .poll(async () => {
      const txt = (await page.getByTestId('sampler-panel').textContent()) ?? '';
      return txt.toLowerCase().includes('kick.wav');
    })
    .toBe(true);

  // light up a few steps on track 0 (the armed pad) — back in the drum section.
  await page.getByTestId('drum-section').scrollIntoViewIfNeeded();
  for (const step of [0, 4, 8, 12]) {
    await page.getByTestId(`drum-cell-0-${step}`).click();
  }
  await expect
    .poll(async () => {
      const p = await pattern(page);
      return [0, 4, 8, 12].every((s) => p[0]![s] === true);
    })
    .toBe(true);

  // master RUNNING first (the grid only emits while the Monarch master runs — v1
  // master-stopped semantics: drum RUN arms silently, snaps in on the run edge).
  await page.locator('[role="button"][aria-label^="RUN ALL"]').click();
  // drum RUN — the lit RUN/STOP latch
  await page.getByTestId('drum-runstop').click();
  await expect
    .poll(() => page.evaluate(() => window.__synthstackStudio!.getDrumSeqRunning() as boolean))
    .toBe(true);
  // let the grid step across at least a full bar at 120 BPM (one bar = 500 ms)
  await page.waitForTimeout(700);
  // STOP the grid + the master
  await page.getByTestId('drum-runstop').click();
  await page.locator('[role="button"][aria-label^="STOP ALL"]').click();

  // ---- e. CLEAR zeroes the whole pattern back to all-false ------------------------
  await page.getByTestId('drum-clear').click();
  await expect
    .poll(async () => {
      const p = await pattern(page);
      return p.length === 8 && p.every((row) => row.length === 16 && row.every((c) => c === false));
    })
    .toBe(true);

  expect(errors).toEqual([]);
});
