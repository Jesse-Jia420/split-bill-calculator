/**
 * settle_view_split.spec.ts — v0.3.14.1 e2e coverage for view=split
 *
 * 反 #99 (按 user story 拆, 不按组件):
 *   作为多币种 session 的用户, 我能在「主币种汇总」和「原始数据」之间切换,
 *   来核验换算 (主币种汇总 = 全部换算到主币种) vs 源币种明细 (原始数据 = 按账单源币种).
 *
 * 反 #129 (测试根据 SPEC + PRD §3.14.4 §E 写):
 *   SPEC §3.14.4 §E BUG #4: 按钮 "源币种分列" → "原始数据", 文案保留主币种汇总 (CNY),
 *   单币种 session 的"原始数据"按钮 disabled (文案 "该 session 只有一种币种").
 *
 * 反 #100 (真 prod context, 不 mock):
 *   - iPhone 13 viewport (390x844, hasTouch, isMobile)
 *   - 真 cookie: sbc_session, 走真实 dev bypass 登录 (demo@example.com + 任何 6 位)
 *   - 真实 BE (localhost:8449) + Vite dev proxy (localhost:8448)
 *   - 真 DB (backend/data/sbc.db), seed_dev_data.py 启动时种 xinhua1001 用户
 *
 * 反 #132 (自己跑测试, 不信 Coder):
 *   本 spec 由 Tester Agent 自行执行, 失败/通过都在最终报告里列出.
 *
 * 不动 backend 代码, 不写 commit (留给 Master).
 */

import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const BASE = "http://localhost:8448";
const LOGIN_EMAIL = "demo@example.com";
const VERIFY_CODE = "123456";
const VIEWPORT = { width: 390, height: 844 };

const SCREENSHOTS_DIR = path.join(process.cwd(), "e2e", "screenshots");
const SHOT = (n: number, name: string) =>
  path.join(SCREENSHOTS_DIR, `v0.3.14.1-${String(n).padStart(2, "0")}-${name}.png`);

async function loginAsXinhua(page: Page): Promise<void> {
  const sendRes = await page.request.post(`${BASE}/api/auth/send-code`, {
    data: { email: LOGIN_EMAIL },
  });
  expect(sendRes.status(), "send-code 200").toBe(200);
  const verifyRes = await page.request.post(`${BASE}/api/auth/verify-code`, {
    data: { email: LOGIN_EMAIL, code: VERIFY_CODE },
  });
  expect(verifyRes.status(), "verify-code 200").toBe(200);
  const meRes = await page.request.get(`${BASE}/api/auth/me`);
  expect(meRes.status(), "/auth/me should be 200 after login").toBe(200);
  const me = await meRes.json();
  expect(me.email).toBe(LOGIN_EMAIL);
}

interface SeededMember { id: number; display_name: string; role: string; }
interface SeededSession { sid: number; members: SeededMember[]; }

async function seedMultiCurrencySession(
  page: Page,
  name: string,
  nicknames: string[],
  bills: { amount: number; currency: string; payerIdx: number; description: string }[]
): Promise<SeededSession> {
  const createRes = await page.request.post(`${BASE}/api/sessions`, {
    data: {
      name,
      currencies: ["CNY", "JPY"],
      primary_currency: "CNY",
      exchange_rates: [{ from_currency: "JPY", to_currency: "CNY", rate: "0.05" }],
      member_nicknames: nicknames,
    },
  });
  expect(createRes.status(), "POST /api/sessions should be 201").toBe(201);
  const created = await createRes.json();
  const sid = created.id;
  expect(sid).toBeGreaterThan(0);

  const detailRes = await page.request.get(`${BASE}/api/sessions/${sid}`);
  expect(detailRes.status(), "GET /api/sessions/{id} should be 200").toBe(200);
  const detail = await detailRes.json();
  expect(detail.currencies).toEqual(["CNY", "JPY"]);
  expect(detail.primary_currency).toBe("CNY");
  const members = detail.members as SeededMember[];
  // Owner (logged-in user) is always member[0]; nicknames fill slots[1..N]
  expect(members.length, "owner + nicknames members").toBe(nicknames.length + 1);

  const allMemberIds = members.map((m) => m.id);
  for (const b of bills) {
    const billRes = await page.request.post(`${BASE}/api/sessions/${sid}/bills`, {
      data: {
        amount: b.amount, currency: b.currency, payer_member_id: members[b.payerIdx].id,
        occurred_at: new Date().toISOString(), description: b.description,
        participants: allMemberIds.map((mid) => ({ member_id: mid, is_exclusive: false, exclusive_amount: 0 })),
        amount_expression: String(b.amount), use_calculator: false,
      },
    });
    if (billRes.status() !== 201) {
      throw new Error(`POST bill failed: ${billRes.status()} ${await billRes.text()}`);
    }
  }
  return { sid, members };
}

