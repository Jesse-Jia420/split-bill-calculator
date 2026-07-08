"""A session = one bill-tracking group (e.g. 'Bangkok 2026-06').

v0.1.1 redesign (2026-06-30): each session now carries ONE fixed invite
token (with 30-day TTL, rotatable by the owner) instead of a separate
session_invites table with many per-link rows. See SPEC §3.4.2.

v0.2.2 (2026-07-03): multi-currency support (PRD §3.7). Each session
now declares its currency set (max 2) and a primary currency that
settlement aggregates into. Existing sessions backfill to
``currencies=["CNY"]`` / ``primary_currency="CNY"`` via the alembic
migration (f3a2e3b592b8_v022_multi_currency).
"""
from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, JSON, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base

if TYPE_CHECKING:
    from app.db.models.bills import Bill
    from app.db.models.session_exchange_rates import SessionExchangeRate
    from app.db.models.session_members import SessionMember
    from app.db.models.settlements import Settlement
    from app.db.models.users import User


class Session(Base):  # noqa: F811 — intentional re-export as BillSession in models/__init__
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    # v0.3 (PRD §3.10): nullable for anonymous session creation.
    owner_user_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True
    )
    # v0.3.x (PRD §3.11): verified email of the owner; NULL until the
    # anonymous creator hits POST /sessions/{id}/claim (the
    # "🔐 登录以保存" button on the detail page). Mirrors the users.email
    # column width (255) since they are semantically the same value.
    # No index -- the claim endpoint looks up by sessions.id, never scans
    # this column (PRD §3.11.2 + §3.11.8).
    owner_email: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    archived: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="0"
    )

    # ---- v0.1.1: per-session fixed invite token ----------------------------
    # One token per session, generated on session create. Rotatable by the
    # owner via POST /sessions/{id}/invite/rotate. 30-day TTL (configurable
    # via settings.invite_ttl_days). The token is 32-byte URL-safe (256 bits
    # of entropy); we store it in clear text because it's already a random
    # secret (hashing buys nothing extra -- see SPEC sec 3.4.2).
    invite_token: Mapped[str] = mapped_column(
        String(128), unique=True, nullable=False, index=True
    )
    invite_expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    invite_created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # ------------------------------------------------------------------------

    # ---- v0.3.x §3.11.11: 7-day active window (PRD §3.11.11 + SPEC §3) --
    # ``last_active_at`` is set at session create (server default now())
    # and bumped whenever the owner performs a join-claim / claim / etc.
    # The 7-day TTL on the invite link is measured from this column — NOT
    # from invite_expires_at (which is unrelated to activity). When the
    # delta exceeds 7 days the session is reclaimed (GET endpoints 410).
    last_active_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # ``expired_notice_sent_at`` is NULL until the (deferred) 2-day-prior
    # cron sets it. Today the cron is out of scope (SPEC §6), but the
    # column is created now so a future migration needs no backfill.
    expired_notice_sent_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # ------------------------------------------------------------------------

    # ---- v0.3.1: public-facing unguessable session code (Bug & Issues #5).
    # 10-char URL-safe alphabet (no 0/O/1/l/I confusion); ~10^15 space.
    # Exposed in the SessionDetail response so the FE can build invite
    # links like /s/{code} instead of leaking the integer id in URLs.
    session_code: Mapped[str] = mapped_column(
        String(12), unique=True, nullable=False, index=True
    )
    # ------------------------------------------------------------------------

    # ---- v0.2.2: multi-currency (PRD §3.7) ------------------------------
    # ``currencies`` is a JSON array of 1 or 2 ISO 4217 currency codes
    # (e.g. ``["CNY"]`` or ``["THB", "CNY"]``). The first element is
    # implicitly the default; ``primary_currency`` is the settlement
    # aggregation target and MUST be one of ``currencies``. Application
    # layer enforces the 1-2 length and value-in-SUPPORTED_CURRENCIES
    # constraints (Pydantic validator on SessionCreate). DB-level
    # defaults are CNY-only for backfill.
    currencies: Mapped[list[str]] = mapped_column(
        JSON, nullable=False, default=lambda: ["CNY"], server_default='["CNY"]'
    )
    primary_currency: Mapped[str] = mapped_column(
        String(8), nullable=False, default="CNY", server_default="CNY"
    )
    # ------------------------------------------------------------------------

    # v0.3: owner can be NULL (anonymous session). Relationship uses
    # lazy='select' to handle NULL FK gracefully.
    owner: Mapped[Optional["User"]] = relationship(
        back_populates="owned_sessions",
        foreign_keys=[owner_user_id],
        lazy="select",
    )
    members: Mapped[list["SessionMember"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )
    bills: Mapped[list["Bill"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )
    settlements: Mapped[list["Settlement"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )
    exchange_rates: Mapped[list["SessionExchangeRate"]] = relationship(
        back_populates="session", cascade="all, delete-orphan"
    )
