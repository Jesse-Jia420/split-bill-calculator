/**
 * TEST-§3.11.11 — join-claim 边界修复 (PO 2026-07-09 05:51 #3765 拍对)
 *
 * 3 scenarios covering PRD §3.11.11.5 decisions β/γ/δ:
 *   - Case A (decision β, anon-to-anon): anon claims anon-claimed slot
 *     → BE 200 + new secret (rotation); FE 进 /sessions/{id}.
 *   - Case B (decision γ, anon-to-loggedin): anon claims logged-in bound
 *     slot → BE 403 + {error: requires_login}; FE 跳 /auth/login?returnTo=...
 *   - Case C (regression, anon-to-unclaimed): anon first-claims empty slot
 *     → BE 200 + new secret (first claim); FE 进 /sessions/{id}.
 *
 * 反 #129: Tester 必根**据** PRD + SPEC 写测试 (PRD §3.11.11.5 + SPEC §3.11.11.D).
 * 反 #131: 本任务**与** Coder 并行 (Coder 实施产品代码, 本 Tester **只**写测试).
 * 反 #100: 不注入 cookie, 真浏览器自然走 /auth/login UI.
 *
 * DB: tests 默认连 /tmp/sbc-test.db, 我们跑测试时设 SBC_SQLITE_PATH 指向
 *      /config/workspace/split-bill-calculator/backend/data/sbc.db (跟 BE 一致).
 */
import { test, expect, type Page, type Browser } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// LOCAL helpers (mirror §3_11_11_wizard.spec.ts convention; sidestep the
// pre-existing test-helpers.ts syntax bug at HEAD).
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
  // 反 #110: 默认指向 prod DB 路径 (BE 也在跑这条)
  "/config/workspace/split-bill-calculator/backend/data/sbc.db";

const SCREENSHOTS_DIR = path.join(process.cwd(), "e2e", "screenshots");
const SCREENSHOT = (n: number, name: string) =>
  path.join(
    SCREENSHOTS_DIR,
    `wizard-join-claim-${String(n).padStart(2, "0")}-${name}.png`
  );

// ---------------------------------------------------------------------------
// Helper: anon-creator flow + claim first 2 slots so we have 2 anon-claimed
// slots (j, k) — Case A scenario setup.
// ---------------------------------------------------------------------------
async function createAnonSessionWithAnonClaimedSlots(
  page: Page,
  sessionName: string,
  nicknames: string[]
): Promise<{ sid: number; memberIds: number[]; secrets: Record<string, string> }> {
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

  const secrets: Record<string, string> = {};
  for (let i = 0; i < memberIds.length; i++) {
    const claimRes = await page.request.post(
      `${BASE}/api/sessions/${sid}/join-claim`,
      { data: { action: "claim", session_member_id: memberIds[i] } }
    );
    expect(claimRes.status()).toBe(200);
    const claimBody = (await claimRes.json()) as { nickname_secret: string };
    secrets[nicknames[i]] = claimBody.nickname_secret;
  }
  return { sid, memberIds, secrets };
}

