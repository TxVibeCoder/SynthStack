/**
 * Sampler pad section e2e (feature-sampler-pads) — runs in the
 * installed Chrome (playwright.config.ts `channel: 'chrome'`; no downloaded
 * browsers) against the Vite dev server.
 *
 * Proves the g5 scroll model + the cross-group wiring end-to-end:
 *   a. the 16:9 console testids sit ABOVE the fold (pixel-stable at 1920×1080)
 *      — they're visible the instant the page loads, before any scroll
 *   b. the SAMPLER section lives BELOW the fold and is reached by scrolling the
 *      .stage-viewport; the pads come PRE-LOADED with the factory kit (no pad reads
 *      'EMPTY'), and loading a tiny WAV via the hidden pad-0 file input OVERRIDES
 *      the factory Kick on that pad (g4 SamplerPanel + g3 loadPadSample)
 *   c. clicking pad-0 auditions it without throwing
 *   d. a cable dragged SAMP_PAD1_OUT → an Monarch input renders + commits (the pad
 *      jack, rendered inside the same scaled <main>, is patchable for free — the
 *      single most load-bearing cross-group claim of the scroll model)
 *   e. RUN ALL plays with zero console errors
 *
 * A second test covers the loop-quantize ADD (per-pad LOOP switch + one global
 * QUANTIZE selector): both Switches render, round-trip through the bridge into
 * state.sampler, and a tap on a LOOP-on pad while the master is RUNNING launches a
 * HELD loop (tap-again stops it) — again with zero console errors.
 *
 * jackCenter/dragCable mirror patch.spec.ts (jackCenter calls
 * scrollIntoViewIfNeeded so pad jacks below the fold work under page.mouse).
 */

import { expect, test, type Page } from '@playwright/test';
// window.__synthstackStudio is typed by src/ui/engineBridge.ts's global declaration

