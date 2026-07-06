"""v031_session_code

Revision ID: 20260707_session_code
Revises: 20260706145026
Create Date: 2026-07-06 18:30:00.000000

v0.3.1 Bug & Issues #5 — PO wants unguessable session codes in invite links.

Changes:
1. sessions.session_code: VARCHAR(12) NULL — nanoid-style 10-char URL-safe code.
   - Generated at session creation (create_session).
   - Existing rows: backfilled with a random code so the column can be NOT NULL.
   - UNIQUE constraint on session_code.
2. (No API changes yet — InviteLinkButton continues to use /sessions/{id} until
    the FE-side /s/{code} route lands. session_code is exposed via SessionDetail
    so the FE can adopt it next iteration.)
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision: str = "20260707_session_code"
down_revision: Union[str, Sequence[str], None] = "20260706145026"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# URL-safe alphabet (no 0/O/1/l/I confusion). 10 chars = 32^10 ≈ 10^15 space.
_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _generate_code() -> str:
    """Deterministic backfill per row using random — but safe under SQLite
    because we just need 10 unique chars from the alphabet."""
    import secrets
    return "".join(secrets.choice(_ALPHABET) for _ in range(10))


def upgrade() -> None:
    bind = op.get_bind()
    insp = inspect(bind)

    if "session_code" not in [c["name"] for c in insp.get_columns("sessions")]:
        # Add as NULLable first; we'll backfill then enforce NOT NULL.
        with op.batch_alter_table("sessions") as batch:
            batch.add_column(sa.Column("session_code", sa.String(12), nullable=True))
        # Backfill existing rows (Python loop to call random for each row).
        rows = bind.execute(sa.text("SELECT id FROM sessions")).fetchall()
        for (sid,) in rows:
            code = _generate_code()
            # Retry on UNIQUE collision (extremely unlikely at 10^15).
            for _ in range(8):
                existing = bind.execute(
                    sa.text("SELECT 1 FROM sessions WHERE session_code = :c"), {"c": code}
                ).fetchone()
                if not existing:
                    break
                code = _generate_code()
            bind.execute(
                sa.text("UPDATE sessions SET session_code = :c WHERE id = :i"),
                {"c": code, "i": sid},
            )
        # Enforce NOT NULL + UNIQUE.
        with op.batch_alter_table("sessions") as batch:
            batch.alter_column("session_code", existing_type=sa.String(12), nullable=False)
            batch.create_unique_constraint("uq_sessions_session_code", ["session_code"])


def downgrade() -> None:
    with op.batch_alter_table("sessions") as batch:
        batch.drop_constraint("uq_sessions_session_code", type_="unique")
        batch.drop_column("session_code")