/**
 * TEST-011 — Session detail empty-state (no bills)
 *
 * Covers: Coverage-Gaps.md gap #11 (PRD §3.5 / §3.6.5)
 *
 * What this verifies
 * ------------------
 * When a session has 0 bills, the session detail page renders the
 * EmptyState component with:
 *   - icon: "receipt"
 *   - title: "还没有账单"
 *   - description: "添加你的第一笔消费,分摊自动结算。"
 *   - CTA: "+ 新建账单" linking to /sessions/{id}/bills/new
 *
 * The EmptyState MUST replace the BillListGrouped component (not
 * coexist). Once the first bill is added via the CTA path, the
 * EmptyState disappears.
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import { ensureUserAndToken, wipeDb, type SeededUser } from "./test-helpers";

const BASE = "http://localhost:8448";
const TEST_EMAIL = "empty.edgar@local.test";
const SESSION_NAME = "TEST-011 empty state";

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

test.beforeEach(() => {
  wipeDb();
});

test("TEST-011: session with 0 bills renders EmptyState + CTA", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const user = ensureUserAndToken(TEST_EMAIL);
  await loginAs(ctx, user);
  const page = await ctx.newPage();

  // Create a session with NO bills.
  const createRes = await page.request.post(`${BASE}/api/sessions`, {
    data: {
      name: SESSION_NAME,
      currencies: ["CNY"],
      primary_currency: "CNY",
      member_nicknames: [],
    },
  });
  expect(createRes.status()).toBe(201);
  const created = await createRes.json();
  const sid = created.id;

  await page.goto(`${BASE}/sessions/${sid}`);
  await page.waitForLoadState("networkidle");

  // EmptyState title + description + CTA visible
  await expect(page.locator("h3", { hasText: "还没有账单" })).toBeVisible();
  await expect(page.getByText("添加你的第一笔消费")).toBeVisible();

  // CTA button "+ 新建账单" → links to /sessions/{sid}/bills/new
  const cta = page.locator('a:has-text("新建账单")');
  await expect(cta).toBeVisible();
  const ctaHref = await cta.getAttribute("href");
  expect(ctaHref).toBe(`/sessions/${sid}/bills/new`);

  // BillListGrouped should NOT be present
  await expect(page.locator(".bill-row, .bill-group")).toHaveCount(0);

  await ctx.close();
});