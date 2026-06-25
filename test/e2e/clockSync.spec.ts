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

/**
 * U2: the two deferred CV-rate jacks — ANV_TEMPO_IN (CV over Anvil step rate) and CAS_RHYTHM_n_IN
 * (CV over the Cascade RG dividers) — through the REAL production wiring path (bridge cables build
 * the cvTaps in Studio.rebuildFollowers; the synthstack-cv-sample worklet samples a live bus; the
 * per-pump sampleCvTaps folds it in). The constant CV SOURCE is ANV_PITCH_OUT: a ConstantSourceNode
 * holding the current Anvil step's pitch. We set step 1's pitch and fire a manual trigger to pin a
 * steady positive vv onto that bus, then verify the sampled value reaches rateHz / divisionCvVv and
 * that UNPLUGGING restores knob-only (no stranded CV offset).
 */
test('U2: CV into ANV_TEMPO_IN raises the Anvil step rate; unplugging restores knob-only', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.getByTestId('power').click();
  await page.waitForFunction(() => (window.__synthstackStudio as any)?.powered === true);

  const bridge = (fn: string, ...args: unknown[]) =>
    page.evaluate(([f, a]) => (window.__synthstackStudio as any)[f as string](...(a as unknown[])), [fn, args] as const);
  const rateHz = () =>
    page.evaluate(() => (window.__synthstackStudio as any).studioInstance.anvilSeq.rateHz as number);

  // Anvil knob TEMPO = 8 Hz (default). Pin a steady +2 vv onto ANV_PITCH_OUT (step 1's pitch, held
  // by the constant-source bus) and patch it into ANV_TEMPO_IN. +2 vv = ×4 the step rate → ~32 Hz.
  await bridge('applyControlCommit', 'anvil', 'ANV_TEMPO', 8);
  await bridge('applyControlCommit', 'anvil', 'ANV_SEQ_PITCH_1', 2);
  await bridge('anvilTrigger'); // pushes step-1 pitch onto the constant ANV_PITCH_OUT bus
  await bridge('commitCables', [{ id: 'cv1', from: 'ANV_PITCH_OUT', to: 'ANV_TEMPO_IN', color: '#fff' }]);

  // The per-pump sampler folds the sampled +2 vv into anvilStepRateHz(knob, cv) → ≈ 8 × 2^2 = 32.
  await expect.poll(rateHz, { timeout: 5000 }).toBeGreaterThan(20); // measurably above the 8 Hz knob-only rate

  // Unplug: the cvTap is torn down and the rate restores to the 8 Hz knob-only value (no strand).
  await bridge('commitCables', []);
  await expect.poll(rateHz, { timeout: 5000 }).toBeLessThan(12); // back to ~8 Hz knob-only
});

test('U2: CV into CAS_RHYTHM_1_IN shifts the RG divider; unplugging restores knob-only', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.getByTestId('power').click();
  await page.waitForFunction(() => (window.__synthstackStudio as any)?.powered === true);

  const bridge = (fn: string, ...args: unknown[]) =>
    page.evaluate(([f, a]) => (window.__synthstackStudio as any)[f as string](...(a as unknown[])), [fn, args] as const);
  const divCv0 = () =>
    page.evaluate(() => (window.__synthstackStudio as any).studioInstance.cascadeClock.divisionCvVv[0] as number);

  // Pin a steady +2 vv onto ANV_PITCH_OUT and patch it into CAS_RHYTHM_1_IN. The sampled CV rides
  // divisionCvVv[0] (which feeds effectiveDivision via cascadeRhythmDivision, clamped 1..16).
  await bridge('applyControlCommit', 'anvil', 'ANV_SEQ_PITCH_1', 2);
  await bridge('anvilTrigger');
  await bridge('commitCables', [{ id: 'cv2', from: 'ANV_PITCH_OUT', to: 'CAS_RHYTHM_1_IN', color: '#fff' }]);

  await expect.poll(divCv0, { timeout: 5000 }).toBeGreaterThan(1); // the sampled +2 vv reached the divider CV

  // Unplug: the offset is restored to 0 (knob-only divider; no stranded CV).
  await bridge('commitCables', []);
  await expect.poll(divCv0, { timeout: 5000 }).toBe(0);
});

