"""Settle API — Sprint 1 T12 + v0.1.2 (T18) + v0.2.2 (T11 Decimal).

Endpoint (mounted under /sessions/{session_id}/settle; the dev proxy
strips the /api prefix):

GET /sessions/{session_id}/settle?view=primary|split

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
1. For each bill, convert its ``amount`` into the session's
   ``primary_currency``:
     - currency == primary: use bill.amount as-is.
     - currency != primary: bill.amount * bill.exchange_rate_snapshot,
       then quantize to 2 dp.
2. Aggregate paid amounts per member:
     paid[member] = sum(converted amount where bill.payer_id == member)
3. Aggregate consumed amounts per member using the same per_user_total
   formula as the bills API (PRD §3.1.2):
     shared_pool = bill.amount - sum(exclusive_amount for p in ppts)
     per_user_shared = shared_pool / len(ppts)
     consumed[member] = sum(per_user_shared + (own_exclusive if any))
4. net[member] = paid[member] - consumed[member]
   (positive net = others owe them; negative net = they owe others)
5. Greedy pair the largest creditor with the largest debtor until
   everyone hits zero. Transfer amount = min(|creditor|, |debtor|).

v0.2.2 (T11) Decimal 精度
-------------------------
ALL intermediate calculations use ``decimal.Decimal`` — NO float.
Bills are stored as ``Numeric(12, 2)`` (T07 migration); settlement
quantizes to cents only at the very last step via
``Decimal('0.01')`` + ``ROUND_HALF_UP``. This avoids the classic
``0.1 + 0.2 = 0.30000000000000004`` drift that broke naive float
settlement.

v0.2.2 (T11) view modes
-----------------------
- ``view=primary`` (default): every amount in the response is the
  primary-currency value. transfer amounts, balance, paid/consumed
  totals, per-member breakdown — all aggregated in primary currency.
- ``view=split``: preserve source currency per bill. Response includes
  a ``currencies: list[str]`` echo and ``per_currency_totals:
  dict[currency, Decimal]``. balances/transfers are computed in primary
  currency regardless (settlement math needs a single reference
  currency); the per-bill ``currency`` field on per-member rows
  carries the source.

v0.3.14 (§3.14.3) settle real-time re-rate
-----------------------------------------
PRD §3.14.3 (PO 2026-07-13 11:33 #4131 拍板) reverses §3.7.6 for the
**settle** path:

- **settle 汇总页** (this endpoint + GET ?view=personal): converts each
  non-primary bill using the *current* ``session_exchange_rates`` row,
  not the bill's historical snapshot. Therefore changes to the session
  rate are reflected immediately in balances / transfers /
  per_member[].total_paid / per_member[].total_consumed /
  per_member[].net / per_member[].exclusive_amount_primary /
  per_member[].share_amount_primary.

- **bill 详情 + bills 列表** (``/sessions/{id}/bills`` endpoint): keeps
  the historical snapshot for amount_primary display (PRD §3.7.5
  snapshot isolation preserved). The ``bills.exchange_rate_snapshot``
  column is **not** mutated by rate changes — we only **read** the
  live session rate when converting inside settle.

- The DB column ``bills.exchange_rate_snapshot`` itself stays
  unchanged by this module. It is still written at bill-create time
  by ``bills.py`` and never overwritten.

When a bill's currency differs from the primary but no current
``session_exchange_rates`` row exists for ``(bill.currency → primary)``,
we still raise 422 ``missing_exchange_rate_snapshot`` (error code
preserved for FE compat).
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal
from enum import Enum
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.core.session_isolation import get_session_member_or_secret
from app.db.models.bill_participants import BillParticipant
from app.db.models.bills import Bill
from app.db.models.session_exchange_rates import SessionExchangeRate
from app.db.models.session_members import SessionMember
from app.db.models.sessions import Session as SessionModel
from app.db.models.session_exchange_rates import SessionExchangeRate
from app.db.models.session_members import SessionMember
from app.db.models.sessions import Session as SessionModel
from app.db.models.settlement_records import SettlementRecord
from app.db.models.settlements import Settlement

logger = logging.getLogger(__name__)

router = APIRouter(tags=["settle"])


# ---------------------------------------------------------------------------
# Constants — Decimal precision & quantization
# ---------------------------------------------------------------------------

# Quantization unit for all settlement money values (PRD §3.7.6).
# 2 dp matches bills.amount Numeric(12, 2); the unit is reused in
# every quantize() call so the response is uniformly cents-aligned.
CENT = Decimal("0.01")
# Tolerance for treating a Decimal balance as effectively zero. We use
# a value strictly less than half a cent so any sub-cent residual after
# quantize() is skipped (a true 0.005 rounds to 0.01 and is settled).
ZERO_TOL = Decimal("0.004999")


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class Transfer(BaseModel):
    from_member_id: int
    to_member_id: int
    """Transfer amount, in the session's ``primary_currency``, cents-aligned."""
    amount: Decimal


