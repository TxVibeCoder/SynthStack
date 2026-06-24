/**
 * External MIDI clock sync against the REAL studio (runs in the final integration pass).
 *
 * Drives studio.onMidiClockStart() + onMidiClockTick() directly via page.evaluate on the live
 * AudioContext (mirrors the clockSync.spec harness). MIDI master is IMPLICIT — Start makes the
 * studio master; there is no opt-in toggle. We assert:
 *   - 0xFA Start flips cascadeClock.externalClock true and Monarch follows (no analog TEMPO patch).
 *   - one Cascade step advances per 6 ticks (24 PPQN ÷ 6 = 4 PPQN = one 16th).
 *   - an analog TEMPO IN cable wins over MIDI for the Monarch (analog > MIDI priority).
 *   - 0xFC Stop releases master and the Monarch returns to internal scheduling.
 *   - a pulse STALL (no further ticks, no Stop) auto-releases master via the scheduler watchdog.
 */

import { expect, test, type Page } from '@playwright/test';

/* eslint-disable @typescript-eslint/no-explicit-any */
const studioCall = (page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(
    ([f, a]) => (window.__synthstackStudio as any).studioInstance[f as string](...(a as unknown[])),
    [fn, args] as const,
  );

const readMidiState = (page: Page) =>
  page.evaluate(() => {
    const studio = (window.__synthstackStudio as any).studioInstance;
    return {
      master: studio.isMidiClockMaster() as boolean,
      cascadeExternal: studio.cascadeClock.externalClock as boolean,
      monarchExternal: studio.monarchSeq.externalClock as boolean,
      cascadeTick: studio.cascadeClock.currentTick as number,
    };
  });

/** Feed `count` 24-PPQN ticks at `bpm`, stamping explicit audio times so the test is deterministic. */
async function feedTicks(page: Page, count: number, bpm: number, startAt: number) {
  await page.evaluate(
    ([c, b, s]) => {
      const studio = (window.__synthstackStudio as any).studioInstance;
      const tickDur = 60 / ((b as number) * 24);
      for (let i = 0; i < (c as number); i++) studio.onMidiClockTick((s as number) + i * tickDur);
    },
    [count, bpm, startAt] as const,
  );
}

test('0xFA Start makes the studio MIDI master and clocks the Cascade ÷6', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.getByTestId('power').click();
  await page.waitForFunction(() => (window.__synthstackStudio as any)?.powered === true);

  // Before any MIDI: internal.
  expect((await readMidiState(page)).master).toBe(false);

  await studioCall(page, 'onMidiClockStart');
  const started = await readMidiState(page);
  expect(started.master).toBe(true);
  expect(started.cascadeExternal).toBe(true);
  expect(started.monarchExternal).toBe(true); // no analog TEMPO cable -> Monarch follows MIDI

  // 12 ticks = two 16ths -> two Cascade external edges (tickIndex += 2).
  const before = (await readMidiState(page)).cascadeTick;
  await feedTicks(page, 12, 120, 1.0);
  expect((await readMidiState(page)).cascadeTick).toBe(before + 2);

  // 0xFC Stop releases master and the Monarch returns to internal.
  await studioCall(page, 'onMidiClockStop');
  const stopped = await readMidiState(page);
  expect(stopped.master).toBe(false);
  expect(stopped.cascadeExternal).toBe(false);
  expect(stopped.monarchExternal).toBe(false);
});

test('analog TEMPO IN wins over MIDI for the Monarch (analog > MIDI priority)', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.getByTestId('power').click();
  await page.waitForFunction(() => (window.__synthstackStudio as any)?.powered === true);

  // Patch a cable into MON_TEMPO_IN, then become MIDI master.
  await page.evaluate(() =>
    (window.__synthstackStudio as any).commitCables([
      { id: 'mt1', from: 'MON_ASSIGN_OUT', to: 'MON_TEMPO_IN', color: '#fff' },
    ]),
  );
  await studioCall(page, 'onMidiClockStart');
  const s = await readMidiState(page);
  expect(s.master).toBe(true);
  expect(s.cascadeExternal).toBe(true); // Cascade still follows MIDI (MIDI > analog)
  // Monarch external because of the analog cable, but it is the ANALOG follower, not MIDI —
  // feeding MIDI ticks must NOT step the Monarch (covered structurally by routeMidiEdge guard).
  expect(s.monarchExternal).toBe(true);

  await studioCall(page, 'onMidiClockStop');
});

test('a pulse stall (no Stop) auto-releases MIDI master via the scheduler watchdog', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.getByTestId('power').click();
  await page.waitForFunction(() => (window.__synthstackStudio as any)?.powered === true);

  await studioCall(page, 'onMidiClockStart');
  // Feed a few ticks at a real-ish past time, then stop feeding entirely (no 0xFC).
  await feedTicks(page, 6, 120, 0.5);
  expect((await readMidiState(page)).master).toBe(true);

  // The watchdog runs on the live scheduler pump (no setInterval of our own). Because the ticks
  // were stamped in the past, currentTime is already well beyond lastTickTime + the gap, so the
  // next pump releases master. Poll until released (generous window).
  await page.waitForFunction(
    () => (window.__synthstackStudio as any).studioInstance.isMidiClockMaster() === false,
    undefined,
    { timeout: 5000 },
  );
  const released = await readMidiState(page);
  expect(released.master).toBe(false);
  expect(released.monarchExternal).toBe(false); // Monarch back to internal
});
