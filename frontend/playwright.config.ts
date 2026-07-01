import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the split-bill-calculator E2E suite.
 *
 * Why these settings:
 * - baseURL points at the Vite dev server (frontend). The dev server's
 *   proxy forwards /api/* to http://127.0.0.1:8449 (the FastAPI backend).
 *   Both servers are expected to already be running before the tests
 *   start (we don't boot them ourselves — that's the dev env's job).
 * - webServer is empty because we run against an already-running stack.
 *   Add `reuseExistingServer: true` if we ever boot them here.
 * - Single worker so the auth-token DB inserts don't race. The suite
 *   is short enough that parallelism doesn't help much.
 * - Trace + video on retry so we can debug flaky failures.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e/report" }]],
  use: {
    baseURL: process.env.SBC_E2E_BASE_URL ?? "http://localhost:8448",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});