class BillSummary(BaseModel):
    """Lightweight bill row for per-member views.

    v0.2.2 (T11): ``amount_primary`` carries the value converted to
    primary currency (or ``amount`` itself when already primary). The
    raw ``currency`` is kept so the FE can switch between primary and
    split views without re-fetching bills.
    """

    bill_id: int
    description: str | None
    amount: Decimal       # raw amount in source currency (or primary if same)
    amount_primary: Decimal  # always primary currency, cents-aligned
    currency: str
    primary_currency: str
    occurred_at: str  # ISO 8601 (UTC)
    participant_count: int = 0  # v0.3.16 #3: number of participants on the bill


class BillShare(BaseModel):
    """A bill + the share this particular member owes for it.

    v0.2.2 (T11): same as BillSummary but additionally carries the
    member's per-share amount in both source and primary currency
    (because each share comes from dividing the raw bill amount and
    therefore inherits the bill's source currency).
    """

    bill_id: int
    description: str | None
    amount: Decimal       # bill total (raw, source currency)
    amount_primary: Decimal  # bill total in primary currency
    share_amount: Decimal  # this member's share, raw currency
    share_amount_primary: Decimal  # this member's share, primary currency
    exclusive_amount: Decimal = Decimal("0")  # source currency
    exclusive_amount_primary: Decimal = Decimal("0")
    currency: str
    primary_currency: str
    occurred_at: str    # ISO 8601 (UTC)
    participant_count: int = 0  # v0.3.16 #3: number of participants on the bill


class MemberSettlement(BaseModel):
    """Per-member breakdown for the 'personal view' tab.

    v0.2.2 (T11): ``total_paid`` / ``total_consumed`` / ``net`` are
    primary-currency values; the per-bill breakdown items carry both
    currencies so the FE can render either view.
    """

    member_id: int
    display_name: str
    role: str
    total_paid: Decimal
    total_consumed: Decimal
    net: Decimal
    paid_bills: list[BillSummary]
    consumed_bills: list[BillShare]


class SettleResponse(BaseModel):
    session_id: int
    generated_at: str
    """v0.2.2: echoes the session's currencies so the FE can render
    chip selectors without a separate GET /sessions/{id}."""
    currencies: list[str]
    primary_currency: str
    """v0.2.2: echo of the view mode used to compute this response."""
    view: str
    """member_id (str) -> net in primary currency, cents-aligned."""
    balances: dict[str, Decimal]
    transfers: list[Transfer]
    per_member: list[MemberSettlement] = []
    currency_breakdown: dict[str, CurrencyBreakdown] | None = None


class CurrencyBreakdown(BaseModel):
    paid: Decimal
    consumed: Decimal
    net: Decimal


class ViewMode(str, Enum):
    PRIMARY = "primary"
    SPLIT = "split"


# ---------------------------------------------------------------------------
# Helpers (pure, testable) — Decimal throughout
# ---------------------------------------------------------------------------


def _quantize(value: Decimal) -> Decimal:
    """Quantize to cents with ROUND_HALF_UP (banker-safe for our use).

    PRD §3.7.6 mandates HALF_UP (consistent with the v0.2.1 calculator
    and the existing v0.1 / v0.1.2 settle behaviour, which also used
    HALF_UP via Python's built-in round()).
    """
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def _is_zero(value: Decimal) -> bool:
    """True when ``value`` is small enough to round to zero cents."""
    return abs(value) < ZERO_TOL


