/**
 * TEST-004 — Invite URL end-to-end closed loop
 *
 * Covers: HIGH risk gap #4 from Coverage-Gaps.md
 *
 * What this verifies
 * ------------------
 * Full invite URL flow (the v0.3.1 main share path):
 *   1. Creator (logged-in or anon) creates session via wizard
 *   2. Creator copies invite URL `/s/{session_code}` (not /sessions/{id})
 *   3. Invitee (fresh browser context, no cookies/localStorage) visits URL
 *   4. /s/{code} redirects to /sessions/{id}/join (BUG-V031-A fix path)
 *   5. Invitee adds new nickname + clicks 加入 → joins session
 *   6. Invitee lands on session detail (has access via X-Nickname-Secret)
 *   7. Invitee creates a bill (anon bill creation flow, BE dep fix)
 *   8. Creator (separate tab) sees the new bill
 *
 * BE/FE contracts exercised:
 *   - POST /sessions with member_nicknames (wizard creates placeholders)
 *   - GET /sessions/by-code/{code} (lookup)
 *   - GET /sessions/{id} with X-Nickname-Secret (member access)
 *   - POST /join-claim action=claim (creator wizard auto-claim)
 *   - POST /join-claim action=add (invitee new nickname)
 *   - POST /bills (anon bill creation with null created_by)
 *   - localStorage sbc.actingAs.{sid} (anon identity persistence)
 *   - /s/{code} → /join redirect (BUG-V031-A fix from commit f2cd73d)
 */
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { wipeDb, ensureUserAndToken } from "./test-helpers";

const SCREENSHOTS_DIR = path.join(process.cwd(), "e2e", "screenshots");
const SCREENSHOT_STEP = (n: number, name: string) =>
  path.join(SCREENSHOTS_DIR, `test-004-${String(n).padStart(2, "0")}-${name}.png`);

const CREATOR_EMAIL = "test004.creator@jessejia.local";
const INVITEE_NICKNAME = "FriendTester";
const SESSION_NAME = "TEST-004 invite-e2e";

test.beforeAll(() => {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
});

test.beforeEach(() => {
  wipeDb();
});

