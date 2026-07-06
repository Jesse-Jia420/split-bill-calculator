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

from fastapi import APIRouter, Depends, HTTPException, Path, Response, status
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.auth import get_current_user, get_optional_user
from app.core.config import settings
from app.core.database import get_db
from app.core.session_isolation import get_session_member, get_session_member_or_secret
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


class SessionSummary(BaseModel):
    """Single-session payload used in POST + GET /sessions responses."""

    id: int
    name: str
    # v0.3 (PRD §3.10): nullable for anonymous session creation.
    owner_user_id: int | None
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


class SessionMemberOut(BaseModel):
    id: int
    # v0.3 (PRD §3.10): nullable for anonymous members.
    user_id: int | None
    # v0.3: email is None for anonymous members (no user account).
    email: str | None
    display_name: str
    role: str
    joined_at: str


class SessionDetail(BaseModel):
    id: int
    name: str
    # v0.3 (PRD §3.10): nullable for anonymous session.
    owner_user_id: int | None
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


class UpdateMemberRequest(BaseModel):
    display_name: str = Field(..., min_length=1, max_length=50)


class UpdateMemberResponse(BaseModel):
    user_id: int
    display_name: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


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


def _summary_dict(
    session: SessionModel,
    role: str,
    member_count: int | None,
    created_member_ids: list[int] | None = None,
) -> dict:
    out: dict = {
        "id": session.id,
        "name": session.name,
        "owner_user_id": session.owner_user_id,
        "role": role,
        "member_count": member_count,
        "created_at": _iso(session.created_at),
        "currencies": list(session.currencies or ["CNY"]),
        "primary_currency": session.primary_currency or "CNY",
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

    # v0.3: owner_user_id is nullable. Anonymous creator → NULL.
    session = SessionModel(
        name=name,
        owner_user_id=user.id if user else None,
        invite_token=invite_token,
        invite_expires_at=now + timedelta(days=settings.invite_ttl_days),
        invite_created_at=now,
        currencies=list(payload.currencies),
        primary_currency=payload.primary_currency,
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

    # v0.3.1: bulk-create unclaimed anonymous member rows for nicknames.
    created_member_ids = []
    for nickname in payload.member_nicknames:
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

    total_members = (1 if user is not None else 0) + len(payload.member_nicknames)
    return _summary_dict(
        session,
        role=SessionRole.OWNER.value if user else "owner",
        member_count=total_members,
        created_member_ids=created_member_ids,
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
        out.append(_summary_dict(session, role=sm.role, member_count=int(count or 0)))
    return out


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
        "name": session.name,
        "owner_user_id": session.owner_user_id,
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
            # Anonymous: claim the slot.
            if sm.nickname_secret is not None:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail={"error": "nickname already claimed by another user"},
                )
            new_secret = secrets.token_hex(32)
            sm.nickname_secret = new_secret
            sm.claimed_at = now
            sm.is_anon = True
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
