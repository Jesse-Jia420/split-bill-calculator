"""Verify seed data balance for the THAILAND2 session (v0.3.x / UAT #0723-3 #5).

The seed_dev_data module inserts 40 bills (35 THB + 5 CNY) with mixed
payer / shared-consumer / exclusive-consumer roles, plus 4 解耦 examples
(payer ≠ consumer). This script verifies the on-disk DB state matches
the design invariants documented in the module:

  1. Per-member net balance: Σ(paid) - Σ(consumed) computed in primary
     currency (CNY). Σ across all members must equal 0 (net identity).
  2. Σ(paid) = Σ(bills) — every penny the bills cost is paid by some
     member.
  3. Σ(consumed) = Σ(bills) — every penny is consumed by some member.
  4. 解耦 example count ≥ 3 (current design: 4).
  5. Per-member 3-role coverage (payer ≥1 + shared consumer ≥1 +
     exclusive consumer ≥1).
  6. Multi-currency bill counts (35 THB + 5 CNY).

Run from anywhere (loads SQLite from the path passed as argv[1] or the
default ``backend/data/sbc.db``). Exit code is non-zero when any check
fails.
"""
from __future__ import annotations

import sys
from collections import defaultdict
from decimal import Decimal
from pathlib import Path

THB_TO_CNY = Decimal("0.21500000")  # mirrors seed_dev_data._THAILAND_THB_TO_CNY


def _to_cny(amount: Decimal, currency: str) -> Decimal:
    if currency == "CNY":
        return amount
    return amount * THB_TO_CNY


