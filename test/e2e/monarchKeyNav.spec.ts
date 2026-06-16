/**
 * Monarch arrow-key note editing e2e (feature-sampler-pads) — runs in the
 * installed Chrome (playwright.config.ts `channel: 'chrome'`; no downloaded
 * browsers) against the Vite dev server. Mirrors keyboard/drumMachine/smoke
 * (favicon-filtered console+pageerror collection, power-on, getByTestId +
 * window.__synthstackStudio store reads).
 *
 * The Monarch step editor (src/ui/sequencer/MonarchStepEditor.tsx) is its own strip
 * panel (REGIONS.seqStrip) on the 16:9 stage. By design: after selecting a
 * step, edit/navigate it with the keyboard arrows instead of trekking to the NOTE
 * knob. This spec proves the design-locked mapping end-to-end:
 *   - ArrowUp / ArrowDown      → selected step note ±1 SEMITONE (clamped [-24, 24])
 *   - Shift+ArrowUp / Down      → ±12 semitones (one octave), same clamp
 *   - ArrowLeft / ArrowRight    → move the selected step ∓/±1 (clamped [0, 31]) and
 *                                 auto-flip the page (page = floor(selected / 8)) so
 *                                 the selected cell stays visible
 * Clicking a step CELL focuses the editor SVG (svgRef.current?.focus()), so the plain
 * "select the step, then use arrows" path lands with e.target === e.currentTarget.
 *
 * The note value round-trips through the SAME store slice the NOTE knob commits to:
 * window.__synthstackStudio.store.getState().transport.monarch.steps[i].noteVv (1 vv/oct), so a
 * +1-semi arrow == +1/12 vv (== onNote's Math.round(v)/12 contract).
 *
 * The double-edit SENTINEL (step e) is the whole feature's correctness guard: keydown
 * BUBBLES, and a focused child Knob's onKeyDown preventDefaults but does NOT
 * stopPropagation, so an arrow on the NOTE knob bubbles to the editor onKeyDown. The
 * editor's `e.target !== e.currentTarget` guard must short-circuit there — otherwise
 * the note would move +2 (knob detent + editor) instead of +1.
 *
 * The existing smoke/patch/clock/sampler/drum/keyboard/recording/presets/factoryKit
 * e2e + the audio battery must still pass unchanged — this feature is purely additive
 * (new testids monarch-step-editor-svg + monarch-cell-N only; the inner monarch-step-editor <g>
 * and the monarch-page-N tabs are untouched).
 */

import { expect, test, type Page } from '@playwright/test';
// window.__synthstackStudio is typed by src/ui/engineBridge.ts's global declaration

/** NOTE_DEF range in MonarchStepEditor.tsx (min -24, max 24) — the semitone rails. */
const NOTE_MIN = -24;
const NOTE_MAX = 24;
const clampSemi = (s: number) => Math.min(NOTE_MAX, Math.max(NOTE_MIN, s));

/** The committed note of step i, in integer SEMITONES (Math.round(noteVv*12)). */
const semisOf = (page: Page, i: number) =>
  page.evaluate(
    (idx) =>
      Math.round(window.__synthstackStudio!.store.getState().transport.monarch.steps[idx]!.noteVv * 12),
    i,
  );