def _convert_to_primary(
    amount: Decimal,
    source_currency: str,
    primary_currency: str,
    rate_snapshot: Decimal | None,
) -> Decimal:
    """Convert a money value to the session's primary currency.

    - Same currency → return amount as Decimal (no conversion needed).
    - Different currency → amount × snapshot rate, then quantize to cents.
    - Different currency but no snapshot → caller is responsible for
      raising HTTPException(422) before this is invoked. This helper
      does NOT raise (kept pure for unit tests).
    """
    if source_currency == primary_currency:
        return _quantize(amount)
    if rate_snapshot is None:
        # Defensive: caller should have validated the snapshot exists.
        # In tests / non-HTTP contexts we surface the missing data.
        raise ValueError(
            f"Missing exchange rate snapshot for {source_currency} → {primary_currency}"
        )
    return _quantize(amount * rate_snapshot)


def _excl_to_primary(
    excl_raw: Decimal,
    bill_currency: str | None,
    snapshot,
    session_rates: dict[tuple[str, str], Decimal] | None,
    primary_currency: str | None,
) -> Decimal:
    """Convert an exclusive amount into primary currency.

    Prefer current ``session_rates`` (same source as bill ``amount_primary``
    in settle_session). Fall back to historical snapshot, then raw.
    Never hardcode CNY — primary may be any supported currency.
    """
    excl_raw = Decimal(excl_raw)
    if (
        session_rates is not None
        and primary_currency is not None
        and bill_currency is not None
        and bill_currency != primary_currency
        and (bill_currency, primary_currency) in session_rates
    ):
        return _quantize(excl_raw * session_rates[(bill_currency, primary_currency)])
    if (
        snapshot is not None
        and bill_currency is not None
        and primary_currency is not None
        and bill_currency != primary_currency
    ):
        return _quantize(excl_raw * Decimal(snapshot))
    if snapshot is not None and bill_currency is not None and bill_currency != "CNY":
        # Legacy unit-test / pre-multi-primary path.
        return _quantize(excl_raw * Decimal(snapshot))
    return _quantize(excl_raw)


