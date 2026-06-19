/**
 * Stage 2 e2e: cable patching + INIT (the UI half; the audio-level
 * wobble proof lands with the stage-3 offline battery).
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

test('patching: drag, fan-in rejection, removal, INIT reset', async ({ page }) => {
  // the 16:9 stage's design target — everything on screen, no scrolling
  await page.setViewportSize({ width: 1920, height: 1080 });
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.location().url.includes('favicon')) errors.push(msg.text());
  });

  await page.goto('/');
  await page.getByTestId('power').click();
  // All patching happens on the PATCHBAY tab: it is the only tab that mounts the
  // voice + sampler jacks AND the cable-chip / cable overlay in the 3-tab layout.
  await page.getByTestId('tab-patchbay').click();
  await expect(page.getByTestId('cable-chip')).toHaveText(/12\/12/);

  // 1. same-panel patch: LFO TRI out -> VCF CUTOFF in (the §8.3 wobble patch)
  await dragCable(page, 'MON_LFO_TRI_OUT', 'MON_VCF_CUTOFF_IN');
  await expect.poll(() => cables(page)).toHaveLength(1);
  expect((await cables(page))[0]).toMatchObject({ from: 'MON_LFO_TRI_OUT', to: 'MON_VCF_CUTOFF_IN' });
  await expect(page.getByTestId('cable-chip')).toHaveText(/11\/12/);
  expect(await page.locator('svg.cable-layer g').count()).toBeGreaterThan(0);

  // 2. occupied input rejects a second cable (one cable per input)
  await dragCable(page, 'MON_EG_OUT', 'MON_VCF_CUTOFF_IN');
  await expect.poll(() => cables(page)).toHaveLength(1);

  // 3. cross-module clock patch: Monarch ASSIGN -> Anvil ADV/CLOCK (§12.2 canonical)
  await dragCable(page, 'MON_ASSIGN_OUT', 'ANV_ADV_CLOCK_IN');
  await expect.poll(() => cables(page)).toHaveLength(2);

  // 4. invalid drop (output -> output) snaps back
  await dragCable(page, 'MON_NOISE_OUT', 'MON_VCA_OUT');
  await expect.poll(() => cables(page)).toHaveLength(2);

  // 5. click the second cable on its curve to remove it. The clickable stroke is a
  // sagging Bézier, so aim at B(0.5): midpoint + 0.75·sag below (cableGeometry math).
  const pa = await jackCenter(page, 'MON_ASSIGN_OUT');
  const pb = await jackCenter(page, 'ANV_ADV_CLOCK_IN');
  const sag = 0.15 * Math.hypot(pb.x - pa.x, pb.y - pa.y) + 30;
  await page.mouse.click((pa.x + pb.x) / 2, (pa.y + pb.y) / 2 + 0.75 * sag);
  await expect.poll(() => cables(page)).toHaveLength(1);
  await expect(page.getByTestId('cable-chip')).toHaveText(/11\/12/);

  // 6. click-to-arm, click-to-connect: no hold needed
  const egOut = await jackCenter(page, 'MON_EG_OUT');
  await page.mouse.click(egOut.x, egOut.y); // arms — cable now follows the cursor
  const vcaCv = await jackCenter(page, 'MON_VCA_CV_IN');
  await page.mouse.click(vcaCv.x, vcaCv.y); // completes
  await expect.poll(() => cables(page)).toHaveLength(2);
  expect((await cables(page))[1]).toMatchObject({ from: 'MON_EG_OUT', to: 'MON_VCA_CV_IN' });

  // 7. Esc abandons an armed cable
  const noiseOut = await jackCenter(page, 'MON_NOISE_OUT');
  // A patchbay point on no jack: the empty band BETWEEN the voice jack-field (its
  // bottom row) and the sampler jacks below it. (The old (960,1000) coord was empty
  // future-strip space in the 2-tab layout; under the 3-tab patchbay fill-zoom that
  // screen coord is no longer guaranteed empty, so derive a verified-empty point from
  // two real jack boxes — both are on screen, and their midpoint sits in the gap that
  // separates the voice patchbay zone from the sampler zone.)
  const monGate = await jackCenter(page, 'MON_GATE_OUT'); // bottom voice-jack row
  const sampOut = await jackCenter(page, 'SAMP_PAD1_OUT'); // first sampler jack, below
  const emptyGap = { x: monGate.x, y: (monGate.y + sampOut.y) / 2 };
  await page.mouse.click(noiseOut.x, noiseOut.y);
  await page.keyboard.press('Escape');
  await page.mouse.click(emptyGap.x, emptyGap.y); // empty space — must not connect anything
  await expect.poll(() => cables(page)).toHaveLength(2);

  // 8. clicking empty space cancels an armed cable
  await page.mouse.click(noiseOut.x, noiseOut.y);
  await page.mouse.click(emptyGap.x, emptyGap.y);
  await expect.poll(() => cables(page)).toHaveLength(2);

  // 9. INIT: turn a knob away from default, then double-click INIT.
  // The Monarch CUTOFF knob is a MONARCH-tab control (each voice has its own tab), so
  // switch to monarch to reach it (the cables/chip still live on patchbay and persist
  // across the tab switch — the store is the single source of truth, unaffected by which
  // tab is mounted).
  await page.getByTestId('tab-monarch').click();
  const knob = page.locator('[aria-label="CUTOFF"]').first();
  await knob.scrollIntoViewIfNeeded();
  const kb = (await knob.boundingBox())!;
  await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2);
  await page.mouse.down();
  await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2 - 40, { steps: 5 });
  await page.mouse.up();
  const turned = await page.evaluate(
    () => window.__synthstackStudio!.store.getState().controls['monarch']!['MON_VCF_CUTOFF'],
  );
  expect(turned).not.toBe(800);

  // INIT lives on the master ribbon (chrome on every tab), so the double-click works
  // from the monarch tab. The cable count drops in the store immediately.
  await page.getByTestId('init').dblclick();
  await expect.poll(() => cables(page)).toHaveLength(0);
  // The cable-chip only mounts on the patchbay tab, so switch back to read the 12/12.
  await page.getByTestId('tab-patchbay').click();
  await expect(page.getByTestId('cable-chip')).toHaveText(/12\/12/);
  const reset = await page.evaluate(
    () => window.__synthstackStudio!.store.getState().controls['monarch']!['MON_VCF_CUTOFF'],
  );
  expect(reset).toBe(800);

  expect(errors).toEqual([]);
});

test('unplugging the HOLD cable releases hold (no stranded freeze)', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('power').click();
  await page.waitForFunction(() => (window.__synthstackStudio as any)?.powered === true);

  const bridge = (fn: string, ...args: unknown[]) =>
    page.evaluate(([f, a]) => (window.__synthstackStudio as any)[f as string](...(a as unknown[])), [fn, args] as const);
  const holdActive = () =>
    page.evaluate(() => (window.__synthstackStudio as any).studioInstance.monarchSeq.holdActive as boolean);
  const setHold = (v: boolean) =>
    page.evaluate((on) => { (window.__synthstackStudio as any).studioInstance.monarchSeq.holdActive = on; }, v);

  // Patch a source into MON_HOLD_IN, then simulate that source having driven the gate HIGH.
  // (The real edge worklet sets holdActive from a >=2.5 vv source; we set it directly so the
  // assertion is deterministic and not tied to a live signal phase.)
  await bridge('commitCables', [{ id: 'h1', from: 'MON_ASSIGN_OUT', to: 'MON_HOLD_IN', color: '#fff' }]);
  await setHold(true);
  expect(await holdActive()).toBe(true);

  // UNPLUG: no cable = HOLD gate low = released. Before the fix this stranded holdActive=true
  // (the falling-edge follower is torn down with the cable) and froze the sequence on one step.
  await bridge('commitCables', []);
  expect(await holdActive()).toBe(false);

  // An UNRELATED patch edit must NOT clobber a panel-set HOLD (no HOLD cable was present, so
  // the release branch stays inert).
  await setHold(true);
  await bridge('commitCables', [{ id: 'x1', from: 'MON_LFO_TRI_OUT', to: 'MON_VCF_CUTOFF_IN', color: '#fff' }]);
  expect(await holdActive()).toBe(true);
});