test('monarch arrow keys: note ±semitone, Shift=octave, Left/Right nav + page-flip, no double-edit', async ({
  page,
}) => {
  // the 16:9 stage's design target — the console (incl. the Monarch step strip) fills the
  // viewport; only the sampler/drum section below the fold scrolls.
  await page.setViewportSize({ width: 1920, height: 1080 });

  const errors: string[] = [];
  page.on('console', (msg) => {
    // index.html ships no favicon; Chrome's /favicon.ico probe 404s against the dev
    // server — network noise, not an app error (same filter as smoke/keyboard).
    if (msg.type() === 'error' && !msg.location().url.includes('favicon')) errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/');
  await page.getByTestId('power').click();

  // ---- a. clicking a step CELL focuses the editor SVG --------------------------------
  // page 0 shows cells 0..7; cell 0 is on screen at the default 16:9 viewport.
  const editor = page.getByTestId('monarch-step-editor-svg');
  await expect(editor).toBeVisible();
  await page.getByTestId('monarch-cell-0').click();
  // the cell click ran svgRef.current?.focus() — the editor SVG now holds focus, so
  // arrow keydowns land on it with e.target === e.currentTarget.
  await expect(editor).toBeFocused();
  const s0 = await semisOf(page, 0);

  // ---- b. ArrowUp / ArrowDown move the selected note ±1 semitone (clamped) -----------
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => semisOf(page, 0)).toBe(clampSemi(s0 + 1));
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => semisOf(page, 0)).toBe(s0); // back to where we started

  // ---- c. Shift+ArrowUp / Down move by one OCTAVE (±12 semitones), same clamp --------
  await page.keyboard.press('Shift+ArrowUp');
  await expect.poll(() => semisOf(page, 0)).toBe(clampSemi(s0 + 12));
  await page.keyboard.press('Shift+ArrowDown');
  await expect.poll(() => semisOf(page, 0)).toBe(s0);

  // ---- d. ArrowRight ×8 moves the selection step 0 → step 8 + auto-flips the page ----
  // step 8 lives on page 1 (floor(8/8)=1); the page must flip so cell 8 is visible.
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('monarch-cell-8')).toBeVisible();
  const s8 = await semisOf(page, 8);
  // ArrowUp now edits the NEW selected step (8), and step 0 is left untouched.
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => semisOf(page, 8)).toBe(clampSemi(s8 + 1));
  expect(await semisOf(page, 0), 'editing step 8 must not touch step 0').toBe(s0);

  // walk back to step 0 with ArrowLeft ×8, then one EXTRA ArrowLeft past the 0 rail
  // (no wrap — clampStep keeps selected at 0).
  for (let i = 0; i < 8; i++) await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('monarch-cell-0')).toBeVisible();
  await page.keyboard.press('ArrowLeft'); // past the low rail — clamped, no wrap to 31
  // ArrowUp still edits step 0 (proving the 0-bound clamp held, not a wrap to 31).
  const s0b = await semisOf(page, 0);
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => semisOf(page, 0)).toBe(clampSemi(s0b + 1));
  // (step 31 must be untouched — a wrap would have selected it instead of clamping at 0)
  const s31Before = await semisOf(page, 31);
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => semisOf(page, 0)).toBe(clampSemi(s0b + 2));
  expect(await semisOf(page, 31), 'low-rail ArrowLeft must not wrap to step 31').toBe(s31Before);

  // ---- e. DOUBLE-EDIT SENTINEL: a focused NOTE knob edits EXACTLY +1, never +2 -------
  // Select step 0 so the NOTE slider edits it. Click cell 1 FIRST (selected is 0 from
  // step d, and re-clicking the already-selected cell toggles REST — §9.3 click-to-rest)
  // so the cell-0 click is an unambiguous SELECT, not a rest toggle. NOTE_DEF has
  // steps=49 over [-24, 24] (48-semi span), so one keyboard detent = exactly 1 semitone.
  // The knob commits on key UP (commitKeyboard), and its onKeyDown preventDefaults but
  // does NOT stopPropagation — so the arrow bubbles to the editor onKeyDown, where the
  // e.target !== e.currentTarget guard MUST short-circuit. A +2 here means the guard
  // regressed (knob + editor both edited).
  await page.getByTestId('monarch-cell-1').click();
  await page.getByTestId('monarch-cell-0').click();
  const noteSlider = page.locator('[role="slider"][aria-label="NOTE"]');
  await expect(noteSlider).toBeVisible();
  await noteSlider.focus();
  const sBefore = await semisOf(page, 0);
  await page.keyboard.press('ArrowUp'); // down (bubbles, guarded) + up (knob commits) = +1
  await expect.poll(() => semisOf(page, 0)).toBe(clampSemi(sBefore + 1)); // EXACTLY +1, not +2

  // ---- f. zero console / page errors across the whole session ------------------------
  expect(errors, `console/page errors during the monarch key-nav run:\n${errors.join('\n')}`).toEqual(
    [],
  );
});