const jackCenter = async (page: Page, id: string) => {
  const el = page.locator(`circle[data-jack-id="${id}"]`);
  await el.scrollIntoViewIfNeeded();
  const box = (await el.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};

const dragCable = async (page: Page, fromId: string, toId: string) => {
  const a = await jackCenter(page, fromId);
  const b = await jackCenter(page, toId);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
};

const cables = (page: Page) =>
  page.evaluate(() => window.__synthstackStudio!.store.getState().cables);

/**
 * A minimal valid mono 16-bit PCM WAV (44-byte header + a few sample frames),
 * built in Node so the test needs no on-disk fixture. decodeAudioData accepts
 * canonical WAV, so loadPadSample resolves to a real (tiny) AudioBuffer.
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
    // a quiet ramp so the buffer isn't pure silence
    buf.writeInt16LE(Math.round(Math.sin((i / frames) * Math.PI * 2) * 8000), 44 + i * 2);
  }
  return buf;
}

test('sampler: 16:9 pins to top, pad load below the fold, cable to the SynthStack', async ({ page }) => {
  // the 16:9 stage's design target — the console fills the viewport, pads scroll
  await page.setViewportSize({ width: 1920, height: 1080 });
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.location().url.includes('favicon')) errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');
  await page.getByTestId('power').click();

  // ---- a. the 16:9 console sits above the fold (pixel-stable, no scroll) -----------
  // top-aligned at exact 16:9, scale==1 — these tiers are visible immediately.
  for (const tier of ['tier-cascade', 'tier-anvil', 'tier-monarch', 'tier-mixer']) {
    await expect(page.getByTestId(tier)).toBeVisible();
  }
  // the console's bottom edge (STAGE.h = 1015.42) is at the very bottom of the
  // 1080 viewport, so the SAMPLER section is below the fold: not yet in view.
  const samplerBoxBefore = await page.getByTestId('sampler-section').boundingBox();
  expect(samplerBoxBefore, 'sampler-section is laid out (below the fold)').not.toBeNull();
  expect(samplerBoxBefore!.y, 'sampler-section starts at/below the fold').toBeGreaterThanOrEqual(1000);

  // ---- b. scroll the viewport down → the SAMPLER section comes into view ------------
  await page.getByTestId('sampler-section').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('sampler-panel')).toBeVisible();
  await expect(page.getByTestId('pad-0')).toBeVisible();

  // the pads come PRE-LOADED with the factory kit, so pad-0 shows the factory Kick
  // (no pad reads EMPTY); loading a WAV below OVERRIDES that factory sound.
  await expect(page.getByTestId('sampler-panel')).toContainText('KICK');
  await expect(page.getByTestId('sampler-panel')).not.toContainText('EMPTY');

  // load a tiny WAV into pad 0 via its hidden file input (the LOAD button's
  // React-managed <input type="file">) — this OVERRIDES the factory Kick on pad 0.
  // setInputFiles dispatches change.
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles({
    name: 'kick.wav',
    mimeType: 'audio/wav',
    buffer: tinyWav(),
  });
  // the pad-0 name label changes from the factory 'KICK' to the loaded file's name
  // once the store ref commits. The panel renders the name UPPER-CASED (SamplerPanel
  // name.toUpperCase()), so match case-insensitively rather than on the raw 'kick.wav'.
  await expect.poll(
    async () => {
      const txt = (await page.getByTestId('sampler-panel').textContent()) ?? '';
      return txt.toLowerCase().includes('kick.wav');
    },
    { message: "pad-0 name label should change from the factory Kick to the loaded file's name" },
  ).toBe(true);

  // ---- c. click pad-0 to audition (must not throw) ---------------------------------
  await page.getByTestId('pad-0').click();

  // ---- d. cable SAMP_PAD1_OUT → an Monarch input commits + renders ---------------------
  // (pad-1 jack == PAD index 0; jacks are 1-based in the def, 0-based in state)
  const before = (await cables(page)).length;
  await dragCable(page, 'SAMP_PAD1_OUT', 'MON_VCF_CUTOFF_IN');
  await expect.poll(() => cables(page).then((c) => c.length)).toBe(before + 1);
  expect((await cables(page)).at(-1)).toMatchObject({
    from: 'SAMP_PAD1_OUT',
    to: 'MON_VCF_CUTOFF_IN',
  });
  expect(await page.locator('svg.cable-layer g').count()).toBeGreaterThan(0);

  // ---- e. RUN ALL plays 500 ms with zero console errors ----------------------------
  await page.locator('[role="button"][aria-label^="RUN ALL"]').click();
  await page.waitForTimeout(500);
  await page.locator('[role="button"][aria-label^="STOP ALL"]').click();

  expect(errors).toEqual([]);
});

/**
 * Loop-quantize flow (ADD: per-pad LOOP toggle + one global QUANTIZE selector).
 * Proves the g1→g4 wiring end-to-end without an assertion on audio: the two new
 * Switch controls are present, change the serialized state through the bridge,
 * and a tap launches a held loop while the Monarch master is RUNNING — all with zero
 * console errors. The master IS running here (RUN ALL clicked before the tap), so
 * QUANTIZE defers the launch to the bar grid; the pad keeps sounding (the held
 * loop), unlike the one-shot audition in the first test (master stopped there).
 *
 * Switch.tsx emits no testid of its own, so g4 wraps each instance in an outer
 * <g data-testid=…>; clicking that <g> advances the lever and fires onChange.
 * Quantize/loop live in state.sampler (NOT state.controls), so they're read back
 * through the bridge (getQuantize / getPadState(n).loop / isPadLoopSounding) the
 * same way the pad meta is — see SamplerPanel.tsx's pad-meta subscription.
 */
test('sampler: per-pad LOOP toggle + global QUANTIZE launch a held loop on the grid', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.location().url.includes('favicon')) errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');
  await page.getByTestId('power').click();

  // bring the SAMPLER section into view and load a real (tiny) buffer into pad 0 —
  // a loop with no sample is a silent no-op, so it must hold an AudioBuffer first.
  await page.getByTestId('sampler-section').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('sampler-panel')).toBeVisible();
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles({ name: 'loop.wav', mimeType: 'audio/wav', buffer: tinyWav() });
  await expect
    .poll(async () => {
      const txt = (await page.getByTestId('sampler-panel').textContent()) ?? '';
      return txt.toLowerCase().includes('loop.wav');
    })
    .toBe(true);

  // ---- a. the new controls render -------------------------------------------------
  await expect(page.getByTestId('pad-0-loop')).toBeVisible();
  await expect(page.getByTestId('sampler-quantize')).toBeVisible();

  // QUANTIZE defaults to '1 BAR' (data/sampler.json default + defaultSamplerState).
  const quantize = () =>
    page.evaluate(() => window.__synthstackStudio!.getQuantize() as string);
  expect(await quantize()).toBe('1 BAR');

  // ---- b. toggle pad-0 LOOP ON ----------------------------------------------------
  // the Switch is a 2-position lever (OFF/ON); one click advances OFF→ON. The flag
  // is declarative — toggling it does NOT itself launch audio (it picks the path
  // the NEXT tap takes), so this commits to the store without a sounding voice.
  const padLoop = (n: number) =>
    page.evaluate((i) => window.__synthstackStudio!.getPadState(i).loop, n);
  expect(await padLoop(0)).toBe(false);
  await page.getByTestId('pad-0-loop').click();
  await expect.poll(() => padLoop(0)).toBe(true);

  // ---- c. pick a QUANTIZE position so a launch defers to the grid -----------------
  // one click advances OFF/1/16/1/8/1/4/1/2/1 BAR by one; from '1 BAR' (index 5)
  // it wraps to 'OFF' (index 0). OFF means an immediate launch — fine for this
  // test (we only assert the selector round-trips + the held loop sounds). We then
  // step once more to a real grid division to prove the selector keeps changing.
  await page.getByTestId('sampler-quantize').click();
  await expect.poll(quantize).toBe('OFF');
  await page.getByTestId('sampler-quantize').click();
  await expect.poll(quantize).toBe('1/16');

  // ---- d. start the master, then tap the LOOP pad → a held loop -------------------
  // master RUNNING here, so with a non-OFF quantize the launch snaps to the grid;
  // the pad then HOLDS (loop voice retained), unlike the first test's one-shot.
  await page.locator('[role="button"][aria-label^="RUN ALL"]').click();
  await page.getByTestId('pad-0').click();

  // the held loop becomes audible once its quantized boundary passes. At 120 BPM a
  // 1/16 grid boundary is ≤ 125 ms out, so poll briefly for the sounding voice.
  const sounding = (n: number) =>
    page.evaluate((i) => window.__synthstackStudio!.isPadLoopSounding(i), n);
  await expect.poll(() => sounding(0), { timeout: 4000 }).toBe(true);

  // ---- e. tap again STOPS the held loop (deferred to the next boundary) -----------
  await page.getByTestId('pad-0').click();
  await expect.poll(() => sounding(0), { timeout: 4000 }).toBe(false);

  await page.locator('[role="button"][aria-label^="STOP ALL"]').click();
  expect(errors).toEqual([]);
});
