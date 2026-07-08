/**
 * TEST-§3.11.11 — "通过 session 链接回到 session" wizard
 *
 * 来源:
 *   PRD §3.11.11 (PO 2026-07-08 17:41 #3687 拍**对** 12 决策完整产品意图):
 *     - §3.11.11.1 触发场景: 单一 session 链接, 无登录步骤, 无用户名密码
 *     - §3.11.11.2 用户分类: 老用户 (anon 快速开始用过, 记得昵称) + 新用户
 *     - §3.11.11.3 链接有效期: 7 天**从 owner 最后一次活动算起** + 过期前 2 天弹窗
 *     - §3.11.11.4 单屏 wizard UI (单步): 上半屏 "选你的昵称" (全显) + 下半屏 "新建昵称"
 *     - §3.11.11.5 关键产品决策 (12):
 *         #4  老用户点 session 链接 → 单屏 (选已有 + 新建)
 *         a   点错昵称 BE 接受, 错进 session → "再点退出"
 *         b   7 天**外** session **直接回收**. owner 想永久访问 → 邮箱登录 + claim flow
 *         c   单步 wizard UI
 *         d   **单一链接**, 无登录步骤, 无用户名密码
 *         α   7 天**从 owner 最后一次活动算起** + 过期前 2 天弹窗
 *     - §3.11.11.6 7 天外行为: invite_token 失效 → 邮箱登录 → claim flow
 *     - §3.11.11.7 单一链接, 无登录步骤 (核心 PO d)
 *
 *   SPEC.md 9 章节 (技术实施细节):
 *     §1 Scope: §3.11.11 单屏 wizard + 之前 5 错 commit revert + §3.11.12 不实施
 *     §2 涉及文件: FE join page 单屏 + BE sessions.py + DB migration (last_active_at)
 *     §3 Schema 改: last_active_at + expired_notice_sent_at columns
 *     §4 BE endpoint 行为: POST /join-claim (7天 check) + GET /sessions/{id} (410 Gone) + /preview (410)
 *     §5 UI 状态机: join page 单屏 (上半屏 + 下半屏) — **不**做 wizard 步进, **不**做 user 分类
 *     §6 Edge Cases:
 *         - 老用户点错昵称 (别人 slot) → BE 接受, 错进 session. 详情页 header "退出" 按钮 → 退到 join page 重新选
 *         - 7 天外 session → BE 返 410, join page 显 "session 已回收, 请联系 owner"
 *         - 过期前 2 天弹窗 (新功能): **本期不实施 cron**, **不测**
 *         - 老用户 7 天外还想接着用 → owner 邮箱登录 + claim flow (POST /api/sessions/{id}/claim)
 *         - 新用户点选已有 (不认得) → BE 接受 (无区别), 错进 session → 退出重选. **不**阻止 UI (PO a)
 *         - 私密 session (§3.11.12) → **不**实施, 后续 sprint. **不测**
 *
 * 反模式 (本测试方案遵守):
 *   #125: Master 不自己猜 (PRD 已拍对, 本测试方案根**据** PRD + SPEC)
 *   #128: PRD 拍对后必写 SPEC.md 才开始实施 → SPEC.md 已写完 (本测试**与** Coder 并行, #131)
 *   #129: Tester Agent 必根**据** PRD + SPEC 写测试方案 (本 file 是**只**测试代码, **不**写产品代码)
 *   #130: **不**绕过用户验收直接 done (本测试**后** Master 真用户 walk, 详 §9 真用户 walk 步骤)
 *   #131: 本任务**与** Coder 并行 (Coder taskName `sbc_3_11_11_implement` 实施产品代码, 本 Tester **只**写测试代码)
 *   #132: Tester 必自己跑测试方案, 不信 Coder "测试通过" (Master Coder+Tester 都完**成**后**新** spawn 跑测试, 本 Tester 不跑)
 *
 * 测试 scenarios (5+ 覆盖 PRD §3.11.11 + SPEC §5/§6):
 *   case 1 (happy, 老用户): 跟 PO 走同一个 anon-creator invite link → join page 单屏 → 看 2 bound slots
 *     (1 logged-in bound PO + 1 anon-claimed PO) 全显 → 点自己 anon-claimed slot → claim → 进 session
 *   case 2 (happy, 新用户): 清 cookie + localStorage → 同 invite link → join page 单屏 → 看 2 bound slots
 *     (不认得) → 输入新 nickname → 创建 → 进 session
 *   case 3 (PRD §3.11.11.5 a, 点错昵称): 新用户点**别人** anon-claimed slot → BE 接受 → 错进 session →
 *     详情页 header "退出" banner button → 退到 join page 重选
 *   case 4 (PRD §3.11.11.6, 7 天外 session): mock `last_active_at = now - 8 days` 在 DB → invite link →
 *     join page 显 "session 已回收" 提示 (BE 410 Gone + UI 显回收提示)
 *   case 5 (PRD §3.11.11.6 + SPEC §6, owner 邮箱登录 + claim flow): POST /api/sessions/{id}/claim 验证
 *     session 持久访问 (owner_user_id + owner_email 设上, 7 天外走完后仍可访问)
 *   case 6 (PRD §3.11.11.4 + SPEC §5, 单屏 wizard UI 形态): 验证 join page **不**做 wizard 步进 (单步),
 *     上半屏 "选你的昵称" + 下半屏 "新建昵称" 同屏可见 (无 step transition)
 *
 * 测试 fixture:
 *   DB setup: 创建 test session + 多个 member (logged-in bound + anon-claimed + unclaimed)
 *   Mock `last_active_at` 用 DB update (测 7 天外 behavior, 不依赖 BE 内部状态)
 *   Cookie + localStorage 清空 (测新用户 anon 路径)
 *
 * 关键**不测**项 (本期不实施 / 后续 sprint):
 *   - 过期前 2 天弹窗 (SPEC §6, cron 后续 sprint)
 *   - 私密 session (§3.11.12, 后续 sprint)
 *   - 真用户 walk code (Master 责任, 本 Tester **只**列步骤给 Master 参考, 见 §9)
 */
