/**
 * Scenario 1b: Wizard at /sessions/new (multi-nickname setup)
 *
 * v0.3.1 → coverage: 3-step wizard (name → count → nicknames) → session detail
 *
 * Split out from full_e2e_journey.spec.ts so each scenario is its own file
 * (parallel worker execution, isolate flake, easier to debug).
 */
import { test, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const SCREENSHOTS_DIR = path.join(process.cwd(), "e2e", "screenshots");
let stepCounter = 0;
const shotPath = (n: number, name: string) =>
  path.join(SCREENSHOTS_DIR, `journey-wizard-${String(n).padStart(2, "0")}-${name}.png`);
const step = () => ++stepCounter;

test.beforeEach(() => {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  stepCounter = 0;
});

test("scenario 1b wizard: name → nicknames (3-step) → session detail", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // STEP 1: Go directly to wizard
  await page.goto("/sessions/new");
  await page.waitForLoadState("networkidle");
  await expect(page.locator("h2")).toHaveText(/给你的账本起个名字/);
  await page.screenshot({ path: shotPath(step(), "wizard-1"), fullPage: true });

  // STEP 2: Fill name → next
  await page.locator("#session-name").fill("Wizard multi test");
  await page.locator('button:has-text("下一步")').click();

  // STEP 3: Member count + nicknames (default count=2)
  await page.waitForLoadState("networkidle");
  await expect(page.locator("h2")).toHaveText(/一共有多少个昵称/);
  await page.screenshot({ path: shotPath(step(), "wizard-2"), fullPage: true });
  const nickInputs = page.locator('input[type="text"]');
  await expect(nickInputs).toHaveCount(2);
  await nickInputs.nth(0).fill("Carol");
  await nickInputs.nth(1).fill("Dave");
  await page.locator('button:has-text("下一步")').click();

  // STEP 4: Currency (pill buttons) → confirm
  await page.waitForLoadState("networkidle");
  await expect(page.locator("h2")).toHaveText(/使用什么币种/);
  await page.screenshot({ path: shotPath(step(), "wizard-3"), fullPage: true });
  await page.locator('button:has-text("确认创建")').click();
  await page.waitForURL(/\/sessions\/\d+$/, { timeout: 15000 });
  const sessionId = Number(page.url().match(/\/sessions\/(\d+)/)?.[1]);
  expect(sessionId).toBeGreaterThan(0);

  // Verify localStorage was set (creator auto-claims first nickname "Carol")
  const lsAfter = await page.evaluate(
    (sid) => localStorage.getItem(`sbc.actingAs.${sid}`),
    sessionId
  );
  expect(lsAfter).toBeTruthy();

  await page.screenshot({ path: shotPath(step(), "wizard-done"), fullPage: true });

  await ctx.close();
});