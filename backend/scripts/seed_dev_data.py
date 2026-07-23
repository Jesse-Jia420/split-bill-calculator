"""Seed split-bill-calculator with development test data.

This module is imported by ``app.main`` on uvicorn startup (via lifespan
hook) and idempotently creates the canonical test fixtures that the
frontend / Sprint verification flow expects to see:

- 1 user (demo@example.com) — also matches the live test account.
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
- v0.3.14.1 hotfix #2 / 2026-07-14: split ``_maybe_seed_thailand_rates``
  into two functions to fix an order-of-operations bug — the new-session
  path used to call the function before any bills existed, so the
  ``has_foreign_bills`` guard would short-circuit and the rate rows
  never got inserted. See Jesse's UAT feedback 2026-07-14.
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
TEST_USER_EMAIL = "demo@example.com"

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
THAILAND_BILLS: list[tuple[str, float, int, str, list[int]] | tuple[str, float, int, str, list[int], str]] = [
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
    # CNY bills — WeChat/Alipay paid in CNY (for dual-currency testing)
    ("6.20WeChat大餐",             380.0,  0, "2026-06-20T20:00:00+08:00", [0, 1, 2, 3, 4], "CNY"),
    ("6.21支付宝午饭",              220.0,  1, "2026-06-21T12:00:00+08:00", [0, 1, 3, 4], "CNY"),
    ("6.22微信买水果",              85.0,   3, "2026-06-22T10:00:00+08:00", [0, 3, 4], "CNY"),
    ("6.21支付宝按摩后加菜",         128.0,  4, "2026-06-21T21:00:00+08:00", [0, 1, 3, 4], "CNY"),
    ("6.22微信零食",                66.0,   2, "2026-06-22T15:00:00+08:00", [0, 2, 3], "CNY"),
]

THAILAND_SESSION_NAME = "泰国测试账单 6.19-6.22"
PERSONAL_SESSION_NAME = "个人测试"


# --------------------------------------------------------------------------- #
# Thailand #2 session (v0.3.25 #17): 4-day weekend trip with EXCLUSIVE bills
# --------------------------------------------------------------------------- #
#
# Purpose (PO msg 16:35 #17, 2026-07-23):
#   "再建一个最新的测试账单。要求 5 人，每个人都有付款，消费，独占。4 天行程。
#    账单名称，细节都要有。其中一个用户的邮箱是 demo@example.com，
#    其余随意。"
#
# Design (Master 自决 per 反 #121 / 反 #150):
#   - Session name: "泰国测试账单 2 7.25-7.28" — 跟现有 "泰国测试账单 6.19-6.22"
#     区分 (PO 字面 "再建一个最新的"), 日期用相对今天 (2026-07-23) 的下个周末.
#   - Members: 沿用 THAILAND_MEMBERS (5 人, xinhua1001/Ju/Canyina/Q/像汤圆一样圆)
#     + 同一组 THAILAND_AUX_USERS (idempotent, User rows 已存在).
#   - 4 天日期: 2026-07-25 (周六) ~ 2026-07-28 (周二).
#   - Bills 格式扩展: (desc, amount, payer_idx, occurred_iso,
#     [(pax_idx, excl_amount)], currency).
#     excl_amount=0 走 inclusive split, >0 走 exclusive (单独算这一个人).
#     THAILAND2_BILLS 全部 inclusive participant 用 excl_amount=0, 独占 bill
#     只放 1 个 participant + excl_amount=全 amount.
#   - 账单密度: 40 bills / 4 天 = ~10 bills/天 (现有 32 bills / 4 天 ≈ 8 bills/天).
#   - PO 字面三维度覆盖 ("每人付款, 消费, 独占"):
#     Jesse 独占 = 7.25酒店(1800) + 7.28咖啡(220) + 7.28晚餐(190) = 3 bills
#     Ju 独占 = 7.26早餐(250) = 1 bill
#     Canyina 独占 = 7.27咖啡(200) = 1 bill
#     Q 独占 = 7.25便利店(350) + 7.28免税(1500) + 7.28支付宝(150) = 3 bills
#     像汤圆一样圆 独占 = 7.26咖啡(220) + 7.28便利店(180) = 2 bills
#     每人都 payer ≥1 + participant ≥1 (inclusive) + exclusive ≥1 (3 维度全齐).

THAILAND2_SESSION_NAME = "泰国测试账单 2 7.25-7.28"

THAILAND2_BILLS: list[tuple[str, float, int, str, list[tuple[int, float]], str]] = [
    # Day 1 — 2026-07-25 (周六, 10 bills, 出发日)
    ("7.25机场打车5人",             600.0,  0, "2026-07-25T15:00:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.25午餐机场4人",            1500.0,  1, "2026-07-25T17:00:00+08:00",
     [(0,0),(1,0),(3,0),(4,0)], "THB"),
    ("7.25酒店check-in Jesse独占",  1800.0,  0, "2026-07-25T18:00:00+08:00",
     [(0, 1800.0)], "THB"),
    ("7.25酒店晚餐5人",            2800.0,  2, "2026-07-25T20:00:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.25夜市甜品3人",             850.0,  3, "2026-07-25T22:00:00+08:00",
     [(0,0),(1,0),(3,0)], "THB"),
    ("7.25打车去酒店4人",           200.0,  4, "2026-07-25T23:00:00+08:00",
     [(0,0),(1,0),(3,0),(4,0)], "THB"),
    ("7.25便利店零食Q独占",         350.0,  3, "2026-07-25T23:30:00+08:00",
     [(3, 350.0)], "THB"),
    ("7.25按摩Ju+Canyina独占",     1600.0,  1, "2026-07-25T22:00:00+08:00",
     [(1, 800.0),(2, 800.0)], "THB"),
    ("7.25WeChat午餐",              280.0,  0, "2026-07-25T17:30:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "CNY"),
    ("7.25支付宝按摩小费",           60.0,  2, "2026-07-25T22:30:00+08:00",
     [(0,0),(1,0),(2,0)], "CNY"),

    # Day 2 — 2026-07-26 (周日, 10 bills, 大皇宫 + 卧佛寺)
    ("7.26酒店早餐Ju独占",           250.0,  1, "2026-07-26T08:00:00+08:00",
     [(1, 250.0)], "THB"),
    ("7.26打车大皇宫5人",           250.0,  0, "2026-07-26T09:30:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.26大皇宫门票5人",          1000.0,  0, "2026-07-26T10:00:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.26午餐5人",                 2800.0,  2, "2026-07-26T13:00:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.26下午咖啡圆独占",           220.0,  4, "2026-07-26T15:30:00+08:00",
     [(4, 220.0)], "THB"),
    ("7.26打车卧佛寺3人",           180.0,  1, "2026-07-26T16:00:00+08:00",
     [(0,0),(1,0),(3,0)], "THB"),
    ("7.26卧佛寺门票5人",           600.0,  1, "2026-07-26T16:30:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.26晚饭中餐5人",             2400.0,  0, "2026-07-26T20:00:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.26酒吧4人",                 3600.0,  2, "2026-07-26T22:00:00+08:00",
     [(0,0),(1,0),(3,0),(4,0)], "THB"),
    ("7.26支付宝按摩后加菜",         128.0,  2, "2026-07-26T21:30:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "CNY"),

    # Day 3 — 2026-07-27 (周一, 10 bills, 湄南河 + Asiatique)
    ("7.27酒店早餐3人",             320.0,  1, "2026-07-27T08:30:00+08:00",
     [(0,0),(1,0),(3,0)], "THB"),
    ("7.27打车湄南河5人",           220.0,  0, "2026-07-27T10:00:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.27湄南河船票5人",          1200.0,  0, "2026-07-27T10:30:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.27午饭码头5人",             1800.0,  2, "2026-07-27T13:00:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.27下午咖啡Canyina独占",      200.0,  2, "2026-07-27T15:30:00+08:00",
     [(2, 200.0)], "THB"),
    ("7.27打车Asiatique4人",        150.0,  3, "2026-07-27T17:00:00+08:00",
     [(0,0),(1,0),(2,0),(3,0)], "THB"),
    ("7.27晚餐Asiatique5人",        3200.0,  0, "2026-07-27T20:00:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.27Asiatique摩天轮5人",      1200.0,  4, "2026-07-27T21:00:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.27夜市烧烤4人",             1800.0,  4, "2026-07-27T22:30:00+08:00",
     [(0,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.27微信打车",                  88.0,  3, "2026-07-27T18:00:00+08:00",
     [(0,0),(1,0),(3,0),(4,0)], "CNY"),

    # Day 4 — 2026-07-28 (周二, 10 bills, 返程)
    ("7.28酒店早餐3人",             280.0,  0, "2026-07-28T08:00:00+08:00",
     [(0,0),(1,0),(3,0)], "THB"),
    ("7.28酒店退房前午餐5人",       1500.0,  1, "2026-07-28T11:00:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.28打车去机场5人",           350.0,  2, "2026-07-28T12:30:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.28机场咖啡Jesse独占",        220.0,  0, "2026-07-28T13:30:00+08:00",
     [(0, 220.0)], "THB"),
    ("7.28机场免税店Q独占",         1500.0,  3, "2026-07-28T14:00:00+08:00",
     [(3, 1500.0)], "THB"),
    ("7.28机场午餐5人",             1200.0,  0, "2026-07-28T15:00:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.28机场便利店圆独占",         180.0,  4, "2026-07-28T15:30:00+08:00",
     [(4, 180.0)], "THB"),
    ("7.28打车去机场2段",           250.0,  1, "2026-07-28T13:00:00+08:00",
     [(0,0),(1,0),(2,0),(3,0),(4,0)], "THB"),
    ("7.28机场晚餐Jesse+Ju独占",     380.0,  0, "2026-07-28T18:00:00+08:00",
     [(0, 190.0),(1, 190.0)], "THB"),
    ("7.28支付宝机场免税",           150.0,  3, "2026-07-28T16:00:00+08:00",
     [(3, 150.0)], "CNY"),
]
# 共 40 bills: 36 THB (含 8 笔独占) + 4 CNY (含 1 笔独占)

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

    v0.3.14.1 hotfix #2: the rate-seeding strategy differs between the
    two paths:
      * existing-session path → ``_maybe_backfill_thailand_rates``
        (skips if no THB bills exist; the session might be a stray)
      * new-session path → ``_seed_thailand_rates_always``
        (bills haven't been created yet, so the has_foreign_bills
        guard would always short-circuit; this is unconditional)
    The exchange_rate_snapshot backfill on the bills is handled
    later by ``_backfill_bill_snapshots`` after
    ``_seed_thailand_bills`` runs.
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
        # v0.2.2 (T12) + v0.3.14.1 hotfix #2: For an EXISTING session,
        # only seed rates if there are actual THB bills to settle. The
        # migration's data backfill only fires once during alembic
        # upgrade, so a re-seeded DB that lost its rates would 422
        # otherwise.
        _maybe_backfill_thailand_rates(db, session, owner)
        # v0.3.14.1 hotfix #2: also repair the `currencies` JSON if it
        # was left at the model default ["CNY"] by an earlier seed run
        # (pre-hotfix the session was always created with no explicit
        # `currencies` arg, so it inherited the default). The bills
        # are THB — the echo must reflect that for the FE.
        if "THB" not in (session.currencies or []):
            session.currencies = ["CNY", "THB"]
            db.flush()
        return session, members

    session = BillSession(
        name=THAILAND_SESSION_NAME,
        owner_user_id=owner.id,
        invite_token="thailand-test-2026-07-01-xinhua",
        invite_expires_at=now + timedelta(days=30),
        invite_created_at=now,
        session_code=_generate_session_code(),
        # v0.3.14.1 hotfix #2: this session will hold 27 THB bills, so
        # declare both currencies up front. Without this, the session
        # is born with currencies=["CNY"] (model default) and the
        # settle API's `currencies` echo returns ["CNY"], which leaves
        # the FE "原始数据" radio disabled (single-currency mode).
        currencies=["CNY", "THB"],
        primary_currency="CNY",
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
    # v0.3.14.1 hotfix #2: Unconditionally seed rates for a newly
    # created session. ``_seed_thailand_bills`` runs AFTER this, so a
    # has_foreign_bills check would always be False. The session is
    # Thailand by construction, so always inserting the canonical
    # THB<->CNY pair is the right default. The exchange_rate_snapshot
    # backfill on the (about-to-be-created) bills is handled later by
    # ``_backfill_bill_snapshots``.
    _seed_thailand_rates_always(db, session, owner)
    return session, members


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
    this point (``_seed_thailand_bills`` runs AFTER this), so the
    has_foreign_bills guard that ``_maybe_backfill_thailand_rates``
    uses would always return False. We just always insert the rates
    here — the session IS Thailand by construction, the rates are
    idempotent, and the snapshot backfill on bills is handled later
    by ``_backfill_bill_snapshots`` (which runs after
    ``_seed_thailand_bills``).

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
    """Create 27 bills (25 THB + 5 CNY) for the Thailand session.

    Returns the number of bills created (0 if they already exist — we
    never recreate). Idempotent: only inserts when there are no bills
    yet for this session.
    """
    existing_count = (
        db.query(Bill).filter(Bill.session_id == session.id).count()
    )
    if existing_count > 0:
        return 0

    thailand_bills = THAILAND_BILLS
    for i, entry in enumerate(thailand_bills):
        desc = entry[0]
        amount = entry[1]
        payer_idx = entry[2]
        occurred_iso = entry[3]
        pax_indices = entry[4]
        occurred = datetime.fromisoformat(occurred_iso)
        bill = Bill(
            session_id=session.id,
            payer_id=members[payer_idx].id,
            amount=amount,
            currency=entry[5] if len(entry) > 5 else "THB",
            description=desc,
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
    return len(thailand_bills)


# --------------------------------------------------------------------------- #
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

    Mirrors the lifecycle of ``_ensure_thailand_session`` (rates seeded
    unconditionally, currencies declared up front, 5-member roster
    resolved from the same auxiliary User rows used by session #1).
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
        return session, members

    session = BillSession(
        name=THAILAND2_SESSION_NAME,
        owner_user_id=owner.id,
        invite_token="thailand2-test-2026-07-23-xinhua",
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

    See SPEC.md §3.13 for rationale (why the default flipped to skip:
    uvicorn restart was re-injecting the xinhua + Thailand fixtures
    into the dev's own SBC personal space every reload).
    """
    if os.getenv("ENV") == "production":
        return {"skipped": "ENV=production"}

    # v0.3.13 opt-out (反 #136): dev default flipped to skip so the
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

        # 5. v0.3.25 #17 (PO msg 16:35 #17, 2026-07-23): Thailand #2
        #    session — 4-day weekend trip (2026-07-25 ~ 2026-07-28) with
        #    40 bills (36 THB + 4 CNY) covering every member's
        #    payer + participant + exclusive roles. Members + aux Users
        #    are shared with Thailand #1 (idempotent). Snapshot backfill
        #    re-applied the same way so THB bills settle cleanly.
        thailand2, thailand2_members = _ensure_thailand2_session(db, xinhua, now)
        bills_created_v2 = _seed_thailand2_bills(db, thailand2, thailand2_members, now)
        _backfill_bill_snapshots(db, thailand2.id)

        db.commit()
        return {
            "xinhua_user_id": xinhua.id,
            "thailand_session_id": thailand.id,
            "thailand2_session_id": thailand2.id,
            "personal_session_id": personal.id,
            "bills_created": bills_created,
            "bill_count_target": len(THAILAND_BILLS),
            "thailand2_bills_created": bills_created_v2,
            "thailand2_bill_count_target": len(THAILAND2_BILLS),
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
