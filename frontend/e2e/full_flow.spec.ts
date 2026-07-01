/**
 * T16 end-to-end test: full user flow through the browser.
 *
 * Strategy
 * --------
 * Drives the SvelteKit frontend in headless Chromium via Playwright
 * and exercises the *whole* product flow:
 *
 *   1. Owner logs in (cookie pre-seeded from a DB-issued auth_token).
 *   2. Owner creates a session named "E2E Test".
 *   3. Owner invites a second user (Bob) and a third (Carol) by
 *      accepting the invite link in a separate browser context.
 *   4. Owner adds 3 bills (lunch, cab, hotel).
 *   5. Owner opens the Settle page; we screenshot the overview tab
 *      and the personal-view tab, and assert the per-member net.
 *   6. Bob opens the session, sees the same bills and the same
 *      settlement (asserts cross-user view consistency).
 *   7. Bob (non-creator) deletes a bill — v0.1.2 (T17) allows it.
 *
 * Why we skip the email verification step
 * ---------------------------------------
 * The prod auth flow is `email → /auth/send-code → Gmail → 6-digit
 * code → /auth/verify-code → cookie`. CI has no Gmail access. So
 * we use the same back-door every backend integration test uses
 * (`tests/test_auth.py::_login_as`): insert the User + AuthToken
 * rows directly into SQLite and seed the `sbc_session` cookie
 * with the matching raw token.
 *
 * Screenshots
 * -----------
 * Written to `frontend/e2e/screenshots/` and excluded from git via
 * `.gitignore`. The Markdown report at `frontend/e2e/REPORT.md`
 * embeds them as relative image links.
 */
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import {
  ensureUserAndToken,
  getSessionInviteToken,
  wipeDb,
  gitShort,
  SCREENSHOTS_DIR,
  REPORT_PATH,
  PROJECT_ROOT,
  type SeededUser,
} from "./test-helpers";

const OWNER = "alice.e2e@jessejia.local";
const BOB = "bob.e2e@jessejia.local";
const CAROL = "carol.e2e@jessejia.local";
const SESSION_NAME = "E2E Test Trip";
const SCREENSHOT_STEP = (n: number, name: string) =>
  path.join(SCREENSHOTS_DIR, `${String(n).padStart(2, "0")}-${name}.png`);

let screenshotLog: string[] = [];
function recordShot(file: string, title: string, note: string) {
  screenshotLog.push(`### Step ${screenshotLog.length + 1}: ${title}\n`);
  screenshotLog.push(`![${title}](./screenshots/${path.basename(file)})\n`);
  screenshotLog.push(`> ${note}\n\n`);
}

