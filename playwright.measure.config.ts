/**
 * Dedicated Playwright config for the fidelity MEASUREMENT battery (`npm run test:measure`).
 *
 * Pinned to a UNIQUE dev port (5191, strict) with reuseExistingServer:false so the measurement
 * run always spawns its OWN SynthStack dev server and can never accidentally reuse a sibling
 * project squatting on the default 5173 (the documented BoardBuilder clash). The standard e2e
 * config (playwright.config.ts) is untouched.
 *
 * CONSTRAINT (same as playwright.config.ts): nothing is installed outside this repo — never run
 * `npx playwright install`. `channel: 'chrome'` drives the already-installed system Chrome;
 * switch to 'msedge' if Chrome ever fails to launch.
 */
import { defineConfig } from '@playwright/test';

const PORT = 5191;

export default defineConfig({
  testDir: 'test/e2e',
  testMatch: /measurement\.spec\.ts/,
  use: {
    channel: 'chrome',
    headless: true,
    baseURL: `http://localhost:${PORT}`,
  },
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
