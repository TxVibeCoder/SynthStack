/**
 * Presets + Save/Load e2e (feature-sampler-pads) — runs in the
 * installed Chrome (playwright.config.ts `channel: 'chrome'`; no downloaded
 * browsers) against the Vite dev server. Mirrors recording.spec.ts /
 * keyboard.spec.ts / drumMachine.spec.ts (console-error collection, power-on,
 * testid assertions, the window.__synthstackStudio engine read).
 *
 * PRESETS + SAVE are the two formerly-dimmed utility-strip caps (UtilityStrip.tsx)
 * gone LIVE: SAVE opens the picker overlay focused on the name input; PRESETS opens
 * it on the factory/slots list. The overlay (PresetPicker.tsx) is rendered as a
 * SIBLING of .stage-viewport, OUTSIDE the transform:scale <main> (App.tsx), so it
 * is screen-pixel-sized chrome and the 16:9 console is pixel-identical at rest.
 *
 * A preset is a coalesced StudioState snapshot. Local SLOTS persist in localStorage
 * (StudioState only; user sample bytes stay in IndexedDB locally). FACTORY presets
 * are hand-authored recipes shipped as data (g1 factoryPresets.ts). Every load path
 * funnels through resetAll (clean-slate INIT) then the shared applyFullState
 * re-apply (controls/cables/mixer/transport/sampler/keyboard) then an awaited
 * reloadPadBuffers — so EVERY feature restores.
 *
 * This spec proves the g1->g5 wiring end-to-end:
 *   a. power on -> the 16:9 console testids are present and the overlay is UNMOUNTED
 *      at rest (pixel-stable); the PRESETS + SAVE caps render in the utility strip
 *   b. click SAVE -> the overlay opens (role=dialog) with the name input focused;
 *      type a name + click preset-save-confirm -> preset-status reads "Saved" and
 *      the slot appears in YOUR SETUPS; close the overlay
 *   c. tweak a control to a DIFFERENT value, then click PRESETS -> the overlay lists
 *      the saved slot + the 4 factory presets; loading the slot RESTORES the control
 *      (the saved snapshot wins over the live tweak) and closes the overlay
 *   d. reopen PRESETS, click a factory-preset row -> the overlay closes and a known
 *      control reflects the recipe via window.__synthstackStudio.store.getState()
 *   e. reopen PRESETS, inline two-step-confirm delete the slot -> its row is gone
 *   f. ZERO console errors across the whole session; the overlay is unmounted at rest
 *
 * The existing smoke/patch/clock/sampler/drum/keyboard/recording/screenshots e2e +
 * the audio battery must still pass unchanged — presets are purely additive (the
 * only at-rest stage delta is the two caps going opacity 0.4 -> 1.0; the overlay
 * mounts only when opened).
 */

import { expect, test } from '@playwright/test';
// window.__synthstackStudio is typed by src/ui/engineBridge.ts's global declaration

// A distinctive control value to round-trip through a saved slot. MON_TEMPO is a
// plain knob (BPM 20..300) committed via applyControlCommit (engine + store), read
// back from state.controls.monarch — no clamping surprises at these in-range values.
const SAVED_TEMPO = 142;
const TWEAKED_TEMPO = 96;

/** A known factory-preset id (g1 factoryPresets.ts — Cellar Door sets MON_TEMPO 124). */
const FACTORY_ID = 'factory-preset-cellar-door';
const FACTORY_TEMPO = 124;

const SLOT_NAME = 'My E2E Setup';

/** Read an Monarch control value straight off the store (JSON round-trips). */
const monarchControl = (page: import('@playwright/test').Page, id: string) =>
  page.evaluate(
    (controlId) =>
      window.__synthstackStudio!.store.getState().controls.monarch?.[controlId] as number | undefined,
    id,
  );

