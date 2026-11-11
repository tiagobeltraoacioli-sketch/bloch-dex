#!/usr/bin/env bash
# Browser phase of rehearse-mainnet-package.sh (set RENDER_HOOK to this file).
# Runs with the rehearsal's chain still up and its helpers exported. Needs:
#   BROWSER_EXE       headless Chromium binary
#   PLAYWRIGHT_DIR    directory whose node_modules holds playwright-core
#   RENDER_LD_PATH    optional LD_LIBRARY_PATH for the browser
set -euo pipefail
: "${BROWSER_EXE:?}" "${PLAYWRIGHT_DIR:?}"
FRONT=$ROOT/frontend
OUT=$EV/render
mkdir -p "$OUT"
BASE=$((PORT + 10)); RIG=$BASE; COMMITTED=$((BASE + 1)); LIVE=$((BASE + 2))

# The browser user: gas and 100 bUSDC, from a key generated here.
umask 077; cast wallet new --json > "$WORK/render-user.json"; umask 022
USER_KEY=$(node -e 'console.log(require(process.argv[1])[0].private_key)' "$WORK/render-user.json")
USER_ADDR=$(node -e 'console.log(require(process.argv[1])[0].address.toLowerCase())' "$WORK/render-user.json")
must "$ISSUER_KEY" "$USER_ADDR" 0x 2000000000000000000 100000 > /dev/null
must "$ISSUER_KEY" "$ASSET" "$(cast calldata "transfer(address,uint256)" "$USER_ADDR" 100000000)" 0 100000 > /dev/null

# Actions the browser script triggers on the chain.
cat > "$WORK/render-actions.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
case "\$1" in
  finalize) $FINALIZE_CMD > /dev/null ;;
  donate-and-finalize)
    bash "$WORK/render-send.sh" "$ISSUER_KEY" "$ASSET" "\$(cast calldata "transfer(address,uint256)" "$PAIR" 1000000000)" > /dev/null
    $FINALIZE_CMD > /dev/null ;;
esac
EOF
cat > "$WORK/render-send.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
K=\$1; TO=\$2; DATA=\$3
FROM=\$(cast wallet address --private-key "\$K")
N=\$(cast nonce "\$FROM" --block latest --rpc-url "$RPC")
RAW=\$(cast mktx --chain 700770 --nonce "\$N" --gas-limit 400000 --gas-price 5000000000 --priority-gas-price 1000000000 --private-key "\$K" "\$TO" "\$DATA")
H=\$(cast keccak "\$RAW"); cast publish --rpc-url "$RPC" "\$RAW" > /dev/null
for _ in \$(seq 300); do
  R=\$(cast rpc eth_getTransactionReceipt "\$H" --rpc-url "$RPC"); [ "\$R" != null ] && break; sleep 1
done
B=\$(node -e 'console.log(BigInt(JSON.parse(process.argv[1]).blockNumber).toString())' "\$R")
until [ "\$(cast block-number --rpc-url "$RPC")" -ge "\$B" ]; do sleep 1; done
EOF

# Finalize the current pool, then move it so the finalized quote is stale.
log "render: finality, then a large swap that only latest sees"
$FINALIZE_CMD | tee -a "$EV/steps.log"
FIN=$(cast rpc eth_getBlockByNumber finalized false --rpc-url "$RPC" | node -e 'console.log(BigInt(JSON.parse(require("fs").readFileSync(0,"utf8")).number).toString())')
must "$ISSUER_KEY" "$ROUTER" "$(cast calldata "swapExactTokensForBLCH(uint256,uint256,address[],address,uint256)" 50000000 0 "[$ASSET,$WRAPPED]" "$ISSUER" 99999999999)" 0 400000 > /dev/null
echo "finalized $FIN, latest $(cast block-number --rpc-url "$RPC")" | tee -a "$EV/steps.log"

# Record and network files of the live build.
node scripts/staging/frontend-record.mjs ${RECORD_FLAGS[@]+"${RECORD_FLAGS[@]}"} --config "$EV/dex.config.json" --plan "$EV/dex.plan.json" --infra-plan "$EV/infra.plan.json" --gate-report "$EV/gate-report.json" --write "$EV/frontend.record.json"
node -e '
const n = JSON.parse(require("fs").readFileSync("deployments/mainnet/frontend.network.json", "utf8"));
n.genesisHash = process.argv[1]; n.rpc = { url: process.argv[2], status: "live" };
console.log(JSON.stringify(n, null, 2));' "$GENESIS" "http://127.0.0.1:$RIG" > "$EV/frontend.network.json"

cd "$FRONT"
[ -d node_modules ] || npm ci --ignore-scripts > "$WORK/npm-ci.log" 2>&1
npx vite build --outDir "$WORK/dist-committed" --emptyOutDir > "$WORK/build-committed.log" 2>&1
POSTERN_MAINNET_NETWORK=$EV/frontend.network.json POSTERN_MAINNET_RECORD=$EV/frontend.record.json \
  npx vite build --outDir "$WORK/dist-live" --emptyOutDir > "$WORK/build-live.log" 2>&1
cd "$ROOT"
# The live build reads the rig instead of the placeholder public origin.
sed -i "s#https://l2rpc.blochl1.com#http://127.0.0.1:$RIG#; s#; *upgrade-insecure-requests##" "$WORK/dist-live/_headers"

node scripts/staging/render/rpc-gateway-rig.mjs "$RPC" "$RIG" "$USER_KEY" > "$WORK/rig.log" 2>&1 &
PIDS+=($!)
node scripts/staging/render/serve.mjs "$WORK/dist-committed" "$COMMITTED" > /dev/null 2>&1 &
PIDS+=($!)
node scripts/staging/render/serve.mjs "$WORK/dist-live" "$LIVE" > /dev/null 2>&1 &
PIDS+=($!)
sleep 1
log "render: headless browser (#/mainnet)"
export MULTICALL3
MULTICALL3=$(jsonget "$EV/infra.plan.json" contracts.multicall3.address)
LD_LIBRARY_PATH=${RENDER_LD_PATH:-} timeout 900 node scripts/staging/render/shot.mjs "$BROWSER_EXE" "$OUT" "$USER_ADDR" \
  "http://127.0.0.1:$COMMITTED/#/mainnet" "http://127.0.0.1:$LIVE/#/mainnet" "http://127.0.0.1:$RIG" "$WORK/render-actions.sh" | tee -a "$EV/steps.log"
log "render: OK"
