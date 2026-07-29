#!/usr/bin/env bash
# Expose Vite :8448 to the public internet for phone QA (Cloud Agent VM).
# Requires: frontend on 0.0.0.0:8448, backend on 0.0.0.0:8449.
set -euo pipefail

PORT="${SBC_FE_PORT:-8448}"
CF_BIN="${CLOUDFLARED_BIN:-/tmp/cloudflared}"

if ! curl -sf "http://127.0.0.1:${PORT}/" >/dev/null; then
  echo "ERROR: nothing listening on 127.0.0.1:${PORT}. Start frontend first (tmux sbc-frontend)." >&2
  exit 1
fi

if [[ ! -x "$CF_BIN" ]]; then
  echo "Downloading cloudflared..."
  curl -sL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" -o "$CF_BIN"
  chmod +x "$CF_BIN"
fi

echo "Starting Cloudflare quick tunnel → http://127.0.0.1:${PORT}"
echo "Open the https://*.trycloudflare.com URL on your phone (NOT 127.0.0.1)."
echo "Login: xinhua1001@outlook.com + any 6-digit code"
echo "---"
exec "$CF_BIN" tunnel --url "http://127.0.0.1:${PORT}"
