"""Seed SplitIt with local development fixtures.

Imported by ``app.main`` on uvicorn startup (unless skipped). Creates
idempotent demo data:

- 1 user (``demo@example.com``)
- Multi-currency Thailand demo ledger + empty personal ledger
- Helper member accounts under ``*.local`` / ``*.test`` domains
- Optional feature-matrix ledgers via ``seed_feature_matrix``

Skipped when ``ENV=production`` or ``SBC_SKIP_SEED=true`` (default).
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

# Synthetic demo account (also the recommended DEV_BYPASS_EMAILS entry).
TEST_USER_EMAIL = "demo@example.com"

# Thailand demo members, in display order. Index 0 is the owner.
# Display names are fictional fixtures referenced by bill descriptions below.
THAILAND_MEMBERS: list[tuple[str, str, str]] = [
    # (display_name, role, owner_email) — empty owner_email → demo user
    ("Jesse", SessionRole.OWNER.value, ""),
    ("Ju", SessionRole.MEMBER.value, "ju@thailand.local"),
    ("Canyina", SessionRole.MEMBER.value, "canyina@thailand.local"),
    ("Q", SessionRole.MEMBER.value, "q@thailand.local"),
    ("像汤圆一样圆.", SessionRole.MEMBER.value, "rounded@thailand.local"),
]

# (Legacy ``THAILAND_BILLS`` + ``THAILAND_SESSION_NAME`` removed in
# v0.3.x / UAT #0723-3 #5 — the 6.19-6.22 fixture was retired; see
# module docstring history. Only THAILAND2 remains as the canonical
# multi-bill / multi-currency test session.)

PERSONAL_SESSION_NAME = "[空·单币]个人测试"
# Legacy name kept for rename migration in seed_feature_matrix.
PERSONAL_SESSION_NAME_LEGACY = "个人测试"


# --------------------------------------------------------------------------- #
# Thailand #2 session (v0.3.25 #17, redesigned v0.3.x / UAT #0723-3 #5):
# 4-day weekend trip with full payer/shared/exclusive coverage + 解耦 examples
# --------------------------------------------------------------------------- #
#
# Purpose (PO msg 16:35 #17, 2026-07-23):
#   "再建一个最新的测试账单。要求 5 人，每个人都有付款，消费，独占。4 天行程。
#    账单名称，细节都要有。其中一个用户的邮箱是 demo@example.com，
#    其余随意。"
#
# Redesigned (PO msg 23:?? #8645, UAT #0723-3 #5, 2026-07-24):
#   "你对于个人消费的理解不太对。" → the previous run had every exclusive
#   bill with payer = consumer, so the FE had no "friend paid on behalf
#   of me" UX to exercise. The redesign adds **4 解耦 examples** (payer
#   ≠ consumer) where one friend pays and another is the personal
#   consumer. The legacy ``6.19-6.22`` session was retired in this
#   commit; THAILAND2 is now the sole canonical test session.
#
# Design invariants (all verified by ``backend/scripts/_verify_seed_balance.py``):
#   - Session name: "泰国测试账单 2 7.25-7.28" — 4-day trip (Sat~Tue).
#   - Members: THAILAND_MEMBERS (5 人) + THAILAND_AUX_USERS (idempotent).
#   - Bills: 40 bills / 4 天 × 10 bills/天, 35 THB + 5 CNY.
#   - Per-member coverage: every member is payer ≥1, shared consumer
#     ≥1 (inclusive), and exclusive consumer ≥1 (is_exclusive=true).
#   - 解耦 examples (payer ≠ consumer): 4 bills — massage (像汤圆 payer
#     for Ju+Canyina), airport 免税店 (Canyina payer for Q), airport
#     便利店 (Ju payer for 像汤圆), airport 晚餐 (Q payer for Jesse+Ju).
#   - Scene coverage: 整团 (5人均分), 4 人, 3 人, 2 人 (Jesse+Ju),
#     个人独占 (exclusive), 跨币种 (THB payer → CNY bills and vice versa).
#   - Balance invariant: Σ paid = Σ consumed = Σ bills (in primary
#     CNY) — see verify script output for per-member nets.
#
# Tuple shape (unchanged from v0.3.25 #17):
#   (description, amount, payer_idx, occurred_iso,
#    [(pax_idx, excl_amount)], currency)
# where:
#   - excl_amount = 0 → inclusive (split share of bill.amount / N).
#   - excl_amount > 0 → exclusive (this single member is the personal
#     consumer for that amount; the bill is "assigned" to them only).
#   - A bill may have both inclusive and exclusive participants
#     (rare — not used here, but supported by the model).
#   - When a bill has multiple exclusive consumers (e.g. massage
#     shared by Ju + Canyina), excl_amount must sum to bill.amount
#     (the FE / settle enforces this on submit).

THAILAND2_SESSION_NAME = "泰国测试账单 2 7.25-7.28"

THAILAND2_BILLS: list[tuple[str, float, int, str, list[tuple[int, float]], str]] = [
    # Day 1 — 2026-07-25 (周六, 10 bills, 出发日)
    # 解耦 #1: 按摩 payer=像汤圆一样圆 (idx 4), exclusive consumers=[Ju, Canyina]
    ("7.25机场打车5人",                       600.0,  3, "2026-07-25T15:00:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.25午餐机场4人",                      1500.0,  1, "2026-07-25T17:00:00+08:00",
     [(0,0),(1,0),(3,0),(4,0)], "THB"),
    ("7.25酒店check-in Jesse独占",            1800.0,  0, "2026-07-25T18:00:00+08:00",
     [(0, 1800.0)], "THB"),
    ("7.25酒店晚餐5人",                      2800.0,  2, "2026-07-25T20:00:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.25夜市甜品3人",                       850.0,  3, "2026-07-25T22:00:00+08:00",
     [(0,0),(1,0),(3,0)], "THB"),
    ("7.25打车去酒店4人",                     200.0,  4, "2026-07-25T23:00:00+08:00",
     [(0,0),(1,0),(3,0),(4,0)], "THB"),
    ("7.25便利店零食Q独占",                   350.0,  3, "2026-07-25T23:30:00+08:00",
     [(3, 350.0)], "THB"),
    # 解耦 #1: payer=像汤圆一样圆 (idx 4), exclusive=[Ju 800, Canyina 800]
    ("7.25按摩Ju+Canyina独占(像汤圆付)",     1600.0,  4, "2026-07-25T22:00:00+08:00",
     [(1, 800.0),(2, 800.0)], "THB"),
    ("7.25WeChat午餐(微信)",                  280.0,  0, "2026-07-25T17:30:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "CNY"),
    ("7.25支付宝按摩小费",                     60.0,  2, "2026-07-25T22:30:00+08:00",
     [(0,0),(1,0),(2,0)], "CNY"),

    # Day 2 — 2026-07-26 (周日, 10 bills, 大皇宫 + 卧佛寺)
    ("7.26酒店早餐Ju独占",                    250.0,  1, "2026-07-26T08:00:00+08:00",
     [(1, 250.0)], "THB"),
    ("7.26打车大皇宫5人",                     250.0,  0, "2026-07-26T09:30:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.26大皇宫门票5人",                    1000.0,  0, "2026-07-26T10:00:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.26午餐5人",                          2800.0,  2, "2026-07-26T13:00:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.26下午咖啡圆独占",                    220.0,  4, "2026-07-26T15:30:00+08:00",
     [(4, 220.0)], "THB"),
    # 2 人专属 (情侣/搭档) — Jesse + Ju
    ("7.26打车卧佛寺2人(Jesse+Ju)",            180.0,  1, "2026-07-26T16:00:00+08:00",
     [(0,0),(1,0)], "THB"),
    ("7.26卧佛寺门票5人",                     600.0,  1, "2026-07-26T16:30:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.26晚饭中餐5人",                      2400.0,  0, "2026-07-26T20:00:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.26酒吧4人",                          3600.0,  2, "2026-07-26T22:00:00+08:00",
     [(0,0),(1,0),(3,0),(4,0)], "THB"),
    ("7.26支付宝按摩后加菜",                   128.0,  2, "2026-07-26T21:30:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "CNY"),

    # Day 3 — 2026-07-27 (周一, 10 bills, 湄南河 + Asiatique)
    ("7.27酒店早餐3人",                       320.0,  1, "2026-07-27T08:30:00+08:00",
     [(0,0),(1,0),(3,0)], "THB"),
    ("7.27打车湄南河5人",                     220.0,  0, "2026-07-27T10:00:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.27湄南河船票5人",                    1200.0,  0, "2026-07-27T10:30:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.27午饭码头5人",                      1800.0,  2, "2026-07-27T13:00:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.27下午咖啡Canyina独占",               200.0,  2, "2026-07-27T15:30:00+08:00",
     [(2, 200.0)], "THB"),
    ("7.27打车Asiatique4人",                  150.0,  3, "2026-07-27T17:00:00+08:00",
     [(0,0),(1,0),(2,0),(3,0)], "THB"),
    ("7.27晚餐Asiatique5人",                 3200.0,  0, "2026-07-27T20:00:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.27Asiatique摩天轮5人",               1200.0,  4, "2026-07-27T21:00:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.27夜市烧烤4人",                      1800.0,  4, "2026-07-27T22:30:00+08:00",
     [(0,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.27微信打车",                           88.0,  3, "2026-07-27T18:00:00+08:00",
     [(0,0),(1,0),(3,0),(4,0)], "CNY"),

    # Day 4 — 2026-07-28 (周二, 10 bills, 返程)
    ("7.28酒店早餐3人",                       280.0,  0, "2026-07-28T08:00:00+08:00",
     [(0,0),(1,0),(3,0)], "THB"),
    ("7.28酒店退房前午餐5人",                1500.0,  1, "2026-07-28T11:00:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.28打车去机场5人",                     350.0,  2, "2026-07-28T12:30:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.28机场咖啡Jesse独占",                 220.0,  0, "2026-07-28T13:30:00+08:00",
     [(0, 220.0)], "THB"),
    # 解耦 #2: payer=Canyina (idx 2), exclusive consumer=Q (idx 3)
    ("7.28机场免税店Q独占(Canyina垫付)",     1500.0,  2, "2026-07-28T14:00:00+08:00",
     [(3, 1500.0)], "THB"),
    ("7.28机场午餐5人",                      1200.0,  0, "2026-07-28T15:00:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    # 解耦 #3: payer=Ju (idx 1), exclusive consumer=像汤圆一样圆 (idx 4)
    ("7.28机场便利店圆独占(Ju垫付)",          180.0,  1, "2026-07-28T15:30:00+08:00",
     [(4, 180.0)], "THB"),
    ("7.28打车去机场2段",                     250.0,  1, "2026-07-28T13:00:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    # 解耦 #4: payer=Q (idx 3), exclusive consumers=[Jesse 190, Ju 190]
    ("7.28机场晚餐Jesse+Ju独占(Q垫付)",       380.0,  3, "2026-07-28T18:00:00+08:00",
     [(0, 190.0),(1, 190.0)], "THB"),
    ("7.28支付宝机场免税",                    150.0,  3, "2026-07-28T16:00:00+08:00",
     [(3, 150.0)], "CNY"),
]
# 共 40 bills: 35 THB (含 8 笔独占, 4 笔 payer≠consumer 解耦) + 5 CNY (含 1 笔独占)


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


# (Legacy ``_ensure_thailand_session`` removed in v0.3.x /
#  UAT #0723-3 #5 — the ``6.19-6.22`` Thailand session was retired.
#  THAILAND2 is the sole canonical multi-bill session now; see
#  ``_ensure_thailand2_session`` below.)


# v0.2.2 (T12): the canonical THB<->CNY rate the test suite recorded
# against. The migration's data backfill needs this row to be present
# OR settle will 422 on historical bills.
_THAILAND_THB_TO_CNY = Decimal("0.21500000")
_THAILAND_CNY_TO_THB = (Decimal("1") / _THAILAND_THB_TO_CNY).quantize(
    Decimal("0.00000001"), rounding=ROUND_HALF_UP
)


def _seed_thailand_rates_always(
    db: OrmSession, session: BillSession, owner: User
) -> None:
    """Unconditionally insert THB<->CNY rates for the Thailand session.

    v0.3.14.1 hotfix #2: a newly created session has no bills yet at
    this point (``_seed_thailand2_bills`` runs AFTER this), so the
    has_foreign_bills guard that ``_maybe_backfill_thailand_rates``
    uses would always return False. We just always insert the rates
    here — the session IS Thailand by construction, the rates are
    idempotent, and the snapshot backfill on bills is handled later
    by ``_backfill_bill_snapshots`` (which runs after
    ``_seed_thailand2_bills``).

    Safe to call multiple times — early-returns when rate rows
    already exist. ``db.commit()`` is the caller's job; we only
    ``db.flush()`` here.
    """
    from decimal import Decimal as _D
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


def _maybe_backfill_thailand_rates(
    db: OrmSession, session: BillSession, owner: User
) -> None:
    """Seed the THB<->CNY rates for an EXISTING Thailand session (idempotent).

    v0.3.14.1 hotfix #2: For an existing session, only insert the
    rates if the session actually has THB bills to settle (a stray
    empty session shouldn't pollute the rates table). Skips when rate
    rows already exist. Also backfills any NULL
    ``exchange_rate_snapshot`` on the existing bills so settle
    doesn't 422.

    ``db.commit()`` is the caller's job — we only ``db.flush()`` here.
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
    """Find-or-create the empty personal session owned by ``owner``.

    Accepts legacy name ``个人测试`` and renames to tagged
    ``[空·单币]个人测试`` so /sessions browsing is self-explanatory.
    """
    existing = (
        db.query(BillSession)
        .filter(
            BillSession.name == PERSONAL_SESSION_NAME,
            BillSession.owner_user_id == owner.id,
        )
        .first()
    )
    if existing is None:
        legacy = (
            db.query(BillSession)
            .filter(
                BillSession.name == PERSONAL_SESSION_NAME_LEGACY,
                BillSession.owner_user_id == owner.id,
            )
            .first()
        )
        if legacy is not None:
            legacy.name = PERSONAL_SESSION_NAME
            db.flush()
            return legacy

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


# Thailand #2 session lifecycle (v0.3.25 #17):
#   - _ensure_thailand2_session: find-or-create 2nd Thailand session
#     with same 5-member roster as session #1 (idempotent User rows).
#   - _seed_thailand2_bills: insert THAILAND2_BILLS (40 bills) with
#     per-participant excl_amount (incl vs exclusive split).
# --------------------------------------------------------------------------- #
def _ensure_thailand2_session(
    db: OrmSession, owner: User, now: datetime
) -> tuple[BillSession, list[SessionMember]]:
    """Find-or-create Thailand #2 session + its 5 members (idempotent).

    Sole canonical multi-bill session since v0.3.x / UAT #0723-3 #5.
    Rates seeded unconditionally, currencies declared up front,
    5-member roster resolved from the same auxiliary User rows.
    """
    session = (
        db.query(BillSession)
        .filter(
            BillSession.name == THAILAND2_SESSION_NAME,
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
        # Repair currencies if an older seed run left it at the model
        # default (["CNY"]), then conditionally backfill rates if the
        # session actually has THB bills to settle.
        _maybe_backfill_thailand_rates(db, session, owner)
        if "THB" not in (session.currencies or []):
            session.currencies = ["CNY", "THB"]
            db.flush()
        # v0.3.x / UAT #0723-3 #5: if the session exists but the
        # member roster is empty (e.g. we just truncated members + bills
        # for a fresh reseed of the same session), recreate the 5-member
        # roster using the same auxiliary User rows as the new-session
        # path. Without this, _seed_thailand2_bills would crash with
        # IndexError because the members list would be empty when the
        # bills loop tries to look up payer / participant IDs.
        if not members:
            aux_by_email = {
                email: _ensure_user(db, email, default_name)
                for email, default_name in THAILAND_AUX_USERS
            }
            new_members: list[SessionMember] = []
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
                new_members.append(sm)
            db.flush()
            members = (
                db.query(SessionMember)
                .filter(SessionMember.session_id == session.id)
                .order_by(SessionMember.id)
                .all()
            )
        return session, members

    session = BillSession(
        name=THAILAND2_SESSION_NAME,
        owner_user_id=owner.id,
        invite_token=secrets.token_urlsafe(32),
        invite_expires_at=now + timedelta(days=30),
        invite_created_at=now,
        session_code=_generate_session_code(),
        currencies=["CNY", "THB"],
        primary_currency="CNY",
    )
    db.add(session)
    db.flush()

    # Same auxiliary accounts as session #1 (User rows already exist).
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
    # Unconditionally seed THB<->CNY rates — the session IS Thailand by
    # construction, and _seed_thailand2_bills runs AFTER this (so the
    # has_foreign_bills guard would always short-circuit here).
    _seed_thailand_rates_always(db, session, owner)
    return session, members


def _seed_thailand2_bills(
    db: OrmSession,
    session: BillSession,
    members: list[SessionMember],
    now: datetime,
) -> int:
    """Create 40 bills (36 THB + 4 CNY) for the Thailand #2 session.

    Per-participant ``excl_amount``:
      - 0 → inclusive split (the participant shares this bill).
      - >0 → exclusive (this single member is responsible for that
        amount; the bill is only assigned to them).

    Returns the number of bills created (0 if they already exist).
    Idempotent: only inserts when there are no bills yet for this
    session.
    """
    existing_count = (
        db.query(Bill).filter(Bill.session_id == session.id).count()
    )
    if existing_count > 0:
        return 0

    for entry in THAILAND2_BILLS:
        desc = entry[0]
        amount = entry[1]
        payer_idx = entry[2]
        occurred_iso = entry[3]
        pax_data = entry[4]  # [(pax_idx, excl_amount), ...]
        currency = entry[5]
        occurred = datetime.fromisoformat(occurred_iso)
        bill = Bill(
            session_id=session.id,
            payer_id=members[payer_idx].id,
            amount=amount,
            currency=currency,
            description=desc,
            occurred_at=occurred,
            created_by=session.owner_user_id,
            created_at=now,
            status="draft",
        )
        db.add(bill)
        db.flush()
        for pax_idx, excl_amount in pax_data:
            bp = BillParticipant(
                bill_id=bill.id,
                member_id=members[pax_idx].id,
                is_exclusive=(excl_amount > 0),
                exclusive_amount=float(excl_amount),
            )
            db.add(bp)
    return len(THAILAND2_BILLS)


def seed_dev_data(db: OrmSession | None = None) -> dict[str, Any]:
    """Idempotently create dev test fixtures.

    Returns a small summary dict; safe to log at INFO level.

    Skip hierarchy (first match wins):
      1. ``ENV=production`` → always skip (legacy prod guard).
      2. ``settings.sbc_skip_seed`` (driven by ``SBC_SKIP_SEED`` env /
         .env, default True) → skip (v0.3.13 default).
      3. Otherwise → inject.

    restarts should not re-inject demo fixtures into a personal DB).
    """
    if os.getenv("ENV") == "production":
        return {"skipped": "ENV=production"}

    # v0.3.13 opt-out: dev default flipped to skip so the
    # dev's own SBC personal space doesn't get a 泰国测试账单 row every
    # restart. Override via SBC_SKIP_SEED=false to bring fixtures back
    # (e.g. for a sprint walk or demo).
    from app.core.config import settings  # local import avoids cycles

    if settings.sbc_skip_seed:
        return {
            "skipped": "SBC_SKIP_SEED",
            "hint": "set SBC_SKIP_SEED=false (or .env SBC_SKIP_SEED=false) to inject",
        }

    owns_db = db is None
    if owns_db:
        db = SessionLocal()

    try:
        now = datetime.now(TZ_SH)

        # 1. Demo owner of seeded sessions.
        demo = _ensure_user(db, TEST_USER_EMAIL, default_name="Jesse")

        # 2. v0.3.x / UAT #0723-3 #5 (PO msg #8645): Thailand #2
        #    session is the **sole** canonical multi-bill session.
        #    5 members + 40 bills (35 THB + 5 CNY) covering every
        #    member's payer + shared-consumer + exclusive-consumer
        #    roles, plus 4 payer≠consumer 解耦 examples.
        thailand2, thailand2_members = _ensure_thailand2_session(db, demo, now)
        bills_created_v2 = _seed_thailand2_bills(db, thailand2, thailand2_members, now)

        # 3. Personal session (1 owner-member, no bills). Tagged name
        #    ``[空·单币]个人测试`` (legacy ``个人测试`` auto-renamed).
        personal = _ensure_personal_session(db, demo, now)

        # 4. v0.2.2 (T12): re-apply the snapshot backfill now that the
        #    rates exist, so newly seeded THB bills have a non-NULL
        #    exchange_rate_snapshot (the migration's backfill runs at
        #    alembic upgrade time, which is a separate step from the
        #    runtime seed). Keep this idempotent — UPDATE just leaves
        #    already-populated rows alone when the rate still matches.
        _backfill_bill_snapshots(db, thailand2.id)

        # 5. Feature-matrix fixtures — ledger/bill names annotate QA paths.
        #    Catalog: docs/TEST_DATA_MATRIX.md
        from scripts.seed_feature_matrix import seed_feature_matrix

        matrix = seed_feature_matrix(db, demo, now)

        db.commit()
        return {
            "demo_user_id": demo.id,
            "thailand2_session_id": thailand2.id,
            "personal_session_id": personal.id,
            "thailand2_bills_created": bills_created_v2,
            "thailand2_bill_count_target": len(THAILAND2_BILLS),
            "feature_matrix": matrix,
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
