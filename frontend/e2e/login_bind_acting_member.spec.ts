/**
 * §3.11.14 — 匿名 slot 登录后绑定 (BE bind_acting_member + FE tryBindActingMember)
 *
 * 3 场景:
 *   A) anon 访问 session + 点 "登录以保存" → 真走 /auth/login → verify-code 200
 *      → bind_acting_member 200 → 该 slot 的 user_id 已设 + C 在我 sessions 列表
 *   B) localStorage 多个 secret (session C + session D) 但只在 C 点登录 → 只 C 的
 *      member 绑了, D 的不动 (FE tryBindActingMember 只走 returnTo 那一个 sid)
 *   C) bind 时 slot 已被 β 轮换 (secret 在 DB 里不存在) → 静默吞掉, 用户仍以
 *      anon 进入 session (localStorage secret 仍可让 /api/sessions/{id} 200)
 *
 * 反 #99: 按 user story 拆 case, 每个 case 走完整进→出.
 * 反 #100: 不注入 cookie, 真浏览器自然走 /auth/login UI.
 * 反 #101: 同时验证 UI locator 真存在 + BE DB 状态 (member.user_id 已设).
 * 反 #94: 走真 /auth/login UI (plant verification code 跳过 SMTP 是项目既有 pattern).
 */
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
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
const SS = (n: number, name: string) =>
  path.join(SCREENSHOTS_DIR, `test-31114-${String(n).padStart(2, "0")}-${name}.png`);

const DB_PATH =
  process.env.SBC_SQLITE_PATH ??
  process.env.SBC_TEST_SQLITE_PATH ??
  "/tmp/sbc-test.db";

async function plantVerificationCode(email: string, code: string = "123456") {
  const db = new Database(DB_PATH);
  try {
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    db.prepare("DELETE FROM verification_codes WHERE email = ?").run(email);
    db.prepare(
      "INSERT INTO verification_codes (email, code, purpose, created_at, expires_at, used) VALUES (?, ?, 'magic_link', ?, ?, 0)"
    ).run(email, code, now, expires);
  } finally {
    db.close();
  }
}

/**
 * 用 request 直建 anon session + 立即 claim creator slot 为 anon.
 * 返 { sid, creatorSecret } (creatorSecret 直接当 anon secret 存到 caller 的 localStorage).
 */
async function createAnonSessionAndClaimCreator(
  page: Page,
  sessionName: string,
  creatorNickname: string
): Promise<{ sid: number; creatorSecret: string }> {
  const createRes = await page.request.post(`${BASE}/api/sessions`, {
    data: { name: sessionName, member_nicknames: [creatorNickname] },
  });
  expect(createRes.status()).toBe(201);
  const created = (await createRes.json()) as {
    id: number;
    created_member_ids: number[];
  };
  const sid = created.id;
  const memberId = created.created_member_ids[0];
  const claimRes = await page.request.post(
    `${BASE}/api/sessions/${sid}/join-claim`,
    { data: { action: "claim", session_member_id: memberId } }
  );
  expect(claimRes.status()).toBe(200);
  const claimBody = (await claimRes.json()) as { nickname_secret: string };
  return { sid, creatorSecret: claimBody.nickname_secret };
}

/**
 * Login helper: plant verification code + 直接跳到 /auth/login verify step
 * 跳过 SMTP (与 owner_email_claim.spec.ts 同 pattern, 保真 /auth/login UI).
 */
async function gotoLoginAndVerify(
  page: Page,
  returnTo: string,
  email: string,
  code: string = "123456"
) {
  await plantVerificationCode(email, code);
  await page.goto(
    `${BASE}/auth/login?returnTo=${encodeURIComponent(returnTo)}&email=${encodeURIComponent(email)}&code=${code}`
  );
  await expect(page.locator("#code")).toBeVisible({ timeout: 5000 });
  await page.locator('button:has-text("验证并登录")').click();
}

test.beforeAll(() => {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  wipeDb();
});

