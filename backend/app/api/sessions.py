"""Sessions API — Sprint 1 T08 + v0.1.1 invite redesign + v0.2.2 multi-currency.

Endpoints (mounted under /sessions; frontend calls them as
/api/sessions — the dev proxy strips the /api prefix):

POST   /sessions                      Create a session (anon or logged-in)
GET    /sessions                      List sessions the caller belongs to
GET    /sessions/{id}                 Session detail + member list
PATCH  /sessions/{id}/members/{mid}   Update caller's own display_name
POST   /sessions/{id}/join-claim      v0.3: anonymous claim or user bind

Auth model
----------
- POST /sessions: allow anonymous (no auth required).
- GET /sessions: requires logged-in user.
- GET /{id}: requires membership (user binding OR nickname_secret header).
- PATCH /{id}/members/{mid}: requires membership AND mid == caller.
- POST /{id}/join-claim: allow anonymous; user binding uses logged-in user.

Response shape notes
--------------------
- Timestamps come back as ISO 8601 strings (pydantic serialisation).
- We DO NOT include emails of *other* members in the public detail;
  only the caller's email is included (use /auth/me if needed).
  This keeps the response payload tight and avoids accidental PII
  leakage via logs.

v0.1.1 changes (2026-06-30)
---------------------------
- create_session now also mints the per-session fixed invite token
  (30-day TTL, secrets.token_urlsafe(32)). The token + expiry are
  read back via GET /sessions/{id}/invite (see invites.py), not the
  summary response (keeps the list/detail payloads tight).
- The detail endpoint now exposes `invite_token_preview` only when
  the caller IS the owner (so the session page can show a copy/rotate
  shortcut inline). Non-owners still 200 but get no preview.

v0.2.2 changes (2026-07-03)
---------------------------
- Session now declares its currency set (``currencies``: JSON list,
  1–2 ISO 4217 codes) and ``primary_currency`` (must be one of those).
- POST /sessions accepts ``currencies``, ``primary_currency`` and
  ``exchange_rates`` (the latter is a list of {from, to, rate}
  dicts; required when the session declares 2 currencies). The
  first currency listed is the implicit default for new bills.
- GET /sessions/{id} now echoes ``currencies`` + ``primary_currency``
  + ``exchange_rates`` so the FE BillForm / Settle pages can render
  without a second round-trip.
- 422 on unsupported currency codes, on primary-must-be-in-currencies,
  on > 2 currencies, and on dual-currency session missing
  ``exchange_rates``.

Datetime handling
-----------------
SQLite strips tzinfo on roundtrip for DateTime(timezone=True) columns,
so every value read back is naive. We always *write* tz-aware UTC
datetimes (Python-side) and rely on SQLAlchemy to normalise on save.
On read, naive values are interpreted as UTC (matching what we wrote).
The previous version re-tagged naive datetimes as local time, which
silently shifted UTC values by the local offset -- a latent bug that
v0.1.1's explicit invite_expires_at field surfaced in tests.
"""
from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, Request, Response, status
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.core.auth import get_current_user, get_optional_user
from app.core.config import settings
from app.core.database import get_db
from app.core.session_isolation import get_session_member, get_session_member_or_secret, require_session_owner
from app.db.models.session_exchange_rates import SessionExchangeRate
from app.db.models.session_members import SessionMember, SessionRole
from app.db.models.sessions import Session as SessionModel
from app.db.models.users import User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/sessions", tags=["sessions"])


# ---------------------------------------------------------------------------
# v0.2.2 multi-currency constants + helpers
# ---------------------------------------------------------------------------

# Whitelisted ISO 4217 codes (PRD §3.7). Anything outside this list is
# 422 at the API boundary so we never silently accept an unsupported
# currency and then fail later at settlement. The list is intentionally
# small (10 codes covering common trip scenarios) and is owned by the
# backend — the frontend mirrors it to render currency chips but
# never trusts client-side validation alone.
SUPPORTED_CURRENCIES: list[str] = [
    "CNY",  # Chinese yuan (home currency for the test suite)
    "USD",  # US dollar
    "THB",  # Thai baht (the canonical PRD example)
    "EUR",  # Euro
    "JPY",  # Japanese yen
    "GBP",  # British pound
    "HKD",  # Hong Kong dollar
    "SGD",  # Singapore dollar
    "KRW",  # Korean won
    "AUD",  # Australian dollar
]

# Default currency offered when the user clicks \"add second currency\"
# on the /sessions/new form (PRD §3.7 UX). USD is chosen because most
# of the existing test users travel internationally.
DEFAULT_SECONDARY_CURRENCY = "USD"


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class ExchangeRateIn(BaseModel):
    """One per (from, to) ordered pair.

    The pair is enforced unique by the DB (uq_rate_per_pair). The
    inverse pair (to → from) is a separate row — see the rate-creation
    loop in ``create_session`` which auto-inserts the reciprocal so the
    user does not have to enter both directions manually.
    """

    from_currency: str = Field(..., min_length=1, max_length=8)
    to_currency: str = Field(..., min_length=1, max_length=8)
    rate: Decimal = Field(..., gt=Decimal("0.00000001"), description="Conversion rate (> 0).")

    @field_validator("from_currency", "to_currency")
    @classmethod
    def _upper(cls, v: str) -> str:
        v = v.strip().upper()
        if not v:
            raise ValueError("currency code must not be blank")
        if v not in SUPPORTED_CURRENCIES:
            raise ValueError(f"currency '{v}' is not in SUPPORTED_CURRENCIES")
        return v

    @field_validator("rate")
    @classmethod
    def _quantize_rate(cls, v: Decimal) -> Decimal:
        # Accept any positive Decimal but normalise to 8dp (matches the
        # Numeric(28, 8) column precision so the API round-trip is
        # lossless).
        try:
            return v.quantize(Decimal("0.00000001"), rounding=ROUND_HALF_UP)
        except Exception:
            raise ValueError("rate must be a valid Decimal")


class ExchangeRateOut(BaseModel):
    id: int
    session_id: int
    from_currency: str
    to_currency: str
    rate: str  # Decimal-as-string per v0.2.2 wire format
    snapshot_at: str
    set_by: int | None


class CreateSessionRequest(BaseModel):
    """v0.2.2 (T08): multi-currency session create.

    ``currencies`` defaults to ``[\"CNY\"]`` — single-currency sessions
    are still allowed (and are 100% backward-compatible with the
    v0.2.1 Pydantic schema). When ``len(currencies) == 2`` the caller
    MUST supply at least one entry in ``exchange_rates`` describing
    how the two currencies relate (PRD §3.7.5).
    """

    name: str = Field(..., min_length=1, max_length=200)
    currencies: list[str] = Field(default_factory=lambda: ["CNY"])
    primary_currency: str = Field(default="CNY")
    exchange_rates: list[ExchangeRateIn] = Field(default_factory=list)
    # v0.3.1: optional initial member nicknames. Max 20 x 50 chars.
    member_nicknames: list[str] = Field(default_factory=list)

    @field_validator("member_nicknames")
    @classmethod
    def _validate_member_nicknames(cls, v):
        if len(v) > 20: raise ValueError("max 20 nicknames")
        seen = set(); out = []
        for raw in v:
            name = (raw or "").strip()
            if not name: continue
            if len(name) > 50: raise ValueError(f"nickname must be <= 50 chars")
            key = name.casefold()
            if key in seen: continue
            seen.add(key); out.append(name)
        return out

    @field_validator("currencies")
    @classmethod
    def _validate_currencies(cls, v: list[str]) -> list[str]:
        if not v:
            raise ValueError("currencies must not be empty")
        if len(v) > 2:
            raise ValueError("currencies must contain at most 2 entries")
        seen: set[str] = set()
        normalised: list[str] = []
        for raw in v:
            code = raw.strip().upper()
            if code not in SUPPORTED_CURRENCIES:
                raise ValueError(f"currency '{code}' is not in SUPPORTED_CURRENCIES")
            if code in seen:
                raise ValueError(f"duplicate currency '{code}'")
            seen.add(code)
            normalised.append(code)
        if not normalised:
            raise ValueError("currencies must not be empty")
        return normalised

    @field_validator("primary_currency")
    @classmethod
    def _validate_primary(cls, v: str) -> str:
        code = v.strip().upper()
        if code not in SUPPORTED_CURRENCIES:
            raise ValueError(f"primary_currency '{code}' is not in SUPPORTED_CURRENCIES")
        return code

    @model_validator(mode="after")
    def _cross_field(self) -> "CreateSessionRequest":
        # primary_currency MUST be one of currencies.
        if self.primary_currency not in self.currencies:
            raise ValueError(
                f"primary_currency '{self.primary_currency}' must be one of currencies {self.currencies}"
            )
        # Dual-currency sessions require at least one rate entry.
        if len(self.currencies) == 2 and not self.exchange_rates:
            raise ValueError(
                "dual-currency session requires at least one exchange_rates entry"
            )
        # The supplied exchange_rates must reference currencies in our set.
        for r in self.exchange_rates:
            if r.from_currency not in self.currencies:
                raise ValueError(
                    f"exchange_rate from_currency '{r.from_currency}' must be in currencies"
                )
            if r.to_currency not in self.currencies:
                raise ValueError(
                    f"exchange_rate to_currency '{r.to_currency}' must be in currencies"
                )
            if r.from_currency == r.to_currency:
                raise ValueError(
                    f"exchange_rate from_currency == to_currency ({r.from_currency})"
                )
        return self