test('presets: save a slot, tweak + restore it, load a factory preset, delete the slot', async ({
  page,
}) => {
  // the 16:9 stage's design target — the console (incl. the utility strip with the
  // PRESETS + SAVE caps) fills the viewport; only the sampler/drum section scrolls.
  await page.setViewportSize({ width: 1920, height: 1080 });

  const errors: string[] = [];
  page.on('console', (msg) => {
    // index.html ships no favicon; Chrome's /favicon.ico probe 404s against the dev
    // server — network noise, not an app error (same filter as smoke.spec).
    if (msg.type() === 'error' && !msg.location().url.includes('favicon')) errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');
  // hermetic: clear any slots a prior run left in this origin's localStorage so the
  // YOUR SETUPS list starts empty (slots are the FIRST localStorage consumer in src).
  await page.evaluate(() => {
    try {
      const keys: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('synthstack-preset:')) keys.push(k);
      }
      for (const k of keys) localStorage.removeItem(k);
    } catch {
      /* localStorage absent — nothing to clear */
    }
  });

  await page.getByTestId('power').click();

  // ---- a. console present, overlay unmounted at rest, the two caps render ------------
  for (const tier of ['tier-cascade', 'tier-anvil', 'tier-monarch', 'tier-mixer']) {
    await expect(page.getByTestId(tier)).toBeVisible();
  }
  const strip = page.getByTestId('utility-strip');
  await expect(strip).toBeVisible();
  await expect(strip.getByTestId('presets')).toBeVisible();
  await expect(strip.getByTestId('save')).toBeVisible();
  // the overlay is conditionally rendered — absent from the DOM until a cap opens it.
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // seed a known, in-range control value into the LIVE setup that the slot captures.
  await page.evaluate(
    (v) => window.__synthstackStudio!.applyControlCommit('monarch', 'MON_TEMPO', v),
    SAVED_TEMPO,
  );
  await expect.poll(() => monarchControl(page, 'MON_TEMPO')).toBe(SAVED_TEMPO);

  // ---- b. SAVE cap -> overlay opens (name input focused) -> save the slot -----------
  await strip.getByTestId('save').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // mode='save' autofocuses the name input.
  const nameInput = page.getByTestId('preset-name-input');
  await expect(nameInput).toBeFocused();
  await nameInput.fill(SLOT_NAME);
  await page.getByTestId('preset-save-confirm').click();
  // the inline status line reports the save (no window.alert).
  await expect(page.getByTestId('preset-status')).toContainText(/saved/i);
  // the slot now appears in YOUR SETUPS (manual re-read — slots live in localStorage).
  await expect(page.getByTestId(`slot-${SLOT_NAME}`)).toBeVisible();
  // close the overlay (Esc) -> it unmounts.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // ---- c. tweak the control, then PRESETS -> load the slot -> control RESTORES -------
  await page.evaluate(
    (v) => window.__synthstackStudio!.applyControlCommit('monarch', 'MON_TEMPO', v),
    TWEAKED_TEMPO,
  );
  await expect.poll(() => monarchControl(page, 'MON_TEMPO')).toBe(TWEAKED_TEMPO);

  await strip.getByTestId('presets').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  // the saved slot + the 4 factory presets are listed.
  await expect(page.getByTestId(`slot-${SLOT_NAME}`)).toBeVisible();
  await expect(page.getByTestId(`factory-preset-${FACTORY_ID}`)).toBeVisible();
  // loading the slot restores the SAVED value (the snapshot wins over the live tweak)
  // and closes the overlay.
  await page.getByTestId(`slot-${SLOT_NAME}`).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => monarchControl(page, 'MON_TEMPO')).toBe(SAVED_TEMPO);

  // ---- d. load a FACTORY preset -> a known control reflects the recipe --------------
  await strip.getByTestId('presets').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByTestId(`factory-preset-${FACTORY_ID}`).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // Cellar Door sets MON_TEMPO 124 (a verified in-range recipe value).
  await expect.poll(() => monarchControl(page, 'MON_TEMPO')).toBe(FACTORY_TEMPO);
  // a factory load never spontaneously sounds: all transport flags stay false.
  const flagsAllFalse = await page.evaluate(() => {
    const t = window.__synthstackStudio!.store.getState().transport;
    return t.monarch.running === false && t.anvil.running === false && t.cascade.playing === false;
  });
  expect(flagsAllFalse, 'a loaded factory preset leaves all transports stopped').toBe(true);

  // ---- e. inline two-step-confirm delete the slot -> its row is gone -----------------
  await strip.getByTestId('presets').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByTestId(`slot-${SLOT_NAME}`)).toBeVisible();
  // first click ARMS the confirm; second click within the row deletes (no window.confirm).
  await page.getByTestId(`slot-delete-${SLOT_NAME}`).click();
  await page.getByTestId(`slot-delete-${SLOT_NAME}`).click();
  // the row is removed in place (manual re-read of listSlots) — overlay stays open.
  await expect(page.getByTestId(`slot-${SLOT_NAME}`)).toHaveCount(0);
  await expect(page.getByRole('dialog')).toBeVisible();
  // close out.
  await page.getByTestId('preset-close').click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // ---- f. zero console errors; the overlay is unmounted at rest ----------------------
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(errors, `console/page errors during the presets run:\n${errors.join('\n')}`).toEqual([]);
});
