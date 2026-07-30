/**
 * v0.3.2 USER JOURNEY — Anon with localStorage secret walks /invites/{token} → direct → /sessions/{id}
 *
 * Per PRD §3.10.5 (v0.3.2 bug fix), /invites/{token} now follows the
 * 4-case dispatch table. This spec covers **row 4** (the most interesting
 * edge case):
 *
 *   | 匿名 + localStorage 有 sbc.actingAs.{sid} | FE 自动取 secret → BE 验证 → /sessions/{id} |
 *
 * Scenario:
 *   - Owner creates a session with placeholders
 *   - Anon browser A claims a placeholder → localStorage gets sbc.actingAs.{sid}
 *   - Anon browser A now visits /invites/{token} (NOT /s/{code}, NOT /sessions/{id})
 *   - FE onMount reads localStorage, calls getSession({sid}) which forwards
 *     X-Nickname-Secret. BE validates → 200 → FE redirects to /sessions/{id}
 *   - /join page must NOT be shown (since secret is valid)
 *
 * iPhone viewport + no cookie injection (per 反模式 #100).
 */
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { ensureUserAndToken, wipeDb } from "./test-helpers";

const BASE = "http://localhost:8448";
const SCREENSHOTS_DIR = path.join(process.cwd(), "e2e", "screenshots");
const SHOT = (n: number, name: string) =>
  path.join(SCREENSHOTS_DIR, `journey-invite-secret-${String(n).padStart(2, "0")}-${name}.png`);

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

test.beforeAll(() => {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
});

test.beforeEach(() => {
  wipeDb();
});

test("JOURNEY (anon + secret): /invites/{token} → BE 验证 secret → /sessions/{id} (no /join)", async ({
  browser,
}) => {
  // ===== 第 1 幕: Setup — owner creates session, fetches invite token =====
  const owner = ensureUserAndToken("invite-secret.owner@local.test");
  const ownerCtx: BrowserContext = await browser.newContext({
    ignoreHTTPSErrors: true,
  });
  await ownerCtx.addCookies([
    {
      name: "sbc_session",
      value: owner.raw_token,
      url: BASE,
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);
  const ownerPage: Page = await ownerCtx.newPage();

  const createRes = await ownerPage.request.post(`${BASE}/api/sessions`, {
    data: {
      name: "Secret 直接进 测试 session",
      currencies: ["CNY"],
      primary_currency: "CNY",
      member_nicknames: ["Slot1", "Slot2"],
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

  // ===== 第 2 幕: Anon browser A claims Slot1 via /sessions/{id}/join =====
  // This sets sbc.actingAs.{sid} in localStorage — exactly the
  // precondition for PRD §3.10.5 row 4.
  const anonCtx: BrowserContext = await browser.newContext({
    ...MOBILE_CONTEXT_OPTS,
    ignoreHTTPSErrors: true,
  });
  const page: Page = await anonCtx.newPage();

  // First, claim a slot via direct /join URL (simpler than going
  // through /s/{code} for this test — both paths store the same secret).
  await page.goto(`${BASE}/sessions/${sid}/join`);
  await page.waitForLoadState("networkidle");

  // Confirm we're on /join and a Slot1 button exists
  await expect(page.locator('.slot-btn:has-text("Slot1")')).toBeVisible({
    timeout: 5000,
  });
  await page.locator('.slot-btn:has-text("Slot1")').click();

  // Should land on /sessions/{id} after claim
  await page.waitForURL(new RegExp(`/sessions/${sid}$`), { timeout: 10000 });
  await page.waitForLoadState("networkidle");

  // Sanity: secret IS in localStorage now
  const secretBeforeInvite = await page.evaluate(
    (id) => localStorage.getItem(`sbc.actingAs.${id}`),
    sid
  );
  expect(
    secretBeforeInvite,
    "precondition: sbc.actingAs.{sid} must be set after claim"
  ).toBeTruthy();
  expect(secretBeforeInvite!.length).toBeGreaterThan(20);
  await page.screenshot({ path: SHOT(1, "after-claim-secret-set"), fullPage: true });

  // ===== 第 3 幕: Anon (with secret) visits /invites/{token} → direct to session =====
  // This is the core v0.3.2 fix path: row 4 of the 4-case table.
  await page.goto(`${BASE}/invites/${token}`);
  await page.waitForLoadState("networkidle");

  // PRD §3.10.5 row 4: 匿名 + localStorage 有 sbc.actingAs.{sid} →
  // FE 自动取 secret → BE 验证 → /sessions/{id}
  await page.waitForURL(new RegExp(`/sessions/${sid}$`), { timeout: 10000 });
  await page.screenshot({ path: SHOT(2, "direct-from-invite"), fullPage: true });

  // REGRESSION ASSERTION: must NOT have shown /join
  expect(
    page.url(),
    "anon with valid secret must land on /sessions/{id} (NOT /join)"
  ).not.toContain("/join");
  const bodyText = await page.locator("body").innerText();
  expect(bodyText).not.toContain("你需要先登录");
  expect(bodyText).not.toContain("选择已有昵称");
  expect(bodyText).not.toContain("新增我的昵称");

  // localStorage secret must still be valid (NOT cleared — BE accepted it)
  const secretAfter = await page.evaluate(
    (id) => localStorage.getItem(`sbc.actingAs.${id}`),
    sid
  );
  expect(
    secretAfter,
    "secret must remain in localStorage after BE 200 response"
  ).toBe(secretBeforeInvite);

  // ===== 第 4 幕: BE state — anon is a member, slot is claimed =====
  const verifyRes = await page.request.get(`${BASE}/api/sessions/${sid}`, {
    headers: { "X-Nickname-Secret": secretBeforeInvite! },
  });
  expect(verifyRes.status()).toBe(200);
  const detail = await verifyRes.json();

  // Slot1 should be claimed by anon (user_id=null, role=member, NOT owner)
  const slot1 = detail.members.find((m: any) => m.display_name === "Slot1");
  expect(slot1).toBeTruthy();
  expect(slot1.role).toBe("member");
  expect(slot1.user_id).toBeNull();

  // ===== 第 5 幕: Test the failure path — bad secret → /join =====
  // Corrupt the secret in localStorage, then visit /invites/{token} again.
  // FE should try getSession, get 403, clear the bad secret, redirect to /join.
  await page.evaluate(
    ({ id, bad }) => {
      localStorage.setItem(`sbc.actingAs.${id}`, bad);
    },
    { id: sid, bad: "INVALID-SECRET-XYZ-1234567890ABCDEF" }
  );

  await page.goto(`${BASE}/invites/${token}`);
  await page.waitForLoadState("networkidle");

  // FE should clear the bad secret and redirect to /join
  await page.waitForURL(new RegExp(`/sessions/${sid}/join$`), { timeout: 10000 });

  // localStorage secret should be cleared (FE cleans up on 403)
  const secretAfterBad = await page.evaluate(
    (id) => localStorage.getItem(`sbc.actingAs.${id}`),
    sid
  );
  expect(
    secretAfterBad,
    "FE must clear invalid sbc.actingAs.{sid} on 403"
  ).toBeNull();
  await page.screenshot({ path: SHOT(3, "bad-secret-falls-to-join"), fullPage: true });

  await anonCtx.close();
});