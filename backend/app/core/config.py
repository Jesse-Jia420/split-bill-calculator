"""Application settings (pydantic-settings, reads from backend/.env)."""
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
    # pydantic-settings 2.x JSON-decodes List fields from dotenv. Use a JSON
    # array in .env, e.g. CORS_ALLOW_ORIGINS=["http://localhost:5173"]
    cors_allow_origins: List[str] = Field(
        default_factory=lambda: [
            "http://localhost:5173",
            "http://localhost:8448",
            "http://127.0.0.1:8448",
            "http://127.0.0.1:5173",
            "http://localhost:8000",
        ],
        description="Allowed CORS origins (JSON array in .env).",
    )

    # --- Email (SMTP) ---
    smtp_host: str = Field(default="smtp.example.com")
    smtp_port: int = Field(default=587)
    smtp_username: str = Field(default="")
    smtp_password: str = Field(default="")
    smtp_from: str = Field(default="noreply@example.com")
    smtp_use_tls: bool = Field(default=True)
    # When True, use implicit SSL (port 465 style). STARTTLS is ignored.
    smtp_use_ssl: bool = Field(default=False)

    # --- Verification / auth TTLs ---
    verification_code_ttl_minutes: int = Field(default=10)
    auth_token_ttl_days: int = Field(
        default=30,
        description="Days to retain unused auth_tokens before cleanup.",
    )
    verification_code_retention_days: int = Field(
        default=7,
        description="Days to retain consumed/expired verification_codes before cleanup.",
    )

    # --- Session invites ---
    invite_ttl_days: int = Field(default=30)

    # 7-day active window from session.last_active_at (GET may 410 when exceeded).
    session_activity_ttl_days: int = Field(default=7)

    # --- Optional AI parse ---
    minimax_api_key: str = Field(
        default="",
        description="MiniMax API key. Empty -> /bills/parse returns 422 ai_unavailable.",
    )
    minimax_api_base: str = Field(default="https://api.minimaxi.com")
    minimax_model: str = Field(default="MiniMax-Text-01")

    # --- Auth rate limits ---
    send_code_rate_limit_per_hour: int = Field(default=5)

    # --- Cookies ---
    cookie_secure: bool = Field(
        default=False,
        description="Set Secure flag on session cookies (true behind HTTPS).",
    )
    session_cookie_name: str = Field(default="sbc_session")

    # --- App ---
    app_env: str = Field(default="dev")
    debug: bool = Field(default=False)

    # Skip demo seed on startup (recommended true for clean clones).
    sbc_skip_seed: bool = Field(
        default=True,
        description="Skip seed_dev_data lifespan injection when True.",
    )
    seed_user_email: str = Field(
        default="demo@example.com",
        description="Owner email for seeded UAT ledgers (SEED_USER_EMAIL).",
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
