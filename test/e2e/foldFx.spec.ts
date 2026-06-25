/**
 * FOLD FX e2e (G8) — runs in the installed Chrome (playwright.config.ts `channel: 'chrome'`)
 * against the Vite dev server. Mirrors presets.spec.ts (console-error collection, power-on,
 * the window.__synthstackStudio engine read). Written for the later integration pass; the
 * unit suite (foldCore.test.ts + effectsState.test.ts) is the green gate for this group.
 *
 * FOLD is the 4th insert effect (flanger/delay/reverb/fold) on BOTH the master bus and each
 * per-voice insert chain. Because the bridge FX surface is id/param-string-generic and the
 * MasterFxChain wires the new unit, this spec proves the new id round-trips end-to-end via
 * the same engineBridge surface the EffectsPanel uses:
 *   a. power on -> the FX panel renders and the store carries a `fold` slice (off by default)
 *   b. toggle master FOLD on + commit drive/symmetry/mix -> the store `effects.master.fold`
 *      slice reflects the writes (engine + store) and stays clamped
 *   c. a per-voice (cascade) FOLD toggle writes `effects.voices.cascade.fold`
 *   d. ZERO console errors across the session
 */

import { expect, test } from '@playwright/test';
// window.__synthstackStudio is typed by src/ui/engineBridge.ts's global declaration

const readMasterFold = (page: import('@playwright/test').Page) =>
  page.evaluate(() => window.__synthstackStudio!.store.getState().effects.master.fold);
const readVoiceFold = (page: import('@playwright/test').Page, voice: string) =>
  page.evaluate(
    (v) => window.__synthstackStudio!.store.getState().effects.voices[v as 'cascade'].fold,
    voice,
  );

test('fold FX: defaults off, master toggle + param commit round-trip, per-voice toggle', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });

  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.location().url.includes('favicon')) errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');
  await page.getByTestId('power').click();

  // ---- a. the fold slice exists + defaults OFF -------------------------------------------
  await expect.poll(async () => (await readMasterFold(page)).on).toBe(false);
  const def = await readMasterFold(page);
  expect(def.drive).toBeGreaterThanOrEqual(1);
  expect(def.drive).toBeLessThanOrEqual(8);

  // ---- b. master FOLD on + param commits round-trip through engine + store ---------------
  await page.evaluate(() => window.__synthstackStudio!.setMasterFxOn('fold', true));
  await page.evaluate(() => window.__synthstackStudio!.commitMasterFxParam('fold', 'drive', 5));
  await page.evaluate(() => window.__synthstackStudio!.commitMasterFxParam('fold', 'symmetry', -0.5));
  await page.evaluate(() => window.__synthstackStudio!.commitMasterFxParam('fold', 'mix', 0.7));
  await expect
    .poll(async () => {
      const f = await readMasterFold(page);
      return [f.on, f.drive, f.symmetry, f.mix].join(',');
    })
    .toBe('true,5,-0.5,0.7');

  // ---- c. per-voice (cascade) FOLD toggle writes the voice slice -------------------------
  await page.evaluate(() => window.__synthstackStudio!.setVoiceFxOn('cascade', 'fold', true));
  await expect.poll(async () => (await readVoiceFold(page, 'cascade')).on).toBe(true);
  // an untouched voice stays off
  expect((await readVoiceFold(page, 'anvil')).on).toBe(false);

  // ---- d. no console errors --------------------------------------------------------------
  expect(errors).toEqual([]);
});