def _compute_balances(
    bills,  # list[Bill] | list[tuple[Bill, Decimal]] — duck-typed for test compatibility
    participants_by_bill: dict[int, list[BillParticipant]],
    member_ids: list[int],
    session_rates: dict[tuple[str, str], Decimal] | None = None,
    primary_currency: str | None = None,
) -> dict[int, Decimal]:
    """Compute net[member_id] for the session (Decimal throughout, v0.2.2 T11).

    Two calling conventions are supported:

    1. **Production**: ``bills = [(bill, amount_in_primary), ...]`` — each
       bill has been pre-converted to the session's primary currency.
       The tuple's amount is used directly.
    2. **Unit-test fixtures**: ``bills = [_FakeBill(...), ...]`` — duck-typed
       stand-ins that lack ``currency`` / ``exchange_rate_snapshot``.
       Treated as already-primary; the algorithm uses ``bill.amount``
       directly. This keeps the v0.1.2 / v0.2.1 unit-test suite working
       unchanged.

    net = (amount I paid for others) - (amount I consumed)
        = sum(bill.amount where bill.payer_id == me)
        - sum(per_user_total across all bills I participated in)

    Orphan member ids (payer / participant not in ``member_ids``, e.g. a
    deleted seat still referenced by old bills) are skipped so sum(net)
    stays 0 instead of HTTP 500.
    """
    member_id_set = set(member_ids)
    paid: dict[int, Decimal] = {mid: Decimal("0") for mid in member_ids}
    consumed: dict[int, Decimal] = {mid: Decimal("0") for mid in member_ids}

    # Determine calling convention: tuple list vs bare Bill list.
    is_pre_converted = bool(bills) and isinstance(bills[0], tuple)

    for entry in bills:
        if is_pre_converted:
            bill, amount_primary = entry
        else:
            bill = entry
            # Unit-test path: the fixture has no currency / snapshot.
            # Treat as already-primary; pure Decimal numeric.
            amount_primary = _quantize(Decimal(bill.amount))
            # For the unit-test path, skip the foreign-currency conversion
            # entirely (fixtures use CNY semantics).
            snapshot = None
            bill_currency = None

        # Real Bill rows have these; test fixtures may not — getattr fallback.
        if is_pre_converted:
            bill_currency = getattr(bill, "currency", None)
            snapshot = getattr(bill, "exchange_rate_snapshot", None)

        # For pre-converted production bills, amount_primary is already in
        # primary currency — DO NOT re-multiply. For unit-test bills (no
        # currency attribute, no snapshot), the conversion branch is skipped.
        if (
            not is_pre_converted
            and bill_currency is not None
            and snapshot is not None
            and bill_currency != "CNY"
        ):
            # Production path with a foreign-currency bill — multiply.
            amount_primary = _quantize(amount_primary * Decimal(snapshot))

        payer_id = int(bill.payer_id)
        # Skip bills whose payer is no longer a session member (orphan FK).
        if payer_id not in member_id_set:
            continue

        all_ppts = participants_by_bill.get(bill.id, [])
        # Drop orphan participants so shares redistribute among remaining seats.
        # Orphan exclusive amounts are peeled off amount_primary so they are not
        # silently absorbed into the shared pool of remaining members.
        orphan_excl = Decimal("0")
        for p in all_ppts:
            if int(p.member_id) not in member_id_set and p.is_exclusive:
                orphan_excl += _excl_to_primary(
                    Decimal(p.exclusive_amount),
                    bill_currency,
                    snapshot,
                    session_rates,
                    primary_currency,
                )
        amount_primary = amount_primary - orphan_excl

        ppts = [p for p in all_ppts if int(p.member_id) in member_id_set]
        # Credit payer even when no remaining participants (degenerate / orphan-only
        # exclusive peeled to 0) — matches historical empty-ppts behaviour.
        paid[payer_id] = paid.get(payer_id, Decimal("0")) + amount_primary
        if not ppts:
            continue

        # Compute exclusive_total in primary currency (Decimal).
        exclusive_total = Decimal("0")
        for p in ppts:
            if p.is_exclusive:
                exclusive_total += _excl_to_primary(
                    Decimal(p.exclusive_amount),
                    bill_currency,
                    snapshot,
                    session_rates,
                    primary_currency,
                )

        shared_pool = amount_primary - exclusive_total
        per_user_shared = shared_pool / Decimal(len(ppts))
        for p in ppts:
            own_excl = Decimal("0")
            if p.is_exclusive:
                own_excl = _excl_to_primary(
                    Decimal(p.exclusive_amount),
                    bill_currency,
                    snapshot,
                    session_rates,
                    primary_currency,
                )
            mid = int(p.member_id)
            consumed[mid] = consumed.get(mid, Decimal("0")) + per_user_shared + own_excl

    net: dict[int, Decimal] = {}
    for mid in member_ids:
        net[mid] = paid.get(mid, Decimal("0")) - consumed.get(mid, Decimal("0"))
    # Invariant (v0.3.14.1): sum(net) MUST equal 0 because every cent paid
    # is also consumed by definition of the algorithm. Raw-Decimal aggregation
    # keeps sum-to-zero. Tolerance 0.0001 handles non-terminating Decimal div.
    total_net = sum(net.values(), Decimal("0"))
    if not _is_zero(total_net):
        raise AssertionError(
            f"settle invariant violated: sum(net)={total_net} (expected 0). "
            f"net={dict(net)}"
        )
    return net


def _primary_currency_for(bill: Bill) -> str:
    """Cheap accessor for a bill's session primary currency.

    The caller is expected to have already joined the Session — we
    infer via bill.session when SQLAlchemy already loaded it, else
    fall back to the conservative 'CNY' (only reached in tests).
    """
    try:
        return bill.session.primary_currency
    except AttributeError:
        return "CNY"


