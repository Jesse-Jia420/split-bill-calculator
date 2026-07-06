"""v030_anon_nickname

Revision ID: 20260706145026
Revises: f3a2e3b592b8
Create Date: 2026-07-06 14:50:00.000000

v0.3 Sprint 4 — anonymous participation (PRD §3.10).

Changes:
1. sessions.owner_user_id: NOT NULL → NULLABLE (anonymous creators)
2. session_members.nickname_secret: VARCHAR(64) NULL — hex secret, generated on claim
3. session_members.is_anon: BOOLEAN NOT NULL DEFAULT false — true when user_id IS NULL
4. session_members.claimed_at: TIMESTAMP NULL — when the nickname was claimed

All ops are idempotent (has_column guards).
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect
from sqlalchemy.engine.reflection import Inspector


revision: str = "20260706145026"
down_revision: Union[str, Sequence[str], None] = "f3a2e3b592b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _has_column(table: str, col: str) -> bool:
    bind = op.get_bind()
    insp: Inspector = inspect(bind)
    return col in [c["name"] for c in insp.get_columns(table)]


def upgrade() -> None:
    # ---- 1. sessions.owner_user_id → NULLABLE -----------------------------
    # SQLite does not support ALTER COLUMN ... DROP NOT NULL, so we use
    # batch_alter_table which recreates the table.
    if _has_column("sessions", "owner_user_id"):
        bind = op.get_bind()
        insp: Inspector = inspect(bind)
        col_info = next(
            (c for c in insp.get_columns("sessions") if c["name"] == "owner_user_id"),
            None,
        )
        if col_info and not col_info.get("nullable", False):
            with op.batch_alter_table("sessions") as batch:
                batch.alter_column(
                    "owner_user_id",
                    existing_type=sa.Integer(),
                    nullable=True,
                )

    # ---- 2. session_members.user_id → NULLABLE ---------------------------
    # v0.3 (PRD §3.10): anonymous members have user_id=NULL.
    if _has_column("session_members", "user_id"):
        bind = op.get_bind()
        insp: Inspector = inspect(bind)
        col_info = next(
            (c for c in insp.get_columns("session_members") if c["name"] == "user_id"),
            None,
        )
        if col_info and not col_info.get("nullable", False):
            with op.batch_alter_table("session_members") as batch:
                batch.alter_column(
                    "user_id",
                    existing_type=sa.Integer(),
                    nullable=True,
                )

    # ---- 3. session_members.nickname_secret -------------------------------
    if not _has_column("session_members", "nickname_secret"):
        op.add_column(
            "session_members",
            sa.Column("nickname_secret", sa.String(64), nullable=True),
        )

    # ---- 4. session_members.is_anon --------------------------------------
    if not _has_column("session_members", "is_anon"):
        op.add_column(
            "session_members",
            sa.Column(
                "is_anon",
                sa.Boolean(),
                nullable=False,
                server_default="false",
            ),
        )

    # ---- 5. session_members.claimed_at -----------------------------------
    if not _has_column("session_members", "claimed_at"):
        op.add_column(
            "session_members",
            sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
        )


def downgrade() -> None:
    # ---- Reverse 5: drop claimed_at ----------------------------------------
    if _has_column("session_members", "claimed_at"):
        op.drop_column("session_members", "claimed_at")

    # ---- Reverse 4: drop is_anon ------------------------------------------
    if _has_column("session_members", "is_anon"):
        op.drop_column("session_members", "is_anon")

    # ---- Reverse 3: drop nickname_secret ----------------------------------
    if _has_column("session_members", "nickname_secret"):
        op.drop_column("session_members", "nickname_secret")

    # ---- Reverse 2: session_members.user_id → NOT NULL --------------------
    if _has_column("session_members", "user_id"):
        bind = op.get_bind()
        insp: Inspector = inspect(bind)
        col_info = next(
            (c for c in insp.get_columns("session_members") if c["name"] == "user_id"),
            None,
        )
        if col_info and col_info.get("nullable", True):
            with op.batch_alter_table("session_members") as batch:
                batch.alter_column(
                    "user_id",
                    existing_type=sa.Integer(),
                    nullable=False,
                )

    # ---- Reverse 1: sessions.owner_user_id → NOT NULL --------------------
    if _has_column("sessions", "owner_user_id"):
        bind = op.get_bind()
        insp: Inspector = inspect(bind)
        col_info = next(
            (c for c in insp.get_columns("sessions") if c["name"] == "owner_user_id"),
            None,
        )
        if col_info and col_info.get("nullable", True):
            with op.batch_alter_table("sessions") as batch:
                batch.alter_column(
                    "owner_user_id",
                    existing_type=sa.Integer(),
                    nullable=False,
                )