async function loginAs(ctx: BrowserContext, rawToken: string) {
  await ctx.addCookies([
    {
      name: "sbc_session",
      value: rawToken,
      url: "http://localhost:8448",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);
}

/**
 * Read the actingAs secret from the page's localStorage.
 * Returns null if not present.
 */
async function getActingAsSecret(page: Page, sid: number): Promise<string | null> {
  return page.evaluate((id) => localStorage.getItem(`sbc.actingAs.${id}`), sid);
}

test("TEST-004: invite URL end-to-end — creator + invitee via /s/{code}", async ({
  browser,
}) => {
  // ── Setup: Creator (logged-in) ─────────────────────────────────────────
  const creator = ensureUserAndToken(CREATOR_EMAIL);
  const creatorCtx: BrowserContext = await browser.newContext({
    ignoreHTTPSErrors: true,
  });
  await loginAs(creatorCtx, creator.raw_token);
  const creatorPage = await creatorCtx.newPage();

  // Creator opens wizard + creates session
  await creatorPage.goto("http://localhost:8448/sessions/new");
  await creatorPage.waitForLoadState("networkidle");

  await creatorPage.locator("#session-name").fill(SESSION_NAME);
  await creatorPage.locator('button:has-text("下一步")').click();
  await creatorPage.waitForSelector('button:has-text("下一步"):nth-of-type(2)', {
    timeout: 5000,
  });
  await creatorPage.locator('button.btn-next').click(); // step 2 → 3
  await creatorPage.waitForSelector('.nickname-row input[type="text"]', {
    timeout: 5000,
  });
  const inputs = await creatorPage
    .locator('.nickname-row input[type="text"]')
    .all();
  expect(inputs.length).toBeGreaterThanOrEqual(2);
  await inputs[0].fill("Alice");
  await inputs[1].fill("Bob");
  await creatorPage.locator('button.btn-confirm').click();

  await creatorPage.waitForURL(/\/sessions\/\d+$/, { timeout: 10000 });
  const sessionId = Number(creatorPage.url().match(/\/sessions\/(\d+)/)![1]);
  expect(sessionId).toBeGreaterThan(0);

  // Get session_code + verify creator's role
  const creatorSecret = await getActingAsSecret(creatorPage, sessionId);
  // Logged-in creator should NOT have sbc.actingAs (no need for secret)
  expect(creatorSecret).toBeNull();

  const creatorSessionRes = await creatorPage.request.get(
    `http://localhost:8448/api/sessions/${sessionId}`
  );
  expect(creatorSessionRes.status()).toBe(200);
  const creatorSession = await creatorSessionRes.json();
  const sessionCode = creatorSession.session_code;
  expect(sessionCode).toMatch(/^[A-Z2-9]{10}$/);
  expect(creatorSession.owner_user_id).toBe(creator.user_id);

  // Members: creator + 2 placeholders
  expect(creatorSession.members.length).toBe(3);
  const creatorMember = creatorSession.members.find(
    (m: any) => m.role === "owner"
  );
  expect(creatorMember).toBeTruthy();
  expect(creatorMember.user_id).toBe(creator.user_id);

  await creatorPage.screenshot({
    path: SCREENSHOT_STEP(1, "creator-session-created"),
  });

  // ── Step 2: Invitee visits /s/{code} in fresh browser ─────────────────
  const inviteeCtx: BrowserContext = await browser.newContext({
    ignoreHTTPSErrors: true,
  });
  const inviteePage = await inviteeCtx.newPage();

  // Visit /s/{code} — should redirect to /join (BUG-V031-A fix)
  await inviteePage.goto(`http://localhost:8448/s/${sessionCode}`);
  await inviteePage.waitForLoadState("networkidle");

  // Critical assertion: redirected to /join, NOT stuck on /s/{code} error page
  expect(
    inviteePage.url(),
    `BUG-V031-A regression: /s/{code} should redirect to /join, got ${inviteePage.url()}`
  ).toContain(`/sessions/${sessionId}/join`);

  await inviteePage.screenshot({
    path: SCREENSHOT_STEP(2, "invitee-after-s-code-redirect"),
  });

  // ── Step 3: Invitee adds NEW nickname ──────────────────────────────────
  const NEW_NICK_INPUT = 'input[placeholder="你想叫什么名字？"]';
  await expect(inviteePage.locator(NEW_NICK_INPUT)).toBeVisible();
  await inviteePage.locator(NEW_NICK_INPUT).fill(INVITEE_NICKNAME);
  await inviteePage.locator('button:has-text("加入")').click();

  // Should redirect to /sessions/{id}
  await inviteePage.waitForURL(/\/sessions\/\d+$/, { timeout: 10000 });
  expect(inviteePage.url()).toContain(`/sessions/${sessionId}`);

  // localStorage secret set
  const inviteeSecret = await getActingAsSecret(inviteePage, sessionId);
  expect(inviteeSecret, "invitee's sbc.actingAs.{sid} should be set").toBeTruthy();

  await inviteePage.screenshot({
    path: SCREENSHOT_STEP(3, "invitee-joined-session"),
  });

  // Verify BE state via API
  const verifyRes = await inviteePage.request.get(
    `http://localhost:8448/api/sessions/${sessionId}`,
    { headers: { "X-Nickname-Secret": inviteeSecret! } }
  );
  expect(verifyRes.status()).toBe(200);
  const verifyData = await verifyRes.json();

  // Should have 4 members now: creator + Alice + Bob + FriendTester
  expect(verifyData.members.length).toBe(4);
  const friendMember = verifyData.members.find(
    (m: any) => m.display_name === INVITEE_NICKNAME
  );
  expect(friendMember).toBeTruthy();
  expect(friendMember.user_id).toBeNull();
  expect(friendMember.role).toBe("member");

  // ── Step 4: Invitee creates a bill ────────────────────────────────────
  // Use the API directly (anon bill creation flow)
  const billPayload = {
    amount: 150,
    currency: "CNY",
    description: "Invitee bill from TEST-004",
    occurred_at: new Date().toISOString().slice(0, 10),
    payer_member_id: friendMember.id,
    participants: [
      { member_id: friendMember.id },
      { member_id: creatorMember.id },
    ],
  };
  const billRes = await inviteePage.request.post(
    `http://localhost:8448/api/sessions/${sessionId}/bills`,
    {
      headers: { "X-Nickname-Secret": inviteeSecret! },
      data: billPayload,
    }
  );
  expect(
    billRes.status(),
    "anon bill creation should succeed"
  ).toBe(201);

  await inviteePage.screenshot({
    path: SCREENSHOT_STEP(4, "invitee-bill-created"),
  });

  // ── Step 5: Creator sees the bill (separate tab) ──────────────────────
  const creatorTab2 = await creatorCtx.newPage();
  await creatorTab2.goto(`http://localhost:8448/sessions/${sessionId}`);
  await creatorTab2.waitForLoadState("networkidle");

  // Should see invitee's bill in the bills list
  const bodyText = await creatorTab2.locator("body").innerText();
  // Bill is shown as amount + ccy text (e.g. "150.00 CNY"); description
  // may only be in detail view, so check amount instead.
  expect(bodyText, "creator should see the bill amount").toContain("150.00");
  expect(bodyText, "creator should see CNY currency").toContain("CNY");
  expect(bodyText, "creator should see FriendTester nickname").toContain(INVITEE_NICKNAME);
  // (¥ currency symbol is shown in detail view but not always in list summary;
  //  we verify CNY which is unambiguous.)

  await creatorTab2.screenshot({
    path: SCREENSHOT_STEP(5, "creator-sees-invitees-bill"),
  });

  // ── Step 6: Creator's settle page shows both members ──────────────────
  await creatorTab2.goto(`http://localhost:8448/sessions/${sessionId}/settle`);
  await creatorTab2.waitForLoadState("networkidle");
  const settleText = await creatorTab2.locator("body").innerText();
  // Creator's default_name "test004.creator" (from email local-part)
  expect(settleText).toContain("test004.creator");
  expect(settleText).toContain(INVITEE_NICKNAME);

  await creatorTab2.screenshot({
    path: SCREENSHOT_STEP(6, "settle-both-members"),
  });

  await creatorCtx.close();
  await inviteeCtx.close();
});
