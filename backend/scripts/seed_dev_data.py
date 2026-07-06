"""Seed split-bill-calculator with development test data.

This module is imported by ``app.main`` on uvicorn startup (via lifespan
hook) and idempotently creates the canonical test fixtures that the
frontend / Sprint verification flow expects to see:

- 1 user (xinhua1001@outlook.com) — also matches the live test account.
- 2 sessions owned by that user:
    * ``泰国测试账单 6.19-6.22`` — 5 members + 27 bills (THB).
    * ``个人测试`` — 1 member (the owner), 0 bills.
- 4 helper User rows backing the Thailand session members
  (Ju / Canyina / Q / 像汤圆一样圆.).

The script is **idempotent**: if a session with the given name already
exists for this owner, it is left untouched (no member / bill churn).
This is what keeps test data alive across dev clones, Coder handovers,
and any future truncate events.

The script **skips entirely** when ``ENV=production`` is set in the
environment, so a production deploy will never accidentally seed dev
fixtures.

History
-------
- v0.1.2 / 2026-07-01: started life as ``_setup_xinhua1001.py``
  (gitignored, xlsx-driven, never committed).
- v0.2 / 2026-07-02 (Sprint 2 prep): moved to git-safe
  ``scripts/seed_dev_data.py`` and hardcoded the 27 bills into Python
  so the binary xlsx is no longer a runtime dependency. See antipattern
  #46 in MEMORY.md.
"""
from __future__ import annotations

import os
import secrets
import sys
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from typing import Any

# Ensure the backend root is importable so ``from app.X import Y`` works
# regardless of how this module is invoked (lifespan hook, CLI, tests).
BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from sqlalchemy import text  # noqa: E402

from sqlalchemy.orm import Session as OrmSession  # noqa: E402

from app.core.database import SessionLocal  # noqa: E402
from app.db.models.bill_participants import BillParticipant  # noqa: E402
from app.db.models.bills import Bill  # noqa: E402
from app.db.models.session_exchange_rates import SessionExchangeRate  # noqa: E402
from app.db.models.session_members import SessionMember, SessionRole  # noqa: E402
from app.db.models.sessions import Session as BillSession  # noqa: E402
from app.db.models.users import User  # noqa: E402

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #

TZ_SH = timezone(timedelta(hours=8))

# Live test account. The matching ``User`` row is created on first run
# and reused thereafter; renaming it would orphan the xinhua1001 login.
TEST_USER_EMAIL = "xinhua1001@outlook.com"

# Thailand session members, in display order.
# Index 0 is the owner (xinhua1001 user); indices 1..4 are the four
# auxiliary accounts. The member index drives payer/participant lookups
# in THAILAND_BILLS below.
THAILAND_MEMBERS: list[tuple[str, str, str]] = [
    # (display_name, role, owner_email)
    # When ``owner_email`` is empty, the member is owned by the test user
    # (xinhua). Otherwise the auxiliary user identified by that email
    # owns the member row.
    ("Jesse",          SessionRole.OWNER.value,  ""),
    ("Ju",             SessionRole.MEMBER.value, "ju@thailand.local"),
    ("Canyina",        SessionRole.MEMBER.value, "canyina@thailand.local"),
    ("Q",              SessionRole.MEMBER.value, "q@thailand.local"),
    ("像汤圆一样圆.",   SessionRole.MEMBER.value, "rounded@thailand.local"),
]

