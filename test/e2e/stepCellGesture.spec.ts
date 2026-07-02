/**
 * Step-cell direct-manipulation e2e (stepCellEdit.ts): TAP a cell toggles the step
 * on/off; a VERTICAL DRAG on a cell tunes its pitch in semitones (and un-rests it).
 * Exercised with trusted input (real mouse) on BOTH editors — Monarch (32-step strip on
 * the Monarch tab) and Courier (64-step strip below the Courier panel) — against the
 * same store slices the engines read (transport.monarch.steps / courier.seq.steps).
 *
 * PX_PER_SEMI is SCREEN pixels (clientY delta), independent of the stage scale — the
 * drag distances below are chosen as exact multiples so the expected semitone delta is
 * unambiguous (21 px = 3 semitones at PX_PER_SEMI = 7).
 */

import { expect, test, type Page } from '@playwright/test';

const PX_PER_SEMI = 7; // keep in lockstep with src/ui/sequencer/stepCellEdit.ts

interface StepShape {
  rest: boolean;
  semis: number;
}

const monarchStep = (page: Page, i: number) =>
  page.evaluate((idx): StepShape => {
    const s = window.__synthstackStudio!.store.getState().transport.monarch.steps[idx]!;
    return { rest: s.rest, semis: Math.round(s.noteVv * 12) };
  }, i);

const courierStep = (page: Page, i: number) =>
  page.evaluate((idx): StepShape => {
    const s = window.__synthstackStudio!.store.getState().courier.seq.steps[idx]!;
    return { rest: s.rest, semis: Math.round(s.noteVv * 12) };
  }, i);

/** Vertical mouse drag from the element centre (negative dy = upward = pitch up). */
async function dragCell(page: Page, testId: string, dy: number): Promise<void> {
  const box = (await page.getByTestId(testId).boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy + dy, { steps: 6 }); // several pointermoves, like a real hand
  await page.mouse.up();
}

test('step cells: tap = on/off, vertical drag = pitch (Monarch + Courier)', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !msg.location().url.includes('favicon')) errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');
  await page.getByTestId('power').click();

  // ===== MONARCH ==============================================================
  await page.getByTestId('tab-monarch').click();
  await expect(page.getByTestId('monarch-cell-1')).toBeVisible();

  // TAP toggles on/off and never touches the pitch (default C3 = −12 semis).
  const m0 = await monarchStep(page, 1);
  await page.getByTestId('monarch-cell-1').click();
  await expect.poll(() => monarchStep(page, 1)).toEqual({ rest: !m0.rest, semis: m0.semis });
  await page.getByTestId('monarch-cell-1').click();
  await expect.poll(() => monarchStep(page, 1)).toEqual(m0);

  // Shift-TAP toggles ACCENT (not rest).
  const accBefore = await page.evaluate(
    () => window.__synthstackStudio!.store.getState().transport.monarch.steps[2]!.accent,
  );
  await page.getByTestId('monarch-cell-2').click({ modifiers: ['Shift'] });
  await expect
    .poll(() =>
      page.evaluate(() => window.__synthstackStudio!.store.getState().transport.monarch.steps[2]!.accent),
    )
    .toBe(!accBefore);

  // DRAG up 3 semitones' worth of pixels raises the pitch by exactly 3 (and un-rests).
  const m3 = await monarchStep(page, 3);
  await dragCell(page, 'monarch-cell-3', -3 * PX_PER_SEMI);
  await expect.poll(() => monarchStep(page, 3)).toEqual({ rest: false, semis: m3.semis + 3 });

  // ===== COURIER ==============================================================
  await page.getByTestId('tab-courier').click();
  await expect(page.getByTestId('courier-cell-1')).toBeVisible();

  const c1 = await courierStep(page, 1);
  await page.getByTestId('courier-cell-1').click();
  await expect.poll(() => courierStep(page, 1)).toEqual({ rest: !c1.rest, semis: c1.semis });
  await page.getByTestId('courier-cell-1').click();
  await expect.poll(() => courierStep(page, 1)).toEqual(c1);

  // DRAG down lowers the pitch (2 semitones) and keeps the step sounding.
  const c2 = await courierStep(page, 2);
  await dragCell(page, 'courier-cell-2', 2 * PX_PER_SEMI);
  await expect.poll(() => courierStep(page, 2)).toEqual({ rest: false, semis: c2.semis - 2 });

  // A drag on a RESTED step un-rests it (dialing a note means you want to hear it).
  await page.getByTestId('courier-cell-4').click(); // rest it first (tap)
  await expect.poll(async () => (await courierStep(page, 4)).rest).toBe(true);
  const c4 = await courierStep(page, 4);
  await dragCell(page, 'courier-cell-4', -PX_PER_SEMI);
  await expect.poll(() => courierStep(page, 4)).toEqual({ rest: false, semis: c4.semis + 1 });

  expect(errors, `console/page errors:\n${errors.join('\n')}`).toEqual([]);
});
