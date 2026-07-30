"""Public reference FX rates (Frankfurter / ECB).

Unauthenticated — used by the create-session wizard before a session exists,
and by CurrencyAddModal when picking a secondary currency.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Annotated

import httpx
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.api.sessions import SUPPORTED_CURRENCIES

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/exchange-rates", tags=["exchange-rates"])

FRANKFURTER_URL = "https://api.frankfurter.dev/v1/latest"
FETCH_TIMEOUT_S = 8.0


class ReferenceRateOut(BaseModel):
    from_currency: str
    to_currency: str
    rate: str = Field(..., description="Decimal string: 1 from = rate to")
    provider: str = "frankfurter"
    provider_date: str | None = Field(
        default=None, description="ECB / provider rate date (YYYY-MM-DD)"
    )
    fetched_at: str = Field(..., description="ISO-8601 UTC when we fetched")


@router.get("/reference", response_model=ReferenceRateOut)
async def get_reference_rate(
    from_currency: Annotated[str, Query(min_length=3, max_length=8, alias="from")],
    to_currency: Annotated[str, Query(min_length=3, max_length=8, alias="to")],
) -> ReferenceRateOut:
    """Return a live reference rate: 1 ``from`` = ``rate`` ``to``.

    Source: Frankfurter (ECB). Failures surface as 502 so the UI can keep
    the manual input empty and let the user type a rate.
    """
    src = from_currency.strip().upper()
    dst = to_currency.strip().upper()
    if src not in SUPPORTED_CURRENCIES or dst not in SUPPORTED_CURRENCIES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": "unsupported_currency",
                "supported_currencies": list(SUPPORTED_CURRENCIES),
            },
        )
    if src == dst:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error": "same_currency"},
        )

    fetched_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    try:
        async with httpx.AsyncClient(timeout=FETCH_TIMEOUT_S) as client:
            resp = await client.get(
                FRANKFURTER_URL,
                params={"from": src, "to": dst},
            )
            resp.raise_for_status()
            payload = resp.json()
    except httpx.HTTPError as exc:
        logger.warning("frankfurter fetch failed %s→%s: %s", src, dst, exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"error": "reference_rate_unavailable"},
        ) from exc

    rates = payload.get("rates") or {}
    raw = rates.get(dst)
    if raw is None:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"error": "reference_rate_unavailable", "reason": "missing_pair"},
        )
    try:
        rate = Decimal(str(raw))
    except (InvalidOperation, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"error": "reference_rate_unavailable", "reason": "bad_rate"},
        ) from exc
    if rate <= 0:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"error": "reference_rate_unavailable", "reason": "non_positive"},
        )

    # Trim trailing zeros for display-friendly strings, keep precision.
    rate_str = format(rate.normalize(), "f")
    return ReferenceRateOut(
        from_currency=src,
        to_currency=dst,
        rate=rate_str,
        provider="frankfurter",
        provider_date=payload.get("date"),
        fetched_at=fetched_at,
    )