def _compute_currency_breakdown(
    bills_with_primary: list[tuple[Bill, Decimal]],
    participants_by_bill: dict[int, list[BillParticipant]],
) -> dict[str, CurrencyBreakdown]:
    """v0.3.14.1 (Bug B): per-source-currency aggregation for view=split.

    Aggregates paid / consumed per source currency across all bills.
    Called only when view == 'split'. Balances / transfers stay in primary currency.
    """
    paid_by_ccy: dict[str, Decimal] = {}
    consumed_by_ccy: dict[str, Decimal] = {}

    for bill, amount_primary in bills_with_primary:
        bill_currency = getattr(bill, "currency", None) or "CNY"
        ppts = participants_by_bill.get(bill.id, [])

        # Accumulate paid in source currency (not converted)
        paid_by_ccy[bill_currency] = paid_by_ccy.get(bill_currency, Decimal("0")) + Decimal(bill.amount)

        # Accumulate consumed: each participant's share in source currency
        if ppts:
            amount_f = Decimal(bill.amount)
            excl_total = sum(
                Decimal(p.exclusive_amount) for p in ppts if p.is_exclusive
            )
            shared = amount_f - excl_total
            per_user = shared / Decimal(len(ppts))
            for p in ppts:
                own = Decimal(p.exclusive_amount) if p.is_exclusive else Decimal("0")
                consumed_by_ccy[bill_currency] = (
                    consumed_by_ccy.get(bill_currency, Decimal("0")) + per_user + own
                )

    result: dict[str, CurrencyBreakdown] = {}
    all_ccys = set(paid_by_ccy) | set(consumed_by_ccy)
    for ccy in all_ccys:
        p = paid_by_ccy.get(ccy, Decimal("0"))
        c = consumed_by_ccy.get(ccy, Decimal("0"))
        result[ccy] = CurrencyBreakdown(paid=p, consumed=c, net=p - c)
    return result


def _apply_settlement_records(
    balances: dict[int, Decimal],
    session_id: int,
    primary_currency: str,
    session_rates: dict[tuple[str, str], Decimal],
    db: Session,
) -> dict[int, Decimal]:
    """v0.3.32 -- UAT 0725-2 #1: shift balances by per-pair settlement_records.

    Each SettlementRecord means "payer already gave payee X (in
    ``currency``)", which is economically equivalent to:
      - payer paid an extra X (in primary currency)
      - payee consumed an extra X (in primary currency)

    In balance terms (balance = paid - consumed):
      - payer.balance += X_primary  (payer is owed more)
      - payee.balance -= X_primary  (payee owes more)

    The resulting greedy_pair output therefore lists only the REMAINING
    transfers. If the sum already covers the raw-bill imbalance, the
    affected pair drops out of the output entirely.

    Rate conversion:
    - When record.currency == primary_currency: 1:1 (no rate lookup).
    - Otherwise: lookup session_rates[(currency, primary_currency)].
      If missing (rare -- the pair was never tracked), 422 with a
      structured error so the FE can prompt the user to set the rate.
      Same fallback behaviour as the bill-to-primary conversion above.

    Returns a NEW dict; the input is not mutated (matches _greedy_pair's
    contract -- it also operates on a copy).
    """
    records = (
        db.query(SettlementRecord)
        .filter(SettlementRecord.session_id == session_id)
        .all()
    )
    if not records:
        return balances

    out = dict(balances)
    for r in records:
        if r.currency == primary_currency:
            amount_primary = _quantize(Decimal(r.amount))
        else:
            rate = session_rates.get((r.currency, primary_currency))
            if rate is None:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail={
                        "error": "missing_exchange_rate_for_settlement",
                        "settlement_record_id": r.id,
                        "currency": r.currency,
                        "primary_currency": primary_currency,
                    },
                )
            amount_primary = _quantize(Decimal(r.amount) * rate)

        # Skip if either side isn't a tracked member (legacy data) -- keeps
        # the math from blowing up if a member was hard-deleted outside
        # the cascade.
        if r.payer_id not in out:
            continue
        if r.payee_id not in out:
            continue

        out[r.payer_id] = _quantize(out[r.payer_id] + amount_primary)
        out[r.payee_id] = _quantize(out[r.payee_id] - amount_primary)
    return out


