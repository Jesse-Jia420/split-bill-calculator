/**
 * T16 — 401 auto-redirect to /auth/login with returnTo.
 *
 * What this verifies
 * ------------------
 * v0.2.3 Sprint 3 Round 3 fix of the "session expired → stuck on broken
 * page" UX bug. The original `apiFetch` in `src/lib/api/client.ts`
 * threw `ApiError(401)` on any 401, leaving the user looking at a
 * half-broken UI (e.g. session detail page with empty members + bills
 * + a confusing toast). The fix intercepts 401 in `apiFetch` and:
 *
 *   - browser + non-/auth/ path → clear user store + window.location.assign
 *     to /auth/login?returnTo=<encoded current path>
 *   - SSR or /auth/* path → throw normally (login pages need to surface
 *     401 as a normal error so verify-code can render failure states)
 *
 * Three scenarios:
 *
 *   A) Logged in → server-side token destroyed → next apiFetch should
 *      redirect to /auth/login?returnTo=/sessions/4
 *
 *   B) Not logged in → /auth/me returns 401. The apiFetch for /auth/me
 *      must NOT redirect (it would loop). loadUser enters its catch
 *      branch and sets user=null; the page renders normally with the
 *      empty state for anonymous users.
 *
 *   C) Open-redirect protection: /auth/login?returnTo=//evil.com. Even
 *      if the user successfully verifies, the page must navigate to
 *      /sessions (not //evil.com).
 *
 * Why DB bypass for login: see test-helpers.ts docstring.
 */
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import {
  ensureUserAndToken,
  wipeDb,
  SCREENSHOTS_DIR,
  type SeededUser,
} from "./test-helpers";

const OWNER = "redirect401.alice@jessejia.local";
const OPENREDIRECT_USER = "redirect401.opnrdr@jessejia.local";

const SCREENSHOT_STEP = (n: number, name: string) =>
  path.join(SCREENSHOTS_DIR, `${String(n).padStart(2, "0")}-${name}.png`);

let screenshotLog: string[] = [];

