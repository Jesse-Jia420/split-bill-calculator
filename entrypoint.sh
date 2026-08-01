#!/bin/sh
# split-bill-calculator entrypoint (反 #160 --host 0.0.0.0 + 反 #159 分次启)
set -e

echo "[entrypoint] ===BE 0: alembic upgrade head (建 DB schema)==="
cd /app/backend
alembic upgrade head 2>&1 | tee /tmp/alembic.log || {
    echo "[entrypoint] alembic upgrade FAILED"
    cat /tmp/alembic.log
    exit 1
}

echo
echo "[entrypoint] ===BE 1: 启 uvicorn (--host 0.0.0.0)==="
cd /app/backend
nohup python -m uvicorn app.main:app \
    --host 0.0.0.0 --port 8449 --env-file .env \
    &>/tmp/uvicorn.log &
UVICORN_PID=$!
echo "[entrypoint] BE_PID=$UVICORN_PID"

echo
echo "[entrypoint] ===FE 2: 启 proxy-server (--host 0.0.0.0, /api/* → BE)==="
cd /app/frontend
PORT=8448 HOST=0.0.0.0 BE_URL=http://sbc-backend-cursor:8449 \
    nohup node proxy-server.js \
    &>/tmp/sveltekit.log &
FE_PID=$!
echo "[entrypoint] FE_PID=$FE_PID"

echo
echo "[entrypoint] ===3: 等待 + 健康检查==="
sleep 8

# BE /version 健康检查
echo "[entrypoint] BE /version smoke:"
curl -sS http://localhost:8449/version && echo

# FE :8448 smoke (5 次 retry, esbuild 启动可能慢)
echo "[entrypoint] FE :8448 smoke (5 次 retry):"
for i in 1 2 3 4 5; do
    echo -n "  attempt $i: "
    STATUS=$(curl -sS -o /dev/null -w "%{http_code}" http://localhost:8448/)
    echo "$STATUS"
    [ "$STATUS" = "200" ] && break
    sleep 2
done

echo
echo "[entrypoint] ===4: 等子进程==="
wait $UVICORN_PID $FE_PID
