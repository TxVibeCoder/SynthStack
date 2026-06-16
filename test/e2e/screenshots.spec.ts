/**
 * Visual capture helper — not an assertion suite. Run explicitly:
 *   npx playwright test screenshots --reporter=line
 * Writes the full 16:9 stage plus per-region PNGs to test-results/panels/
 * for layout/typography review.
 *
 * The captured regions are all ABOVE-the-fold console panels — the sampler/drum
 * section (below the fold) is NOT captured here, so there is no sampler-section
 * baseline to re-take when the pads gained the pre-loaded factory kit + per-pad KIT
 * buttons. The above-the-fold 16:9 stage stays pixel-identical (the kit pre-load +
 * the KIT pixels live below the fold; the picker menu portals to document.body only
 * when open). If a sampler-section capture is ever added, expect it to show the kit
 * names (KICK..PERC) and 8 KIT buttons rather than EMPTY pads.
 */

import { test } from '@playwright/test';

const REGION_TEST_IDS = [
  'tier-cascade',
  'tier-anvil',
  'tier-monarch',
  'tier-mixer',
  'seq-strip',
  'jack-field',
  'utility-strip',
  'future-strip',
];

test('capture stage + region screenshots', async ({ page }) => {
  // the 16:9 stage's design target (a 1080p viewport ≈ scale 1)
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/');
  await page.getByTestId('power').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'test-results/panels/stage-16x9.png' });
  for (const id of REGION_TEST_IDS) {
    await page.getByTestId(id).screenshot({ path: `test-results/panels/${id}.png` });
  }
});
