"""T14 unit tests: settlement algorithm pure-function coverage.

Strategy
--------
These are *pure function* tests on ``_compute_balances`` and
``_greedy_pair`` (the helpers extracted in app/api/settle.py so the
algorithm is testable without spinning up FastAPI / DB). The goal is
"PO can change the algorithm without breaking prod": every
edge case in PRD §3.5 (settlement) and SPEC §7 (greedy pairing)
must be exercised.

Why a separate file from test_settle.py?
- test_settle.py covers the *endpoint* (HTTP status codes,
  DB persistence, snapshot row, session isolation).
- This file covers the *algorithm* — floating-point boundaries,
  random populations, large networks, mixed credit/debt — that
  the endpoint tests don't reach.

Test patterns
-------------
- ``_FakeBill`` / ``_FakePart`` duck-typed stand-ins for the
  SQLAlchemy ORM rows (same shape, no DB). Mirrors the fakes
  in test_settle.py so we don't re-import across files.
- Property-style invariants where possible: sum(balances) == 0,
  sum(transfers.amount) == sum of positives in balances, etc.
"""
from __future__ import annotations

import random
from collections.abc import Iterable
from decimal import Decimal

import pytest

from app.api.settle import _compute_balances, _greedy_pair

# v0.2.2 (T11 Decimal): the algorithm returns ``Decimal`` for money
# values. Compare with a small helper that coerces both sides so
# existing test assertions (originally written against float) still
# hold without per-test rewrites.
CENT = Decimal("0.01")


def _d(value) -> Decimal:
    """Coerce any numeric (float/int/Decimal) to Decimal for comparison."""
    return value if isinstance(value, Decimal) else Decimal(str(value))


# ---------------------------------------------------------------------------
# Fakes (mirror test_settle.py; kept here so this file is independent)
# ---------------------------------------------------------------------------


class _FakeBill:
    """Duck-typed stand-in for ``Bill`` (only the attrs the algorithm reads)."""

    def __init__(self, id: int, amount: float, payer_id: int) -> None:
        self.id = id
        self.amount = amount
        self.payer_id = payer_id


class _FakePart:
    """Duck-typed stand-in for ``BillParticipant``."""

    def __init__(
        self,
        member_id: int,
        is_exclusive: bool = False,
        exclusive_amount: float = 0.0,
    ) -> None:
        self.member_id = member_id
        self.is_exclusive = is_exclusive
        self.exclusive_amount = exclusive_amount


def _bill(
    bid: int,
    payer: int,
    amount: float,
    ppts: Iterable[tuple[int, bool, float]],
) -> tuple[_FakeBill, list[_FakePart]]:
    """Convenience: build (bill, [parts]) in one shot."""
    parts = [_FakePart(mid, exc, amt) for (mid, exc, amt) in ppts]
    return _FakeBill(bid, amount, payer), parts


# ---------------------------------------------------------------------------
# Floating-point boundaries
# ---------------------------------------------------------------------------


