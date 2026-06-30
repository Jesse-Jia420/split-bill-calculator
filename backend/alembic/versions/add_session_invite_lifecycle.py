"""extend session_invites with TTL + accept tracking + soft-delete

Revision ID: add_session_invite_lifecycle
Revises: fc3262e0bb12
Create Date: 2026-06-30 11:30:00.000000

Why this migration
------------------
Sprint 1 T07-T09 (sessions + invites API) require the invite row to
carry:

- expires_at  - TTL for the invite link. T09 default = 30 days
  (settings.invite_ttl_days). Used by GET /api/invites/{token} and
  POST /api/invites/{token}/accept to reject expired invites with
  HTTP 410.
- used_at     - timestamp the invite was accepted. Distinguishes
  "active" from "accepted" without touching revoked.
- accepted_by_user_id - FK to the user who accepted. Lets us
  surface the joiner in audit / future activity feeds without a join
  through session_members. (T09 returns this in the accept response.)
- deleted_at  - soft-delete timestamp. Set by
  DELETE /api/sessions/{id}/invites/{iid} (owner-only).
  Used to distinguish "revoked by owner" from "still active" without
  overloading the existing revoked boolean.

revoked (existing boolean) is left in place for v0.2 features (e.g.
rate-limited revocation reasons) but is no longer the source of truth
for the public invite status - deleted_at is.

Backfill
--------
Existing rows (pre-T09) get expires_at = created_at + 30 days as
a best-effort default so any pre-existing invite link keeps working
until a sensible cutoff. used_at / accepted_by_user_id /
deleted_at default to NULL.
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op


# revision identifiers, used by Alembic.
revision: str = "add_session_invite_lifecycle"
down_revision: Union[str, Sequence[str], None] = "fc3262e0bb12"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add lifecycle columns to session_invites (SQLite batch mode)."""
    with op.batch_alter_table("session_invites", schema=None) as batch_op:
        batch_op.add_column(
            sa.Column(
                "expires_at",
                sa.DateTime(timezone=True),
                nullable=True,  # backfilled below
            )
        )
        batch_op.add_column(
            sa.Column(
                "used_at",
                sa.DateTime(timezone=True),
                nullable=True,
            )
        )
        batch_op.add_column(
            sa.Column(
                "accepted_by_user_id",
                sa.Integer(),
                nullable=True,
            )
        )
        batch_op.add_column(
            sa.Column(
                "deleted_at",
                sa.DateTime(timezone=True),
                nullable=True,
            )
        )
        batch_op.create_index(
            batch_op.f("ix_session_invites_accepted_by_user_id"),
            ["accepted_by_user_id"],
            unique=False,
        )
        batch_op.create_foreign_key(
            "fk_session_invites_accepted_by_user_id_users",
            "users",
            ["accepted_by_user_id"],
            ["id"],
            ondelete="SET NULL",
        )

    # Backfill: every pre-existing invite gets expires_at = created_at + 30d.
    # SQLite batch_alter_table doesn't support server-side expressions; do it
    # explicitly. We treat the 30d window as a reasonable default so any
    # leftover links still work long enough for a clean handoff.
    conn = op.get_bind()
    conn.execute(
        sa.text(
            "UPDATE session_invites "
            "SET expires_at = datetime(created_at, '+30 days') "
            "WHERE expires_at IS NULL"
        )
    )


def downgrade() -> None:
    """Reverse: drop indexes + columns."""
    with op.batch_alter_table("session_invites", schema=None) as batch_op:
        batch_op.drop_index(batch_op.f("ix_session_invites_accepted_by_user_id"))
        batch_op.drop_constraint(
            "fk_session_invites_accepted_by_user_id_users",
            type_="foreignkey",
        )
        batch_op.drop_column("deleted_at")
        batch_op.drop_column("accepted_by_user_id")
        batch_op.drop_column("used_at")
        batch_op.drop_column("expires_at")
