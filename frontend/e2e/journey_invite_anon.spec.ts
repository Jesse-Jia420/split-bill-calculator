/**
 * v0.3.2 USER JOURNEY — Anon walks /invites/{token} → /join → claim → session
 *
 * Per PRD §3.10.5 (v0.3.2 bug fix), /invites/{token} now follows the
 * 4-case dispatch table:
 *   | 访问者状态                                | 行为                                          |
 *   | 已登录 + 已有 (user_id, session_id) 绑定  | auto-match → /sessions/{id}                  |
 *   | 已登录 + 无绑定                            | → /sessions/{id}/join                        |
 *   | 未登录 / 匿名 (无 secret)                  | → /sessions/{id}/join                        |
 *   | 匿名 + localStorage 有 sbc.actingAs.{sid} | FE 自动取 secret → BE 验证 → /sessions/{id}  |
 *
 * This spec covers the **anonymous, no secret** case (PRD row 3):
 *   - Owner (logged-in) creates a session, reads the invite token
 *   - Anonymous browser (fresh context, no cookies, no localStorage)
 *     visits /invites/{token}
 *   - FE auto-dispatches → /sessions/{id}/join (NOT the old "需要先登录" page)
 *   - Anon claims an existing unclaimed placeholder slot
 *   - FE sets sbc.actingAs.{sid} and redirects to /sessions/{id}
 *
 * iPhone viewport + no cookie injection (per 反模式 #100).
 *
 * Why this spec exists (regression coverage):
 *   Before v0.3.2 fix, anon visiting /invites/{token} saw
 *   "你需要先登录才能加入 session" + a button to /auth/login (forced login).
 *   This violated the PRD §3.10.5 table.
 */
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import { ensureUserAndToken, wipeDb } from "./test-helpers";

const BASE = "http://localhost:8448";
const SQLITE_PATH =
  process.env.SBC_SQLITE_PATH ??
  "/config/workspace/split-bill-calculator/backend/data/sbc.db";
const SCREENSHOTS_DIR = path.join(process.cwd(), "e2e", "screenshots");
const SHOT = (n: number, name: string) =>
  path.join(SCREENSHOTS_DIR, `journey-invite-anon-${String(n).padStart(2, "0")}-${name}.png`);

// 真 iPhone viewport — 旧 spec 用 default (1280x720), 漏了 mobile-only bug
const IPHONE_VIEWPORT = { width: 390, height: 844 } as const;
const MOBILE_CONTEXT_OPTS = {
  viewport: IPHONE_VIEWPORT,
  hasTouch: true,
  isMobile: true,
  locale: "zh-CN",
  deviceScaleFactor: 3,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
} as const;