def verify(db_path: str = "backend/data/sbc.db") -> int:
    import sqlite3
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()

    # Locate THAILAND2 session
    session_row = cur.execute(
        "SELECT id, name, primary_currency FROM sessions WHERE name = '泰国测试账单 2 7.25-7.28'"
    ).fetchone()
    if session_row is None:
        print("FAIL: session '泰国测试账单 2 7.25-7.28' not found in DB")
        return 1
    session_id, session_name, primary = session_row
    print(f"Session {session_id}: {session_name} (primary={primary})")
    assert primary == "CNY", f"expected primary=CNY, got {primary}"

    # Members
    member_rows = cur.execute(
        "SELECT id, display_name FROM session_members WHERE session_id=? ORDER BY id",
        (session_id,),
    ).fetchall()
    member_names = {mid: name for mid, name in member_rows}
    print(f"Members: {member_names}")
    assert len(member_rows) == 5, f"expected 5 members, got {len(member_rows)}"

    paid = defaultdict(lambda: Decimal(0))
    incl_share = defaultdict(lambda: Decimal(0))
    excl_share = defaultdict(lambda: Decimal(0))

    # Bills
    bill_rows = cur.execute(
        "SELECT id, payer_id, amount, currency FROM bills WHERE session_id=?",
        (session_id,),
    ).fetchall()
    bill_count_by_currency: dict[str, int] = defaultdict(int)
    for bill_id, payer_id, amount, currency in bill_rows:
        bill_count_by_currency[currency] += 1
        amount_cny = _to_cny(Decimal(str(amount)), currency)
        paid[payer_id] += amount_cny

    # Participants per bill (need # inclusive pax to split amount)
    pax_rows = cur.execute(
        """SELECT bp.bill_id, bp.member_id, bp.is_exclusive, bp.exclusive_amount, b.amount, b.currency
           FROM bill_participants bp
           JOIN bills b ON b.id = bp.bill_id
           WHERE b.session_id=?""",
        (session_id,),
    ).fetchall()

    bill_pax: dict[int, list[tuple[int, int, Decimal]]] = defaultdict(list)
    for bill_id, member_id, is_exclusive, excl_amount, _amount, _currency in pax_rows:
        bill_pax[bill_id].append((member_id, is_exclusive, Decimal(str(excl_amount))))

    for bill_id, payer_id, amount, currency in bill_rows:
        amount_cny = _to_cny(Decimal(str(amount)), currency)
        pax_list = bill_pax[bill_id]
        inclusive = [m for m, ex, _ in pax_list if not ex]
        exclusive = [(m, a) for m, ex, a in pax_list if ex]
        if inclusive:
            per_pax = amount_cny / len(inclusive)
            for m in inclusive:
                incl_share[m] += per_pax
        for m, a in exclusive:
            # exclusive_amount is stored in the bill's native currency —
            # convert to CNY before accumulating so Σ consumed is
            # comparable across mixed-currency bills.
            excl_share[m] += _to_cny(a, currency)

    total_paid = sum(paid.values())
    total_incl = sum(incl_share.values())
    total_excl = sum(excl_share.values())
    total_consumed = total_incl + total_excl
    total_bills_cny = sum(_to_cny(Decimal(str(amount)), currency) for _, _, amount, currency in bill_rows)

    print()
    print(f"Bills by currency: {dict(bill_count_by_currency)}")
    print(f"Σ paid = {float(total_paid):.4f} CNY")
    print(f"Σ consumed = {float(total_consumed):.4f} CNY  (incl {float(total_incl):.4f} + excl {float(total_excl):.4f})")
    print(f"Σ bills = {float(total_bills_cny):.4f} CNY")
    diff_paid = total_paid - total_bills_cny
    diff_consumed = total_consumed - total_bills_cny
    print(f"Σ paid - Σ bills = {float(diff_paid):.6f} (must be 0)")
    print(f"Σ consumed - Σ bills = {float(diff_consumed):.6f} (must be 0)")

    if abs(diff_paid) > Decimal("0.01"):
        print("FAIL: Σ paid != Σ bills")
        return 2
    if abs(diff_consumed) > Decimal("0.01"):
        print("FAIL: Σ consumed != Σ bills")
        return 3

    print()
    print("Per-member balance (CNY):")
    for mid, name in member_names.items():
        consumed = incl_share[mid] + excl_share[mid]
        net = paid[mid] - consumed
        sign = "+" if net >= 0 else ""
        print(f"  {name:<14}  paid={float(paid[mid]):>8.2f}  incl={float(incl_share[mid]):>7.2f}  excl={float(excl_share[mid]):>6.2f}  net={sign}{float(net):>+7.2f}")

    # 解耦 count
    decoupled_count = 0
    decoupled_examples: list[tuple[str, str, list[str]]] = []
    for bill_id, payer_id, amount, currency in bill_rows:
        pax_list = bill_pax[bill_id]
        exclusive_pax = [m for m, ex, _ in pax_list if ex]
        if exclusive_pax and payer_id not in exclusive_pax:
            desc = cur.execute("SELECT description FROM bills WHERE id=?", (bill_id,)).fetchone()[0]
            decoupled_count += 1
            decoupled_examples.append((desc, member_names[payer_id], [member_names[m] for m in exclusive_pax]))
    print()
    print(f"payer ≠ consumer 解耦 count: {decoupled_count}")
    for desc, payer, consumers in decoupled_examples:
        print(f"  - {desc}: payer={payer} → consumer={consumers}")
    if decoupled_count < 3:
        print("FAIL: 解耦 count < 3")
        return 4

    # 3-role coverage
    payer_count: dict[int, int] = defaultdict(int)
    incl_count: dict[int, int] = defaultdict(int)
    excl_count: dict[int, int] = defaultdict(int)
    for bill_id, payer_id, _, _ in bill_rows:
        payer_count[payer_id] += 1
    for bill_id, member_id, is_exclusive, _, _, _ in pax_rows:
        if is_exclusive:
            excl_count[member_id] += 1
        else:
            incl_count[member_id] += 1
    print()
    print("Per-member 3-role coverage:")
    fail = False
    for mid, name in member_names.items():
        p, i, e = payer_count[mid], incl_count[mid], excl_count[mid]
        ok = p >= 1 and i >= 1 and e >= 1
        flag = "✓" if ok else "✗"
        print(f"  {flag} {name:<14}  payer={p}  incl={i}  excl={e}")
        if not ok:
            fail = True
    if fail:
        print("FAIL: some member missing payer/incl/excl coverage")
        return 5

    # Bill counts
    print()
    if bill_count_by_currency.get("THB", 0) != 35:
        print(f"FAIL: expected 35 THB bills, got {bill_count_by_currency.get('THB', 0)}")
        return 6
    if bill_count_by_currency.get("CNY", 0) != 5:
        print(f"FAIL: expected 5 CNY bills, got {bill_count_by_currency.get('CNY', 0)}")
        return 7

    print("✅ All 7 invariant checks passed.")
    return 0


if __name__ == "__main__":
    db = sys.argv[1] if len(sys.argv) > 1 else "backend/data/sbc.db"
    sys.exit(verify(db))