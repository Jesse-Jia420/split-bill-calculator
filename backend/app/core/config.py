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
    smtp_username: str = Field(default="jessejia1001@gmail.com")
    smtp_password: str = Field(default="<from-bw>")
    smtp_from: str = Field(default="jessejia1001@gmail.com")
    smtp_use_tls: bool = Field(default=True)

    # --- Verification code ---
    verification_code_ttl_minutes: int = Field(default=10)
    auth_token_ttl_days: int = Field(default=30)

    # --- Session invites (T09) ---
    # Default TTL for newly minted session invite links. v0.1 default: 30 days.
    # Controlled via env INVITE_TTL_DAYS.
    invite_ttl_days: int = Field(default=30)

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


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
