/**
 * v0.3.2 USER JOURNEY — Logged-in user walks /invites/{token} → auto-match / /join
 *
 * Per PRD §3.10.5 (v0.3.2 bug fix), /invites/{token} now follows the
 * 4-case dispatch table. This spec covers the **logged-in** rows:
 *
 *   Row 1: 已登录 + 已有 (user_id, session_id) 绑定 → auto-match → /sessions/{id}
 *          (direct redirect, never shows /join)
 *   Row 2: 已登录 + 无绑定 → /sessions/{id}/join (login flow)
 *
 * Two sub-tests:
 *   Test A — owner visits their own /invites/{token} → auto-match (row 1)
 *   Test B — non-owner logged-in user visits /invites/{token} → /join (row 2)
 *
 * iPhone viewport + no cookie injection (per 反模式 #100).
 *
 * To be truly "no cookie injection", the logged-in user walks the real
 * /auth/login UI after we SQL-inject a verification_code (avoids SMTP
 * round-trip per 反模式 #44). Same pattern as story_anon_records_bill.
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
const SHOT_A = (n: number, name: string) =>
  path.join(SCREENSHOTS_DIR, `journey-invite-loggedin-a-${String(n).padStart(2, "0")}-${name}.png`);
const SHOT_B = (n: number, name: string) =>
  path.join(SCREENSHOTS_DIR, `journey-invite-loggedin-b-${String(n).padStart(2, "0")}-${name}.png`);

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

/**
 * Real auth flow WITHOUT SMTP round-trip: SQL-inject a verification_code
 * (per 反模式 #44) and use the login page's `?email=&code=` test-mode
 * pre-fill to jump straight to the verify step. The browser then walks
 * the real verify UI (form submit, BE Set-Cookie) — no cookie injection.
 *
 * Returns the user's default_name (local-part of email) for downstream
 * checks.
 */
async function loginBySqlInjection(
  ctx: BrowserContext,
  email: string
): Promise<string> {
  const db = new Database(SQLITE_PATH);
  try {
    db.prepare(
      "INSERT OR IGNORE INTO users (email, default_name, created_at) VALUES (?, ?, ?)"
    ).run(email, email.split("@")[0], new Date().toISOString());
    const code = "999999";
    db.prepare(
      "INSERT INTO verification_codes (email, code, purpose, session_id, created_at, expires_at, used) VALUES (?, ?, ?, NULL, ?, ?, 0)"
    ).run(
      email,
      code,
      "magic_link",
      new Date().toISOString(),
      new Date(Date.now() + 10 * 60_000).toISOString()
    );
  } finally {
    db.close();
  }

  // Use the login page's test-mode pre-fill: ?email=…&code=999999
  // pre-fills the form AND jumps straight to the verify step on mount.
  // The user still has to click the verify button, so we walk the real
  // BE verify-code endpoint (no SMTP, no cookie injection).
  const loginPage = await ctx.newPage();
  await loginPage.goto(
    `${BASE}/auth/login?next=/sessions&email=${encodeURIComponent(email)}&code=999999`
  );
  await loginPage.waitForLoadState("networkidle");
  // We should be on the verify step. Click "验证" / submit.
  const verifyBtn = loginPage
    .locator('button:has-text("验证"), button[type="submit"]')
    .first();
  await expect(verifyBtn).toBeVisible({ timeout: 5000 });
  await verifyBtn.click();
  await loginPage.waitForURL(/\/sessions/, { timeout: 10000 });
  await loginPage.close();
  return email.split("@")[0];
}

test.beforeAll(() => {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
});

test.beforeEach(() => {
  wipeDb();
});