# Hardcoded 27 bills (THB) extracted from ``_test_bills.xlsx`` Sheet2 on
# 2026-07-02. Each tuple is:
#     (description, amount, payer_member_idx, occurred_at_iso, participant_indices)
#
# - member index 0..4 maps to THAILAND_MEMBERS above
#   (0=Jesse, 1=Ju, 2=Canyina, 3=Q, 4=像汤圆一样圆.)
# - occurred_at_iso is timezone-aware (Asia/Shanghai)
# - participant_indices is a list of member indices who split the bill.
THAILAND_BILLS: list[tuple[str, float, int, str, list[int]]] = [
    ("6.19打车",                   159.0,  2, "2026-06-19T20:00:00+08:00", [0, 1, 3, 4]),
    ("午餐",                       900.0,  3, "2026-06-20T12:00:00+08:00", [0, 1, 2, 3, 4]),
    ("晚餐妈妈面",                 1340.0, 0, "2026-06-20T12:00:00+08:00", [0, 1, 2, 3, 4]),
    ("搭船",                       150.0,  0, "2026-06-20T12:00:00+08:00", [0, 1, 2, 3, 4]),
    ("6.19打车3人",                200.0,  2, "2026-06-19T20:00:00+08:00", [1, 3, 4]),
    ("6.20打车5人",                169.0,  1, "2026-06-20T20:00:00+08:00", [0, 1, 2, 3, 4]),
    ("晚餐中国米粉",               606.0,  0, "2026-06-20T12:00:00+08:00", [0, 1, 3, 4]),
    ("虾",                         200.0,  3, "2026-06-20T12:00:00+08:00", [3, 4]),
    ("6.20酒吧4人",                2813.0, 0, "2026-06-20T20:00:00+08:00", [0, 1, 3, 4]),
    ("6.20打车4人 打抛饭到照相馆",  69.0,   4, "2026-06-20T20:00:00+08:00", [0, 1, 3, 4]),
    ("6.20打车4人 照相馆",         330.0,  0, "2026-06-20T20:00:00+08:00", [0, 1, 3, 4]),
    ("6.20打车2人 Old Siam Plaza", 125.0,  0, "2026-06-20T20:00:00+08:00", [0, 3]),
    ("6.21打车4人",                277.0,  1, "2026-06-21T20:00:00+08:00", [0, 1, 3, 4]),
    ("6.21 商场午饭4人",           1406.0, 4, "2026-06-21T20:00:00+08:00", [0, 1, 3, 4]),
    ("6.21打车3人 去TK Seafood",   177.0,  0, "2026-06-21T20:00:00+08:00", [0, 3, 4]),
    ("6.21打车4人 去myday按摩",    136.0,  0, "2026-06-21T20:00:00+08:00", [0, 1, 3, 4]),
    ("6.21打车4人 myday按摩完回家", 93.0,  4, "2026-06-21T20:00:00+08:00", [0, 1, 3, 4]),
    ("6.21吃饭3人 TK Seafood",     2000.0, 1, "2026-06-21T20:00:00+08:00", [0, 3, 4]),
    ("6.22打车4人 大金佛",         89.0,   0, "2026-06-22T20:00:00+08:00", [0, 1, 3, 4]),
    ("6.22午吃饭4人 酒店楼下餐厅", 1145.0, 0, "2026-06-22T20:00:00+08:00", [0, 1, 3, 4]),
    ("6.22晚吃饭3人",              1560.0, 0, "2026-06-22T20:00:00+08:00", [0, 1, 3]),
    ("6.22打车3人 泰拳去",         144.0,  0, "2026-06-22T20:00:00+08:00", [0, 1, 3]),
    ("6.22打车3人 泰拳回",         200.0,  3, "2026-06-22T20:00:00+08:00", [0, 1, 3]),
    ("6.21打车3人去central world", 125.0,  3, "2026-06-21T20:00:00+08:00", [0, 3, 4]),
    ("6.22打车大金佛回民宿",       109.0,  3, "2026-06-22T20:00:00+08:00", [0, 1, 3, 4]),
    ("6.22打车去酒店",             100.0,  3, "2026-06-22T20:00:00+08:00", [3, 4]),
    ("6.22榴莲",                   550.0,  3, "2026-06-22T20:00:00+08:00", [0, 3]),
]

THAILAND_SESSION_NAME = "泰国测试账单 6.19-6.22"
PERSONAL_SESSION_NAME = "个人测试"

# Auxiliary user accounts backing the non-owner Thailand members.
# Each entry: (email, default_name). The seed creates the User on first
# run and never modifies it thereafter.
THAILAND_AUX_USERS: list[tuple[str, str]] = [
    ("ju@thailand.local",      "Ju"),
    ("canyina@thailand.local", "Canyina"),
    ("q@thailand.local",       "Q"),
    ("rounded@thailand.local", "像汤圆一样圆"),
]


# --------------------------------------------------------------------------- #
# Core seeding logic
# --------------------------------------------------------------------------- #



def _generate_session_code() -> str:
    """v0.3.1 (Bug & Issues #5): unguessable 10-char session code.
    Same alphabet + length as backend/app/api/sessions.py."""
    import secrets as _secrets
    _ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(_secrets.choice(_ALPHABET) for _ in range(10))



def _ensure_user(db: OrmSession, email: str, default_name: str) -> User:
    """Idempotently create / fetch a user row."""
    user = db.query(User).filter_by(email=email).first()
    if user is None:
        user = User(email=email, default_name=default_name)
        db.add(user)
        db.flush()
    elif user.default_name != default_name:
        # Mirror the Coder 12 setup: keep default_name consistent so the
        # UI shows the same label across dev reseeds.
        user.default_name = default_name
        db.flush()
    return user