async function seedSingleCurrencySession(page: Page, name: string, nicknames: string[]): Promise<SeededSession> {
  const createRes = await page.request.post(`${BASE}/api/sessions`, {
    data: { name, currencies: ["CNY"], primary_currency: "CNY", member_nicknames: nicknames },
  });
  expect(createRes.status(), "POST /api/sessions should be 201").toBe(201);
  const created = await createRes.json();
  const sid = created.id;
  const detailRes = await page.request.get(`${BASE}/api/sessions/${sid}`);
  expect(detailRes.status()).toBe(200);
  const detail = await detailRes.json();
  const members = detail.members as SeededMember[];
  expect(members.length, "owner + nicknames").toBe(nicknames.length + 1);
  const memberIds = members.map((m) => m.id);
  const billRes = await page.request.post(`${BASE}/api/sessions/${sid}/bills`, {
    data: {
      amount: 100, currency: "CNY", payer_member_id: memberIds[0],
      occurred_at: new Date().toISOString(), description: "Lunch CNY",
      participants: memberIds.map((mid) => ({ member_id: mid, is_exclusive: false, exclusive_amount: 0 })),
      amount_expression: "100", use_calculator: false,
    },
  });
  expect(billRes.status(), "POST bill should be 201").toBe(201);
  return { sid, members };
}

test.beforeAll(() => { fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true }); });

// ───────────────────────────────────────────────────────────────────────────
// (a) 主场景: view=split 展示按源币种明细
// ───────────────────────────────────────────────────────────────────────────

test("(a) view=split shows multi-currency breakdown (主场景)", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: VIEWPORT, hasTouch: true, isMobile: true, locale: "zh-CN", ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await loginAsXinhua(page);

  const { sid } = await seedMultiCurrencySession(
    page, "TEST-SPLIT (a) dual", ["Alice", "Bob", "Carol"],
    [
      { amount: 1000, currency: "CNY", payerIdx: 0, description: "Dinner CNY" },
      { amount: 5000, currency: "JPY", payerIdx: 1, description: "Coffee JPY" },
    ]
  );

  await page.goto(`${BASE}/sessions/${sid}/settle`);
  await page.waitForLoadState("networkidle");
  const viewSwitch = page.locator('[role="radiogroup"][aria-label="结算视图"]');
  await expect(viewSwitch).toBeVisible({ timeout: 5000 });

  const primaryBtn = page.locator('[role="radio"]:has-text("主币种汇总")');
  const splitBtn = page.locator('[role="radio"]:has-text("原始数据")');
  await expect(primaryBtn).toHaveAttribute("aria-checked", "true");
  await expect(splitBtn).toHaveAttribute("aria-checked", "false");
  await expect(splitBtn).toBeEnabled();
  await page.screenshot({ path: SHOT(1, "default-primary"), fullPage: true });

  const splitResponsePromise = page.waitForResponse(
    (r) => r.url().includes(`/sessions/${sid}/settle`) && r.url().includes("view=split")
  );
  await splitBtn.click();
  const splitResponse = await splitResponsePromise;
  expect(splitResponse.status(), "split view API should be 200").toBe(200);

  await expect(splitBtn).toHaveAttribute("aria-checked", "true");
  await expect(primaryBtn).toHaveAttribute("aria-checked", "false");
  await page.screenshot({ path: SHOT(2, "view-split-active"), fullPage: true });

  const splitJson = await splitResponse.json();
  expect(splitJson.view, "response.view should be 'split'").toBe("split");
  expect(splitJson.primary_currency).toBe("CNY");
  expect(splitJson.currencies).toEqual(["CNY", "JPY"]);

  const allBillCurrencies = new Set<string>();
  for (const pm of splitJson.per_member ?? []) {
    for (const bill of pm.paid_bills ?? []) allBillCurrencies.add(bill.currency);
    for (const bill of pm.consumed_bills ?? []) allBillCurrencies.add(bill.currency);
  }
  expect(allBillCurrencies.has("JPY"), "split view per_member breakdown should expose JPY source currency").toBe(true);
  expect(allBillCurrencies.has("CNY"), "split view per_member breakdown should expose CNY source currency").toBe(true);

  await ctx.close();
});

// ───────────────────────────────────────────────────────────────────────────
// (b) view=split 跟 view=primary 的视觉/数据差异
// ───────────────────────────────────────────────────────────────────────────