def _greedy_pair(net: dict[int, Decimal]) -> list[dict]:
    """Pair largest creditor with largest debtor until balances are zero.

    Returns a list of {from_member_id, to_member_id, amount} dicts.
    `from` is the debtor (negative net) paying the creditor (positive net).

    Coerces incoming ``float`` values to ``Decimal`` so the legacy
    v0.1.2 unit-test fixtures (which pass plain floats) keep working.
    """
    # Work on copies so we don't mutate the input.
    balances: dict[int, Decimal] = {
        mid: _quantize(Decimal(str(v)) if not isinstance(v, Decimal) else v)
        for mid, v in net.items()
    }
    transfers: list[dict] = []

    # Round tiny residuals to zero up front so noise doesn't generate
    # spurious transfers.
    for mid in list(balances.keys()):
        if _is_zero(balances[mid]):
            balances[mid] = Decimal("0")

    while True:
        creditors = [(mid, bal) for mid, bal in balances.items() if bal > ZERO_TOL]
        debtors = [(mid, bal) for mid, bal in balances.items() if bal < -ZERO_TOL]

        if not creditors or not debtors:
            break

        # Largest creditor (most positive net) ↔ largest debtor (most negative)
        creditors.sort(key=lambda x: x[1], reverse=True)
        debtors.sort(key=lambda x: x[1])
        c_mid, c_amt = creditors[0]
        d_mid, d_amt = debtors[0]

        amount = _quantize(min(c_amt, -d_amt))
        if _is_zero(amount):
            break

        transfers.append(
            {"from_member_id": d_mid, "to_member_id": c_mid, "amount": amount}
        )
        balances[c_mid] = _quantize(balances[c_mid] - amount)
        balances[d_mid] = _quantize(balances[d_mid] + amount)

    return transfers


def _iso(dt: datetime | None) -> str:
    if dt is None:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.isoformat()


def _share_amounts_primary(
    bill,  # Bill | _FakeBill — duck-typed for unit tests
    parts: list[BillParticipant],
    amount_primary: Decimal,
    session_rates: dict[tuple[str, str], Decimal] | None = None,
    primary_currency: str | None = None,
) -> list[Decimal]:
    """Per-participant share in primary currency (same formula as bills API).

    shared_pool = amount_primary - sum(primary exclusive for p where is_exclusive)
    per_user_shared = shared_pool / len(parts)
    share = per_user_shared + (own_exclusive_primary if is_exclusive else 0)

    Duck-typed: real Bill rows expose ``currency`` / ``exchange_rate_snapshot``;
    unit-test fixtures (``_FakeBill``) don't. We use getattr() fallbacks so
    the same function serves both call sites without conditionals at the
    algorithm level.
    """
    if not parts:
        return []
    bill_currency = getattr(bill, "currency", None)
    snapshot = getattr(bill, "exchange_rate_snapshot", None)
    exclusive_total = Decimal("0")
    for p in parts:
        if p.is_exclusive:
            exclusive_total += _excl_to_primary(
                Decimal(p.exclusive_amount),
                bill_currency,
                snapshot,
                session_rates,
                primary_currency,
            )
    shared_pool = amount_primary - exclusive_total
    per_user_shared = shared_pool / Decimal(len(parts))
    out: list[Decimal] = []
    for p in parts:
        own = Decimal("0")
        if p.is_exclusive:
            own = _excl_to_primary(
                Decimal(p.exclusive_amount),
                bill_currency,
                snapshot,
                session_rates,
                primary_currency,
            )
        out.append(per_user_shared + own)
    return out