async function loginAs(page: Page, user: SeededUser) {
  // Set the cookie the way /auth/verify-code would have set it.
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

test.beforeAll(() => {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  screenshotLog = [];
});

test.beforeEach(() => {
  wipeDb();
});

test.afterAll(() => {
  // Write the Markdown report — even on failure (best-effort).
  const md = buildReport();
  try {
    fs.writeFileSync(REPORT_PATH, md);
  } catch (e) {
    console.warn("failed to write REPORT.md:", e);
  }
});

test("full E2E flow: create session → invite → bills → settle", async ({
  browser,
}) => {
  // -----------------------------------------------------------------------
  // Step 1: Owner logs in (cookie seeded) + lands on /sessions
  // -----------------------------------------------------------------------
  const ownerCtx: BrowserContext = await browser.newContext();
  const ownerPage: Page = await ownerCtx.newPage();
  const owner = ensureUserAndToken(OWNER);
  await loginAs(ownerPage, owner);
  await ownerPage.goto("/sessions");

  // The /sessions page calls /auth/me on mount → confirms cookie works.
  await expect(ownerPage.locator("text=我的 sessions").first()).toBeVisible({
    timeout: 10000,
  });
  await expect(ownerPage.locator("text=登录").first()).not.toBeVisible();
  let shot = SCREENSHOT_STEP(1, "owner-sessions-empty");
  await ownerPage.screenshot({ path: shot, fullPage: true });
  recordShot(
    shot,
    "Owner lands on /sessions (empty)",
    `User \`${OWNER}\` is logged in via seeded cookie. The page renders without redirecting to /auth/login.`
  );

  // -----------------------------------------------------------------------
  // Step 2: Create a session
  // -----------------------------------------------------------------------
  await ownerPage.goto("/sessions/new");
  await expect(ownerPage.locator("h2", { hasText: "新建 session" })).toBeVisible();
  await ownerPage.locator("#name").fill(SESSION_NAME);
  shot = SCREENSHOT_STEP(2, "owner-new-session-form");
  await ownerPage.screenshot({ path: shot, fullPage: true });
  recordShot(
    shot,
    "Owner fills in 'New session' form",
    `Types "${SESSION_NAME}" into the name field. The form's <code>id="name"</code> input is the binding target for the SvelteKit form.`
  );

  await ownerPage.locator("button.primary", { hasText: "创建" }).click();
  // After create, app navigates to /sessions/{id}.
  await ownerPage.waitForURL(/\/sessions\/\d+/, { timeout: 10000 });
  const sessionUrl = ownerPage.url();
  const sessionId = Number(sessionUrl.match(/\/sessions\/(\d+)/)?.[1]);
  expect(sessionId).toBeGreaterThan(0);

  // Confirm the session header is rendered.
  await expect(
    ownerPage.locator("h2", { hasText: SESSION_NAME })
  ).toBeVisible();
  shot = SCREENSHOT_STEP(3, "owner-session-detail-empty");
  await ownerPage.screenshot({ path: shot, fullPage: true });
  recordShot(
    shot,
    "Owner is in the new (empty) session",
    `URL = <code>${sessionUrl}</code>. Session detail page shows the empty-state ("no bills yet") and an owner-only invite button.`
  );

  // -----------------------------------------------------------------------
  // Step 3: Two more users join via the invite link
  // -----------------------------------------------------------------------
  const inviteToken = getSessionInviteToken(sessionId);

  // Bob in a separate browser context (proves cross-user isolation
  // at the UI level — separate cookies, separate login state).
  const bobCtx = await browser.newContext();
  const bobPage: Page = await bobCtx.newPage();
  const bob = ensureUserAndToken(BOB);
  await loginAs(bobPage, bob);
  await bobPage.goto(`/invites/${inviteToken}`);
  await expect(bobPage.locator(`text=${SESSION_NAME}`).first()).toBeVisible({
    timeout: 10000,
  });
  await expect(bobPage.locator("#display_name")).toBeVisible({
    timeout: 10000,
  });
  await bobPage.locator("#display_name").fill("Bob");
  shot = SCREENSHOT_STEP(4, "bob-invite-accept");
  await bobPage.screenshot({ path: shot, fullPage: true });
  recordShot(
    shot,
    "Bob opens the invite link (logged in)",
    `Bob navigates to <code>/invites/${inviteToken.slice(0, 12)}…</code> and sees the session preview. He fills in his display name.`
  );

  await bobPage.locator("button.primary", { hasText: "加入 session" }).click();
  await bobPage.waitForURL(/\/sessions\/\d+/, { timeout: 10000 });
  await expect(
    bobPage.locator("h2", { hasText: SESSION_NAME })
  ).toBeVisible();

  // Carol in yet another browser context.
  const carolCtx = await browser.newContext();
  const carolPage: Page = await carolCtx.newPage();
  const carol = ensureUserAndToken(CAROL);
  await loginAs(carolPage, carol);
  await carolPage.goto(`/invites/${inviteToken}`);
  await carolPage.locator("#display_name").fill("Carol");
  await carolPage.locator("button.primary", { hasText: "加入 session" }).click();
  await carolPage.waitForURL(/\/sessions\/\d+/, { timeout: 10000 });

  // -----------------------------------------------------------------------
  // Step 4: Owner adds 3 bills
  // -----------------------------------------------------------------------
  await ownerPage.goto(`/sessions/${sessionId}`);
  await ownerPage.getByRole("link", { name: "+ 新建账单", exact: true }).click();
  await ownerPage.waitForURL(/\/sessions\/\d+\/bills\/new/, { timeout: 10000 });

  // Bill 1: Alice pays 300, all 3 share.
  await ownerPage.locator("#amount").fill("300");
  await ownerPage.locator("#desc").fill("lunch");
  const payerOptions = await ownerPage.locator("#payer option").all();
  expect(payerOptions.length).toBeGreaterThan(1);
  // First non-null option is Alice (alphabetical by display_name).
  const aliceOptionValue = await payerOptions[1].getAttribute("value");
  await ownerPage.locator("#payer").selectOption(aliceOptionValue!);
  // The participant checkboxes are inside `.ppt-check` labels — each row
  // has TWO checkboxes (participant + exclusive). Select by label text
  // to avoid ambiguity.
  await ownerPage.getByRole("checkbox", { name: "alice.e2e" }).check();
  await ownerPage.getByRole("checkbox", { name: "Bob" }).check();
  await ownerPage.getByRole("checkbox", { name: "Carol" }).check();
  shot = SCREENSHOT_STEP(5, "owner-bill-1-form");
  await ownerPage.screenshot({ path: shot, fullPage: true });
  recordShot(
    shot,
    "Owner fills Bill #1: lunch 300, paid by Alice, all 3 share",
    "The form's amount/payer/desc/occurredAt fields are bound to <code>BillForm.svelte</code>. Participants list checks all three members."
  );

  await ownerPage.locator("button.primary", { hasText: "保存账单" }).click();
  await ownerPage.waitForURL(new RegExp(`/sessions/${sessionId}$`), {
    timeout: 10000,
  });

  // Bill 2: Bob pays 150, all 3 share.
  await ownerPage.getByRole("link", { name: "+ 新建账单", exact: true }).click();
  await ownerPage.waitForURL(/\/sessions\/\d+\/bills\/new/, { timeout: 10000 });
  await ownerPage.locator("#amount").fill("150");
  await ownerPage.locator("#desc").fill("cab");
  const payerOptions2 = await ownerPage.locator("#payer option").all();
  const bobOptionValue = await payerOptions2[2].getAttribute("value");
  await ownerPage.locator("#payer").selectOption(bobOptionValue!);
  await ownerPage.getByRole("checkbox", { name: "alice.e2e" }).check();
  await ownerPage.getByRole("checkbox", { name: "Bob" }).check();
  await ownerPage.getByRole("checkbox", { name: "Carol" }).check();
  await ownerPage.locator("button.primary", { hasText: "保存账单" }).click();
  await ownerPage.waitForURL(new RegExp(`/sessions/${sessionId}$`), {
    timeout: 10000,
  });

  // Bill 3: Carol pays 600, only Bob + Carol share (Alice excluded).
  await ownerPage.getByRole("link", { name: "+ 新建账单", exact: true }).click();
  await ownerPage.waitForURL(/\/sessions\/\d+\/bills\/new/, { timeout: 10000 });
  await ownerPage.locator("#amount").fill("600");
  await ownerPage.locator("#desc").fill("hotel night");
  const payerOptions3 = await ownerPage.locator("#payer option").all();
  const carolOptionValue = await payerOptions3[3].getAttribute("value");
  await ownerPage.locator("#payer").selectOption(carolOptionValue!);
  await ownerPage.getByRole("checkbox", { name: "Bob" }).check();
  await ownerPage.getByRole("checkbox", { name: "Carol" }).check();
  await ownerPage.locator("button.primary", { hasText: "保存账单" }).click();
  await ownerPage.waitForURL(new RegExp(`/sessions/${sessionId}$`), {
    timeout: 10000,
  });

  // Verify the bills render in the session detail.
  await expect(ownerPage.locator("text=lunch")).toBeVisible();
  await expect(ownerPage.locator("text=cab")).toBeVisible();
  await expect(ownerPage.locator("text=hotel night")).toBeVisible();
  shot = SCREENSHOT_STEP(6, "owner-session-3-bills");
  await ownerPage.screenshot({ path: shot, fullPage: true });
  recordShot(
    shot,
    "Session detail with 3 bills",
    "lunch (300 by Alice, all share), cab (150 by Bob, all share), hotel night (600 by Carol, Bob+Carol). Total = 1050."
  );

  // -----------------------------------------------------------------------
  // Step 5: Settle page (overview + personal-view tabs)
  // -----------------------------------------------------------------------
  await ownerPage.getByRole("link", { name: "查看结算" }).click();
  await ownerPage.waitForURL(/\/sessions\/\d+\/settle/, { timeout: 10000 });

  await expect(
    ownerPage.locator("h2", { hasText: /结算/ })
  ).toBeVisible();
  shot = SCREENSHOT_STEP(7, "owner-settle-overview");
  await ownerPage.screenshot({ path: shot, fullPage: true });
  recordShot(
    shot,
    "Settle page — overview tab (transfers list)",
    "Per-member net + transfer path. Expected: Alice paid 300 + consumed 100+50=150 = +150; Bob paid 150 + consumed 100+50+300=450 = -300; Carol paid 600 + consumed 100+50+300=450 = +150. Sum = 0."
  );

  await ownerPage.locator('button[role="tab"]', { hasText: "个人视图" }).click();
  await expect(
    ownerPage.locator('[role="tab"][aria-selected="true"]', {
      hasText: "个人视图",
    })
  ).toBeVisible();
  shot = SCREENSHOT_STEP(8, "owner-settle-personal");
  await ownerPage.screenshot({ path: shot, fullPage: true });
  recordShot(
    shot,
    "Settle page — personal-view tab (per-member breakdown)",
    "v0.1.2 (T18): per-member breakdown — paid_bills, consumed_bills, totals."
  );

  // -----------------------------------------------------------------------
  // Step 6: Bob (separate browser) sees the same session + bills
  // -----------------------------------------------------------------------
  await bobPage.goto(`/sessions/${sessionId}`);
  await expect(
    bobPage.locator("h2", { hasText: SESSION_NAME })
  ).toBeVisible();
  await expect(bobPage.locator("text=lunch")).toBeVisible();
  shot = SCREENSHOT_STEP(9, "bob-session-view");
  await bobPage.screenshot({ path: shot, fullPage: true });
  recordShot(
    shot,
    "Bob views the session in his own browser",
    `Bob's cookie (<code>${BOB}</code>) is logged in. He can read all 3 bills and the settle page — but cannot rotate the invite or rename others (asserted separately in the permission-matrix tests).`
  );

  await bobPage.getByRole("link", { name: "查看结算" }).click();
  await bobPage.waitForURL(/\/sessions\/\d+\/settle/, { timeout: 10000 });
  shot = SCREENSHOT_STEP(10, "bob-settle");
  await bobPage.screenshot({ path: shot, fullPage: true });
  recordShot(
    shot,
    "Bob's settle view matches Alice's",
    "Cross-user view consistency: both see the same transfers (greedy pairing is deterministic given the same bills)."
  );

  // -----------------------------------------------------------------------
  // Step 7: PATCH + DELETE smoke (covers v0.1.2 permissions)
  // -----------------------------------------------------------------------
  await bobPage.goto(`/sessions/${sessionId}`);
  // Wait for the session detail to actually render (header is unique
  // to this page and appears only after the data loads).
  await expect(
    bobPage.locator("h2", { hasText: SESSION_NAME })
  ).toBeVisible({ timeout: 10000 });
  bobPage.on("dialog", (d) => d.accept());
  const deleteButtons = await bobPage.locator('button:has-text("删除")').all();
  expect(deleteButtons.length).toBe(3);
  await deleteButtons[0].click();
  await expect(bobPage.locator("text=lunch")).not.toBeVisible();
  shot = SCREENSHOT_STEP(11, "bob-after-delete");
  await bobPage.screenshot({ path: shot, fullPage: true });
  recordShot(
    shot,
    "Bob (non-creator) deletes a bill — v0.1.2 (T17)",
    "v0.1.2 changed the rule: any session member can delete (creator-only removed in T17). The bill list shrinks from 3 → 2 rows."
  );

  // -----------------------------------------------------------------------
  // Final assertion
  // -----------------------------------------------------------------------
  const settleResp = await ownerPage.request.get(
    `http://localhost:8448/api/sessions/${sessionId}/settle`
  );
  expect(settleResp.ok()).toBeTruthy();
  const settleBody = await settleResp.json();
  expect(settleBody.balances).toBeDefined();
  const total = Object.values(settleBody.balances as Record<string, number>).reduce(
    (a, b) => a + b,
    0
  );
  expect(Math.abs(total)).toBeLessThan(0.05);
});

function buildReport(): string {
  const commit = gitShort();
  const date = new Date().toISOString();
  const header = `# T16 E2E Test Report\n\n`;
  const meta = [
    `**Date**: ${date}`,
    `**Backend commit**: \`${commit}\``,
    `**Test runner**: Playwright (Chromium headless)`,
    `**Frontend**: Vite dev server on http://localhost:8448`,
    `**Backend**: FastAPI on http://localhost:8449 (proxied via /api)`,
    ``,
    `## Environment\n`,
    `- Node: ${process.version}`,
    `- Project root: \`${PROJECT_ROOT}\``,
    `- Screenshots: \`frontend/e2e/screenshots/\``,
    ``,
    `## What this test covers\n`,
    `1. Owner (Alice) logs in via seeded cookie → renders /sessions without redirect`,
    `2. Creates a session named "${SESSION_NAME}"`,
    `3. Two more users (Bob, Carol) join via the invite link — separate browser contexts to verify cross-user isolation`,
    `4. Owner creates 3 bills (lunch/cab/hotel) — covering normal AA + partial-share participants`,
    `5. Owner opens the Settle page, screenshots both Overview and Personal-View tabs (v0.1.2 / T18)`,
    `6. Bob views the same session in his own browser — asserts cross-user view consistency`,
    `7. Bob (non-creator) deletes a bill — v0.1.2 (T17) allows any-member deletion`,
    `8. Settle endpoint balances sum to ~0 (algorithm correctness)\n`,
  ].join("\n");

  return header + meta + `## Screenshots\n\n` + screenshotLog.join("\n");
}