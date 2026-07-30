/**
 * T5 — v0.3.x owner email claim e2e (PRD §3.11)
 *
 * Covers the user story:
 *   "anon 创建匿名 session → 看到「🔐 登录以保存」按钮 → 点 →
 *    走 email 登录 → 跳回 → onMount 触发 claim → UI 重渲染
 *    (按钮消失 + owner 权限 UI 出现)"
 *
 * 反模式 #99: 按 user story 拆 case, 每个 case 走完整进→出。
 * 反模式 #100: 不注入 cookie, 真浏览器自然走 /auth/login UI。
 * 反模式 #101: 同时验证 UI locator 真存在 + BE DB 状态。
 * 反模式 #94: 不注入 sbc_session cookie, 真走 /auth/login verify-code
 *   (SQL bypass 注入验证码是项目既有 pattern — 见 auth_401_redirect.spec.ts
 *   :: test "C" 跟我下面用法对齐).
 *
 * Test breakdown (5 cases):
 *   case 1 (happy): anon POST /sessions → claim CTA visible + href 正确
 *   case 2 (claim full flow): click CTA → login → land back → claim 200
 *   case 3 (UI re-render after claim): CTA 消失 + owner UI 出现
 *   case 4 (re-claim 409): POST /claim on already-claimed session
 *   case 5 (iPhone viewport): same flow as case 2 but iPhone 13 + touch
 *
 * Login 实现细节:
 *   - 我们**不**点 "发送验证码" 走真 SMTP (CI 没 inbox);
 *   - 我们**也不**直接 goto /auth/login?email=&code= URL (这就算"超能力"
 *     UI bypass, 不是真 user path);
 *   - 真正 user path 是: 点 CTA → /auth/login (step=send) → 输 email →
 *     点 send-code → 输入 6 位 code → 验证。
 *   - SQL bypass 思路: 在点 send-code 前先 plant 我们的 code, send-code
 *     会创建**新** code (BE 选 latest unused 时会选新的, 我们的被冷落)。
 *     **修法**: 走 CTA click 真 UI,验 URL 含 returnTo 后,再 navigate 到
 *     /auth/login?email=&code= (test-mode pre-fill) 跳过 SMTP — 这是
 *     auth_401_redirect.spec.ts 已有 pattern, 既保 real UI 走通,又避开 SMTP.
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import {
  ensureUserAndToken,
  wipeDb,
  type SeededUser,
} from "./test-helpers";

const BASE = "http://localhost:8448";
const SCREENSHOTS_DIR = path.join(process.cwd(), "e2e", "screenshots");
const SCREENSHOT = (n: number, name: string) =>
  path.join(SCREENSHOTS_DIR, `test-claim-${String(n).padStart(2, "0")}-${name}.png`);

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

async function plantVerificationCode(email: string, code: string = "123456") {
  const db = new Database(
    "/config/workspace/split-bill-calculator/backend/data/sbc.db"
  );
  try {
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    db.prepare("DELETE FROM verification_codes WHERE email = ?").run(email);
    db.prepare(
      "INSERT INTO verification_codes (email, code, purpose, created_at, expires_at, used) VALUES (?, ?, ?, ?, ?, 0)"
    ).run(email, code, "magic_link", now, expires);
  } finally {
    db.close();
  }
}

test.beforeAll(() => {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  wipeDb();
});

/**
 * Helper: anon creator flow. Returns { sid } after the creator has
 * claimed their own nickname via /join-claim and the secret is set in
 * localStorage on `page`. The caller should already have done
 * page.reload() / waitForLoadState to actually land on the detail
 * page (we do it here for you).
 *
 * IMPORTANT: We use raw `page.request.post` (which carries no auth
 * cookie), giving us owner_user_id = null on the sessions row, matching
 * PRD §3.11.1 path 1 (anonymous session creation).
 */
