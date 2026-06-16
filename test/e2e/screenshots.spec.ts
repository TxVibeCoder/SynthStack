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

// Region testids grouped by the tab they mount on (per-voice tab restructure). The voices
// now each have their OWN tab, so the control regions are captured per-tab. 'utility-strip'
// (the master ribbon) + 'tier-mixer' (the ribbon's 4 channel faders) are chrome present on
// every tab; the consolidated jack field (88 voice + 16 sampler jacks) lives on 'patchbay'.
const CHROME_TEST_IDS = ['utility-strip', 'tier-mixer'];
const TAB_TEST_IDS: ReadonlyArray<{ tab: string; ids: readonly string[] }> = [
  { tab: 'tab-cascade', ids: ['tier-cascade'] },
  { tab: 'tab-anvil', ids: ['tier-anvil'] },
  { tab: 'tab-monarch', ids: ['tier-monarch', 'seq-strip', 'future-strip'] },
  { tab: 'tab-patchbay', ids: ['jack-field'] },
];

test('capture stage + region screenshots', async ({ page }) => {
  // the 16:9 stage's design target (a 1080p viewport ≈ scale 1)
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto('/');
  await page.getByTestId('power').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'test-results/panels/stage-16x9.png' });
  // chrome regions: present on every tab (default cascade tab is fine).
  for (const id of CHROME_TEST_IDS) {
    await page.getByTestId(id).screenshot({ path: `test-results/panels/${id}.png` });
  }
  // per-tab control/jack regions: switch to each owning tab before capturing.
  for (const { tab, ids } of TAB_TEST_IDS) {
    await page.getByTestId(tab).click();
    await page.waitForTimeout(300);
    for (const id of ids) {
      await page.getByTestId(id).screenshot({ path: `test-results/panels/${id}.png` });
    }
  }
});
