"""Auth API router — T05: POST /auth/send-code.

v0.1 sends the verification code to the user's email and returns 200.
It does NOT persist the code to ``verification_codes`` yet — that lands
in T06 (auth full lifecycle) per the sprint plan. This is the minimum
end-to-end slice that proves the SMTP integration works.
"""
from __future__ import annotations

import logging
import re

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.core.config import settings
from app.services.email_service import (
    EmailAuthError,
    EmailError,
    EmailNetworkError,
    EmailService,
)
from app.services.verification_code import generate_code

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

# Defensive local regex (a normal, reasonable email pattern).
# Using a plain ``str`` here (not pydantic's EmailStr) so we can return
# a clean 400 with the documented response shape, instead of pydantic's
# default 422 validation-error body.
_EMAIL_RE = re.compile(r"^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$")


class SendCodeRequest(BaseModel):
    email: str = Field(..., description="Recipient email address", min_length=3, max_length=254)


class SendCodeResponse(BaseModel):
    sent: bool
    email: str
    ttl_minutes: int


@router.post("/send-code", response_model=SendCodeResponse)
async def send_verification_code(payload: SendCodeRequest) -> SendCodeResponse:
    """Send a 6-digit verification code to ``payload.email``.

    Response codes:
    - 200: code sent (or attempted) successfully.
    - 400: email format is invalid.
    - 500: SMTP error (auth or network).
    """
    email = payload.email.strip()

    # Regex check — single source of truth for the 400 response shape.
    if not _EMAIL_RE.match(email):
        raise HTTPException(status_code=400, detail={"error": "invalid email format"})

    code = generate_code()
    ttl = settings.verification_code_ttl_minutes

    service = EmailService(settings)
    try:
        await service.send_verification_code(email, code, ttl)
    except EmailAuthError as exc:
        logger.error("send-code: SMTP auth failed for %s", email)
        raise HTTPException(
            status_code=500,
            detail={"error": f"send failed: {exc}"},
        ) from exc
    except EmailNetworkError as exc:
        logger.error("send-code: SMTP network error for %s", email)
        raise HTTPException(
            status_code=500,
            detail={"error": f"send failed: {exc}"},
        ) from exc
    except EmailError as exc:
        logger.error("send-code: SMTP error for %s", email)
        raise HTTPException(
            status_code=500,
            detail={"error": f"send failed: {exc}"},
        ) from exc

    return SendCodeResponse(sent=True, email=email, ttl_minutes=ttl)