// ---------------------------------------------------------------------------
// 场景 A: anon 访问 session + 点 "登录以保存" → 真走 /auth/login → verify-code
//        200 → bind 200 → 该 slot 的 user_id 已设 + session 在用户的 my sessions
// ---------------------------------------------------------------------------
test("A: anon + '登录以保存' → login → bind 200 → slot.user_id 已设", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  const loginEmail = "scenarioA.alice@local.test";

  // 1. 创 anon session + claim creator slot
  const { sid, creatorSecret } = await createAnonSessionAndClaimCreator(
    page,
    "场景A 测试 session",
    "alice"
  );

  // 2. 把 anon secret 写到 localStorage
  await page.goto(`${BASE}/sessions/${sid}`);
  await page.evaluate(
    ({ sid, secret }) =>
      localStorage.setItem(`sbc.actingAs.${sid}`, secret),
    { sid, secret: creatorSecret }
  );
  await page.reload();
  await page.waitForLoadState("networkidle");

  // 3. NavBar: "登录以保存" (因为在 session 内)
  const saveLink = page.locator(".right a.btn-sm", { hasText: "登录以保存" });
  await expect(saveLink).toBeVisible({ timeout: 5000 });

  // 4. 点 "登录以保存" → 跳 /auth/login?returnTo=/sessions/{sid}
  await saveLink.click();
  await page.waitForURL(/\/auth\/login\?returnTo=/, { timeout: 5000 });
  const url = new URL(page.url());
  expect(decodeURIComponent(url.searchParams.get("returnTo") ?? "")).toBe(
    `/sessions/${sid}`
  );

  // 5. 在 /auth/login 真 UI: email 输入 (verify step 是 plant 的)
  await page.locator("#email").fill(loginEmail);
  await gotoLoginAndVerify(page, `/sessions/${sid}`, loginEmail);

  // 6. 跳回 /sessions/{sid}
  await page.waitForURL(new RegExp(`/sessions/${sid}$`), { timeout: 10000 });
  await page.waitForLoadState("networkidle");

  // 7. NavBar 已登录: 显示 email + "注销登录"
  await expect(
    page.locator(".right .email", { hasText: "scenarioA.alice" })
  ).toBeVisible({ timeout: 5000 });

  // 8. ★ 验证: DB 该 SessionMember.user_id 已设 (不是 NULL)
  const db = new Database(DB_PATH);
  let member: { user_id: number | null; is_anon: number } | undefined;
  let boundUserId: number | undefined;
  try {
    member = db
      .prepare(
        "SELECT user_id, is_anon FROM session_members WHERE session_id = ? AND nickname_secret = ?"
      )
      .get(sid, creatorSecret) as
      | { user_id: number | null; is_anon: number }
      | undefined;
    if (member?.user_id) {
      boundUserId = member.user_id;
    }
  } finally {
    db.close();
  }
  expect(member).toBeTruthy();
  expect(member!.user_id).not.toBeNull();
  expect(member!.is_anon).toBe(0); // is_anon=false

  // 9. ★ 验证: 这个 user 在 /api/sessions 列表里能看到这个 session
  const cookieHeader = (
    await ctx.cookies()
  ).find((c) => c.name === "sbc_session");
  expect(cookieHeader).toBeTruthy();
  const listRes = await page.request.get(`${BASE}/api/sessions`, {
    headers: { Cookie: `sbc_session=${cookieHeader!.value}` },
  });
  expect(listRes.status()).toBe(200);
  const mySessions = (await listRes.json()) as Array<{ id: number }>;
  expect(mySessions.map((s) => s.id)).toContain(sid);

  await page.screenshot({
    path: SS(1, "A-after-bind"),
    fullPage: true,
  });
  await ctx.close();
});

// ---------------------------------------------------------------------------
// 场景 B: localStorage 多个 secret (C + D) 但只在 C 点登录 → 只 C 的 e 绑了,
//         D 的 f 不绑 (FE tryBindActingMember 只走 returnTo 那一个 sid)
// ---------------------------------------------------------------------------
test("B: multi-slot localStorage + 只登录一个 → 只那个 sid 的 slot 绑定", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  const loginEmail = "scenarioB.bob@local.test";

  // 创 2 个 anon session, 都 claim creator
  const C = await createAnonSessionAndClaimCreator(
    page,
    "场景B session C",
    "carol"
  );
  const D = await createAnonSessionAndClaimCreator(
    page,
    "场景B session D",
    "dave"
  );

  // Plant both actingAs secrets in localStorage
  await page.goto(`${BASE}/`);
  await page.evaluate(
    ({ cSid, cSecret, dSid, dSecret }) => {
      localStorage.setItem(`sbc.actingAs.${cSid}`, cSecret);
      localStorage.setItem(`sbc.actingAs.${dSid}`, dSecret);
    },
    { cSid: C.sid, cSecret: C.creatorSecret, dSid: D.sid, dSecret: D.creatorSecret }
  );

  // 访问 session C, 然后从 NavBar 点 "登录以保存"
  await page.goto(`${BASE}/sessions/${C.sid}`);
  await page.waitForLoadState("networkidle");
  const saveLink = page.locator(".right a.btn-sm", { hasText: "登录以保存" });
  await expect(saveLink).toBeVisible({ timeout: 5000 });
  await saveLink.click();
  await page.waitForURL(new RegExp(`/auth/login\\?returnTo=%2Fsessions%2F${C.sid}`), {
    timeout: 5000,
  });

  // 真 UI login: fill email + click verify
  await page.locator("#email").fill(loginEmail);
  await gotoLoginAndVerify(page, `/sessions/${C.sid}`, loginEmail);
  await page.waitForURL(new RegExp(`/sessions/${C.sid}$`), { timeout: 10000 });
  await page.waitForLoadState("networkidle");

  // 验证 DB: C.user_id NOT NULL, D.user_id IS NULL
  const db = new Database(DB_PATH);
  let cMember: { user_id: number | null } | undefined;
  let dMember: { user_id: number | null } | undefined;
  try {
    cMember = db
      .prepare(
        "SELECT user_id FROM session_members WHERE session_id = ? AND nickname_secret = ?"
      )
      .get(C.sid, C.creatorSecret) as { user_id: number | null } | undefined;
    dMember = db
      .prepare(
        "SELECT user_id FROM session_members WHERE session_id = ? AND nickname_secret = ?"
      )
      .get(D.sid, D.creatorSecret) as { user_id: number | null } | undefined;
  } finally {
    db.close();
  }
  // C bound
  expect(cMember).toBeTruthy();
  expect(cMember!.user_id).not.toBeNull();
  // D untouched
  expect(dMember).toBeTruthy();
  expect(dMember!.user_id).toBeNull();

  await page.screenshot({
    path: SS(2, "B-only-C-bound"),
    fullPage: true,
  });
  await ctx.close();
});

