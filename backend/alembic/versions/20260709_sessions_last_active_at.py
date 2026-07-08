"""§3.11.11: add sessions.last_active_at + expired_notice_sent_at columns.

Revision ID: 20260709_sessions_last_active_at
Revises: 20260708_add_sessions_owner_email
Create Date: 2026-07-09

v0.3.x §3.11.11 (PRD §3.11.11 — PO 2026-07-08 17:41 拍板 + SPEC §3):
- ``last_active_at`` is set at session creation (default CURRENT_TIMESTAMP)
  and updated whenever the owner performs an activity that proves the
  session is still in use. The 7-day expiry window is measured from this
  column (not from invite_expires_at, which is unrelated to activity).
- ``expired_notice_sent_at`` is NULL until the 2-day-prior cron sets it.
  It exists today so the cron (deferred to a later sprint) can idempotently
  skip already-notified owners; not enforcing a column now means a future
  migration would need a default backfill.

Both columns are nullable=False / null for the notice column so a single
DDL covers the existing rows: existing rows get ``last_active_at = now``
(via the server default) and ``expired_notice_sent_at = NULL`` (already
NULL by definition).

Migration is idempotent via ``inspect().has_column`` — see SPEC §D.
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20260709_sessions_last_active_at"
down_revision = "20260708_add_sessions_owner_email"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("sessions")} if insp.has_table("sessions") else set()
    with op.batch_alter_table("sessions") as batch_op:
        if "last_active_at" not in cols:
            batch_op.add_column(
                sa.Column(
                    "last_active_at",
                    sa.DateTime(timezone=True),
                    nullable=False,
                    server_default=sa.func.now(),
                )
            )
        if "expired_notice_sent_at" not in cols:
            batch_op.add_column(
                sa.Column(
                    "expired_notice_sent_at",
                    sa.DateTime(timezone=True),
                    nullable=True,
                )
            )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("sessions")} if insp.has_table("sessions") else set()
    with op.batch_alter_table("sessions") as batch_op:
        if "expired_notice_sent_at" in cols:
            batch_op.drop_column("expired_notice_sent_at")
        if "last_active_at" in cols:
            batch_op.drop_column("last_active_at")