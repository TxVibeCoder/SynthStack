/**
 * Factory kit e2e (feature-sampler-pads) — runs in the installed
 * Chrome (playwright.config.ts `channel: 'chrome'`; no downloaded browsers)
 * against the Vite dev server. Mirrors sampler.spec.ts / drumMachine.spec.ts
 * (console-error collection, power-on, scroll idiom, the window.__synthstackStudio
 * engine read).
 *
 * The 8 sampler pads now ship PRE-LOADED with a playable factory kit — the
 * FACTORY_KIT manifest (src/engine/factorySamples.ts) is the ONE source of truth
 * (Kick / Snare / Clap / Closed Hat / Open Hat / Low Tom / Rim / Perc; pad index =
 * kit index). defaultSamplerState() seeds pad t with FACTORY_KIT[t]; powerOn renders
 * + registers the buffers (loadFactorySamples) then resolves them onto the pads
 * (reloadPadBuffers); INIT (engineBridge.resetAll) clears + reloads the kit. A small
 * per-pad KIT picker (pad-${i}-kit → a listbox of the 8 names → assignFactoryToPad)
 * lets any pad be re-pointed at any factory sound; a drag-drop / LOAD user file still
 * overrides it (last-action-wins).
 *
 * This spec proves the g1->g5 wiring end-to-end (on the SAMPLER tab, where the pads
 * live in the 3-tab layout):
 *   a. power on -> the 8 pads come PRE-LOADED with the factory kit names on first
 *      load (no pad reads EMPTY); each pad-i meta carries its FACTORY_KIT[i] id/name
 *   b. open pad-0's KIT picker and pick a DIFFERENT factory sound (Snare) -> the pad
 *      meta flips to 'factory-snare'/'Snare' (assignFactoryToPad) and the name label
 *      re-renders; the menu closes
 *   c. INIT (double-click) RESTORES the whole kit -> pad-0 returns to the factory Kick
 *   d. ZERO console errors across the session; the picker menu is unmounted at rest
 *
 * The pads + KIT pixels live on the SAMPLER tab (the menu portals to document.body
 * only when open). The existing smoke/patch/clock/sampler/drum/keyboard/recording/
 * presets/screenshots e2e + the audio battery still pass — the factory kit is additive.
 */

import { expect, test, type Page } from '@playwright/test';
// window.__synthstackStudio is typed by src/ui/engineBridge.ts's global declaration

/**
 * The factory kit manifest, mirrored here as the e2e contract (the source of truth
 * is FACTORY_KIT in src/engine/factorySamples.ts; index = pad index = render order).
 * Kept literal so the spec needs no app import (Playwright runs in Node).
 */
const FACTORY_KIT: ReadonlyArray<{ id: string; name: string }> = [
  { id: 'factory-kick', name: 'Kick' },
  { id: 'factory-snare', name: 'Snare' },
  { id: 'factory-clap', name: 'Clap' },
  { id: 'factory-hat-closed', name: 'Closed Hat' },
  { id: 'factory-hat-open', name: 'Open Hat' },
  { id: 'factory-tom', name: 'Low Tom' },
  { id: 'factory-rim', name: 'Rim' },
  { id: 'factory-perc', name: 'Perc' },
];

/** Read a pad's persisted meta straight off the bridge (JSON round-trips). */
const padMeta = (page: Page, padIndex: number) =>
  page.evaluate((i) => {
    const p = window.__synthstackStudio!.getPadState(i);
    return { sampleId: p.sampleId, sampleName: p.sampleName };
  }, padIndex);

test('factory kit: pads pre-load on power-on, the KIT picker re-points a pad, INIT restores the kit', async ({
  page,
}) => {
  // the 16:9 stage's design target — the sampler section (the pre-loaded pads + KIT
  // buttons) lives on the SAMPLER tab and fill-zooms into view when that tab is active.
  await page.setViewportSize({ width: 1920, height: 1080 });
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.location().url.includes('favicon')) errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');
  await page.getByTestId('power').click();

  // ---- a. the 8 pads come PRE-LOADED with the factory kit on first power-on --------
  // switch to the SAMPLER tab (the pads + KIT pickers live there in the 3-tab layout,
  // fill-zoomed into view); the pads resolve their factory buffers on first power-on.
  await page.getByTestId('tab-sampler').click();
  await expect(page.getByTestId('sampler-panel')).toBeVisible();
  await expect(page.getByTestId('pad-0')).toBeVisible();

  // no pad reads EMPTY — every pad carries its FACTORY_KIT entry (name + id). The
  // panel renders names UPPER-CASED (SamplerPanel name.toUpperCase()), so match the
  // label case-insensitively; assert the persisted meta exactly.
  await expect(page.getByTestId('sampler-panel')).not.toContainText('EMPTY');
  for (let i = 0; i < FACTORY_KIT.length; i++) {
    const entry = FACTORY_KIT[i]!;
    await expect.poll(() => padMeta(page, i)).toEqual({
      sampleId: entry.id,
      sampleName: entry.name,
    });
    await expect(page.getByTestId('sampler-panel')).toContainText(entry.name.toUpperCase());
  }

  // ---- b. open pad-0's KIT picker and pick a DIFFERENT factory sound (Snare) -------
  // the menu is unmounted at rest; clicking the per-pad KIT trigger opens it.
  await expect(page.getByTestId('pad-0-kit')).toBeVisible();
  await page.getByTestId('pad-0-kit').click();

  // the listbox portals to document.body and lists the 8 FACTORY_KIT rows; pick Snare.
  const snare = FACTORY_KIT[1]!; // factory-snare / Snare
  const snareRow = page.getByTestId(`pad-kit-option-${snare.id}`);
  await expect(snareRow).toBeVisible();
  await snareRow.click();

  // assignFactoryToPad flips pad-0's persisted meta + the name label re-renders; the
  // menu closes (its row is gone from the DOM). The persisted-meta poll is the
  // authoritative check — a panel-wide text match would be ambiguous (the kit names
  // repeat across the 8 pads), so assert pad-0's meta exactly.
  await expect.poll(() => padMeta(page, 0)).toEqual({
    sampleId: snare.id,
    sampleName: snare.name,
  });
  await expect(page.getByTestId(`pad-kit-option-${snare.id}`)).toHaveCount(0);

  // ---- c. INIT (double-click) RESTORES the whole factory kit ----------------------
  // resetAll clears the pad buffers then reloads defaultStudioState().sampler (which
  // carries the 8 factory ids), so pad-0 returns to the factory Kick. Re-check every
  // pad's meta so the restore proves the FULL kit, not just pad-0.
  await page.getByTestId('init').dblclick();
  for (let i = 0; i < FACTORY_KIT.length; i++) {
    const entry = FACTORY_KIT[i]!;
    await expect.poll(() => padMeta(page, i)).toEqual({
      sampleId: entry.id,
      sampleName: entry.name,
    });
  }

  // ---- d. zero console errors across the session ----------------------------------
  expect(errors).toEqual([]);
});