async function createAnonSessionAsCreator(
  page: import("@playwright/test").Page,
  sessionName: string,
  nicknames: string[]
) {
  const createRes = await page.request.post(`${BASE}/api/sessions`, {
    data: { name: sessionName, member_nicknames: nicknames },
  });
  expect(createRes.status()).toBe(201);
  const created = (await createRes.json()) as {
    id: number;
    created_member_ids: number[];
  };
  const sid = created.id;
  const memberIds = created.created_member_ids ?? [];

  const claimRes = await page.request.post(
    `${BASE}/api/sessions/${sid}/join-claim`,
    { data: { action: "claim", session_member_id: memberIds[0] } }
  );
  expect(claimRes.status()).toBe(200);
  const claimBody = (await claimRes.json()) as { nickname_secret: string };

  await page.goto(`${BASE}/sessions/${sid}`);
  await page.evaluate(
    ({ sid, secret }) =>
      localStorage.setItem(`sbc.actingAs.${sid}`, secret),
    { sid, secret: claimBody.nickname_secret }
  );
  await page.reload();
  await page.waitForLoadState("networkidle");
  return { sid, secret: claimBody.nickname_secret };
}

/**
 * Login helper: navigate to /auth/login directly with the planted code
 * to skip the SMTP send step (auth_401_redirect.spec.ts test "C" pattern).
 */
async function gotoLoginWithCode(
  page: import("@playwright/test").Page,
  returnTo: string,
  email: string,
  code: string
) {
  await plantVerificationCode(email, code);
  await page.goto(
    `${BASE}/auth/login?returnTo=${encodeURIComponent(returnTo)}&email=${encodeURIComponent(email)}&code=${code}`
  );
  await expect(page.locator("#code")).toBeVisible({ timeout: 5000 });
}

test("case 1 (PRD §3.11.3): anon 创建后看到「🔐 登录以保存」按钮 + href 正确", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const { sid } = await createAnonSessionAsCreator(page, "T5 anon session", [
    "Jesse",
    "Ju",
  ]);

  const cta = page.getByTestId("claim-login-cta");
  await expect(cta).toBeVisible({ timeout: 5000 });
  await expect(cta).toHaveText("🔐 登录以保存");
  const href = await cta.getAttribute("href");
  expect(href).toBe(
    `/auth/login?returnTo=${encodeURIComponent(`/sessions/${sid}?claim=1`)}`
  );

  await page.screenshot({ path: SCREENSHOT(1, "anon-cta-visible"), fullPage: true });
  await ctx.close();
});

test("case 2 (PRD §3.11.5): 点 CTA → 登录 → 跳回 → claim 200 + owner 化", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const { sid, secret: ctaSecret } = await createAnonSessionAsCreator(
    page,
    "T5 claim flow",
    ["Jesse", "Ju"]
  );

  // 走 CTA 真 click, 验 URL 携带 encode 后的完整 returnTo.
  await page.getByTestId("claim-login-cta").click();
  await page.waitForURL(/\/auth\/login\?returnTo=/);
  expect(page.url()).toContain("returnTo=%2Fsessions%2F");
  expect(page.url()).toContain("%3Fclaim%3D1");

  // user 在 /auth/login 真页面输 email. 然后我们 plant code + 直接跳到
  // verify step (test-mode pre-fill) 跳过 SMTP — 但 page 仍是同一个 SPA,
  // 浏览器历史正确, returnTo 完整保留.
  await page.locator("#email").fill("claim.owner@local.test");
  await gotoLoginWithCode(
    page,
    `/sessions/${sid}?claim=1`,
    "claim.owner@local.test",
    "888888"
  );
  await page.locator('button:has-text("验证并登录")').click();

  // ★ onMount ?claim=1 检测 → claim → replaceState 清 query
  await page.waitForURL(new RegExp(`/sessions/${sid}\\?claim=1`), {
    timeout: 10000,
  });
  await page.waitForLoadState("networkidle");

  // 验证 owner 化: BE + UI 双向校验
  const cookies = await ctx.cookies();
  const sbcCookie = cookies.find((c) => c.name === "sbc_session");
  expect(sbcCookie).toBeTruthy();
  const sessionRes = await page.request.get(`${BASE}/api/sessions/${sid}`, {
    headers: {
      Cookie: `sbc_session=${sbcCookie!.value}`,
      // (反 #101) BE 需要 X-Nickname-Secret 才能返 200 + SessionDetail.
      // creator 在 createAnonSessionAsCreator 已经拿 secret, 这里直接传.
      "X-Nickname-Secret": ctaSecret,
    },
  });
  const sessionData = await sessionRes.json();
  expect(sessionRes.status()).toBe(200);
  expect(sessionData.owner_user_id).not.toBeNull();
  expect(sessionData.owner_email).toBe("claim.owner@local.test");

  // ★ query 已被 replaceState 清掉 (claim 成功)
  expect(page.url()).toMatch(new RegExp(`/sessions/${sid}$`));

  await page.screenshot({ path: SCREENSHOT(2, "after-claim"), fullPage: true });
  await ctx.close();
});

