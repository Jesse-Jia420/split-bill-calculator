/**
 * Scenario 2: Multi-user via session_code (/s/{code})
 *
 * v0.3.1 → coverage: creator (anon) builds session via wizard →
 *   creator revisits via /s/{code} (auto-login as member) →
 *   invitee (fresh browser, no localStorage) visits /s/{code} → 403 +
 *   "打不开" error.
 *
 * Split out from full_e2e_journey.spec.ts.
 */
import { test, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";

const SCREENSHOTS_DIR = path.join(process.cwd(), "e2e", "screenshots");
let stepCounter = 0;
const shotPath = (n: number, name: string) =>
  path.join(SCREENSHOTS_DIR, `journey-code-${String(n).padStart(2, "0")}-${name}.png`);
const step = () => ++stepCounter;

test.beforeEach(() => {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  stepCounter = 0;
});

test("scenario 2 multi-user: creator + invitee via /s/{code}", async ({ browser }) => {
  // ── Creator (anonymous) creates session via wizard ───────────────────
  const creatorCtx = await browser.newContext();
  const creatorPage = await creatorCtx.newPage();
  await creatorPage.goto("/sessions/new");
  await creatorPage.locator("#session-name").fill("Multi-user session");
  await creatorPage.locator("button.btn-next", { hasText: "下一步" }).click();
  await expect(creatorPage.locator("h2", { hasText: "一共有多少人" })).toBeVisible();
  await creatorPage.locator("button.btn-next", { hasText: "下一步" }).click();
  await expect(creatorPage.locator("h2", { hasText: "每个人叫什么名字" })).toBeVisible();
  const cn = creatorPage.locator(".nickname-row input[type='text']");
  await cn.nth(0).fill("Creator");
  await cn.nth(1).fill("Friend");
  await creatorPage.locator("button.btn-confirm", { hasText: "确认创建" }).click();
  await creatorPage.waitForURL(/\/sessions\/\d+$/);
  const creatorSid = Number(creatorPage.url().match(/\/sessions\/(\d+)/)?.[1]);
  expect(creatorSid).toBeGreaterThan(0);

  // Fetch session_code + creator secret from localStorage
  const creatorSecret = await creatorPage.evaluate(
    (sid) => localStorage.getItem(`sbc.actingAs.${sid}`),
    creatorSid
  );
  expect(creatorSecret, "creator must have an X-Nickname-Secret after wizard").toBeTruthy();

  const sessionRes = await creatorPage.request.get(`/api/sessions/${creatorSid}`, {
    headers: { "X-Nickname-Secret": creatorSecret! },
  });
  expect(sessionRes.status()).toBe(200);
  const sessionData = await sessionRes.json();
  const sessionCode = sessionData.session_code;
  expect(sessionCode).toMatch(/^[A-Z2-9]{10}$/);

  await creatorPage.screenshot({ path: shotPath(step(), "creator-view"), fullPage: true });

  // ── Creator revisits via /s/{code} → should redirect to /sessions/{id} ──
  const creatorPage2 = await creatorCtx.newPage();
  await creatorPage2.goto(`/s/${sessionCode}`);
  await creatorPage2.waitForURL(new RegExp(`/sessions/${creatorSid}$`), { timeout: 10000 });
  await creatorPage2.waitForTimeout(500);
  await creatorPage2.screenshot({ path: shotPath(step(), "code-creator-redirect"), fullPage: true });

  const creator2Text = await creatorPage2.locator("body").textContent();
  expect(creator2Text).toContain("Multi-user session");

  // ── Invitee (separate browser, fresh state, no localStorage) ─────────
  // Non-member visits /s/{code} → BE 403 → "打不开" page.
  const inviteeCtx = await browser.newContext();
  const inviteePage = await inviteeCtx.newPage();
  await inviteePage.goto(`/s/${sessionCode}`);
  await inviteePage.waitForTimeout(2000); // wait for BE 403 + error display
  await inviteePage.screenshot({ path: shotPath(step(), "invitee-not-member"), fullPage: true });

  // Invitee must see an error message (not the session detail).
  const inviteeText = await inviteePage.locator("body").textContent();
  expect(
    inviteeText?.includes("打不开") || inviteeText?.includes("无法") || inviteeText?.includes("加入"),
    `invitee should see an error / join prompt (got: ${inviteeText?.slice(0, 200)})`
  ).toBe(true);

  await creatorCtx.close();
  await inviteeCtx.close();
});