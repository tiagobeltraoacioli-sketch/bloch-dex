# Agent 144: browser phase (RENDER_HOOK) of rehearse-mainnet-package.sh with HOLD_TOKEN. The live #/mainnet build reads the L2 through the
# CORS rig and the bUSDC hold status from the Ethereum anvil through a second rig; states normal, paused (vault
# guardian pause), held at latest only (forged credit not final) and held (final). Monitor and keeper run per state.
set -euo pipefail
: "${BROWSER_EXE:?}" "${PLAYWRIGHT_DIR:?}"
FRONT=$ROOT/frontend
OUT=$EV/hold
mkdir -p "$OUT"
BF=$WORK/bridge-facts.json
bj() { node -e 'console.log(require(process.argv[1])[process.argv[2]])' "$BF" "$1"; }
ETH=$(bj eth); VAULT=$(bj vault)
BASE=$((PORT + 30)); RIG=$BASE; ETH_RIG=$((BASE + 1)); LIVE=$((BASE + 2))

umask 077; cast wallet new --json > "$WORK/render-user.json"; umask 022
USER_KEY=$(node -e 'console.log(require(process.argv[1])[0].private_key)' "$WORK/render-user.json")
USER_ADDR=$(node -e 'console.log(require(process.argv[1])[0].address.toLowerCase())' "$WORK/render-user.json")
must "$ISSUER_KEY" "$USER_ADDR" 0x 2000000000000000000 100000 > /dev/null
must "$ISSUER_KEY" "$ASSET" "$(cast calldata "transfer(address,uint256)" "$USER_ADDR" 100000000)" 0 100000 > /dev/null
cast rpc anvil_mine 0x80 --rpc-url "$RPC" > /dev/null
KEEPER_ADDR=$(addr 8)

cat > "$WORK/hold-actions.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export PATH="$PATH"
cd "$ROOT"
ETH=$ETH; RPC=$RPC; VAULT=$VAULT; ASSET=$ASSET
case "\$1" in
  snapshot-eth) cast rpc evm_snapshot --rpc-url \$ETH | tr -d '"' > "$WORK/eth.snap" ;;
  revert-eth) cast rpc evm_revert "\$(cat "$WORK/eth.snap")" --rpc-url \$ETH > /dev/null ;;
  pause)
    cast send \$VAULT "guardianPause()" --private-key "$(bj guardianKey)" --rpc-url \$ETH > /dev/null
    cast rpc anvil_mine 0x48 --rpc-url \$ETH > /dev/null ;;
  forge)
    # A committee-signed mint with no Ethereum deposit behind it (the 139 / 109 forged credit), credited after the delay.
    N=\$(cast call \$ASSET "nextSlot()(uint64)" --rpc-url \$RPC | awk '{print \$1}')
    ID=\$(printf '0x%016x%s' "\$N" "\$(cast keccak "forged-\$N" | cut -c19-)")
    TO=0x00000000000000000000000000000000000f0e9d
    DIG=\$(cast call \$ASSET "mintDigest(bytes32,uint64,uint64,address)(bytes32)" "\$ID" "\$N" 50000000 \$TO --rpc-url \$RPC)
    SIGS=0x; while read -r _ k; do SIGS+=\$(cast wallet sign --no-hash "\$DIG" --private-key "\$k" | cut -c3-); done < <(head -n 2 "$(bj l2SignersFile)")
    cast send \$ASSET "mint(bytes32,uint64,uint64,address,bytes)" "\$ID" "\$N" 50000000 \$TO "\$SIGS" --private-key "$ISSUER_KEY" --rpc-url \$RPC > /dev/null
    cast rpc evm_increaseTime 43300 --rpc-url \$RPC > /dev/null; cast rpc evm_mine --rpc-url \$RPC > /dev/null
    cast send \$ASSET "executeMint(bytes32)" "\$ID" --private-key "$ISSUER_KEY" --rpc-url \$RPC > /dev/null ;;
  finalize-l2) cast rpc anvil_mine 0x80 --rpc-url \$RPC > /dev/null ;;
  ops)
    set +e
    node scripts/ops/dex-monitor.mjs --config "$EV/gate.json" --rpc "$GATE_RPC" --rehearsal --eth-rpc \$ETH --bridge-vault \$VAULT --json > "$OUT/monitor-\$2.json"; M=\$?
    node scripts/ops/dex-skim-keeper.mjs --config "$EV/gate.json" --rpc "$GATE_RPC" --keeper $KEEPER_ADDR --state "$WORK/hold-keeper-\$2.json" --eth-rpc \$ETH --bridge-vault \$VAULT > "$OUT/keeper-\$2.json" 2>&1; KX=\$?
    node -e 'const m=require(process.argv[1]);const c=m.checks.find(x=>x.name.startsWith("bridge_exit"));const k=require("fs").readFileSync(process.argv[2],"utf8").trim();console.log(JSON.stringify({monitor:m.level,monitorExit:+process.argv[3],bridgeExit:c,keeperExit:+process.argv[4],keeper:k.slice(-300)}))' "$OUT/monitor-\$2.json" "$OUT/keeper-\$2.json" \$M \$KX ;;