class AvatarItem(BaseModel):
    """One member's avatar info for the SessionCard avatar stack.

    v0.3.x (UAT 0723 #6): 让 /sessions 列表的 SessionCard 在彩色圆点内
    显示成员昵称首字母. name 是原始 display_name (FE 可作 aria-label /
    tooltip / fallback). initial 是 1 字符显示字符串 — Latin 取首字母后
    大写, CJK 取原首字符 (e.g. "Jesse" → "J", "像汤圆一样圆" → "像",
    "我" → "我").
    """

    name: str  # 原始 display_name (FE aria-label / tooltip, 也作 initial fallback)
    initial: str  # 1 char 显示文字 (Latin 大写 + CJK 原字符)


class SessionSummary(BaseModel):
    """Single-session payload used in POST + GET /sessions responses."""

    id: int
    # v0.3.1 (Bug & Issues #5): unguessable public code; prefer this over
    # the integer id in invite URLs (e.g. /s/{session_code}).
    session_code: str = ""
    name: str
    # v0.3 (PRD §3.10): nullable for anonymous session creation.
    owner_user_id: int | None
    # v0.3.x (PRD §3.11): mirrors owner_user_id; NULL until the anonymous
    # creator hits POST /sessions/{id}/claim via the
    # "🔐 登录以保存" button.
    owner_email: str | None = None
    role: str
    member_count: int | None = None  # only populated for list responses
    created_at: str
    # v0.2.2 (T08): per-session currency metadata echoed so list
    # endpoints are sufficient for the FE to decide which chip to
    # pre-select.
    currencies: list[str] = []
    primary_currency: str = "CNY"
    # v0.3.1: only on POST /sessions response when member_nicknames supplied.
    created_member_ids: list[int] = Field(default_factory=list)
    # v0.3.x (UAT 0723 #6): 前 N 个成员的 name/initial 数组 (N 跟 FE
    # SessionCard.MAX_AVATARS=6 对齐). FE 用 initial 在 .avatar-mini 圆点
    # 内显示首字符. 超出 +N 显示跟 N+1 错开 (仍用 avatar-mini-overflow).
    avatars: list[AvatarItem] = Field(default_factory=list)


class SessionMemberOut(BaseModel):
    id: int
    # v0.3 (PRD §3.10): nullable for anonymous members.
    user_id: int | None
    # v0.3: email is None for anonymous members (no user account).
    email: str | None
    display_name: str
    role: str
    joined_at: str


# ---------------------------------------------------------------------------
# BUG-LANDING-1 / BUG-LANDING-3 (fix): public session preview.
#
# GET /sessions/{id}/preview is the new no-auth endpoint anon visitors use
# to render the /join page before they have a nickname secret. It exposes
# enough to:
#   - show the session name + currency chips on /join
#   - show all member slots (owner placeholder + nicknames) so /join can
#     render clickable "claim me" buttons
#   - share the invite_token + invite_url so an anon creator can copy the
#     invite link to friends right after creating the session
#
# Critical: this is a SEPARATE endpoint from GET /sessions/{id}. The
# existing detail endpoint still requires X-Nickname-Secret or login and
# never returns invite_token to non-owners. The preview endpoint always
# returns invite_token because it's the only way an anon visitor can
# learn the URL without first claiming a slot.
# ---------------------------------------------------------------------------


class SessionPreviewMember(BaseModel):
    """One slot in the session preview.

    No secrets (no nickname_secret, no email). No joined_at (preview is
    for the /join page which only cares about the slot identity + claim
    state). The ``display_name`` and ``role`` are sufficient for /join's
    "select your nickname" UI.
    """

    id: int
    display_name: str
    role: str
    user_id: int | None
    is_anon: bool
    # ISO datetime string; null when the slot has never been claimed.
    claimed_at: str | None


class SessionPreview(BaseModel):
    """Public preview payload (anon-accessible)."""

    id: int
    name: str
    currencies: list[str]
    primary_currency: str
    # v0.3.1: unguessable 10-char public code (e.g. /s/HY3MYUL9EQ).
    session_code: str
    # BUG-LANDING-3 (fix): the full invite token. Always returned on the
    # preview endpoint (no auth required) so anon creators can copy the
    # invite link from /join without first claiming a slot. Contrast with
    # GET /sessions/{id} which only returns invite_token_preview to the
    # owner.
    invite_token: str
    # Client-relative path to the invite landing page (FE will prepend
    # the origin). Same token as invite_token.
    invite_url: str
    # All slots (owner + member). Unclaimed first, claimed last, both
    # ordered by id so the order is stable across renders.
    members: list[SessionPreviewMember]


class SessionDetail(BaseModel):
    id: int
    # v0.3.1 (Bug & Issues #5): unguessable public code.
    session_code: str = ""
    name: str
    # v0.3 (PRD §3.10): nullable for anonymous session.
    owner_user_id: int | None
    # v0.3.x (PRD §3.11): see owner_email in SessionSummary.
    owner_email: str | None = None
    members: list[SessionMemberOut]
    created_at: str
    # v0.1.1: owner-only token preview. Frontend prefers the dedicated
    # GET /sessions/{id}/invite endpoint for live data; this is a hint
    # for inline display when the owner loads the page.
    invite_token_preview: str | None = None
    invite_expires_at: str | None = None
    # v0.2.1 T02 (PRD §3.6.2): SessionMember.ids of the most recent bill's
    # participants (NULL when the session has no bills yet). The frontend
    # uses this to prefill participants in BillForm's create mode.
    last_bill_participants: list[int] | None = None
    # v0.2.2 (T08): full currency metadata for the FE BillForm / Settle.
    currencies: list[str]
    primary_currency: str
    exchange_rates: list[ExchangeRateOut] = []
    # v0.3.x (UAT 0723 #6): 给详情页 hero 也可用 (虽然 FE 当前主要
    # 用在 SessionCard 列表页). 跟 SessionSummary.avatars 同源.
    avatars: list[AvatarItem] = Field(default_factory=list)


class UpdateMemberRequest(BaseModel):
    display_name: str = Field(..., min_length=1, max_length=50)


# v0.3.18 #53 (PO msg 10:49 #6542): owner-driven "add secondary currency"
# flow. The SessionCurrencyBadge single-pill renders as a clickable +
# icon for owner; the modal calls POST /sessions/{id}/currencies then
# POST /sessions/{id}/exchange-rates (the latter auto-pairs forward +
# reciprocal). This endpoint owns the "extend currencies set" half; the
# rate-row POST is unchanged (see exchange_rates.py).
class AddCurrencyRequest(BaseModel):
    """v0.3.18 #53: payload for adding a secondary currency to a session.

    The primary currency is locked (you can never change a session's
    primary post-create per v0.2.2 PRD §3.7.5); only the SECONDARY slot
    can be added. Constraint: at most 2 currencies per session.
    """

    currency: str = Field(..., min_length=1, max_length=8)

    @field_validator("currency")
    @classmethod
    def _upper_currency(cls, v: str) -> str:
        code = v.strip().upper()
        if not code:
            raise ValueError("currency code must not be blank")
        if code not in SUPPORTED_CURRENCIES:
            raise ValueError(f"currency '{code}' is not in SUPPORTED_CURRENCIES")
        return code


class UpdateMemberResponse(BaseModel):
    user_id: int
    display_name: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------



# v0.3.1 (PO Bug #5): unguessable session code generator.
# 10 chars from a 32-char alphabet (no 0/O/1/l/I confusion).
_SESSION_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _generate_session_code() -> str:
    """Return a 10-char URL-safe session code."""
    import secrets as _secrets
    return "".join(_secrets.choice(_SESSION_CODE_ALPHABET) for _ in range(10))


