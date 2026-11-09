#!/usr/bin/env bash
# Browser-engine wallet phase of rehearse-mainnet-package.sh in anvil mode (set RENDER_HOOK to this file; run.mjs does).
# It is sourced with the rehearsal's chain still up and its helpers and variables in scope: a deployed DEX, a seeded
# WBLCH/bUSDC pair and throwaway keys. It builds the production bundle against that chain, serves it on loopback and
# hands over to scenarios.mjs, which drives the installed Chrome over the DevTools protocol with a simulated wallet.
# Nothing here uses a real wallet, a real key or a public network.
set -euo pipefail
: "${CHROME_EXE:?CHROME_EXE=<Google Chrome or Chromium binary> is required}"
[ "$MODE" = anvil ] || { echo "the browser wallet harness needs anvil mode: it controls inclusion with anvil's mining RPC" >&2; exit 2; }
FRONT=$ROOT/frontend
OUT=${WALLET_EVIDENCE:-$EV/browser-wallet}
mkdir -p "$OUT"
GATEWAY=$((PORT + 10)); STATIC=$((PORT + 11)); DEBUG=$((PORT + 12))

log "browser wallet: finality, then the frontend record and network files of this chain"
$FINALIZE_CMD > /dev/null
node scripts/staging/frontend-record.mjs --config "$EV/dex.config.json" --plan "$EV/dex.plan.json" --infra-plan "$EV/infra.plan.json" --gate-report "$EV/gate-report.json" --write "$EV/wallet.frontend.record.json"
node -e '
const n = JSON.parse(require("fs").readFileSync("deployments/mainnet/frontend.network.json", "utf8"));
n.genesisHash = process.argv[1]; n.rpc = { url: process.argv[2], status: "live" };
console.log(JSON.stringify(n, null, 2));' "$GENESIS" "http://127.0.0.1:$GATEWAY" > "$EV/wallet.frontend.network.json"

log "browser wallet: production bundle against this chain"
(cd "$FRONT" && POSTERN_MAINNET_NETWORK=$EV/wallet.frontend.network.json POSTERN_MAINNET_RECORD=$EV/wallet.frontend.record.json \
  node node_modules/vite/bin/vite.js build --outDir "$WORK/dist-wallet" --emptyOutDir > "$WORK/build-wallet.log" 2>&1) || { tail -n 30 "$WORK/build-wallet.log"; exit 1; }
# The committed CSP names the public RPC origin; the loopback build reads the harness gateway over plain HTTP.
node -e '
const fs = require("fs"); const f = process.argv[1] + "/_headers";
const before = fs.readFileSync(f, "utf8");
const after = before.replace("https://l2rpc.blochl1.com", process.argv[2]).replace(/; *upgrade-insecure-requests/, "");
if (after === before) throw new Error("the CSP of the built bundle was not adapted to the loopback gateway");
fs.writeFileSync(f, after);' "$WORK/dist-wallet" "http://127.0.0.1:$GATEWAY"

node scripts/staging/render/serve.mjs "$WORK/dist-wallet" "$STATIC" > /dev/null 2>&1 &
PIDS+=($!)

cat > "$WORK/wallet-harness.json" <<EOF
{
  "rpc": "$RPC",
  "gatewayPort": $GATEWAY,
  "debugPort": $DEBUG,
  "page": "http://127.0.0.1:$STATIC/#/mainnet",
  "chrome": "$CHROME_EXE",
  "out": "$OUT",
  "work": "$WORK",
  "chainId": 700770,
  "issuerKey": "$ISSUER_KEY",
  "asset": "$ASSET",
  "router": "$ROUTER",
  "wrapped": "$WRAPPED",
  "pair": "$PAIR",
  "revision": "$(git rev-parse HEAD)",
  "dirty": $([ -z "$(git status --porcelain)" ] && echo false || echo true)
}
EOF
chmod 600 "$WORK/wallet-harness.json"
if [ -n "${WALLET_HOOK_HOLD:-}" ]; then
  # Development aid: keep the chain and the static server up while scenarios.mjs is run by hand against $WORK/wallet-harness.json.
  log "browser wallet: holding the chain while $WALLET_HOOK_HOLD exists"
  touch "$WALLET_HOOK_HOLD"
  while [ -e "$WALLET_HOOK_HOLD" ]; do sleep 2; done
else
  log "browser wallet: scenarios in headless Chrome"
  node "$FRONT/integration/browser/scenarios.mjs" "$WORK/wallet-harness.json" ${WALLET_ONLY:+--only "$WALLET_ONLY"} | tee -a "$EV/steps.log"
  log "browser wallet: OK"
fi
