"""Settle API — Sprint 1 T12, v0.1.2 extension (T18).

Endpoint (mounted under /sessions/{session_id}/settle; the dev proxy
strips the /api prefix):

GET /sessions/{session_id}/settle

Returns the per-member net balance (positive = owed money, negative =
owes money) and a list of suggested transfers that zero everyone's
balance. v0.1.2 (T18) also returns a per-member breakdown for the
frontend 'personal view' tab (see `per_member` field below).

Auth model
----------
- Any session member may request settle (uses get_session_member).
- The endpoint is read-only against `bills` and writes a single
  `settlements` row as a snapshot (v0.1 keeps it simple — every call
  re-generates a fresh row; we don't expose historical comparison).

Algorithm (SPEC §7 + PRD §3.5)
------------------------------
1. Aggregate paid amounts per member:
     paid[member] = sum(bill.amount for bill in bills where bill.payer_id == member)
2. Aggregate consumed amounts per member using the same per_user_total
   formula as the bills API (PRD §3.1.2):
     shared_pool = bill.amount - sum(exclusive_amount for p in ppts)
     per_user_shared = shared_pool / len(ppts)
     consumed[member] = sum(per_user_shared + (own_exclusive if any))
3. net[member] = paid[member] - consumed[member]
   (positive net = others owe them; negative net = they owe others)
4. Greedy pair the largest creditor with the largest debtor until
   everyone hits zero. Transfer amount = min(|creditor|, |debtor|).

Floating point caveat
---------------------
SQLite REAL stores IEEE-754 doubles; we round to 2 decimal places when
serialising to the snapshot JSON to avoid noise like 0.00000001 in the
UI. The in-memory computation uses full precision, only the stored
snapshot gets the rounding.

v0.1.2 (T18) per-member breakdown
----------------------------------
For each session member we emit one `MemberSettlement` with:
  - total_paid      = sum(bill.amount for bill in session.bills if bill.payer_id == member.id)
  - total_consumed  = sum(participant.share_amount for bill in session.bills
                          for participant in bill.participants
                          if participant.member_id == member.id)
  - net             = total_paid - total_consumed
                      (== `balances[member_id]` for the same session)
  - paid_bills      = bills where the member was the payer (newest first)
  - consumed_bills  = bills where the member was a participant, with
                      `share_amount` filled in (newest first)

The persisted `summary_json` snapshot keeps its v0.1.0 shape
(`balances` + `transfers` only) so existing snapshots remain valid;
the `per_member` list is computed on the fly from `bills` +
`bill_participants` + `session_members` at request time, so format
changes don't require a backfill migration.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.session_isolation import get_session_member
from app.db.models.bill_participants import BillParticipant
from app.db.models.bills import Bill
from app.db.models.session_members import SessionMember
from app.db.models.settlements import Settlement

logger = logging.getLogger(__name__)

router = APIRouter(tags=["settle"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class Transfer(BaseModel):
    from_member_id: int
    to_member_id: int
    amount: float


class BillSummary(BaseModel):
    """Lightweight bill row for per-member views."""

    bill_id: int
    description: str | None
    amount: float
    currency: str
    occurred_at: str  # ISO 8601 (UTC)


class BillShare(BaseModel):
    """A bill + the share this particular member owes for it.

    v0.1.2 (PO 2026-07-01 fix #4): adds `exclusive_amount` so the
    per-member personal view can split "shared part" (split equally
    with everyone) from "exclusive part" (this member ate the entire
    portion alone). `share_amount == shared_part + exclusive_amount`.
    Default 0.0 for backward compatibility with existing snapshots.
    """

    bill_id: int
    description: str | None
    amount: float       # bill total
    share_amount: float # this member's share (= shared + exclusive)
    exclusive_amount: float = 0.0  # this member's exclusive portion
    currency: str
    occurred_at: str    # ISO 8601 (UTC)


class MemberSettlement(BaseModel):
    """v0.1.2 (T18): per-member breakdown for the 'personal view' tab.

    `total_paid` / `total_consumed` mirror the same numbers that feed the
    session-wide `balances` dict, so `net = total_paid - total_consumed`
    always equals `balances[member_id]`.

    `paid_bills` lists every bill where the member was the payer.
    `consumed_bills` lists every bill that allocated a share to the
    member (including bills they themselves paid -- those appear in
    both lists).
    """

    member_id: int
    display_name: str
    role: str
    total_paid: float
    total_consumed: float
    net: float
    paid_bills: list[BillSummary]
    consumed_bills: list[BillShare]


class SettleResponse(BaseModel):
    session_id: int
    generated_at: str
    balances: dict[str, float]  # member_id (str) -> net
    transfers: list[Transfer]
    per_member: list[MemberSettlement] = []  # v0.1.2 (T18)


# ---------------------------------------------------------------------------
# Helpers (pure, testable)
# ---------------------------------------------------------------------------


def _compute_balances(
    bills: list[Bill],
    participants_by_bill: dict[int, list[BillParticipant]],
    member_ids: list[int],
) -> dict[int, float]:
    """Compute net[member_id] for the session.

    net = (amount I paid for others) - (amount I consumed)
        = sum(bill.amount where bill.payer_id == me)
        - sum(per_user_total across all bills I participated in)

    Pure function — no DB, no IO.
    """
    paid: dict[int, float] = {mid: 0.0 for mid in member_ids}
    consumed: dict[int, float] = {mid: 0.0 for mid in member_ids}

    for bill in bills:
        paid[bill.payer_id] = paid.get(bill.payer_id, 0.0) + bill.amount
        ppts = participants_by_bill.get(bill.id, [])
        if not ppts:
            # Degenerate: no participants = no consumption to distribute.
            # v0.1 validation requires participants on POST, so this is
            # only reachable via direct DB writes. Stay defensive.
            continue

        exclusive_total = sum(p.exclusive_amount for p in ppts if p.is_exclusive)
        shared_pool = bill.amount - exclusive_total
        per_user_shared = shared_pool / len(ppts)
        for p in ppts:
            share = per_user_shared + (p.exclusive_amount if p.is_exclusive else 0.0)
            consumed[p.member_id] = consumed.get(p.member_id, 0.0) + share

    net: dict[int, float] = {}
    for mid in member_ids:
        net[mid] = round(paid.get(mid, 0.0) - consumed.get(mid, 0.0), 2)
    return net


def _greedy_pair(net: dict[int, float], tol: float = 1e-6) -> list[dict]:
    """Pair largest creditor with largest debtor until balances are zero.

    Returns a list of {from_member_id, to_member_id, amount} dicts.
    `from` is the debtor (negative net) paying the creditor (positive net).
    """
    # Work on copies so we don't mutate the input.
    balances = {mid: float(v) for mid, v in net.items()}
    transfers: list[dict] = []

    # Round tiny residuals to zero up front so floating point noise
    # doesn't generate spurious transfers.
    for mid in list(balances.keys()):
        if abs(balances[mid]) < tol:
            balances[mid] = 0.0

    while True:
        creditors = [(mid, bal) for mid, bal in balances.items() if bal > tol]
        debtors = [(mid, -bal) for mid, bal in balances.items() if bal < -tol]

        if not creditors or not debtors:
            break

        # Largest creditor (most positive net)
        creditors.sort(key=lambda x: x[1], reverse=True)
        debtors.sort(key=lambda x: x[1], reverse=True)
        c_mid, c_amt = creditors[0]
        d_mid, d_amt = debtors[0]

        amount = round(min(c_amt, d_amt), 2)
        if amount < tol:
            break

        transfers.append(
            {"from_member_id": d_mid, "to_member_id": c_mid, "amount": amount}
        )
        balances[c_mid] = round(balances[c_mid] - amount, 2)
        balances[d_mid] = round(balances[d_mid] + amount, 2)

    return transfers


def _iso(dt: datetime | None) -> str:
    if dt is None:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def _bill_share_amounts(bill: Bill, parts: list[BillParticipant]) -> list[float]:
    """Per-participant share for a single bill (same formula as bills API).

    shared_pool = amount - sum(exclusive_amount for p in parts if is_exclusive)
    per_user_shared = shared_pool / len(parts)
    share = per_user_shared + (own_exclusive if is_exclusive else 0)
    """
    if not parts:
        return []
    exclusive_total = sum(p.exclusive_amount for p in parts if p.is_exclusive)
    shared_pool = bill.amount - exclusive_total
    per_user_shared = shared_pool / len(parts)
    return [
        per_user_shared + (p.exclusive_amount if p.is_exclusive else 0.0)
        for p in parts
    ]


def _compute_per_member(
    bills: list[Bill],
    participants_by_bill: dict[int, list[BillParticipant]],
    members: list[SessionMember],
) -> list[MemberSettlement]:
    """Build the per-member breakdown for the v0.1.2 personal view tab.

    Pure function — easy to unit-test. Returns one MemberSettlement per
    session member, in the order they were passed in (caller is
    responsible for ordering, typically `joined_at asc`).
    """
    out: list[MemberSettlement] = []
    for m in members:
        paid_bills: list[BillSummary] = []
        consumed_bills: list[BillShare] = []
        total_paid = 0.0
        total_consumed = 0.0

        for bill in bills:
            # Biller side: bills where this member is the payer.
            if bill.payer_id == m.id:
                paid_bills.append(
                    BillSummary(
                        bill_id=bill.id,
                        description=bill.description,
                        amount=bill.amount,
                        currency=bill.currency,
                        occurred_at=_iso(bill.occurred_at),
                    )
                )
                total_paid += bill.amount

            # Consumer side: bills that include this member as a participant.
            ppts = participants_by_bill.get(bill.id, [])
            shares = _bill_share_amounts(bill, ppts)
            for idx, p in enumerate(ppts):
                if p.member_id == m.id:
                    share_amount = shares[idx] if idx < len(shares) else 0.0
                    # v0.1.2 (fix #4): surface the exclusive portion as
                    # its own field so the FE can show "独占 X" vs
                    # "共享 Y" without re-deriving from the bill shape.
                    # exclusive_amount is 0 when the member is not
                    # flagged is_exclusive, and is always present
                    # (default 0) on the response.
                    exclusive_amount = (
                        p.exclusive_amount if p.is_exclusive else 0.0
                    )
                    consumed_bills.append(
                        BillShare(
                            bill_id=bill.id,
                            description=bill.description,
                            amount=bill.amount,
                            share_amount=share_amount,
                            exclusive_amount=exclusive_amount,
                            currency=bill.currency,
                            occurred_at=_iso(bill.occurred_at),
                        )
                    )
                    total_consumed += share_amount
                    break  # one row per bill per member

        net = round(total_paid - total_consumed, 2)
        out.append(
            MemberSettlement(
                member_id=m.id,
                display_name=m.display_name,
                role=m.role,
                total_paid=round(total_paid, 2),
                total_consumed=round(total_consumed, 2),
                net=net,
                paid_bills=sorted(paid_bills, key=lambda b: b.occurred_at, reverse=True),
                consumed_bills=sorted(
                    consumed_bills, key=lambda b: b.occurred_at, reverse=True
                ),
            )
        )
    return out


# ---------------------------------------------------------------------------
# GET /sessions/{session_id}/settle
# ---------------------------------------------------------------------------


@router.get(
    "/sessions/{session_id}/settle",
    response_model=SettleResponse,
)
async def settle_session(
    sm: Annotated[SessionMember, Depends(get_session_member)],
    db: Annotated[Session, Depends(get_db)],
) -> dict:
    """Compute + persist a settlement snapshot for the session.

    200: balances + transfers + snapshot timestamp.
    401: no/invalid cookie.
    403: not a session member.
    """
    # Load every member in the session (we need everyone for net=0
    # even if they had no bills — they're still owed 0 / owe 0).
    members = (
        db.query(SessionMember)
        .filter(SessionMember.session_id == sm.session_id)
        .order_by(SessionMember.joined_at.asc())
        .all()
    )
    member_ids = [m.id for m in members]

    # Load all bills + their participants in two queries (N+1 free).
    bills = (
        db.query(Bill)
        .filter(Bill.session_id == sm.session_id)
        .order_by(Bill.occurred_at.asc(), Bill.id.asc())
        .all()
    )
    participants_by_bill: dict[int, list[BillParticipant]] = {}
    if bills:
        rows = (
            db.query(BillParticipant)
            .filter(BillParticipant.bill_id.in_([b.id for b in bills]))
            .order_by(BillParticipant.id.asc())
            .all()
        )
        for r in rows:
            participants_by_bill.setdefault(r.bill_id, []).append(r)

    balances = _compute_balances(bills, participants_by_bill, member_ids)
    transfers = _greedy_pair(balances)

    # v0.1.2 (T18): per-member breakdown for the personal view tab.
    # Reuse the same per-bill `share_amount` math the bills API does
    # (SPEC §3 "派生字段不入库"); build maps member_id -> total_paid +
    # list of paid_bills / list of consumed_bills (with shares).
    per_member = _compute_per_member(
        bills=bills,
        participants_by_bill=participants_by_bill,
        members=members,
    )

    # Persist snapshot (SPEC §3 settlements table). v0.1.2 (T18) keeps
    # the persisted `summary_json` shape backward-compatible: only
    # balances + transfers. The richer `per_member` is computed
    # on-the-fly so we don't bloat the snapshot and so future format
    # changes don't need a backfill migration.
    now = datetime.now(timezone.utc)
    summary = {
        "balances": {str(mid): balances[mid] for mid in member_ids},
        "transfers": transfers,
    }
    snapshot = Settlement(
        session_id=sm.session_id,
        generated_at=now,
        summary_json=json.dumps(summary, ensure_ascii=False, sort_keys=True),
    )
    db.add(snapshot)
    db.commit()
    db.refresh(snapshot)

    return {
        "session_id": sm.session_id,
        "generated_at": _iso(snapshot.generated_at),
        "balances": {str(mid): balances[mid] for mid in member_ids},
        "transfers": transfers,
        "per_member": [pm.model_dump() for pm in per_member],
    }