/**
 * TASK 2: the external-clock measured-edge timestamp must PERSIST across an unrelated patch edit.
 * rebuildFollowers runs on every cable add/remove; before the fix it re-declared `let lastEdge = -1`
 * fresh each rebuild, so an unrelated edit while externally clocked reset the measured tick interval
 * and the next edge fell back to the internal stepDur for one step's gate spacing (a one-step
 * timing glitch). Now the timestamp lives on an instance field and is reset ONLY when the clock
 * SOURCE changes. We externally-clock the Courier from the running Monarch, let an edge or two land
 * (so courierClockLastEdge becomes a real positive timestamp), then make an UNRELATED edit and
 * assert the timestamp was NOT reset to -1.
 */
test('external-clock lastEdge survives an unrelated patch edit (no one-step interval glitch)', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.getByTestId('power').click();
  await page.waitForFunction(() => (window.__synthstackStudio as any)?.powered === true);

  const bridge = (fn: string, ...args: unknown[]) =>
    page.evaluate(([f, a]) => (window.__synthstackStudio as any)[f as string](...(a as unknown[])), [fn, args] as const);
  const courierLastEdge = () =>
    page.evaluate(() => (window.__synthstackStudio as any).studioInstance.courierClockLastEdge as number);

  // Monarch ASSIGN -> Courier CLOCK IN; run both so real edges advance courierClockLastEdge.
  await bridge('commitCables', [{ id: 'cc', from: 'MON_ASSIGN_OUT', to: 'COU_CLOCK_IN', color: '#fff' }]);
  await bridge('applyControlCommit', 'monarch', 'MON_TEMPO', 120);
  await bridge('courierRun');
  await bridge('monarchRun');
  await expect.poll(courierLastEdge).toBeGreaterThan(0); // a real measured edge has landed
  const before = await courierLastEdge();

  // UNRELATED edit: add a cable that has nothing to do with COU_CLOCK_IN. The CLOCK source is
  // unchanged, so the measured timestamp must be preserved (NOT reset to -1).
  await bridge('commitCables', [
    { id: 'cc', from: 'MON_ASSIGN_OUT', to: 'COU_CLOCK_IN', color: '#fff' },
    { id: 'x', from: 'MON_LFO_TRI_OUT', to: 'MON_VCF_CUTOFF_IN', color: '#fff' },
  ]);
  expect(await courierLastEdge()).toBeGreaterThanOrEqual(before); // preserved (advances or holds; never -1)

  // SOURCE change (swap the CLOCK source) DOES reset it to -1 (a new clock starts a fresh interval).
  await bridge('commitCables', [
    { id: 'cc2', from: 'CAS_CLOCK_OUT', to: 'COU_CLOCK_IN', color: '#fff' },
    { id: 'x', from: 'MON_LFO_TRI_OUT', to: 'MON_VCF_CUTOFF_IN', color: '#fff' },
  ]);
  expect(await courierLastEdge()).toBe(-1);

  await bridge('monarchStop');
  await bridge('courierStop');
});

/**
 * TASK 3 transport-gate jacks driven by a REAL gate signal through the production follower path.
 * The Monarch GATE OUT (+5/0 per-note gate) is the source: running the Monarch produces real rising
 * (note-on) and falling (note-off) edges that the synthstack-edge worklet delivers to the followed
 * transport. We assert the followed transport actually starts on a rising edge, and that unplugging
 * tears the follower down with no stranded state.
 */
