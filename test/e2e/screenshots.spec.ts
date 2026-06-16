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

// Region testids grouped by the tab they mount on (3-tab refactor). 'utility-strip' is
// the master ribbon (present on every tab); the studio control regions live on the
// 'studio' tab; the consolidated jack field (88 voice + 16 sampler jacks) lives on the
// 'patchbay' tab.
const STUDIO_TEST_IDS = [
  'tier-cascade',
  'tier-anvil',
  'tier-monarch',
  'tier-mixer',
  'seq-strip',
  'future-strip',
  'utility-strip',
];
const PATCHBAY_TEST_IDS = ['jack-field'];

test('capture stage + region screenshots', async ({ page }) => {
  // the 16:9 stage's design target (a 1080p viewport ≈ scale 1)
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/');
  await page.getByTestId('power').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'test-results/panels/stage-16x9.png' });
  for (const id of STUDIO_TEST_IDS) {
    await page.getByTestId(id).screenshot({ path: `test-results/panels/${id}.png` });
  }
  // switch to the Patchbay tab for the jack field
  await page.getByTestId('tab-patchbay').click();
  await page.waitForTimeout(300);
  for (const id of PATCHBAY_TEST_IDS) {
    await page.getByTestId(id).screenshot({ path: `test-results/panels/${id}.png` });
  }
});
