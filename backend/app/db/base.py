"""SQLAlchemy declarative base. All ORM models import Base from here."""
from __future__ import annotations

from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    """Project-wide declarative base."""
    pass


# Importing the models package registers tables on Base.metadata so that
# Alembic autogenerate can see them.
def _register_models() -> None:
    from app.db import models  # noqa: F401
    from app.db.models import (  # noqa: F401
        auth_tokens,
        bill_comments,
        bill_participants,
        bills,
        session_invites,
        session_members,
        sessions,
        users,
        verification_codes,
    )


_register_models()