async function loginAs(ctx: BrowserContext, rawToken: string) {
  // Setup-only helper for the OWNER context that creates the session.
  // The ANON context used in the actual journey test never receives
  // any cookies — it's a fresh, real-anon flow.
  await ctx.addCookies([
    {
      name: "sbc_session",
      value: rawToken,
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

test("JOURNEY (anon, no secret): /invites/{token} → /join → claim slot → /sessions/{id}", async ({
  browser,
}) => {
  // ===== 第 1 幕: Setup — owner 创建 session + 拿 invite token =====
  // Owner 用 cookie 注入登录, 因为这只为 set up 测试 fixture.
  // 真正的 anon journey 在独立的 fresh context 里跑.
  const owner = ensureUserAndToken("invite-anon.owner@jessejia.local");
  const ownerCtx: BrowserContext = await browser.newContext({
    ignoreHTTPSErrors: true,
  });
  await loginAs(ownerCtx, owner.raw_token);
  const ownerPage: Page = await ownerCtx.newPage();

  // Create session via direct API (3 unclaimed placeholders so /join has slots)
  const createRes = await ownerPage.request.post(`${BASE}/api/sessions`, {
    data: {
      name: "邀请测试 session",
      currencies: ["CNY"],
      primary_currency: "CNY",
      member_nicknames: ["Alice", "Bob", "Carol"],
    },
  });
  expect(createRes.status()).toBe(201);
  const created = await createRes.json();
  const sid = created.id;
  expect(sid).toBeGreaterThan(0);

  // Get invite token via owner-only API
  const inviteRes = await ownerPage.request.get(`${BASE}/api/sessions/${sid}/invite`);
  expect(inviteRes.status()).toBe(200);
  const invite = await inviteRes.json();
  const token = invite.token;
  expect(token).toMatch(/^[A-Za-z0-9_-]{16,}$/);
  expect(invite.status).toBe("active");

  // ===== 第 2 幕: Anon (fresh mobile context, no cookies, no localStorage) =====
  const anonCtx: BrowserContext = await browser.newContext({
    ...MOBILE_CONTEXT_OPTS,
    ignoreHTTPSErrors: true,
  });
  const page: Page = await anonCtx.newPage();

  // Verify clean slate
  await page.goto(`${BASE}/`);
  await page.evaluate(() => localStorage.clear());
  await page.context().clearCookies();

  // Visit /invites/{token}
  await page.goto(`${BASE}/invites/${token}`);
  await page.waitForLoadState("networkidle");

  // ===== 第 3 幕: 4-case dispatch — anon no secret → /join =====
  // PRD §3.10.5 row 3: anon + no sbc.actingAs.{sid} → /sessions/{id}/join
  await page.waitForURL(new RegExp(`/sessions/${sid}/join$`), { timeout: 10000 });
  await page.screenshot({ path: SHOT(1, "anon-on-join-page"), fullPage: true });

  // REGRESSION ASSERTION: /invites/{token} must NOT show the old broken UI
  // (the v0.2.x "你需要先登录" text + login button).
  const bodyText = await page.locator("body").innerText();
  expect(
    bodyText,
    "/invites/{token} anon flow must NOT show the old '需要登录' forced-login UI"
  ).not.toContain("你需要先登录");
  // Also must NOT show the manual "加入 session" button (with manual accept flow)
  // — the only legitimate path now is to claim a slot or add a new nickname.
  await expect(page.locator('button:has-text("加入 session")')).toHaveCount(0);

  // Should see at least one unclaimed slot button (Alice / Bob / Carol)
  const slotButtons = page.locator(".slot-btn");
  await expect(slotButtons.first()).toBeVisible({ timeout: 5000 });
  const slotCount = await slotButtons.count();
  expect(slotCount).toBeGreaterThanOrEqual(3);

  // ===== 第 4 幕: Anon claims Alice's slot =====
  await page.locator('.slot-btn:has-text("Alice")').click();

  // ===== 第 5 幕: Redirect to /sessions/{id} + secret stored =====
  await page.waitForURL(new RegExp(`/sessions/${sid}$`), { timeout: 10000 });
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: SHOT(2, "anon-after-claim"), fullPage: true });

  // localStorage secret was set
  const secret = await page.evaluate(
    (id) => localStorage.getItem(`sbc.actingAs.${id}`),
    sid
  );
  expect(secret, "sbc.actingAs.{sid} should be set after claim").toBeTruthy();
  expect(secret!.length, "secret should be non-trivial hex").toBeGreaterThan(20);

  // ===== 第 6 幕: BE state check — anon is now a member =====
  const verifyRes = await page.request.get(`${BASE}/api/sessions/${sid}`, {
    headers: { "X-Nickname-Secret": secret! },
  });
  expect(verifyRes.status()).toBe(200);
  const detail = await verifyRes.json();

  // 4 members: owner (user_id=owner.user_id) + Alice/Bob/Carol placeholders
  expect(detail.members.length).toBe(4);

  // Alice should be claimed by our anon user (user_id=null, role=member, NOT owner)
  const alice = detail.members.find((m: any) => m.display_name === "Alice");
  expect(alice).toBeTruthy();
  expect(alice.role, "Alice is a member slot (not owner)").toBe("member");
  expect(alice.user_id).toBeNull();
  expect(alice.email, "anon claimer has no email").toBeNull();

  // Owner is in the members list with role=owner
  const ownerMember = detail.members.find((m: any) => m.role === "owner");
  expect(ownerMember, "owner must be a member").toBeTruthy();
  expect(ownerMember.user_id).toBe(owner.user_id);

  await page.screenshot({ path: SHOT(3, "members-verified"), fullPage: true });

  await ownerCtx.close();
  await anonCtx.close();
});

// ---------------------------------------------------------------------------
// Test B — Anon walks /invites/{token} → /join → 新建一个角色（昵称）
//          (covers the "new role" path, distinct from the "claim existing
//          placeholder" path tested above)
// ---------------------------------------------------------------------------
test("JOURNEY (anon, new role): /invites/{token} → /join → 新建一个角色 → /sessions/{id}", async ({
  browser,
}) => {
  // ===== 第 1 幕: Setup — owner creates session with placeholders =====
  const owner = ensureUserAndToken("invite-anon-new.owner@jessejia.local");
  const ownerCtx: BrowserContext = await browser.newContext({
    ignoreHTTPSErrors: true,
  });
  await loginAs(ownerCtx, owner.raw_token);
  const ownerPage: Page = await ownerCtx.newPage();

  const createRes = await ownerPage.request.post(`${BASE}/api/sessions`, {
    data: {
      name: "新建角色 测试 session",
      currencies: ["CNY"],
      primary_currency: "CNY",
      member_nicknames: ["Existing-A", "Existing-B"],
    },
  });
  expect(createRes.status()).toBe(201);
  const created = await createRes.json();
  const sid = created.id;

  const inviteRes = await ownerPage.request.get(
    `${BASE}/api/sessions/${sid}/invite`
  );
  const token = (await inviteRes.json()).token;
  expect(token).toBeTruthy();

  await ownerCtx.close();

  // ===== 第 2 幕: Anon (fresh mobile context) visits /invites/{token} =====
  const anonCtx: BrowserContext = await browser.newContext({
    ...MOBILE_CONTEXT_OPTS,
    ignoreHTTPSErrors: true,
  });
  const page: Page = await anonCtx.newPage();

  await page.goto(`${BASE}/`);
  await page.evaluate(() => localStorage.clear());
  await page.context().clearCookies();

  await page.goto(`${BASE}/invites/${token}`);
  await page.waitForLoadState("networkidle");

  // FE 4-case dispatch — anon no secret → /join
  await page.waitForURL(new RegExp(`/sessions/${sid}/join$`), { timeout: 10000 });
  await page.screenshot({ path: SHOT(10, "anon-newrole-on-join"), fullPage: true });

  // ===== 第 3 幕: Verify the "新建一个角色" label is visible =====
  // The /join page's anon section now uses "新建一个角色（昵称）" so
  // anons can see at a glance that they can also create a new role
  // (not just claim an existing placeholder).
  await expect(
    page.locator("text=新建一个角色（昵称）"),
    "anon /join must show the clearer '新建一个角色（昵称）' label"
  ).toBeVisible({ timeout: 5000 });
  await expect(
    page.locator('input[placeholder="你想叫什么名字？"]'),
    "anon /join must still render the new-nickname input"
  ).toBeVisible();

  // ===== 第 4 幕: Anon types a new nickname + clicks 加入 (does NOT claim) =====
  const NEW_ROLE = "Brand-New-Role";
  await page.locator('input[placeholder="你想叫什么名字？"]').fill(NEW_ROLE);
  await page.locator('button:has-text("加入")').click();

  // ===== 第 5 幕: Redirect to /sessions/{id} + secret stored =====
  await page.waitForURL(new RegExp(`/sessions/${sid}$`), { timeout: 10000 });
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: SHOT(11, "anon-newrole-after-add"), fullPage: true });

  const secret = await page.evaluate(
    (id) => localStorage.getItem(`sbc.actingAs.${id}`),
    sid
  );
  expect(secret, "sbc.actingAs.{sid} should be set after add").toBeTruthy();

  // ===== 第 6 幕: BE state — the new role exists in the members list =====
  const verifyRes = await page.request.get(`${BASE}/api/sessions/${sid}`, {
    headers: { "X-Nickname-Secret": secret! },
  });
  expect(verifyRes.status()).toBe(200);
  const detail = await verifyRes.json();

  // 4 members: owner + Existing-A + Existing-B + Brand-New-Role
  expect(detail.members.length).toBe(4);

  const newRoleMember = detail.members.find(
    (m: any) => m.display_name === NEW_ROLE
  );
  expect(newRoleMember, "the new role must be in the members list").toBeTruthy();
  expect(newRoleMember.role).toBe("member");
  expect(newRoleMember.user_id, "anon add is unclaimed (user_id=null)").toBeNull();
  expect(newRoleMember.email).toBeNull();

  // Original placeholders must still be unclaimed (we did NOT touch them)
  for (const name of ["Existing-A", "Existing-B"]) {
    const m = detail.members.find((x: any) => x.display_name === name);
    expect(m, `${name} should still exist`).toBeTruthy();
    expect(m.user_id, `${name} should still be unclaimed`).toBeNull();
  }

  await anonCtx.close();
});