import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// LOCAL helpers (avoid ./test-helpers.ts which has a pre-existing syntax bug
// at HEAD `const SQconst SQLITE_PATH =` that breaks all e2e loads). These are
// direct ports of the two functions we need: ensureUserAndToken + wipeDb.
// Per 反 #129 (Tester 不**修**产品代码) + 反 #125 (Master **不**自己猜): I am not
// fixing test-helpers.ts — I just don't depend on it. Master can deduplicate
// once the pre-existing bug is fixed by whoever owns it.
// ---------------------------------------------------------------------------
function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

interface SeededUser {
  email: string;
  raw_token: string;
  user_id: number;
}

function ensureUserAndToken(email: string): SeededUser {
  const db = new Database(SQLITE_PATH);
  try {
    const default_name = email.split("@")[0].slice(0, 120);
    let row = db.prepare("SELECT id FROM users WHERE email = ?").get(email) as
      | { id: number }
      | undefined;
    let userId: number;
    if (!row) {
      const info = db
        .prepare(
          "INSERT INTO users (email, default_name, created_at) VALUES (?, ?, ?)"
        )
        .run(email, default_name, new Date().toISOString());
      userId = Number(info.lastInsertRowid);
    } else {
      userId = row.id;
    }
    const raw = crypto.randomBytes(32).toString("base64url");
    const token_hash = hashToken(raw);
    const expires = new Date(
      Date.now() + 30 * 24 * 3600 * 1000
    ).toISOString();
    db.prepare(
      "INSERT INTO auth_tokens (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)"
    ).run(userId, token_hash, new Date().toISOString(), expires);
    return { email, raw_token: raw, user_id: userId };
  } finally {
    db.close();
  }
}

function wipeDb(): void {
  const db = new Database(SQLITE_PATH);
  try {
    db.exec(`
      DELETE FROM settlements;
      DELETE FROM bill_participants;
      DELETE FROM bills;
      DELETE FROM session_members;
      DELETE FROM sessions;
      DELETE FROM auth_tokens;
      DELETE FROM verification_codes;
      DELETE FROM users;
    `);
  } finally {
    db.close();
  }
}

const BASE = "http://localhost:8448";
const SQLITE_PATH =
  process.env.SBC_SQLITE_PATH ??
  process.env.SBC_TEST_SQLITE_PATH ??
  "/tmp/sbc-test.db";

const SCREENSHOTS_DIR = path.join(process.cwd(), "e2e", "screenshots");
const SCREENSHOT = (n: number, name: string) =>
  path.join(
    SCREENSHOTS_DIR,
    `test-3-11-11-${String(n).padStart(2, "0")}-${name}.png`
  );

