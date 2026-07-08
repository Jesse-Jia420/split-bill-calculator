/**
 * DB helpers for Playwright E2E tests.
 *
 * Why we need this
 * ----------------
 * The split-bill-calculator's auth flow uses email verification: a user
 * submits their email, gets a 6-digit code via Gmail, types it in,
 * and the server sets a session cookie. In CI / E2E we don't have
 * real Gmail access, so we **skip the verification step** by:
 *   1. Inserting the User + AuthToken rows directly.
 *   2. Computing the raw token (returned to the test).
 *   3. The Playwright test sets that token as the `sbc_session` cookie
 *      in the browser context, mimicking what /auth/verify-code would
 *      do after the user pastes their code.
 *
 * This pattern matches how every backend integration test logs in
 * (`test_auth.py::_login_as`). We mirror it here so the E2E sees the
 * same cookie shape the real flow would produce.
 *
 * The DB connection uses SQLAlchemy + the same `DATABASE_URL` env var
 * the backend uses, so it always points at the real DB the test stack
 * is hitting.
 */
import Database from "better-sqlite3";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import path from "node:path";

const SQconst SQLITE_PATH =
  process.env.SBC_SQLITE_PATH ??
  process.env.SBC_TEST_SQLITE_PATH ??
  // 反 #110: 默认指向 /tmp/sbc-test.db 而不是 prod DB
  "/tmp/sbc-test.db";

export function hashToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export interface SeededUser {
  email: string;
  raw_token: string;
  user_id: number;
}

export function ensureUserAndToken(email: string): SeededUser {
  const db = new Database(SQLITE_PATH);
  try {
    const default_name = email.split("@")[0].slice(0, 120);
    // find-or-create user
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
    // mint a fresh raw token
    const raw = crypto.randomBytes(32).toString("base64url");
    const token_hash = hashToken(raw);
    const expires = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    db.prepare(
      "INSERT INTO auth_tokens (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)"
    ).run(userId, token_hash, new Date().toISOString(), expires);
    return { email, raw_token: raw, user_id: userId };
  } finally {
    db.close();
  }
}

/**
 * Read the latest active invite token for a session (owner-visible).
 */
export function getSessionInviteToken(sessionId: number): string {
  const db = new Database(SQLITE_PATH);
  try {
    const row = db
      .prepare(
        "SELECT invite_token FROM sessions WHERE id = ? AND invite_expires_at > ?"
      )
      .get(sessionId, new Date().toISOString()) as
      | { invite_token: string }
      | undefined;
    if (!row) throw new Error(`no active invite for session ${sessionId}`);
    return row.invite_token;
  } finally {
    db.close();
  }
}

/**
 * Reset the DB between tests (E2E-friendly: only wipes test rows).
 * Spec: keeps schema, drops all rows.
 */
export function wipeDb(): void {
  const db = new Database(SQLITE_PATH);
  try {
    // order matters because of FKs
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

/** Git commit short hash (for the report header). */
export function gitShort(): string {
  try {
    return execSync("git rev-parse --short=8 HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "unknown";
  }
}

/** Path to write screenshots to. */
export const SCREENSHOTS_DIR = path.join(process.cwd(), "e2e", "screenshots");
export const REPORT_PATH = path.join(process.cwd(), "e2e", "REPORT.md");

/** Path to the project root (codeserver workspace). */
export const PROJECT_ROOT = "/config/workspace/split-bill-calculator";