"""Tests for ``scripts.seed_dev_data`` (Sprint 2 — anti-pattern #46 fix).

Strategy
--------
- Uses a temporary SQLite DB for isolation — never touches the dev
  ``data/sbc.db``. We swap ``app.core.database.engine`` and
  ``SessionLocal`` for an in-process :memory: connection that lives
  for the duration of the test module.
- Verify (a) idempotency — running twice does NOT create duplicates;
  (b) ENV=production skip; (c) the hardcoded bill count matches the
  original xlsx (27 bills); (d) unrelated sessions are left alone.
"""
from __future__ import annotations

import importlib
import os
from pathlib import Path
from typing import Iterator

import pytest
import sqlalchemy as sa
from sqlalchemy.orm import sessionmaker


@pytest.fixture(scope="module")
def isolated_engine() -> Iterator[sa.engine.Engine]:
    """Swap the global engine/SessionLocal for a per-module temp file.

    Using a tempfile (not :memory:) keeps the connection-pool semantics
    realistic. We restore the original engine on teardown so other
    tests in the suite that import ``app.*`` are unaffected.
    """
    import app.core.database as db_mod

    original_engine = db_mod.engine
    original_sessionlocal = db_mod.SessionLocal
    original_settings_db = db_mod.settings.database_url

    tmp_db = Path("/tmp/test_seed_dev_data_sbc.db")
    if tmp_db.exists():
        tmp_db.unlink()
    test_url = f"sqlite:///{tmp_db}"

    # Apply the swap BEFORE importing models so they bind to the new engine.
    test_engine = sa.create_engine(
        test_url,
        connect_args={"check_same_thread": False},
        future=True,
    )
    TestSessionLocal = sessionmaker(
        bind=test_engine,
        autocommit=False,
        autoflush=False,
        expire_on_commit=False,
    )

    db_mod.engine = test_engine
    db_mod.SessionLocal = TestSessionLocal
    # Also patch the env so subsequent imports resolve the same URL.
    os.environ["DATABASE_URL"] = test_url
    db_mod.settings.database_url = test_url

    # Create schema. Importing models registers them on Base.metadata;
    # we then ``create_all`` against the new engine.
    from app.db.base import Base  # noqa: WPS433 — late import on purpose
    import app.db.models  # noqa: F401, WPS433 — register all tables

    Base.metadata.create_all(test_engine)

    try:
        yield test_engine
    finally:
        db_mod.engine = original_engine
        db_mod.SessionLocal = original_sessionlocal
        db_mod.settings.database_url = original_settings_db
        os.environ.pop("DATABASE_URL", None)
        test_engine.dispose()
        if tmp_db.exists():
            tmp_db.unlink()


