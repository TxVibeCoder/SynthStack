/**
 * Keyboard + Web MIDI e2e (feature-sampler-pads) — runs in the installed
 * Chrome (playwright.config.ts `channel: 'chrome'`; no downloaded
 * browsers) against the Vite dev server. Mirrors drumMachine.spec.ts / smoke
 * (console-error collection, power-on, testid assertions).
 *
 * The keyboard lives in the futureStrip band (REGIONS.futureStrip — the reserved
 * bottom strip, now the on-screen piano's home), INSIDE the 16:9 stage, so it is
 * always visible with no scroll. It is a SECOND driver of the Monarch's ONE mono voice
 * (the same setPitchAt+gateAt calls the sequencer binding makes — the
 * "thin adapter"); the on-screen keys + Web MIDI share ONE last-note mono
 * allocator behind engineBridge.noteOn/noteOff.
 *
 * This spec proves the g1->g5 wiring end-to-end, WITHOUT real MIDI hardware
 * (which cannot be auto-tested headlessly — that is a manual hardware
 * checkpoint):
 *   a. power on -> the keyboard-panel + all 25 keys render in the future-strip region
 *   b. pressing a key drives the Monarch with ZERO console errors (the pointer
 *      down/up routes through engineBridge.noteOn/noteOff -> studio.monarchNoteOn/Off)
 *   c. OCT+ / OCT- change the octave readout (and the bridge's keyboardOctave),
 *      then return to centre
 *   d. ENABLE MIDI surfaces a NON-EMPTY status STRING — the config grants NO midi
 *      permission and passes no Chrome MIDI flag, so headless channel Chrome may
 *      DENY or auto-grant 0 devices; we accept ANY valid state (OFF / DENIED /
 *      NO MIDI / device text) and NEVER assert specifically 'enabled'. The shell
 *      degrades gracefully either way (never throws).
 *
 * The existing smoke/patch/clock/sampler/drum e2e + the audio battery must still
 * pass unchanged — the keyboard feature is purely additive (the futureStrip swap
 * leaves every other region pixel-identical and the cable space undisturbed).
 */

import { expect, test } from '@playwright/test';
// window.__synthstackStudio is typed by src/ui/engineBridge.ts's global declaration

const KEY_COUNT = 25; // 2 octaves + top C — engine keyMap.KEYBED_KEYS

test('keyboard: renders 25 keys, a press plays the Monarch, octave shifts, MIDI status surfaces', async ({
  page,
}) => {
  // the 16:9 stage's design target — the console (incl. the keyboard strip) fills
  // the viewport; only the sampler/drum section below the fold scrolls.
  await page.setViewportSize({ width: 1920, height: 1080 });

  const errors: string[] = [];
  page.on('console', (msg) => {
    // index.html ships no favicon; Chrome's /favicon.ico probe 404s against the
    // dev server — network noise, not an app error (same filter as smoke.spec).
    if (msg.type() === 'error' && !msg.location().url.includes('favicon')) errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');
  await page.getByTestId('power').click();

  // ---- a. the keyboard panel + all 25 keys render inside the future-strip region ----
  const region = page.getByTestId('future-strip');
  await expect(region).toBeVisible();
  const panel = page.getByTestId('keyboard-panel');
  await expect(panel).toBeVisible();
  // the panel is the child of the future-strip Region (the band is its home).
  await expect(region.getByTestId('keyboard-panel')).toBeVisible();
  for (let i = 0; i < KEY_COUNT; i++) {
    await expect(page.getByTestId(`key-${i}`)).toBeVisible();
  }
  // exactly 25 keys, no more/no fewer (15 white + 10 black from KEYBED_SHAPE).
  await expect(panel.locator('[data-testid^="key-"]')).toHaveCount(KEY_COUNT);

  // ---- b. pressing a key drives the Monarch (no throw, no console errors) ----------------
  // pointer down on a white key (semitone 0 = low C) then up: noteOn -> noteOff
  // through the shared mono allocator -> studio.monarchNoteOn/Off (setPitchAt+gateAt).
  const middleKey = page.getByTestId('key-12'); // top C of the lower octave (semitone 12)
  const box = await middleKey.boundingBox();
  expect(box, 'key-12 has a bounding box').not.toBeNull();
  const cx = box!.x + box!.width / 2;
  const cy = box!.y + box!.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down(); // noteOn
  await page.waitForTimeout(60); // let the gate be high for a beat
  await page.mouse.up(); // noteOff
  // a second key, pressed and released, exercises the mono allocator once more
  // (a fresh attack into an empty stack, then gate-off). Real mouse events so the
  // panel's setPointerCapture gets a valid pointerId.
  const lowBox = await page.getByTestId('key-0').boundingBox();
  expect(lowBox, 'key-0 has a bounding box').not.toBeNull();
  await page.mouse.move(lowBox!.x + lowBox!.width / 2, lowBox!.y + lowBox!.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(40);
  await page.mouse.up();

  // ---- c. OCT+ / OCT- shift the octave readout and the bridge's keyboardOctave -------
  const readingOctave = () =>
    page.evaluate(() => window.__synthstackStudio!.getKeyboardOctave() as number);
  const octaveStart = await readingOctave();
  expect(octaveStart, 'keyboard octave starts at 0 after power-on').toBe(0);

  await page.getByTestId('octave-up').click();
  await expect.poll(readingOctave).toBe(1);
  // the on-screen readout reflects the shift (its exact label text is the panel's
  // business — assert only that it is non-empty + present).
  await expect(page.getByTestId('octave-readout')).not.toBeEmpty();

  await page.getByTestId('octave-down').click();
  await page.getByTestId('octave-down').click();
  await expect.poll(readingOctave).toBe(-1);
  // back to centre so the run leaves no residual shift (defensive for any later spec
  // sharing the page is unnecessary — Playwright isolates pages — but it documents 0).
  await page.getByTestId('octave-up').click();
  await expect.poll(readingOctave).toBe(0);

  // ---- d. ENABLE MIDI surfaces a NON-EMPTY status string (any valid state) -----------
  // headless channel Chrome with no midi permission: may DENY or auto-grant 0 devices.
  // The shell never throws; the status caption must read SOMETHING. NEVER assert
  // specifically 'enabled' — real hardware + the permission prompt are manual-only.
  await page.getByTestId('enable-midi').click();
  await expect
    .poll(async () => ((await page.getByTestId('midi-status').textContent()) ?? '').trim().length)
    .toBeGreaterThan(0);

  // ---- zero console errors across the whole session ---------------------------------
  expect(errors, `console/page errors during the keyboard run:\n${errors.join('\n')}`).toEqual([]);
});
