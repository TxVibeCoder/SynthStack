/**
 * Drum machine e2e (feature-sampler-pads) — runs in the installed
 * Chrome (playwright.config.ts `channel: 'chrome'`; no downloaded browsers)
 * against the Vite dev server. Mirrors sampler.spec.ts's scroll idiom + its
 * tinyWav helper.
 *
 * The drum machine is an 8-track × 16-step grid (track t triggers sample pad t),
 * stepped one column per master 16th by the 5th scheduler citizen samplerSeq. It
 * lives on the SAMPLER tab directly BELOW the pads (DRUM_REGION tiles under
 * SAMPLER_REGION), rendered inside the same scaled <main>. This spec proves the
 * g1→g5 wiring end-to-end:
 *   a. the STUDIO console tiers render on the default STUDIO tab at load
 *   b. on the SAMPLER tab the DRUM MACHINE panel fill-zooms into view (per-tab fill,
 *      not a scroll fold)
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

test('drum machine: on the sampler tab, cell round-trips, RUN plays, CLEAR zeroes', async ({
  page,
}) => {
  // the 16:9 stage's design target — the sampler section (pads + drum grid) lives on
  // the SAMPLER tab and fill-zooms into view when that tab is active.
  await page.setViewportSize({ width: 1920, height: 1080 });
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.location().url.includes('favicon')) errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');
  await page.getByTestId('power').click();

  // ---- a. the STUDIO console tiers render on the default STUDIO tab ----------------
  // the app boots on the STUDIO tab, so the voice tiers are visible immediately.
  for (const tier of ['tier-cascade', 'tier-anvil', 'tier-monarch', 'tier-mixer']) {
    await expect(page.getByTestId(tier)).toBeVisible();
  }

  // ---- b. switch to the SAMPLER tab → the DRUM MACHINE panel fill-zooms into view ---
  // In the 3-tab layout the drum grid lives on the SAMPLER tab (below the pads) and is
  // scaled to FILL the viewport, so it is on screen once the tab is active — this
  // asserts the NEW per-tab-fill behavior (replacing the old below-the-fold scroll).
  await page.getByTestId('tab-sampler').click();
  await expect(page.getByTestId('drum-machine-panel')).toBeVisible();
  await expect(page.getByTestId('drum-cell-0-0')).toBeVisible();
  const drumBox = await page.getByTestId('drum-section').boundingBox();
  expect(drumBox, 'drum-section is laid out on the sampler tab').not.toBeNull();
  expect(drumBox!.y, 'drum-section top is within the viewport (fill-zoom)').toBeLessThan(1080);
  expect(drumBox!.y + drumBox!.height, 'drum-section is on screen, not below a fold').toBeGreaterThan(0);

  // ---- c. toggle cell (0,0) → it round-trips into state.sampler.pattern[0][0] ------
  expect((await pattern(page))[0]![0], 'pattern[0][0] starts OFF').toBe(false);
  await page.getByTestId('drum-cell-0-0').click();
  await expect.poll(async () => (await pattern(page))[0]![0]).toBe(true);
  // toggling again flips it back (idempotent pair)
  await page.getByTestId('drum-cell-0-0').click();
  await expect.poll(async () => (await pattern(page))[0]![0]).toBe(false);

  // ---- d. arm pad-0 with a tiny WAV, set a couple of cells, RUN ALL + drum RUN -----
  // load a real (tiny) buffer into pad 0 so the track-0 hits aren't silent no-ops.
  // The sampler panel and the drum grid share the SAMPLER tab (we are already on it),
  // both fill-zoomed into view — no scroll fold to clear.
  await expect(page.getByTestId('sampler-panel')).toBeVisible();
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles({ name: 'kick.wav', mimeType: 'audio/wav', buffer: tinyWav() });
  await expect
    .poll(async () => {
      const txt = (await page.getByTestId('sampler-panel').textContent()) ?? '';
      return txt.toLowerCase().includes('kick.wav');
    })
    .toBe(true);

  // light up a few steps on track 0 (the armed pad) — the drum grid is in view.
  await expect(page.getByTestId('drum-machine-panel')).toBeVisible();
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
