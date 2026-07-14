/**
 * TEST-008 — /invites/{token} → dispatch to /sessions/{id}/join
 *
 * Covers: Coverage-Gaps.md gap #8 (PRD §3.2 / §3.3)
 *
 * What this verifies
 * ------------------
 * v0.3.2 rewrote /invites/{token} to be a dispatcher (not a claim page):
 *   - Anon users → redirect to /sessions/{id}/join
 *   - Logged-in non-members → redirect to /sessions/{id}/join
 *   - Logged-in members → redirect to /sessions/{id}
 *   - Anon with valid secret → auto-redirect to /sessions/{id}
 *
 * This test verifies:
 * 1. Anonymous browser → /invites/{token} → redirect to /sessions/{id}/join
 * 2. Authenticated non-member → /invites/{token} → redirect to /sessions/{id}/join
 *    → fill nickname + 加入 → member of session
 * 3. Idempotency: re-accept = same session, no duplicate member
 *
 * Setup: use ensureUserAndToken for both owner + claimer (no DEV_BYPASS
 * SMTP round-trip). For anon steps, use a fresh context with no cookies.
 */
import { test, expect, type BrowserContext } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { ensureUserAndToken, wipeDb, type SeededUser } from "./test-helpers";

const BASE = "http://localhost:8448";
const OWNER_EMAIL = "invite.owner@jessejia.local";
const CLAIMER_EMAIL = "invite.claimer@jessejia.local";
const SESSION_NAME = "TEST-008 invite token dispatch";

const SCREENSHOTS_DIR = path.join(process.cwd(), "e2e", "screenshots");
const SCREENSHOT_STEP = (n: number, name: string) =>
  path.join(SCREENSHOTS_DIR, `test-008-${String(n).padStart(2, "0")}-${name}.png`);

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

test("TEST-008: /invites/{token} dispatches anon → /join, logged-in non-member → /join + join", async ({
  browser,
}) => {
  // ── Setup: owner creates session, gets invite token ──────────────────
  const owner = ensureUserAndToken(OWNER_EMAIL);
  const ownerCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  await loginAs(ownerCtx, owner);
  const ownerPage = await ownerCtx.newPage();

  const createRes = await ownerPage.request.post(`${BASE}/api/sessions`, {
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

  // Get invite token (owner is a member by default; can GET /invite).
  const inviteRes = await ownerPage.request.get(`${BASE}/api/sessions/${sid}/invite`);
  expect(inviteRes.status()).toBe(200);
  const invite = await inviteRes.json();
  const token = invite.token;
  expect(token).toMatch(/^[A-Za-z0-9_-]{16,}$/); // base64-ish, len >= 16
  expect(invite.url).toBe(`/invites/${token}`);
  expect(invite.status).toBe("active");

  // ── Step 1: anonymous browser hits /invites/{token} ──────────────────
  // v0.3.2: anon users are IMMEDIATELY redirected to /sessions/{id}/join
  const anonCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const anonPage = await anonCtx.newPage();
  await anonPage.goto(`${BASE}/invites/${token}`);
  await anonPage.waitForLoadState("networkidle");

  // Should redirect to /sessions/{id}/join
  await expect(anonPage).toHaveURL(/\/sessions\/\d+\/join/);

  // Join page shows the session name and "加入 session" heading
  await expect(anonPage.locator("h2", { hasText: "加入 session" })).toBeVisible();
  await expect(anonPage.getByText(SESSION_NAME)).toBeVisible();
  await anonPage.screenshot({ path: SCREENSHOT_STEP(1, "anon-join-redirect"), fullPage: true });

  await anonCtx.close();

  // ── Step 2: authenticated non-member hits /invites/{token} ────────────
  // v0.3.2: logged-in non-members are IMMEDIATELY redirected to /sessions/{id}/join
  // They use the join form (action=add) to join.
  const claimer = ensureUserAndToken(CLAIMER_EMAIL);
  const claimerCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  await loginAs(claimerCtx, claimer);
  const claimerPage = await claimerCtx.newPage();

  await claimerPage.goto(`${BASE}/invites/${token}`);
  await claimerPage.waitForLoadState("networkidle");

  // Should redirect to /sessions/{id}/join
  await expect(claimerPage).toHaveURL(/\/sessions\/\d+\/join/);

  // Join page: for logged-in non-member, shows existing nicknames OR add new
  // The input placeholder is "你的昵称" (not "你想叫什么名字？")
  const nicknameInput = claimerPage.locator('input[placeholder="你的昵称"]');
  await expect(nicknameInput).toBeVisible({ timeout: 5000 });
  await nicknameInput.fill("Eve-from-invite");
  await claimerPage.locator('button:has-text("加入")').click();

  // Should redirect to /sessions/{id}
  await claimerPage.waitForURL(new RegExp(`/sessions/${sid}(?:$|[^0-9])`), {
    timeout: 10000,
  });
  await claimerPage.screenshot({ path: SCREENSHOT_STEP(2, "after-join") });

  // ── Step 3: claimer is now a member ──────────────────────────────────
  const sessionRes = await claimerPage.request.get(`${BASE}/api/sessions/${sid}`);
  expect(sessionRes.status()).toBe(200);
  const sessionDetail = await sessionRes.json();
  const claimerMember = sessionDetail.members.find(
    (m: any) => m.user_id === claimer.user_id
  );
  expect(claimerMember, "claimer should now be a session member").toBeTruthy();
  expect(claimerMember.display_name).toBe("Eve-from-invite");

  // ── Step 4: re-join = same session, no duplicate member ────────────────
  // Navigate to /invites/{token} again — should redirect to /sessions/{id} (already a member)
  await claimerPage.goto(`${BASE}/invites/${token}`);
  await claimerPage.waitForLoadState("networkidle");
  // v0.3.2: logged-in member → redirect to /sessions/{id} (not the join page)
  await expect(claimerPage).toHaveURL(new RegExp(`/sessions/${sid}(?:$|[^0-9])`));

  // Members list still has exactly one claimer member (no duplicate).
  const afterRejoin = await (await claimerPage.request.get(`${BASE}/api/sessions/${sid}`)).json();
  const claimerMembersAfter = afterRejoin.members.filter(
    (m: any) => m.user_id === claimer.user_id
  );
  expect(
    claimerMembersAfter.length,
    "re-join should not create duplicate SessionMember"
  ).toBe(1);

  await ownerCtx.close();
  await claimerCtx.close();
});