// ---------------------------------------------------------------------------
// 场景 C: bind 时 slot 已被 β 轮换 (secret 在 DB 里不存在, 因为 anon 重新
//         claim 时 secret 重生) → 静默吞掉, 用户仍以 anon 进入 session
//
//   Setup: anon 创 session + claim e with secret S1. 然后让 SAME anon slot
//          再次 claim (模拟 β 轮换) → BE 会给 secret S2, 而 S1 已无效.
//          此时 user 持 S1 来 bind → BE 返 404 → FE 静默吞掉 → 用户仍
//          以 anon 进入 session, localStorage 仍存 S1 (虽无效).
// ---------------------------------------------------------------------------
test("C: secret 已轮换 → bind 静默吞掉 + 用户仍以 anon 进入 session", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  const loginEmail = "scenarioC.chris@local.test";

  // 1. 创 session + claim creator slot → 拿到 S1
  const { sid, creatorSecret: originalSecret } =
    await createAnonSessionAndClaimCreator(
      page,
      "场景C 测试 session",
      "chris"
    );
  // 从 DB 拿该 session 的唯一 anon member id (用于触发 β 重生 secret).
  const lookupDb = new Database(DB_PATH);
  let memberId: number;
  try {
    const row = lookupDb
      .prepare(
        "SELECT id FROM session_members WHERE session_id = ? AND nickname_secret IS NOT NULL ORDER BY id LIMIT 1"
      )
      .get(sid) as { id: number } | undefined;
    if (!row) throw new Error(`no claimed member for session ${sid}`);
    memberId = row.id;
  } finally {
    lookupDb.close();
  }
  // 再 claim 一次 → 原 secret 被新 secret 轮换 (β 决策)
  const claimAgainRes = await page.request.post(
    `${BASE}/api/sessions/${sid}/join-claim`,
    {
      data: { action: "claim", session_member_id: memberId },
    }
  );
  expect(claimAgainRes.status()).toBe(200);
  const claimAgainBody = (await claimAgainRes.json()) as {
    nickname_secret: string;
  };
  const s2 = claimAgainBody.nickname_secret;
  expect(s2).toBeTruthy();

  // 2. 在 localStorage 故意植入 **已轮换的** S1 (模拟 FE 拿旧 secret 来 bind)
  //    真实 scenario 是 FE 还在用 claim 第一次时存的 secret, 后来 slot 被重 claim 了.
  await page.goto(`${BASE}/sessions/${sid}`);
  await page.evaluate(
    ({ sid, oldSecret }) =>
      localStorage.setItem(`sbc.actingAs.${sid}`, oldSecret),
    { sid, oldSecret: "rotated_secret_not_in_db_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }
  );
  await page.reload();
  await page.waitForLoadState("networkidle");

  // 3. 点 "登录以保存"
  const saveLink = page.locator(".right a.btn-sm", { hasText: "登录以保存" });
  await expect(saveLink).toBeVisible({ timeout: 5000 });
  await saveLink.click();
  await page.waitForURL(/\/auth\/login\?returnTo=/, { timeout: 5000 });

  // 4. 输 email + verify
  await page.locator("#email").fill(loginEmail);
  await gotoLoginAndVerify(page, `/sessions/${sid}`, loginEmail);
  // ★ 跳回 /sessions/{sid} (404 静默吞掉, 不抛异常)
  await page.waitForURL(new RegExp(`/sessions/${sid}$`), { timeout: 10000 });
  await page.waitForLoadState("networkidle");

  // 5. ★ 验证: 用户已登录 (NavBar 显示 email)
  await expect(
    page.locator(".right .email", { hasText: "scenarioC.chris" })
  ).toBeVisible({ timeout: 5000 });

  // 6. ★ 验证: 该 slot 的 user_id IS NULL (bind 没生效)
  const db = new Database(DB_PATH);
  let member: { user_id: number | null; nickname_secret: string | null } | undefined;
  try {
    member = db
      .prepare(
        "SELECT user_id, nickname_secret FROM session_members WHERE session_id = ?"
      )
      .get(sid) as
      | { user_id: number | null; nickname_secret: string | null }
      | undefined;
  } finally {
    db.close();
  }
  expect(member).toBeTruthy();
  expect(member!.user_id).toBeNull(); // bind 失败, slot 仍是 anon
  // DB 里的 secret 是 s2 (新), 不是 s1 (已被轮换的)
  expect(member!.nickname_secret).toBe(s2);

  await page.screenshot({
    path: SS(3, "C-secret-rotated-silently-bound"),
    fullPage: true,
  });
  await ctx.close();
});