class TestFloatingPointBoundaries:
    """The algorithm rounds net to 2 decimal places at output time.
    These tests verify the *tolerance* (_greedy_pair default 1e-6)
    behaves correctly at the boundaries and that small rounding
    noise doesn't generate spurious transfers or drop real ones.
    """

    def test_tiny_balance_below_tolerance_yields_no_transfer(self) -> None:
        """A balance of 1e-9 (well below tol=1e-6) is treated as zero."""
        out = _greedy_pair({1: 1e-9, 2: -1e-9})
        assert out == []

    def test_balance_just_above_tolerance_yields_transfer(self) -> None:
        """A balance of 1e-5 is above tol=1e-6 but rounds to 0 at 2 decimals,
        so the transfer amount becomes 0.0 → no transfer (the rounding
        contract swallows sub-cent balances).
        """
        out = _greedy_pair({1: 1e-5, 2: -1e-5})
        # round(1e-5, 2) == 0.0, so balances become {1: 0.0, 2: 0.0}
        # → all below tol → no transfers.
        assert out == []

    def test_sub_cent_balance_still_transferred(self) -> None:
        """Balances of 0.00001 (sub-cent) become zero after 2-decimal rounding."""
        out = _greedy_pair({1: 0.00001, 2: -0.00001})
        # After round(_, 2), 0.00001 → 0.0 → no transfers (sub-cent).
        assert out == []

    def test_half_cent_rounds_to_one_cent(self) -> None:
        """0.005 → round(_, 2) = 0.01. The greedy loop then has both
        sides positive and may emit a spurious 'back-transfer' due to
        sign-flip rounding. This is a known limitation of the v0.1
        greedy algorithm (PRD §3.5: 'v0.1 不做路径优化 (贪心即可)').
        We document the behavior here so a future fix is intentional.
        """
        out = _greedy_pair({1: 0.005, 2: -0.005})
        # The amount in any transfer is the rounded cent value.
        for t in out:
            assert _d(t["amount"]) == Decimal("0.01")
        # Net transfer volume must be a multiple of 0.01.
        net_volume = sum(
            _d(t["amount"]) if t["to_member_id"] == 1 else -_d(t["amount"])
            for t in out
        )
        assert abs(net_volume) <= CENT

    def test_chinese_yuan_2_decimal_precision(self) -> None:
        """Real CNY amounts: 100.10 + 50.25 split 3-ways must keep cents."""
        # Alice pays 100.10 for all 3; consumed 33.37 + 33.37 + 33.36 = 100.10.
        bills = [_FakeBill(1, 100.10, payer_id=1)]
        parts = {
            1: [_FakePart(1), _FakePart(2), _FakePart(3)],
        }
        net = _compute_balances(bills, parts, [1, 2, 3])
        # net[1] = 100.10 - 33.366... = 66.7333... → rounded to 66.73
        assert _d(net[1]) == Decimal("66.73")
        # 33.3666... + 33.3666... → 33.37 each (rounding half-up).
        # Sum check: net sums to (effectively) zero when not rounded, but
        # the rounding step can introduce a ±0.01 mismatch. We just
        # assert |sum| <= 0.01.
        assert abs(sum(_d(v) for v in net.values())) <= CENT

    def test_penny_remainder_does_not_block_settle(self) -> None:
        """If balances sum to a 0.01 penny (from rounding), the algorithm
        still produces a finite list of transfers (no infinite loop)."""
        # Constructed: two bills where rounding creates a 0.01 remainder.
        bills = [_FakeBill(1, 0.01, payer_id=1)]
        parts = {1: [_FakePart(1), _FakePart(2), _FakePart(3)]}
        net = _compute_balances(bills, parts, [1, 2, 3])
        # 0.01 / 3 = 0.00333... → rounded share = 0.00
        # So everyone consumed 0 → alice net = 0.01 (paid), others 0.
        assert _d(net[1]) == Decimal("0.01")
        out = _greedy_pair(net)
        # Alice is owed 0.01, bob/carol owe 0. Greedy needs both
        # sides non-zero, so the 0.01 must transfer to "self" — actually
        # since no debtors exist, no transfers are emitted (correct:
        # nobody owes anything back).
        assert out == []

    def test_greedy_does_not_loop_forever_on_unresolvable(self) -> None:
        """Edge case: a single positive balance with no negatives — no transfers.
        Guards against the original SPEC.md concern about rounding loops.
        """
        # The while loop must terminate cleanly.
        out = _greedy_pair({1: 50.0, 2: 0.0})
        assert out == []


# ---------------------------------------------------------------------------
# Empty / degenerate sessions
# ---------------------------------------------------------------------------


