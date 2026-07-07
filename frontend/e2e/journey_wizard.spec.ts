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

test("scenario 1b wizard: name → count → 2 nicknames → session detail", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // STEP 1: Go directly to wizard
  await page.goto("/sessions/new");
  await expect(
    page.locator("h2", { hasText: "给你的账本起个名字" })
  ).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: shotPath(step(), "wizard-1"), fullPage: true });

  // STEP 2: Fill name → next
  await page.locator("#session-name").fill("Wizard multi test");
  await page.locator("button.btn-next", { hasText: "下一步" }).click();
  await expect(page.locator("h2", { hasText: "一共有多少人" })).toBeVisible();
  await page.screenshot({ path: shotPath(step(), "wizard-2"), fullPage: true });

  // STEP 3: Count → next (keep default 2)
  await page.locator("button.btn-next", { hasText: "下一步" }).click();
  await expect(page.locator("h2", { hasText: "每个人叫什么名字" })).toBeVisible();
  await page.screenshot({ path: shotPath(step(), "wizard-3"), fullPage: true });

  // STEP 4: Fill nicknames → confirm
  const nickInputs = page.locator(".nickname-row input[type='text']");
  await expect(nickInputs).toHaveCount(2);
  await nickInputs.nth(0).fill("Carol");
  await nickInputs.nth(1).fill("Dave");
  await page.screenshot({ path: shotPath(step(), "wizard-3-filled"), fullPage: true });

  await page.locator("button.btn-confirm", { hasText: "确认创建" }).click();
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