test('ANV_RUN_STOP_IN and CAS_PLAY_IN start their transports on a real gate edge', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.getByTestId('power').click();
  await page.waitForFunction(() => (window.__synthstackStudio as any)?.powered === true);

  const bridge = (fn: string, ...args: unknown[]) =>
    page.evaluate(([f, a]) => (window.__synthstackStudio as any)[f as string](...(a as unknown[])), [fn, args] as const);
  const running = () =>
    page.evaluate(() => {
      const studio = (window.__synthstackStudio as any).studioInstance;
      return { anvil: studio.anvilSeq.running as boolean, cascade: studio.cascadeClock.running as boolean };
    });

  // MON_GATE_OUT -> ANV_RUN/STOP IN and -> CAS_PLAY IN (fan-out from one output is free). Neither the
  // Anvil seq nor the Cascade clock is running yet.
  await bridge('commitCables', [
    { id: 'g1', from: 'MON_GATE_OUT', to: 'ANV_RUN_STOP_IN', color: '#fff' },
    { id: 'g2', from: 'MON_GATE_OUT', to: 'CAS_PLAY_IN', color: '#fff' },
  ]);
  expect(await running()).toEqual({ anvil: false, cascade: false });

  // Run the Monarch: its per-note GATE edges drive both followers. The first rising edge (gateOn)
  // starts each followed transport (anvilSeq.start / cascadeClock.start).
  await bridge('applyControlCommit', 'monarch', 'MON_TEMPO', 120); // 8 steps/s -> gates ~every 125 ms
  await bridge('monarchRun');
  await expect.poll(() => running().then((r) => r.anvil)).toBe(true);
  await expect.poll(() => running().then((r) => r.cascade)).toBe(true);

  // Unplug both: the followers are torn down. The transports are LEFT as-is (a run-control cable
  // pull must not toggle the transport) — nothing strands, and no console error fires.
  await bridge('monarchStop');
  await bridge('commitCables', []);
  // A subsequent unrelated patch edit must rebuild cleanly (no throw, no stranded follower).
  await bridge('commitCables', [{ id: 'u', from: 'MON_LFO_TRI_OUT', to: 'MON_VCF_CUTOFF_IN', color: '#fff' }]);
});

/**
 * TASK 3: CAS_RESET_IN edge semantics through the real follower path. A rising edge calls
 * cascadeClock.reset(), which zeroes the tick counter. We let the Cascade tick well past zero, then
 * fire repeated real reset edges from the Monarch GATE OUT and confirm the tick counter is knocked
 * back down (it can never climb as high while resets keep landing). Comparing against the
 * un-clamped pre-reset tick keeps the assertion robust to live-edge timing.
 */
test('CAS_RESET_IN knocks the Cascade tick counter back down on real edges', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.getByTestId('power').click();
  await page.waitForFunction(() => (window.__synthstackStudio as any)?.powered === true);

  const bridge = (fn: string, ...args: unknown[]) =>
    page.evaluate(([f, a]) => (window.__synthstackStudio as any)[f as string](...(a as unknown[])), [fn, args] as const);
  const tickIndex = () =>
    page.evaluate(() => (window.__synthstackStudio as any).studioInstance.cascadeClock.currentTick as number);

  // Run the Cascade alone so its tick counter climbs well past step 1.
  await bridge('applyControlCommit', 'cascade', 'CAS_TEMPO', 20);
  await bridge('cascadePlay');
  await expect.poll(tickIndex).toBeGreaterThan(10);

  // Patch MON_GATE_OUT -> CAS_RESET_IN and run the Monarch faster than the Cascade so reset edges
  // land frequently. Each rising gate edge fires reset(), zeroing the tick counter — so the
  // observed tick can no longer climb past the small window between consecutive reset edges.
  await bridge('commitCables', [{ id: 'r', from: 'MON_GATE_OUT', to: 'CAS_RESET_IN', color: '#fff' }]);
  await bridge('applyControlCommit', 'monarch', 'MON_TEMPO', 240); // 16 gates/s -> frequent resets
  await bridge('monarchRun');
  await page.waitForTimeout(600); // let several reset edges land

  // The tick counter is repeatedly reset, so it stays small — far below where free-running at
  // 20 Hz for this long would have taken it. A generous bound proves the reset edges are landing.
  await expect.poll(tickIndex).toBeLessThan(10);

  await bridge('monarchStop');
  await bridge('cascadeStop');
});