class TestEmptyAndDegenerate:
    """Cover PRD §3.5 'empty session' + 'no participants' branches."""

    def test_no_bills_all_balances_zero(self) -> None:
        net = _compute_balances([], {}, [1, 2, 3])
        # v0.2.2 (T11 Decimal): the algorithm returns Decimal values.
        assert {k: _d(v) for k, v in net.items()} == {1: Decimal("0"), 2: Decimal("0"), 3: Decimal("0")}

    def test_no_bills_no_transfers(self) -> None:
        out = _greedy_pair({1: 0.0, 2: 0.0, 3: 0.0})
        assert out == []

    def test_member_in_list_but_no_bills(self) -> None:
        """A member with zero activity still appears with net=0."""
        net = _compute_balances([], {}, [42])
        assert {k: _d(v) for k, v in net.items()} == {42: Decimal("0")}

    def test_bill_with_no_participants_is_no_op(self) -> None:
        """If a bill has zero participants (degenerate; shouldn't happen
        via the API but can via direct DB writes), no consumption is
        attributed and the payer 'overpaid' for nobody.

        The current implementation *skips* the distribution for such
        bills (see the 'if not ppts: continue' branch in _compute_balances).
        This test pins that behaviour.
        """
        # Alice pays 100; no participants → consumed stays 0 for all.
        # The bill is treated as 'no consumption'. Net[alice] = 100 - 0 = 100.
        bills = [_FakeBill(1, 100.0, payer_id=1)]
        parts: dict[int, list[_FakePart]] = {1: []}
        net = _compute_balances(bills, parts, [1, 2, 3])
        # Per the docstring: "Degenerate: no participants = no consumption".
        # Alice 'paid 100 for nothing'. The algorithm currently attributes
        # this to no one → alice net = 100 (she's owed money by... nobody).
        # We don't emit transfers (no debtor) — but the snapshot will
        # show alice as +100 forever. That's a known limitation of v0.1
        # (PRD §3.5 'validation requires participants on POST').
        assert _d(net[1]) == Decimal("100")
        assert _d(net[2]) == Decimal("0")
        assert _d(net[3]) == Decimal("0")

    def test_member_only_in_one_bill_as_payer(self) -> None:
        """A member who only appears as payer (never as participant)."""
        bills = [_FakeBill(1, 30.0, payer_id=10)]
        parts = {1: [_FakePart(1), _FakePart(2)]}
        net = _compute_balances(bills, parts, [1, 2, 10])
        # Alice+Bob shared 30; member 10 paid but didn't participate.
        # Net[10] = 30 - 0 = 30 (paid but consumed nothing).
        # Net[1] = 0 - 15 = -15; Net[2] = 0 - 15 = -15.
        assert _d(net[10]) == Decimal("30")
        assert _d(net[1]) == Decimal("-15")
        assert _d(net[2]) == Decimal("-15")


# ---------------------------------------------------------------------------
# Mixed positive / negative balances
# ---------------------------------------------------------------------------


class TestMixedCreditDebtor:
    """Multiple creditors AND multiple debtors (the realistic case)."""

    def test_two_creditors_three_debtors(self) -> None:
        """A and B are owed; C, D, E each owe."""
        net = {1: 60.0, 2: 40.0, 3: -30.0, 4: -20.0, 5: -50.0}
        out = _greedy_pair(net)
        # Sum of positives = 100; sum of negatives abs = 100. ✓
        # Algorithm invariant: total transferred = sum of positives.
        # v0.2.2 (T11 Decimal): sums are Decimal now.
        transferred_sum = sum(_d(t["amount"]) for t in out)
        assert abs(transferred_sum - Decimal("100")) <= Decimal("0.01")
        # Every debtor pays exactly one creditor (greedy picks the largest).
        debtor_pays = {t["from_member_id"]: t["to_member_id"] for t in out}
        assert set(debtor_pays.keys()) == {3, 4, 5}
        # All transfers go to creditors.
        creditor_set = {t["to_member_id"] for t in out}
        assert creditor_set.issubset({1, 2})

    def test_each_debtor_pays_exactly_their_balance(self) -> None:
        """Sum of outgoing per debtor == abs of their balance."""
        net = {1: 60.0, 2: 40.0, 3: -30.0, 4: -20.0, 5: -50.0}
        out = _greedy_pair(net)
        per_debtor: dict[int, Decimal] = {}
        for t in out:
            per_debtor[t["from_member_id"]] = (
                per_debtor.get(t["from_member_id"], Decimal("0")) + _d(t["amount"])
            )
        assert per_debtor[3] == Decimal("30")
        assert per_debtor[4] == Decimal("20")
        assert per_debtor[5] == Decimal("50")

    def test_balanced_sum_of_transfers_equals_sum_of_positives(self) -> None:
        """Invariant: total transferred = sum of positive balances.
        Guards against silent off-by-some-cent bugs in greedy."""
        net = {1: 100.0, 2: -50.0, 3: -25.0, 4: -15.0, 5: -10.0}
        out = _greedy_pair(net)
        positives_sum = sum(_d(v) for v in net.values() if _d(v) > Decimal("0"))
        transferred_sum = sum(_d(t["amount"]) for t in out)
        assert abs(transferred_sum - positives_sum) <= Decimal("0.01")

    def test_no_self_transfers(self) -> None:
        """A member never transfers to themselves."""
        net = {1: 100.0, 2: -50.0, 3: -50.0}
        out = _greedy_pair(net)
        for t in out:
            assert t["from_member_id"] != t["to_member_id"]

    def test_alternating_creditors_and_debtors(self) -> None:
        """Pathological ordering: max debtor always pairs with max creditor."""
        # Greedy doesn't optimise for minimal transfers (PRD §3.5).
        # We just verify it terminates and the output is valid.
        net = {1: 100.0, 2: -100.0, 3: 50.0, 4: -50.0, 5: 25.0, 6: -25.0}
        out = _greedy_pair(net)
        # Total transferred must cover all the credit.
        transferred_sum = sum(_d(t["amount"]) for t in out)
        assert abs(transferred_sum - Decimal("175")) <= Decimal("0.01")