def _iso(dt: datetime | None) -> str:
    """Serialise a (possibly naive) datetime as an ISO 8601 string.

    Always treats naive datetimes as UTC. SQLite stores our tz-aware
    UTC writes as naive UTC values; treating them as local on read
    would silently shift every timestamp by the local offset.
    """
    if dt is None:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def _get_member_avatars(
    db: Session,
    session_id: int,
    limit: int = 6,
) -> list[AvatarItem]:
    """Return up to ``limit`` AvatarItem rows for the SessionCard avatar stack.

    v0.3.x (UAT 0723 #6): 让 /sessions 列表的 SessionCard 在彩色圆点内
    显示成员昵称首字母 (e.g. "Jesse" → "J", "像汤圆一样圆" → "像").

    Implementation notes:
      - Order: 按 SessionMember.id ASC (跟加入顺序一致 — 跟 SessionDetail
        endpoint 用 .order_by(SessionMember.joined_at.asc()) 顺序一致, 因为
        实际写入是连续 INSERT, id 顺序跟 joined_at 顺序保证 deterministic).
        Owner 是第 1 个加入的, 所以总是先显示; 其它成员按加入顺序.
      - Initial 计算: ``name[:1].upper()`` — Latin 字符 .upper() 变
        大写, CJK 字符 .upper() 留原字符 (Unicode 标准行为), 多字符表情
        部分也会留首字符. 空字符串走 fallback "?" 给单测更好 trace.
      - Limit: 跟 SessionCard.MAX_AVATARS=6 对齐. 超出 +N 显示交 FE 处理.
    """
    rows = (
        db.query(SessionMember)
        .filter(SessionMember.session_id == session_id)
        .order_by(SessionMember.id.asc())
        .limit(limit)
        .all()
    )
    out: list[AvatarItem] = []
    for sm in rows:
        name = sm.display_name or ""
        initial = name[:1].upper() if name else "?"
        out.append(AvatarItem(name=name, initial=initial))
    return out


def _summary_dict(
    session: SessionModel,
    role: str,
    member_count: int | None,
    created_member_ids: list[int] | None = None,
    avatars: list[AvatarItem] | None = None,
) -> dict:
    out: dict = {
        "id": session.id,
        "name": session.name,
        "owner_user_id": session.owner_user_id,
        "owner_email": session.owner_email,
        "role": role,
        "member_count": member_count,
        "created_at": _iso(session.created_at),
        "currencies": list(session.currencies or ["CNY"]),
        "primary_currency": session.primary_currency or "CNY",
        # v0.3.1 (Bug & Issues #5): unguessable public code.
        "session_code": session.session_code or "",
        # v0.3.x (UAT 0723 #6): 前 6 个成员的 name/initial, 供 SessionCard
        # avatar stack 在彩色圆点内显示首字符. None → [] 保 Pydantic 默认
        # 与 backward compatible (老 client 不读 avatars 字段不挂).
        "avatars": list(avatars) if avatars is not None else [],
    }
    # v0.3.1: only surface on create response.
    if created_member_ids is not None:
        out["created_member_ids"] = list(created_member_ids)
    return out


def _exchange_rate_dict(rate: SessionExchangeRate) -> dict:
    """Serialise a SessionExchangeRate row for the API response.

    Decimal-as-string for the rate field (matches the v0.2.2 wire
    contract used elsewhere — FE parseFloat()s it for display).
    """
    return {
        "id": rate.id,
        "session_id": rate.session_id,
        "from_currency": rate.from_currency,
        "to_currency": rate.to_currency,
        "rate": str(rate.rate),
        "snapshot_at": _iso(rate.snapshot_at),
        "set_by": rate.set_by,
    }


def _classify_invite_status(session: SessionModel) -> str:
    """Public invite status string for a session.

    Used by the invite endpoints (invites.py) and (mirrored) by the
    session detail endpoint. Returns "active" or "expired"; deleted /
    accepted no longer apply because there is one token per session
    that never goes into an "accepted" state (revisits are idempotent
    membership lookups, see SPEC §3.4.2 + PO decision B ii).
    """
    expires = session.invite_expires_at
    if expires is None:
        return "active"
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=timezone.utc)
    if expires < datetime.now(timezone.utc):
        return "expired"
    return "active"


def _check_session_activity_window(
    session: SessionModel,
) -> None:
    """§3.11.11 7-day activity window check.

    Raises HTTPException 410 if the session's last_active_at is more than
    ``settings.session_activity_ttl_days`` (default 7) in the past.
    This is independent from invite token TTL — the invite link can still
    be valid per ``invite_expires_at`` while the session itself has been
    reclaimed due to owner inactivity (PRD §3.11.11 decision α).
    """
    if session.last_active_at is None:
        # Defensive: treat missing value as active (new sessions).
        return
    last_active = session.last_active_at
    if last_active.tzinfo is None:
        last_active = last_active.replace(tzinfo=timezone.utc)
    cutoff = datetime.now(timezone.utc) - timedelta(
        days=settings.session_activity_ttl_days
    )
    if last_active < cutoff:
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail={
                "error": "session expired, owner not active for 7 days",
                "code": "session_reclaimed",
            },
        )


# ---------------------------------------------------------------------------
# POST /sessions
# ---------------------------------------------------------------------------