// ---------------------------------------------------------------------------
// Helper: anon-creator flow + insert a logged-in bound slot (jesse).
// ---------------------------------------------------------------------------
async function createAnonSessionWithLoggedInBoundSlot(
  page: Page,
  sessionName: string,
  jesseEmail: string,
  jesseDisplayName: string
): Promise<{ sid: number; jesseSlotId: number; jesseUserId: number }> {
  const createRes = await page.request.post(`${BASE}/api/sessions`, {
    data: {
      name: sessionName,
      member_nicknames: ["Placeholder"],  // throwaway unclaimed slot
      currencies: ["CNY"],
      primary_currency: "CNY",
      exchange_rates: [],
    },
  });
  expect(createRes.status()).toBe(201);
  const created = (await createRes.json()) as { id: number };
  const sid = created.id;

  const jesse = ensureUserAndToken(jesseEmail);
  const db = new Database(SQLITE_PATH);
  try {
    const now = new Date().toISOString();
    const info = db
      .prepare(
        `INSERT INTO session_members
           (session_id, user_id, display_name, role, joined_at, is_anon, claimed_at)
         VALUES (?, ?, ?, 'member', ?, 0, ?)`
      )
      .run(sid, jesse.user_id, jesseDisplayName, now, now);
    return {
      sid,
      jesseSlotId: Number(info.lastInsertRowid),
      jesseUserId: jesse.user_id,
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Helper: anon-creator flow + insert an unclaimed slot (l) — Case C scenario.
// ---------------------------------------------------------------------------
async function createAnonSessionWithUnclaimedSlot(
  page: Page,
  sessionName: string,
  unclaimedNickname: string
): Promise<{ sid: number; unclaimedSlotId: number }> {
  const createRes = await page.request.post(`${BASE}/api/sessions`, {
    data: {
      name: sessionName,
      member_nicknames: [unclaimedNickname],
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
  // created_member_ids[0] is the unclaimed slot (claimed_at=null, nickname_secret=null)
  return { sid, unclaimedSlotId: created.created_member_ids[0] };
}

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

function getMemberNicknameSecret(slotId: number): string | null {
  const db = new Database(SQLITE_PATH);
  try {
    const row = db
      .prepare(
        "SELECT nickname_secret FROM session_members WHERE id = ?"
      )
      .get(slotId) as { nickname_secret: string | null } | undefined;
    return row?.nickname_secret ?? null;
  } finally {
    db.close();
  }
}

async function freshAnonContext(browser: Browser) {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  await page.goto(BASE);
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await ctx.clearCookies();
  return { ctx, page };
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
// CASE A — 决策 β (anon-to-anon): anon 抢 anon-claimed slot → 接受 + 覆盖
// ===========================================================================
test("case A (PRD §3.11.11.5 β + SPEC §3.11.11.D): anon 抢 anon-claimed slot → BE 200 + 覆盖 secret + 进 session", async ({
  browser,
}) => {
  // ── Setup: anon session "hh" with 2 anon-claimed slots (j, k) ──
  const setupCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const setupPage = await setupCtx.newPage();
  const { sid, memberIds, secrets: oldSecrets } =
    await createAnonSessionWithAnonClaimedSlots(setupCtx, "hh", ["j", "k"]);
  const jSlotId = memberIds[0];
  const oldJSecret = oldSecrets["j"];
  expect(oldJSecret).toBeTruthy();
  await setupCtx.close();

  // ── Fresh anon browser visits /sessions/{sid}/join ──
  const { ctx, page } = await freshAnonContext(browser);
  await page.goto(`${BASE}/sessions/${sid}/join`);
  await page.waitForLoadState("networkidle");

  // Verify both j and k buttons are visible (decision δ — FE 不区分, 全显)
  const jButton = page.locator("button", { hasText: "j" });
  await expect(jButton).toBeVisible({ timeout: 5000 });

  // ── Click j → BE 200 + new secret + redirect to /sessions/{id} ──
  await jButton.click();
  await page.waitForURL(new RegExp(`/sessions/${sid}(?:$|[^0-9])`), {
    timeout: 10000,
  });
  await page.waitForLoadState("networkidle");

  // ── Verify DB: j's nickname_secret was rotated (β) ──
  const newSecret = getMemberNicknameSecret(jSlotId);
  expect(newSecret).toBeTruthy();
  expect(newSecret).not.toBe(oldJSecret);  // β rotation: secret MUST differ
  expect(newSecret!.length).toBe(64);  // 32-byte hex

  // ── Verify FE: localStorage has new secret ──
  const actingAs = await page.evaluate(
    (sessionId) => localStorage.getItem(`sbc.actingAs.${sessionId}`),
    sid
  );
  expect(actingAs).toBe(newSecret);

  await page.screenshot({
    path: SCREENSHOT(1, "case-A-after-claim"),
    fullPage: true,
  });
  await ctx.close();
});

// ===========================================================================
// CASE B — 决策 γ (anon-to-loggedin): anon 点 logged-in bound slot → 403
// ===========================================================================
test("case B (PRD §3.11.11.5 γ + SPEC §3.11.11.D): anon 点 logged-in bound slot → BE 403 + 跳 /auth/login", async ({
  browser,
}) => {
  const jesseEmail = "jesse.gamma@3-11-11.local";
  const jesseDisplayName = "jesse";

  // ── Setup: anon session "hh" with 1 logged-in bound slot (jesse) ──
  const setupCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const setupPage = await setupCtx.newPage();
  const { sid, jesseSlotId, jesseUserId } =
    await createAnonSessionWithLoggedInBoundSlot(
      setupPage,
      "hh",
      jesseEmail,
      jesseDisplayName
    );
  await setupCtx.close();

  // ── Fresh anon browser visits /sessions/{sid}/join ──
  const { ctx, page } = await freshAnonContext(browser);
  await page.goto(`${BASE}/sessions/${sid}/join`);
  await page.waitForLoadState("networkidle");

  // Verify jesse button visible (decision δ — full-show)
  const jesseButton = page.locator("button", { hasText: jesseDisplayName });
  await expect(jesseButton).toBeVisible({ timeout: 5000 });

  // ── Click jesse → expect FE to navigate to /auth/login?returnTo=... ──
  await jesseButton.click();

  // γ: FE should window.location.assign to /auth/login with returnTo back to /join.
  // Wait for URL transition. We allow up to 10s for the navigation.
  await page.waitForURL(/\/auth\/login/, { timeout: 10000 });
  const url = page.url();
  expect(url).toContain("/auth/login");
  expect(url).toContain("returnTo=");
  expect(url).toContain(encodeURIComponent(`/sessions/${sid}/join`));

  await page.screenshot({
    path: SCREENSHOT(2, "case-B-login-redirect"),
    fullPage: true,
  });

  // ── Verify DB: jesse slot's user_id was NOT cleared (impersonation blocked) ──
  const db = new Database(SQLITE_PATH);
  try {
    const sm = db
      .prepare(
        "SELECT user_id, is_anon FROM session_members WHERE id = ?"
      )
      .get(jesseSlotId) as { user_id: number | null; is_anon: number };
    expect(sm.user_id).toBe(jesseUserId);
    expect(sm.is_anon).toBe(0);
  } finally {
    db.close();
  }

  await ctx.close();
});

// ===========================================================================
// CASE C — 回归 (anon-to-unclaimed): anon 首次认领 unclaimed slot
// ===========================================================================
test("case C (PRD §3.11.11.5 a 回归 + SPEC §3.11.11.D): anon 首次认领 unclaimed slot → BE 200 + 首次 secret + 进 session", async ({
  browser,
}) => {
  // ── Setup: anon session "hh" with 1 unclaimed slot (l) ──
  const setupCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const setupPage = await setupCtx.newPage();
  const { sid, unclaimedSlotId } = await createAnonSessionWithUnclaimedSlot(
    setupPage,
    "hh",
    "l"
  );
  // Sanity: pre-condition, slot is unclaimed (no secret)
  const preSecret = getMemberNicknameSecret(unclaimedSlotId);
  expect(preSecret).toBeNull();
  await setupCtx.close();

  // ── Fresh anon browser visits /sessions/{sid}/join ──
  const { ctx, page } = await freshAnonContext(browser);
  await page.goto(`${BASE}/sessions/${sid}/join`);
  await page.waitForLoadState("networkidle");

  const lButton = page.locator("button", { hasText: "l" });
  await expect(lButton).toBeVisible({ timeout: 5000 });

  // ── Click l → BE 200 + first secret + redirect to /sessions/{id} ──
  await lButton.click();
  await page.waitForURL(new RegExp(`/sessions/${sid}(?:$|[^0-9])`), {
    timeout: 10000,
  });
  await page.waitForLoadState("networkidle");

  // ── Verify DB: l's nickname_secret is now set, is_anon=true, user_id=NULL ──
  const db = new Database(SQLITE_PATH);
  try {
    const sm = db
      .prepare(
        `SELECT nickname_secret, is_anon, user_id, claimed_at
           FROM session_members WHERE id = ?`
      )
      .get(unclaimedSlotId) as {
      nickname_secret: string | null;
      is_anon: number;
      user_id: number | null;
      claimed_at: string | null;
    };
    expect(sm.nickname_secret).toBeTruthy();
    expect(sm.nickname_secret!.length).toBe(64);
    expect(sm.is_anon).toBe(1);
    expect(sm.user_id).toBeNull();
    expect(sm.claimed_at).toBeTruthy();
  } finally {
    db.close();
  }

  // ── Verify FE: localStorage has the new secret ──
  const actingAs = await page.evaluate(
    (sessionId) => localStorage.getItem(`sbc.actingAs.${sessionId}`),
    sid
  );
  expect(actingAs).toBeTruthy();
  expect(actingAs!.length).toBe(64);

  await page.screenshot({
    path: SCREENSHOT(3, "case-C-first-claim"),
    fullPage: true,
  });
  await ctx.close();
});
