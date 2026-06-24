/**
 * Playwright smoke-test config.
 *
 * CONSTRAINT: nothing is installed outside this repo — never run
 * `npx playwright install` and never download a browser. `channel: 'chrome'`
 * drives the already-installed Chrome; if Chrome ever fails to
 * launch, switch the channel to 'msedge' (the supported fallback) — both are
 * system browsers, not Playwright-managed downloads.
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  // the fidelity measurement battery runs only via its own config (dedicated port) — keep it
  // out of the default e2e sweep so it never contends for 5173.
  testIgnore: /measurement\.spec\.ts/,
  use: {
    channel: 'chrome',
    headless: true,
    /** webServer.port below — page.goto('/') resolves against this. */
    baseURL: 'http://localhost:5173',
  },
  webServer: {
    command: 'npm run dev',
    port: 5173,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