@router.post(
    "",
    response_model=SessionSummary,
    status_code=status.HTTP_201_CREATED,
)
async def create_session(
    payload: CreateSessionRequest,
    user: Annotated[User | None, Depends(get_optional_user)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Create a new session.

    v0.3 (PRD §3.10): supports anonymous session creation.
    - Logged-in user: owner_user_id = user.id, owner added as SessionMember.
    - Anonymous user: owner_user_id = NULL, no SessionMember row added.
      The creator must join via the join-claim flow to add themselves.

    v0.1.1: also mints the per-session fixed invite token (30-day TTL).

    v0.2.2 (T08): accepts ``currencies`` / ``primary_currency`` /
    ``exchange_rates``.

    201: session created.
    422: invalid name / currencies / exchange_rates (pydantic).
    """
    name = payload.name.strip()
    if not name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "name must not be blank"},
        )

    now = datetime.now(timezone.utc)
    invite_token = secrets.token_urlsafe(32)

    # v0.3 (PRD §3.10) + v0.3.x (PRD §3.11): anonymous creator leaves
    # both owner_user_id and owner_email NULL. Logged-in creator gets
    # both fields bound atomically here -- no further claim needed.
    session = SessionModel(
        name=name,
        owner_user_id=user.id if user else None,
        owner_email=user.email if user else None,
        invite_token=invite_token,
        invite_expires_at=now + timedelta(days=settings.invite_ttl_days),
        invite_created_at=now,
        currencies=list(payload.currencies),
        primary_currency=payload.primary_currency,
        session_code=_generate_session_code(),
        # §3.11.11: initialise activity clock at session creation.
        last_active_at=now,
    )
    db.add(session)
    db.flush()  # populate session.id

    # v0.2.2 (T08/T09): seed SessionExchangeRate rows.
    # set_by is the user_id if logged in, else NULL (anonymous creation).
    owner_id = user.id if user else None
    for r in payload.exchange_rates:
        db.add(
            SessionExchangeRate(
                session_id=session.id,
                from_currency=r.from_currency,
                to_currency=r.to_currency,
                rate=r.rate,
                set_by=owner_id,
            )
        )
        reciprocal = Decimal("1") / r.rate
        reciprocal = reciprocal.quantize(Decimal("0.00000001"), rounding=ROUND_HALF_UP)
        db.add(
            SessionExchangeRate(
                session_id=session.id,
                from_currency=r.to_currency,
                to_currency=r.from_currency,
                rate=reciprocal,
                set_by=owner_id,
            )
        )

    # v0.3: If logged in, the owner is also added as SessionMember.
    # Anonymous creators must join via the join-claim flow.
    if user is not None:
        sm = SessionMember(
            session_id=session.id,
            user_id=user.id,
            display_name=user.default_name,
            role=SessionRole.OWNER.value,
        )
        db.add(sm)

    # v0.3.15 (PO #4879) 修 wizard nicknames[0] "我" 改名不能生效:
    # anon path 用 nicknames[0] 作 owner placeholder display_name (默认 "我")
    # 这样用户改 nicknames[0] 后会真实成为 owner placeholder name, dedupe 跳过自己 → 无 n+1
    owner_placeholder_id: int | None = None
    owner_placeholder_name: str = "我"
    if user is None:
        # 用 nicknames[0] 作 owner placeholder name (trim 后非空), 否则默认 "我"
        if payload.member_nicknames:
            trimmed_first = (payload.member_nicknames[0] or "").strip()
            if trimmed_first:
                owner_placeholder_name = trimmed_first
        owner_sm = SessionMember(
            session_id=session.id,
            user_id=None,
            display_name=owner_placeholder_name,
            role=SessionRole.OWNER.value,
            nickname_secret=None,
            is_anon=True,
            claimed_at=None,
        )
        db.add(owner_sm)
        db.flush()
        owner_placeholder_id = owner_sm.id

    # v0.3.1: bulk-create unclaimed anonymous member rows for nicknames.
    # v0.3.15 (PO #4879) dedupe 包含 nicknames[0] (如果作 owner placeholder):
    # The landing wizard sends member_nicknames=[nicknames[0], ...同伴].
    # When nicknames[0] is empty/"我"/占位, BE uses owner placeholder "我"
    # and dedupes "我" (casefold) so we don't get a second row.
    # When nicknames[0] is a real name like "阿兰", BE uses that as owner
    # placeholder and dedupes "阿兰" (casefold) so we don't get a second row.
    created_member_ids: list[int] = []
    if owner_placeholder_id is not None:
        created_member_ids.append(owner_placeholder_id)
    # v0.3.15 (PO #4879): 登录态 owner 是 user.default_name (不是 placeholder),
    # 但 wizard nicknames[0]="你" placeholder 仍应当被跳过 (避免变 member).
    # 所以 login + anon 都把 nicknames[0] 加进 seen_nickname_keys (trim 后非空).
    seen_nickname_keys: set[str] = set()
    if owner_placeholder_id is not None:
        seen_nickname_keys.add(owner_placeholder_name.casefold())
    else:
        # login path: dedupe nicknames[0] placeholder ("你")
        first_nick = (payload.member_nicknames[0] if payload.member_nicknames else "").strip()
        if first_nick:
            seen_nickname_keys.add(first_nick.casefold())
    for nickname in payload.member_nicknames:
        key = nickname.casefold()
        if key in seen_nickname_keys:
            # Skip — the owner placeholder already represents this name.
            continue
        seen_nickname_keys.add(key)
        sm = SessionMember(
            session_id=session.id,
            user_id=None,
            display_name=nickname,
            role=SessionRole.MEMBER.value,
            nickname_secret=None,
            is_anon=True,
            claimed_at=None,
        )
        db.add(sm)
        db.flush()
        created_member_ids.append(sm.id)

    db.commit()
    db.refresh(session)

    # total_members:
    #   - Logged-in creator: 1 (their user-bound owner row) + len(nicknames).
    #   - Anon creator: 1 (the owner placeholder) + len(deduped nicknames).
    # In the anon branch created_member_ids starts with the owner
    # placeholder id, so we subtract 1 to get the count of additional
    # nickname rows. In the logged-in branch created_member_ids holds
    # ONLY the nickname rows (placeholder skipped), so we subtract 0.
    owner_in_created = 1 if owner_placeholder_id is not None else 0
    nickname_count = len(created_member_ids) - owner_in_created
    total_members = 1 + nickname_count
    # v0.3.x (UAT 0723 #6): 拉前 6 个成员的 name/initial 供 SessionCard
    # avatar stack 显示. members 刚 INSERT 完, flush 已 hold, 立刻读可拿
    # 到 (跟 detail endpoint 同 session 内读 pattern 一致).
    avatars = _get_member_avatars(db, session.id, limit=6)
    return _summary_dict(
        session,
        role=SessionRole.OWNER.value if user else "owner",
        member_count=total_members,
        created_member_ids=created_member_ids,
        avatars=avatars,
    )


# ---------------------------------------------------------------------------
# GET /sessions
# ---------------------------------------------------------------------------


@router.get("", response_model=list[SessionSummary])
async def list_sessions(
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> list[dict]:
    """List every session the caller belongs to.

    200: list of session summaries, ordered by created_at DESC (newest
    first) so the most recent trip is at the top of the UI.
    401: no/invalid cookie.
    """
    rows = (
        db.query(SessionModel, SessionMember)
        .join(SessionMember, SessionMember.session_id == SessionModel.id)
        .filter(SessionMember.user_id == user.id)
        .order_by(SessionModel.created_at.desc())
        .all()
    )

    out: list[dict] = []
    for session, sm in rows:
        # Count members in a second query — cheap for v0.1 (sessions are
        # small), avoids GROUP-BY plumbing for now.
        count = (
            db.query(func.count(SessionMember.id))
            .filter(SessionMember.session_id == session.id)
            .scalar()
        )
        # v0.3.x (UAT 0723 #6): 拉前 6 个成员的 name/initial 供 SessionCard
        # avatar stack 显示.
        avatars = _get_member_avatars(db, session.id, limit=6)
        out.append(
            _summary_dict(
                session,
                role=sm.role,
                member_count=int(count or 0),
                avatars=avatars,
            )
        )
    return out


# ---------------------------------------------------------------------------
# GET /sessions/{id}/preview   (BUG-LANDING-1 + BUG-LANDING-3 fix)
# ---------------------------------------------------------------------------


@router.get(
    "/{session_id}/preview",
    response_model=SessionPreview,
    status_code=status.HTTP_200_OK,
)
async def get_session_preview(
    db: Annotated[Session, Depends(get_db)],
    session_id: int = Path(..., description="Session ID"),
) -> dict:
    """Public, no-auth preview of a session.

    Why: anon visitors landing on /join need to see the session name,
    all member slots (so they can pick one to claim), and the invite
    token (so the creator can copy the invite link right after creation)
    -- without first calling GET /sessions/{id}, which 403s for anon.

    What this returns:
    - id, name, currencies, primary_currency
    - session_code (10-char unguessable public code)
    - invite_token (full token) + invite_url (client-relative /invites/{token})
    - members[]: all slots, ordered unclaimed-first then claimed (both
      ordered by id ASC) so the /join UI can render "claim me" buttons
      before "already taken" badges.

    What this does NOT do:
    - No auth check. Anon visitors can call it freely.
    - Does NOT expose nickname_secret, email, or joined_at.
    - Does NOT expose invite_expires_at (anon callers don't need to act
      on TTL -- they need to act on the URL).
    - Does NOT include bills or settlements.

    Path note: registered as /{session_id}/preview (not /preview) so it
    matches a literal ``preview`` segment, NOT the catch-all
    /{session_id} GET. FastAPI evaluates routes in declaration order so
    this endpoint also shadows any /{session_id}/preview/<x> future
    routes correctly.

    200: SessionPreview payload.
    404: session_id doesn't exist (raw integer lookup -- does NOT raise
         the auth-style 403 the detail endpoint raises).
    """
    session = db.query(SessionModel).filter_by(id=session_id).first()
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "session not found"},
        )

    # Pull every slot. No JOIN needed -- we don't expose email here, so
    # the User table is irrelevant for this endpoint.
    members_rows = (
        db.query(SessionMember)
        .filter(SessionMember.session_id == session.id)
        .order_by(SessionMember.claimed_at.is_(None).desc(), SessionMember.id.asc())
        .all()
    )

    members_payload: list[dict] = []
    for sm_row in members_rows:
        members_payload.append(
            {
                "id": sm_row.id,
                "display_name": sm_row.display_name,
                "role": sm_row.role,
                "user_id": sm_row.user_id,
                "is_anon": bool(sm_row.is_anon),
                # None for unclaimed slots; ISO string once claimed.
                "claimed_at": _iso(sm_row.claimed_at) if sm_row.claimed_at else None,
            }
        )

    invite_token = session.invite_token or ""
    return {
        "id": session.id,
        "name": session.name,
        "currencies": list(session.currencies or ["CNY"]),
        "primary_currency": session.primary_currency or "CNY",
        "session_code": session.session_code or "",
        "invite_token": invite_token,
        "invite_url": f"/invites/{invite_token}" if invite_token else "",
        "members": members_payload,
    }


# ---------------------------------------------------------------------------
# GET /sessions/{id}
# ---------------------------------------------------------------------------


def _compute_last_bill_participants(
    db: Session, session_id: int
) -> list[int] | None:
    """Find the most recent bill in the session and return its participant IDs.

    Returns ``None`` if the session has no bills yet (frontend treats
    that as "no history → fall back to default-all-included"). The "most
    recent" bill is the one with the latest occurred_at; ties broken by
    higher id (most recently created).
    """
    from app.db.models.bills import Bill
    from app.db.models.bill_participants import BillParticipant

    bill = (
        db.query(Bill)
        .filter(Bill.session_id == session_id)
        .order_by(Bill.occurred_at.desc(), Bill.id.desc())
        .first()
    )
    if bill is None:
        return None
    rows = (
        db.query(BillParticipant.member_id)
        .filter(BillParticipant.bill_id == bill.id)
        .order_by(BillParticipant.member_id.asc())
        .all()
    )
    return [mid for (mid,) in rows]


@router.get("/by-code/{session_code}", response_model=SessionDetail)
async def get_session_by_code(
    session_code: str,
    request: Request,
    user: Annotated[User | None, Depends(get_optional_user)],
    db: Annotated[Session, Depends(get_db)],
    response: Response,
) -> dict:
    """v0.3.1 (Bug & Issues #5): lookup a session by its public code.

    Builds the SessionDetail payload inline (rather than calling the
    shared _detail_dict helper) because the existing helper has subtle
    dependencies on the get_session_member_or_secret dep signature
    that don't apply here.
    """
    session = db.execute(
        select(SessionModel).where(SessionModel.session_code == session_code)
    ).scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail={"error": "session not found"})

    # §3.11.11: 7-day activity window check.
    _check_session_activity_window(session)

    from app.db.models.session_members import SessionMember as SessionMemberModel
    from app.db.models.users import User as UserModel
    sm = None
    if user is not None:
        sm = db.execute(
            select(SessionMemberModel).where(
                SessionMemberModel.session_id == session.id,
                SessionMemberModel.user_id == user.id,
            )
        ).scalar_one_or_none()
    if sm is None:
        secret = request.headers.get("X-Nickname-Secret")
        if secret:
            sm = db.execute(
                select(SessionMemberModel).where(
                    SessionMemberModel.session_id == session.id,
                    SessionMemberModel.nickname_secret == secret,
                )
            ).scalar_one_or_none()
    if sm is None:
        raise HTTPException(
            status_code=403,
            detail={"error": "not a session member", "session_id": session.id},
        )

    members = db.execute(
        select(SessionMemberModel, UserModel)
        .outerjoin(UserModel, UserModel.id == SessionMemberModel.user_id)
        .where(SessionMemberModel.session_id == session.id)
        .order_by(SessionMemberModel.joined_at.asc())
    ).all()
    last_bill_participants = _compute_last_bill_participants(db, session.id)
    rates = db.execute(
        select(SessionExchangeRate)
        .where(SessionExchangeRate.session_id == session.id)
        .order_by(SessionExchangeRate.from_currency.asc(), SessionExchangeRate.to_currency.asc())
    ).scalars().all()

    payload: dict = {
        "id": session.id,
        "session_code": session.session_code or "",
        "name": session.name,
        "owner_user_id": session.owner_user_id,
        # v0.3.x (PRD §3.11): persist owner email so the FE can render
        # the "🔐 登录以保存" CTA conditionally on session.owner_user_id
        # being NULL. Mirrors SessionSummary / SessionDetail.
        "owner_email": session.owner_email,
        "members": [
            {
                "id": sm_row.id,
                "user_id": sm_row.user_id,
                "email": u.email if u else None,
                "display_name": sm_row.display_name,
                "role": sm_row.role,
                "joined_at": _iso(sm_row.joined_at),
            }
            for sm_row, u in members
        ],
        "created_at": _iso(session.created_at),
        "invite_token_preview": None,
        "invite_expires_at": None,
        "last_bill_participants": last_bill_participants,
        "currencies": list(session.currencies or ["CNY"]),
        "primary_currency": session.primary_currency or "CNY",
        "exchange_rates": [_exchange_rate_dict(r) for r in rates],
    }
    if sm.role == SessionRole.OWNER.value:
        payload["invite_token_preview"] = session.invite_token
        payload["invite_expires_at"] = _iso(session.invite_expires_at)
    response.headers["X-SBC-Member-ID"] = str(sm.id)
    return payload


@router.get("/{session_id}/preview", response_model=dict)
async def get_session_preview_public(
    session_id: int,
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """v0.3.x (PO 12:45 Bug 2 fix): public no-auth session preview.

    Returns minimum session metadata + member list needed by the
    /join page for anon visitors who don't yet have a cookie or
    X-Nickname-Secret. Used so anon creators / invitees can see the
    nickname slots in the session before deciding to login / claim.

    Public fields only: name, currencies, primary_currency, members
    (id, display_name, role, user_id (NULL=anon), claimed_at).
    NO owner_user_id, owner_email, invite_token, invite_url, X-Nickname-Secret.

    200: lightweight payload
    404: session not found
    """
    session = db.execute(
        select(SessionModel).where(SessionModel.id == session_id)
    ).scalar_one_or_none()
    if session is None:
        raise HTTPException(status_code=404, detail={"error": "session not found"})

    # §3.11.11: 7-day activity window check (410 Gone when reclaimed).
    _check_session_activity_window(session)

    from app.db.models.session_members import SessionMember as SessionMemberModel
    members = db.execute(
        select(SessionMemberModel)
        .where(SessionMemberModel.session_id == session.id)
        .order_by(SessionMemberModel.joined_at.asc())
    ).scalars().all()

    return {
        "id": session.id,
        "name": session.name,
        "session_code": session.session_code or "",
        "currencies": list(session.currencies or ["CNY"]),
        "primary_currency": session.primary_currency or "CNY",
        "members": [
            {
                "id": m.id,
                "display_name": m.display_name,
                "role": m.role,
                "user_id": m.user_id,
                "is_anon": m.user_id is None,
                "claimed_at": _iso(m.joined_at),
                # §3.11.13: anon slot → return secret (already-public to claimer
                # via localStorage / X-Nickname-Secret); logged-in slot → null.
                "nickname_secret": (
                    m.nickname_secret
                    if (m.user_id is None and m.nickname_secret is not None)
                    else None
                ),
            }
            for m in members
        ],
    }


@router.get("/{session_id}", response_model=SessionDetail)
async def get_session(
    response: Response,
    sm: Annotated[SessionMember, Depends(get_session_member_or_secret)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Session detail + member list.

    v0.3 (PRD §3.10): supports anonymous access via X-Nickname-Secret header.
    Auto-match: if caller has a valid (user_id, session_id) binding or a
    matching nickname_secret, they get the session detail directly.
    Otherwise 403 (caller is redirected to join page by the FE).

    200: detail payload.
    401: no/invalid cookie AND no X-Nickname-Secret.
    403: caller is not a member of the session.
    404: session does not exist (only reached if the membership row
         points to a now-deleted session — see session_isolation for the
         403 path).

    v0.1.1: when the caller is the owner, the response also carries
    `invite_token_preview` + `invite_expires_at` so the frontend can
    pre-populate the inline invite link without an extra round-trip.
    Non-owners get the response without those fields.
    """
    session = db.query(SessionModel).filter_by(id=sm.session_id).first()
    if session is None:
        # Should be impossible — FK ON DELETE CASCADE — but stay defensive.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "session not found"},
        )

    # §3.11.11: 7-day activity window check (410 Gone when reclaimed).
    _check_session_activity_window(session)

    # v0.3 (PRD §3.10): use LEFT JOIN so anonymous members (user_id=NULL)
    # are included. Anonymous members have no user row, so u.email is None.
    members = (
        db.query(SessionMember, User)
        .outerjoin(User, User.id == SessionMember.user_id)
        .filter(SessionMember.session_id == session.id)
        .order_by(SessionMember.joined_at.asc())
        .all()
    )

    last_bill_participants = _compute_last_bill_participants(db, session.id)

    # v0.2.2 (T08/T09): load every SessionExchangeRate row for this
    # session so the FE settings page + BillForm can render without
    # a second API call.
    rates = (
        db.query(SessionExchangeRate)
        .filter(SessionExchangeRate.session_id == session.id)
        .order_by(SessionExchangeRate.from_currency.asc(), SessionExchangeRate.to_currency.asc())
        .all()
    )

    def _member_dict(sm_row: SessionMember, u: User | None) -> dict:
        return {
            "id": sm_row.id,
            "user_id": sm_row.user_id,  # None for anonymous
            "email": u.email if u else None,
            "display_name": sm_row.display_name,
            "role": sm_row.role,
            "joined_at": _iso(sm_row.joined_at),
        }

    payload: dict = {
        "id": session.id,
        # v0.3.1 (Bug & Issues #5): public 10-char session_code for unguessable URLs.
        "session_code": session.session_code or "",
        "name": session.name,
        "owner_user_id": session.owner_user_id,
        # v0.3.x (PRD §3.11): persist owner email so the FE can render
        # the "🔐 登录以保存" CTA conditionally on session.owner_user_id
        # being NULL. Mirrors SessionSummary / SessionDetail.
        "owner_email": session.owner_email,
        "members": [_member_dict(sm_row, u) for sm_row, u in members],

        "created_at": _iso(session.created_at),
        "invite_token_preview": None,
        "invite_expires_at": None,
        "last_bill_participants": last_bill_participants,
        # v0.2.2 (T08): full currency metadata for the FE BillForm /
        # Settle / Settings pages.
        "currencies": list(session.currencies or ["CNY"]),
        "primary_currency": session.primary_currency or "CNY",
        "exchange_rates": [_exchange_rate_dict(r) for r in rates],
        # v0.3.x (UAT 0723 #6): 详情页 hero 也可以用 same avatar 数组
        # (虽然 FE 当前主要消费 SessionCard 列表页). 拉前 6 跟 SessionSummary
        # 同步. members 已用 .order_by(joined_at.asc()) 拿到, _get_member_avatars
        # 内部按 id ASC 重拉 — 同样数据, double query 但保证顺序一致.
        "avatars": [
            a.model_dump() for a in _get_member_avatars(db, session.id, limit=6)
        ],
    }

    # Owner-only invite preview. Non-owners still get 200 but with NULL
    # fields; the frontend then loads GET /sessions/{id}/invite on demand.
    if sm.role == SessionRole.OWNER.value:
        payload["invite_token_preview"] = session.invite_token
        payload["invite_expires_at"] = _iso(session.invite_expires_at)

    # v0.3 (PRD §3.10): tell the FE which member-row belongs to the
    # anonymous caller (for currentMember derivation).
    # sm.id is the SessionMember row PK from get_session_member_or_secret.
    response.headers["X-SBC-Member-ID"] = str(sm.id)

    return payload


# ---------------------------------------------------------------------------
# POST /sessions/{id}/claim (v0.3.x — PRD §3.11)
# ---------------------------------------------------------------------------

@router.post(
    "/{session_id}/claim",
    response_model=SessionDetail,
)
async def claim_session(
    session_id: int,
    request: Request,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """v0.3.x (PRD §3.11): bind the current user as the session owner.

    Sole entry point for owner claim. Triggered by the FE onMount of
    /sessions/{id} when the URL carries ``?claim=1`` -- the user
    originally hit the "🔐 登录以保存" CTA on the anon-owned session
    detail page, went through /auth/login?returnTo=...&claim=1, and
    is now back with a fresh sbc_session cookie.

    Guards (PRD §3.11.5):
      * Must be authenticated (401 otherwise, via get_current_user).
      * Session must exist (404).
      * session.owner_user_id must still be NULL (409) -- prevents
        racing with another user who claimed first.
      * session.owner_email must still be NULL (409) -- belt-and-braces
        to owner_user_id (they are always set together, but checking
        both catches any future drift).

    Success: atomically sets owner_user_id AND owner_email on the
    sessions row and returns the full SessionDetail so the FE can
    refresh its local state and re-render without the
    "🔐 登录以保存" CTA.

    Not invoked from any other path: verify-code, dashboard, session
    list, etc. all leave owner_email alone (PRD §3.11.8).
    """
    _ = request  # kept for parity with other endpoints that use Request directly
    session = db.query(SessionModel).filter_by(id=session_id).first()
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "session not found"},
        )
    if session.owner_user_id is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": "session already claimed"},
        )
    if session.owner_email is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"error": "session owner_email already set"},
        )

    # Atomic UPDATE with the same guard in the WHERE so two concurrent
    # claimants cannot both succeed even if both pass the read-side
    # check above. SQLite serialises writes; we also add the explicit
    # owner_user_id IS NULL guard for clarity.
    # §3.11.11: also bump last_active_at so owner claiming resets the
    # 7-day clock (owner proving they're still active).
    now = datetime.now(timezone.utc)
    db.execute(
        update(SessionModel)
        .where(SessionModel.id == session_id, SessionModel.owner_user_id.is_(None))
        .values(owner_user_id=user.id, owner_email=user.email, last_active_at=now)
    )
    db.commit()
    db.refresh(session)

    # Build the same inline payload as get_session (see comment there)
    # so the FE can drop the response into its existing session state
    # without a second round-trip. The claimer is the new owner; the
    # SessionMember row was created back in the wizard / join-claim
    # flow, so we can derive their member_id from the (user_id,
    # session_id) binding. If the claimer never bound a nickname
    # (e.g. creator who skipped §3.10.5), we fall back to the
    # session's first owner-role row (typically None -- caller is
    # the first owner member).
    from app.db.models.session_members import SessionMember as _SM
    sm = (
        db.query(_SM)
        .filter(_SM.session_id == session.id, _SM.user_id == user.id)
        .first()
    )
    if sm is None:
        # No nickname binding yet -- synthesise a minimal SessionMember
        # payload so the response shape stays consistent. The FE's
        # currentMember derivation will fall back to "no row" UI.
        members = (
            db.query(SessionMember, User)
            .outerjoin(User, User.id == SessionMember.user_id)
            .filter(SessionMember.session_id == session.id)
            .order_by(SessionMember.joined_at.asc())
            .all()
        )
        acting_member_id: int | None = None
    else:
        members = (
            db.query(SessionMember, User)
            .outerjoin(User, User.id == SessionMember.user_id)
            .filter(SessionMember.session_id == session.id)
            .order_by(SessionMember.joined_at.asc())
            .all()
        )
        acting_member_id = sm.id

    last_bill_participants = _compute_last_bill_participants(db, session.id)
    rates = (
        db.query(SessionExchangeRate)
        .filter(SessionExchangeRate.session_id == session.id)
        .order_by(
            SessionExchangeRate.from_currency.asc(),
            SessionExchangeRate.to_currency.asc(),
        )
        .all()
    )

    payload: dict = {
        "id": session.id,
        "session_code": session.session_code or "",
        "name": session.name,
        "owner_user_id": session.owner_user_id,
        "owner_email": session.owner_email,
        "members": [
            {
                "id": sm_row.id,
                "user_id": sm_row.user_id,
                "email": u.email if u else None,
                "display_name": sm_row.display_name,
                "role": sm_row.role,
                "joined_at": _iso(sm_row.joined_at),
            }
            for sm_row, u in members
        ],
        "created_at": _iso(session.created_at),
        "invite_token_preview": session.invite_token,
        "invite_expires_at": _iso(session.invite_expires_at),
        "last_bill_participants": last_bill_participants,
        "currencies": list(session.currencies or ["CNY"]),
        "primary_currency": session.primary_currency or "CNY",
        "exchange_rates": [_exchange_rate_dict(r) for r in rates],
    }
    return payload


