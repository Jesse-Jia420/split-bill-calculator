/**
 * TEST-005 — BillForm calculator popup (= closes + writes back amount)
 *
 * Covers: Coverage-Gaps.md gap #5 (BillForm calculator, PRD §3.4 / §3.9.1b)
 *
 * What this verifies
 * ------------------
 * The AmountCalculatorInput bottom-sheet keypad:
 *   1. Tapping the amount row (`[data-testid=amount-calc-row]`) opens the
 *      keypad sheet (`.sheet[role=dialog]`).
 *   2. Typing "12+34" via the keypad keys (aria-labels: 1/2/加/3/4) builds
 *      the raw expression string in the amount input.
 *   3. Pressing `=` (`[data-testid=amount-calc-eq-done]`) evaluates the
 *      expression AND closes the sheet (v0.3.1 PO Bug #3: `=` == 完成).
 *   4. After close: the form-position amount input holds the raw
 *      expression "12+34", and the preview shows "= 46.00".
 *   5. On submit, the BE re-evaluates (use_calculator=true) and stores
 *      amount=46 with amount_expression="12+34".
 *
 * Real selectors (read from AmountCalculatorInput.svelte + BillForm.svelte):
 *   - trigger row:  [data-testid="amount-calc-row"]
 *   - form input:   [data-testid="amount-calc-input"]  (value = raw expr)
 *   - preview:      [data-testid="amount-calc-preview"] (= 46.00 CNY)
 *   - sheet:        .sheet[role="dialog"]
 *   - keypad keys:  button[aria-label="1".."9"/"0"], "加"(+), "减"(-),
 *                   "乘"(*), "除"(/), "小数点"(.), "清空"(C), "退格"(⌫)
 *   - equals/done:  [data-testid="amount-calc-eq-done"]
 *
 * NOTE: keypad keys use aria-label (NOT data-key). The spec sketch in
 * Coverage-Gaps.md assumed data-key="X"; the real component uses
 * aria-label, so we target getByRole('button', { name }).
 *
 * Pre-conditions:
 *   - Frontend running on http://localhost:8448
 *   - Backend running on http://localhost:8449
 *   - TEST_EMAIL must NOT be in DEV_BYPASS_EMAILS (we seed a real
 *     auth_tokens row via ensureUserAndToken + loginAs).
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { ensureUserAndToken, wipeDb, type SeededUser } from "./test-helpers";

const BASE = "http://localhost:8448";
const TEST_EMAIL = "calc.dave@jessejia.local";
const SESSION_NAME = "TEST-005 calculator writeback";

const SCREENSHOTS_DIR = path.join(process.cwd(), "e2e", "screenshots");
const SCREENSHOT_STEP = (n: number, name: string) =>
  path.join(SCREENSHOTS_DIR, `test-005-${String(n).padStart(2, "0")}-${name}.png`);

async function loginAs(ctx: BrowserContext, user: SeededUser) {
  await ctx.addCookies([
    {
      name: "sbc_session",
      value: user.raw_token,
      url: BASE,
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);
}

test.beforeAll(() => {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
});

test.beforeEach(() => {
  wipeDb();
});

test("TEST-005: calculator = closes sheet + writes back evaluated amount", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const user = ensureUserAndToken(TEST_EMAIL);
  await loginAs(ctx, user);
  const page = await ctx.newPage();

  // ── Create a session via the logged-in wizard ────────────────────────
  await page.goto(`${BASE}/sessions/new`);
  await page.waitForLoadState("networkidle");
  expect(page.url()).toContain("/sessions/new");

  // Step 1: session name → 下一步
  await page.locator("#session-name").fill(SESSION_NAME);
  await page.locator('button:has-text("下一步")').click();

  // Step 2: accept default member count (2) → 下一步
  await page.locator('button:has-text("下一步")').click();

  // Step 3: fill 2 placeholder nicknames → 确认创建
  const inputs = await page.locator('input[type="text"]').all();
  expect(inputs.length).toBeGreaterThanOrEqual(2);
  await inputs[0].fill("Eve");
  await inputs[1].fill("Frank");
  await page.locator('button:has-text("确认创建")').click();

  await page.waitForURL(/\/sessions\/\d+/, { timeout: 10000 });
  const sid = Number(page.url().match(/\/sessions\/(\d+)/)![1]);
  expect(sid).toBeGreaterThan(0);

  // ── Open the new-bill form ───────────────────────────────────────────
  await page.goto(`${BASE}/sessions/${sid}/bills/new`);
  await page.waitForLoadState("networkidle");

  const row = page.locator('[data-testid="amount-calc-row"]');
  await expect(row).toBeVisible();
  await page.screenshot({ path: SCREENSHOT_STEP(1, "form-loaded") });

  // ── Open keypad + type "12+34" ───────────────────────────────────────
  await row.click();
  const sheet = page.locator('.sheet[role="dialog"]');
  await expect(sheet).toBeVisible();
  await page.screenshot({ path: SCREENSHOT_STEP(2, "keypad-open") });

  // keypad keys use aria-label; "+" == "加"
  const key = (name: string) =>
    sheet.getByRole("button", { name, exact: true });
  await key("1").click();
  await key("2").click();
  await key("加").click();
  await key("3").click();
  await key("4").click();

  // sheet-top row echoes the raw expression while typing
  await expect(
    page.locator('[data-testid="amount-calc-sheet-row"]')
  ).toContainText("12+34");
  await page.screenshot({ path: SCREENSHOT_STEP(3, "expr-typed") });

  // ── Press = (evaluate + close) ───────────────────────────────────────
  await page.locator('[data-testid="amount-calc-eq-done"]').click();

  // Sheet must close
  await expect(sheet).toHaveCount(0);

  // Form-position input holds the raw expression; preview shows = 46.00
  await expect(page.locator('[data-testid="amount-calc-input"]')).toHaveValue(
    "12+34"
  );
  await expect(
    page.locator('[data-testid="amount-calc-preview"]')
  ).toContainText("46.00");
  await page.screenshot({ path: SCREENSHOT_STEP(4, "sheet-closed-writeback") });

  // ── Fill the rest of the form + submit ───────────────────────────────
  await page.locator("#desc").fill("Test calc");

  // Payer defaults to the owner (defaultPayerMemberId). Be defensive: if
  // still unset, pick the first real option.
  const payerVal = await page.locator("#payer").inputValue();
  if (!payerVal || payerVal === "null") {
    await page.locator("#payer").selectOption({ index: 1 });
  }

  // Participants default to all-included; submit directly.
  await page.locator('button[type="submit"]:has-text("保存账单")').click();
  await page.waitForURL(new RegExp(`/sessions/${sid}(?:$|[^0-9])`), {
    timeout: 10000,
  });
  await page.screenshot({ path: SCREENSHOT_STEP(5, "after-submit") });

  // ── Assertions via API — BE re-evaluated + stored expression ─────────
  const res = await page.request.get(`${BASE}/api/sessions/${sid}/bills`);
  expect(res.status(), "GET /sessions/{id}/bills should be 200").toBe(200);
  const bills = await res.json();
  const calcBill = bills.find((b: any) => b.description === "Test calc");
  expect(calcBill, "the calculator bill should be persisted").toBeTruthy();
  expect(calcBill.amount, "amount = evaluated 12+34 = 46").toBe(46);
  expect(
    calcBill.amount_expression,
    "amount_expression stores the raw string"
  ).toBe("12+34");

  await ctx.close();
});
