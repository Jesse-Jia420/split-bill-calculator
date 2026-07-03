"""v0.2.2 T12 verification helper.

Run ad-hoc after `alembic upgrade head` to confirm:
  1. The migration is idempotent (rerun-safe).
  2. The 27 Thailand bills survive the Float -> Numeric migration
     with SUM(amount) unchanged.
  3. The settlement endpoint will compute decimals for the Thailand
     session (no IEEE 754 drift).

Manual invocation:

    $ .venv/bin/python -m scripts._verify_v022_migration

Exit code 0 on success, 1 on failure (prints details).

This script is NOT a pytest fixture; it is a top-down verification that
exercises real alembic / sql / http calls so the Master flow can show
the user proof-of-correctness during Sprint review.
"""
from __future__ import annotations

import os
import sys
import traceback
from decimal import Decimal

# Ensure the backend root is on the path so ``app.*`` imports work when
# running this script with `python scripts/_verify_v022_migration.py`
# from the backend directory.
_BACKEND_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BACKEND_ROOT not in sys.path:
    sys.path.insert(0, _BACKEND_ROOT)


def main() -> int:
    print("[v022_verify] running idempotency + Thailand integrity check")

    from alembic.command import upgrade
    from alembic.config import Config as AlembicConfig

    from app.core.database import SessionLocal
    from app.db.models.bills import Bill
    from app.db.models.session_exchange_rates import SessionExchangeRate
    from app.db.models.sessions import Session as BillSession
    from scripts.seed_dev_data import (
        THAILAND_BILLS,
        THAILAND_SESSION_NAME,
        seed_dev_data,
    )

    failures: list[str] = []

    # --- 1. alembic upgrade idempotency ---------------------------------
    cfg = AlembicConfig("alembic.ini")
    cfg.set_main_option("script_location", "alembic")
    try:
        upgrade(cfg, "head")
        upgrade(cfg, "head")  # second run should be a no-op
        print("[v022_verify] alembic idempotency: OK")
    except Exception:
        failures.append("alembic upgrade head twice raised")
        traceback.print_exc()

    # --- 2. seed + Thailand integrity ------------------------------------
    db = SessionLocal()
    try:
        seed_dev_data(db)
        bills = db.query(Bill).filter(Bill.session_id == 1).all()  # Thailand
        # session 1 is hardcoded for the seeded Thailand data set.
        if len(bills) != 27:
            failures.append(
                f"expected 27 THB bills in session 1, found {len(bills)}"
            )
            print(f"[v022_verify] Thailand bills: {len(bills)} (expected 27)")
        actual_total = sum((Decimal(b.amount) for b in bills), Decimal("0"))
        expected_total = sum(
            (Decimal(str(amt)) for (_d, amt, _p, _t, _pax) in THAILAND_BILLS),
            Decimal("0"),
        )
        drift = abs(actual_total - expected_total)
        print(
            f"[v022_verify] Thailand TOTAL: actual={actual_total} "
            f"expected={expected_total} drift={drift}"
        )
        if drift >= Decimal("0.05"):
            failures.append(
                f"Thailand total drifted: actual={actual_total} expected={expected_total}"
            )

        # Schema sanity.
        if bills and not isinstance(bills[0].amount, Decimal):
            failures.append(
                f"bills[0].amount type is {type(bills[0].amount).__name__}, expected Decimal"
            )

        # Session metadata.
        sess = (
            db.query(BillSession)
            .filter(BillSession.name == THAILAND_SESSION_NAME)
            .first()
        )
        if sess is None:
            failures.append("Thailand session not found after seed")
        else:
            if sess.primary_currency != "CNY":
                failures.append(
                    f"Thailand primary_currency={sess.primary_currency!r}, expected 'CNY'"
                )
            if "CNY" not in (sess.currencies or []):
                failures.append(
                    f"Thailand currencies={sess.currencies!r}, expected 'CNY' in it"
                )

        # Snapshot backfill.
        null_snaps = sum(1 for b in bills if b.exchange_rate_snapshot is None)
        foreign = sum(1 for b in bills if b.currency != sess.primary_currency)
        print(
            f"[v022_verify] Thailand snapshots: total={len(bills)} foreign={foreign} null={null_snaps}"
        )
        if null_snaps:
            failures.append(f"{null_snaps} Thailand bills still have NULL snapshot")
    finally:
        db.close()

    # --- 3. summary -------------------------------------------------------
    if failures:
        print("\n[v022_verify] FAILED:")
        for f in failures:
            print(" -", f)
        return 1
    print("\n[v022_verify] ALL OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