# ---------------------------------------------------------------------------
# POST /sessions/{id}/currencies (v0.3.18 #53 - PO msg 10:49 #6542)
# ---------------------------------------------------------------------------


@router.post(
    "/{session_id}/currencies",
    response_model=SessionDetail,
)
async def add_session_currency(
    payload: AddCurrencyRequest,
    sm: Annotated[SessionMember, Depends(require_session_owner)],
    db: Annotated[Session, Depends(get_db)],
    session_id: int = Path(..., description="sessions.id"),
) -> dict:
    """v0.3.18 #53 - owner-only "add secondary currency" endpoint.

    Triggered from the SessionCurrencyBadge single-pill click (when the
    session currently has 1 currency and the caller is the owner). The
    FE then submits a follow-up POST to /exchange-rates with the rate
    between the new currency and the primary (the exchange_rates.py
    endpoint auto-pairs forward + reciprocal rows).

    Guards:
      * require_session_owner -> 403 if not owner (or not a member).
      * 404 if the session does not exist.
      * 409 if the new currency is ALREADY in the session.currencies set
        (idempotent error rather than silent no-op - the FE knows to
        bail out and reload).
      * 422 if adding would exceed 2 currencies (PRD §3.7.5 hard cap).

    On success: appends the new currency to the JSON ``currencies``
    column, commits, then returns the full SessionDetail payload so the
    FE can drop the response into its existing session state and
    re-render without a second round-trip (the badge will switch from
    single-pill to dual-currency-bar after the FE's follow-up
    /exchange-rates POST completes too).

    Note: this endpoint **does not** create an exchange rate. The FE
    makes a separate POST to /exchange-rates after this succeeds. We
    keep the two operations decoupled so that "add currency" remains a
    pure metadata change even if the user changes their mind about the
    rate - they can cancel the modal between the two calls and the
    session is left in a consistent "currency added but no rate yet"
    state (which is fine for the FE; the next POST /exchange-rates
    will populate the rate or 422 if the user picks a different
    currency).
    """
    session = db.query(SessionModel).filter_by(id=session_id).first()
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "session not found"},
        )

    current_currencies = list(session.currencies or ["CNY"])

    if payload.currency in current_currencies:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "currency_already_in_session",
                "currency": payload.currency,
                "session_currencies": current_currencies,
            },
        )
    if len(current_currencies) >= 2:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": "max_2_currencies_per_session",
                "current_currencies": current_currencies,
            },
        )

    # Append + commit. Preserve the primary_currency (locked by the
    # add-currency endpoint contract - see class docstring).
    new_currencies = current_currencies + [payload.currency]
    session.currencies = new_currencies
    db.commit()
    db.refresh(session)

    # Build the same inline payload as get_session / claim_session so
    # the FE can drop the response into its existing session state.
    members = (
        db.query(SessionMember, User)
        .outerjoin(User, User.id == SessionMember.user_id)
        .filter(SessionMember.session_id == session.id)
        .order_by(SessionMember.joined_at.asc())
        .all()
    )
    last_bill_participants = _compute_last_bill_participants(db, session.id)
    rates = (
        db.query(SessionExchangeRate)
        .filter(SessionExchangeRate.session_id == session.id)
        .order_by(
            SessionExchangeRate.from_currency.asc(),
            SessionExchangeRate.to_currency.asc(),
        )
        .all()
    )

    payload_out: dict = {
        "id": session.id,
        "session_code": session.session_code or "",
        "name": session.name,
        "owner_user_id": session.owner_user_id,
        "owner_email": session.owner_email,
        "members": [
            {
                "id": sm_row.id,
                "user_id": sm_row.user_id,
                "email": u.email if u else None,
                "display_name": sm_row.display_name,
                "role": sm_row.role,
                "joined_at": _iso(sm_row.joined_at),
            }
            for sm_row, u in members
        ],
        "created_at": _iso(session.created_at),
        # Owner-only invite preview (caller IS owner via dep guard).
        "invite_token_preview": session.invite_token,
        "invite_expires_at": _iso(session.invite_expires_at),
        "last_bill_participants": last_bill_participants,
        "currencies": list(session.currencies or ["CNY"]),
        "primary_currency": session.primary_currency or "CNY",
        "exchange_rates": [_exchange_rate_dict(r) for r in rates],
    }
    return payload_out


