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
  await page.mouse.click(noiseOut.x, noiseOut.y);
  await page.keyboard.press('Escape');
  await page.mouse.click(960, 1000); // empty space (future strip) — must not connect anything
  await expect.poll(() => cables(page)).toHaveLength(2);

  // 8. clicking empty space cancels an armed cable
  await page.mouse.click(noiseOut.x, noiseOut.y);
  await page.mouse.click(960, 1000);
  await expect.poll(() => cables(page)).toHaveLength(2);

  // 9. INIT: turn a knob away from default, then double-click INIT
  const cutoff = await jackCenter(page, 'MON_VCF_CUTOFF_IN'); // scrolls Monarch into view
  void cutoff;
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

  await page.getByTestId('init').dblclick();
  await expect.poll(() => cables(page)).toHaveLength(0);
  await expect(page.getByTestId('cable-chip')).toHaveText(/12\/12/);
  const reset = await page.evaluate(
    () => window.__synthstackStudio!.store.getState().controls['monarch']!['MON_VCF_CUTOFF'],
  );
  expect(reset).toBe(800);

  expect(errors).toEqual([]);
});
