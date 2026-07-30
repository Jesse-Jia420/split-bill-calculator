"""Reference FX endpoint tests."""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def test_reference_rate_success(client: TestClient) -> None:
    mock_resp = MagicMock()
    mock_resp.raise_for_status = MagicMock()
    mock_resp.json.return_value = {"amount": 1.0, "base": "CNY", "date": "2026-07-29", "rates": {"THB": 4.52}}

    mock_client = AsyncMock()
    mock_client.__aenter__.return_value = mock_client
    mock_client.__aexit__.return_value = None
    mock_client.get = AsyncMock(return_value=mock_resp)

    with patch("app.api.reference_rates.httpx.AsyncClient", return_value=mock_client):
        r = client.get("/exchange-rates/reference", params={"from": "CNY", "to": "THB"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["from_currency"] == "CNY"
    assert body["to_currency"] == "THB"
    assert body["rate"] == "4.52"
    assert body["provider"] == "frankfurter"
    assert body["provider_date"] == "2026-07-29"
    assert "fetched_at" in body


def test_reference_rate_same_currency_422(client: TestClient) -> None:
    r = client.get("/exchange-rates/reference", params={"from": "CNY", "to": "CNY"})
    assert r.status_code == 422


def test_reference_rate_provider_down_502(client: TestClient) -> None:
    import httpx

    mock_client = AsyncMock()
    mock_client.__aenter__.return_value = mock_client
    mock_client.__aexit__.return_value = None
    mock_client.get = AsyncMock(side_effect=httpx.ConnectError("boom"))

    with patch("app.api.reference_rates.httpx.AsyncClient", return_value=mock_client):
        r = client.get("/exchange-rates/reference", params={"from": "CNY", "to": "USD"})
    assert r.status_code == 502
