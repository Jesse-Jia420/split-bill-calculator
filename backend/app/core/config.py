"""Application settings (pydantic-settings, reads from .env)."""
from __future__ import annotations

from functools import lru_cache
from typing import List

from pydantic import Field, field_validator
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
    cors_allow_origins: List[str] = Field(
        default_factory=lambda: [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:8000",
        ],
        description="Allowed CORS origins.",
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

    # --- App ---
    app_env: str = Field(default="dev")
    debug: bool = Field(default=False)

    @field_validator("cors_allow_origins", mode="before")
    @classmethod
    def _parse_cors(cls, v):  # noqa: D401
        """Allow comma-separated string env values for CORS origins."""
        if isinstance(v, str):
            return [o.strip() for o in v.split(",") if o.strip()]
        return v


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