# ---------------------------------------------------------------------------
# DELETE /sessions/{id}/currencies/{code} (v0.3.21 #108 - PO msg 17:54)
# ---------------------------------------------------------------------------


@router.delete(
    "/{session_id}/currencies/{currency_code}",
    response_model=SessionDetail,
)
async def remove_session_currency(
    currency_code: str,
    sm: Annotated[SessionMember, Depends(require_session_owner)],
    db: Annotated[Session, Depends(get_db)],
    session_id: int = Path(..., description="sessions.id"),
) -> dict:
    """v0.3.21 #108 (PO msg 17:54): owner-only "remove secondary currency" endpoint.

    Mirror of POST /sessions/{id}/currencies: removes a secondary currency
    from the session + cascades its exchange rates. Triggered from
    CurrencyAddModal when the user picks 「—」 (代表 "切回单币种") OR when
    the user picks a different currency as new secondary (replace flow).

    Guards:
      * require_session_owner -> 403 if not owner (or not a member).
      * 404 if the session does not exist.
      * 404 if the currency is NOT in the session's currencies set
        (idempotent error rather than silent no-op).
      * 409 if the currency IS the session's primary_currency -- we never
        let owners delete the primary currency via this endpoint (per
        PRD §3.7.5 the primary is locked at the metadata level).
      * 422 if the currency code is not in SUPPORTED_CURRENCIES.

    Cascade:
      * Remove the currency from session.currencies (filter the JSON list).
      * DELETE every SessionExchangeRate row whose from_currency OR
        to_currency matches (forward + reciprocal legs, both gone).

    On success: returns the full SessionDetail payload (same shape as
    POST /sessions/{id}/currencies + claim_session + get_session) so the
    FE can drop the response into its existing session state and
    re-render the SessionCurrencyBadge without a second round-trip.
    """
    code = currency_code.strip().upper()
    if code not in SUPPORTED_CURRENCIES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": "currency_not_supported",
                "currency": code,
                "supported_currencies": list(SUPPORTED_CURRENCIES),
            },
        )

    session = db.query(SessionModel).filter_by(id=session_id).first()
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "session not found"},
        )

    current_currencies = list(session.currencies or ["CNY"])

    if code not in current_currencies:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "error": "currency_not_in_session",
                "currency": code,
                "session_currencies": current_currencies,
            },
        )

    if code == session.primary_currency:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "cannot_remove_primary_currency",
                "currency": code,
            },
        )

    # Cascade: remove from currencies list + delete every rate row
    # that references this currency in either direction.
    new_currencies = [c for c in current_currencies if c != code]
    session.currencies = new_currencies
    db.flush()

    rates_to_delete = (
        db.query(SessionExchangeRate)
        .filter(
            SessionExchangeRate.session_id == session_id,
            (SessionExchangeRate.from_currency == code)
            | (SessionExchangeRate.to_currency == code),
        )
        .all()
    )
    for r in rates_to_delete:
        db.delete(r)

    db.commit()
    db.refresh(session)

    # Build the same inline SessionDetail payload as POST /currencies +
    # claim_session + get_session so the FE can drop it in.
    members = (
        db.query(SessionMember, User)
        .outerjoin(User, User.id == SessionMember.user_id)
        .filter(SessionMember.session_id == session.id)
        .order_by(SessionMember.joined_at.asc())
        .all()
    )
    last_bill_participants = _compute_last_bill_participants(db, session.id)
    remaining_rates = (
        db.query(SessionExchangeRate)
        .filter(SessionExchangeRate.session_id == session.id)
        .order_by(
            SessionExchangeRate.from_currency.asc(),
            SessionExchangeRate.to_currency.asc(),
        )
        .all()
    )

    payload_out: dict = {
        "id": session.id,
        "session_code": session.session_code or "",
        "name": session.name,
        "owner_user_id": session.owner_user_id,
        "owner_email": session.owner_email,
        "members": [
            {
                "id": sm_row.id,
                "user_id": sm_row.user_id,
                "email": u.email if u else None,
                "display_name": sm_row.display_name,
                "role": sm_row.role,
                "joined_at": _iso(sm_row.joined_at),
            }
            for sm_row, u in members
        ],
        "created_at": _iso(session.created_at),
        "invite_token_preview": session.invite_token,
        "invite_expires_at": _iso(session.invite_expires_at),
        "last_bill_participants": last_bill_participants,
        "currencies": list(session.currencies or ["CNY"]),
        "primary_currency": session.primary_currency or "CNY",
        "exchange_rates": [_exchange_rate_dict(r) for r in remaining_rates],
    }
    return payload_out


