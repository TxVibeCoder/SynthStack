/**
 * Browser smoke test — runs in the installed
 * Chrome (playwright.config.ts `channel: 'chrome'`; no downloaded browsers)
 * against the Vite dev server.
 *
 * One test, five assertions in sequence (console errors are
 * collected for the whole session so every later step is covered too):
 *   a. / loads with zero console errors
 *   b. POWER is visible; clicking it un-dims the rack and the AudioContext
 *      reaches 'running' within 5 s
 *   c. all three panels render — 88 jacks (Monarch 32 + Anvil 24 + Cascade 32)
 *   d. dragging the Monarch CUTOFF knob 40 px commits a changed store value
 *   e. RUN ALL plays 500 ms with no console errors, then STOP ALL
 *
 * The engine is reached through window.__synthstackStudio — the EngineBridge
 * singleton, globally typed in src/ui/engineBridge.ts. The AudioContext sits
 * behind the bridge's private `studioInstance` field; TS privacy is
 * compile-time only, so readAudioContextState() reaches through it at runtime
 * (the same pattern MixerPanel.readBaseLatencySec uses).
 */

import { expect, test } from '@playwright/test';

/**
 * Monarch 32 + Anvil 24 + Cascade 32 (data/*.json, schema-validated in test/unit), plus
 * the SAMPLER section's 16 rendered pad jacks (8 SAMP_PAD{n}_OUT + 8
 * SAMP_PAD{n}_TRIG_IN). The sampler def also carries SAMP_MIX_OUT, but the panel
 * wires that to mixer ch3 internally and does NOT render a jack circle for it,
 * so only 16 of the 17 SAMP_* jacks appear in the DOM.
 */
const JACK_COUNT = 32 + 24 + 32 + 16;

/** data/monarch.json MON_VCF_CUTOFF default (Hz) — the knob step d drags. */
const MON_CUTOFF_DEFAULT_HZ = 800;

/**
 * Runs INSIDE the page via page.evaluate — must stay self-contained (no outer
 * captures). `audioContext` is a throwing getter before power-on, hence the
 * try/catch around the optional chain.
 */
function readAudioContextState(): string {
  const bridge = window.__synthstackStudio as unknown as
    | { studioInstance?: { context?: { audioContext?: { state?: string } } } | null }
    | undefined;
  try {
    return bridge?.studioInstance?.context?.audioContext?.state ?? 'no-context';
  } catch {
    return 'no-context';
  }
}

test('studio smoke: load, power, panels, knob drag, run/stop all', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    // index.html ships no favicon; Chrome's automatic /favicon.ico probe 404s
    // against the dev server. Network noise, not an app error. The 404's URL
    // lives in msg.location().url ("Failed to load resource..."), not the text.
    if (msg.location().url.includes('favicon.ico')) return;
    consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));

  const expectNoErrors = (when: string) => {
    expect(consoleErrors, `console errors ${when}:\n${consoleErrors.join('\n')}`).toEqual([]);
    expect(pageErrors, `uncaught page errors ${when}:\n${pageErrors.join('\n')}`).toEqual([]);
  };

  // ---- a. page loads at / with zero console errors --------------------------------
  await page.goto('/');
  await expect(page.locator('main.rack')).toBeVisible();
  expectNoErrors('after load');

  // ---- b. POWER visible → click → rack un-dims, AudioContext 'running' ≤ 5 s ------
  const power = page.getByTestId('power');
  await expect(power).toBeVisible();
  await power.click();
  for (const tier of ['tier-cascade', 'tier-anvil', 'tier-monarch', 'tier-mixer']) {
    await expect(page.getByTestId(tier)).not.toHaveClass(/\bunpowered\b/);
  }
  await expect
    .poll(() => page.evaluate(readAudioContextState), {
      timeout: 5_000,
      message: "AudioContext should reach 'running' within 5 s of the POWER click",
    })
    .toBe('running');

  // ---- c. all panels render their jacks: 104 (88 console + 16 sampler) -------------
  // Jack.tsx intentionally carries data-jack-id on BOTH the <g> and its hit
  // circle (stage-2 CableLayer contract), so "[data-jack-id] elements" are
  // counted as one hit circle per jack plus one distinct id per jack.
  await expect(page.locator('circle[data-jack-id]')).toHaveCount(JACK_COUNT);
  const uniqueJackIds = await page.evaluate(
    () =>
      new Set(
        Array.from(document.querySelectorAll('[data-jack-id]'), (el) =>
          el.getAttribute('data-jack-id'),
        ),
      ).size,
  );
  expect(uniqueJackIds, 'distinct data-jack-id values across all panels').toBe(JACK_COUNT);

  // ---- d. drag the Monarch CUTOFF knob 40 px up; the store value must change ----------
  const before = await page.evaluate(
    () => window.__synthstackStudio?.store.getControl('monarch', 'MON_VCF_CUTOFF') ?? null,
  );
  const knob = page.getByTestId('tier-monarch').locator('[role="slider"][aria-label="CUTOFF"]');
  await expect(knob).toBeVisible();
  // The Monarch tier sits below the fold at the default viewport; raw page.mouse
  // calls do NOT auto-scroll the way locator.click does, so bring it on screen
  // first (boundingBox is viewport-relative — read it after the scroll).
  await knob.scrollIntoViewIfNeeded();
  const box = await knob.boundingBox();
  if (!box) throw new Error('Monarch CUTOFF knob has no bounding box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy - 40, { steps: 8 }); // up = increase (CONVENTIONS.md)
  await page.mouse.up(); // release → onCommit → one store write
  const after = await page.evaluate(
    () => window.__synthstackStudio?.store.getControl('monarch', 'MON_VCF_CUTOFF') ?? null,
  );
  expect(typeof after, 'release should commit a numeric CUTOFF value to the store').toBe('number');
  expect(after).not.toBe(before);
  // store starts empty (defaults live in the JSON), so before is null on a fresh page
  expect(after as number).toBeGreaterThan(
    typeof before === 'number' ? before : MON_CUTOFF_DEFAULT_HZ,
  );

  // ---- e. RUN ALL → 500 ms, no console errors → STOP ALL --------------------------
  await page.locator('[role="button"][aria-label^="RUN ALL"]').click();
  await page.waitForTimeout(500);
  expectNoErrors('while all transports run');
  const running = await page.evaluate(() => window.__synthstackStudio?.getTransportFlags() ?? null);
  expect(running, 'all three transports should run after RUN ALL').toEqual({
    monarchRunning: true,
    anvilRunning: true,
    cascadePlaying: true,
    // drumRunning is independent of RUN ALL (DECISION 6): RUN ALL never starts the drum grid.
    drumRunning: false,
  });
  await page.locator('[role="button"][aria-label^="STOP ALL"]').click();
  const stopped = await page.evaluate(() => window.__synthstackStudio?.getTransportFlags() ?? null);
  expect(stopped, 'STOP ALL should halt all three transports').toEqual({
    monarchRunning: false,
    anvilRunning: false,
    cascadePlaying: false,
    drumRunning: false,
  });
  expectNoErrors('at the end of the smoke run');
});
