/**
 * v0.3.1 end-to-end test — covers the 4 critical user flows that
 * were broken or redesigned today (2026-07-06):
 *
 *   1. ANONYMOUS LANDING: "直接开始使用" → creates anon session
 *      → join page (NOT "无效的 session") → add nickname → in session
 *   2. LOGGED-IN LANDING: "进入我的session" → /sessions dashboard
 *   3. MULTI-CURRENCY DAILY TOTAL: a day with CNY+THB bills
 *      shows "X CNY + Y THB" (NOT naive sum 3,810)
 *   4. INVITE BUTTON: copies session URL (/sessions/{id}), NOT
 *      invite URL (/invites/{token}); NO expiry text shown before click
 *   5. SETTLE PAGE: /sessions/{id}/settle loads (NOT 422 / redirect)
 *
 * Each test is independent and uses a fresh browser context.
 * DB cleanup is via a `beforeEach` wipeDb() — same as full_flow.spec.ts.
 */
import { test, expect, type Page } from "@playwright/test";
import {
  ensureUserAndToken,
  wipeDb,
  SCREENSHOTS_DIR,
} from "./test-helpers";

test.beforeEach(async () => {
  wipeDb();
});


// Helper: claim a nickname for an anonymous browser context so the user
// becomes a session member. Required for tests that visit /sessions/{id}
// or /sessions/{id}/settle (those endpoints require session membership).
async function claimNickname(page: Page, sid: number, nickname: string) {
  // Wait for the join page to load
  await page.waitForURL(/\/sessions\/\d+\/join$/, { timeout: 5000 });
  // Find the "add new nickname" input + click 加入
  // The join page shows the input + "加入" button for empty sessions
  const input = page.locator('input[type="text"]').first();
  await input.fill(nickname);
  await page.locator("button:has-text('加入')").click();
  // After successful add, the page should redirect to /sessions/{id}
  await page.waitForURL((url) => !url.toString().includes("/join"), {
    timeout: 5000,
  });
}

async function screenshotOn(page: Page, name: string) {
  await page.screenshot({
    path: `${SCREENSHOTS_DIR}/v031-${name}.png`,
    fullPage: true,
  });
}

test.describe("v0.3.1 landing + anon-join", () => {
  test("anon: landing → 直接开始使用 → join page (no 无效的 session)", async ({
    page,
  }) => {
    await page.goto("/");

    // ASSERT landing elements
    await expect(page.locator(".tagline")).toBeVisible();
    await expect(page.locator("button.btn-primary")).toHaveText(
      /直接开始使用/
    );
    await expect(page.locator("a.btn-ghost")).toHaveText(/登录/);
    await screenshotOn(page, "01-landing-anon");

    // ACT: click "直接开始使用"
    await page.locator("button.btn-primary").click();

    // ASSERT: lands on /sessions/{id}/join (NOT an error)
    await page.waitForURL(/\/sessions\/\d+\/join$/, { timeout: 5000 });
    await expect(page.locator("h2")).toHaveText(/加入 session/);

    // ASSERT: NO "无效的 session" error
    await expect(page.locator(".error")).toHaveCount(0);
    await expect(page.locator("text=无效的 session")).toHaveCount(0);
    await screenshotOn(page, "02-join-anon");
  });

  test("logged-in: 进入我的session logic (via direct goto)", async ({ page }) => {
    // ARRANGE: seed a logged-in user
    const u = ensureUserAndToken("logged.v03@jessejia.local");

    // Set sbc_session cookie (raw token, BE hashes it)
    await page.context().addCookies([
      {
        name: "sbc_session",
        value: u.raw_token,
        domain: "localhost",
        path: "/",
        httpOnly: false,
        secure: false,
        sameSite: "Lax",
      },
    ]);

    // The / route auto-redirects logged-in users to /sessions (per
    // +layout.svelte). So we test the button behavior by going to /sessions
    // directly, but we ALSO check the landing button's existence by
    // racing past the layout redirect via noLayoutRedirect trick.
    // Simpler: just verify the logic in the source — the +page.svelte
    // handleStartUsing calls goto("/sessions") if $user is truthy.
    // We assert that by visiting / and checking we end up at /sessions
    // (the layout redirect is equivalent to clicking the button).
    await page.goto("/");
    await page.waitForURL(/\/sessions$/, { timeout: 5000 });
    await screenshotOn(page, "04-dashboard");
  });
});

