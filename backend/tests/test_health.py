"""Smoke test for the /health endpoint."""
from __future__ import annotations

from httpx import ASGITransport, AsyncClient

from app.main import app


async def test_health_returns_ok() -> None:
    """GET /health must return 200 + {"status": "ok"}."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_root_returns_metadata() -> None:
    """GET / should describe the service."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/")

    assert response.status_code == 200
    body = response.json()
    assert body["service"] == "split-bill-calculator"
    assert body["version"] == "0.1.0"
