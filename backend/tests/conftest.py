"""Pytest configuration for split-bill-calculator backend tests.

This file is loaded by pytest BEFORE any test module is imported. We use
that ordering to seed the ``DEV_BYPASS_EMAILS`` env var so the
``app.api.auth`` module-level constant resolves to a non-empty set by
the time any test (including those that don't care about bypass)
imports it. Without this, the bypass tests in ``test_auth_bypass.py``
would see an empty set because the constant is computed once at import
time (and other test files in the directory are imported first by
pytest's alphabetical collector).
"""
from __future__ import annotations

import os

# Default bypass list used by tests. Synthetic demo@example.com only;
# leave this empty in production. example.com is reserved for non-bypass
# regression cases.
os.environ.setdefault(
    "DEV_BYPASS_EMAILS",
    "demo@example.com",
)