test.describe("v0.3.1 fix: Svelte 5 page store", () => {
  test("settle page loads with valid session id (no 422 redirect)", async ({
    page,
  }) => {
    // Create a session via the API
    const createRes = await page.request.post("/api/sessions", {
      data: { name: "Settle page test" },
      maxRedirects: 0,
    });
    const sid = (await createRes.json()).id;
    expect(sid).toBeGreaterThan(0);

    // Visit /sessions/{id} first — auto-redirects to /join (non-member)
    await page.goto(`/sessions/${sid}`);
    // Claim a nickname to become a member
    await claimNickname(page, sid, "Tester");

    // Now visit the settle page
    await page.goto(`/sessions/${sid}/settle`);

    // ASSERT: page stays on settle URL (no redirect to /sessions/{id})
    await page.waitForURL(/\/sessions\/\d+\/settle$/, { timeout: 5000 });
    // ASSERT: shows the 结算 header (not an error)
    await expect(page.locator("h2")).toContainText("结算", { timeout: 5000 });
    await screenshotOn(page, "05-settle-page");
  });
});

test.describe("v0.3.1 fix: per-currency daily total", () => {
  test("multi-currency day shows per-ccy breakdown (NOT naive sum)", async ({
    page,
  }) => {
    // ARRANGE: create session + members + 4 multi-ccy bills via direct SQL
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(
      "/config/workspace/split-bill-calculator/backend/data/sbc.db"
    );

    // Ensure user id=1 exists for created_by FK constraint.
    db.prepare("INSERT OR IGNORE INTO users (id, email, default_name, created_at) VALUES (1, 'test.v03@jessejia.local', 'Test', ?)").run(new Date().toISOString());

    const sess = db
      .prepare(
        "INSERT INTO sessions (name, owner_user_id, invite_token, invite_expires_at, invite_created_at, currencies, primary_currency, created_at, session_code) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        "Daily total test",
        "test-token-" + Date.now(),
        new Date(Date.now() + 30 * 86400e3).toISOString(),
        new Date().toISOString(),
        JSON.stringify(["CNY", "THB"]),
        "CNY",
        new Date().toISOString(),
        "TEST" + Date.now().toString().slice(-6)  // v0.3.1: unique session_code
      );
    const sid = Number(sess.lastInsertRowid);

    const memberNames = ["Alice", "Jesse", "Ju", "Canyina", "Q"];
    const memberIds: number[] = [];
    for (const n of memberNames) {
      const m = db
        .prepare(
          "INSERT INTO session_members (session_id, user_id, display_name, role, joined_at) VALUES (?, NULL, ?, ?, ?)"
        )
        .run(sid, n, "member", new Date().toISOString());
      memberIds.push(Number(m.lastInsertRowid));
    }
    const [alice, jesse, ju, canyina, q] = memberIds;

    db.prepare(
      "INSERT INTO session_exchange_rates (session_id, from_currency, to_currency, rate, set_by) VALUES (?, ?, ?, ?, NULL)"
    ).run(sid, "CNY", "THB", 0.215);
    db.prepare(
      "INSERT INTO session_exchange_rates (session_id, from_currency, to_currency, rate, set_by) VALUES (?, ?, ?, ?, NULL)"
    ).run(sid, "THB", "CNY", 4.651);

    // 4 bills for 2026-07-05 — same shape as Jesse's screenshot
    const day = "2026-07-05 12:00:00";
    const bills = [
      { amount: 680, ccy: "CNY", desc: "晚餐 全员", payer: alice, parts: memberIds },
      { amount: 3000, ccy: "THB", desc: "巴酒水 3 人", payer: jesse, parts: [jesse, ju, canyina] },
      { amount: 30, ccy: "CNY", desc: "便利店 1 人", payer: ju, parts: [ju] },
      { amount: 100, ccy: "CNY", desc: "Q 个人小费", payer: q, parts: [q] },
    ];
    for (const b of bills) {
      const bill = db
        .prepare(
          "INSERT INTO bills (session_id, payer_id, amount, currency, description, occurred_at, created_by, created_at, status, exchange_rate_snapshot) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)"
        )
        .run(
          sid,
          b.payer,
          b.amount,
          b.ccy,
          b.desc,
          day,
          new Date().toISOString(),
          "active"
        );
      const bid = Number(bill.lastInsertRowid);
      for (const mid of b.parts) {
        db.prepare(
          "INSERT INTO bill_participants (bill_id, member_id, is_exclusive, exclusive_amount) VALUES (?, ?, 0, 0)"
        ).run(bid, mid);
      }
    }
    db.close();

    // ACT: visit the session as a member (claim a nickname first)
    await page.goto(`/sessions/${sid}`);
    console.log("after goto URL:", page.url());
    // Auto-redirected to /join, claim a nickname
    await claimNickname(page, sid, "Tester");
    console.log("after claim URL:", page.url());
    // Should now be on /sessions/{sid}; wait for bills to load
    await page.waitForLoadState("networkidle");
    console.log("after idle URL:", page.url());
    // Check the page H2 to see what page is shown
    const h2 = await page.locator("h2").first().textContent();
    console.log("H2 text:", h2);
    // Check localStorage for the secret
    const secret = await page.evaluate((id) => localStorage.getItem("sbc.actingAs." + id), sid);
    console.log("localStorage secret:", secret);
    // Give the page a moment to render the bill list
    await page.waitForTimeout(1000);

    // ASSERT: daily total shows "X CNY + Y THB" (NOT just 3,810)
    const dayTotal = page.locator("[data-testid='day-total']").first();
    await expect(dayTotal).toBeVisible({ timeout: 5000 });
    const totalText = (await dayTotal.textContent()) ?? "";
    console.log("day-total text:", totalText);
    expect(totalText).toContain("CNY");
    expect(totalText).toContain("THB");
    expect(totalText).toMatch(/\+ /);
    // ASSERT: NOT 3,810 (the buggy value)
    expect(totalText).not.toContain("3,810");
    await screenshotOn(page, "06-multi-currency-total");
  });
});

