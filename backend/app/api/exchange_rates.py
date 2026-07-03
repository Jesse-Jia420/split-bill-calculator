"""Per-session exchange-rate management (v0.2.2 Sprint 2 T09).

Endpoints (mounted under /sessions/{session_id}/exchange-rates via the
sessions prefix; the dev proxy strips /api so the FE calls them as
``/api/sessions/{id}/exchange-rates``):

POST  /sessions/{id}/exchange-rates              Add a new (from, to) rate
GET   /sessions/{id}/exchange-rates              List every rate for the session
PATCH /sessions/{id}/exchange-rates/{rate_id}    Update the rate (snapshot_at bumped)
DELETE /sessions/{id}/exchange-rates/{rate_id}   Remove a rate (PRD: rate is
                                                  immutable in v0.2.2 \u2014 we
                                                  expose DELETE only so the FE
                                                  settings page can offer an
                                                  explicit delete button)

Auth model (aligned with the rest of the sessions router)
---------------------------------------------------------
- All endpoints go through ``get_session_member`` -- any session member
  can read or update exchange rates. PRD does not restrict editing to
  owner; later sprints may add a role gate when v0.2.3 introduces
  Frankfurter API integration.

Snapshot semantics (PRD \u00a73.7.5)
----------------------------------
The ``session_exchange_rates`` table is the AUTHORITATIVE live rate. A
bill captures its own ``exchange_rate_snapshot`` at record time (see
``bills.py`` \u2014 T10) and settlement ALWAYS uses the snapshot, never
the live rate, so historical bills stay stable when rates change.

Mutating an existing rate therefore only affects bills recorded AFTER
the mutation. The endpoint's ``set_by`` + ``snapshot_at`` columns let
the FE settings page render "last updated 3 hours ago by Jesse".

Validation
----------
- ``from_currency`` / ``to_currency`` MUST be in the session's
  ``currencies`` set -- otherwise 422 (we never create a rate for a
  currency the session is not tracking).
- ``rate`` must be > 0 (we bound it tighter to ``0.00000001`` to skip
  sub-cent noise).
- Both directions are auto-paired: when you POST
  ``{from:THB, to:CNY, rate:0.215}`` the system also writes
  ``{from:CNY, to:THB, rate:4.65116279}`` (1/0.215) so both directions
  are queryable without a second POST. Existing inverse rows are NOT
  overwritten (PATCH a rate to update both legs consistently).
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.session_isolation import get_session_member
from app.db.models.session_exchange_rates import SessionExchangeRate
from app.db.models.session_members import SessionMember
from app.db.models.sessions import Session as SessionModel
from app.api.sessions import SUPPORTED_CURRENCIES

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/sessions/{session_id}/exchange-rates",
    tags=["exchange-rates"],
)


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class CreateRateRequest(BaseModel):
    from_currency: str = Field(..., min_length=1, max_length=8)
    to_currency: str = Field(..., min_length=1, max_length=8)
    rate: Decimal = Field(..., gt=Decimal("0.00000001"))

    @field_validator("from_currency", "to_currency")
    @classmethod
    def _upper_currency(cls, v: str) -> str:
        code = v.strip().upper()
        if code not in SUPPORTED_CURRENCIES:
            raise ValueError(f"currency '{code}' is not in SUPPORTED_CURRENCIES")
        return code


class UpdateRateRequest(BaseModel):
    rate: Decimal = Field(..., gt=Decimal("0.00000001"))


class ExchangeRateOut(BaseModel):
    id: int
    session_id: int
    from_currency: str
    to_currency: str
    rate: str  # Decimal-as-string (v0.2.2 wire format)
    snapshot_at: str
    set_by: int | None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _iso(dt: datetime | None) -> str:
    if dt is None:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def _serialise(rate: SessionExchangeRate) -> dict:
    return {
        "id": rate.id,
        "session_id": rate.session_id,
        "from_currency": rate.from_currency,
        "to_currency": rate.to_currency,
        "rate": str(rate.rate),
        "snapshot_at": _iso(rate.snapshot_at),
        "set_by": rate.set_by,
    }


def _load_session_or_404(db: Session, session_id: int) -> SessionModel:
    row = db.query(SessionModel).filter(SessionModel.id == session_id).first()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "session not found"},
        )
    return row


def _validate_currency_in_session(
    code: str, currencies: list[str]
) -> None:
    if code not in currencies:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": "currency_not_in_session",
                "currency": code,
                "session_currencies": list(currencies),
            },
        )


# ---------------------------------------------------------------------------
# POST /sessions/{id}/exchange-rates
# ---------------------------------------------------------------------------


@router.post(
    "",
    response_model=list[ExchangeRateOut],
    status_code=status.HTTP_201_CREATED,
)
async def create_exchange_rate(
    payload: CreateRateRequest,
    sm: Annotated[SessionMember, Depends(get_session_member)],
    db: Annotated[Session, Depends(get_db)],
) -> list[dict]:
    """Create a new (from, to) exchange rate, auto-paired with the reciprocal.

    - 201: returns BOTH inserted rows (forward + reciprocal).
    - 401/403: not logged in / not a session member.
    - 404: session not found (only reachable when membership row points
      to a now-deleted session \u2014 FK cascade should make this impossible).
    - 409: a row already exists for this (from, to) pair. Use PATCH to
      update it.
    - 422: rate out of range, currency not supported, currency not in
      session currencies set.
    """
    session_row = _load_session_or_404(db, sm.session_id)
    currencies = list(session_row.currencies or ["CNY"])
    _validate_currency_in_session(payload.from_currency, currencies)
    _validate_currency_in_session(payload.to_currency, currencies)
    if payload.from_currency == payload.to_currency:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error": "from_currency == to_currency"},
        )

    forward = SessionExchangeRate(
        session_id=session_row.id,
        from_currency=payload.from_currency,
        to_currency=payload.to_currency,
        rate=Decimal(payload.rate).quantize(
            Decimal("0.00000001"), rounding=ROUND_HALF_UP
        ),
        set_by=sm.user_id,
    )
    db.add(forward)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "rate_already_exists",
                "from_currency": payload.from_currency,
                "to_currency": payload.to_currency,
            },
        )

    # Reciprocal. If the caller already inserted both legs in a
    # race we just skip the reciprocal (the unique constraint will
    # surface that as 409 on a duplicate POST, not here).
    reciprocal_value = (Decimal("1") / Decimal(payload.rate)).quantize(
        Decimal("0.00000001"), rounding=ROUND_HALF_UP
    )
    reciprocal = SessionExchangeRate(
        session_id=session_row.id,
        from_currency=payload.to_currency,
        to_currency=payload.from_currency,
        rate=reciprocal_value,
        set_by=sm.user_id,
    )
    db.add(reciprocal)
    try:
        db.flush()
    except IntegrityError:
        # Reciprocal already exists \u2014 just roll it back, keep forward.
        db.rollback()
        db.add(forward)  # forward was rolled back above; re-add
        db.commit()

    db.commit()
    db.refresh(forward)
    db.refresh(reciprocal)

    # Return only the rows we intended (idempotent output).
    rows = (
        db.query(SessionExchangeRate)
        .filter(
            SessionExchangeRate.session_id == session_row.id,
            SessionExchangeRate.from_currency.in_(
                [payload.from_currency, payload.to_currency]
            ),
            SessionExchangeRate.to_currency.in_(
                [payload.from_currency, payload.to_currency]
            ),
        )
        .order_by(SessionExchangeRate.from_currency.asc())
        .all()
    )
    return [_serialise(r) for r in rows]


# ---------------------------------------------------------------------------
# GET /sessions/{id}/exchange-rates
# ---------------------------------------------------------------------------


@router.get("", response_model=list[ExchangeRateOut])
async def list_exchange_rates(
    sm: Annotated[SessionMember, Depends(get_session_member)],
    db: Annotated[Session, Depends(get_db)],
) -> list[dict]:
    """Return every exchange rate for the session.

    200: list (possibly empty for single-currency sessions).
    401/403: standard.
    """
    rates = (
        db.query(SessionExchangeRate)
        .filter(SessionExchangeRate.session_id == sm.session_id)
        .order_by(
            SessionExchangeRate.from_currency.asc(),
            SessionExchangeRate.to_currency.asc(),
        )
        .all()
    )
    return [_serialise(r) for r in rates]


# ---------------------------------------------------------------------------
# PATCH /sessions/{id}/exchange-rates/{rate_id}
# ---------------------------------------------------------------------------


@router.patch(
    "/{rate_id}",
    response_model=list[ExchangeRateOut],
)
async def update_exchange_rate(
    payload: UpdateRateRequest,
    sm: Annotated[SessionMember, Depends(get_session_member)],
    db: Annotated[Session, Depends(get_db)],
    rate_id: int = Path(..., description="SessionExchangeRate.id"),
) -> list[dict]:
    """Update an existing rate's value; the reciprocal is auto-updated too.

    snapshot_at + set_by are refreshed; existing bills keep their
    snapshots so historical settlement doesn't shift (PRD \u00a73.7.5).
    """
    rate_row = (
        db.query(SessionExchangeRate)
        .filter(
            SessionExchangeRate.id == rate_id,
            SessionExchangeRate.session_id == sm.session_id,
        )
        .first()
    )
    if rate_row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "rate not found in this session"},
        )

    new_rate = Decimal(payload.rate).quantize(
        Decimal("0.00000001"), rounding=ROUND_HALF_UP
    )
    rate_row.rate = new_rate
    rate_row.set_by = sm.user_id
    rate_row.snapshot_at = datetime.now(timezone.utc)

    # Update reciprocal (other row pointing in the opposite direction).
    reciprocal_row = (
        db.query(SessionExchangeRate)
        .filter(
            SessionExchangeRate.session_id == sm.session_id,
            SessionExchangeRate.from_currency == rate_row.to_currency,
            SessionExchangeRate.to_currency == rate_row.from_currency,
        )
        .first()
    )
    if reciprocal_row is not None:
        reciprocal_rate = (Decimal("1") / new_rate).quantize(
            Decimal("0.00000001"), rounding=ROUND_HALF_UP
        )
        reciprocal_row.rate = reciprocal_rate
        reciprocal_row.set_by = sm.user_id
        reciprocal_row.snapshot_at = rate_row.snapshot_at

    db.commit()
    db.refresh(rate_row)

    return [
        _serialise(rate_row),
        *([_serialise(reciprocal_row)] if reciprocal_row else []),
    ]


# ---------------------------------------------------------------------------
# DELETE /sessions/{id}/exchange-rates/{rate_id}
# ---------------------------------------------------------------------------


@router.delete(
    "/{rate_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_exchange_rate(
    sm: Annotated[SessionMember, Depends(get_session_member)],
    db: Annotated[Session, Depends(get_db)],
    rate_id: int = Path(..., description="SessionExchangeRate.id"),
) -> None:
    """Remove a rate row (and its reciprocal) from the session.

    This is mostly a UI affordance for the Settings page; the FE
    rarely needs to delete rather than update. After deletion, any
    subsequent bill in the dropped currency will fail settlement
    with 422 \"missing_exchange_rate_snapshot\" until a new rate is
    written.

    204: rate + reciprocal removed.
    401/403: standard.
    404: rate row does not exist in this session.
    """
    rate_row = (
        db.query(SessionExchangeRate)
        .filter(
            SessionExchangeRate.id == rate_id,
            SessionExchangeRate.session_id == sm.session_id,
        )
        .first()
    )
    if rate_row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "rate not found in this session"},
        )

    from_cur, to_cur = rate_row.from_currency, rate_row.to_currency
    reciprocal = (
        db.query(SessionExchangeRate)
        .filter(
            SessionExchangeRate.session_id == sm.session_id,
            SessionExchangeRate.from_currency == to_cur,
            SessionExchangeRate.to_currency == from_cur,
        )
        .first()
    )

    db.delete(rate_row)
    if reciprocal is not None and reciprocal.id != rate_row.id:
        db.delete(reciprocal)
    db.commit()
    return None
