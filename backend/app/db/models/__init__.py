"""All SQLAlchemy ORM models. Importing this package registers every table on
Base.metadata so Alembic autogenerate picks them up.

v0.1.1: session_invites table is dropped (SessionInvite removed). The
invite token now lives as columns on the Session model.
"""
from app.db.models.auth_tokens import AuthToken
from app.db.models.bill_comments import BillComment
from app.db.models.bill_participants import BillParticipant
from app.db.models.bills import Bill
from app.db.models.session_members import SessionMember
from app.db.models.sessions import Session as BillSession
from app.db.models.settlements import Settlement
from app.db.models.users import User
from app.db.models.verification_codes import (
    VerificationCode,
    VerificationPurpose,
)

__all__ = [
    "AuthToken",
    "Bill",
    "BillComment",
    "BillParticipant",
    "BillSession",
    "SessionMember",
    "Settlement",
    "User",
    "VerificationCode",
    "VerificationPurpose",
]