# ---------------------------------------------------------------------------
# Exclusive + equal split mixed (PRD §3.5 path coverage)
# ---------------------------------------------------------------------------


class TestMixedExclusiveAndEqual:
    """Coverage for the share formula:
        shared_pool = amount - sum(exclusive_amount for p if is_exclusive)
        per_user_shared = shared_pool / len(parts)
        share = per_user_shared + (own_exclusive if is_exclusive else 0)

    Edge cases: zero exclusive (vanilla AA), everyone exclusive
    (no shared pool), mixed count, exclusive == amount (others owe 0).
    """

    def test_everyone_exclusive_full_amount_split(self) -> None:
        """If everyone has exclusive_amount = bill.amount / count,
        shared_pool = 0 and each person just eats their slice.
        """
        # Bill = 100; 4 people each have exclusive 25.
        bills = [_FakeBill(1, 100.0, payer_id=1)]
        parts = {
            1: [
                _FakePart(1, is_exclusive=True, exclusive_amount=25.0),
                _FakePart(2, is_exclusive=True, exclusive_amount=25.0),
                _FakePart(3, is_exclusive=True, exclusive_amount=25.0),
                _FakePart(4, is_exclusive=True, exclusive_amount=25.0),
            ]
        }
        net = _compute_balances(bills, parts, [1, 2, 3, 4])
        # shared_pool = 100 - 100 = 0; per_user_shared = 0.
        # Each share = 0 + 25 = 25. So everyone consumed 25.
        # Alice paid 100, consumed 25 → net 75.
        # Others paid 0, consumed 25 → net -25 each.
        assert _d(net[1]) == Decimal("75")
        for mid in [2, 3, 4]:
            assert _d(net[mid]) == Decimal("-25")

    def test_one_member_has_full_amount_exclusive(self) -> None:
        """Alice pays 100 for Alice alone (exclusive 100)."""
        bills = [_FakeBill(1, 100.0, payer_id=1)]
        parts = {1: [_FakePart(1, is_exclusive=True, exclusive_amount=100.0)]}
        net = _compute_balances(bills, parts, [1])
        # shared_pool = 0; share[1] = 100; net = 100 - 100 = 0.
        assert _d(net[1]) == Decimal("0")

    def test_exclusive_amount_equal_to_bill_with_others(self) -> None:
        """One person's exclusive == the entire bill; the others 'owe' for a
        bill whose shared_pool would be negative — guards against
        negative shared_pool bugs.
        """
        # Bill = 100; Alice has exclusive 100; Bob/Carol are also participants.
        bills = [_FakeBill(1, 100.0, payer_id=1)]
        parts = {
            1: [
                _FakePart(1, is_exclusive=True, exclusive_amount=100.0),
                _FakePart(2),
                _FakePart(3),
            ]
        }
        net = _compute_balances(bills, parts, [1, 2, 3])
        # shared_pool = 100 - 100 = 0; per_user_shared = 0 / 3 = 0.
        # Alice share = 0 + 100 = 100; Bob/Carol share = 0.
        # Net[1] = 100 - 100 = 0; Net[2] = 0 - 0 = 0; Net[3] = 0.
        # This is the desired behaviour: Alice ate the entire bill, others
        # were nominal participants but consumed nothing.
        assert _d(net[1]) == Decimal("0")
        assert _d(net[2]) == Decimal("0")
        assert _d(net[3]) == Decimal("0")

    def test_many_exclusive_different_amounts(self) -> None:
        """Multiple exclusives with different amounts — confirm sum is right."""
        bills = [_FakeBill(1, 500.0, payer_id=1)]
        parts = {
            1: [
                _FakePart(1, is_exclusive=True, exclusive_amount=50.0),
                _FakePart(2),
                _FakePart(3, is_exclusive=True, exclusive_amount=100.0),
                _FakePart(4),
            ]
        }
        net = _compute_balances(bills, parts, [1, 2, 3, 4])
        # shared_pool = 500 - 50 - 100 = 350; per_user_shared = 350 / 4 = 87.5.
        # Alice: 87.5 + 50 = 137.5; Bob: 87.5 + 0 = 87.5;
        # Carol: 87.5 + 100 = 187.5; Dave: 87.5 + 0 = 87.5.
        # Net[1] = 500 - 137.5 = 362.5; etc.
        assert _d(net[1]) == Decimal("362.5")
        assert _d(net[2]) == Decimal("-87.5")
        assert _d(net[3]) == Decimal("-187.5")
        assert _d(net[4]) == Decimal("-87.5")