@pytest.fixture(autouse=True)
def _reset_state(
    isolated_engine: sa.engine.Engine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Truncate all tables between tests so the seed runs are reproducible.

    Also ensures the seed does NOT short-circuit on a stray production
    env from the surrounding shell.
    """
    monkeypatch.delenv("ENV", raising=False)
    # Rebuild schema from scratch — the cheapest isolation guarantee.
    from app.db.base import Base
    import app.db.models  # noqa: F401
    Base.metadata.drop_all(isolated_engine)
    Base.metadata.create_all(isolated_engine)


def _reload_seed_module() -> "object":
    """Reload the seed module so module-level constants stay fresh."""
    import scripts.seed_dev_data as mod

    return importlib.reload(mod)


def _session():
    import app.core.database as db_mod

    return db_mod.SessionLocal()


def test_seed_creates_thailand_and_personal_sessions() -> None:
    """First run creates the two expected sessions + their members."""
    seed_mod = _reload_seed_module()
    result = seed_mod.seed_dev_data()

    assert "skipped" not in result
    assert result["bills_created"] == len(seed_mod.THAILAND_BILLS) == 27
    assert result["xinhua_user_id"] is not None
    assert result["thailand_session_id"] is not None
    assert result["personal_session_id"] is not None

    db = _session()
    try:
        from app.db.models.session_members import SessionMember
        from app.db.models.bills import Bill

        # Thailand: 5 members
        thailand_members = (
            db.query(SessionMember)
            .filter(SessionMember.session_id == result["thailand_session_id"])
            .count()
        )
        assert thailand_members == 5

        # Thailand: 27 bills
        thailand_bills = (
            db.query(Bill)
            .filter(Bill.session_id == result["thailand_session_id"])
            .count()
        )
        assert thailand_bills == 27

        # Personal: 1 owner-member, 0 bills
        personal_members = (
            db.query(SessionMember)
            .filter(SessionMember.session_id == result["personal_session_id"])
            .count()
        )
        assert personal_members == 1
        personal_bills = (
            db.query(Bill)
            .filter(Bill.session_id == result["personal_session_id"])
            .count()
        )
        assert personal_bills == 0

        from app.db.models.users import User

        xinhua = db.query(User).filter_by(email=seed_mod.TEST_USER_EMAIL).first()
        assert xinhua is not None
        assert xinhua.default_name == "Jesse"
    finally:
        db.close()


def test_seed_is_idempotent() -> None:
    """Running seed_dev_data twice must NOT create duplicates."""
    seed_mod = _reload_seed_module()

    r1 = seed_mod.seed_dev_data()
    r2 = seed_mod.seed_dev_data()

    # Session / user ids stay the same.
    assert r1["xinhua_user_id"] == r2["xinhua_user_id"]
    assert r1["thailand_session_id"] == r2["thailand_session_id"]
    assert r1["personal_session_id"] == r2["personal_session_id"]
    # First run creates 27 bills; second run creates 0.
    assert r1["bills_created"] == 27
    assert r2["bills_created"] == 0

    db = _session()
    try:
        from app.db.models.session_members import SessionMember
        from app.db.models.bills import Bill

        thailand_bills = (
            db.query(Bill)
            .filter(Bill.session_id == r1["thailand_session_id"])
            .count()
        )
        assert thailand_bills == 27

        thailand_members = (
            db.query(SessionMember)
            .filter(SessionMember.session_id == r1["thailand_session_id"])
            .count()
        )
        assert thailand_members == 5

        personal_members = (
            db.query(SessionMember)
            .filter(SessionMember.session_id == r1["personal_session_id"])
            .count()
        )
        assert personal_members == 1
    finally:
        db.close()


def test_seed_skipped_when_env_production(monkeypatch: pytest.MonkeyPatch) -> None:
    """ENV=production must short-circuit the seed (no rows created)."""
    monkeypatch.setenv("ENV", "production")
    seed_mod = _reload_seed_module()

    result = seed_mod.seed_dev_data()
    assert result == {"skipped": "ENV=production"}

    db = _session()
    try:
        from app.db.models.session_members import SessionMember
        from app.db.models.sessions import Session as BillSession
        from app.db.models.bills import Bill
        from app.db.models.users import User

        assert db.query(User).count() == 0
        assert db.query(BillSession).count() == 0
        assert db.query(SessionMember).count() == 0
        assert db.query(Bill).count() == 0
    finally:
        db.close()


def test_hardcoded_bill_count_matches_xlsx() -> None:
    """Sanity: the hardcoded THAILAND_BILLS list has 27 entries."""
    seed_mod = _reload_seed_module()
    assert len(seed_mod.THAILAND_BILLS) == 27
    for bill in seed_mod.THAILAND_BILLS:
        assert len(bill) == 5
        desc, amount, payer_idx, occurred_iso, pax = bill
        assert isinstance(desc, str) and desc
        assert isinstance(amount, float)
        assert 0 <= payer_idx <= 4
        assert isinstance(occurred_iso, str) and "T" in occurred_iso
        assert isinstance(pax, list) and 1 <= len(pax) <= 5
        for p in pax:
            assert 0 <= p <= 4


def test_seed_does_not_touch_unrelated_sessions() -> None:
    """Pre-existing sessions (e.g. Coder 12's 2903 合租花费) are left alone."""
    from datetime import datetime, timedelta, timezone

    from app.db.models.session_members import SessionMember
    from app.db.models.sessions import Session as BillSession
    from app.db.models.bills import Bill
    from app.db.models.users import User

    db = _session()
    try:
        # Plant an unrelated session owned by a different user.
        u = User(email="other@example.com", default_name="Other")
        db.add(u)
        db.flush()
        other_session = BillSession(
            name="2903 合租花费",
            owner_user_id=u.id,
            invite_token="other-token-xxx",
            invite_expires_at=datetime.now(timezone.utc) + timedelta(days=30),
            invite_created_at=datetime.now(timezone.utc),
        )
        db.add(other_session)
        db.commit()
        other_id = other_session.id
    finally:
        db.close()

    seed_mod = _reload_seed_module()
    seed_mod.seed_dev_data()

    db = _session()
    try:
        # The unrelated session is still there, untouched, still owned by
        # the original user (not xinhua), and still has 0 members.
        other = db.query(BillSession).filter(BillSession.id == other_id).first()
        assert other is not None
        xinhua = (
            db.query(User).filter_by(email=seed_mod.TEST_USER_EMAIL).first()
        )
        assert other.owner_user_id != xinhua.id
        assert (
            db.query(SessionMember).filter(SessionMember.session_id == other_id).count()
            == 0
        )
        assert db.query(Bill).filter(Bill.session_id == other_id).count() == 0
    finally:
        db.close()
