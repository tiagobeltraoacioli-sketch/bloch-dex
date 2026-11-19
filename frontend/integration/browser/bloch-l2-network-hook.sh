#!/usr/bin/env bash
# The Bloch L2 as the seventh network of the multichain site "Bloch DEX": browser phase of
# rehearse-mainnet-package.sh in anvil mode (set RENDER_HOOK to this file). It is sourced with the rehearsal's chain
# still up: the L2 exchange contracts deployed by the L2 deployment kit with their real constructor rules (chain id
# 700770, the committed reserve caps, the first-depositor rule), a seeded WBLCH/bUSDC pair, throwaway keys.
#
# From the SAME two files the kit writes for the Bloch L2 site (the frontend record of this deployment and the L2
# network file with the RPC live and the genesis pinned) it builds BOTH sites:
#   <work>/dist-wallet       the Bloch L2 site (as wallet-hook.sh does), page #/mainnet
#   <work>/dist-multichain   the multichain site, with the same two files given through POSTERN_MAINNET_NETWORK and
#                            POSTERN_MAINNET_RECORD, page #/bloch-l2; its _headers is written by
#                            scripts/multichain-finish.mjs from those files (no text is patched in)
# serves each on loopback, writes one harness file per site (the format of wallet-hook.sh, so scenarios.mjs runs
# against either) and holds the chain while <work>/hold exists. Nothing here uses a real wallet, a real key or a
# public network.
set -euo pipefail
: "${CHROME_EXE:?CHROME_EXE=<Google Chrome or Chromium binary> is required}"
[ "$MODE" = anvil ] || { echo "this hook needs anvil mode: the scenarios control inclusion with anvil's mining RPC" >&2; exit 2; }
FRONT=$ROOT/frontend
GATEWAY=$((PORT + 10)); STATIC=$((PORT + 11)); DEBUG=$((PORT + 12)); MC_STATIC=$((PORT + 13)); MC_DEBUG=$((PORT + 14))

log "bloch-l2-network: finality, then the frontend record and network files of this chain"
$FINALIZE_CMD > /dev/null
node scripts/staging/frontend-record.mjs ${RECORD_FLAGS[@]+"${RECORD_FLAGS[@]}"} --config "$EV/dex.config.json" --plan "$EV/dex.plan.json" --infra-plan "$EV/infra.plan.json" --gate-report "$EV/gate-report.json" --write "$EV/wallet.frontend.record.json"
node -e '
const n = JSON.parse(require("fs").readFileSync("deployments/mainnet/frontend.network.json", "utf8"));
n.genesisHash = process.argv[1]; n.rpc = { url: process.argv[2], status: "live" };
console.log(JSON.stringify(n, null, 2));' "$GENESIS" "http://127.0.0.1:$GATEWAY" > "$EV/wallet.frontend.network.json"

log "bloch-l2-network: the Bloch L2 site against this chain"
(cd "$FRONT" && POSTERN_MAINNET_NETWORK=$EV/wallet.frontend.network.json POSTERN_MAINNET_RECORD=$EV/wallet.frontend.record.json \
  node node_modules/vite/bin/vite.js build --outDir "$WORK/dist-wallet" --emptyOutDir > "$WORK/build-wallet.log" 2>&1) || { tail -n 30 "$WORK/build-wallet.log"; exit 1; }
node -e '
const fs = require("fs"); const f = process.argv[1] + "/_headers";
const before = fs.readFileSync(f, "utf8");
const after = before.replace("https://l2rpc.blochl1.com", process.argv[2]).replace(/; *upgrade-insecure-requests/, "");
if (after === before) throw new Error("the CSP of the built bundle was not adapted to the loopback gateway");
fs.writeFileSync(f, after);' "$WORK/dist-wallet" "http://127.0.0.1:$GATEWAY"

log "bloch-l2-network: the multichain site against this chain, from the same two files"
(cd "$FRONT" && POSTERN_MAINNET_NETWORK=$EV/wallet.frontend.network.json POSTERN_MAINNET_RECORD=$EV/wallet.frontend.record.json POSTERN_MULTICHAIN_OUT=$WORK/dist-multichain \
  node node_modules/vite/bin/vite.js build --config vite.multichain.config.ts > "$WORK/build-multichain.log" 2>&1 \
  && POSTERN_MAINNET_NETWORK=$EV/wallet.frontend.network.json POSTERN_MAINNET_RECORD=$EV/wallet.frontend.record.json \
  node scripts/multichain-finish.mjs "$WORK/dist-multichain" >> "$WORK/build-multichain.log" 2>&1) || { tail -n 30 "$WORK/build-multichain.log"; exit 1; }
grep -q "connect-src [^;]* http://127.0.0.1:$GATEWAY " "$WORK/dist-multichain/_headers" || { echo "the multichain policy does not name the rehearsal's L2 endpoint" >&2; exit 1; }

node scripts/staging/render/serve.mjs "$WORK/dist-wallet" "$STATIC" > /dev/null 2>&1 &
PIDS+=($!)
node scripts/staging/render/serve.mjs "$WORK/dist-multichain" "$MC_STATIC" > /dev/null 2>&1 &
PIDS+=($!)

harness() { # <file> <page> <debug port> <evidence dir>
  mkdir -p "$4"
  cat > "$1" <<JSON
{
  "rpc": "$RPC",
  "gatewayPort": $GATEWAY,
  "debugPort": $3,
  "page": "$2",
  "chrome": "$CHROME_EXE",
  "out": "$4",
  "work": "$WORK",
  "chainId": 700770,
  "issuerKey": "$ISSUER_KEY",
  "asset": "$ASSET",
  "router": "$ROUTER",
  "wrapped": "$WRAPPED",
  "pair": "$PAIR",
  "revision": "$(git rev-parse HEAD 2> /dev/null || echo "${WALLET_REVISION:-export}")",
  "dirty": $(if git rev-parse HEAD > /dev/null 2>&1; then [ -z "$(git status --porcelain)" ] && echo false || echo true; else echo '"export without .git"'; fi)
}
JSON
  chmod 600 "$1"
}
OUT=${WALLET_EVIDENCE:-$EV/bloch-l2-network}
harness "$WORK/wallet-harness.json" "http://127.0.0.1:$STATIC/#/mainnet" "$DEBUG" "$OUT/l2-site"
harness "$WORK/multichain-harness.json" "http://127.0.0.1:$MC_STATIC/#/bloch-l2" "$MC_DEBUG" "$OUT/multichain"

HOLD=${WALLET_HOOK_HOLD:-$WORK/hold}
log "bloch-l2-network: holding the chain while $HOLD exists (harness files: $WORK/wallet-harness.json, $WORK/multichain-harness.json)"
touch "$HOLD"
while [ -e "$HOLD" ]; do sleep 2; done
log "bloch-l2-network: released"
