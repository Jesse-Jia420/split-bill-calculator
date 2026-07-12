"""Application settings (pydantic-settings, reads from .env)."""
from __future__ import annotations

from functools import lru_cache
from typing import List

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # --- Database ---
    database_url: str = Field(
        default="sqlite:///./data/sbc.db",
        description="SQLAlchemy database URL.",
    )

    # --- Security ---
    secret_key: str = Field(
        default="change-me-in-production",
        description="Secret key for signing tokens. MUST be overridden in production.",
    )

    # --- CORS ---
    # NOTE: pydantic-settings 2.x dotenv loader JSON-decodes List fields BEFORE field_validator
    # (mode="before") runs, so we cannot parse comma-separated strings here. The .env file
    # MUST use a JSON array, e.g.:
    #   CORS_ALLOW_ORIGINS=["http://localhost:5173","http://127.0.0.1:5173"]
    # See SPEC.md antipattern #31.
    cors_allow_origins: List[str] = Field(
        default_factory=lambda: [
            "http://localhost:5173", "http://localhost:8448", "http://127.0.0.1:8448",
            "http://127.0.0.1:5173",
            "http://localhost:8000",
        ],
        description="Allowed CORS origins (JSON array in .env).",
    )

    # --- Email (SMTP) ---
    smtp_host: str = Field(default="smtp.gmail.com")
    smtp_port: int = Field(default=587)
    smtp_username: str = Field(default="your-smtp-user@example.com")
    smtp_password: str = Field(default="<from-bw>")
    smtp_from: str = Field(default="your-smtp-user@example.com")
    smtp_use_tls: bool = Field(default=True)
    # smtp_use_ssl: implicit SSL from connect (port 465 pattern, e.g. Aliyun
    # DirectMail). When True, smtp_use_tls (STARTTLS) is ignored and the
    # SMTP_SSL class is used directly. Default False preserves the legacy
    # Gmail SMTP+STARTTLS path.
    smtp_use_ssl: bool = Field(default=False)

    # --- Verification code ---
    verification_code_ttl_minutes: int = Field(default=10)
    auth_token_ttl_days: int = Field(default=30)

    # --- Session invites (T09) ---
    # Default TTL for newly minted session invite links. v0.1 default: 30 days.
    # Controlled via env INVITE_TTL_DAYS.
    invite_ttl_days: int = Field(default=30)

    # --- v0.3.x §3.11.11 (PRD §3.11.11) ---
    # 7-day active window measured from session.last_active_at. When the
    # delta exceeds this, the session is reclaimed (GET endpoints 410).
    # This is intentionally independent from invite_ttl_days — the invite
    # link is still valid for invite_ttl_days after rotation, but the
    # *ability to enter the session* via that link is bound by this
    # activity window.
    session_activity_ttl_days: int = Field(default=7)

    # --- AI parse (T11) ---
    # MiniMax API key for POST /sessions/{id}/bills/parse.
    # v0.1 simplification: read directly from env MINIMAX_API_KEY.
    # When empty / unset, /bills/parse returns 422 {error: ai_unavailable}
    # so the frontend falls back to a plain manual form. See SPEC sec 6.
    minimax_api_key: str = Field(
        default="",
        description="MiniMax API key. Empty/unset -> /bills/parse returns 422 ai_unavailable.",
    )
    minimax_api_base: str = Field(
        default="https://api.minimaxi.com",
        description="MiniMax API base URL.",
    )
    minimax_model: str = Field(
        default="MiniMax-Text-01",
        description="MiniMax chat model id used by /bills/parse.",
    )

    # --- Auth rate limits ---
    # Maximum /auth/send-code requests per email per hour. v0.1: 5/h.
    send_code_rate_limit_per_hour: int = Field(default=5)

    # --- Cookies ---
    # dev: false (http). prod: true (https only). Controlled by env COOKIE_SECURE.
    cookie_secure: bool = Field(
        default=False,
        description="Set Secure flag on session cookies (true in production behind HTTPS).",
    )
    session_cookie_name: str = Field(default="sbc_session")

    # --- App ---
    app_env: str = Field(default="dev")
    debug: bool = Field(default=False)

    # --- v0.3.13 dev seed opt-out + cleanup (反 #136) ---
    # Default True: uvicorn startup skips auto-injection of the
    # `demo@example.com` user + 泰国测试账单 + 个人测试 fixtures,
    # so the dev's own SBC personal space stays free of seed data
    # (otherwise every restart re-injects 30+ rows). Set to "false" or
    # "0" (case-insensitive) explicitly to *opt-in* to the legacy
    # always-seed behaviour (e.g. for a sprint walk or demo).
    #
    # Override hierarchy:
    #   1. `ENV=production` → seed is **always** skipped (legacy guard).
    #   2. `SBC_SKIP_SEED` env → take this value (default True = skip).
    #   3. .env file `SBC_SKIP_SEED=false` → opt back in.
    #
    # See SPEC.md §3.13 for rationale.
    sbc_skip_seed: bool = Field(
        default=True,
        description=(
            "Skip seed_dev_data lifespan injection (True = skip, False = "
            "inject). Default True to keep the personal SBC space clean "
            "across restarts. Override per dev with SBC_SKIP_SEED=false."
        ),
    )

    # Retention windows for nightly_cleanup.py.
    # - `auth_token_ttl_days`: drop auth_tokens that are expired OR older
    #   than this AND never used. Active session cookies (those whose
    #   raw token is still hashed and matched at request time) are NEVER
    #   touched — the script only operates on tokens whose *hash* row is
    #   already expired or whose row is 30+ days old without a recorded
    #   `last_used_at`.
    # - `verification_code_retention_days`: drop `verification_codes`
    #   rows that are (used OR expired) for longer than this window.
    auth_token_ttl_days: int = Field(
        default=30,
        description="Days to retain unused auth_tokens before cleanup.",
    )
    verification_code_retention_days: int = Field(
        default=7,
        description=(
            "Days to retain consumed/expired verification_codes before "
            "cleanup. Active (unconsumed & unexpired) codes are NEVER "
            "touched by this script."
        ),
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