// ---------------------------------------------------------------------------
// Test A — Owner visits their own /invites/{token}: auto-match (PRD row 1)
// ---------------------------------------------------------------------------
test("JOURNEY (logged-in, owner): /invites/{token} → auto-match → /sessions/{id}", async ({
  browser,
}) => {
  // ===== 第 1 幕: Setup session via owner =====
  // Setup uses ensureUserAndToken for the OWNER fixture only (this is not
  // the actual journey — it's just creating the session + invite token).
  // The journey test below walks the REAL auth UI in a separate browser.
  const owner = ensureUserAndToken("invite-loggedin-a.owner@local.test");
  const setupCtx: BrowserContext = await browser.newContext({
    ignoreHTTPSErrors: true,
  });
  await setupCtx.addCookies([
    {
      name: "sbc_session",
      value: owner.raw_token,
      url: BASE,
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);
  const setupPage = await setupCtx.newPage();

  const createRes = await setupPage.request.post(`${BASE}/api/sessions`, {
    data: {
      name: "Auto-match 测试 session",
      currencies: ["CNY"],
      primary_currency: "CNY",
      member_nicknames: ["X", "Y"],
    },
  });
  expect(createRes.status()).toBe(201);
  const created = await createRes.json();
  const sid = created.id;

  const inviteRes = await setupPage.request.get(
    `${BASE}/api/sessions/${sid}/invite`
  );
  expect(inviteRes.status()).toBe(200);
  const token = (await inviteRes.json()).token;
  expect(token).toBeTruthy();

  await setupCtx.close();

  // ===== 第 2 幕: Owner 走真 auth flow (no cookie injection) =====
  // 用 SQL 注入 verification_code + 真浏览器走 /auth/login. 这样
  // owner 是用 cookie 登录的, 不是 cookie 注入的.
  const ownerCtx: BrowserContext = await browser.newContext({
    ...MOBILE_CONTEXT_OPTS,
    ignoreHTTPSErrors: true,
  });
  await loginBySqlInjection(ownerCtx, "invite-loggedin-a.owner@local.test");
  const ownerPage: Page = await ownerCtx.newPage();

  // Sanity check: owner should now see their session in dashboard
  await ownerPage.goto(`${BASE}/sessions`);
  await ownerPage.waitForLoadState("networkidle");
  const dashText = await ownerPage.locator("body").innerText();
  expect(dashText, "owner should see session in dashboard").toContain(
    "Auto-match 测试 session"
  );

  // ===== 第 3 幕: Owner visits /invites/{token} → auto-match (PRD row 1) =====
  await ownerPage.goto(`${BASE}/invites/${token}`);
  await ownerPage.waitForLoadState("networkidle");

  // PRD §3.10.5 row 1: 已登录 + 已有 (user_id, session_id) 绑定 → /sessions/{id}
  await ownerPage.waitForURL(new RegExp(`/sessions/${sid}$`), { timeout: 10000 });
  await ownerPage.screenshot({ path: SHOT_A(1, "owner-auto-match"), fullPage: true });

  // REGRESSION ASSERTION: must NOT show /join page, must NOT show old "需要登录"
  expect(
    ownerPage.url(),
    "owner (already a member) must auto-match to /sessions/{id}, not /join"
  ).not.toContain("/join");
  const ownerText = await ownerPage.locator("body").innerText();
  expect(ownerText).not.toContain("你需要先登录");
  // No old-style accept form (input#display_name + 加入 session button)
  await expect(ownerPage.locator('input#display_name')).toHaveCount(0);
  await expect(ownerPage.locator('button:has-text("加入 session")')).toHaveCount(0);

  // Session detail should show the session name
  expect(ownerText).toContain("Auto-match 测试 session");

  await ownerCtx.close();
});

// ---------------------------------------------------------------------------
// Test B — Non-owner logged-in user visits /invites/{token}: → /join (PRD row 2)
// ---------------------------------------------------------------------------
test("JOURNEY (logged-in, non-member): /invites/{token} → /join → add new nickname → /sessions/{id}", async ({
  browser,
}) => {
  // ===== 第 1 幕: Setup — owner creates session =====
  const owner = ensureUserAndToken("invite-loggedin-b.owner@local.test");
  const setupCtx: BrowserContext = await browser.newContext({
    ignoreHTTPSErrors: true,
  });
  await setupCtx.addCookies([
    {
      name: "sbc_session",
      value: owner.raw_token,
      url: BASE,
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);
  const setupPage = await setupCtx.newPage();

  const createRes = await setupPage.request.post(`${BASE}/api/sessions`, {
    data: {
      name: "未匹配 → 新建 member 测试",
      currencies: ["CNY"],
      primary_currency: "CNY",
      member_nicknames: ["Placeholder"],
    },
  });
  expect(createRes.status()).toBe(201);
  const created = await createRes.json();
  const sid = created.id;

  const inviteRes = await setupPage.request.get(
    `${BASE}/api/sessions/${sid}/invite`
  );
  const token = (await inviteRes.json()).token;
  expect(token).toBeTruthy();

  await setupCtx.close();

  // ===== 第 2 幕: 第二个 logged-in user (non-member) 走真 auth flow =====
  // 注意: invitee 是真用户, 不是 owner. 走 magic-link SQL 注入 + 真 /auth/login UI.
  const inviteeCtx: BrowserContext = await browser.newContext({
    ...MOBILE_CONTEXT_OPTS,
    ignoreHTTPSErrors: true,
  });
  await loginBySqlInjection(inviteeCtx, "invite-loggedin-b.invitee@local.test");
  const inviteePage: Page = await inviteeCtx.newPage();

  // ===== 第 3 幕: Invite 走 /invites/{token} → /join (PRD row 2) =====
  await inviteePage.goto(`${BASE}/invites/${token}`);
  await inviteePage.waitForLoadState("networkidle");

  // PRD §3.10.5 row 2: 已登录 + 无绑定 → /sessions/{id}/join
  await inviteePage.waitForURL(new RegExp(`/sessions/${sid}/join$`), { timeout: 10000 });
  await inviteePage.screenshot({ path: SHOT_B(1, "invitee-on-join"), fullPage: true });

  // REGRESSION ASSERTION: must NOT show old broken UI
  const joinText = await inviteePage.locator("body").innerText();
  expect(joinText).not.toContain("你需要先登录");
  await expect(inviteePage.locator('input#display_name')).toHaveCount(0);
  await expect(inviteePage.locator('button:has-text("加入 session")')).toHaveCount(0);

  // ===== 第 4 幕: Invite 添加新 nickname (logged-in 用户的 add 流程) =====
  const NEW_NICK_INPUT = 'input[placeholder="你的昵称"]';
  // 注意: /join page 对 logged-in 用户用 placeholder="你的昵称", 不是
  // "你想叫什么名字？" (那是 anon 用的).
  await expect(inviteePage.locator(NEW_NICK_INPUT)).toBeVisible({ timeout: 5000 });

  const NEW_NICK = "Invitee-from-invite";
  await inviteePage.locator(NEW_NICK_INPUT).fill(NEW_NICK);
  await inviteePage.locator('button:has-text("加入")').click();

  // ===== 第 5 幕: Redirect to /sessions/{id} =====
  await inviteePage.waitForURL(new RegExp(`/sessions/${sid}$`), { timeout: 10000 });
  await inviteePage.waitForLoadState("networkidle");
  await inviteePage.screenshot({ path: SHOT_B(2, "after-add"), fullPage: true });

  // ===== 第 6 幕: BE state — invitee 现在是 member, 绑 user_id =====
  const verifyRes = await inviteePage.request.get(`${BASE}/api/sessions/${sid}`);
  expect(verifyRes.status()).toBe(200);
  const detail = await verifyRes.json();

  const inviteeMember = detail.members.find(
    (m: any) => m.display_name === NEW_NICK
  );
  expect(inviteeMember, "invitee should be added as a member").toBeTruthy();
  expect(inviteeMember.role).toBe("member");
  // Critical: invitee's user_id is bound (logged-in flow binds to user)
  expect(
    inviteeMember.user_id,
    "logged-in invitee should have user_id bound (not null like anon)"
  ).toBeGreaterThan(0);

  await inviteeCtx.close();
});