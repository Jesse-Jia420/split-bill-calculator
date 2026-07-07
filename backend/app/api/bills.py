"""Bills API — Sprint 1 T10 + T11.

Endpoints (mounted under /sessions/{session_id}/bills; the dev proxy
strips the /api prefix so the frontend calls them as
/api/sessions/{id}/bills/...):

POST   /sessions/{session_id}/bills/parse        T11 — AI-assist prefill
GET    /sessions/{session_id}/bills              List bills (member-only)
POST   /sessions/{session_id}/bills              Create a bill
PATCH  /sessions/{session_id}/bills/{bill_id}    Update a bill
DELETE /sessions/{session_id}/bills/{bill_id}    Delete a bill

Auth model (SPEC §5, v0.1.2 updated)
--------------------------------------
- Any session member can CREATE a bill (POST /bills).
- v0.1.2 (T17): any session member can also UPDATE and DELETE a bill
  (the v0.1.0 'creator-only' check is removed). The bill's `description`
  field remains immutable: PATCH bodies containing `description` (or
  any other unknown field) get rejected with 422 by `extra='forbid'`.
  `created_by` is still recorded on the bill for UI display ("recorded by X").
- GET requires membership (uses get_session_member dependency).

Derivation rules (PRD §3.1.2 + SPEC §3 "派生字段不入库")
-------------------------------------------------------
For each bill we compute the per-participant share on the fly:

    shared_pool     = amount - sum(exclusive_amount for p where is_exclusive)
    per_user_shared = shared_pool / len(participants)
    share_amount    = per_user_shared + (own_exclusive if is_exclusive else 0)

`share_amount` is included in every participant payload returned to the
frontend (computed, not stored). It is the "how much does this person
owe for this bill" number.

T11 /bills/parse contract
-------------------------
Body:    { "text": "<natural language expense description>" }
200:     { "amount": <num>, "payer_hint": <str>, "participants_hint": [<str>...], "description": <str> }
422:     { "detail": { "error": "ai_unavailable" } } — no key / API error / malformed JSON
The endpoint NEVER writes to the DB. The frontend fills the bill
form with the response, lets the user confirm, then POSTs /bills.

v0.2.2 (T07/T10) multi-currency
--------------------------------
Each session declares 1–2 active currencies in ``sessions.currencies``
and a ``primary_currency`` for settlement. Bills record their own
``currency`` (chosen from the session's allowed set) and snapshot the
relevant exchange rate into ``bills.exchange_rate_snapshot`` so later
rate changes never retroactively re-convert historical bills.

POST /bills rules
  * ``payload.currency`` MUST be in ``session.currencies`` (422 otherwise).
  * When ``currency == session.primary_currency`` → ``exchange_rate_snapshot = NULL``.
  * When ``currency != session.primary_currency`` → look up the rate from
    ``session_exchange_rates`` (from=currency, to=primary_currency);
    if missing → 422 ``missing_exchange_rate``. Otherwise snapshot it.

PATCH /bills rules
  * ``payload.currency`` (when supplied) gets the same currency-must-be-in-session
    validation as POST. When the currency actually CHANGES, we refresh the
    snapshot to the current rate for the new (currency → primary) pair.
    When the currency is unchanged, we LEAVE the original snapshot
    untouched (snapshot mode is one-way: once recorded, the rate stays).
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from decimal import Decimal
from typing import Annotated, Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Path, status
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.session_isolation import get_session_member, get_session_member_or_secret
from app.db.models.bill_participants import BillParticipant
from app.db.models.bills import Bill, BillStatus
from app.db.models.session_exchange_rates import SessionExchangeRate
from app.db.models.sessions import Session as SessionModel
from app.db.models.session_members import SessionMember
from app.services.calculator import AmountCalculator

logger = logging.getLogger(__name__)

router = APIRouter(tags=["bills"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class ParticipantIn(BaseModel):
    member_id: int = Field(..., description="SessionMember.id")
    is_exclusive: bool = Field(default=False)
    exclusive_amount: float = Field(default=0.0, ge=0)

    @field_validator("exclusive_amount")
    @classmethod
    def _consistent(cls, v: float, info: Any) -> float:
        is_exclusive = info.data.get("is_exclusive", False)
        if is_exclusive and v <= 0:
            raise ValueError("exclusive_amount must be > 0 when is_exclusive is true")
        if not is_exclusive and v != 0:
            raise ValueError("exclusive_amount must be 0 when is_exclusive is false")
        return v


class CreateBillRequest(BaseModel):
    amount: float = Field(..., gt=0, description="Total bill amount (> 0).")
    payer_member_id: int = Field(..., description="SessionMember.id of the payer.")
    description: str | None = Field(default=None, max_length=500)
    occurred_at: datetime = Field(..., description="ISO 8601 datetime of the expense.")
    currency: str = Field(default="CNY", min_length=1, max_length=8)
    participants: list[ParticipantIn] = Field(..., min_length=1)

    # v0.2.1 T01 (PRD §3.6.1): raw calculator expression echoed back. The
    # server re-evaluates it via AmountCalculator and overwrites ``amount``
    # with the quantised result; the original expression is stored alongside
    # so the edit page can repopulate the calculator field verbatim.
    amount_expression: str | None = Field(default=None, max_length=64)
    # When True, ``amount_expression`` is evaluated and applied. When False
    # (or unset), ``amount_expression`` is treated as informational only and
    # ``amount`` is used as-is. Defaults to False for backward compatibility
    # with v0.1.* callers that never sent an expression.
    use_calculator: bool = Field(default=False)

    @field_validator("currency")
    @classmethod
    def _strip_currency(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("currency must not be blank")
        return v.upper()

    @field_validator("amount_expression")
    @classmethod
    def _check_amount_expression(cls, v: str | None) -> str | None:
        if v is None or v.strip() == "":
            return None
        # Whitelist enforcement. Calculator may still raise ValueError on
        # things like consecutive operators (covered by the evaluate call
        # in the endpoint).
        import re as _re
        if _re.search(r"[^0-9+\-*/.\s]", v):
            raise ValueError(
                "amount_expression contains characters outside the whitelist "
                r"[0-9+\-*/.\s]"
            )
        return v


class UpdateBillRequest(BaseModel):
    """T17 (v0.1.2): any session member can update a bill.

    - `description` is intentionally NOT exposed: once a bill is recorded,
      its description is immutable (PO 2026-06-30 B②i). PATCHes that
      include `description` (or any other unknown field) get rejected
      with 422 by `extra='forbid'`.
    - `created_by` is still returned by the API (for UI display of who
      recorded the bill) but is **not** used as a permission gate.

    v0.2.1 T01: ``amount_expression`` is an optional override of the
    calculator expression. When ``use_calculator=True``, the server
    re-evaluates the expression and replaces the stored ``amount`` with
    the quantised result; when ``use_calculator=False`` (or the field is
    absent) the expression is echoed back verbatim and ``amount`` is
    taken as-is. Validation rejects malformed expressions with 422
    (Pydantic field_validator).

    v0.3.1 (TEST-006 bug fix): ``use_calculator`` is now part of
    UpdateBillRequest. Previously, BillForm's `buildPayload` always sent
    `use_calculator` (truthy whenever amount_expression was non-empty),
    and PATCH silently 422'd the whole body because `extra='forbid'`.
    Now the FE flag flows through Pydantic unchanged.
    """

    model_config = ConfigDict(extra="forbid")

    amount: float | None = Field(default=None, gt=0)
    payer_member_id: int | None = None
    occurred_at: datetime | None = None
    currency: str | None = Field(default=None, min_length=1, max_length=8)
    participants: list[ParticipantIn] | None = Field(default=None, min_length=1)
    amount_expression: str | None = Field(default=None, max_length=64)
    use_calculator: bool | None = Field(default=None)

    @field_validator("amount_expression")
    @classmethod
    def _check_amount_expression(cls, v: str | None) -> str | None:
        if v is None or v.strip() == "":
            return None
        import re as _re
        if _re.search(r"[^0-9+\-*/.\s]", v):
            raise ValueError(
                "amount_expression contains characters outside the whitelist "
                r"[0-9+\-*/.\s]"
            )
        return v

    @field_validator("currency")
    @classmethod
    def _strip_currency(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if not v:
            raise ValueError("currency must not be blank")
        return v.upper()


class ParticipantOut(BaseModel):
    member_id: int
    is_exclusive: bool
    exclusive_amount: float
    share_amount: float


class BillOut(BaseModel):
    id: int
    session_id: int
    payer_id: int
    amount: float
    currency: str
    description: str | None
    occurred_at: str
    created_by: int | None  # v0.3.1: NULL for anonymous bill creators
    created_at: str
    status: str
    participants: list[ParticipantOut]
    # v0.2.1 T01: original calculator expression, or NULL for bills
    # recorded before v0.2.1 (or with use_calculator=False).
    amount_expression: str | None = None
    # v0.2.2 (T10): rate snapshot (NULL when bill.currency ==
    # session.primary_currency). Decimal-as-string for lossless wire.
    exchange_rate_snapshot: str | None = None


# T11 schemas --------------------------------------------------------------


class ParseBillRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)


class ParseBillResponse(BaseModel):
    amount: float
    payer_hint: str
    participants_hint: list[str]
    description: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _iso(dt: datetime | None) -> str:
    """Serialise a (possibly naive) datetime as an ISO 8601 string.

    SQLite strips tzinfo on DateTime(timezone=True) roundtrip. We always
    insert tz-aware UTC values, so a naive value still represents UTC
    -- annotate it that way so the serialised ISO string is correct.
    """
    if dt is None:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def _compute_share_amounts(amount: float, parts: list[ParticipantIn]) -> list[float]:
    """Apply PRD §3.1.2 derivation. Pure function -- easy to unit-test.

    v0.2.2 (T07/T11): ``amount`` may be Decimal at runtime (bills.amount
    is Numeric(12, 2)). Float callers still work because Decimal coerces
    transparently in arithmetic. The result is rounded to cents at the
    end so the JSON output matches the BE's intended display precision.
    """
    from decimal import Decimal, ROUND_HALF_UP

    if not parts:
        return []
    # Coerce to Decimal for the intermediate math so we don't accumulate
    # IEEE-754 noise across participants. Quantize only at the end.
    amt = amount if isinstance(amount, Decimal) else Decimal(str(amount))
    exclusive_total = Decimal("0")
    for p in parts:
        if p.is_exclusive:
            exclusive_total += Decimal(str(p.exclusive_amount))
    shared_pool = amt - exclusive_total
    per_user_shared = shared_pool / len(parts)
    out: list[float] = []
    for p in parts:
        own = Decimal(str(p.exclusive_amount)) if p.is_exclusive else Decimal("0")
        share = per_user_shared + own
        share_q = share.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        out.append(float(share_q))
    return out


def _session_member_ids(db: Session, session_id: int) -> set[int]:
    """Return the set of SessionMember.id belonging to this session."""
    rows = (
        db.query(SessionMember.id)
        .filter(SessionMember.session_id == session_id)
        .all()
    )
    return {mid for (mid,) in rows}


def _validate_participants(
    db: Session,
    session_id: int,
    payer_member_id: int,
    participants: list[ParticipantIn],
) -> None:
    """Cross-check participant membership + duplicates.

    Raises HTTPException(400) on any violation. Centralised so POST
    and PATCH share the same rules.
    """
    member_ids = _session_member_ids(db, session_id)
    if payer_member_id not in member_ids:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "payer_member_id is not a session member"},
        )

    seen: set[int] = set()
    for p in participants:
        if p.member_id not in member_ids:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"error": f"participant member_id={p.member_id} is not a session member"},
            )
        if p.member_id in seen:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"error": f"duplicate participant member_id={p.member_id}"},
            )
        seen.add(p.member_id)


def _validate_calculator_expression(expression: str | None) -> Decimal | None:
    """Validate + evaluate a calculator expression. Returns Decimal or None.

    ``None`` input → ``None`` output (legacy callers that don't use the
    calculator). Any failure mode → ``ValueError`` with a human-readable
    reason that the endpoint turns into 422.
    """
    if expression is None or expression.strip() == "":
        return None
    try:
        # ``evaluate`` re-checks the whitelist internally, but the
        # pydantic validator already enforced it on entry so the only
        # remaining failure mode is structural (operator order, division
        # by zero, malformed literal).
        result = AmountCalculator.evaluate(expression)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error": "invalid_amount_expression", "reason": str(e)},
        ) from e
    # Decimal → float for the NUMERIC-less amount column. Float is OK
    # here because the source value is already quantised to two decimal
    # places by AmountCalculator (so no compounding error).
    return result


def _resolve_exchange_rate_snapshot(
    db: Session,
    session_id: int,
    bill_currency: str,
) -> Decimal | None:
    """Return the rate to apply when the bill is in ``bill_currency``.

    Behaviour (PRD §3.7.5, T10):
    - Look up the session so we can compare to ``primary_currency``.
    - If ``bill_currency == primary_currency`` → return ``None``
      (no conversion needed; settlement will use the amount directly).
    - Otherwise look up the row in ``session_exchange_rates`` with
      ``from_currency = bill_currency`` and ``to_currency = primary_currency``.
      If no row exists, raise ``HTTPException(422)`` so the FE can prompt
      the user to set the rate first.
    - The returned ``Decimal`` is the exact value the bill will store in
      ``exchange_rate_snapshot`` -- no quantisation happens here (the
      stored precision is 8dp via the column type).

    v0.2.2 (T10) — called by create_bill AND update_bill.
    """
    session_row = db.query(SessionModel).filter(SessionModel.id == session_id).first()
    if session_row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "session not found"},
        )

    primary = session_row.primary_currency or "CNY"
    if bill_currency == primary:
        return None  # primary currency → no snapshot needed

    rate_row = (
        db.query(SessionExchangeRate)
        .filter(
            SessionExchangeRate.session_id == session_id,
            SessionExchangeRate.from_currency == bill_currency,
            SessionExchangeRate.to_currency == primary,
        )
        .first()
    )
    if rate_row is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": "missing_exchange_rate",
                "currency": bill_currency,
                "primary_currency": primary,
                "hint": (
                    "no rate is recorded for "
                    f"{bill_currency} → {primary} on this session"
                ),
            },
        )
    return Decimal(rate_row.rate)


def _check_exclusive_total(amount: float | Decimal, participants: list[ParticipantIn]) -> None:
    """Sum exclusive_amount must not exceed amount.

    v0.2.2 (T07): ``bill.amount`` is now ``Numeric(12, 2)`` → ``Decimal`` on
    read. We coerce both sides to ``Decimal`` so the comparison works for
    either caller. Tolerance ``1e-9`` keeps the legacy float-input callers
    green while letting Decimal callers do exact comparisons.
    """
    amt = amount if isinstance(amount, Decimal) else Decimal(str(amount))
    exclusive_total = Decimal("0")
    for p in participants:
        if p.is_exclusive:
            exclusive_total += Decimal(str(p.exclusive_amount))
    if exclusive_total > amt + Decimal("1e-9"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "sum of exclusive_amount exceeds bill amount"},
        )


def _bill_to_dict(bill: Bill, participants: list[BillParticipant]) -> dict:
    """Serialise a Bill row + its participants for the response.

    `share_amount` is computed here, NOT stored on the row (SPEC §3
    "派生字段不入库").

    v0.2.2 (T10): ``exchange_rate_snapshot`` is Decimal-as-string when
    present, NULL when the bill is in primary currency.
    """
    parts_in = [
        ParticipantIn(
            member_id=p.member_id,
            is_exclusive=p.is_exclusive,
            exclusive_amount=p.exclusive_amount,
        )
        for p in participants
    ]
    share_amounts = _compute_share_amounts(bill.amount, parts_in)
    return {
        "id": bill.id,
        "session_id": bill.session_id,
        "payer_id": bill.payer_id,
        "amount": bill.amount,
        "currency": bill.currency,
        "description": bill.description,
        "occurred_at": _iso(bill.occurred_at),
        "created_by": bill.created_by,
        "created_at": _iso(bill.created_at),
        "status": bill.status,
        # v0.2.1 T01: echo the raw expression so the edit page can
        # repopulate the calculator field verbatim.
        "amount_expression": bill.amount_expression,
        # v0.2.2 (T10): snapshot of the rate used at record-time so
        # settlement can replay historical conversion.
        "exchange_rate_snapshot": (
            str(bill.exchange_rate_snapshot)
            if bill.exchange_rate_snapshot is not None
            else None
        ),
        "participants": [
            {
                "member_id": p.member_id,
                "is_exclusive": p.is_exclusive,
                "exclusive_amount": p.exclusive_amount,
                "share_amount": share_amounts[i],
            }
            for i, p in enumerate(participants)
        ],
    }


# ---------------------------------------------------------------------------
# T11 -- POST /sessions/{session_id}/bills/parse  (must be declared BEFORE
#        the generic /{bill_id} routes so FastAPI doesn't try to bind
#        bill_id="parse" -- FastAPI matches routes in declaration order.)
# ---------------------------------------------------------------------------


def _build_minimax_prompt(text: str, member_names: list[str]) -> str:
    """Construct the chat-completion prompt for /bills/parse.

    Strict JSON contract -- see SPEC §6. We instruct the model to
    return ONLY the JSON object (no markdown fence, no prose).
    """
    members_block = ", ".join(member_names) if member_names else "(no other members)"
    return (
        "You are a structured-information extractor for a bill-splitting app.\n"
        "Given a free-text expense description in Chinese or English and the list of\n"
        "session members, return a single JSON object with EXACTLY these fields:\n"
        '  "amount": <positive number, total bill amount>,\n'
        '  "payer_hint": <string -- either "self" (the writer paid) OR the exact\n'
        "                   display_name of the payer from the member list>,\n"
        '  "participants_hint": [<list of strings -- either ["all"] for everyone\n'
        "                        shared equally, or a list of member display_names\n"
        "                        from the list below>],\n"
        '  "description": <short string, <= 60 chars>.\n'
        "\n"
        f"Session members (display names): {members_block}\n"
        "\n"
        f'Free-text description: "{text}"\n'
        "\n"
        "Return ONLY the JSON object on a single line. No markdown, no commentary,\n"
        "no code fence. If you cannot extract a positive amount, return\n"
        '{"amount": 0, "payer_hint": "self", "participants_hint": ["all"], "description": ""}.\n'
    )


async def _call_minimax_api(text: str, member_names: list[str]) -> dict:
    """Call the MiniMax chat-completion API and return the parsed JSON dict.

    Raises ValueError("ai_unavailable") for ANY failure mode the test
    suite recognises (no key, HTTP error, malformed JSON, schema drift).
    Centralised so tests can monkeypatch exactly this function.
    """
    if not settings.minimax_api_key:
        raise ValueError("ai_unavailable")

    url = f"{settings.minimax_api_base.rstrip('/')}/v1/text/chatcompletion_v2"
    headers = {
        "Authorization": f"Bearer {settings.minimax_api_key}",
        "Content-Type": "application/json",
    }
    body = {
        "model": settings.minimax_model,
        "messages": [
            {"role": "system", "content": "You are a JSON-only structured extractor."},
            {"role": "user", "content": _build_minimax_prompt(text, member_names)},
        ],
        "temperature": 0.1,
        "max_tokens": 256,
        "response_format": {"type": "json_object"},
    }

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(url, json=body, headers=headers)
        if resp.status_code != 200:
            logger.warning("MiniMax returned %s: %s", resp.status_code, resp.text[:200])
            raise ValueError("ai_unavailable")
        data = resp.json()
    except (httpx.HTTPError, ValueError, json.JSONDecodeError) as e:
        logger.warning("MiniMax call failed: %s", e)
        raise ValueError("ai_unavailable")

    # MiniMax response mirrors OpenAI: choices[0].message.content is a JSON string.
    try:
        content = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise ValueError("ai_unavailable")

    content = content.strip()
    if content.startswith("```"):
        # strip ```json ... ```
        content = content.strip("`")
        if content.lower().startswith("json"):
            content = content[4:]
        content = content.strip()

    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        raise ValueError("ai_unavailable")

    if not isinstance(parsed, dict):
        raise ValueError("ai_unavailable")
    for key in ("amount", "payer_hint", "participants_hint", "description"):
        if key not in parsed:
            raise ValueError("ai_unavailable")
    if not isinstance(parsed["amount"], (int, float)) or parsed["amount"] <= 0:
        raise ValueError("ai_unavailable")
    if not isinstance(parsed["payer_hint"], str):
        raise ValueError("ai_unavailable")
    if not isinstance(parsed["participants_hint"], list):
        raise ValueError("ai_unavailable")
    if not all(isinstance(x, str) for x in parsed["participants_hint"]):
        raise ValueError("ai_unavailable")
    if not isinstance(parsed["description"], str):
        raise ValueError("ai_unavailable")

    return {
        "amount": float(parsed["amount"]),
        "payer_hint": parsed["payer_hint"],
        "participants_hint": list(parsed["participants_hint"]),
        "description": parsed["description"],
    }


@router.post(
    "/sessions/{session_id}/bills/parse",
    response_model=ParseBillResponse,
)
async def parse_bill(
    payload: ParseBillRequest,
    sm: Annotated[SessionMember, Depends(get_session_member)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """AI-assisted bill prefill (T11).

    Caller must be a session member (so we can pass the member list to
    the LLM for disambiguation). The endpoint NEVER writes to the DB.

    200: parsed JSON shape returned (frontend fills the form).
    401: no/invalid cookie.
    403: not a session member.
    422: missing text / ai_unavailable / schema violation.
    """
    # Build the member display-name list (deterministic ordering for the prompt).
    members = (
        db.query(SessionMember)
        .filter(SessionMember.session_id == sm.session_id)
        .order_by(SessionMember.joined_at.asc())
        .all()
    )
    member_names = [m.display_name for m in members]

    try:
        return await _call_minimax_api(payload.text, member_names)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error": "ai_unavailable"},
        )


# ---------------------------------------------------------------------------
# GET /sessions/{session_id}/bills
# ---------------------------------------------------------------------------


@router.get("/sessions/{session_id}/bills", response_model=list[BillOut])
async def list_bills(
    sm: Annotated[SessionMember, Depends(get_session_member_or_secret)],
    db: Annotated[Session, Depends(get_db)],
) -> list[dict]:
    """Return every bill in the session, newest first.

    200: list of bills with computed per-participant share_amount.
    401: no/invalid cookie.
    403: not a session member.
    """
    bills = (
        db.query(Bill)
        .filter(Bill.session_id == sm.session_id)
        .order_by(Bill.occurred_at.desc(), Bill.id.desc())
        .all()
    )
    out: list[dict] = []
    for bill in bills:
        participants = (
            db.query(BillParticipant)
            .filter(BillParticipant.bill_id == bill.id)
            .order_by(BillParticipant.id.asc())
            .all()
        )
        out.append(_bill_to_dict(bill, participants))
    return out


# ---------------------------------------------------------------------------
# POST /sessions/{session_id}/bills
# ---------------------------------------------------------------------------


@router.post(
    "/sessions/{session_id}/bills",
    response_model=BillOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_bill(
    payload: CreateBillRequest,
    sm: Annotated[SessionMember, Depends(get_session_member_or_secret)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Create a bill in the session.

    Any session member may create (SPEC §5: 'session 内任何成员可加').
    v0.3.1: anonymous members can create via X-Nickname-Secret header.

    201: bill persisted with computed share_amounts returned.
    400: invalid participant / amount / exclusive total.
    401: no/invalid cookie.
    403: not a session member.
    422: missing/over-long/invalid fields (pydantic).
    """
    _validate_participants(db, sm.session_id, payload.payer_member_id, payload.participants)

    # v0.2.2 (T10): bill.currency must be in the session's allowed set,
    # otherwise 422 (we never accept a currency the session can't
    # settle). Capture the snapshot at the same time.
    session_row = db.query(SessionModel).filter(SessionModel.id == sm.session_id).first()
    if session_row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "session not found"},
        )
    allowed_currencies = list(session_row.currencies or ["CNY"])
    if payload.currency not in allowed_currencies:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": "currency_not_in_session",
                "currency": payload.currency,
                "session_currencies": allowed_currencies,
            },
        )
    rate_snapshot = _resolve_exchange_rate_snapshot(
        db, sm.session_id, payload.currency
    )

    # v0.2.1 T01: when use_calculator=True we treat amount_expression as
    # the authoritative source and overwrite amount with the Decimal
    # evaluation. Any failure → 422 inside _validate_calculator_expression.
    effective_amount = float(payload.amount)
    stored_expression: str | None = None
    if payload.use_calculator:
        evaluated = _validate_calculator_expression(payload.amount_expression)
        if evaluated is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={"error": "use_calculator is true but amount_expression is empty"},
            )
        effective_amount = float(evaluated)
        stored_expression = payload.amount_expression

    _check_exclusive_total(effective_amount, payload.participants)

    bill = Bill(
        session_id=sm.session_id,
        payer_id=payload.payer_member_id,
        amount=effective_amount,
        currency=payload.currency,
        description=payload.description,
        occurred_at=payload.occurred_at,
        created_by=sm.user_id,
        status=BillStatus.DRAFT.value,
        # v0.2.1 T01: store raw expression only when it came from the calculator.
        amount_expression=stored_expression,
        # v0.2.2 (T10): snapshot of the rate used at record-time so
        # settlement can replay historical conversion. NULL when the bill
        # is already in the session's primary currency (no conversion
        # needed).
        exchange_rate_snapshot=rate_snapshot,
    )
    db.add(bill)
    try:
        db.flush()
    except Exception as e:  # pragma: no cover -- defensive
        db.rollback()
        logger.exception("Failed to insert bill: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"error": "could not create bill"},
        )

    for p in payload.participants:
        db.add(
            BillParticipant(
                bill_id=bill.id,
                member_id=p.member_id,
                is_exclusive=p.is_exclusive,
                exclusive_amount=p.exclusive_amount,
            )
        )

    db.commit()
    db.refresh(bill)

    participants = (
        db.query(BillParticipant)
        .filter(BillParticipant.bill_id == bill.id)
        .order_by(BillParticipant.id.asc())
        .all()
    )
    return _bill_to_dict(bill, participants)


