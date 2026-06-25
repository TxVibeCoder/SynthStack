/**
 * G5 sampler pop-out e2e — runs in the installed Chrome (playwright.config.ts `channel:'chrome'`)
 * against the Vite dev server. (Written here; executed in the integration pass.)
 *
 * Proves the two-window pop-out end to end:
 *   a. clicking POP OUT on the SAMPLER tab opens a SECOND page at `#/sampler-popout` showing 8 pads;
 *   b. tapping a pad in the POP-OUT reaches the MAIN engineBridge (the audition fires there);
 *   c. loading a sample in the POP-OUT mirrors the new pad name back in BOTH windows;
 *   d. EXACTLY ONE AudioContext exists — the pop-out NEVER instantiated engineBridge (its
 *      window.__synthstackStudio stays undefined), the single-AudioContext backstop for the
 *      "no second AudioContext" gotcha.
 */
import { expect, test, type Page } from '@playwright/test';

/** A minimal valid mono 16-bit PCM WAV built in Node (no on-disk fixture; mirrors sampler.spec). */
function tinyWav(): Buffer {
  const sampleRate = 8000;
  const frames = 64;
  const dataBytes = frames * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < frames; i++) {
    buf.writeInt16LE(Math.round(Math.sin((i / frames) * Math.PI * 2) * 8000), 44 + i * 2);
  }
  return buf;
}

const waitPowered = (page: Page) =>
  page.waitForFunction(
    () => (window.__synthstackStudio as { powered?: boolean } | undefined)?.powered === true,
    null,
    { timeout: 15_000 },
  );

test('sampler pop-out: 8 pads, audition reaches the MAIN engine, load mirrors back, one AudioContext', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.location().url.includes('favicon')) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await page.getByTestId('power').click();
  await waitPowered(page);

  // On the SAMPLER tab, the POP OUT button opens a second window.
  await page.getByTestId('tab-sampler').click();
  await expect(page.getByTestId('sampler-popout')).toBeVisible();

  const [popout] = await Promise.all([
    context.waitForEvent('page'),
    page.getByTestId('sampler-popout').click(),
  ]);
  await popout.waitForLoadState('domcontentloaded');

  // ---- a. the pop-out shows 8 pads -------------------------------------------------------
  for (let i = 0; i < 8; i++) {
    await expect(popout.getByTestId(`pad-${i}`)).toBeVisible();
  }

  // ---- d (part 1). the pop-out NEVER instantiated engineBridge --------------------------
  // The debug hook is set ONLY by engineBridge's module; the pop-out never imports it.
  const popoutHasEngine = await popout.evaluate(
    () => (window as { __synthstackStudio?: unknown }).__synthstackStudio !== undefined,
  );
  expect(popoutHasEngine, 'pop-out must NOT have an engineBridge singleton').toBe(false);

  // ---- b. tapping a pad in the POP-OUT reaches the MAIN engineBridge ---------------------
  // Audition has no persistent side effect, so assert via a flag the main page records by
  // wrapping the singleton's auditionPad before the tap.
  await page.evaluate(() => {
    const eb = window.__synthstackStudio as unknown as {
      auditionPad: (i: number) => void;
      __auditioned?: number[];
    };
    const orig = eb.auditionPad.bind(eb);
    eb.__auditioned = [];
    eb.auditionPad = (i: number) => {
      eb.__auditioned!.push(i);
      orig(i);
    };
  });
  await popout.getByTestId('pad-2').click();
  await expect
    .poll(async () =>
      page.evaluate(
        () => (window.__synthstackStudio as unknown as { __auditioned?: number[] }).__auditioned ?? [],
      ),
    )
    .toContain(2);

  // ---- c. loading a sample in the POP-OUT mirrors the new pad name back in BOTH ----------
  const popInput = popout.locator('input[type="file"]');
  await popInput.setInputFiles({ name: 'snare.wav', mimeType: 'audio/wav', buffer: tinyWav() });

  // mirror back to the MAIN window's store
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const pads = window.__synthstackStudio!.store.getState().sampler.pads;
        return (pads[0]?.sampleName ?? '').toLowerCase();
      }),
    )
    .toContain('snare.wav');
  // and the pop-out's own panel shows it too
  await expect
    .poll(async () => ((await popout.getByTestId('sampler-panel').textContent()) ?? '').toLowerCase())
    .toContain('snare.wav');

  // ---- d (part 2). EXACTLY ONE AudioContext across the two windows -----------------------
  // The main window powered one AudioContext; the pop-out powered none.
  const mainCtx = await page.evaluate(
    () => (window.__synthstackStudio as { powered?: boolean } | undefined)?.powered === true,
  );
  expect(mainCtx, 'main window owns the single AudioContext').toBe(true);

  expect(errors, 'no console errors during the pop-out flow').toEqual([]);
});