def _ensure_thailand_session(
    db: OrmSession, owner: User, now: datetime
) -> tuple[BillSession, list[SessionMember]]:
    """Find-or-create the Thailand session + its 5 members.

    Returns ``(session, members)``. If the session already exists we
    fetch and return its current members without mutation. Also seeds
    the v0.2.2 session_exchange_rates row(s) so the bills in this
    session can settle without 422 — the Thailand trip's canonical
    rate was 1 THB ≈ 0.2150 CNY at the time of recording.
    """
    session = (
        db.query(BillSession)
        .filter(
            BillSession.name == THAILAND_SESSION_NAME,
            BillSession.owner_user_id == owner.id,
        )
        .first()
    )
    if session is not None:
        members = (
            db.query(SessionMember)
            .filter(SessionMember.session_id == session.id)
            .order_by(SessionMember.id)
            .all()
        )
        # v0.2.2 (T12): if there are no exchange rates yet for this
        # session but there ARE THB bills, seed the canonical rate so
        # the existing bills can be settled (the migration's data
        # backfill only fires once during alembic upgrade).
        _maybe_seed_thailand_rates(db, session, owner)
        return session, members

    session = BillSession(
        name=THAILAND_SESSION_NAME,
        owner_user_id=owner.id,
        invite_token="thailand-test-2026-07-01-xinhua",
        invite_expires_at=now + timedelta(days=30),
        invite_created_at=now,
        session_code=_generate_session_code(),
    )
    db.add(session)
    db.flush()

    # Resolve each member's owner user. Index 0 is the test user;
    # indices 1..4 are the auxiliary accounts (already ensured).
    aux_by_email = {
        email: _ensure_user(db, email, default_name)
        for email, default_name in THAILAND_AUX_USERS
    }

    members: list[SessionMember] = []
    for display_name, role, owner_email in THAILAND_MEMBERS:
        if owner_email:
            member_user = aux_by_email[owner_email]
        else:
            member_user = owner
        sm = SessionMember(
            session_id=session.id,
            user_id=member_user.id,
            display_name=display_name,
            role=role,
        )
        db.add(sm)
        members.append(sm)
    db.flush()
    _maybe_seed_thailand_rates(db, session, owner)
    return session, members


# v0.2.2 (T12): the canonical THB<->CNY rate the test suite recorded
# against. The migration's data backfill needs this row to be present
# OR settle will 422 on historical bills.
_THAILAND_THB_TO_CNY = Decimal("0.21500000")
_THAILAND_CNY_TO_THB = (Decimal("1") / _THAILAND_THB_TO_CNY).quantize(
    Decimal("0.00000001"), rounding=ROUND_HALF_UP
)


def _maybe_seed_thailand_rates(
    db: OrmSession, session: BillSession, owner: User
) -> None:
    """Seed the THB<->CNY rates for the Thailand session (idempotent).

    Only inserts when:
    - the session has at least one bill in a currency other than the
      primary (i.e. it actually needs rates), AND
    - no rate row exists yet for either direction.

    Safe to call from both the create and the find paths of
    ``_ensure_thailand_session``. ``db.commit()`` is the caller's job
    — we only ``db.flush()`` here.
    """
    from decimal import Decimal as _D
    has_foreign_bills = (
        db.query(Bill)
        .filter(Bill.session_id == session.id, Bill.currency != "CNY")
        .count()
        > 0
    )
    if not has_foreign_bills:
        return
    existing = (
        db.query(SessionExchangeRate)
        .filter(SessionExchangeRate.session_id == session.id)
        .count()
    )
    if existing > 0:
        return
    db.add(
        SessionExchangeRate(
            session_id=session.id,
            from_currency="THB",
            to_currency="CNY",
            rate=_D("0.21500000"),
            snapshot_at=datetime.now(timezone.utc),
            set_by=owner.id,
        )
    )
    db.add(
        SessionExchangeRate(
            session_id=session.id,
            from_currency="CNY",
            to_currency="THB",
            rate=_THAILAND_CNY_TO_THB,
            snapshot_at=datetime.now(timezone.utc),
            set_by=owner.id,
        )
    )
    db.flush()

    # Backfill any NULL snapshots on existing THB bills in this
    # session so settle doesn't 422.
    db.execute(
        text(
            """
            UPDATE bills SET exchange_rate_snapshot = (
                SELECT ser.rate FROM session_exchange_rates ser
                WHERE ser.session_id = bills.session_id
                  AND ser.from_currency = bills.currency
                  AND ser.to_currency = (
                      SELECT primary_currency FROM sessions s WHERE s.id = bills.session_id
                  )
                LIMIT 1
            )
            WHERE session_id = :sid
              AND exchange_rate_snapshot IS NULL
              AND currency <> (
                  SELECT primary_currency FROM sessions s WHERE s.id = bills.session_id
              )
            """
        ),
        {"sid": session.id},
    )