def _compute_per_member(
    bills_with_primary: list[tuple[Bill, Decimal]],
    participants_by_bill: dict[int, list[BillParticipant]],
    members: list[SessionMember],
    session_rates: dict[tuple[str, str], Decimal] | None = None,
    primary_currency: str | None = None,
) -> list[MemberSettlement]:
    """Build the per-member breakdown (primary currency throughout).

    v0.3.14 §3.14.3: when ``session_rates`` is provided, the
    per-bill ``exclusive_amount_primary`` uses the *current*
    session rate (matching the conversion used for ``amount_primary``
    above) instead of the historical ``bill.exchange_rate_snapshot``.
    Unit-test paths that omit ``session_rates`` keep the snapshot-based
    behaviour so the v0.1.2 / v0.2.1 unit fixtures remain valid.
    """
    out: list[MemberSettlement] = []
    member_id_set = {m.id for m in members}
    for m in members:
        paid_bills: list[BillSummary] = []
        consumed_bills: list[BillShare] = []
        total_paid = Decimal("0")
        total_consumed = Decimal("0")

        for bill, amount_primary in bills_with_primary:
            # Match _compute_balances: skip orphan-payer bills.
            if int(bill.payer_id) not in member_id_set:
                continue
            primary = _primary_currency_for(bill)
            # v0.3.16 #3: 提前算 ppts, 让 payer 侧 BillSummary 也能拿到 participant_count
            # Drop orphan participants (same filter as balances).
            ppts = [
                p
                for p in participants_by_bill.get(bill.id, [])
                if int(p.member_id) in member_id_set
            ]
            if not ppts:
                continue
            shares_primary = _share_amounts_primary(
                bill,
                ppts,
                amount_primary,
                session_rates=session_rates,
                primary_currency=primary_currency,
            )
            # Biller side: bills where this member is the payer.
            if bill.payer_id == m.id:
                paid_bills.append(
                    BillSummary(
                        bill_id=bill.id,
                        description=bill.description,
                        amount=Decimal(bill.amount),
                        amount_primary=amount_primary,
                        currency=bill.currency,
                        primary_currency=primary,
                        occurred_at=_iso(bill.occurred_at),
                        participant_count=len(ppts),
                    )
                )
                total_paid += amount_primary

            # Consumer side: bills that include this member as a participant.
            for idx, p in enumerate(ppts):
                if p.member_id == m.id:
                    share_primary = shares_primary[idx] if idx < len(shares_primary) else Decimal("0")
                    exclusive_primary = Decimal("0")
                    exclusive_raw = Decimal("0")
                    if p.is_exclusive:
                        exclusive_raw = _quantize(Decimal(p.exclusive_amount))
                        # v0.3.14 §3.14.3: prefer the *current* session rate
                        # so exclusive_amount_primary matches the rate used
                        # for amount_primary above. Fall back to the bill's
                        # stored snapshot only when no live rate is supplied
                        # (unit-test path — preserves existing fixtures).
                        use_live_rate = (
                            session_rates is not None
                            and primary_currency is not None
                            and bill.currency != primary_currency
                            and (bill.currency, primary_currency) in session_rates
                        )
                        if use_live_rate:
                            exclusive_primary = _quantize(
                                exclusive_raw * session_rates[(bill.currency, primary_currency)]
                            )
                        elif bill.exchange_rate_snapshot is not None and bill.currency != primary:
                            exclusive_primary = _quantize(exclusive_raw * bill.exchange_rate_snapshot)
                        else:
                            exclusive_primary = exclusive_raw
                    consumed_bills.append(
                        BillShare(
                            bill_id=bill.id,
                            description=bill.description,
                            amount=Decimal(bill.amount),
                            amount_primary=amount_primary,
                            share_amount=share_primary,           # source-currency share
                            share_amount_primary=share_primary,   # primary-currency share
                            exclusive_amount=exclusive_raw,
                            exclusive_amount_primary=exclusive_primary,
                            currency=bill.currency,
                            primary_currency=primary,
                            occurred_at=_iso(bill.occurred_at),
                            participant_count=len(ppts),
                        )
                    )
                    total_consumed += share_primary
                    break  # one row per bill per member

        net = _quantize(total_paid - total_consumed)
        out.append(
            MemberSettlement(
                member_id=m.id,
                display_name=m.display_name,
                role=m.role,
                total_paid=_quantize(total_paid),
                total_consumed=_quantize(total_consumed),
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
    sm: Annotated[SessionMember, Depends(get_session_member_or_secret)],
    db: Annotated[Session, Depends(get_db)],
    view: Annotated[ViewMode, Query()] = ViewMode.PRIMARY,
) -> dict:
    """Compute + persist a settlement snapshot for the session.

    200: balances + transfers + snapshot timestamp + per-member breakdown.
    401: no/invalid cookie.
    403: not a session member.
    422: foreign-currency bill missing its rate snapshot (T11 snapshot mode).
    """
    # ---- 0. Load session for currencies + primary_currency ----------------
    session_row = (
        db.query(SessionModel).filter(SessionModel.id == sm.session_id).first()
    )
    if session_row is None:
        # Should be impossible — FK ON DELETE CASCADE — but stay defensive.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"error": "session not found"},
        )
    primary_currency = session_row.primary_currency

    # ---- 1. Load every member in the session -----------------------------
    members = (
        db.query(SessionMember)
        .filter(SessionMember.session_id == sm.session_id)
        .order_by(SessionMember.joined_at.asc())
        .all()
    )
    member_ids = [m.id for m in members]

    # ---- 2. Load all bills + their participants --------------------------
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

    # ---- 2.5. Load session_exchange_rates (v0.3.14 §3.14.3) -------------
    # Settle converts each non-primary bill using the *current* row in
    # session_exchange_rates (PRD §3.14.3 — PO #4131). The bill's stored
    # ``exchange_rate_snapshot`` is ignored here (it remains immutable
    # for the bills-list / bill-detail path, where PRD §3.7.5 still
    # applies).
    session_rates: dict[tuple[str, str], Decimal] = {}
    rate_rows = (
        db.query(SessionExchangeRate)
        .filter(SessionExchangeRate.session_id == sm.session_id)
        .all()
    )
    for r in rate_rows:
        session_rates[(r.from_currency, r.to_currency)] = Decimal(r.rate)

    # ---- 3. Convert each bill to primary currency (Decimal throughout) ---
    bills_with_primary: list[tuple[Bill, Decimal]] = []
    for b in bills:
        if b.currency == primary_currency:
            amount_primary = _quantize(Decimal(b.amount))
        else:
            # v0.3.14 §3.14.3: read the current session rate. Fall back
            # to 422 with the legacy error code if no direct rate is set
            # (e.g. owner only configured the reverse pair).
            current_rate = session_rates.get((b.currency, primary_currency))
            if current_rate is None:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                    detail={
                        "error": "missing_exchange_rate_snapshot",
                        "bill_id": b.id,
                        "currency": b.currency,
                        "primary_currency": primary_currency,
                    },
                )
            amount_primary = _quantize(Decimal(b.amount) * current_rate)
        bills_with_primary.append((b, amount_primary))

    # ---- 4. Aggregate balances (Decimal) + greedy pair (Decimal) ---------
    balances = _compute_balances(
        bills_with_primary,
        participants_by_bill,
        member_ids,
        session_rates=session_rates,
        primary_currency=primary_currency,
    )

    # v0.3.32 -- UAT 0725-2 #1: subtract per-pair settlement_records so the
    # remaining transfer list reflects "what's still owed" rather than the
    # raw bills math. See _apply_settlement_records for the per-pair shift
    # in primary currency (rate-converted when record currency != primary).
    balances = _apply_settlement_records(
        balances=balances,
        session_id=sm.session_id,
        primary_currency=primary_currency,
        session_rates=session_rates,
        db=db,
    )
    transfers = _greedy_pair(balances)

    # ---- 5. Per-member breakdown (primary currency) -----------------------
    per_member = _compute_per_member(
        bills_with_primary=bills_with_primary,
        participants_by_bill=participants_by_bill,
        members=members,
        session_rates=session_rates,
        primary_currency=primary_currency,
    )

    # ---- 6. Persist snapshot (backward-compatible JSON shape) -------------
    now = datetime.now(timezone.utc)
    # Use str(amount) for JSON serialization so cents are preserved
    # exactly. JSON numbers would round to float on the way back, which
    # we explicitly want to avoid (Decimal precision is the whole point).
    summary = {
        "balances": {str(mid): str(balances[mid]) for mid in member_ids},
        "transfers": [
            {"from_member_id": t["from_member_id"], "to_member_id": t["to_member_id"], "amount": str(t["amount"])}
            for t in transfers
        ],
        "view": view.value,
        "primary_currency": primary_currency,
    }
    snapshot = Settlement(
        session_id=sm.session_id,
        generated_at=now,
        summary_json=json.dumps(summary, ensure_ascii=False, sort_keys=True),
    )
    db.add(snapshot)
    db.commit()
    db.refresh(snapshot)

    # ---- 7. Build response ----------------------------------------------
    # The per_member field is computed on the fly (not persisted) so
    # future format changes don't need a backfill migration. Pydantic
    # serialises Decimal to a string by default — which is what we want
    # for FE precision (the FE parseFloat()s before rendering).
    return {
        "session_id": sm.session_id,
        "generated_at": _iso(snapshot.generated_at),
        "currencies": list(session_row.currencies or ["CNY"]),
        "primary_currency": primary_currency,
        "view": view.value,
        "balances": {str(mid): balances[mid] for mid in member_ids},
        "transfers": transfers,
        "per_member": [pm.model_dump(mode="json") for pm in per_member],
        "currency_breakdown": (
            _compute_currency_breakdown(bills_with_primary, participants_by_bill)
            if view == "split" else None
        ),
    }