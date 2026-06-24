/**
 * Drives the fidelity MEASUREMENT battery headlessly (`npm run test:measure`, via
 * playwright.measure.config.ts on a dedicated port). The page renders real OfflineAudioContext +
 * worklet graphs and measures pitch / waveshape / filter against math-spec targets; this spec
 * collects the verdicts and prints the per-voice scorecard.
 */

import { expect, test } from '@playwright/test';

test('fidelity measurement battery passes', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/#/dev/measure');
  await expect(page.locator('[data-status="done"]')).toBeVisible({ timeout: 220_000 });
  const raw = await page.getByTestId('measure-results').textContent();
  const results = JSON.parse(raw ?? '[]') as { name: string; pass: boolean; detail: string }[];
  expect(results.length).toBeGreaterThan(0);
  // print the scorecard so the run output IS the fidelity report
  // eslint-disable-next-line no-console
  console.log('\n=== FIDELITY SCORECARD ===\n' + results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}\n      ${r.detail}`).join('\n') + '\n');
  const failures = results.filter((r) => !r.pass);
  expect(failures, failures.map((f) => `${f.name}: ${f.detail}`).join('\n')).toEqual([]);
});
