/**
 * TEST-008 — 老 /invites/{token} 路径 claim
 *
 * Covers: Coverage-Gaps.md gap #8 (PRD §3.2 / §3.3)
 *
 * What this verifies
 * ------------------
 * 1. Owner GETs /api/sessions/{id}/invite to obtain a token + url.
 * 2. Anonymous browser (no cookie) navigates to /invites/{token}:
 *    - Public preview renders with session_name + inviter_display_name.
 *    - "登录 / 注册" CTA shows with ?next=/invites/{token} link.
 * 3. Authenticated user (cookie set) navigates to same /invites/{token}:
 *    - Accept form renders (input#display_name + "加入 session" button).
 *    - Submitting with display_name POSTs /invites/{token}/accept.
 *    - Redirects to /sessions/{sid}.
 *    - User is now a member (GET /api/sessions/{sid}/members includes them).
 * 4. Idempotency: re-accepting the same invite = same session_id, no dup.
 *
 * Real selectors (read from invites/[token]/+page.svelte):
 *   - #display_name input
 *   - button.primary:has-text("加入 session")
 *   - a:has-text("登录 / 注册") (for anon users)
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
const SESSION_NAME = "TEST-008 invite token claim";

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

test("TEST-008: /invites/{token} public preview + authenticated claim flow", async ({
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
  const anonCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const anonPage = await anonCtx.newPage();
  await anonPage.goto(`${BASE}/invites/${token}`);
  await anonPage.waitForLoadState("networkidle");

  // Preview renders session_name + inviter name.
  // ensureUserAndToken derives default_name from email local-part, so
  // inviter_display_name === 'invite.owner' for OWNER_EMAIL.
  const inviterDisplayName = OWNER_EMAIL.split("@")[0];
  await expect(anonPage.locator("h2", { hasText: "加入 session" })).toBeVisible();
  await expect(anonPage.getByText(SESSION_NAME)).toBeVisible();
  await expect(anonPage.getByText(inviterDisplayName)).toBeVisible();

  // "登录 / 注册" CTA visible with ?next=/invites/{token}
  const loginLink = anonPage.locator('a:has-text("登录 / 注册")');
  await expect(loginLink).toBeVisible();
  const loginHref = await loginLink.getAttribute("href");
  expect(loginHref).toContain("/auth/login");
  // next= may be raw or url-encoded depending on browser; check both.
  expect(loginHref).toMatch(/next=(?:%2F|\/)invites%2F|\/invites\//);
  await anonPage.screenshot({ path: SCREENSHOT_STEP(1, "anon-preview"), fullPage: true });

  await anonCtx.close();

  // ── Step 2: authenticated user hits /invites/{token} ────────────────
  const claimer = ensureUserAndToken(CLAIMER_EMAIL);
  const claimerCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  await loginAs(claimerCtx, claimer);
  const claimerPage = await claimerCtx.newPage();

  // Watch the accept POST so we can verify it succeeds.
  const acceptPromise = claimerPage.waitForResponse(
    (r) =>
      r.url().endsWith(`/invites/${token}/accept`) &&
      r.request().method() === "POST"
  );

  await claimerPage.goto(`${BASE}/invites/${token}`);
  await claimerPage.waitForLoadState("networkidle");

  // Accept form renders
  const displayNameInput = claimerPage.locator("#display_name");
  await expect(displayNameInput).toBeVisible();
  await expect(claimerPage.locator('button:has-text("加入 session")')).toBeVisible();
  await claimerPage.screenshot({ path: SCREENSHOT_STEP(2, "accept-form") });

  await displayNameInput.fill("Eve-from-invite");
  await claimerPage.locator('button:has-text("加入 session")').click();

  const acceptResp = await acceptPromise;
  expect(acceptResp.status(), "POST /invites/{token}/accept should be 2xx").toBeLessThan(300);
  const acceptBody = await acceptResp.json();
  expect(acceptBody.session_id).toBe(sid);
  expect(acceptBody.display_name).toBe("Eve-from-invite");

  // Redirect to session detail
  await claimerPage.waitForURL(new RegExp(`/sessions/${sid}(?:$|[^0-9])`), {
    timeout: 10000,
  });
  await claimerPage.screenshot({ path: SCREENSHOT_STEP(3, "after-accept") });

  // ── Step 3: claimer is now a member ──────────────────────────────────
  const sessionRes = await claimerPage.request.get(`${BASE}/api/sessions/${sid}`);
  expect(sessionRes.status()).toBe(200);
  const sessionDetail = await sessionRes.json();
  const claimerMember = sessionDetail.members.find(
    (m: any) => m.user_id === claimer.user_id
  );
  expect(claimerMember, "claimer should now be a session member").toBeTruthy();
  expect(claimerMember.display_name).toBe("Eve-from-invite");

  // ── Step 4: idempotency — re-accept = same session, no dup ──────────
  const reacceptPromise = claimerPage.waitForResponse(
    (r) =>
      r.url().endsWith(`/invites/${token}/accept`) &&
      r.request().method() === "POST"
  );
  await claimerPage.goto(`${BASE}/invites/${token}`);
  await claimerPage.waitForLoadState("networkidle");
  await claimerPage.locator("#display_name").fill("Different-name");
  await claimerPage.locator('button:has-text("加入 session")').click();
  const reacceptResp = await reacceptPromise;
  // Re-accept should still be 2xx (idempotent per BE docstring).
  expect(reacceptResp.status()).toBeLessThan(300);
  await claimerPage.waitForURL(new RegExp(`/sessions/${sid}(?:$|[^0-9])`));

  // Members list still has exactly one claimer member (no duplicate).
  const afterReaccept = await (await claimerPage.request.get(`${BASE}/api/sessions/${sid}`)).json();
  const claimerMembersAfter = afterReaccept.members.filter(
    (m: any) => m.user_id === claimer.user_id
  );
  expect(
    claimerMembersAfter.length,
    "idempotent re-accept should not create duplicate SessionMember"
  ).toBe(1);

  await ownerCtx.close();
  await claimerCtx.close();
});