"""v0.1.1 per-session fixed invite token

Replaces the session_invites table (one row per invite) with a single
invite_token column on the sessions table (one token per session, 30-day
TTL, rotatable by the owner). See SPEC sec 3.4.2 for product rationale and
sec 4 for the API contract.

Why this migration
------------------
- Add 3 columns to ``sessions``: invite_token (str, unique), invite_expires_at
  (tz-aware datetime), invite_created_at (tz-aware datetime).
- Backfill every pre-existing session row with a fresh token + 30-day TTL
  so the data is immediately usable (no NULL holes).
- Make invite_token NOT NULL + add a unique index so it can stand in for the
  old session_invites.token index for lookups.
- Drop the old ``session_invites`` table. v0.1 has not been released, so
  there are no production invite rows to preserve (any dev / test data is
  regenerated on session create).

SQLite gotcha
-------------
``ALTER TABLE ADD COLUMN ... DEFAULT (CURRENT_TIMESTAMP)`` fails on SQLite
because the function call is not a constant. We therefore omit the
``server_default`` on the new invite_created_at column here -- the model
itself carries ``server_default=func.now()`` for fresh CREATE TABLE
statements, and we backfill all existing rows immediately so no NULL holes
remain.

Backward compatibility
----------------------
``downgrade()`` recreates the ``session_invites`` table with the original
columns (the v0.1 shape, prior to T09's lifecycle migration), drops the
unique index, and removes the three invite columns. NOTE: this cannot
recover any invite rows that existed before the upgrade (we drop the
table), only the schema. v0.1 has no shipped data to preserve.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "181c0c376a4b"
down_revision: Union[str, Sequence[str], None] = "add_session_invite_lifecycle"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add per-session invite columns + backfill + drop session_invites."""
    # 1) Add 3 columns to sessions (nullable first so we can backfill).
    op.add_column(
        "sessions",
        sa.Column("invite_token", sa.String(length=128), nullable=True),
    )
    op.add_column(
        "sessions",
        sa.Column("invite_expires_at", sa.DateTime(timezone=True), nullable=True),
    )
    # NOTE: SQLite rejects ALTER TABLE ADD COLUMN with a non-constant
    # DEFAULT (CURRENT_TIMESTAMP). The model carries server_default=func.now()
    # for fresh CREATE TABLE statements, and we backfill all existing rows
    # immediately below so no NULL holes remain.
    op.add_column(
        "sessions",
        sa.Column("invite_created_at", sa.DateTime(timezone=True), nullable=True),
    )

    # 2) Backfill: generate a token + 30d expiry for every existing session.
    #    Use raw SQL because we need Python-side randomness (secrets).
    import secrets
    from datetime import datetime, timedelta, timezone

    bind = op.get_bind()
    rows = bind.execute(sa.text("SELECT id FROM sessions")).fetchall()
    now = datetime.now(timezone.utc)
    expires = now + timedelta(days=30)
    for row in rows:
        token = secrets.token_urlsafe(32)
        bind.execute(
            sa.text(
                "UPDATE sessions "
                "SET invite_token = :t, "
                "    invite_expires_at = :e, "
                "    invite_created_at = :c "
                "WHERE id = :i"
            ),
            {"t": token, "e": expires, "c": now, "i": row.id},
        )

    # 3) Tighten to NOT NULL + add the unique index.
    with op.batch_alter_table("sessions", schema=None) as batch_op:
        batch_op.alter_column("invite_token", existing_type=sa.String(length=128), nullable=False)
        batch_op.create_index(
            batch_op.f("ix_sessions_invite_token"),
            ["invite_token"],
            unique=True,
        )

    # 4) Drop session_invites -- v0.1 unreleased, no audit data to keep.
    op.drop_table("session_invites")


def downgrade() -> None:
    """Reverse: drop invite columns + recreate session_invites table.

    Note: any invite rows that existed BEFORE the upgrade are LOST (we
    dropped the table). This is acceptable for v0.1-dev; production
    rollbacks would need a backup of session_invites first.
    """
    # 1) Drop the invite columns + index first.
    with op.batch_alter_table("sessions", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_sessions_invite_token"))
        batch_op.drop_column("invite_created_at")
        batch_op.drop_column("invite_expires_at")
        batch_op.drop_column("invite_token")

    # 2) Recreate session_invites with the original v0.1 schema (pre-T09).
    op.create_table(
        "session_invites",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("session_id", sa.Integer(), nullable=False),
        sa.Column("token", sa.String(length=128), nullable=False),
        sa.Column("created_by", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked", sa.Boolean(), server_default="0", nullable=False),
        sa.Column("max_uses", sa.Integer(), nullable=True),
        sa.Column("use_count", sa.Integer(), server_default="0", nullable=False),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["session_id"], ["sessions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    with op.batch_alter_table("session_invites", schema=None) as batch_op:
        batch_op.create_index(
            batch_op.f("ix_session_invites_created_by"),
            ["created_by"],
            unique=False,
        )
        batch_op.create_index(
            batch_op.f("ix_session_invites_session_id"),
            ["session_id"],
            unique=False,
        )
        batch_op.create_index(
            batch_op.f("ix_session_invites_token"),
            ["token"],
            unique=True,
        )
