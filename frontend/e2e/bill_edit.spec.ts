/**
 * TEST-006 — Edit bill (/bills/{billId}/edit)
 *
 * Covers: Coverage-Gaps.md gap #6 (PRD §3.6.4 + PO T17 B②i)
 *
 * What this verifies
 * ------------------
 * 1. Pre-fill: navigating to /sessions/{id}/bills/{billId}/edit shows
 *    BillForm in edit mode with the existing amount, payer, occurred_at,
 *    currency, participants — but description is READ-ONLY (PO T17).
 * 2. Edit amount via the calculator keypad → submit → BE PATCH succeeds.
 * 3. BE persistence: GET /api/sessions/{id}/bills shows the updated
 *    amount (re-evaluated) + same amount_expression + same description
 *    (immutable).
 * 4. Description immutability: even if the readonly input exposes the
 *    value, PATCH with description=anything gets 422 (extra='forbid').
 *
 * Real selectors (from BillForm.svelte):
 *   - #amount (label for AmountCalculatorInput)
 *   - [data-testid="amount-calc-row"]  — trigger
 *   - [data-testid="amount-calc-input"] — form input
 *   - [data-testid="amount-calc-eq-done"] — = (evaluates + closes)
 *   - #payer (select)
 *   - #desc (input, disabled in edit mode)
 *   - [data-testid="description-readonly-hint"] — visible in edit mode
 *   - submit button text: "保存修改" (edit) vs "保存账单" (create)
 *   - keypad keys: aria-label 1/2/加/3/4 etc
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { ensureUserAndToken, wipeDb, type SeededUser } from "./test-helpers";

const BASE = "http://localhost:8448";
const TEST_EMAIL = "edit.eve@jessejia.local";
const SESSION_NAME = "TEST-006 edit bill";

const SCREENSHOTS_DIR = path.join(process.cwd(), "e2e", "screenshots");
const SCREENSHOT_STEP = (n: number, name: string) =>
  path.join(SCREENSHOTS_DIR, `test-006-${String(n).padStart(2, "0")}-${name}.png`);

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

test("TEST-006: edit-bill page prefills form, accepts amount change, locks description", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const user = ensureUserAndToken(TEST_EMAIL);
  await loginAs(ctx, user);
  const page = await ctx.newPage();

  // ── Setup: wizard → session → 1 bill (description='Original') ────────
  await page.goto(`${BASE}/sessions/new`);
  await page.waitForLoadState("networkidle");

  await page.locator("#session-name").fill(SESSION_NAME);
  await page.locator('button:has-text("下一步")').click();
  await page.locator('button:has-text("下一步")').click(); // default 2
  const inputs = await page.locator('input[type="text"]').all();
  await inputs[0].fill("Member A");
  await inputs[1].fill("Member B");
  await page.locator('button:has-text("确认创建")').click();

  await page.waitForURL(/\/sessions\/\d+/);
  const sid = Number(page.url().match(/\/sessions\/(\d+)/)![1]);

  // Create initial bill: amount=50 CNY, description='Original'
  await page.goto(`${BASE}/sessions/${sid}/bills/new`);
  await page.waitForLoadState("networkidle");
  const row = page.locator('[data-testid="amount-calc-row"]');
  await row.click();
  const sheet = page.locator('.sheet[role="dialog"]');
  await expect(sheet).toBeVisible();
  for (const ch of "50") {
    await sheet.getByRole("button", { name: ch, exact: true }).click();
  }
  await page.locator('[data-testid="amount-calc-eq-done"]').click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('[data-testid="amount-calc-input"]')).toHaveValue("50");
  await page.locator("#desc").fill("Original");
  await page.locator('button[type="submit"]:has-text("保存账单")').click();
  await page.waitForURL(new RegExp(`/sessions/${sid}(?:$|[^0-9])`));

  // Verify the bill exists, then capture its id.
  let bills = (await (await page.request.get(`${BASE}/api/sessions/${sid}/bills`)).json()) as Array<any>;
  expect(bills.length).toBe(1);
  const billId = bills[0].id;
  expect(bills[0].amount).toBe(50);
  expect(bills[0].description).toBe("Original");

  // ── Step 1: open edit page → verify prefill ──────────────────────────
  await page.goto(`${BASE}/sessions/${sid}/bills/${billId}/edit`);
  await page.waitForLoadState("networkidle");

  // Page title is "编辑账单" (not "新建账单")
  await expect(page.locator("h2")).toHaveText("编辑账单");

  // Amount input prefilled with "50"
  await expect(page.locator('[data-testid="amount-calc-input"]')).toHaveValue("50");

  // Description is read-only (disabled) + visible hint
  const descInput = page.locator("#desc");
  await expect(descInput).toBeDisabled();
  await expect(descInput).toHaveValue("Original");
  await expect(page.locator('[data-testid="description-readonly-hint"]')).toBeVisible();

  // Submit button text is "保存修改" (NOT "保存账单")
  await expect(
    page.locator('button[type="submit"]:has-text("保存修改")')
  ).toBeVisible();
  await expect(
    page.locator('button[type="submit"]:has-text("保存账单")')
  ).toHaveCount(0);

  await page.screenshot({ path: SCREENSHOT_STEP(1, "edit-prefilled") });

  // ── Step 2: change amount to 200 via keypad ───────────────────────────
  await row.click();
  await expect(sheet).toBeVisible();
  // Clear (C key) then type 200
  await sheet.getByRole("button", { name: "清空", exact: true }).click();
  for (const ch of "200") {
    await sheet.getByRole("button", { name: ch, exact: true }).click();
  }
  await page.locator('[data-testid="amount-calc-eq-done"]').click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('[data-testid="amount-calc-input"]')).toHaveValue("200");
  await expect(
    page.locator('[data-testid="amount-calc-preview"]')
  ).toContainText("200.00");

  // Description input remains disabled + still "Original" (cannot be edited)
  await expect(page.locator("#desc")).toBeDisabled();
  await expect(page.locator("#desc")).toHaveValue("Original");
  await page.screenshot({ path: SCREENSHOT_STEP(2, "amount-edited") });

  // ── Step 3: submit → redirects back to session detail ────────────────
  await page.locator('button[type="submit"]:has-text("保存修改")').click();
  await page.waitForURL(new RegExp(`/sessions/${sid}(?:$|[^0-9])`), {
    timeout: 10000,
  });
  await page.screenshot({ path: SCREENSHOT_STEP(3, "after-edit-submit") });

  // ── Step 4: API verifies persistence + description immutable ─────────
  bills = (await (await page.request.get(`${BASE}/api/sessions/${sid}/bills`)).json()) as Array<any>;
  const edited = bills.find((b) => b.id === billId);
  expect(edited).toBeTruthy();
  expect(edited.amount, "amount updated to 200").toBe(200);
  expect(
    edited.amount_expression,
    "amount_expression stores '200' (calculator input echoed back)"
  ).toBe("200");
  expect(
    edited.description,
    "description immutable (PO T17)"
  ).toBe("Original");
  expect(edited.id).toBe(billId); // same bill, not a new one

  await ctx.close();
});

test("TEST-006b: PATCH with description=anything → 422 (extra='forbid')", async ({
  browser,
}) => {
  // Defense-in-depth: even if a future FE bug lets the user submit a
  // description, the BE rejects it. Verifies the contract documented in
  // app/api/bills.py:UpdateBillRequest (model_config extra='forbid').
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const user = ensureUserAndToken(TEST_EMAIL);
  await loginAs(ctx, user);
  const page = await ctx.newPage();

  // Minimal setup: reuse the same wizard flow to get a session + bill.
  await page.goto(`${BASE}/sessions/new`);
  await page.waitForLoadState("networkidle");
  await page.locator("#session-name").fill(SESSION_NAME);
  await page.locator('button:has-text("下一步")').click();
  await page.locator('button:has-text("下一步")').click();
  const inputs = await page.locator('input[type="text"]').all();
  await inputs[0].fill("Member A");
  await inputs[1].fill("Member B");
  await page.locator('button:has-text("确认创建")').click();
  await page.waitForURL(/\/sessions\/\d+/);
  const sid = Number(page.url().match(/\/sessions\/(\d+)/)![1]);

  await page.goto(`${BASE}/sessions/${sid}/bills/new`);
  await page.waitForLoadState("networkidle");
  await page.locator('[data-testid="amount-calc-row"]').click();
  await page.locator('.sheet[role="dialog"]').getByRole("button", { name: "清空", exact: true }).click();
  for (const ch of "30") {
    await page.locator('.sheet[role="dialog"]').getByRole("button", { name: ch, exact: true }).click();
  }
  await page.locator('[data-testid="amount-calc-eq-done"]').click();
  await page.locator("#desc").fill("Untouched");
  await page.locator('button[type="submit"]:has-text("保存账单")').click();
  await page.waitForURL(new RegExp(`/sessions/${sid}(?:$|[^0-9])`));

  const bills = (await (await page.request.get(`${BASE}/api/sessions/${sid}/bills`)).json()) as Array<any>;
  const billId = bills[0].id;

  // Try PATCH with description → expect 422
  const patch = await page.request.patch(
    `${BASE}/api/sessions/${sid}/bills/${billId}`,
    {
      data: { amount: 99, description: "Hacked!" },
    }
  );
  expect(patch.status(), "PATCH with description must be rejected by extra='forbid'").toBe(422);

  // Confirm the bill didn't change
  const after = await (await page.request.get(`${BASE}/api/sessions/${sid}/bills`)).json() as Array<any>;
  expect(after[0].amount).toBe(30);
  expect(after[0].description).toBe("Untouched");

  await ctx.close();
});