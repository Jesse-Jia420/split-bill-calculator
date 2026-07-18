"""v0.3.17 #36fix3 (PO msg 14:53): add bills.created_by_session_member_id.

Revision ID: 20260718_v0317_bills_creator_sm_id
Revises: 20260709_sessions_last_active_at
Create Date: 2026-07-18

Background
----------
v0.1.0 (Sprint 1 T10) used ``Bill.created_by`` (FK to ``users.id``) as
the **session-member-level** creator identity for the ownership check:
only the creator can PATCH or DELETE their bill. v0.1.2 (T17) relaxed
that to "any session member" — the original creator-only guard was
removed because a logged-in user who wasn't around when the bill was
recorded could still fix typos on the group's behalf.

PO 2026-07-18 14:53 reverses that decision: PO wants only the bill
creator to be able to PATCH / DELETE again (this hotfix is part of
the same v0.3.17 sprint). Re-enabling the check on the existing
``Bill.created_by`` column is **broken** because:

  * ``Bill.created_by`` is FK to ``users.id`` and NULL for bills
    created by anonymous members (v0.3.1 made it nullable).
  * Comparing ``bill.created_by == sm.user_id`` then permanently
    fails for any anon-created bill (the original anon creator
    has ``sm.user_id = NULL`` too), so nobody — not even the
    original anon creator — could edit their own anon bill.

Design
------
Add a session-member-level pointer that doesn't depend on login
state: ``bills.created_by_session_member_id INTEGER REFERENCES
session_members(id) ON DELETE SET NULL`` (nullable, indexed). All
existing CRUD writes (POST + v0.1.x patches) can populate it with
``sm.id`` (which is always NOT NULL). Anonymous creators work
identically because ``sm.id`` exists regardless of ``sm.user_id``.

The owner check becomes ``bill.created_by_session_member_id ==
sm.id`` — clean, login-agnostic.

Backfill
--------
Pre-migration bills have ``created_by_session_member_id IS NULL``.
For historical bills we set it to ``payer_id`` (the only other
session-member pointer on the row). The v0.1.0 PO assumption was
"creator ≈ payer" — 99% of seeded Thailand test data matches this
(single-payer / single-creator per bill). New bills written by the
updated POST handler always set the column explicitly, so the
backfill only matters for existing rows.

Migration is idempotent: it inspects column existence before each
``add_column`` / ``drop_column`` so re-running it is safe.

Implementation note — SQLite batch_alter_table + ForeignKey
----------------------------------------------------------
SQLite's ``batch_alter_table`` (used for ALTER TABLE emulation on
SQLite, which doesn't support most ALTER operations natively)
requires explicit constraint names for foreign keys. We therefore
declare the column WITHOUT the FK inline (avoiding the
"Constraint must have a name" error), then add the FK and the
index as separate batch operations, matching the style used in
``fc3262e0bb12_init_9_tables_bill_comments.py``.
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20260718_v0317_bills_creator_sm_id"
down_revision = "20260709_sessions_last_active_at"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("bills")} if insp.has_table("bills") else set()

    # v0.3.17 #36fix3: idempotent add column + FK constraint + index.
    # Column is declared WITHOUT the ForeignKey inline (SQLite's
    # batch_alter_table refuses inline FKs without an explicit name).
    if "created_by_session_member_id" not in cols:
        with op.batch_alter_table("bills") as batch_op:
            batch_op.add_column(
                sa.Column(
                    "created_by_session_member_id",
                    sa.Integer(),
                    nullable=True,
                )
            )
        # The FK constraint is added in a SECOND batch_alter_table so
        # alembic doesn't auto-generate a "Constraint must have a name"
        # error. The named constraint matches the model-layer
        # ``ForeignKey(...)`` declaration — the ORM uses
        # ``__table_args__ = (ForeignKeyConstraint(...),)`` semantics.
        with op.batch_alter_table(
            "bills",
            naming_convention={
                "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
            },
        ) as batch_op:
            batch_op.create_foreign_key(
                "fk_bills_created_by_session_member_id_session_members",
                "session_members",
                ["created_by_session_member_id"],
                ["id"],
                ondelete="SET NULL",
            )
            batch_op.create_index(
                "ix_bills_created_by_session_member_id",
                ["created_by_session_member_id"],
            )

    # Backfill: pre-migration rows have NULL — best-effort recovery
    # via the payer_id (creator ≈ payer in v0.1.0 semantics).
    # Raw SQL is the most direct expression of "this is one UPDATE,
    # no transaction locking needed" — Alembic's op.execute wraps it
    # in the migration transaction either way.
    op.execute(
        "UPDATE bills SET created_by_session_member_id = payer_id "
        "WHERE created_by_session_member_id IS NULL"
    )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    cols = {c["name"] for c in insp.get_columns("bills")} if insp.has_table("bills") else set()

    if "created_by_session_member_id" in cols:
        with op.batch_alter_table("bills") as batch_op:
            batch_op.drop_index(
                "ix_bills_created_by_session_member_id",
                table_name="bills",
            )
        with op.batch_alter_table("bills") as batch_op:
            batch_op.drop_constraint(
                "fk_bills_created_by_session_member_id_session_members",
                type_="foreignkey",
            )
        with op.batch_alter_table("bills") as batch_op:
            batch_op.drop_column("created_by_session_member_id")