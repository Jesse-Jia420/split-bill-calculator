"""Bills API — Sprint 1 T10 + T11.

Endpoints (mounted under /sessions/{session_id}/bills; the dev proxy
strips the /api prefix so the frontend calls them as
/api/sessions/{id}/bills/...):

POST   /sessions/{session_id}/bills/parse        T11 — AI-assist prefill
GET    /sessions/{session_id}/bills              List bills (member-only)
POST   /sessions/{session_id}/bills              Create a bill
PATCH  /sessions/{session_id}/bills/{bill_id}    Update a bill
DELETE /sessions/{session_id}/bills/{bill_id}    Delete a bill

Auth model (SPEC §5)
--------------------
- Any session member can CREATE a bill (POST /bills).
- Only the bill creator (bill.created_by == caller's user.id) can
  UPDATE or DELETE; the session's bills are *not* locked yet (v0.1
  status defaults to 'draft'), so the only gate is "you created it".
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
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Annotated, Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Path, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_db
from app.core.session_isolation import get_session_member
from app.db.models.bill_participants import BillParticipant
from app.db.models.bills import Bill, BillStatus
from app.db.models.session_members import SessionMember

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

    @field_validator("currency")
    @classmethod
    def _strip_currency(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("currency must not be blank")
        return v.upper()


class UpdateBillRequest(BaseModel):
    amount: float | None = Field(default=None, gt=0)
    payer_member_id: int | None = None
    description: str | None = Field(default=None, max_length=500)
    occurred_at: datetime | None = None
    currency: str | None = Field(default=None, min_length=1, max_length=8)
    participants: list[ParticipantIn] | None = Field(default=None, min_length=1)

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
    created_by: int
    created_at: str
    status: str
    participants: list[ParticipantOut]


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
    """Apply PRD §3.1.2 derivation. Pure function -- easy to unit-test."""
    if not parts:
        return []
    exclusive_total = sum(p.exclusive_amount for p in parts if p.is_exclusive)
    shared_pool = amount - exclusive_total
    per_user_shared = shared_pool / len(parts)
    out: list[float] = []
    for p in parts:
        out.append(per_user_shared + (p.exclusive_amount if p.is_exclusive else 0.0))
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


def _check_exclusive_total(amount: float, participants: list[ParticipantIn]) -> None:
    """Sum exclusive_amount must not exceed amount."""
    exclusive_total = sum(p.exclusive_amount for p in participants if p.is_exclusive)
    if exclusive_total > amount + 1e-9:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "sum of exclusive_amount exceeds bill amount"},
        )


def _bill_to_dict(bill: Bill, participants: list[BillParticipant]) -> dict:
    """Serialise a Bill row + its participants for the response.

    `share_amount` is computed here, NOT stored on the row (SPEC §3
    "派生字段不入库").
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
    sm: Annotated[SessionMember, Depends(get_session_member)],
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
    sm: Annotated[SessionMember, Depends(get_session_member)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Create a bill in the session.

    Any session member may create (SPEC §5: 'session 内任何成员可加').

    201: bill persisted with computed share_amounts returned.
    400: invalid participant / amount / exclusive total.
    401: no/invalid cookie.
    403: not a session member.
    422: missing/over-long/invalid fields (pydantic).
    """
    _validate_participants(db, sm.session_id, payload.payer_member_id, payload.participants)
    _check_exclusive_total(payload.amount, payload.participants)

    bill = Bill(
        session_id=sm.session_id,
        payer_id=payload.payer_member_id,
        amount=payload.amount,
        currency=payload.currency,
        description=payload.description,
        occurred_at=payload.occurred_at,
        created_by=sm.user_id,
        status=BillStatus.DRAFT.value,
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
    """Update a bill. Only the bill's creator may modify (SPEC §5).

    v0.1 status defaults to 'draft', so the 'session not locked' check
    is implicitly satisfied (no lock endpoint exists in v0.1 yet).
    When v0.2 adds a lock endpoint, add `bill.status != BillStatus.LOCKED.value`
    to the guard here.

    200: bill updated.
    400: invalid participant / amount / exclusive total.
    401: no/invalid cookie.
    403: caller is not a session member OR did not create this bill.
    404: bill not found in this session.
    422: missing/over-long/invalid fields (pydantic).
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

    if bill.created_by != sm.user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error": "only the bill creator can modify it"},
        )

    # Apply scalar updates first (any of these may be None).
    if payload.amount is not None:
        bill.amount = payload.amount
    if payload.payer_member_id is not None:
        bill.payer_id = payload.payer_member_id
    if payload.description is not None:
        bill.description = payload.description
    if payload.occurred_at is not None:
        bill.occurred_at = payload.occurred_at
    if payload.currency is not None:
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
    """Delete a bill. Only the bill's creator may delete (SPEC §5).

    204: bill deleted (participants cascade).
    401: no/invalid cookie.
    403: caller is not a session member OR did not create this bill.
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
    if bill.created_by != sm.user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error": "only the bill creator can delete it"},
        )
    db.delete(bill)
    db.commit()
    return None