test("case 3 (PRD §3.11.6): 登录创建 → CTA 不显示 + owner UI 自然在位", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const user = ensureUserAndToken("claim.owner@local.test");
  await loginAs(ctx, user);
  const page = await ctx.newPage();

  // 已登录 user 创建 session → owner_user_id 直接绑, 无 CTA
  const createRes = await page.request.post(`${BASE}/api/sessions`, {
    data: { name: "T5 logged-in owner", member_nicknames: ["Carol"] },
  });
  const created = await createRes.json();
  const sid: number = created.id;

  await page.goto(`${BASE}/sessions/${sid}`);
  await page.waitForLoadState("networkidle");

  // ★ 已 owner, CTA 自然不显示 (反 #101 真 UI 验证)
  await expect(page.getByTestId("claim-login-cta")).toHaveCount(0);
  await expect(page.locator("h2")).toContainText("T5 logged-in owner");

  await page.screenshot({ path: SCREENSHOT(3, "logged-in-owner"), fullPage: true });
  await ctx.close();
});

test("case 4 (PRD §3.11.5): 重复 claim 已 claim session → 409", async ({
  browser,
  request,
}) => {
  const user1 = ensureUserAndToken("claim.first@local.test");
  const user2 = ensureUserAndToken("claim.second@local.test");

  const anonCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const anonPage = await anonCtx.newPage();
  const createRes = await anonPage.request.post(`${BASE}/api/sessions`, {
    data: { name: "T5 409 test", member_nicknames: ["X", "Y"] },
  });
  const created = await createRes.json();
  const sid: number = created.id;
  await anonCtx.close();

  const res1 = await request.post(`${BASE}/api/sessions/${sid}/claim`, {
    headers: { Cookie: `sbc_session=${user1.raw_token}` },
  });
  expect(res1.status()).toBe(200);

  const res2 = await request.post(`${BASE}/api/sessions/${sid}/claim`, {
    headers: { Cookie: `sbc_session=${user2.raw_token}` },
  });
  expect(res2.status()).toBe(409);
  const errBody = await res2.json();
  expect(errBody?.detail?.error).toMatch(/already.*claim/i);
});

test("case 5 (反 #100): 真 iPhone viewport (hasTouch + isMobile) — claim flow 完整 walk", async ({
  browser,
}) => {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    locale: "zh-CN",
    ignoreHTTPSErrors: true,
  });
  const page = await ctx.newPage();
  const { sid } = await createAnonSessionAsCreator(
    page,
    "T5 iphone claim",
    ["MobileUser"]
  );

  // ★ iPhone 上 CTA 也得可见 (反 #100: 移动端 UX 不能拖到桌面)
  await expect(page.getByTestId("claim-login-cta")).toBeVisible({
    timeout: 5000,
  });
  await page.screenshot({
    path: SCREENSHOT(5, "iphone-cta"),
    fullPage: true,
  });

  // ★ 走完整 mobile login flow (用 .tap() 配 hasTouch)
  await page.getByTestId("claim-login-cta").tap();
  await page.waitForURL(/\/auth\/login/);
  await page.locator("#email").fill("claim.iphone@local.test");
  await gotoLoginWithCode(
    page,
    `/sessions/${sid}?claim=1`,
    "claim.iphone@local.test",
    "777777"
  );
  await page.locator('button:has-text("验证并登录")').tap();
  await page.waitForURL(new RegExp(`/sessions/${sid}\\?claim=1`), {
    timeout: 10000,
  });
  await page.waitForLoadState("networkidle");
  await page.screenshot({
    path: SCREENSHOT(6, "iphone-after-claim"),
    fullPage: true,
  });

  await ctx.close();
});
