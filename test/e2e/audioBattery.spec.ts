/**
 * Drives the §13.2 offline-audio battery headlessly (`npm run test:audio`).
 * The page renders real OfflineAudioContext + worklet graphs; this spec just
 * collects the verdicts.
 */

import { expect, test } from '@playwright/test';

test('offline audio battery passes', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/#/dev/audio-tests');
  await expect(page.locator('[data-status="done"]')).toBeVisible({ timeout: 220_000 });
  const raw = await page.getByTestId('audio-results').textContent();
  const results = JSON.parse(raw ?? '[]') as { name: string; pass: boolean; detail: string }[];
  expect(results.length).toBeGreaterThan(0);
  const failures = results.filter((r) => !r.pass);
  expect(failures, failures.map((f) => `${f.name}: ${f.detail}`).join('\n')).toEqual([]);
});
