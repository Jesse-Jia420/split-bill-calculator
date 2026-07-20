#!/bin/bash
# Simulate the wizard flow via curl to identify where the secret changes
set -e
BASE=http://localhost:8449

echo '=== 1. POST /api/sessions ==='
RESP=$(curl -s -X POST $BASE/sessions -H 'Content-Type: application/json' -d '{"name":"Sim","member_nicknames":["同伴 A"],"currencies":["CNY"],"primary_currency":"CNY"}')
echo "$RESP" | head -c 800
echo
SID=$(echo "$RESP" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')
MIDS=$(echo "$RESP" | python3 -c 'import sys,json;print(",".join(str(x) for x in json.load(sys.stdin)["created_member_ids"]))')
echo "SID=$SID MIDS=$MIDS"

echo '=== 2. POST /api/sessions/$SID/join-claim ==='
FIRST_MID=$(echo "$MIDS" | cut -d, -f1)
CLAIM=$(curl -s -X POST $BASE/sessions/$SID/join-claim -H 'Content-Type: application/json' -d "{\"action\":\"claim\",\"session_member_id\":$FIRST_MID}")
echo "$CLAIM"
echo
SECRET=$(echo "$CLAIM" | python3 -c 'import sys,json;print(json.load(sys.stdin)["nickname_secret"])')
echo "SECRET=$SECRET"

echo '=== 3. Check DB ==='
sqlite3 data/sbc.db "SELECT id, session_id, nickname_secret FROM session_members WHERE session_id=$SID;"

echo '=== 4. GET /api/sessions/$SID (with secret) ==='
curl -s $BASE/sessions/$SID -H "X-Nickname-Secret: $SECRET" | head -c 200
echo

echo '=== 5. POST /api/sessions/$SID/bills (with the secret) ==='
curl -s -X POST $BASE/sessions/$SID/bills -H 'Content-Type: application/json' -H "X-Nickname-Secret: $SECRET" -d '{"amount":100,"currency":"CNY","payer_member_id":1,"participants":[{"member_id":1,"share_expression":"100/2"}]}' | head -c 500
echo

echo '=== 6. Check DB again ==='
sqlite3 data/sbc.db "SELECT id, session_id, nickname_secret FROM session_members WHERE session_id=$SID;"