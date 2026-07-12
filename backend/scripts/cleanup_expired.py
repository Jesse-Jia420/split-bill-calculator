"""Operational cleanup — drop stale `verification_codes` & `auth_tokens` rows.

Background
----------
v0.3.13 (SPEC §3.13): the SBC backend had no TTL cleanup for the two
session-data tables that every login handshake writes to. Over weeks of
e2e + manual + dev walks, the table sizes grew monotonically:

- ``verification_codes``: a new row for every ``POST /auth/send-code``,
  never reclaimed after the 6-digit code expired or got consumed.
- ``auth_tokens``: a new row for every successful
  ``POST /auth/verify-code`` (long-lived token), never reclaimed after
  expiry or 30+ days of inactivity.

The result is that logging back into SBC and looking at one's session
data sees years of cruft, including (in the xinhua dev account) 4 ACTIVE
auth_tokens issued in the same second during a single seed_dev_data
test-fixture run.

This script is the cleanup pass. It is **safe to run at any time** —
active sessions (tokens whose raw hash is matched at request time) are
never touched. It only operates on rows that are *already* dead from
the application's point of view.

Usage
-----
::

    cd backend
    .venv/bin/python -m scripts.cleanup_expired [--dry-run] [--quiet]

Options:
    --dry-run  Print the rows that would be deleted, but issue no DELETE.
    --quiet    Suppress per-row logging (only summary).

Exit codes:
    0   Success (or dry-run).
    1   Configuration error.
    2   SQL/runtime error.

Retention windows are read from ``settings.auth_token_ttl_days`` (default
30) and ``settings.verification_code_retention_days`` (default 7). Tune
via ``.env`` per environment. See SPEC.md §3.13 for the rationale.
"""
from __future__ import annotations

import argparse
import logging
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Ensure ``from app.X import Y`` works no matter how this script is invoked.
BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from sqlalchemy import text  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.core.database import SessionLocal  # noqa: E402
from app.db.models.auth_tokens import AuthToken  # noqa: E402
from app.db.models.verification_codes import (  # noqa: E402
    VerificationCode,
)

logger = logging.getLogger("scripts.cleanup_expired")