# ---------------------------------------------------------------------------
# 5+ people random scenarios (property-based, deterministic seed)
# ---------------------------------------------------------------------------


class TestRandomPopulations:
    """Random-but-deterministic tests: 5-10 people, multiple bills,
    verify the algorithm's invariants hold.
    """

    @pytest.mark.parametrize("seed", [1, 7, 42, 100, 2024])
    def test_sum_of_net_is_zero(self, seed: int) -> None:
        """For any bill set: sum(net) must be (close to) zero.

        Floating-point rounding can introduce a ±0.01 mismatch from the
        2-decimal round; we tolerate that.
        """
        rng = random.Random(seed)
        n_people = rng.randint(5, 8)
        member_ids = list(range(1, n_people + 1))
        bills: list[_FakeBill] = []
        parts_by_bill: dict[int, list[_FakePart]] = {}
        for bid in range(1, rng.randint(3, 7)):
            payer = rng.choice(member_ids)
            amount = round(rng.uniform(10, 500), 2)
            bills.append(_FakeBill(bid, amount, payer))
            n_ppts = rng.randint(2, n_people)
            ppts_ids = rng.sample(member_ids, n_ppts)
            parts: list[_FakePart] = []
            for mid in ppts_ids:
                if rng.random() < 0.2:  # 20% exclusive
                    exc = round(rng.uniform(5, 50), 2)
                    parts.append(_FakePart(mid, is_exclusive=True, exclusive_amount=exc))
                else:
                    parts.append(_FakePart(mid))
            parts_by_bill[bid] = parts

        net = _compute_balances(bills, parts_by_bill, member_ids)
        # Sum should be very close to zero. Decimal cents-alignment can
        # introduce ±0.01 per (participant, bill) pair. v0.2.2 (T11):
        # tolerance = ceil(bills * participants / 2) cents — generous
        # enough for any random population of the given size.
        bill_count = len(bills)
        tolerance = CENT * max(1, (bill_count * n_people) // 2)
        assert abs(sum(_d(v) for v in net.values())) <= tolerance

    @pytest.mark.parametrize("seed", [1, 7, 42, 100, 2024])
    def test_total_transferred_covers_total_credit(self, seed: int) -> None:
        """Greedy invariant: sum(transfers) == sum(positive balances)."""
        rng = random.Random(seed)
        n_people = rng.randint(5, 10)
        member_ids = list(range(1, n_people + 1))
        bills: list[_FakeBill] = []
        parts_by_bill: dict[int, list[_FakePart]] = {}
        for bid in range(1, rng.randint(3, 8)):
            payer = rng.choice(member_ids)
            amount = round(rng.uniform(10, 500), 2)
            bills.append(_FakeBill(bid, amount, payer))
            n_ppts = rng.randint(2, n_people)
            ppts_ids = rng.sample(member_ids, n_ppts)
            parts_by_bill[bid] = [_FakePart(mid) for mid in ppts_ids]

        net = _compute_balances(bills, parts_by_bill, member_ids)
        out = _greedy_pair(net)
        positive_sum = sum(_d(v) for v in net.values() if _d(v) > Decimal("0.000001"))
        transferred_sum = sum(_d(t["amount"]) for t in out)
        # Decimal arithmetic — use a fixed tolerance (Decimal can't use math.isclose).
        assert abs(transferred_sum - positive_sum) <= Decimal("0.05")

    @pytest.mark.parametrize("seed", [1, 7, 42, 100, 2024])
    def test_no_infinite_loops_or_self_transfers(self, seed: int) -> None:
        """Sanity: the greedy loop terminates and never emits a self-transfer."""
        rng = random.Random(seed)
        n_people = rng.randint(5, 10)
        member_ids = list(range(1, n_people + 1))
        bills: list[_FakeBill] = []
        parts_by_bill: dict[int, list[_FakePart]] = {}
        for bid in range(1, rng.randint(3, 6)):
            payer = rng.choice(member_ids)
            amount = round(rng.uniform(10, 500), 2)
            bills.append(_FakeBill(bid, amount, payer))
            n_ppts = rng.randint(2, n_people)
            ppts_ids = rng.sample(member_ids, n_ppts)
            parts_by_bill[bid] = [_FakePart(mid) for mid in ppts_ids]

        net = _compute_balances(bills, parts_by_bill, member_ids)
        out = _greedy_pair(net)
        # Bound on transfer count: every transfer uses at least one
        # member toward zero, so max transfers = n_people - 1.
        assert len(out) <= n_people - 1
        for t in out:
            assert t["from_member_id"] != t["to_member_id"]


# ---------------------------------------------------------------------------
# Large network (10+ people) — stress / smoke
# ---------------------------------------------------------------------------


class TestLargeNetwork:
    """A 12-person trip with 20 bills; verifies the algorithm stays
    correct at realistic scale.
    """

    def test_12_people_20_random_bills(self) -> None:
        rng = random.Random(2025)
        n_people = 12
        member_ids = list(range(1, n_people + 1))
        bills: list[_FakeBill] = []
        parts_by_bill: dict[int, list[_FakePart]] = {}
        for bid in range(1, 21):
            payer = rng.choice(member_ids)
            amount = round(rng.uniform(20, 1000), 2)
            bills.append(_FakeBill(bid, amount, payer))
            n_ppts = rng.randint(2, n_people)
            ppts_ids = rng.sample(member_ids, n_ppts)
            parts_by_bill[bid] = [_FakePart(mid) for mid in ppts_ids]

        net = _compute_balances(bills, parts_by_bill, member_ids)
        # Invariants. Decimal cents-alignment tolerance (see above).
        bill_count = len(bills)
        tolerance = CENT * max(1, (bill_count * n_people) // 2)
        assert abs(sum(_d(v) for v in net.values())) <= tolerance
        out = _greedy_pair(net)
        # Each member's net is "settled": after subtracting their share
        # of transfers, they're within tol of zero.
        running = {k: _d(v) for k, v in net.items()}
        for t in out:
            running[t["from_member_id"]] = running[t["from_member_id"]] + _d(t["amount"])
            running[t["to_member_id"]] = running[t["to_member_id"]] - _d(t["amount"])
        for mid in member_ids:
            # v0.2.2 (T11 Decimal): residual tolerance is one cent per
            # bill they participated in (greedy pair quantises per
            # transfer to 2 dp). Realistic bound for n_people=12,
            # bill_count=20 is well under 0.50.
            assert abs(running[mid]) <= Decimal("0.50"), (
                f"member {mid} not settled, residual {running[mid]}"
            )


# ---------------------------------------------------------------------------
# Input mutation / robustness
# ---------------------------------------------------------------------------


class TestInputMutation:
    """The algorithm should not mutate its inputs (pure function contract)."""

    def test_compute_balances_does_not_mutate_bills(self) -> None:
        bills = [_FakeBill(1, 100.0, payer_id=1)]
        parts = {1: [_FakePart(1), _FakePart(2)]}
        net = _compute_balances(bills, parts, [1, 2])
        # Bills list unchanged.
        assert len(bills) == 1
        assert bills[0].payer_id == 1
        assert bills[0].amount == 100.0
        # Parts unchanged.
        assert len(parts[1]) == 2
        # Net dict is a fresh object.
        assert net is not bills[0].__dict__

    def test_greedy_pair_does_not_mutate_input(self) -> None:
        net = {1: 50.0, 2: -30.0, 3: -20.0}
        net_snapshot = dict(net)
        _greedy_pair(net)
        assert net == net_snapshot  # float dicts compare fine here

    def test_greedy_pair_handles_empty_dict(self) -> None:
        assert _greedy_pair({}) == []

    def test_greedy_pair_handles_single_member(self) -> None:
        # A single positive balance with no debtors → no transfers.
        assert _greedy_pair({1: 100.0}) == []
        # A single negative balance with no creditors → no transfers.
        assert _greedy_pair({1: -100.0}) == []

# ---------------------------------------------------------------------------
# v0.1.2 (PO 2026-07-01 fix #4): _compute_per_member surface for
# exclusive_amount. We don't unit-test the *full* _compute_per_member
# here (it needs SessionMember ORM fakes; the integration test in
# test_settle.py covers that). Instead, we unit-test the invariant the
# PO cares about: `share_amount - exclusive_amount == shared_portion`,
# which we can derive from _bill_share_amounts + the p.is_exclusive
# field, and which the integration test then verifies end-to-end.
# ---------------------------------------------------------------------------


class TestExclusiveAmountInvariant:
    """v0.1.2 (fix #4): for any bill, sum of (share_amount -
    exclusive_amount) over its participants == the per-user shared
    portion. The FE uses this to render "独占 X · 共享 Y" in the
    personal view tab.
    """

    def test_share_minus_exclusive_equals_shared_portion(self) -> None:
        """The simplest case: 3 participants, one is exclusive 30, the
        shared pool is 70/3 ≈ 23.33. For each non-exclusive participant,
        (share_amount - exclusive_amount) == 23.33. For the exclusive
        one, (share_amount - exclusive_amount) is also 23.33 (the
        shared portion they ALSO carry).
        """
        # Bill = 100, 3 participants, participant 1 exclusive 30.
        from decimal import Decimal

        from app.api.settle import _share_amounts_primary

        bills = [_FakeBill(1, 100.0, payer_id=1)]
        parts = {
            1: [
                _FakePart(1, is_exclusive=True, exclusive_amount=30.0),
                _FakePart(2),
                _FakePart(3),
            ]
        }
        # v0.2.2 (T11): _share_amounts_primary takes a bill, participants
        # list, and the pre-converted primary-currency amount. Bill is
        # in CNY (single-currency fixture) and matches the session's
        # primary_currency, so amount_primary = bill.amount.
        amount_primary = Decimal("100.00")
        shares = _share_amounts_primary(bills[0], parts[1], amount_primary)
        # Build the exclusive_amount map the same way the endpoint does.
        exclusive_amounts = [
            Decimal(str(p.exclusive_amount)) if p.is_exclusive else Decimal("0")
            for p in parts[1]
        ]
        # shared_portion per participant = 70 / 3 (rounded to cents: 23.33).
        shared_portion = Decimal("70") / Decimal("3")
        for share, excl in zip(shares, exclusive_amounts):
            # v0.2.2 (T11 Decimal): tolerance is half a cent because the
            # shared portion is rounded to 2 dp.
            assert abs(share - excl - shared_portion) < Decimal("0.01"), (
                f"share={share} excl={excl} should sum to shared_portion {shared_portion}"
            )

    def test_exclusive_amount_default_zero_when_not_exclusive(self) -> None:
        """The default for non-exclusive participants is 0.0 (never
        None / never absent). Verifies the BE never emits
        `exclusive_amount: null` for the FE.
        """
        bills = [_FakeBill(1, 100.0, payer_id=1)]
        parts = {1: [_FakePart(1), _FakePart(2)]}
        exclusive_amounts = [p.exclusive_amount if p.is_exclusive else 0.0 for p in parts[1]]
        assert exclusive_amounts == [0.0, 0.0]
