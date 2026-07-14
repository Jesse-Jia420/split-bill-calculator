/**
 * Scenario 1: Anonymous user quick flow (split out from full_e2e_journey)
 *
 * v0.3.1 → coverage: anonymous landing → 直接开始使用 →
 *   /join claim nickname → 2 multi-currency-ish bills → settle page
 *
 * Self-contained helpers (no shared state with other specs).
 * No REPORT.md aggregation — one spec = one report per scenario, kept local.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const SCREENSHOTS_DIR = path.join(process.cwd(), "e2e", "screenshots");
let stepCounter = 0;
const shotPath = (n: number, name: string) =>
  path.join(SCREENSHOTS_DIR, `journey-anon-${String(n).padStart(2, "0")}-${name}.png`);
const step = () => ++stepCounter;

test.beforeEach(() => {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  stepCounter = 0;
});

test("scenario 1 anon: landing → 直接开始使用 → join → claim → 2 bills → settle → /s/{code}", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // STEP 1: Landing page
  await page.goto("/");
  await expect(page.locator("text=轻松分摊")).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: shotPath(step(), "landing"), fullPage: true });

  // STEP 2: Click "直接开始使用"
  await page.locator("button", { hasText: "直接开始使用" }).first().click();
  await page.waitForURL(/\/sessions\/new$/, { timeout: 15000 });
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: shotPath(step(), "wizard-step1"), fullPage: true });

  // STEP 2a: Wizard step 1 — session name
  await page.locator("#session-name").fill("Anon Quick Session");
  await page.locator('button:has-text("下一步")').click();

  // STEP 2b: Wizard step 2 — member nicknames (3-step wizard)
  await page.waitForLoadState("networkidle");
  await expect(page.locator("h2")).toHaveText(/一共有多少个昵称/);
  const inputs = await page.locator('input[type="text"]').all();
  await inputs[0].fill("Alice");
  await inputs[1].fill("同伴 B");
  await page.screenshot({ path: shotPath(step(), "wizard-step2"), fullPage: true });
  await page.locator('button:has-text("下一步")').click();

  // STEP 2c: Wizard step 3 — currency
  await page.waitForLoadState("networkidle");
  await expect(page.locator("h2")).toHaveText(/使用什么币种/);
  await page.screenshot({ path: shotPath(step(), "wizard-step3"), fullPage: true });
  await page.locator('button:has-text("确认创建")').click();

  await page.waitForURL(/\/sessions\/\d+$/, { timeout: 15000 });
  await page.waitForLoadState("networkidle");
  const sessionId = Number(page.url().match(/\/sessions\/(\d+)/)?.[1]);
  expect(sessionId).toBeGreaterThan(0);
  await page.screenshot({ path: shotPath(step(), "session-detail"), fullPage: true });

  // Verify localStorage secret was set (wizard auto-claims via join-claim)
  const secret = await page.evaluate(
    (sid) => localStorage.getItem(`sbc.actingAs.${sid}`),
    sessionId
  );
  expect(secret, "X-Nickname-Secret should be in localStorage after wizard").toBeTruthy();
  expect(secret?.length).toBeGreaterThan(20);

  // STEP 4: Get session_code + member ids
  const sessionRes = await page.request.get(`/api/sessions/${sessionId}`, {
    headers: { "X-Nickname-Secret": secret! },
  });
  expect(sessionRes.status()).toBe(200);
  const sessionData = await sessionRes.json();
  const sessionCode = sessionData.session_code;
  expect(sessionCode).toMatch(/^[A-Z2-9]{10}$/);
  const aliceMemberId = sessionData.members.find((m: any) => m.display_name === "Alice")?.id;
  const other = sessionData.members.find((m: any) => m.display_name !== "Alice");
  const otherId = other?.id ?? aliceMemberId;

  // STEP 5: Seed 2 bills via API (more reliable than UI bill form)
  const today = new Date().toISOString().slice(0, 10);
  const bill1 = await page.request.post(`/api/sessions/${sessionId}/bills`, {
    headers: { "X-Nickname-Secret": secret! },
    data: {
      description: "Dinner",
      amount: 810,
      currency: "CNY",
      occurred_at: `${today}T19:00:00Z`,
      payer_member_id: aliceMemberId,
      participants: [
        { member_id: aliceMemberId, is_exclusive: false, exclusive_amount: 0 },
        { member_id: otherId, is_exclusive: false, exclusive_amount: 0 },
      ],
    },
  });
  expect(bill1.status(), "first bill should be 201").toBe(201);

  const bill2 = await page.request.post(`/api/sessions/${sessionId}/bills`, {
    headers: { "X-Nickname-Secret": secret! },
    data: {
      description: "Coffee",
      amount: 35,
      currency: "CNY",
      occurred_at: `${today}T21:00:00Z`,
      payer_member_id: aliceMemberId,
      participants: [
        { member_id: aliceMemberId, is_exclusive: false, exclusive_amount: 0 },
        { member_id: otherId, is_exclusive: false, exclusive_amount: 0 },
      ],
    },
  });
  expect(bill2.status(), "second bill should be 201").toBe(201);

  // STEP 6: Reload → see bills
  await page.goto(`/sessions/${sessionId}`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: shotPath(step(), "session-with-bills"), fullPage: true });
  const bodyText = await page.locator("body").textContent();
  expect(bodyText).toContain("Dinner");
  expect(bodyText).toContain("Coffee");

  // STEP 7: Settle page
  await page.goto(`/sessions/${sessionId}/settle`);
  await page.waitForTimeout(800);
  await page.screenshot({ path: shotPath(step(), "settle"), fullPage: true });
  const settleText = await page.locator("body").textContent();
  expect(settleText).toMatch(/CNY/);
  // Alice paid 845, owes 422.50 herself → not zero balance
  expect(settleText).not.toMatch(/所有人都已结清/);

  // STEP 8: /s/{code} redirect
  await page.goto(`/s/${sessionCode}`);
  await page.waitForURL(new RegExp(`/sessions/${sessionId}$`), { timeout: 10000 });
  await page.screenshot({ path: shotPath(step(), "code-redirect"), fullPage: true });

  await ctx.close();
});