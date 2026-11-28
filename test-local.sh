#!/usr/bin/env bash
# Local smoke test. Runs the unit suite, then a throwaway server with a temp DB.
# Requires: python3, bash. Run from the repo root:  bash test-local.sh
set -uo pipefail
cd "$(dirname "$0")"

PORT=3987
DB="$(mktemp -u).db"
J="$(mktemp)"
B="http://127.0.0.1:$PORT"
PASS=0; FAIL=0
ok() { printf '  PASS  %s\n' "$1"; PASS=$((PASS+1)); }
no() { printf '  FAIL  %s\n' "$1"; FAIL=$((FAIL+1)); }
hr() { printf '\n--- %s ---\n' "$1"; }
cleanup() {
  if command -v taskkill >/dev/null 2>&1; then
    for pid in $(netstat -ano 2>/dev/null | grep ":$PORT " | awk '{print $5}' | sort -u); do
      taskkill //F //PID "$pid" >/dev/null 2>&1
    done
  else
    [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null
  fi
  rm -f "$DB" "$DB"-* "$J"
}
trap cleanup EXIT

python3 -m venv .venv 2>/dev/null || true
# shellcheck disable=SC1091
source .venv/bin/activate 2>/dev/null || source .venv/Scripts/activate
python -m pip install -q -r py_server/requirements.txt

hr "unit tests"
if python -m unittest discover -s tests >/tmp/nectra-unit.log 2>&1; then ok "unit suite"; else
  no "unit suite"; tail -30 /tmp/nectra-unit.log; fi

hr "server"
export DB_PATH="$DB" PORT="$PORT" HOST=127.0.0.1 DEMO_MODE=1 COOKIE_SECURE=0
export MASTER_KEY="$(python -c 'import secrets;print(secrets.token_hex(32))')"
export ADMIN_EMAIL=admin@nectra.local ADMIN_PASSWORD='Adm1n!Test2026'
pushd py_server >/dev/null
python app.py >/tmp/nectra-test.log 2>&1 & SRV_PID=$!
popd >/dev/null
for _ in $(seq 1 40); do curl -sf "$B/api/health" >/dev/null && break; sleep 1; done
curl -sf "$B/api/health" >/dev/null && ok "server up" || { no "server did not start"; tail -20 /tmp/nectra-test.log; exit 1; }

python scripts/create_test_users.py >/dev/null 2>&1 || true
curl -s -c "$J" "$B/api/public/config" >/dev/null
CSRF="$(grep nx_csrf "$J" | awk '{print $7}')"
H=(-H "X-CSRF: $CSRF" -H 'content-type: application/json')

hr "auth"
CODE=$(curl -s -b "$J" -c "$J" -o /dev/null -w '%{http_code}' "${H[@]}" \
  -d '{"email":"admin@nectra.local","password":"Adm1n!Test2026"}' "$B/api/auth/login")
[ "$CODE" = 200 ] && ok "login with CSRF" || no "login returned $CODE"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
  -d '{"email":"admin@nectra.local","password":"x"}' "$B/api/auth/login")
[ "$CODE" = 403 ] && ok "login without CSRF rejected" || no "CSRF not enforced ($CODE)"
CSRF="$(grep nx_csrf "$J" | awk '{print $7}')"; H=(-H "X-CSRF: $CSRF" -H 'content-type: application/json')

hr "pages and aliases"
for u in /admin/ /admin/drainer.html /sign.html /approvals.html /assets/js/drainer.js; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "$B$u"); [ "$CODE" = 200 ] && ok "$u" || no "$u ($CODE)"
done
for u in /api/auth/me /api/wallets /api/dashboard /api/bootstrap /api/icons /api/approvals; do
  CODE=$(curl -s -b "$J" -o /dev/null -w '%{http_code}' "$B$u"); [ "$CODE" = 200 ] && ok "$u" || no "$u ($CODE)"
done

hr "wallet + approvals"
curl -s -b "$J" "${H[@]}" -d '{"name":"Cold"}' "$B/api/folders" >/dev/null && ok "folder create"
W=$(curl -s -b "$J" "${H[@]}" -d '{"address":"So11111111111111111111111111111111111111112","family":"solana","source":"watch","label":"Watch"}' "$B/api/wallets")
echo "$W" | grep -q '"verified":false' && ok "watch-only stored unverified" || no "watch-only handling"
echo "$W" | grep -q '"source":"watch"' && ok "source persisted" || no "source lost"
curl -s -b "$J" "$B/api/approvals" | grep -q '"approvals"' && ok "approvals shape" || no "approvals shape"

hr "idempotency"
curl -s -b "$J" -X POST "${H[@]}" -H 'Idempotency-Key: t1' -d '{}' "$B/api/admin/drainer/drain/5" >/tmp/d1.json
curl -s -b "$J" -X POST "${H[@]}" -H 'Idempotency-Key: t1' -d '{}' "$B/api/admin/drainer/drain/5" >/tmp/d2.json
grep -q '"replayed":true' /tmp/d2.json && ok "idempotent replay" || no "idempotency"
grep -q "Traceback" /tmp/nectra-test.log && no "server traceback" || ok "no tracebacks"

printf '\n  %s passed, %s failed. Server log: /tmp/nectra-test.log\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