# ---------------------------------------------------------------------------
# PATCH /sessions/{session_id}/bills/{bill_id}
# ---------------------------------------------------------------------------


@router.patch(
    "/sessions/{session_id}/bills/{bill_id}",
    response_model=BillOut,
)
async def update_bill(
    payload: UpdateBillRequest,
    sm: Annotated[SessionMember, Depends(get_session_member)],
    db: Annotated[Session, Depends(get_db)],
    bill_id: int = Path(..., description="Bill.id"),
) -> dict:
    """Update a bill. Any session member may modify (SPEC §5, v0.1.2).

    v0.1.2: relaxed from 'creator-only' to 'any member' to support
    group editing -- e.g. someone who wasn't around when the bill
    was recorded can fix the amount / payer / participants on the
    group's behalf. The bill's `description` is immutable (PO
    2026-06-30 B②i): once a description is committed it is
    treated as historical fact. The schema rejects PATCH bodies
    containing `description` with 422 via `extra='forbid'`.

    v0.1 status defaults to 'draft', so the 'session not locked' check
    is implicitly satisfied (no lock endpoint exists in v0.1 yet).
    When v0.2 adds a lock endpoint, add `bill.status != BillStatus.LOCKED.value`
    to the guard here.

    200: bill updated.
    400: invalid participant / amount / exclusive total.
    401: no/invalid cookie.
    403: caller is not a session member.
    404: bill not found in this session.
    422: missing/over-long/invalid fields OR `description`/unknown field
         (pydantic extra='forbid').
    """
    bill = (
        db.query(Bill)
        .filter(Bill.id == bill_id, Bill.session_id == sm.session_id)
        .first()
    )
    if bill is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "bill not found"},
        )

    # v0.1.2 (T17): removed creator check -- any session member can update.

    # Apply scalar updates first (any of these may be None).
    # v0.2.1 T01 + v0.3.1 (TEST-006 fix): when amount_expression arrives
    # in a PATCH AND use_calculator is truthy, the expression is the
    # authoritative source for ``amount``. Without use_calculator the
    # expression is informational only (mirrors CreateBillRequest
    # semantics) and we fall back to the explicit ``amount`` field.
    if (
        payload.amount_expression is not None
        and payload.use_calculator is True
    ):
        evaluated = _validate_calculator_expression(payload.amount_expression)
        if evaluated is not None:
            bill.amount = float(evaluated)
            bill.amount_expression = payload.amount_expression
    elif payload.amount is not None:
        bill.amount = payload.amount
    if payload.payer_member_id is not None:
        bill.payer_id = payload.payer_member_id
    # v0.1.2 (T17): description is no longer mutable. The schema rejects
    # PATCH bodies containing `description` with 422 via `extra='forbid'`,
    # so we don't need to skip updating it here -- it's already filtered.
    if payload.occurred_at is not None:
        bill.occurred_at = payload.occurred_at
    if payload.currency is not None:
        # v0.2.2 (T10): currency must be in the session's allowed set,
        # and on a real change we refresh the snapshot too.
        session_row = db.query(SessionModel).filter(SessionModel.id == sm.session_id).first()
        if session_row is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail={"error": "session not found"},
            )
        allowed_currencies = list(session_row.currencies or ["CNY"])
        if payload.currency not in allowed_currencies:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={
                    "error": "currency_not_in_session",
                    "currency": payload.currency,
                    "session_currencies": allowed_currencies,
                },
            )
        if payload.currency != bill.currency:
            # Currency actually changed — refresh the snapshot from the
            # current rates. If the user changes a primary-currency bill
            # to a foreign currency without setting a rate first, we 422.
            bill.currency = payload.currency
            bill.exchange_rate_snapshot = _resolve_exchange_rate_snapshot(
                db, sm.session_id, payload.currency
            )
        else:
            bill.currency = payload.currency

    # If participants were sent, replace wholesale.
    if payload.participants is not None:
        effective_payer = (
            payload.payer_member_id if payload.payer_member_id is not None else bill.payer_id
        )
        _validate_participants(db, sm.session_id, effective_payer, payload.participants)
        _check_exclusive_total(bill.amount, payload.participants)

        existing = (
            db.query(BillParticipant)
            .filter(BillParticipant.bill_id == bill.id)
            .all()
        )
        for old in existing:
            db.delete(old)
        db.flush()
        for p in payload.participants:
            db.add(
                BillParticipant(
                    bill_id=bill.id,
                    member_id=p.member_id,
                    is_exclusive=p.is_exclusive,
                    exclusive_amount=p.exclusive_amount,
                )
            )
    else:
        # No participant change, but the existing rows should still satisfy any
        # new amount constraint the caller applied. Re-check exclusive total.
        existing = (
            db.query(BillParticipant)
            .filter(BillParticipant.bill_id == bill.id)
            .all()
        )
        existing_inputs = [
            ParticipantIn(
                member_id=p.member_id,
                is_exclusive=p.is_exclusive,
                exclusive_amount=p.exclusive_amount,
            )
            for p in existing
        ]
        _check_exclusive_total(bill.amount, existing_inputs)
        if payload.payer_member_id is not None:
            _validate_participants(db, sm.session_id, payload.payer_member_id, existing_inputs)

    db.commit()
    db.refresh(bill)

    participants = (
        db.query(BillParticipant)
        .filter(BillParticipant.bill_id == bill.id)
        .order_by(BillParticipant.id.asc())
        .all()
    )
    return _bill_to_dict(bill, participants)


# ---------------------------------------------------------------------------
# DELETE /sessions/{session_id}/bills/{bill_id}
# ---------------------------------------------------------------------------


@router.delete(
    "/sessions/{session_id}/bills/{bill_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_bill(
    sm: Annotated[SessionMember, Depends(get_session_member)],
    db: Annotated[Session, Depends(get_db)],
    bill_id: int = Path(..., description="Bill.id"),
) -> None:
    """Delete a bill. Any session member may delete (SPEC §5, v0.1.2).

    204: bill deleted (participants cascade).
    401: no/invalid cookie.
    403: caller is not a session member.
    404: bill not found in this session.
    """
    bill = (
        db.query(Bill)
        .filter(Bill.id == bill_id, Bill.session_id == sm.session_id)
        .first()
    )
    if bill is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "bill not found"},
        )
    # v0.1.2 (T17): removed creator check -- any session member can delete.
    db.delete(bill)
    db.commit()
    return None