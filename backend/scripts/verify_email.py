"""CLI: verify SMTP credentials + send a test verification code email.

This is the end-to-end sanity check for the T05 email integration.
It runs inside the codeserver container (no `bw` available there) and
reads the SMTP credentials from the same `.env` file the backend uses.

Usage:
    cd /config/workspace/split-bill-calculator/backend
    .venv/bin/python -m scripts.verify_email [recipient_email]

Default recipient: jessejia1001@gmail.com

Exit codes:
    0  SMTP reachable, login OK, email sent
    1  SMTP error (auth/network/other) — see stderr
    2  Configuration error (missing password etc.) — see stderr
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from pathlib import Path

# Ensure the backend's ``app`` package is importable when this script is
# invoked as ``python -m scripts.verify_email``.
BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.core.config import settings  # noqa: E402
from app.services.email_service import (  # noqa: E402
    EmailAuthError,
    EmailError,
    EmailNetworkError,
    EmailService,
)
from app.services.verification_code import generate_code  # noqa: E402

DEFAULT_RECIPIENT = "jessejia1001@gmail.com"

# Suppress noisy SMTP DEBUG output but keep our own INFO logs.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)


def _config_error(msg: str) -> "None":
    sys.stderr.write(f"CONFIG ERROR: {msg}\n")
    sys.exit(2)


async def _send(recipient: str) -> None:
    # Defensive: refuse to run with the placeholder password.
    if not settings.smtp_password or settings.smtp_password == "<from-bw>":
        _config_error(
            "SMTP_PASSWORD is empty or still the placeholder. "
            "Set it in backend/.env (do not commit)."
        )

    service = EmailService(settings)
    code = generate_code()
    ttl = settings.verification_code_ttl_minutes
    print(f"→ Sending verification code to {recipient!r}")
    print(f"  host={settings.smtp_host}:{settings.smtp_port} "
          f"user={settings.smtp_username!r} tls={settings.smtp_use_tls}")
    print(f"  code={code!r} ttl={ttl}m  (the code itself is printed for debugging)")

    try:
        await service.send_verification_code(recipient, code, ttl)
    except EmailAuthError as exc:
        sys.stderr.write(f"SMTP AUTH FAILED: {exc}\n")
        sys.exit(1)
    except EmailNetworkError as exc:
        sys.stderr.write(f"SMTP NETWORK ERROR: {exc}\n")
        sys.exit(1)
    except EmailError as exc:
        sys.stderr.write(f"SMTP ERROR: {exc}\n")
        sys.exit(1)

    print(f"OK: SMTP verified. Test email sent to {recipient}")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify SMTP credentials + send a test verification code email.",
    )
    parser.add_argument(
        "recipient",
        nargs="?",
        default=DEFAULT_RECIPIENT,
        help=f"Recipient email (default: {DEFAULT_RECIPIENT})",
    )
    args = parser.parse_args()

    asyncio.run(_send(args.recipient))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