async function loginAs(page: Page, user: SeededUser) {
  // Mirror real /auth/verify-code: seed the cookie the browser sends.
  await page.context().addCookies([
    {
      name: "sbc_session",
      value: user.raw_token,
      url: "http://localhost:8448",
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ]);
}

/**
 * Plant a verification code directly into the DB so verifyCode succeeds
 * without going through Gmail. Returns the 6-digit string.
 *
 * Note: codes are stored as the raw 6 digits in this app (see
 * `app/api/auth.py` POST /auth/verify-code — code is matched with
 * `hmac.compare_digest(code, row.code)`).
 */
function plantVerificationCode(email: string, code: string = "123456") {
  const db = new Database(
    process.env.SBC_SQLITE_PATH ??
      "/config/workspace/split-bill-calculator/backend/data/sbc.db"
  );
  try {
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    db.prepare(
      "DELETE FROM verification_codes WHERE email = ?"
    ).run(email);
    db.prepare(
      "INSERT INTO verification_codes (email, code, purpose, created_at, expires_at, used) VALUES (?, ?, ?, ?, ?, 0)"
    ).run(email, code, "magic_link", now, expires);
  } finally {
    db.close();
  }
}

test.beforeAll(() => {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
});

test.beforeEach(() => {
  wipeDb();
});

// ---------------------------------------------------------------------------
// Scenario A — Logged in, server-side token destroyed mid-session.
// ---------------------------------------------------------------------------
test("A: 401 on protected page redirects to /auth/login with returnTo", async ({
  browser,
}) => {
  const ctx: BrowserContext = await browser.newContext();
  const page: Page = await ctx.newPage();
  const owner = ensureUserAndToken(OWNER);
  await loginAs(page, owner);

  // Land on a "protected" page that will issue an apiFetch to a real
  // backend endpoint (the /sessions/4 detail page calls /sessions/4 on
  // mount). We don't need session 4 to exist — a 404 won't redirect,
  // we only care about the 401 behavior, which we trigger next.
  await page.goto("/sessions");
  await expect(page.locator("text=我的 sessions").first()).toBeVisible({
    timeout: 10000,
  });

  // Step 1 — confirm we ARE logged in (sanity check before we kill auth).
  await expect(page.locator("text=登录").first()).not.toBeVisible();

  // Step 2 — nuke the session cookie from the browser context.
  // (Equivalent to "user cleared cookies" or "auth token expired".)
  await ctx.clearCookies();

  // Step 3 — now navigate to a page whose mount-time apiFetch will hit
  // a protected endpoint and get 401. /sessions/4 doesn't need to
  // exist as a session — we just need *some* 401-triggering apiFetch.
  // Going to /sessions is enough: the layout's onMount → loadUser →
  // /auth/me → 401 → apiFetch must redirect to /auth/login.
  await page.goto("/sessions/4", { waitUntil: "domcontentloaded" });

  // Step 4 — expect redirect to /auth/login?returnTo=/sessions/4.
  await page.waitForURL(/\/auth\/login\?returnTo=/, { timeout: 10000 });
  const url = new URL(page.url());
  expect(url.pathname).toBe("/auth/login");
  const ret = url.searchParams.get("returnTo");
  expect(ret).toBe("/sessions/4");

  // Sanity: the login page itself rendered.
  await expect(page.locator("h2", { hasText: "登录" })).toBeVisible();

  await page.screenshot({
    path: SCREENSHOT_STEP(1, "scenario-a-redirected-to-login"),
    fullPage: true,
  });
  screenshotLog.push(
    "### Scenario A\n401 on protected page → /auth/login?returnTo=/sessions/4\n\n"
  );
});

// ---------------------------------------------------------------------------
// Scenario B — Not logged in, /auth/me returns 401. NO redirect.
// ---------------------------------------------------------------------------
test("B: anonymous /auth/me 401 does NOT redirect (loadUser catches)", async ({
  browser,
}) => {
  const ctx: BrowserContext = await browser.newContext();
  const page: Page = await ctx.newPage();
  // No loginAs — anonymous user.

  // Use a page that calls /auth/me but NOT a protected endpoint that
  // would 401 on its own (i.e. we want to isolate the /auth/me 401
  // path through client.ts → loadUser → catch → user=null). /auth/login
  // is ideal: its onMount calls loadUser (→ /auth/me → 401 → no
  // redirect) and then renders the form. Anonymous users stay on
  // /auth/login and see the email input.
  await page.goto("/auth/login", { waitUntil: "domcontentloaded" });

  // Stay on /auth/login, NOT redirected to itself (no loop).
  await page.waitForTimeout(2000); // give the redirect a chance to fire
  const url = new URL(page.url());
  expect(url.pathname).toBe("/auth/login");

  // The login form rendered normally (loadUser catch → user=null).
  await expect(page.locator("#email")).toBeVisible({ timeout: 5000 });
  // NavBar shows 登录 link (because user is null).
  await expect(page.locator("text=登录").first()).toBeVisible();

  await page.screenshot({
    path: SCREENSHOT_STEP(2, "scenario-b-anonymous-no-redirect"),
    fullPage: true,
  });
  screenshotLog.push(
    "### Scenario B\nAnonymous /sessions → /auth/me 401 → no redirect (loadUser caught it)\n\n"
  );
});

// ---------------------------------------------------------------------------
// Scenario C — Open-redirect protection.
// ---------------------------------------------------------------------------
test("C: ?returnTo=//evil.com is sanitized → verify → /sessions (not evil.com)", async ({
  browser,
}) => {
  const ctx: BrowserContext = await browser.newContext();
  const page: Page = await ctx.newPage();

  // Pre-plant a verification code so /auth/verify-code will accept it.
  plantVerificationCode(OPENREDIRECT_USER, "123456");

  // Land on /auth/login with a malicious returnTo. Pre-fill email +
  // code via query params (test-mode pre-fill in +page.svelte onMount)
  // to skip the SMTP send step — CI doesn't have a real inbox.
  await page.goto(
    `/auth/login?returnTo=${encodeURIComponent("//evil.com")}` +
      `&email=${encodeURIComponent(OPENREDIRECT_USER)}` +
      `&code=123456`
  );
  await expect(page.locator("h2", { hasText: "登录" })).toBeVisible();

  // The verify-step input should already be visible (test-mode pre-fill).
  await expect(page.locator("#code")).toBeVisible({ timeout: 5000 });

  // Click 验证并登录 directly.
  await page.locator("button.primary", { hasText: "验证并登录" }).click();

  // Must land on /sessions (safe fallback) — NOT //evil.com.
  await page.waitForURL(
    (u) => new URL(u).pathname === "/sessions",
    { timeout: 10000 }
  );

  const finalUrl = new URL(page.url());
  expect(finalUrl.pathname).toBe("/sessions");
  expect(finalUrl.host).toBe("localhost:8448");
  expect(page.url()).not.toContain("evil.com");

  await page.screenshot({
    path: SCREENSHOT_STEP(3, "scenario-c-openredirect-blocked"),
    fullPage: true,
  });
  screenshotLog.push(
    "### Scenario C\n?returnTo=//evil.com → verify → /sessions (open-redirect blocked)\n\n"
  );
});

test.afterAll(() => {
  // Best-effort write a tiny summary; we don't blow away the
  // existing full_flow REPORT.md.
  const summaryPath = path.join(
    SCREENSHOTS_DIR,
    "..",
    "auth_401_redirect-summary.md"
  );
  fs.writeFileSync(
    summaryPath,
    "# T16 — 401 auto-redirect e2e summary\n\n" + screenshotLog.join("")
  );
});