def _ensure_personal_session(
    db: OrmSession, owner: User, now: datetime
) -> BillSession:
    """Find-or-create the empty personal session owned by ``owner``."""
    existing = (
        db.query(BillSession)
        .filter(
            BillSession.name == PERSONAL_SESSION_NAME,
            BillSession.owner_user_id == owner.id,
        )
        .first()
    )
    if existing is not None:
        return existing

    personal = BillSession(
        name=PERSONAL_SESSION_NAME,
        owner_user_id=owner.id,
        invite_token=secrets.token_urlsafe(32),
        session_code=_generate_session_code(),
        invite_expires_at=now + timedelta(days=30),
        invite_created_at=now,
    )
    db.add(personal)
    db.flush()

    sm = SessionMember(
        session_id=personal.id,
        user_id=owner.id,
        display_name="Jesse",
        role=SessionRole.OWNER.value,
    )
    db.add(sm)
    db.flush()
    return personal


def _backfill_bill_snapshots(db: OrmSession, session_id: int) -> None:
    """Fill in NULL exchange_rate_snapshot rows for a session's bills.

    v0.2.2 (T12): the seed inserts THB bills and (now) creates the
    THB<->CNY rate, but seed order matters — we want to ensure the
    bills end up with a snapshot regardless of which path ran first.
    Safe to run after the migration's data backfill.
    """
    db.execute(
        text(
            """
            UPDATE bills SET exchange_rate_snapshot = (
                SELECT ser.rate FROM session_exchange_rates ser
                WHERE ser.session_id = bills.session_id
                  AND ser.from_currency = bills.currency
                  AND ser.to_currency = (
                      SELECT primary_currency FROM sessions s WHERE s.id = bills.session_id
                  )
                LIMIT 1
            )
            WHERE session_id = :sid
              AND exchange_rate_snapshot IS NULL
              AND currency <> (
                  SELECT primary_currency FROM sessions s WHERE s.id = bills.session_id
              )
            """
        ),
        {"sid": session_id},
    )


def _seed_thailand_bills(
    db: OrmSession,
    session: BillSession,
    members: list[SessionMember],
    now: datetime,
) -> int:
    """Create 27 THB bills for the Thailand session.

    Returns the number of bills created (0 if they already exist — we
    never recreate). Idempotent: only inserts when there are no bills
    yet for this session.
    """
    existing_count = (
        db.query(Bill).filter(Bill.session_id == session.id).count()
    )
    if existing_count > 0:
        return 0

    for description, amount, payer_idx, occurred_iso, pax_indices in THAILAND_BILLS:
        occurred = datetime.fromisoformat(occurred_iso)
        bill = Bill(
            session_id=session.id,
            payer_id=members[payer_idx].id,
            amount=amount,
            currency="THB",
            description=description,
            occurred_at=occurred,
            created_by=session.owner_user_id,
            created_at=now,
            status="draft",
        )
        db.add(bill)
        db.flush()
        for pax_idx in pax_indices:
            bp = BillParticipant(
                bill_id=bill.id,
                member_id=members[pax_idx].id,
                is_exclusive=False,
                exclusive_amount=0.0,
            )
            db.add(bp)
    return len(THAILAND_BILLS)


def seed_dev_data(db: OrmSession | None = None) -> dict[str, Any]:
    """Idempotently create dev test fixtures.

    Returns a small summary dict; safe to log at INFO level.

    Skipped entirely when ``ENV=production`` (case sensitive) so a
    production deploy will never accidentally seed dev fixtures.
    """
    if os.getenv("ENV") == "production":
        return {"skipped": "ENV=production"}

    owns_db = db is None
    if owns_db:
        db = SessionLocal()

    try:
        now = datetime.now(TZ_SH)

        # 1. Main test user (xinhua1001) — owner of all seeded sessions.
        xinhua = _ensure_user(db, TEST_USER_EMAIL, default_name="Jesse")

        # 2. Thailand session + 5 members + 27 bills.
        thailand, thailand_members = _ensure_thailand_session(db, xinhua, now)
        bills_created = _seed_thailand_bills(db, thailand, thailand_members, now)

        # 3. Personal session (1 owner-member, no bills).
        personal = _ensure_personal_session(db, xinhua, now)

        # 4. v0.2.2 (T12): re-apply the snapshot backfill now that the
        #    rates exist, so newly seeded Thailand bills have a non-NULL
        #    exchange_rate_snapshot (the migration's backfill runs at
        #    alembic upgrade time, which is a separate step from the
        #    runtime seed). Keep this idempotent — UPDATE just leaves
        #    already-populated rows alone when the rate still matches.
        _backfill_bill_snapshots(db, thailand.id)

        db.commit()
        return {
            "xinhua_user_id": xinhua.id,
            "thailand_session_id": thailand.id,
            "personal_session_id": personal.id,
            "bills_created": bills_created,
            "bill_count_target": len(THAILAND_BILLS),
        }
    except Exception:
        db.rollback()
        raise
    finally:
        if owns_db:
            db.close()


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def main() -> int:
    """Run the seed from the command line: ``python -m scripts.seed_dev_data``."""
    result = seed_dev_data()
    print(f"[seed_dev_data] {result}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