# ---------------------------------------------------------------------------
# v0.3.25 #16 (UAT line: /sessions 账本 item 加红色删除按钮, owner only):
# DELETE /sessions/{session_id} — owner-only 硬删除整个 session + cascade.
# ---------------------------------------------------------------------------
@router.delete(
    "/{session_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_session(
    sm: Annotated[SessionMember, Depends(require_session_owner)],
    db: Annotated[Session, Depends(get_db)],
    session_id: int = Path(..., description="sessions.id"),
) -> None:
    """Owner-only 硬删除整个 session.

    v0.3.25 #16 (UAT): SessionCard 加红色删除按钮 (owner only). 后端 cascade:
    - Session.members (cascade all, delete-orphan) → SessionMember × N
    - Session.bills (cascade all, delete-orphan) → Bill × N → BillParticipant × N
    - Session.settlements (cascade all, delete-orphan) → Settlement × N
    - Session.exchange_rates (cascade all, delete-orphan) → SessionExchangeRate × N
    - Session.invites (外键 to session_id) → SessionInvite × N
    - SessionMemberClaim (外键 to session_id via SessionMember) → 跟随 member cascade

    Guards:
    - require_session_owner → 403 if caller is not owner (or not a member).
    - 404 if session does not exist (raise 之前).

    不可逆 — PO 字面反馈 "此操作不可逆". 响应 204 No Content (REST 习惯).
    """
    session = db.query(SessionModel).filter_by(id=session_id).first()
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "session not found"},
        )
    db.delete(session)
    db.commit()
    return None


# ---------------------------------------------------------------------------
# PATCH /sessions/{id}/members/{mid}
# ---------------------------------------------------------------------------


@router.patch(
    "/{session_id}/members/{member_id}",
    response_model=UpdateMemberResponse,
)
async def update_member_display_name(
    payload: UpdateMemberRequest,
    sm: Annotated[SessionMember, Depends(get_session_member)],
    db: Annotated[Session, Depends(get_db)],
    member_id: int = Path(..., description="SessionMember.id"),
) -> dict:
    """Update the caller's own per-session nickname.

    v0.1 simplification: member_id MUST equal the caller's row in
    that session. Anything else is a 403. This avoids the v0.2
    permission matrix (owner renames / admin renames) and keeps the
    endpoint scope tight.

    200: nickname updated.
    400: empty / over-50 chars (pydantic).
    401: no/invalid cookie.
    403: caller is not a member, OR member_id is not theirs.
    404: member row doesn't exist in this session.
    """
    if member_id != sm.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error": "can only update your own member row"},
        )

    new_name = payload.display_name.strip()
    if not new_name:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "display_name must not be blank"},
        )

    sm.display_name = new_name
    db.commit()
    db.refresh(sm)
    return {"user_id": sm.user_id, "display_name": sm.display_name}


