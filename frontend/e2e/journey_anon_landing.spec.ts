/**
 * Scenario 3: Anonymous landing state (button label)
 *
 * v0.3.1 → coverage: anon visitor lands on / → "直接开始使用" CTA visible.
 *
 * Split out from full_e2e_journey.spec.ts.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const SCREENSHOTS_DIR = path.join(process.cwd(), "e2e", "screenshots");
let stepCounter = 0;
const shotPath = (n: number, name: string) =>
  path.join(SCREENSHOTS_DIR, `journey-landing-${String(n).padStart(2, "0")}-${name}.png`);
const step = () => ++stepCounter;

test.beforeEach(() => {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  stepCounter = 0;
});

test("scenario 3 anon state: landing shows '直接开始使用' button", async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  await page.goto("/");
  await page.waitForTimeout(500);

  const anonBtn = page.locator("button", { hasText: "直接开始使用" }).first();
  await expect(anonBtn).toBeVisible({ timeout: 5000 });
  await page.screenshot({ path: shotPath(step(), "anon-button"), fullPage: true });

  await ctx.close();
});