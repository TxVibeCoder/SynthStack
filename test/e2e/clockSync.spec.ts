/**
 * Realtime clock-sync verification against the REAL studio:
 * cables patched through the bridge build the followers in Studio.rebuildFollowers,
 * transports run on the live AudioContext, and we count steps on both sides.
 * (Sample-level skew is proven offline in the audio battery; this proves the
 * production wiring path end-to-end.)
 */

import { expect, test, type Page } from '@playwright/test';

/* eslint-disable @typescript-eslint/no-explicit-any */
const readSteps = (page: Page) =>
  page.evaluate(() => {
    const studio = (window.__synthstackStudio as any).studioInstance;
    return {
      monarch: studio.monarchSeq.currentStep as number,
      anvil: studio.anvilSeq.currentStep as number,
      cascade2: studio.cascadeClock.steps[1] as number,
    };
  });

/** Total forward steps over a polling window, wrap-aware. */
async function countAdvances(page: Page, ms: number, wraps: { monarch: number; anvil: number; cascade2: number }) {
  const sums = { monarch: 0, anvil: 0, cascade2: 0 };
  let prev = await readSteps(page);
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await page.waitForTimeout(150);
    const cur = await readSteps(page);
    for (const k of ['monarch', 'anvil', 'cascade2'] as const) {
      sums[k] += (cur[k] - prev[k] + wraps[k]) % wraps[k];
    }
    prev = cur;
  }
  return sums;
}

test('cross-module clock patches and TEMPO LINK sync as specified', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByTestId('power').click();
  await page.waitForFunction(() => (window.__synthstackStudio as any)?.powered === true);

  const bridge = (fn: string, ...args: unknown[]) =>
    page.evaluate(([f, a]) => (window.__synthstackStudio as any)[f as string](...(a as unknown[])), [fn, args] as const);

  // ---- 1. Monarch ASSIGN -> Anvil ADV/CLOCK: 1 Anvil advance per Monarch step ----------------
  await bridge('commitCables', [
    { id: 'c1', from: 'MON_ASSIGN_OUT', to: 'ANV_ADV_CLOCK_IN', color: '#fff' },
  ]);
  await bridge('applyControlCommit', 'monarch', 'MON_TEMPO', 120); // 8 steps/s
  await bridge('monarchRun');
  await page.waitForTimeout(400); // let the lookahead settle
  const a = await countAdvances(page, 3000, { monarch: 16, anvil: 8, cascade2: 4 });
  await bridge('monarchStop');
  expect(a.monarch).toBeGreaterThan(15); // it actually ran
  expect(Math.abs(a.anvil - a.monarch)).toBeLessThanOrEqual(2); // 1:1 lock (± polling edges)

  // ---- 2. Cascade SEQ 2 CLK -> Anvil ADV/CLOCK: polyrhythmic clocking -------------------
  await bridge('commitCables', [
    { id: 'c2', from: 'CAS_SEQ2_CLK_OUT', to: 'ANV_ADV_CLOCK_IN', color: '#fff' },
  ]);
  await bridge('applyControlCommit', 'cascade', 'CAS_TEMPO', 8); // ticks at 8 Hz
  await bridge('cascadePlay');
  await page.waitForTimeout(400);
  const b = await countAdvances(page, 3000, { monarch: 16, anvil: 8, cascade2: 4 });
  await bridge('cascadeStop');
  expect(b.cascade2).toBeGreaterThan(8); // seq 2 advanced (RG2 default ÷2 of 8 Hz)
  expect(Math.abs(b.anvil - b.cascade2)).toBeLessThanOrEqual(2); // Anvil follows seq 2 exactly

  // ---- 3. TEMPO LINK: Anvil rate + Cascade tick rate slaved to Monarch BPM ------------------
  await bridge('commitCables', []);
  await bridge('setTempoLink', true);
  await bridge('applyControlCommit', 'monarch', 'MON_TEMPO', 240);
  const rates = await page.evaluate(() => {
    const studio = (window.__synthstackStudio as any).studioInstance;
    return { anvilHz: studio.anvilSeq.rateHz as number, cascadeHz: studio.cascadeClock.tempoHz as number };
  });
  expect(rates.anvilHz).toBeCloseTo((240 / 60) * 4, 5); // 16 steps/s (16ths)
  expect(rates.cascadeHz).toBeCloseTo(240 / 60, 5); // 4 Hz (1 PPQ)
});

/**
 * Courier external CLOCK IN end-to-end: a cable in COU_CLOCK_IN flips the Courier sequencer into
 * external-clock mode (internal lookahead suppressed) and steps it one step per source edge. Same
 * production path as the Anvil/Cascade/Monarch clock-ins above, through the real bridge + AudioContext.
 */
test('external CLOCK IN drives the Courier sequencer 1:1 with the source', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.getByTestId('power').click();
  await page.waitForFunction(() => (window.__synthstackStudio as any)?.powered === true);

  const bridge = (fn: string, ...args: unknown[]) =>
    page.evaluate(([f, a]) => (window.__synthstackStudio as any)[f as string](...(a as unknown[])), [fn, args] as const);

  const readPair = () =>
    page.evaluate(() => {
      const studio = (window.__synthstackStudio as any).studioInstance;
      return {
        monarch: studio.monarchSeq.currentStep as number,
        courier: studio.courierSeq.currentStep as number,
        courierExternal: studio.courierSeq.externalClock as boolean,
      };
    });

  // Monarch ASSIGN -> Courier CLOCK IN: one Courier step per Monarch step (mirrors the proven
  // Monarch ASSIGN -> Anvil ADV/CLOCK lock in test 1, exercising the COU_CLOCK_IN follower).
  await bridge('commitCables', [{ id: 'cc1', from: 'MON_ASSIGN_OUT', to: 'COU_CLOCK_IN', color: '#fff' }]);
  expect((await readPair()).courierExternal).toBe(true); // the cable flipped Courier to external clock

  await bridge('applyControlCommit', 'monarch', 'MON_TEMPO', 120); // 8 steps/s
  await bridge('courierRun'); // engage Courier — internal lookahead stays suppressed while clocked
  await bridge('monarchRun');
  await page.waitForTimeout(400); // let the lookahead settle

  // wrap-aware advance count over a 3 s window (both default to endStep 16).
  const sums = { monarch: 0, courier: 0 };
  let prev = await readPair();
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    await page.waitForTimeout(150);
    const cur = await readPair();
    sums.monarch += (cur.monarch - prev.monarch + 16) % 16;
    sums.courier += (cur.courier - prev.courier + 16) % 16;
    prev = cur;
  }
  await bridge('monarchStop');
  await bridge('courierStop');

  expect(sums.monarch).toBeGreaterThan(15); // the source actually ran
  expect(Math.abs(sums.courier - sums.monarch)).toBeLessThanOrEqual(2); // 1:1 lock (± polling edges)
});