def _now() -> datetime:
    """Return the SQL 'now' as a timezone-aware UTC datetime.

    SQLite stores naive UTC; we anchor everything to UTC to keep the
    arithmetic consistent regardless of where the backend runs.
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)


def cleanup_verification_codes(db, *, dry_run: bool = False, quiet: bool = False) -> int:
    """Drop consumed/expired ``verification_codes`` rows older than retention.

    Active codes (unconsumed & unexpired) are NEVER touched.

    Returns the number of rows deleted (or that would be deleted in
    ``--dry-run`` mode).
    """
    retention_days = settings.verification_code_retention_days
    cutoff = _now() - timedelta(days=retention_days)

    # Two predicates cover the "dead" space: consumed (used=1) OR
    # expired (expires_at < cutoff is too aggressive — we only drop
    # rows whose *consumed_at-or-expires_at* plus retention is in the
    # past, so a freshly-expired code is kept for `retention_days`
    # before being swept).
    #
    # Simpler model adopted here: drop rows WHERE used=1 AND
    # created_at < cutoff — i.e. consumed codes that have been sitting
    # around longer than the retention window. Also drop rows WHERE
    # expires_at < (now - 1 hour) AND used=0 — already-expired codes
    # that were never consumed (e.g. user closed the login modal).
    stale_consumed_q = text(
        "SELECT id, email, code FROM verification_codes "
        "WHERE used = 1 AND created_at < :cutoff "
        "ORDER BY id"
    )
    stale_unused_q = text(
        "SELECT id, email, code FROM verification_codes "
        "WHERE used = 0 AND expires_at < :expired_before "
        "ORDER BY id"
    )
    expired_before = _now() - timedelta(hours=1)

    rows_consumed = db.execute(stale_consumed_q, {"cutoff": cutoff}).fetchall()
    rows_unused = db.execute(stale_unused_q, {"expired_before": expired_before}).fetchall()
    ids = [r[0] for r in (*rows_consumed, *rows_unused)]

    if not ids:
        if not quiet:
            logger.info(
                "verification_codes: nothing to clean "
                "(retention=%dd, expired&unused cutoff=%s)",
                retention_days,
                expired_before.isoformat(timespec="seconds"),
            )
        return 0

    if not quiet:
        logger.info(
            "verification_codes: %d stale row(s) "
            "(%d consumed-stale + %d unused-expired)",
            len(ids),
            len(rows_consumed),
            len(rows_unused),
        )
        sample = (*rows_consumed, *rows_unused)[: min(10, len(ids))]
        for r in sample:
            logger.info("  would drop id=%s email=%s code=%s", r[0], r[1], r[2])

    if dry_run:
        return len(ids)

    # Nuke in chunks (SQLite has a 999 placeholder limit).
    deleted = 0
    chunk_size = 200
    delete_q = text(f"DELETE FROM verification_codes WHERE id IN :ids").bindparams(
        # SQLAlchemy expanding bind needs an `expanding=True` declared
        # via `bindparam` — use a manual approach here instead.
        # rewriting: use any(...) — see below.
    )
    for i in range(0, len(ids), chunk_size):
        chunk = ids[i : i + chunk_size]
        placeholders = ",".join(f":id{j}" for j in range(len(chunk)))
        params = {f"id{j}": v for j, v in enumerate(chunk)}
        result = db.execute(
            text(f"DELETE FROM verification_codes WHERE id IN ({placeholders})"),
            params,
        )
        deleted += result.rowcount or 0
    db.commit()
    return deleted


def cleanup_auth_tokens(db, *, dry_run: bool = False, quiet: bool = False) -> int:
    """Drop stale ``auth_tokens`` rows.

    Two predicates again — but unlike verification_codes, an "active"
    auth_token is one whose ``expires_at > now`` AND whose raw-token
    cookie is still in someone's browser. We can't see who's holding
    the raw token; but we *can* safely delete:

    (a) rows whose ``expires_at < now`` (already expired — FE would
        reject them on next request),
    (b) rows older than ``auth_token_ttl_days`` AND whose
        ``last_used_at IS NULL`` (never used within the window — so
        no one still has the cookie).

    Tokens whose ``last_used_at IS NOT NULL`` and ``last_used_at > now -
    auth_token_ttl_days`` are presumed live and **never** deleted,
    even if they're old.

    Returns rows deleted (or would-be-deleted in --dry-run).
    """
    retention_days = settings.auth_token_ttl_days
    now = _now()
    inactivity_cutoff = now - timedelta(days=retention_days)

    stale_q = text(
        "SELECT id, user_id, token_hash, created_at, expires_at, last_used_at "
        "FROM auth_tokens "
        "WHERE "
        "  (expires_at < :now) "
        "  OR "
        "  (last_used_at IS NULL AND created_at < :inactivity_cutoff) "
        "ORDER BY id"
    )
    rows = db.execute(
        stale_q, {"now": now, "inactivity_cutoff": inactivity_cutoff}
    ).fetchall()

    if not rows:
        if not quiet:
            logger.info(
                "auth_tokens: nothing to clean "
                "(retention=%dd, inactivity cutoff=%s)",
                retention_days,
                inactivity_cutoff.isoformat(timespec="seconds"),
            )
        return 0

    if not quiet:
        logger.info("auth_tokens: %d stale row(s)", len(rows))
        for r in rows[: min(10, len(rows))]:
            logger.info(
                "  would drop id=%s user_id=%s expires=%s last_used=%s",
                r[0],
                r[1],
                str(r[4])[:19],
                str(r[5])[:19] if r[5] else "never",
            )

    if dry_run:
        return len(rows)

    ids = [r[0] for r in rows]
    deleted = 0
    chunk_size = 200
    for i in range(0, len(ids), chunk_size):
        chunk = ids[i : i + chunk_size]
        placeholders = ",".join(f":id{j}" for j in range(len(chunk)))
        params = {f"id{j}": v for j, v in enumerate(chunk)}
        result = db.execute(
            text(f"DELETE FROM auth_tokens WHERE id IN ({placeholders})"),
            params,
        )
        deleted += result.rowcount or 0
    db.commit()
    return deleted


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Drop stale verification_codes and auth_tokens rows per the "
            "SPEC.md §3.13 retention windows. Safe to run at any time."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be dropped; issue no DELETE.",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Suppress per-row logging; only print summary.",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.WARNING if args.quiet else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    db = SessionLocal()
    try:
        vc_deleted = cleanup_verification_codes(
            db, dry_run=args.dry_run, quiet=args.quiet
        )
        at_deleted = cleanup_auth_tokens(
            db, dry_run=args.dry_run, quiet=args.quiet
        )
    finally:
        db.close()

    action = "would drop" if args.dry_run else "dropped"
    logger.warning(
        "CLEANUP SUMMARY: verification_codes %s=%d, auth_tokens %s=%d",
        action,
        vc_deleted,
        action,
        at_deleted,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