esac
EOF
chmod +x "$WORK/hold-actions.sh"

node scripts/staging/frontend-record.mjs --config "$EV/dex.config.json" --plan "$EV/dex.plan.json" --infra-plan "$EV/infra.plan.json" --gate-report "$EV/gate-report.json" --write "$EV/frontend.record.json"
node -e '
const n = JSON.parse(require("fs").readFileSync("deployments/mainnet/frontend.network.json", "utf8"));
const [genesis, rpc, eth, vault, token] = process.argv.slice(1);
n.genesisHash = genesis; n.rpc = { url: rpc, status: "live" };
n.bridges[0].withdrawUrl = "https://bridge.example.invalid/bridge";
n.bridges[0].status = { ethRpcUrl: eth, vault, token };
console.log(JSON.stringify(n, null, 2));' "$GENESIS" "http://127.0.0.1:$RIG" "http://127.0.0.1:$ETH_RIG" "$VAULT" "$ASSET" > "$EV/frontend.network.json"
cd "$FRONT"
[ -d node_modules ] || npm ci --ignore-scripts > "$WORK/npm-ci.log" 2>&1
POSTERN_MAINNET_NETWORK=$EV/frontend.network.json POSTERN_MAINNET_RECORD=$EV/frontend.record.json \
  npx vite build --outDir "$WORK/dist-live" --emptyOutDir > "$WORK/build-live.log" 2>&1
cd "$ROOT"
sed -i "s#https://l2rpc.blochl1.com#http://127.0.0.1:$RIG http://127.0.0.1:$ETH_RIG#; s#; *upgrade-insecure-requests##" "$WORK/dist-live/_headers"
node scripts/staging/render/rpc-gateway-rig.mjs "$RPC" "$RIG" "$USER_KEY" > "$WORK/rig.log" 2>&1 &
PIDS+=($!)
node scripts/staging/render/rpc-gateway-rig.mjs "$ETH" "$ETH_RIG" "$USER_KEY" > "$WORK/eth-rig.log" 2>&1 &
PIDS+=($!)
node scripts/staging/render/serve.mjs "$WORK/dist-live" "$LIVE" > /dev/null 2>&1 &
PIDS+=($!)
sleep 1
log "hold: headless browser (#/mainnet), normal, paused, held latest-only, held"
LD_LIBRARY_PATH=${RENDER_LD_PATH:-} timeout 1500 node "$HOLD_SHOT" "$BROWSER_EXE" "$OUT" "$USER_ADDR" \
  "http://127.0.0.1:$LIVE/#/mainnet" "http://127.0.0.1:$RIG" "$WORK/hold-actions.sh" | tee -a "$EV/steps.log"
log "hold: OK"
