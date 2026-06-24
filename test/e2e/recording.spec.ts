/**
 * Master-recording e2e (feature-sampler-pads) — runs in the installed
 * Chrome (playwright.config.ts `channel: 'chrome'`; no downloaded browsers)
 * against the Vite dev server. Mirrors drumMachine.spec.ts / keyboard.spec.ts /
 * smoke (console-error collection, power-on, testid assertions, the
 * window.__synthstackStudio engine read).
 *
 * The RECORD button lives in the top-right UTILITY STRIP (UtilityStrip.tsx,
 * formerly a dimmed placeholder, now LIVE). Clicking it
 * toggles capture of the master output (post-softClip, the final audible node)
 * into a MediaStreamAudioDestinationNode + MediaRecorder; the button lights red
 * while recording and shows an elapsed m:ss readout; a second click stops and (in
 * a real browser) triggers a synthstack-*.webm download. Recording is a leaf
 * fan-out off softClip — the softClip->destination edge is untouched, so the
 * studio keeps SOUNDING while recording.
 *
 * This spec proves the g1->g4 wiring end-to-end, WITHOUT validating the captured
 * bytes (headlessly impossible — see the CHECKPOINT note below):
 *   a. power on -> the RECORD button renders inside the utility-strip region;
 *      getRecordingState().recording is false and the elapsed readout is absent
 *   b. click RECORD -> the bridge poll flips recording true, the Button's
 *      aria-pressed goes true, and the [data-testid=record-elapsed] readout appears
 *   c. the elapsed timer ADVANCES (the readout's m:ss text changes as the recorder
 *      runs) — proves the live capture + the 250 ms UI poll are wired
 *   d. click RECORD again -> recording flips back to false (idle), aria-pressed
 *      false, and the record-elapsed readout is removed from the DOM
 *   e. ZERO console errors across the whole session
 *
 * MANUAL CHECKPOINT (design-flagged, NOT headlessly validatable): the actual
 * captured .webm bytes cannot be confirmed in automation — a human records in real
 * Chrome/Edge, confirms a synthstack-*.webm DOWNLOADS, PLAYS BACK, and contains
 * the FULL MIX (all three SynthStacks + sampler + drum + keyboard), and verifies a
 * POWER-toggle MID-RECORD still produces a complete file (the auto-stop +
 * flush-before-suspend path in StudioContext.powerOff). This spec deliberately
 * does NOT assert a downloaded file; it only proves the lamp / toggle / elapsed
 * poll and that nothing throws.
 *
 * REAL-DOWNLOAD HAZARD: the second (stop) click fires triggerDownload -> a real
 * <a download>.click() in channel Chrome. We register page.on('download', ...) to
 * CONSUME it so Playwright does not leave it dangling (which could otherwise flake
 * the zero-console-errors assertion). We never assert anything about its contents.
 *
 * The existing smoke/patch/clock/sampler/drum/keyboard/screenshots e2e + the audio
 * battery must still pass unchanged — recording is purely additive (no master-chain
 * node insertion, no state change; the recorder only exists after the first RECORD
 * click inside StudioContext).
 */

import { expect, test } from '@playwright/test';
// window.__synthstackStudio is typed by src/ui/engineBridge.ts's global declaration

test('recording: RECORD lights, elapsed advances, a second click returns to idle', async ({
  page,
}) => {
  // the 16:9 stage's design target — the console (incl. the utility strip with the
  // RECORD button) fills the viewport; only the sampler/drum section scrolls.
  await page.setViewportSize({ width: 1920, height: 1080 });

  const errors: string[] = [];
  page.on('console', (msg) => {
    // index.html ships no favicon; Chrome's /favicon.ico probe 404s against the
    // dev server — network noise, not an app error (same filter as smoke.spec).
    if (msg.type() === 'error' && !msg.location().url.includes('favicon')) errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  // CONSUME the real browser download the stop-click fires (triggerDownload ->
  // <a download>.click()). Awaiting d.path() resolves the saved temp file so
  // Playwright never leaves the download pending; failures are swallowed (the
  // file's existence/contents are a manual checkpoint, not asserted here).
  page.on('download', (d) => {
    void d.path().catch(() => {});
  });

  await page.goto('/');
  await page.getByTestId('power').click();
  // Wait for the engine to power before touching the recorder: recording guards on the bridge
  // `_powered` flag, so a RECORD click before power-on completes is a silent no-op (power-on lags
  // the UI rendering under parallel headless load). Mirrors smoke.spec / drumMachine.spec.
  await page.waitForFunction(
    () => (window.__synthstackStudio as { powered?: boolean } | undefined)?.powered === true,
    null,
    { timeout: 15_000 },
  );

  const isRecording = () =>
    page.evaluate(() => window.__synthstackStudio!.getRecordingState().recording as boolean);

  // ---- a. the RECORD button renders in the utility strip; recorder starts idle -----
  const strip = page.getByTestId('utility-strip');
  await expect(strip).toBeVisible();
  const record = page.getByTestId('record');
  await expect(record).toBeVisible();
  // the RECORD control is the child of the utility-strip region (its home).
  await expect(strip.getByTestId('record')).toBeVisible();
  // the shared Button renders role="button"; before recording it is not pressed.
  const recordButton = record.locator('[role="button"]');
  await expect(recordButton).toHaveAttribute('aria-pressed', 'false');

  expect(await isRecording(), 'recorder is idle right after power-on').toBe(false);
  // idle => the elapsed readout is absent from the DOM (rendered only while recording).
  await expect(page.getByTestId('record-elapsed')).toHaveCount(0);

  // ---- b. click RECORD -> recording true, lamp lit (aria-pressed), readout appears --
  await record.click();
  await expect.poll(isRecording, { message: 'RECORD click should start the recorder' }).toBe(true);
  await expect(recordButton).toHaveAttribute('aria-pressed', 'true');
  const elapsed = page.getByTestId('record-elapsed');
  await expect(elapsed).toBeVisible();

  // ---- c. the elapsed m:ss readout ADVANCES while recording --------------------------
  // first capture an early reading, then let real time pass and confirm the text
  // changed (the recorder's performance.now() clock + the 250 ms UI poll, live).
  const firstReading = ((await elapsed.textContent()) ?? '').trim();
  expect(firstReading, 'elapsed readout shows an m:ss string while recording').toMatch(
    /^\d+:\d{2}$/,
  );
  // cross at least one whole second so the m:ss text is guaranteed to tick forward.
  await page.waitForTimeout(1_300);
  await expect
    .poll(async () => ((await elapsed.textContent()) ?? '').trim(), {
      message: 'the elapsed readout should advance as the recorder runs',
    })
    .not.toBe(firstReading);

  // ---- d. click RECORD again -> back to idle (the stop-click fires the download) -----
  await record.click();
  await expect.poll(isRecording, { message: 'a second RECORD click should stop' }).toBe(false);
  await expect(recordButton).toHaveAttribute('aria-pressed', 'false');
  // idle again => the elapsed readout is removed from the DOM.
  await expect(page.getByTestId('record-elapsed')).toHaveCount(0);

  // ---- e. zero console errors across the whole session -------------------------------
  expect(errors, `console/page errors during the recording run:\n${errors.join('\n')}`).toEqual([]);
});