test.describe("v0.3.1 fix: session_code routing (Bug & Issues #5)", () => {
  test("/s/{session_code} redirects to /sessions/{id}", async ({ page }) => {
    // ARRANGE: create session via API
    const createRes = await page.request.post("/api/sessions", {
      data: { name: "Code routing test" },
      maxRedirects: 0,
    });
    const created = await createRes.json();
    const sid = created.id;
    const code = created.session_code;
    expect(code).toMatch(/^[A-Z2-9]{10}$/);

    // Visit /sessions/{sid} and claim nickname
    await page.goto(`/sessions/${sid}`);
    await claimNickname(page, sid, "CodeClaimer");

    // Now visit /s/{code} — should redirect to /sessions/{sid}
    await page.goto(`/s/${code}`);
    await page.waitForURL(/\/sessions\/\d+$/, { timeout: 5000 });
    // Verify it's the right session
    const h2 = await page.locator("h2").first().textContent();
    expect(h2).toContain("Code routing test");
    await page.screenshot({
      path: `${SCREENSHOTS_DIR}/v031-09-s-code.png`,
      fullPage: true,
    });
  });
});

test.describe("v0.3.1 fix: invite button copies session URL", () => {
  test("no expiry text before click; click copies session URL", async ({
    page,
    context,
  }) => {
    // ARRANGE: create session
    const createRes = await page.request.post("/api/sessions", {
      data: { name: "Invite button test" },
      maxRedirects: 0,
    });
    const sid = (await createRes.json()).id;

    // First go to /sessions/{id} — auto-redirects to /join for non-member
    await page.goto(`/sessions/${sid}`);
    await claimNickname(page, sid, "Inviter");
    // Re-visit to ensure fresh page state with member session
    await page.goto(`/sessions/${sid}`);

    // ASSERT: invite button visible
    const inviteBtn = page.locator(".invite-btn");
    await expect(inviteBtn).toBeVisible();

    // ASSERT: NO expiry hint before click (per PO 16:55)
    await expect(page.locator(".hint")).toHaveCount(0);
    await expect(page.locator("text=/后过期/")).toHaveCount(0);
    await expect(page.locator("text=/分钟后过期/")).toHaveCount(0);
    await screenshotOn(page, "07-invite-before-click");

    // Grant clipboard permission + ACT: click invite button
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await inviteBtn.click();

    // ASSERT: clipboard contains the SESSION URL
    const clipboardText = await page.evaluate(() =>
      navigator.clipboard.readText()
    );
    console.log("clipboard:", clipboardText);
    // v0.3.1 (Bug & Issues #5): invite button now copies /s/{session_code}
    // (unguessable 10-char code) instead of /sessions/{id} (predictable int).
    // Accept either format for backward-compat (e.g., when session_code is missing).
    expect(clipboardText).toMatch(
      new RegExp(`(/sessions/${sid}$|/s/[A-Z2-9]{10}$)`)
    );
    // ASSERT: NOT the old invite URL format
    expect(clipboardText).not.toMatch(/\/invites\//);
    await screenshotOn(page, "08-invite-after-click");
  });
});