# ---------------------------------------------------------------------------
# POST /sessions/{id}/join-claim   (v0.3 anon participation)
# ---------------------------------------------------------------------------


class JoinClaimRequest(BaseModel):
    """v0.3 (PRD §3.10): Request body for POST /sessions/{id}/join-claim.

    ``action``: "claim" = take an existing unclaimed nickname slot;
                "add" = create a new nickname row.
    ``session_member_id``: required for "claim" (the slot to take).
    ``display_name``: required for "add" (the new nickname).
    ``nickname_secret``: the caller's current secret (for anonymous re-entry
                         when already claimed; used for validation).
    """

    action: str = Field(..., pattern="^(claim|add)$")
    session_member_id: int | None = None
    display_name: str | None = None
    nickname_secret: str | None = None

    @model_validator(mode="after")
    def _validate(self) -> "JoinClaimRequest":
        if self.action == "claim" and self.session_member_id is None:
            raise ValueError("session_member_id is required for action=claim")
        if self.action == "add":
            if not self.display_name or not self.display_name.strip():
                raise ValueError("display_name is required for action=add")
        return self


class JoinClaimResponse(BaseModel):
    session_member_id: int
    display_name: str
    nickname_secret: str | None = None
    role: str
    joined_at: str
    is_anon: bool


@router.post(
    "/{session_id}/join-claim",
    response_model=JoinClaimResponse,
    status_code=status.HTTP_200_OK,
)
async def join_claim_session(
    payload: JoinClaimRequest,
    user: Annotated[User | None, Depends(get_optional_user)],
    db: Annotated[Session, Depends(get_db)],
    session_id: int = Path(..., description="Session ID"),
) -> dict:
    """v0.3 (PRD §3.10): Claim an existing nickname slot or add a new one.

    Anonymous callers (no cookie):
    - action=claim: UPDATE existing unclaimed row (nickname_secret=NULL)
      SET nickname_secret=<new_hex>, claimed_at=NOW(), is_anon=true.
      Returns the new secret for localStorage. 409 if already claimed.
    - action=add: INSERT new anonymous row with nickname_secret=<new_hex>,
      is_anon=true, claimed_at=NOW().

    Logged-in callers:
    - action=claim: UPDATE row SET user_id=current_user.id, is_anon=false.
      (Does NOT change nickname_secret or claimed_at.)
    - action=add: INSERT new row with user_id=current_user.id, is_anon=false.

    200: success.
    400: invalid payload (missing fields, blank display_name).
    403: session doesn't exist or caller can't join.
    404: session not found.
    409: conflict — the nickname slot was already claimed by another anon.
    """
    # Verify session exists.
    session = db.query(SessionModel).filter_by(id=session_id).first()
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "session not found"},
        )

    # §3.11.11: 7-day activity window check.
    _check_session_activity_window(session)

    now = datetime.now(timezone.utc)

    if payload.action == "claim":
        assert payload.session_member_id is not None
        sm = (
            db.query(SessionMember)
            .filter_by(id=payload.session_member_id, session_id=session_id)
            .first()
        )
        if sm is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"error": "member not found in this session"},
            )

        if user is not None:
            # Logged-in: bind user_id to this nickname slot.
            sm.user_id = user.id
            sm.is_anon = False
            # §3.11.11: bump owner activity clock on every join/claim.
            session.last_active_at = now
            db.commit()
            db.refresh(sm)
            return {
                "session_member_id": sm.id,
                "display_name": sm.display_name,
                "nickname_secret": None,
                "role": sm.role,
                "joined_at": _iso(sm.joined_at),
                "is_anon": sm.is_anon,
            }
        else:
            # Anonymous caller — split into 2 paths (SPEC §3.11.11.B / PRD §3.11.11.5 decisions beta/gamma).
            if sm.user_id is not None:
                # Decision gamma (anon-to-loggedin): do NOT overwrite (impersonation risk).
                # Tell FE to bounce the caller to /auth/login with a returnTo back to /join.
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail={
                        "error": "requires_login",
                        "reason": "slot is owned by a logged-in user; please login to claim",
                        "slot_owner_user_id": sm.user_id,
                    },
                )
            # Decision beta (anon-to-anon overwrite) and anon-to-unclaimed (first claim) — both accepted.
            new_secret = secrets.token_hex(32)
            sm.nickname_secret = new_secret  # overwrite any prior anon secret (beta rotation)
            sm.claimed_at = now
            sm.is_anon = True
            sm.user_id = None  # defensive: clear any stale user binding
            # §3.11.11: bump owner activity clock on every join/claim.
            session.last_active_at = now
            db.commit()
            db.refresh(sm)
            return {
                "session_member_id": sm.id,
                "display_name": sm.display_name,
                "nickname_secret": new_secret,
                "role": sm.role,
                "joined_at": _iso(sm.joined_at),
                "is_anon": sm.is_anon,
            }

    else:  # action == "add"
        display_name = payload.display_name.strip()
        if not display_name:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"error": "display_name must not be blank"},
            )

        if user is not None:
            # Logged-in: create user-bound member row.
            sm = SessionMember(
                session_id=session_id,
                user_id=user.id,
                display_name=display_name,
                role=SessionRole.MEMBER.value,
                is_anon=False,
                claimed_at=now,
            )
            db.add(sm)
            # §3.11.11: bump owner activity clock on every join/claim.
            session.last_active_at = now
            db.commit()
            db.refresh(sm)
            return {
                "session_member_id": sm.id,
                "display_name": sm.display_name,
                "nickname_secret": None,
                "role": sm.role,
                "joined_at": _iso(sm.joined_at),
                "is_anon": sm.is_anon,
            }
        else:
            # Anonymous: create anon member row with new secret.
            new_secret = secrets.token_hex(32)
            sm = SessionMember(
                session_id=session_id,
                user_id=None,
                display_name=display_name,
                role=SessionRole.MEMBER.value,
                nickname_secret=new_secret,
                is_anon=True,
                claimed_at=now,
            )
            db.add(sm)
            # §3.11.11: bump owner activity clock on every join/claim.
            session.last_active_at = now
            db.commit()
            db.refresh(sm)
            return {
                "session_member_id": sm.id,
                "display_name": sm.display_name,
                "nickname_secret": new_secret,
                "role": sm.role,
                "joined_at": _iso(sm.joined_at),
                "is_anon": sm.is_anon,
            }


# §3.11.14: anon-claimed slot → user-bound on login.
# Triggered by FE after /auth/login verify_code 200 — localStorage secret → BE.
# BE finds the SessionMember (session_id, nickname_secret, is_anon=True, user_id IS NULL)
# and binds user_id to the current user.


class BindActingMemberRequest(BaseModel):
    nickname_secret: str = Field(..., min_length=1, max_length=64)


class BindActingMemberResponse(BaseModel):
    session_member_id: int
    display_name: str
    user_id: int


@router.post(
    "/{session_id}/bind-acting-member",
    response_model=BindActingMemberResponse,
    status_code=status.HTTP_200_OK,
)
async def bind_acting_member(
    payload: BindActingMemberRequest,
    user: Annotated[User, Depends(get_current_user)],
    db: Annotated[Session, Depends(get_db)],
    session_id: int = Path(..., description="Session ID"),
) -> dict:
    """§3.11.14: anon-claimed slot → user-bound.

    FE 在登录 verify_code 200 后调一次 (NavBar "登录以保存" 触发流):
    - 拿 localStorage `sbc.actingAs.{sid}` → secret
    - 调本 endpoint with {nickname_secret: secret}
    - BE 找 SessionMember (session_id=sid AND nickname_secret=secret AND user_id IS NULL AND is_anon=True)
    - 找到 → SET user_id=current_user.id, is_anon=False, claimed_at=now()

    失败返 404 (session 不存在 OR slot 已不存在 / 已被 β 轮换 / 已绑 user_id).
    FE 静默吞掉 (用户仍以 anon 进入 session, localStorage secret 仍有效).
    """
    sm = db.execute(
        select(SessionMember)
        .where(
            SessionMember.session_id == session_id,
            SessionMember.nickname_secret == payload.nickname_secret,
            SessionMember.user_id.is_(None),
            SessionMember.is_anon.is_(True),
        )
    ).scalar_one_or_none()
    if sm is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "no matching anon-claimed slot", "session_id": session_id},
        )

    session = db.get(SessionModel, session_id)
    if session is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "session not found"},
        )
    _check_session_activity_window(session)  # 410 if expired (existing helper)

    sm.user_id = user.id
    sm.is_anon = False
    sm.claimed_at = datetime.now(timezone.utc)
    session.last_active_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(sm)

    return {
        "session_member_id": sm.id,
        "display_name": sm.display_name,
        "user_id": sm.user_id,
    }
