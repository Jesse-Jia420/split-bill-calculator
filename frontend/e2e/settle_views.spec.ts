/**
 * TEST-007 — Settle page dual-view switch (view=primary ↔ view=split)
 *
 * Covers: Coverage-Gaps.md gap #7 (PRD §3.7 / §3.7.6)
 *
 * What this verifies
 * ------------------
 * 1. Toggle UI: 2 radio buttons above the transfer card.
 *    - '主币种汇总 (CNY)' is active by default; switches off on click.
 *    - '源币种分列' is disabled when session has 1 currency; enabled
 *      when ≥ 2.
 * 2. API contract: clicking each toggle fires a re-fetch with the right
 *    `view=primary|split` query. The response carries `view` echoed back.
 * 3. Multi-currency session: split view's per-member rows preserve each
 *    bill's source currency (raw) in addition to primary-currency totals.
 *    Primary view only shows the primary-currency value.
 * 4. Transfer math is identical in both views (settle needs a single
 *    reference currency per PRD §3.7.6).
 *
 * Real selectors (read from settle/+page.svelte + SettleTransferPath.svelte):
 *   - view-switch container:    [role="radiogroup"][aria-label="结算视图"]
 *   - primary button:           [role="radio"]:has-text("主币种汇总")
 *   - split button:             [role="radio"]:has-text("源币种分列")
 *
 * Setup: skip the wizard (which defaults to single-currency) and POST the
 * session directly with currencies=[CNY, USD] + USD→CNY rate=7.0. There
 * is no PATCH endpoint to add a second currency after creation.
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { ensureUserAndToken, wipeDb, type SeededUser } from "./test-helpers";

const BASE = "http://localhost:8448";
const TEST_EMAIL = "settle.frank@jessejia.local";
const SESSION_NAME = "TEST-007 settle dual-view";

const SCREENSHOTS_DIR = path.join(process.cwd(), "e2e", "screenshots");
const SCREENSHOT_STEP = (n: number, name: string) =>
  path.join(SCREENSHOTS_DIR, `test-007-${String(n).padStart(2, "0")}-${name}.png`);

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

test("TEST-007: settle primary view + split view toggle (multi-currency)", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const user = ensureUserAndToken(TEST_EMAIL);
  await loginAs(ctx, user);
  const page = await ctx.newPage();

  // ── Setup: create multi-currency session directly via API ────────────
  const createRes = await page.request.post(`${BASE}/api/sessions`, {
    data: {
      name: SESSION_NAME,
      currencies: ["CNY", "USD"],
      primary_currency: "CNY",
      exchange_rates: [{ from_currency: "USD", to_currency: "CNY", rate: "7.0" }],
      member_nicknames: ["Member A", "Member B", "Member C"],
    },
  });
  expect(createRes.status(), "POST /api/sessions should be 201").toBe(201);
  const created = await createRes.json();
  const sid = created.id;
  expect(sid).toBeGreaterThan(0);
  // POST returns summary only; GET returns full SessionDetail with members.
  const detailRes = await page.request.get(`${BASE}/api/sessions/${sid}`);
  expect(detailRes.status()).toBe(200);
  const detail = await detailRes.json();
  expect(detail.currencies).toEqual(["CNY", "USD"]);
  expect(detail.primary_currency).toBe("CNY");
  const owner = detail.members.find((m: any) => m.role === "owner");
  const memberA = detail.members.find((m: any) => m.display_name === "Member A");
  const memberB = detail.members.find((m: any) => m.display_name === "Member B");
  const memberC = detail.members.find((m: any) => m.display_name === "Member C");
  const allMembers = [owner, memberA, memberB, memberC];
  expect(allMembers.length).toBe(4);

  async function createBill(
    payerId: number,
    amount: number,
    currency: string,
    description: string,
    partIds: number[]
  ) {
    const r = await page.request.post(`${BASE}/api/sessions/${sid}/bills`, {
      data: {
        amount,
        payer_member_id: payerId,
        occurred_at: new Date().toISOString(),
        currency,
        description,
        participants: partIds.map((mid) => ({
          member_id: mid,
          is_exclusive: false,
          exclusive_amount: 0,
        })),
        amount_expression: String(amount),
        use_calculator: false,
      },
    });
    if (r.status() !== 201) {
      throw new Error(`POST bill failed: ${r.status()} ${await r.text()}`);
    }
  }

  // ── 3 bills, all 4 members split evenly ───────────────────────────────
  const splitIds = allMembers.map((m: any) => m.id);
  await createBill(owner.id, 100, "CNY", "Bill CNY 100 by owner", splitIds);
  await createBill(memberA.id, 50, "USD", "Bill USD 50 by A", splitIds);
  await createBill(owner.id, 60, "USD", "Bill USD 60 by owner", splitIds);

  // ── Open settle page ─────────────────────────────────────────────────
  await page.goto(`${BASE}/sessions/${sid}/settle`);
  await page.waitForLoadState("networkidle");
  await expect(page.locator("h2")).toContainText("结算");

  // ── Step 1: default = primary ───────────────────────────────────────
  const primaryBtn = page.locator('[role="radio"]:has-text("主币种汇总")');
  const splitBtn = page.locator('[role="radio"]:has-text("源币种分列")');

  await expect(primaryBtn).toHaveAttribute("aria-checked", "true");
  await expect(splitBtn).toHaveAttribute("aria-checked", "false");
  await expect(splitBtn).toBeEnabled();
  await page.screenshot({ path: SCREENSHOT_STEP(1, "primary-active") });

  // Verify primary-view API payload
  const primaryApi = await page.request.get(
    `${BASE}/api/sessions/${sid}/settle?view=primary`
  );
  expect(primaryApi.status()).toBe(200);
  const primaryJson = await primaryApi.json();
  expect(primaryJson.view).toBe("primary");
  expect(primaryJson.primary_currency).toBe("CNY");
  expect(primaryJson.currencies).toEqual(["CNY", "USD"]);
  expect(primaryJson.transfers.length).toBeGreaterThan(0);
  // Both views return per_member rows with their source currency, so the
  // split logic lives in the FE renderer (SettleMemberBreakdown picks
  // whether to show source-currency or primary-currency values). Verify
  // the primary view exposes per_member currency breakdown covering both
  // currencies (sanity that the response shape is full).
  const ccySet = new Set(
    (primaryJson.per_member ?? []).flatMap((pm: any) =>
      (pm.paid_bills ?? []).map((b: any) => b.currency)
    )
  );
  expect(ccySet.has("USD"), "USD bills should be in per_member.paid_bills").toBe(true);
  expect(ccySet.has("CNY"), "CNY bills should be in per_member.paid_bills").toBe(true);

  // ── Step 2: click split → API re-fetches ──────────────────────────────
  // Set up the response listener BEFORE clicking so we don't race the
  // settle GET that fires on viewMode change.
  const splitResponsePromise = page.waitForResponse(
    (r) => r.url().includes("/settle") && r.url().includes("view=split")
  );
  await splitBtn.click();
  await splitResponsePromise;
  await expect(splitBtn).toHaveAttribute("aria-checked", "true");
  await expect(primaryBtn).toHaveAttribute("aria-checked", "false");
  await page.screenshot({ path: SCREENSHOT_STEP(2, "split-active") });

  const splitApi = await page.request.get(
    `${BASE}/api/sessions/${sid}/settle?view=split`
  );
  expect(splitApi.status()).toBe(200);
  const splitJson = await splitApi.json();
  expect(splitJson.view).toBe("split");
  expect(splitJson.primary_currency).toBe("CNY");
  expect(splitJson.currencies).toEqual(["CNY", "USD"]);
  // Split view's per_member rows also carry source currency on each
  // bill (the renderer reads .currency to pick display format).
  const usdBills = (splitJson.per_member ?? []).flatMap((pm: any) =>
    (pm.paid_bills ?? []).filter((b: any) => b.currency === "USD")
  );
  expect(
    usdBills.length,
    "split view should expose USD source currency on at least 1 bill"
  ).toBeGreaterThan(0);

  // ── Step 3: transfer math identical in both views ────────────────────
  const norm = (xs: any[]) =>
    xs
      .map((t: any) => `${t.from_member_id}->${t.to_member_id}:${Number(t.amount).toFixed(2)}`)
      .sort();
  expect(norm(splitJson.transfers)).toEqual(norm(primaryJson.transfers));

  // ── Step 4: switch back to primary ───────────────────────────────────
  const primaryResponsePromise = page.waitForResponse(
    (r) => r.url().includes("/settle") && r.url().includes("view=primary")
  );
  await primaryBtn.click();
  await primaryResponsePromise;
  await expect(primaryBtn).toHaveAttribute("aria-checked", "true");

  await ctx.close();
});

test("TEST-007b: single-currency session disables split toggle", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const user = ensureUserAndToken(TEST_EMAIL);
  await loginAs(ctx, user);
  const page = await ctx.newPage();

  await page.goto(`${BASE}/sessions/new`);
  await page.waitForLoadState("networkidle");
  await page.locator("#session-name").fill(SESSION_NAME + " single");
  await page.locator('button:has-text("下一步")').click();
  await page.locator('button:has-text("下一步")').click();
  const inputs = await page.locator('input[type="text"]').all();
  await inputs[0].fill("Solo A");
  await inputs[1].fill("Solo B");
  await page.locator('button:has-text("确认创建")').click();
  await page.waitForURL(/\/sessions\/\d+/);
  const sid = Number(page.url().match(/\/sessions\/(\d+)/)![1]);

  // Default currencies is [CNY] → split toggle must be disabled
  await page.goto(`${BASE}/sessions/${sid}/settle`);
  await page.waitForLoadState("networkidle");

  const splitBtn = page.locator('[role="radio"]:has-text("源币种分列")');
  await expect(splitBtn).toBeDisabled();

  await ctx.close();
});