test("(b) view=primary vs view=split differ in API + DOM", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: VIEWPORT, hasTouch: true, isMobile: true, locale: "zh-CN", ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await loginAsXinhua(page);

  const { sid } = await seedMultiCurrencySession(
    page, "TEST-SPLIT (b) dual", ["Alice", "Bob", "Carol"],
    [
      { amount: 1000, currency: "CNY", payerIdx: 0, description: "Dinner CNY" },
      { amount: 5000, currency: "JPY", payerIdx: 1, description: "Coffee JPY" },
    ]
  );

  await page.goto(`${BASE}/sessions/${sid}/settle`);
  await page.waitForLoadState("networkidle");
  const viewSwitch = page.locator('[role="radiogroup"][aria-label="结算视图"]');
  await expect(viewSwitch).toBeVisible({ timeout: 5000 });

  const primaryBtn = page.locator('[role="radio"]:has-text("主币种汇总")');
  const splitBtn = page.locator('[role="radio"]:has-text("原始数据")');

  // Default view=primary loaded on page.goto; no API call on re-click
  await expect(primaryBtn).toHaveAttribute("aria-checked", "true");
  // Fetch primary view explicitly for API contract verification
  const primaryApi = await page.request.get(`${BASE}/api/sessions/${sid}/settle?view=primary`);
  expect(primaryApi.status()).toBe(200);
  const primaryJson = await primaryApi.json();
  expect(primaryJson.view).toBe("primary");
  expect(primaryJson.primary_currency).toBe("CNY");
  expect(primaryJson.currencies).toEqual(["CNY", "JPY"]);
  await page.screenshot({ path: SHOT(3, "view-primary"), fullPage: true });

  const splitResponsePromise = page.waitForResponse(
    (r) => r.url().includes(`/sessions/${sid}/settle`) && r.url().includes("view=split")
  );
  await splitBtn.click();
  const splitResponse = await splitResponsePromise;
  expect(splitResponse.status()).toBe(200);
  const splitJson = await splitResponse.json();
  expect(splitJson.view).toBe("split");
  expect(splitJson.primary_currency).toBe("CNY");
  await page.screenshot({ path: SHOT(4, "view-split"), fullPage: true });

  await expect(splitBtn).toHaveAttribute("aria-checked", "true");
  await expect(primaryBtn).toHaveAttribute("aria-checked", "false");
  const splitHasActiveClass = await splitBtn.evaluate((el) => el.classList.contains("active"));
  const primaryHasActiveClass = await primaryBtn.evaluate((el) => el.classList.contains("active"));
  expect(splitHasActiveClass, "split btn should have .active class").toBe(true);
  expect(primaryHasActiveClass, "primary btn should not have .active class").toBe(false);

  const norm = (n: any) => Number(n).toFixed(2);
  const primaryTotals = (primaryJson.per_member ?? []).map((pm: any) => ({
    mid: pm.member_id, paid: norm(pm.total_paid), consumed: norm(pm.total_consumed), net: norm(pm.net),
  }));
  const splitTotals = (splitJson.per_member ?? []).map((pm: any) => ({
    mid: pm.member_id, paid: norm(pm.total_paid), consumed: norm(pm.total_consumed), net: norm(pm.net),
  }));
  expect(splitTotals, "primary vs split per-member totals should be identical in primary currency").toEqual(primaryTotals);
  expect(primaryJson.view).not.toBe(splitJson.view);

  await ctx.close();
});

// ───────────────────────────────────────────────────────────────────────────
// (c) 单币种守卫: 单币种 session "原始数据" 按钮 disabled
// ───────────────────────────────────────────────────────────────────────────

test("(c) view=split is disabled for single-currency session (守卫)", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: VIEWPORT, hasTouch: true, isMobile: true, locale: "zh-CN", ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await loginAsXinhua(page);

  const { sid } = await seedSingleCurrencySession(page, "TEST-SPLIT (c) single", ["Solo A", "Solo B"]);

  await page.goto(`${BASE}/sessions/${sid}/settle`);
  await page.waitForLoadState("networkidle");
  const viewSwitch = page.locator('[role="radiogroup"][aria-label="结算视图"]');
  await expect(viewSwitch).toBeVisible({ timeout: 5000 });

  const primaryBtn = page.locator('[role="radio"]:has-text("主币种汇总")');
  const splitBtn = page.locator('[role="radio"]:has-text("原始数据")');

  await expect(splitBtn).toBeDisabled();
  await expect(primaryBtn).toBeEnabled();
  await expect(primaryBtn).toHaveAttribute("aria-checked", "true");
  await expect(splitBtn).toHaveAttribute("aria-checked", "false");
  await page.screenshot({ path: SHOT(5, "single-currency-disabled"), fullPage: true });

  const titleAttr = await splitBtn.getAttribute("title");
  expect(titleAttr, "disabled split btn should have title containing '一种币种' per SPEC §3.14.4 §E").toContain("一种币种");

  await expect(viewSwitch).toBeVisible();
  await expect(splitBtn).toBeVisible();

  await ctx.close();
});
