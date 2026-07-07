/**
 * TEST-009 — Rate limit on /auth/send-code (5/hour per email)
 *
 * Covers: Coverage-Gaps.md gap #9 (PRD §6.3 auth rate limit)
 *
 * What this verifies
 * ------------------
 * The BE enforces a 5-codes-per-hour limit per email on POST /auth/send-code.
 * The 6th request within the window MUST return 429 with:
 *   - body: { error: "rate limit exceeded", retry_after_minutes: N }
 *   - Header: Retry-After (if set by BE)
 *
 * Setup trick (per dev anti-pattern #44):
 *   - We do NOT call POST /auth/send-code 5 times to set up the limit
 *     (that would trigger SMTP and spam Jesse's outlook mailbox).
 *   - Instead we INSERT 5 verification_codes rows directly via SQLite
 *     so the rate-limit count is already at the ceiling.
 *   - Then a single POST /auth/send-code confirms the 6th call hits the
 *     guard and returns 429.
 *
 * Why this matters:
 *   - Without this test, regressions in the rate-limit guard (e.g.
 *     someone removing the count check) would silently let attackers
 *     spam send-code to any email, costing SMTP quota + Jesse's sanity.
 */
import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { wipeDb } from "./test-helpers";

// Mirror test-helpers.ts SQLITE_PATH so the file can run both on the
// VPS (where data/sbc.db is at the absolute path) and inside the
// codeserver container (where the path is /config/workspace/...).
const SQLITE_PATH =
  process.env.SBC_SQLITE_PATH ??
  "/config/workspace/split-bill-calculator/backend/data/sbc.db";

const BASE = "http://localhost:8448";
// Use a non-bypass email (per dev anti-pattern #44, bypass emails skip
// rate-limit + SMTP; we want the real guard).
const TEST_EMAIL = "ratelimit.rachel@jessejia.local";

test.beforeEach(() => {
  wipeDb();
});

test("TEST-009: 6th POST /auth/send-code within 1h → 429 (rate limit)", async ({
  request,
}) => {
  // ── Step 1: plant 5 verification_codes rows directly via SQL ────────
  // The BE rate-limit guard does:
  //   SELECT COUNT(*) FROM verification_codes
  //   WHERE email=? AND purpose='magic_link' AND created_at >= now-1h
  // 5 rows = ceiling; the next POST should hit 429.
  const db = new Database(SQLITE_PATH);
  try {
    // Find or create the user (the guard only counts rows, doesn't
    // require a User to exist, but it's cleaner to seed one).
    db.prepare(
      "INSERT OR IGNORE INTO users (email, default_name, created_at) VALUES (?, ?, ?)"
    ).run(TEST_EMAIL, TEST_EMAIL.split("@")[0], new Date().toISOString());

    // Clear any existing rate-limit window rows for this email.
    db.prepare("DELETE FROM verification_codes WHERE email = ?").run(TEST_EMAIL);

    const now = new Date();
    const insertCode = db.prepare(
      "INSERT INTO verification_codes (email, code, purpose, session_id, created_at, expires_at, used) VALUES (?, ?, ?, NULL, ?, ?, 0)"
    );
    for (let i = 0; i < 5; i++) {
      // Spread the 5 rows over the past hour (window_start = now-1h) so
      // they're all within the rate-limit window. Stagger by ~5 min each.
      const createdAt = new Date(now.getTime() - (50 - i * 10) * 60_000);
      const expiresAt = new Date(createdAt.getTime() + 10 * 60_000);
      insertCode.run(
        TEST_EMAIL,
        `${100000 + i}`.padStart(6, "0"), // any 6-digit code
        "magic_link",
        createdAt.toISOString(),
        expiresAt.toISOString()
      );
    }

    const count = (
      db
        .prepare("SELECT COUNT(*) as c FROM verification_codes WHERE email = ?")
        .get(TEST_EMAIL) as { c: number }
    ).c;
    expect(count, "should have 5 verification_codes planted").toBe(5);
  } finally {
    db.close();
  }

  // ── Step 2: POST /auth/send-code → expect 429 ───────────────────────
  const res = await request.post(`${BASE}/api/auth/send-code`, {
    data: { email: TEST_EMAIL },
  });
  expect(res.status(), "6th send-code within 1h must return 429").toBe(429);

  // ── Step 3: response body shape ─────────────────────────────────────
  const body = await res.json();
  expect(body.detail?.error).toBe("rate limit exceeded");
  expect(body.detail?.retry_after_minutes).toBeGreaterThanOrEqual(1);
  expect(body.detail?.retry_after_minutes).toBeLessThanOrEqual(60);

  // Optional: Retry-After header is set by BE (skip if not — it's a
  // nice-to-have, not a hard contract).
  // const retryAfter = res.headers()['retry-after'];
});

test("TEST-009b: under the 5/h limit, POST still works (returns 200)", async ({
  request,
}) => {
  // Sanity guard: confirm that planting only 4 rows does NOT trip 429.
  // (Uses the same direct-INSERT trick to avoid SMTP pollution.)
  const db = new Database(SQLITE_PATH);
  try {
    db.prepare(
      "INSERT OR IGNORE INTO users (email, default_name, created_at) VALUES (?, ?, ?)"
    ).run(TEST_EMAIL, TEST_EMAIL.split("@")[0], new Date().toISOString());
    db.prepare("DELETE FROM verification_codes WHERE email = ?").run(TEST_EMAIL);

    const now = new Date();
    const insertCode = db.prepare(
      "INSERT INTO verification_codes (email, code, purpose, session_id, created_at, expires_at, used) VALUES (?, ?, ?, NULL, ?, ?, 0)"
    );
    for (let i = 0; i < 4; i++) {
      const createdAt = new Date(now.getTime() - (50 - i * 10) * 60_000);
      const expiresAt = new Date(createdAt.getTime() + 10 * 60_000);
      insertCode.run(TEST_EMAIL, `${200000 + i}`.padStart(6, "0"), "magic_link", createdAt.toISOString(), expiresAt.toISOString());
    }
  } finally {
    db.close();
  }

  // Planted 4 rows; the next POST should be the 5th → still allowed.
  // ⚠️ This DOES call /auth/send-code once → 1 SMTP email to a non-jesse
  // test mailbox. Acceptable since the receiver is test-only and this
  // is the only way to verify the under-limit path end-to-end.
  const res = await request.post(`${BASE}/api/auth/send-code`, {
    data: { email: TEST_EMAIL },
  });
  expect(res.status(), "5th send-code (under limit) should succeed").toBeLessThan(300);
});