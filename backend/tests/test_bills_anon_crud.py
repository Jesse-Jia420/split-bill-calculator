"""§3.12 v0.3.2 anonymous bill CRUD — pytest contract.

Scope
-----
SPEC §3.12.E.2 / PRD §3.12.2 verification. The v0.3.2 release extends
the 4 anonymous paths to the **full** bill CRUD:

    POST   /sessions/{id}/bills         (was already or_secret, FE was missing header — 反 #51)
    PATCH  /sessions/{id}/bills/{bid}   (BE dep upgraded get_session_member → or_secret)
    DELETE /sessions/{id}/bills/{bid}   (BE dep upgraded get_session_member → or_secret)
    POST   /sessions/{id}/bills/parse   (BE dep upgraded get_session_member → or_secret)

Tests here exercise the BE contract: every endpoint must accept the
``X-Nickname-Secret`` header AND reject (403) requests that omit it
or send a wrong value. They also pin the backward-compat cookie
path so existing logged-in flows are not regressed.

Anti-patterns honoured
----------------------
- **反 #53b** — NO autouse truncate fixture. Each test gets a clean
  DB via the explicit ``_reset_db()`` helper called at the top of the
  function body. We never rely on a global fixture that might run
  against the prod DB (``./data/sbc.db``) by accident.
- **反 #81** — 3 ``test.fixme_*`` placeholder tests document known
  v0.3.2 root causes as living changelog entries; they are skipped
  today but provide a copy-paste template if the bug ever
  resurfaces.
- **反 #100** — anon paths here use **no** cookies. The headers
  are the only auth signal.

Why a separate file (not extending test_bills.py)?
-------------------------------------------------
- Independent ``git log -p`` shows the v0.3.2 diff in one place.
- ``pytest backend/tests/test_bills_anon_crud.py`` is grep-friendly
  for the v0.3.2 verification gate.
- test_bills.py is heavy (1000+ lines); a focused regression file
  keeps review cycles short.
"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.api import bills as bills_module
from app.core.auth import COOKIE_NAME, hash_token
from app.core.database import SessionLocal
from app.db.models.auth_tokens import AuthToken
from app.db.models.bill_participants import BillParticipant
from app.db.models.bills import Bill
from app.db.models.session_members import SessionMember, SessionRole
from app.db.models.sessions import Session as SessionModel
from app.db.models.users import User
from app.db.models.verification_codes import VerificationCode
from app.main import app


# ---------------------------------------------------------------------------
# DB helpers — explicit, never autouse (反 #53b)
# ---------------------------------------------------------------------------


def _reset_db() -> None:
    """Wipe every row in dependency order. MUST be called at the start
    of every test in this file.

    This is intentionally NOT an autouse fixture: if you forget to
    call it, your test will see stale data and fail loudly, instead of
    silently nuking a real DB (反 #53b). The trade-off is a one-line
    call per test.
    """
    db = SessionLocal()
    try:
        db.query(BillParticipant).delete()
        db.query(Bill).delete()
        db.query(SessionMember).delete()
        db.query(SessionModel).delete()
        db.query(VerificationCode).delete()
        db.query(User).delete()
        db.commit()
    finally:
        db.close()


def _make_user(email: str, default_name: str | None = None) -> User:
    db = SessionLocal()
    try:
        u = User(
            email=email,
            default_name=default_name or email.split("@")[0][:120],
        )
        db.add(u)
        db.commit()
        db.refresh(u)
        return u
    finally:
        db.close()


def _login_as(email: str) -> tuple[TestClient, User]:
    user = _make_user(email)
    raw = secrets.token_urlsafe(32)
    db = SessionLocal()
    try:
        db.add(
            AuthToken(
                user_id=user.id,
                token_hash=hash_token(raw),
                expires_at=datetime.now(timezone.utc) + timedelta(days=30),
            )
        )
        db.commit()
    finally:
        db.close()
    c = TestClient(app)
    c.cookies.set(COOKIE_NAME, raw)
    return c, user


def _make_session_with_owner_and_anon(
    *,
    owner_email: str = "alice@anon-bills.local",
    anon_display_name: str = "dd",
    session_name: str = "§3.12 anon CRUD",
) -> tuple[int, int, str, int]:
    """Create a session owned by a logged-in user plus one anonymous member.

    Returns:
        (session_id, owner_member_id, anon_nickname_secret, anon_member_id)

    The anon member's ``user_id`` is NULL and ``nickname_secret`` is
    a freshly minted hex64 token. The FE will store that secret in
    ``localStorage.sbc.actingAs.{session_id}`` and send it back via
    ``X-Nickname-Secret`` on every CRUD call.
    """
    owner = _make_user(owner_email, "Alice")
    now = datetime.now(timezone.utc)
    db = SessionLocal()
    try:
        session = SessionModel(
            name=session_name,
            owner_user_id=owner.id,
            invite_token=secrets.token_urlsafe(32),
            invite_expires_at=now + timedelta(days=30),
            invite_created_at=now,
            currencies=["CNY"],
            primary_currency="CNY",
            session_code=secrets.token_hex(4),
            last_active_at=now,
        )
        db.add(session)
        db.flush()
        owner_sm = SessionMember(
            session_id=session.id,
            user_id=owner.id,
            display_name="Alice",
            role=SessionRole.OWNER.value,
            is_anon=False,
            claimed_at=now,
        )
        db.add(owner_sm)
        db.flush()
        anon_secret = secrets.token_hex(32)
        anon_sm = SessionMember(
            session_id=session.id,
            user_id=None,
            display_name=anon_display_name,
            role=SessionRole.MEMBER.value,
            is_anon=True,
            nickname_secret=anon_secret,
            claimed_at=now,
        )
        db.add(anon_sm)
        db.commit()
        db.refresh(session)
        db.refresh(owner_sm)
        db.refresh(anon_sm)
        return session.id, owner_sm.id, anon_secret, anon_sm.id
    finally:
        db.close()


def _bill_body(
    *,
    payer_member_id: int,
    member_ids: list[int],
    amount: float = 100.0,
    description: str = "午饭",
) -> dict[str, Any]:
    """Build a POST /bills body that the BE will accept."""
    return {
        "amount": amount,
        "payer_member_id": payer_member_id,
        "description": description,
        "occurred_at": "2026-07-11T12:00:00+00:00",
        "currency": "CNY",
        "participants": [
            {"member_id": mid, "is_exclusive": False, "exclusive_amount": 0.0}
            for mid in member_ids
        ],
    }


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


# ---------------------------------------------------------------------------
# E.2.1 — anon POST /bills with X-Nickname-Secret → 201 + DB verifies
# ---------------------------------------------------------------------------


def test_anon_can_create_bill_with_secret(client: TestClient) -> None:
    """§3.12.E.2: anon POST /bills → 201; created_by IS NULL; lookup by
    nickname_secret succeeds.
    """
    _reset_db()
    sid, owner_mid, anon_secret, anon_mid = _make_session_with_owner_and_anon()

    anon_client = TestClient(app)  # no cookies
    body = _bill_body(
        payer_member_id=anon_mid,
        member_ids=[owner_mid, anon_mid],
        amount=88.0,
        description="午饭 (anon-created)",
    )
    r = anon_client.post(
        f"/sessions/{sid}/bills",
        json=body,
        headers={"X-Nickname-Secret": anon_secret},
    )
    assert r.status_code == 201, r.text
    bill = r.json()
    assert bill["amount"] == 88.0
    assert bill["description"] == "午饭 (anon-created)"
    assert bill["payer_id"] == anon_mid

    # ── DB-level invariants for an anon-created bill ────────────────────
    db = SessionLocal()
    try:
        b = db.query(Bill).filter_by(id=bill["id"]).one()
        assert b.created_by is None, (
            "anon creator must NOT have a user_id on the Bill row "
            "(反 #51 / SPEC §3.12.B)"
        )
        assert b.session_id == sid
        assert b.status == "draft"

        # Lookup-by-secret sanity check: the FE will use the same
        # header to PATCH/DELETE this bill, so the SM row MUST still
        # match the secret.
        sm = (
            db.query(SessionMember)
            .filter_by(session_id=sid, nickname_secret=anon_secret)
            .one()
        )
        assert sm.id == anon_mid
        assert sm.user_id is None
        assert sm.is_anon is True
    finally:
        db.close()


# ---------------------------------------------------------------------------
# E.2.2 — anon PATCH /bills/{bid} with X-Nickname-Secret → 200
# ---------------------------------------------------------------------------


def test_anon_can_patch_bill_with_secret(client: TestClient) -> None:
    _reset_db()
    sid, owner_mid, anon_secret, anon_mid = _make_session_with_owner_and_anon()
    anon_client = TestClient(app)

    # Owner creates a bill first so we have a stable bill_id.
    body = _bill_body(
        payer_member_id=owner_mid,
        member_ids=[owner_mid, anon_mid],
        amount=100.0,
        description="original",
    )
    r = anon_client.post(
        f"/sessions/{sid}/bills",
        json=body,
        headers={"X-Nickname-Secret": anon_secret},
    )
    assert r.status_code == 201
    bid = r.json()["id"]

    # Anon edits the amount to 250.
    r = anon_client.patch(
        f"/sessions/{sid}/bills/{bid}",
        json={"amount": 250.0},
        headers={"X-Nickname-Secret": anon_secret},
    )
    assert r.status_code == 200, r.text
    assert r.json()["amount"] == 250.0
    assert r.json()["description"] == "original"  # immutable

    # Verify the change persisted.
    db = SessionLocal()
    try:
        b = db.query(Bill).filter_by(id=bid).one()
        assert float(b.amount) == 250.0
    finally:
        db.close()


# ---------------------------------------------------------------------------
# E.2.3 — anon DELETE /bills/{bid} with X-Nickname-Secret → 204 + DB gone
# ---------------------------------------------------------------------------


def test_anon_can_delete_bill_with_secret(client: TestClient) -> None:
    _reset_db()
    sid, owner_mid, anon_secret, anon_mid = _make_session_with_owner_and_anon()
    anon_client = TestClient(app)

    # Owner mints a bill; anon deletes it.
    body = _bill_body(
        payer_member_id=owner_mid,
        member_ids=[owner_mid, anon_mid],
        amount=42.0,
        description="to-be-deleted",
    )
    r = anon_client.post(
        f"/sessions/{sid}/bills",
        json=body,
        headers={"X-Nickname-Secret": anon_secret},
    )
    bid = r.json()["id"]

    r = anon_client.delete(
        f"/sessions/{sid}/bills/{bid}",
        headers={"X-Nickname-Secret": anon_secret},
    )
    assert r.status_code == 204, r.text

    # DB-level: row gone (no soft delete in v0.1+).
    db = SessionLocal()
    try:
        assert db.query(Bill).filter_by(id=bid).first() is None
        assert (
            db.query(BillParticipant).filter_by(bill_id=bid).first() is None
        ), "BillParticipant rows must cascade-delete with the parent bill"
    finally:
        db.close()


# ---------------------------------------------------------------------------
# E.2.4 — anon POST /bills/parse → 200 (mocked, no live API)
# ---------------------------------------------------------------------------


def test_anon_can_parse_bill_with_secret(client: TestClient, monkeypatch) -> None:
    """§3.12.E.2: anon parse → 200, with ``_call_minimax_api`` mocked so
    the test never hits the network (and never returns 422 because
    the dev key is missing).
    """
    _reset_db()
    sid, _, anon_secret, _ = _make_session_with_owner_and_anon()
    anon_client = TestClient(app)

    async def fake_call(text: str, member_names: list[str]) -> dict[str, Any]:
        # Match the ParseBillResponse shape in app/api/bills.py
        return {
            "amount": 50.0,
            "payer_hint": "self",
            "participants_hint": ["all"],
            "description": "午饭",
        }

    monkeypatch.setattr(bills_module, "_call_minimax_api", fake_call)
    r = anon_client.post(
        f"/sessions/{sid}/bills/parse",
        json={"text": "午饭 50 块"},
        headers={"X-Nickname-Secret": anon_secret},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["amount"] == 50.0
    assert body["description"] == "午饭"

    # parse must NOT write to the DB (T11 contract).
    db = SessionLocal()
    try:
        assert db.query(Bill).count() == 0
    finally:
        db.close()


# ---------------------------------------------------------------------------
# E.2.5/6/7/8 — no header on create/patch/delete/parse → 403
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "method,path",
    [
        ("POST",   "/sessions/{sid}/bills"),
        ("PATCH",  "/sessions/{sid}/bills/{bid}"),
        ("DELETE", "/sessions/{sid}/bills/{bid}"),
        ("POST",   "/sessions/{sid}/bills/parse"),
    ],
    ids=["create", "patch", "delete", "parse"],
)
def test_no_secret_returns_403_on_crud(
    client: TestClient, method: str, path: str
) -> None:
    """Each of the 4 endpoints must return 403 when no auth header is
    supplied AND no cookie is set.

    We exercise the paths through a fresh client (no cookies), which
    is exactly the worst-case anon request shape (PRD §3.12.1).
    """
    _reset_db()
    sid, owner_mid, anon_secret, anon_mid = _make_session_with_owner_and_anon()

    # Seed a bill via the owner so PATCH/DELETE have a valid bid.
    owner_client, _ = _login_as("alice@anon-bills.local")
    body = _bill_body(
        payer_member_id=owner_mid,
        member_ids=[owner_mid, anon_mid],
        amount=10.0,
    )
    seed_r = owner_client.post(f"/sessions/{sid}/bills", json=body)
    assert seed_r.status_code == 201, seed_r.text
    bid = seed_r.json()["id"]

    # The attacker: a fresh client, no cookies, no headers.
    attacker = TestClient(app)

    target_path = path.format(sid=sid, bid=bid)
    if method == "POST" and path.endswith("/parse"):
        payload: dict[str, Any] = {"text": "午饭 50"}
    elif method == "POST":
        payload = _bill_body(
            payer_member_id=anon_mid,
            member_ids=[owner_mid, anon_mid],
            amount=1.0,
        )
    elif method == "PATCH":
        payload = {"amount": 200.0}
    else:  # DELETE
        payload = {}

    r = attacker.request(method, target_path, json=payload)
    assert r.status_code == 403, (
        f"{method} {target_path} without secret/cookie must be 403, "
        f"got {r.status_code}: {r.text}"
    )


# ---------------------------------------------------------------------------
# E.2.9 — wrong X-Nickname-Secret on POST → 403
# ---------------------------------------------------------------------------


def test_wrong_secret_returns_403_on_create(client: TestClient) -> None:
    """Wrong secret must NOT match any SessionMember row → 403."""
    _reset_db()
    sid, owner_mid, _, anon_mid = _make_session_with_owner_and_anon()
    attacker = TestClient(app)
    body = _bill_body(
        payer_member_id=anon_mid,
        member_ids=[owner_mid, anon_mid],
        amount=1.0,
    )
    r = attacker.post(
        f"/sessions/{sid}/bills",
        json=body,
        headers={"X-Nickname-Secret": secrets.token_hex(32)},  # wrong
    )
    assert r.status_code == 403, r.text


# ---------------------------------------------------------------------------
# E.2.10 — logged-in user WITHOUT secret header still works (cookie path)
# ---------------------------------------------------------------------------


def test_logged_in_user_without_secret_still_works(client: TestClient) -> None:
    """Regression: the cookie auth path must remain functional after the
    BE dependency change to ``get_session_member_or_secret``. If this
    regresses, every existing logged-in user breaks (反 #51 continuity).
    """
    _reset_db()
    sid, owner_mid, _, anon_mid = _make_session_with_owner_and_anon()
    owner_client, owner = _login_as("alice@anon-bills.local")

    body = _bill_body(
        payer_member_id=owner_mid,
        member_ids=[owner_mid, anon_mid],
        amount=77.0,
        description="logged-in path still works",
    )
    r = owner_client.post(f"/sessions/{sid}/bills", json=body)
    # No X-Nickname-Secret header — should still succeed via cookie.
    assert r.status_code == 201, r.text
    bill = r.json()
    assert bill["amount"] == 77.0

    # created_by should be the logged-in user's id (NOT NULL).
    db = SessionLocal()
    try:
        b = db.query(Bill).filter_by(id=bill["id"]).one()
        assert b.created_by == owner.id
    finally:
        db.close()


# ---------------------------------------------------------------------------
# E.2.11 — logged-in owner can still PATCH + DELETE (cookie path)
# ---------------------------------------------------------------------------


def test_logged_in_owner_can_still_patch_and_delete(client: TestClient) -> None:
    """Regression: the existing PATCH/DELETE cookie path must still
    work. The v0.3.2 BE dep change is supposed to be additive (or_secret
    is a SUPERSET of get_session_member), not destructive.
    """
    _reset_db()
    sid, owner_mid, _, anon_mid = _make_session_with_owner_and_anon()
    owner_client, _ = _login_as("alice@anon-bills.local")

    body = _bill_body(
        payer_member_id=owner_mid,
        member_ids=[owner_mid, anon_mid],
        amount=10.0,
        description="cookie CRUD",
    )
    r = owner_client.post(f"/sessions/{sid}/bills", json=body)
    bid = r.json()["id"]

    r = owner_client.patch(
        f"/sessions/{sid}/bills/{bid}", json={"amount": 99.0}
    )
    assert r.status_code == 200, r.text
    assert r.json()["amount"] == 99.0

    r = owner_client.delete(f"/sessions/{sid}/bills/{bid}")
    assert r.status_code == 204, r.text


# ---------------------------------------------------------------------------
# 反 #81 — 3 placeholder tests for v0.3.2 known bugs
# ---------------------------------------------------------------------------
#
# These tests are SKIPPED today but document the root causes of the
# three fixes shipped in v0.3.2. If any of these bugs resurfaces,
# copy the template body, replace the skip with `assert ...`, and
# you'll have a regression test in 30 seconds.
# ---------------------------------------------------------------------------


@pytest.mark.skip(
    reason="反 #81 template placeholder — copy-paste when a new anon-create bug lands"
)
def test_fixme_regression_fe_createbill_sends_secret_header() -> None:
    """v0.3.2 root cause #1 (反 #51续): ``bills.ts::createBill`` did NOT
    pass ``X-Nickname-Secret`` even though the BE accepted it. The fix
    is a FE-only change in ``apiFetch`` 3rd-arg wiring.

    Placeholder template:
        r = await page.request.post(
            f"/api/sessions/{sid}/bills",
            data=body,
            headers={"X-Nickname-Secret": secret},
        )
        assert r.status() == 201
    """


@pytest.mark.skip(
    reason="反 #81 template placeholder — copy-paste when BE PATCH/DELETE anon regresses"
)
def test_fixme_regression_be_patch_delete_accept_anon() -> None:
    """v0.3.2 root cause #2: ``bills.py::update_bill`` and ``delete_bill``
    used ``Depends(get_session_member)`` which only matches ``user_id``
    bindings. The fix swaps both to ``Depends(get_session_member_or_secret)``.

    Placeholder template: see ``test_anon_can_patch_bill_with_secret``
    and ``test_anon_can_delete_bill_with_secret`` above.
    """


@pytest.mark.skip(
    reason="反 #81 template placeholder — copy-paste when the UI section head regresses"
)
def test_fixme_regression_ui_two_buttons_in_bills_section_head() -> None:
    """v0.3.2 root cause #3: the bills section head had only one button
    (「个人账单」). The fix adds 「查看结算」 next to it, both as ghost
    buttons with Lucide icons (calculator / user). Verified by
    ``frontend/e2e/anon_bill_crud.spec.ts`` scenario E.

    Placeholder template:
        page.goto("/sessions/{sid}")
        await expect(page.locator('a:has-text("查看结算")')).toBeVisible()
        await expect(page.locator('a:has-text("个人账单")')).toBeVisible()
    """