/**
 * G6 — the global KIT-SELECT dropdown re-points all 8 pads at once. The kit library
 * (KIT_LIBRARY in src/engine/factorySamples.ts) ships the default 'Studio' kit plus
 * extra synthesized kits ('Cellar', 'Glass'); selecting a kit flips every pad's meta to
 * that kit's 8 sounds. The per-pad picker then lists the CURRENT kit's sounds, and a
 * per-pad override after a kit-select still wins (last-action-wins). INIT restores the
 * default kit + selection.
 */
test('G6 kit-select: choosing a kit re-points all 8 pads; INIT restores the default kit', async ({
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
  await page.getByTestId('tab-sampler').click();
  await expect(page.getByTestId('sampler-panel')).toBeVisible();
  await expect(page.getByTestId('pad-0')).toBeVisible();

  // ---- the default kit's selection + pad-0 meta on first power-on -------------------
  const kitId = () => page.evaluate(() => window.__synthstackStudio!.getKitId());
  const defaultKitId = await kitId();
  await expect.poll(() => padMeta(page, 0)).toEqual({
    sampleId: FACTORY_KIT[0]!.id,
    sampleName: FACTORY_KIT[0]!.name,
  });

  // ---- open the global KIT-SELECT and pick a NON-default kit ------------------------
  await expect(page.getByTestId('kit-select')).toBeVisible();
  await page.getByTestId('kit-select').click();
  const menu = page.getByTestId('kit-select-menu');
  await expect(menu).toBeVisible();
  // pick the first option whose kit id differs from the default. NOTE: a `hasNot`
  // filter does NOT work here — an option element is not its own descendant, so it
  // would never exclude the default option (it would pick the default = a no-op).
  // A CSS :not() on the testid excludes the default option element itself.
  const otherOption = menu.locator(
    `[data-testid^="kit-select-option-"]:not([data-testid="kit-select-option-${defaultKitId}"])`,
  );
  const chosenTestId = await otherOption.first().getAttribute('data-testid');
  const chosenKitId = chosenTestId!.replace('kit-select-option-', '');
  await otherOption.first().click();

  // ---- all 8 pad metas flip to the chosen kit's sounds; kitId persists --------------
  await expect.poll(() => kitId()).toBe(chosenKitId);
  // every pad now carries a NON-default sound (its sampleId changed from the default kit's)
  for (let i = 0; i < 8; i++) {
    await expect
      .poll(() => padMeta(page, i).then((m) => m.sampleId))
      .not.toBe(FACTORY_KIT[i]!.id);
  }

  // ---- per-pad override after a kit-select still wins (last-action-wins) ------------
  // open pad-0's per-pad KIT picker (now lists the CHOSEN kit's sounds) and pick a row.
  await page.getByTestId('pad-0-kit').click();
  const padMenu = page.getByTestId('pad-0-kit-menu');
  await expect(padMenu).toBeVisible();
  const padOption = padMenu.locator('[data-testid^="pad-kit-option-"]').first();
  const padOptId = (await padOption.getAttribute('data-testid'))!.replace('pad-kit-option-', '');
  await padOption.click();
  await expect.poll(() => padMeta(page, 0).then((m) => m.sampleId)).toBe(padOptId);
  // the kit selection itself is unchanged by a per-pad override
  await expect.poll(() => kitId()).toBe(chosenKitId);

  // ---- INIT restores the default kit + selection -----------------------------------
  await page.getByTestId('init').dblclick();
  await expect.poll(() => kitId()).toBe(defaultKitId);
  for (let i = 0; i < FACTORY_KIT.length; i++) {
    await expect.poll(() => padMeta(page, i)).toEqual({
      sampleId: FACTORY_KIT[i]!.id,
      sampleName: FACTORY_KIT[i]!.name,
    });
  }

  expect(errors).toEqual([]);
});