// ---------------------------------------------------------------------------
// Helper: ensure a session exists with placeholder nicknames (no auto-claim).
// Mirrors createAnonSessionAsCreator from owner_email_claim.spec.ts but **stops
// short** of the creator's claim — placeholders stay user_id=null + claimed_at=null
// so case 1 / case 2 / case 3 can drive their own anon-claim paths.
// ---------------------------------------------------------------------------
async function createSessionWithPlaceholders(
  page: Page,
  name: string,
  nicknames: string[]
): Promise<{ id: number; session_code: string }> {
  const r = await page.request.post(`${BASE}/api/sessions`, {
    data: {
      name,
      member_nicknames: nicknames,
      currencies: ["CNY"],
      primary_currency: "CNY",
      exchange_rates: [],
    },
  });
  expect(r.status(), "POST /api/sessions should return 201").toBe(201);
  return r.json();
}

// ---------------------------------------------------------------------------
// Helper: anon-creator flow that DOES claim the first placeholder so the
// session has 1 anon-claimed slot + remaining unclaimed placeholders. This
// is the "PO 自己创建 anon session" canonical path that case 1 starts from.
// ---------------------------------------------------------------------------
async function createAnonSessionAsCreator(
  page: Page,
  sessionName: string,
  nicknames: string[]
): Promise<{ sid: number; creatorSecret: string; memberIds: number[] }> {
  const createRes = await page.request.post(`${BASE}/api/sessions`, {
    data: {
      name: sessionName,
      member_nicknames: nicknames,
      currencies: ["CNY"],
      primary_currency: "CNY",
      exchange_rates: [],
    },
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

  return { sid, creatorSecret: claimBody.nickname_secret, memberIds };
}

// ---------------------------------------------------------------------------
// Helper: read the invite URL (session_code based, per /s/{code} canonical
// path — owner_email_claim.spec.ts uses /api/sessions/{id}/invite for raw
// token, but §3.11.11 uses /s/{code} which is the user-facing invite URL).
// ---------------------------------------------------------------------------
function getSessionInviteUrl(sessionId: number): string {
  const db = new Database(SQLITE_PATH);
  try {
    const row = db
      .prepare("SELECT session_code FROM sessions WHERE id = ?")
      .get(sessionId) as { session_code: string } | undefined;
    if (!row) throw new Error(`no session ${sessionId}`);
    return `${BASE}/s/${row.session_code}`;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Helper: seed an additional logged-in bound member into a session.
// Inserts a SessionMember row with user_id set + is_anon=false, mirroring
// the path a logged-in user takes when they join via /join-claim action=claim.
// ---------------------------------------------------------------------------
function seedLoggedInBoundMember(
  sessionId: number,
  email: string,
  displayName: string
): { memberId: number; userId: number } {
  const user = ensureUserAndToken(email);
  const db = new Database(SQLITE_PATH);
  try {
    const now = new Date().toISOString();
    const info = db
      .prepare(
        `INSERT INTO session_members
           (session_id, user_id, display_name, role, joined_at, is_anon)
         VALUES (?, ?, ?, 'member', ?, 0)`
      )
      .run(sessionId, user.user_id, displayName, now);
    return { memberId: Number(info.lastInsertRowid), userId: user.user_id };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Helper: bump (or backdate) last_active_at for a session. PRD §3.11.11.5α
// defines "owner activity window" — case 4 backdates by 8 days to force the
// 410 Gone path on GET endpoints.
// ---------------------------------------------------------------------------
function setSessionLastActiveAt(
  sessionId: number,
  isoDateTime: string
): void {
  const db = new Database(SQLITE_PATH);
  try {
    db.prepare("UPDATE sessions SET last_active_at = ? WHERE id = ?").run(
      isoDateTime,
      sessionId
    );
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Helper: clear all storage + cookies on a fresh page so we test the
// "新用户" path (no prior session binding, no acting-as secret).
// ---------------------------------------------------------------------------
async function freshAnonContext(browser: import("@playwright/test").Browser) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  // Visit the origin first so we can clear storage on the right domain.
  await page.goto(BASE);
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await ctx.clearCookies();
  return { ctx, page };
}

// ---------------------------------------------------------------------------
// Login + plant-code pattern (mirrors auth_401_redirect.spec.ts::gotoLoginWithCode)
// so we can bypass SMTP send while still exercising the real /auth/login UI.
// ---------------------------------------------------------------------------
function plantVerificationCode(email: string, code: string = "123456") {
  const db = new Database(SQLITE_PATH);
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

async function gotoLoginWithCode(
  page: Page,
  returnTo: string,
  email: string,
  code: string
) {
  plantVerificationCode(email, code);
  await page.goto(
    `${BASE}/auth/login?returnTo=${encodeURIComponent(returnTo)}&email=${encodeURIComponent(email)}&code=${code}`
  );
  await expect(page.locator("#code")).toBeVisible({ timeout: 5000 });
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------
test.beforeAll(() => {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
});

test.beforeEach(() => {
  wipeDb();
});

// ===========================================================================
// CASE 1 — 老用户 (anon creator) 走 invite link → join page 单屏 wizard →
//          点自己 anon-claimed slot → 进 session
// ===========================================================================
test("case 1 (PRD §3.11.11.4 + SPEC §5): 老用户 anon creator 点 invite link → 单屏 wizard → 点自己 anon-claimed slot", async ({
  browser,
}) => {
  // ── Setup: PO 自己创建 anon session, claim 第 1 个 slot (PO 自己的昵称) ──
  const setupCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const setupPage = await setupCtx.newPage();
  const { sid } = await createAnonSessionAsCreator(
    setupPage,
    "§3.11.11 老用户 anon session",
    ["MasterTrueUser", "Slot2Unclaimed", "Slot3Unclaimed"]
  );
  // 额外 seed 1 个 logged-in bound member (e.g. 之前的 session partner 已经登录),
  // 验证上半屏**全**显 (logged-in bound + anon-claimed + unclaimed 三类 slot 都展示).
  seedLoggedInBoundMember(sid, "loggedin.partner@jessejia.local", "LoggedInPartner");
  await setupCtx.close();

  // ── PO 在同一台机器同浏览器 (清 localStorage 模拟"刚换浏览器") ──────────
  const { ctx, page } = await freshAnonContext(browser);

  // ── Step 1: PO 点 invite link (/s/{session_code}) ─────────────────────
  const inviteUrl = getSessionInviteUrl(sid);
  await page.goto(inviteUrl);
  await page.waitForLoadState("networkidle");

  // BUG-V031-A fix: /s/{code} redirects non-members to /sessions/{id}/join
  await page.waitForURL(new RegExp(`/sessions/${sid}/join`), {
    timeout: 10000,
  });

  // ── Step 2: join page 单屏 wizard (SPEC §5) ───────────────────────────
  // 上半屏: "选你的昵称" 区块 — **所有** bound 槽 as buttons
  //   - "MasterTrueUser" (anon-claimed by PO creator, claimed_at 有值)
  //   - "LoggedInPartner" (logged-in bound, user_id 有值)
  // 下半屏: "新建昵称" input + button
  // 验证关键 (PRD §3.11.11.4): 全显, **不** filter user_id, **不** filter claimed_at
  await expect(page.getByText(/选你.*昵称|选择已有昵称/)).toBeVisible({
    timeout: 5000,
  });
  await expect(page.getByText(/新建|新增/)).toBeVisible();

  // 上半屏显 PO 自己的 anon-claimed slot (button 可点)
  const mySlot = page.locator("button", { hasText: "MasterTrueUser" });
  await expect(mySlot).toBeVisible();
  await expect(mySlot).toBeEnabled();

  // 上半屏**也**显别人的 slot (logged-in bound + unclaimed 都显)
  await expect(
    page.locator("button", { hasText: "LoggedInPartner" })
  ).toBeVisible();
  await expect(
    page.locator("button", { hasText: "Slot2Unclaimed" })
  ).toBeVisible();

  await page.screenshot({
    path: SCREENSHOT(1, "join-page-single-screen"),
    fullPage: true,
  });

  // ── Step 3: PO 点自己 slot → claim 成功 → redirect 到 /sessions/{id} ──
  // (SPEC §5: 上半屏 button onclick = handleClaim(slot.id), 现有 BE endpoint 不变)
  await mySlot.click();
  await page.waitForURL(new RegExp(`/sessions/${sid}(?:$|[^0-9])`), {
    timeout: 10000,
  });
  await page.waitForLoadState("networkidle");

  // ── 验证 session detail ───────────────────────────────────────────────
  // (反 #101: 同时验证 UI locator + BE DB 状态)
  const sessionRes = await page.request.get(
    `${BASE}/api/sessions/${sid}/preview`
  );
  expect(sessionRes.status()).toBe(200);
  const session = await sessionRes.json();
  const me = session.members.find(
    (m: any) => m.display_name === "MasterTrueUser"
  );
  expect(me, "PO's anon-claimed slot should be visible in /preview").toBeTruthy();

  // localStorage 已存 actingAs secret
  const actingAs = await page.evaluate(
    (sessionId) => localStorage.getItem(`sbc.actingAs.${sessionId}`),
    sid
  );
  expect(actingAs, "anon secret should be stored in localStorage after claim").toBeTruthy();

  await page.screenshot({
    path: SCREENSHOT(2, "after-claim-on-detail"),
    fullPage: true,
  });
  await ctx.close();
});

// ===========================================================================
// CASE 2 — 新用户 (清 cookie + localStorage) 走 invite link → join page
//          单屏 wizard → 不认得上半屏 slots → 输入新 nickname → 创建 → 进 session
// ===========================================================================
test("case 2 (PRD §3.11.11.2 + SPEC §5): 新用户清 storage → invite link → 单屏 → 新建昵称 → 进 session", async ({
  browser,
}) => {
  // ── Setup: PO 创建 anon session + 2 个 slot (PO 自己 claim + 1 logged-in bound) ──
  const setupCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const setupPage = await setupCtx.newPage();
  const { sid } = await createAnonSessionAsCreator(
    setupPage,
    "§3.11.11 新用户 anon session",
    ["PO_Nickname", "Slot2ForOthers"]
  );
  seedLoggedInBoundMember(sid, "loggedin.partner2@jessejia.local", "Partner2");
  await setupCtx.close();

  // ── 完全 fresh browser context (反 #100: 不注入 cookie, 不注入 localStorage) ──
  const { ctx, page } = await freshAnonContext(browser);

  // ── Step 1: 点 invite link ────────────────────────────────────────────
  const inviteUrl = getSessionInviteUrl(sid);
  await page.goto(inviteUrl);
  await page.waitForURL(new RegExp(`/sessions/${sid}/join`), {
    timeout: 10000,
  });

  // ── Step 2: 单屏 wizard 可见 (上半屏 + 下半屏) ────────────────────────
  await expect(page.getByText(/选你.*昵称|选择已有昵称/)).toBeVisible();
  await expect(page.getByText(/新建|新增/)).toBeVisible();

  // 上半屏显所有 bound slot (新用户**不**认得, 但 UI **不**阻止, PRD a)
  await expect(page.locator("button", { hasText: "PO_Nickname" })).toBeVisible();
  await expect(page.locator("button", { hasText: "Partner2" })).toBeVisible();

  // ── Step 3: 输入新 nickname "AnonTest" + 创建 ─────────────────────────
  const newNicknameInput = page.locator(
    'input[placeholder*="昵称"], input[placeholder*="名字"]'
  ).first();
  await expect(newNicknameInput).toBeVisible();
  await newNicknameInput.fill("AnonTest");

  const addButton = page.locator('button:has-text("加入")').first();
  await expect(addButton).toBeEnabled();
  await addButton.click();

  // ── Step 4: redirect 到 session detail ────────────────────────────────
  await page.waitForURL(new RegExp(`/sessions/${sid}(?:$|[^0-9])`), {
    timeout: 10000,
  });
  await page.waitForLoadState("networkidle");

  // ── 验证: 新成员已加入 (action=add path) ──────────────────────────────
  const previewRes = await page.request.get(
    `${BASE}/api/sessions/${sid}/preview`
  );
  expect(previewRes.status()).toBe(200);
  const preview = await previewRes.json();
  const newMember = preview.members.find(
    (m: any) => m.display_name === "AnonTest"
  );
  expect(newMember, "newly added nickname should appear in member list").toBeTruthy();
  expect(newMember.user_id, "anon path: user_id is null").toBeNull();

  await page.screenshot({
    path: SCREENSHOT(3, "new-user-claim-detail"),
    fullPage: true,
  });
  await ctx.close();
});

// ===========================================================================
// CASE 3 — 老用户点错昵称 (PRD §3.11.11.5a + SPEC §6) — BE 接受, 错进 session,
//          详情页 header "退出" 按钮 (banner) → 退到 join page 重新选
// ===========================================================================
test("case 3 (PRD §3.11.11.5 a + SPEC §6): 老用户点别人 slot → BE 接受 → 错进 session → header '退出' → 退到 join 重选", async ({
  browser,
}) => {
  // ── Setup: 创建 session, 有 3 个 unclaimed slot ──────────────────────
  const setupCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const setupPage = await setupCtx.newPage();
  const { sid } = await createAnonSessionAsCreator(
    setupPage,
    "§3.11.11 错昵称 session",
    ["AliceSlot", "BobSlot", "CarolSlot"]
  );
  await setupCtx.close();

  // ── 模拟老用户: 之前 claim 过 AliceSlot, 但现在清 storage 走 invite link ──
  // (PRD §3.11.11.2: 老用户 = 之前 anon (未绑邮箱) "快速开始" 用过, 记得自己昵称)
  // 这里模拟"记得昵称但点错" — 新 fresh context, 但 wizard 上半屏 3 个 slot 全显,
  // 用户点 BobSlot (不是 AliceSlot).
  const { ctx, page } = await freshAnonContext(browser);

  await page.goto(getSessionInviteUrl(sid));
  await page.waitForURL(new RegExp(`/sessions/${sid}/join`), {
    timeout: 10000,
  });

  // ── Step 1: 点**别人** slot (BobSlot, 不是老用户的 AliceSlot) ────────
  // PRD §3.11.11.5a: BE **不**阻止, 接受. (错进 session 是 PO a 明确产品意图)
  const wrongSlot = page.locator("button", { hasText: "BobSlot" });
  await expect(wrongSlot).toBeVisible();
  await wrongSlot.click();

  // ── Step 2: 进 session detail (错进) ─────────────────────────────────
  await page.waitForURL(new RegExp(`/sessions/${sid}(?:$|[^0-9])`), {
    timeout: 10000,
  });
  await page.waitForLoadState("networkidle");

  // 验证 BobSlot 已被该 browser claim (user_id 仍 null 但 claimed_at 有值, nickname_secret 已设)
  const previewRes = await page.request.get(
    `${BASE}/api/sessions/${sid}/preview`
  );
  const preview = await previewRes.json();
  const bobMember = preview.members.find(
    (m: any) => m.display_name === "BobSlot"
  );
  expect(bobMember).toBeTruthy();

  // ── Step 3: 详情页 header "退出" 按钮 (PRD a: "再点退出") ─────────────
  // SPEC §6: 详情页 header "退出" 按钮 (banner 那个) → 退到 join page 重新选
  // 这个 button 是 SPEC §6 明确要求的**新** UI 元素, 应**只**在错进 session 状态下显
  // (locator 用语义 class 或 data-testid; 本测试采用 hasText + 走 onclick)
  const exitButton = page.locator(
    'button:has-text("退出"), a:has-text("退出")'
  ).first();
  await expect(exitButton, "header exit button should appear after wrong-nick entry").toBeVisible({
    timeout: 5000,
  });
  await page.screenshot({
    path: SCREENSHOT(4, "wrong-nick-detail-with-exit"),
    fullPage: true,
  });

  // ── Step 4: 点 "退出" → 退到 join page (清 localStorage, 再选) ────────
  await exitButton.click();
  await page.waitForURL(new RegExp(`/sessions/${sid}/join`), {
    timeout: 10000,
  });
  await page.waitForLoadState("networkidle");

  // 验证 localStorage 已清 (secret 没了, 用户可重新选)
  const actingAs = await page.evaluate(
    (sessionId) => localStorage.getItem(`sbc.actingAs.${sessionId}`),
    sid
  );
  expect(actingAs, "actingAs secret should be cleared after exit").toBeNull();

  // 验证 join page 单屏 wizard 又可见 (上半屏 + 下半屏)
  await expect(page.getByText(/选你.*昵称|选择已有昵称/)).toBeVisible();
  await expect(page.getByText(/新建|新增/)).toBeVisible();

  // 这次点**正确**的 slot (AliceSlot)
  const correctSlot = page.locator("button", { hasText: "AliceSlot" });
  await expect(correctSlot).toBeVisible();
  await correctSlot.click();
  await page.waitForURL(new RegExp(`/sessions/${sid}(?:$|[^0-9])`), {
    timeout: 10000,
  });

  await page.screenshot({
    path: SCREENSHOT(5, "after-rejoin-correct-slot"),
    fullPage: true,
  });
  await ctx.close();
});

// ===========================================================================
// CASE 4 — 7 天外 session (PRD §3.11.11.6 + SPEC §4) — mock last_active_at
//          = now - 8 days → invite link → join page 显 "session 已回收"
// ===========================================================================
test("case 4 (PRD §3.11.11.6 + SPEC §4): 7 天外 session → invite link → 显 'session 已回收'", async ({
  browser,
}) => {
  // ── Setup: 创建 session, 然后 backdate last_active_at 到 8 天前 ───────
  const setupCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const setupPage = await setupCtx.newPage();
  const { sid } = await createAnonSessionAsCreator(
    setupPage,
    "§3.11.11 7天外 session",
    ["OwnerSlot", "OtherSlot"]
  );
  // 8 days ago (PRD §3.11.11.6: 7 天**外** → session 回收)
  const eightDaysAgo = new Date(
    Date.now() - 8 * 24 * 60 * 60 * 1000
  ).toISOString();
  setSessionLastActiveAt(sid, eightDaysAgo);
  await setupCtx.close();

  // ── Fresh anon visitor 走 invite link ─────────────────────────────────
  const { ctx, page } = await freshAnonContext(browser);
  await page.goto(getSessionInviteUrl(sid));

  // ── Step 1: /s/{code} 应**不** redirect 到 join page (因为 BE 410 Gone) ──
  // SPEC §4.2: GET /api/sessions/{id} 7 天外 → 410 Gone
  // SPEC §4.3: GET /api/sessions/{id}/preview 同上 → 410
  // FE join page 拿到 410 → 应显 "session 已回收, 请联系 owner" 提示
  await page.waitForLoadState("networkidle");

  // ── Step 2: 验证 join page 显回收提示 ─────────────────────────────────
  // (注意: 这取决于 FE 怎么处理 410 — 应在 join page 渲染一个错误 banner)
  // 文案来自 PRD §3.11.11.6 + SPEC §6 edge case row 2: "session 已回收"
  await expect(
    page.getByText(/session.*已回收|session.*过期|session.*回收/)
  ).toBeVisible({ timeout: 10000 });

  // ── Step 3: 验证**不**显 "选你的昵称" / "新建昵称" wizard ────────────
  // 7 天外 session = BE 410, FE 不应让用户继续 claim / add
  await expect(page.getByText(/选你.*昵称|选择已有昵称/)).toHaveCount(0);
  await expect(page.getByText(/新建|新增/)).toHaveCount(0);

  await page.screenshot({
    path: SCREENSHOT(6, "expired-session-reclaimed"),
    fullPage: true,
  });

  // ── Step 4: BE 直接验证 GET /preview 返 410 Gone ─────────────────────
  // (反 #101: 同时验证 UI locator + BE DB 状态)
  const previewRes = await page.request.get(
    `${BASE}/api/sessions/${sid}/preview`
  );
  expect(
    previewRes.status(),
    "7-day-expired session /preview should return 410 Gone"
  ).toBe(410);

  await ctx.close();
});

// ===========================================================================
// CASE 5 — owner 邮箱登录 + claim flow (PRD §3.11.11.6 + SPEC §6) —
//          session 7 天外后, owner 走邮箱登录 + POST /api/sessions/{id}/claim
//          → session 持久化 (owner_user_id + owner_email 设上, 后续 access
//          不再受 7 天限制)
// ===========================================================================
test("case 5 (PRD §3.11.11.6 + SPEC §6): owner 邮箱登录 + claim flow → 7 天外 session 持久访问", async ({
  browser,
}) => {
  // ── Setup: 7 天外 anon session ────────────────────────────────────────
  const setupCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const setupPage = await setupCtx.newPage();
  const { sid } = await createAnonSessionAsCreator(
    setupPage,
    "§3.11.11 owner claim flow",
    ["PO_Nick", "OtherNick"]
  );
  const eightDaysAgo = new Date(
    Date.now() - 8 * 24 * 60 * 60 * 1000
  ).toISOString();
  setSessionLastActiveAt(sid, eightDaysAgo);
  await setupCtx.close();

  // ── Owner 走真 /auth/login UI (plant code 跳过 SMTP, 跟 owner_email_claim 同 pattern) ──
  const ownerEmail = "owner.claim@jessejia.local";
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  // 直接 navigate 到 detail page, 7 天外 → BE 410 Gone → join page 显回收提示
  await page.goto(`${BASE}/sessions/${sid}`);
  await page.waitForLoadState("networkidle");

  // 验证 7 天外 join page 行为 (跟 case 4 一致)
  await expect(
    page.getByText(/session.*已回收|session.*过期|session.*回收/)
  ).toBeVisible({ timeout: 10000 });

  // ── Owner 走 /auth/login 邮箱验证 ─────────────────────────────────────
  // 7 天外 owner 想**永**久访问 → 邮箱登录 → claim flow (POST /claim) 绑
  // user_id + owner_email → session 持久化 (SPEC §6 row 4)
  await gotoLoginWithCode(
    page,
    `/sessions/${sid}?claim=1`,
    ownerEmail,
    "888888"
  );
  await page.locator('button:has-text("验证并登录")').click();
  await page.waitForURL(new RegExp(`/sessions/${sid}\\?claim=1`), {
    timeout: 10000,
  });
  await page.waitForLoadState("networkidle");

  // ── 验证: claim flow 成功后 owner_user_id + owner_email 已设 ──────────
  const cookies = await ctx.cookies();
  const sbcCookie = cookies.find((c) => c.name === "sbc_session");
  expect(sbcCookie, "owner should have sbc_session cookie after login").toBeTruthy();

  const sessionRes = await page.request.get(`${BASE}/api/sessions/${sid}`, {
    headers: { Cookie: `sbc_session=${sbcCookie!.value}` },
  });
  expect(sessionRes.status(), "after claim, GET /sessions/{id} should return 200").toBe(200);
  const session = await sessionRes.json();
  expect(session.owner_user_id, "owner_user_id should be set after claim").not.toBeNull();
  expect(session.owner_email, "owner_email should be set after claim").toBe(ownerEmail);

  // ── 验证: claim 成功后 last_active_at 已更新 (从 8 天前 → now) ─────────
  // 这样后续 7 天**内** owner 可正常访问, **不**再被 410
  const db = new Database(SQLITE_PATH);
  let updatedLastActiveAt: string;
  try {
    const row = db
      .prepare("SELECT last_active_at FROM sessions WHERE id = ?")
      .get(sid) as { last_active_at: string } | undefined;
    expect(row).toBeTruthy();
    updatedLastActiveAt = row!.last_active_at;
  } finally {
    db.close();
  }
  const updatedTime = new Date(updatedLastActiveAt).getTime();
  const eightDaysAgoMs = Date.now() - 8 * 24 * 60 * 60 * 1000;
  expect(
    updatedTime,
    "claim flow should bump last_active_at to now (or recent), not 8 days ago"
  ).toBeGreaterThan(eightDaysAgoMs);

  // ── 验证: query `?claim=1` 已被 replaceState 清掉 ────────────────────
  expect(page.url()).toMatch(new RegExp(`/sessions/${sid}$`));

  await page.screenshot({
    path: SCREENSHOT(7, "owner-claim-persistent"),
    fullPage: true,
  });
  await ctx.close();
});

// ===========================================================================
// CASE 6 — 单屏 wizard UI 形态 (PRD §3.11.11.4 + SPEC §5) — 验证 join page
//          **不**做 wizard 步进 (单步), 上半屏 "选你的昵称" + 下半屏 "新建昵称"
//          **同屏**可见 (无 step transition)
// ===========================================================================
test("case 6 (PRD §3.11.11.4 + SPEC §5): 单屏 wizard UI — 上半屏 + 下半屏 同屏可见, 无 step transition", async ({
  browser,
}) => {
  // ── Setup: session with mixed slots (logged-in bound + anon-claimed + unclaimed) ──
  const setupCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const setupPage = await setupCtx.newPage();
  const { sid } = await createAnonSessionAsCreator(
    setupPage,
    "§3.11.11 单屏 UI 验证",
    ["Slot1Unclaimed", "Slot2Unclaimed"]
  );
  seedLoggedInBoundMember(sid, "loggedin.user3@jessejia.local", "Slot3LoggedIn");
  await setupCtx.close();

  // ── Fresh anon visitor ────────────────────────────────────────────────
  const { ctx, page } = await freshAnonContext(browser);
  await page.goto(getSessionInviteUrl(sid));
  await page.waitForURL(new RegExp(`/sessions/${sid}/join`), {
    timeout: 10000,
  });

  // ── 关键断言: 上半屏 + 下半屏 **同屏** 可见 (单屏 wizard = 单步) ─────
  // SPEC §5: "**不**做 user state 区分 (老/新 都**同**屏)" + "**不**做 wizard 步进 (单屏 = 单步)"
  //   - "选你的昵称" 区块 visible
  //   - "新建昵称" input visible
  //   - **不**存在 "下一步" / "上一步" / step indicator UI
  await expect(page.getByText(/选你.*昵称|选择已有昵称/)).toBeVisible();
  const newNicknameInput = page.locator(
    'input[placeholder*="昵称"], input[placeholder*="名字"]'
  ).first();
  await expect(newNicknameInput).toBeVisible();

  // 验证**不**存在 wizard 步进按钮
  const stepButtons = await page
    .locator('button:has-text("下一步"), button:has-text("上一步"), button:has-text("继续")')
    .count();
  expect(stepButtons, "single-screen wizard should NOT have next/back buttons").toBe(0);

  // ── 关键断言: 全显 (PRD §3.11.11.4) — logged-in bound + anon-claimed + unclaimed 都显 ──
  await expect(page.locator("button", { hasText: "Slot1Unclaimed" })).toBeVisible();
  await expect(page.locator("button", { hasText: "Slot2Unclaimed" })).toBeVisible();
  await expect(page.locator("button", { hasText: "Slot3LoggedIn" })).toBeVisible();

  await page.screenshot({
    path: SCREENSHOT(8, "single-screen-ui-morph"),
    fullPage: true,
  });
  await ctx.close();
});