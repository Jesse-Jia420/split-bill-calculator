"""Feature-matrix test fixtures — ledger/bill names annotate what to test.

Idempotent. Called from ``seed_dev_data`` when ``SBC_SKIP_SEED=false``.

Naming rules
------------
- 账本名称: ``[场景标签]简述`` — browse ``/sessions`` and know the path.
- 账单名称: ``[类型]细节`` — browse bill list / search and know the path.
- Keep names short (wizard maxlength ≈ 25 CJK; list truncates).

See ``docs/TEST_DATA_MATRIX.md`` for the full catalog mapped to feature IDs.
"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from sqlalchemy.orm import Session as OrmSession

from app.db.models.bill_participants import BillParticipant
from app.db.models.bills import Bill
from app.db.models.session_exchange_rates import SessionExchangeRate
from app.db.models.session_members import SessionMember, SessionRole
from app.db.models.sessions import Session as BillSession
from app.db.models.settlement_records import SettlementRecord
from app.db.models.users import User

TZ_SH = timezone(timedelta(hours=8))
_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _code() -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(10))


def _ensure_user(db: OrmSession, email: str, default_name: str) -> User:
    user = db.query(User).filter_by(email=email).first()
    if user is None:
        user = User(email=email, default_name=default_name)
        db.add(user)
        db.flush()
    return user


def _find_owned(db: OrmSession, name: str, owner_id: int) -> BillSession | None:
    return (
        db.query(BillSession)
        .filter(BillSession.name == name, BillSession.owner_user_id == owner_id)
        .first()
    )


def _new_session(
    db: OrmSession,
    *,
    name: str,
    owner: User | None,
    now: datetime,
    currencies: list[str],
    primary: str,
    invite_expired: bool = False,
) -> BillSession:
    invite_expires = (
        now - timedelta(days=1) if invite_expired else now + timedelta(days=30)
    )
    sess = BillSession(
        name=name,
        owner_user_id=owner.id if owner else None,
        owner_email=owner.email if owner else None,
        invite_token=secrets.token_urlsafe(32),
        session_code=_code(),
        invite_expires_at=invite_expires,
        invite_created_at=now,
        last_active_at=now,
        currencies=list(currencies),
        primary_currency=primary,
    )
    db.add(sess)
    db.flush()
    return sess


def _add_member(
    db: OrmSession,
    session: BillSession,
    *,
    display_name: str,
    role: str = SessionRole.MEMBER.value,
    user: User | None = None,
    is_anon: bool = False,
    with_secret: bool = False,
) -> SessionMember:
    secret = secrets.token_hex(32) if with_secret else None
    claimed_at = datetime.now(TZ_SH) if (user is not None or with_secret) else None
    sm = SessionMember(
        session_id=session.id,
        user_id=user.id if user else None,
        display_name=display_name,
        role=role,
        is_anon=is_anon and user is None,
        nickname_secret=secret,
        claimed_at=claimed_at,
    )
    db.add(sm)
    db.flush()
    return sm


def _add_rate(
    db: OrmSession,
    session: BillSession,
    *,
    frm: str,
    to: str,
    rate: Decimal,
    set_by: int | None,
    now: datetime,
) -> None:
    existing = (
        db.query(SessionExchangeRate)
        .filter(
            SessionExchangeRate.session_id == session.id,
            SessionExchangeRate.from_currency == frm,
            SessionExchangeRate.to_currency == to,
        )
        .first()
    )
    if existing:
        return
    db.add(
        SessionExchangeRate(
            session_id=session.id,
            from_currency=frm,
            to_currency=to,
            rate=rate,
            snapshot_at=now,
            set_by=set_by,
        )
    )
    db.flush()


def _add_bill(
    db: OrmSession,
    session: BillSession,
    *,
    description: str,
    amount: float,
    currency: str,
    payer: SessionMember,
    creator_sm: SessionMember,
    now: datetime,
    occurred: datetime | None = None,
    participants: list[tuple[SessionMember, float]] | None = None,
    amount_expression: str | None = None,
    snapshot: Decimal | None = None,
) -> Bill:
    if participants is None:
        participants = [(payer, 0.0)]
    bill = Bill(
        session_id=session.id,
        payer_id=payer.id,
        amount=Decimal(str(amount)),
        currency=currency,
        description=description,
        amount_expression=amount_expression,
        exchange_rate_snapshot=snapshot,
        occurred_at=occurred or now,
        created_by=creator_sm.user_id,
        created_by_session_member_id=creator_sm.id,
        created_at=now,
        status="draft",
    )
    db.add(bill)
    db.flush()
    for m, excl in participants:
        db.add(
            BillParticipant(
                bill_id=bill.id,
                member_id=m.id,
                is_exclusive=(excl > 0),
                exclusive_amount=float(excl),
            )
        )
    db.flush()
    return bill


def _fx_empty_add_secondary(db: OrmSession, owner: User, now: datetime) -> BillSession:
    name = "[空·可加副币]待加USD"
    sess = _new_session(
        db, name=name, owner=owner, now=now, currencies=["CNY"], primary="CNY"
    )
    _add_member(db, sess, display_name="Jesse", role=SessionRole.OWNER.value, user=owner)
    return sess


def _fx_empty_dual_editable(db: OrmSession, owner: User, now: datetime) -> BillSession:
    name = "[空·双币可改]CNY+JPY"
    sess = _new_session(
        db, name=name, owner=owner, now=now, currencies=["CNY", "JPY"], primary="CNY"
    )
    _add_member(db, sess, display_name="Jesse", role=SessionRole.OWNER.value, user=owner)
    rate = Decimal("20.00000000")
    recip = (Decimal("1") / rate).quantize(Decimal("0.00000001"), rounding=ROUND_HALF_UP)
    _add_rate(db, sess, frm="CNY", to="JPY", rate=rate, set_by=owner.id, now=now)
    _add_rate(db, sess, frm="JPY", to="CNY", rate=recip, set_by=owner.id, now=now)
    return sess


def _fx_single_locked(db: OrmSession, owner: User, now: datetime) -> BillSession:
    name = "[单币有账·锁副币]只能CNY"
    sess = _new_session(
        db, name=name, owner=owner, now=now, currencies=["CNY"], primary="CNY"
    )
    jesse = _add_member(
        db, sess, display_name="Jesse", role=SessionRole.OWNER.value, user=owner
    )
    ju_user = _ensure_user(db, "matrix-ju@local.test", "Ju")
    ju = _add_member(db, sess, display_name="Ju", user=ju_user)
    _add_bill(
        db, sess,
        description="[AA·2人]午餐均分",
        amount=120.0, currency="CNY", payer=jesse, creator_sm=jesse, now=now,
        participants=[(jesse, 0.0), (ju, 0.0)],
    )
    _add_bill(
        db, sess,
        description="[独占]Jesse咖啡",
        amount=28.0, currency="CNY", payer=jesse, creator_sm=jesse, now=now,
        participants=[(jesse, 28.0)],
    )
    return sess


def _settled_zero(db: OrmSession, owner: User, now: datetime) -> BillSession:
    name = "[已结清]转账为零"
    sess = _new_session(
        db, name=name, owner=owner, now=now, currencies=["CNY"], primary="CNY"
    )
    jesse = _add_member(
        db, sess, display_name="Jesse", role=SessionRole.OWNER.value, user=owner
    )
    ju_user = _ensure_user(db, "matrix-ju@local.test", "Ju")
    ju = _add_member(db, sess, display_name="Ju", user=ju_user)
    _add_bill(
        db, sess,
        description="[AA·2人]已结清样例晚餐",
        amount=100.0, currency="CNY", payer=jesse, creator_sm=jesse, now=now,
        participants=[(jesse, 0.0), (ju, 0.0)],
    )
    db.add(
        SettlementRecord(
            session_id=sess.id,
            payer_id=ju.id,
            payee_id=jesse.id,
            currency="CNY",
            amount=Decimal("50.00"),
            note="[结算记录]Ju已还Jesse·应转账归零",
            created_by=ju.id,
            created_at=now,
        )
    )
    db.flush()
    return sess


def _partial_settlement(db: OrmSession, owner: User, now: datetime) -> BillSession:
    name = "[有结算记录]部分还款"
    sess = _new_session(
        db, name=name, owner=owner, now=now,
        currencies=["CNY", "THB"], primary="CNY",
    )
    jesse = _add_member(
        db, sess, display_name="Jesse", role=SessionRole.OWNER.value, user=owner
    )
    ju_user = _ensure_user(db, "matrix-ju@local.test", "Ju")
    ju = _add_member(db, sess, display_name="Ju", user=ju_user)
    rate = Decimal("0.21500000")
    recip = (Decimal("1") / rate).quantize(Decimal("0.00000001"), rounding=ROUND_HALF_UP)
    _add_rate(db, sess, frm="THB", to="CNY", rate=rate, set_by=owner.id, now=now)
    _add_rate(db, sess, frm="CNY", to="THB", rate=recip, set_by=owner.id, now=now)
    _add_bill(
        db, sess,
        description="[THB]酒店Jesse垫付",
        amount=2000.0, currency="THB", payer=jesse, creator_sm=jesse, now=now,
        participants=[(jesse, 0.0), (ju, 0.0)], snapshot=rate,
    )
    _add_bill(
        db, sess,
        description="[CNY]微信午餐2人",
        amount=160.0, currency="CNY", payer=ju, creator_sm=ju, now=now,
        participants=[(jesse, 0.0), (ju, 0.0)],
    )
    db.add(
        SettlementRecord(
            session_id=sess.id, payer_id=ju.id, payee_id=jesse.id,
            currency="CNY", amount=Decimal("50.00"),
            note="[CNY还款]部分已结", created_by=ju.id,
            created_at=now - timedelta(hours=2),
        )
    )
    db.add(
        SettlementRecord(
            session_id=sess.id, payer_id=ju.id, payee_id=jesse.id,
            currency="THB", amount=Decimal("200.00"),
            note="[THB还款]副币种结算记录", created_by=jesse.id,
            created_at=now - timedelta(hours=1),
        )
    )
    db.flush()
    return sess


def _join_three_slots(db: OrmSession, owner: User, now: datetime) -> BillSession:
    name = "[join·三态槽]认领演示"
    sess = _new_session(
        db, name=name, owner=owner, now=now, currencies=["CNY"], primary="CNY"
    )
    _add_member(
        db, sess, display_name="Jesse(已登录)", role=SessionRole.OWNER.value, user=owner
    )
    _add_member(db, sess, display_name="未认领·小明")
    _add_member(
        db, sess, display_name="anon已占·小红", is_anon=True, with_secret=True,
    )
    return sess


def _member_of_others(db: OrmSession, owner: User, now: datetime) -> BillSession:
    name = "[我是Member]别人的账本"
    ju_user = _ensure_user(db, "matrix-ju@local.test", "Ju")
    existing = _find_owned(db, name, ju_user.id)
    if existing:
        return existing
    sess = _new_session(
        db, name=name, owner=ju_user, now=now, currencies=["CNY"], primary="CNY"
    )
    ju = _add_member(
        db, sess, display_name="Ju", role=SessionRole.OWNER.value, user=ju_user
    )
    jesse = _add_member(db, sess, display_name="Jesse", user=owner)
    _add_bill(
        db, sess,
        description="[非我创建·Jesse不可改]Ju记的账",
        amount=88.0, currency="CNY", payer=ju, creator_sm=ju, now=now,
        participants=[(ju, 0.0), (jesse, 0.0)],
    )
    _add_bill(
        db, sess,
        description="[我创建·Jesse可改删]Jesse记的账",
        amount=66.0, currency="CNY", payer=jesse, creator_sm=jesse, now=now,
        participants=[(ju, 0.0), (jesse, 0.0)],
    )
    return sess


def _deletable_owner(db: OrmSession, owner: User, now: datetime) -> BillSession:
    name = "[可硬删]临时废账本"
    sess = _new_session(
        db, name=name, owner=owner, now=now, currencies=["CNY"], primary="CNY"
    )
    _add_member(db, sess, display_name="Jesse", role=SessionRole.OWNER.value, user=owner)
    return sess


def _calculator_bills(db: OrmSession, owner: User, now: datetime) -> BillSession:
    name = "[计算器]含表达式"
    sess = _new_session(
        db, name=name, owner=owner, now=now, currencies=["CNY"], primary="CNY"
    )
    jesse = _add_member(
        db, sess, display_name="Jesse", role=SessionRole.OWNER.value, user=owner
    )
    ju_user = _ensure_user(db, "matrix-ju@local.test", "Ju")
    ju = _add_member(db, sess, display_name="Ju", user=ju_user)
    _add_bill(
        db, sess,
        description="[计算器]晚餐350/5",
        amount=70.0, currency="CNY", payer=jesse, creator_sm=jesse, now=now,
        participants=[(jesse, 0.0), (ju, 0.0)], amount_expression="350/5",
    )
    _add_bill(
        db, sess,
        description="[计算器]酒水(80+40)/2",
        amount=60.0, currency="CNY", payer=ju, creator_sm=ju, now=now,
        participants=[(jesse, 0.0), (ju, 0.0)], amount_expression="(80+40)/2",
    )
    return sess


def _mixed_and_decouple(db: OrmSession, owner: User, now: datetime) -> BillSession:
    name = "[混合+解耦]分摊独占"
    sess = _new_session(
        db, name=name, owner=owner, now=now, currencies=["CNY"], primary="CNY"
    )
    jesse = _add_member(
        db, sess, display_name="Jesse", role=SessionRole.OWNER.value, user=owner
    )
    ju_user = _ensure_user(db, "matrix-ju@local.test", "Ju")
    ju = _add_member(db, sess, display_name="Ju", user=ju_user)
    q_user = _ensure_user(db, "matrix-q@local.test", "Q")
    q = _add_member(db, sess, display_name="Q", user=q_user)
    _add_bill(
        db, sess,
        description="[混合]饭局200+酒水Ju独占80",
        amount=280.0, currency="CNY", payer=jesse, creator_sm=jesse, now=now,
        participants=[(jesse, 0.0), (ju, 80.0), (q, 0.0)],
    )
    _add_bill(
        db, sess,
        description="[解耦垫付]Q小吃(Jesse付)",
        amount=45.0, currency="CNY", payer=jesse, creator_sm=jesse, now=now,
        participants=[(q, 45.0)],
    )
    _add_bill(
        db, sess,
        description="[付款人不参与]请客Ju+Q",
        amount=200.0, currency="CNY", payer=jesse, creator_sm=jesse, now=now,
        participants=[(ju, 0.0), (q, 0.0)],
    )
    return sess


def _idle_bystander(db: OrmSession, owner: User, now: datetime) -> BillSession:
    name = "[闲人旁观]net0"
    sess = _new_session(
        db, name=name, owner=owner, now=now, currencies=["CNY"], primary="CNY"
    )
    jesse = _add_member(
        db, sess, display_name="Jesse", role=SessionRole.OWNER.value, user=owner
    )
    ju_user = _ensure_user(db, "matrix-ju@local.test", "Ju")
    ju = _add_member(db, sess, display_name="Ju", user=ju_user)
    _add_member(db, sess, display_name="旁观者不花钱")
    _add_bill(
        db, sess,
        description="[AA·2人]仅Jesse+Ju吃饭",
        amount=90.0, currency="CNY", payer=jesse, creator_sm=jesse, now=now,
        participants=[(jesse, 0.0), (ju, 0.0)],
    )
    return sess


def _usd_primary(db: OrmSession, owner: User, now: datetime) -> BillSession:
    name = "[主币USD]USD+THB"
    sess = _new_session(
        db, name=name, owner=owner, now=now,
        currencies=["USD", "THB"], primary="USD",
    )
    jesse = _add_member(
        db, sess, display_name="Jesse", role=SessionRole.OWNER.value, user=owner
    )
    rate = Decimal("35.00000000")
    recip = (Decimal("1") / rate).quantize(Decimal("0.00000001"), rounding=ROUND_HALF_UP)
    _add_rate(db, sess, frm="USD", to="THB", rate=rate, set_by=owner.id, now=now)
    _add_rate(db, sess, frm="THB", to="USD", rate=recip, set_by=owner.id, now=now)
    _add_bill(
        db, sess,
        description="[USD]Airbnb定金",
        amount=120.0, currency="USD", payer=jesse, creator_sm=jesse, now=now,
        participants=[(jesse, 120.0)],
    )
    _add_bill(
        db, sess,
        description="[THB]街边小吃",
        amount=350.0, currency="THB", payer=jesse, creator_sm=jesse, now=now,
        participants=[(jesse, 350.0)], snapshot=recip,
    )
    return sess


def _invite_expired(db: OrmSession, owner: User, now: datetime) -> BillSession:
    name = "[邀请·已过期]过期链接"
    sess = _new_session(
        db, name=name, owner=owner, now=now, currencies=["CNY"], primary="CNY",
        invite_expired=True,
    )
    _add_member(db, sess, display_name="Jesse", role=SessionRole.OWNER.value, user=owner)
    return sess


def _rename_personal(db: OrmSession, owner: User) -> dict[str, Any] | None:
    new_name = "[空·单币]个人测试"
    old = _find_owned(db, "个人测试", owner.id)
    tagged = _find_owned(db, new_name, owner.id)
    if old is not None and tagged is not None:
        # Prefer tagged; drop empty legacy duplicate.
        db.delete(old)
        db.flush()
        return {"name": new_name, "id": tagged.id, "created": False, "deleted_legacy": "个人测试"}
    if old is not None and tagged is None:
        old.name = new_name
        db.flush()
        return {"name": new_name, "id": old.id, "created": False, "renamed_from": "个人测试"}
    if tagged is not None:
        return {"name": new_name, "id": tagged.id, "created": False}
    return None


def seed_feature_matrix(
    db: OrmSession, owner: User, now: datetime | None = None
) -> dict[str, Any]:
    """Create/annotate feature-matrix fixtures. Idempotent. No commit."""
    now = now or datetime.now(TZ_SH)
    created: list[dict[str, Any]] = []

    ren = _rename_personal(db, owner)
    if ren:
        created.append(ren)

    th = _find_owned(db, "泰国测试账单 2 7.25-7.28", owner.id)
    if th:
        created.append({
            "name": th.name,
            "id": th.id,
            "created": False,
            "note": "canonical multi-currency; bills tagged 独占/垫付/N人",
        })

    builders: list[tuple[str, Any]] = [
        ("[空·可加副币]待加USD", lambda: _fx_empty_add_secondary(db, owner, now)),
        ("[空·双币可改]CNY+JPY", lambda: _fx_empty_dual_editable(db, owner, now)),
        ("[单币有账·锁副币]只能CNY", lambda: _fx_single_locked(db, owner, now)),
        ("[已结清]转账为零", lambda: _settled_zero(db, owner, now)),
        ("[有结算记录]部分还款", lambda: _partial_settlement(db, owner, now)),
        ("[join·三态槽]认领演示", lambda: _join_three_slots(db, owner, now)),
        ("[可硬删]临时废账本", lambda: _deletable_owner(db, owner, now)),
        ("[计算器]含表达式", lambda: _calculator_bills(db, owner, now)),
        ("[混合+解耦]分摊独占", lambda: _mixed_and_decouple(db, owner, now)),
        ("[闲人旁观]net0", lambda: _idle_bystander(db, owner, now)),
        ("[主币USD]USD+THB", lambda: _usd_primary(db, owner, now)),
        ("[邀请·已过期]过期链接", lambda: _invite_expired(db, owner, now)),
    ]

    for name, fn in builders:
        existing = _find_owned(db, name, owner.id)
        if existing is not None:
            created.append({"name": name, "id": existing.id, "created": False})
        else:
            sess = fn()
            created.append({"name": name, "id": sess.id, "created": True})

    mem = _member_of_others(db, owner, now)
    created.append({
        "name": mem.name,
        "id": mem.id,
        "login_as": "demo@example.com=Member; owner=matrix-ju@local.test",
    })

    return {"feature_matrix": created, "count": len(created)}
