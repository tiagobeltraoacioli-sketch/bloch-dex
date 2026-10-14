#!/usr/bin/env bash
# End-to-end rehearsal of the mainnet DEX deployment procedure on a throwaway
# local anvil chain: config -> plan -> dry run -> broadcast -> record ->
# finality gate (schema 2). Never point this at a real network: it starts its
# own anvil on 127.0.0.1 and uses anvil's public development keys.
#
#   scripts/staging/rehearse-deploy-anvil.sh <revision> [chain-id] [port]
#
# The default chain ID 700770 (the Bloch L2 mainnet ID from
# deployments/networks.json) exercises the mainnet path on a throwaway chain
# whose genesis differs from the real one; 700771 or 31337 exercise the
# explicit --rehearsal path. The bloch_finality method is served by a local
# shim that mirrors anvil's `finalized` tag; it proves the tooling, not Bloch
# finality. Bloch Inc is played by a test-only 2-of-3 multisig contract and
# the two pilot counter-assets (wGnB, bUSDC) by test-only tokens exposing the
# bridge's bucketCapacity(); the caps are the committed mainnet values.
set -euo pipefail

REVISION=${1:?usage: rehearse-deploy-anvil.sh <40-hex revision> [chain-id] [port]}
CHAIN_ID=${2:-700770}
PORT=${3:-18571}
SHIM_PORT=$((PORT + 1))
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
WORK=$(mktemp -d)
RPC=http://127.0.0.1:$PORT
SHIM=http://127.0.0.1:$SHIM_PORT

# anvil's well-known development accounts (public test keys).
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
DEPLOYER=0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266
OWNER_A_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
OWNER_A=0x70997970c51812dc3a010c7d01b50e0d17dc79c8
OWNER_B_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
OWNER_B=0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc
OWNER_C=0x15d34aaf54267db7d7c367839aaf71a00a2c6a65
ISSUER_KEY=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
ISSUER=0x90f79bf6eb2c4f870365e785982e1f101e93b906
# Committed mainnet caps and the bridge buckets they imply (cap = bucket / 10).
WBLCH_CAP=10000000000000000000
GNB_CAP=100000000000; GNB_BUCKET=1000000000000
USD_CAP=1000000000; USD_BUCKET=10000000000

case "$CHAIN_ID" in
  700771|31337) FLAG=--rehearsal; NAME=local-rehearsal; REHEARSAL=true ;;
  *) FLAG=; NAME=bloch-l2-mainnet; REHEARSAL=false ;;
esac

anvil --chain-id "$CHAIN_ID" --port "$PORT" --silent > "$WORK/anvil.log" 2>&1 &
ANVIL=$!
node scripts/fixtures/anvil-finality-shim.mjs "$RPC" "$SHIM_PORT" > "$WORK/shim.log" 2>&1 &
SHIMPID=$!
trap 'kill $ANVIL $SHIMPID 2>/dev/null || true' EXIT
for _ in $(seq 50); do cast chain-id --rpc-url "$RPC" > /dev/null 2>&1 && break; sleep 0.2; done

forge build > "$WORK/build.log" 2>&1 || { tail -n 30 "$WORK/build.log"; exit 1; }
created() { awk '/Deployed to:/ {print tolower($3)}'; }
codehash() { cast keccak "$(cast code "$1" --rpc-url "$RPC")"; }
BLOCH_INC=$(forge create test/mocks/RehearsalMultisig.sol:RehearsalMultisig --rpc-url "$RPC" --private-key "$ISSUER_KEY" \
  --broadcast --constructor-args "[$OWNER_A,$OWNER_B,$OWNER_C]" 2 | created)
GNB=$(forge create test/mocks/RehearsalBridgedToken.sol:RehearsalBridgedToken --rpc-url "$RPC" --private-key "$ISSUER_KEY" \
  --broadcast --constructor-args "Rehearsal wGnB" "wGnB" 8 100000000000000 "$ISSUER" "$GNB_BUCKET" | created)
ASSET=$(forge create test/mocks/RehearsalBridgedToken.sol:RehearsalBridgedToken --rpc-url "$RPC" --private-key "$ISSUER_KEY" \
  --broadcast --constructor-args "Rehearsal bUSDC" "bUSDC" 6 1000000000000 "$ISSUER" "$USD_BUCKET" | created)
GENESIS=$(cast block 0 --field hash --rpc-url "$RPC")
CONFIG="$WORK/config.json"
cat > "$CONFIG" <<JSON
{
  "schemaVersion": 1,
  "domain": "postern.dex.mainnet-deploy.v1",
  "network": { "name": "$NAME", "chainId": $CHAIN_ID, "genesisHash": "$GENESIS", "rehearsal": $REHEARSAL },
  "source": { "revision": "$REVISION", "compiler": { "solc": "0.8.24", "evmVersion": "paris", "optimizer": true, "optimizerRuns": 200, "bytecodeHash": "none" } },
  "deployer": { "address": "$DEPLOYER", "startNonce": 0 },
  "blochInc": { "address": "$BLOCH_INC", "codeHash": "$(codehash "$BLOCH_INC")" },
  "wrappedNative": { "deploy": true },
  "fees": { "feeTo": "blochInc" },
  "reserveCaps": [
    { "token": "WBLCH", "cap": "$WBLCH_CAP" },
    { "symbol": "wGnB", "token": "$GNB", "codeHash": "$(codehash "$GNB")", "bridgeBucketCapacity": "$GNB_BUCKET", "cap": "$GNB_CAP" },
    { "symbol": "bUSDC", "token": "$ASSET", "codeHash": "$(codehash "$ASSET")", "bridgeBucketCapacity": "$USD_BUCKET", "cap": "$USD_CAP" }
  ],
  "initialPairs": [ { "tokenA": "WBLCH", "tokenB": "wGnB" }, { "tokenA": "WBLCH", "tokenB": "bUSDC" } ],
  "gate": { "maxWrappedReserveCap": "10000000000000000000" }
}
JSON

D="node scripts/staging/deploy-dex.mjs"
echo "== validate / plan"
SHA=$($D validate --config "$CONFIG" $FLAG | node -e 'process.stdin.on("data",d=>console.log(JSON.parse(d).configSha256))')
$D plan --config "$CONFIG" $FLAG --write "$WORK/plan.json" > /dev/null
if [ -n "$FLAG" ]; then
  echo "== a development chain without --rehearsal is refused"
  if $D validate --config "$CONFIG" 2> "$WORK/refusal.txt"; then echo "FAIL: accepted without --rehearsal"; exit 1; fi
  cat "$WORK/refusal.txt"
fi
echo "== broadcast without --confirm is refused"
if $D run --config "$CONFIG" --plan "$WORK/plan.json" --rpc "$RPC" $FLAG --broadcast 2> "$WORK/refusal.txt"; then
  echo "FAIL: broadcast without confirmation"; exit 1
fi
cat "$WORK/refusal.txt"
echo "== dry run"
$D run --config "$CONFIG" --plan "$WORK/plan.json" --rpc "$RPC" $FLAG > "$WORK/dry-run.log"
tail -n 4 "$WORK/dry-run.log"
[ "$(cast nonce "$DEPLOYER" --rpc-url "$RPC")" = 0 ] || { echo "FAIL: dry run changed the chain"; exit 1; }
echo "== broadcast"
$D run --config "$CONFIG" --plan "$WORK/plan.json" --rpc "$RPC" $FLAG --broadcast --confirm "$SHA" -- --private-key "$DEPLOYER_KEY" > "$WORK/broadcast.log"
tail -n 4 "$WORK/broadcast.log"
echo "== record"
$D record --config "$CONFIG" --plan "$WORK/plan.json" --rpc "$RPC" $FLAG \
  --broadcast-file "broadcast/DeployMainnet.s.sol/$CHAIN_ID/run-latest.json" --write "$WORK/gate.json"
echo "== on-chain runtime hashes equal the plan"
node -e '
const plan = require(process.argv[1]);
const { execFileSync } = require("node:child_process");
const at = (a) => execFileSync("cast", ["keccak", execFileSync("cast", ["code", a, "--rpc-url", process.argv[2]]).toString().trim()]).toString().trim();
for (const [k, c] of Object.entries(plan.contracts)) if (at(c.address) !== c.codeHash) { console.error("FAIL", k); process.exit(1); }
for (const p of plan.pairs) if (at(p.address) !== p.codeHash) { console.error("FAIL pair"); process.exit(1); }
console.log("runtime hashes ok:", Object.keys(plan.contracts).join(", "), "+", plan.pairs.length, "pair(s); init code hash", plan.pairInitCodeHash);
' "$WORK/plan.json" "$RPC"
echo "== gate before finality is refused"
if node scripts/staging/check-finality-gate.mjs --config "$WORK/gate.json" --rpc "$SHIM" 2> "$WORK/refusal.txt"; then
  echo "FAIL: gate passed before finality"; exit 1
fi
cat "$WORK/refusal.txt"
cast rpc anvil_mine 0x80 --rpc-url "$RPC" > /dev/null
echo "== gate after finality"
node scripts/staging/check-finality-gate.mjs --config "$WORK/gate.json" --rpc "$SHIM" | head -n 12
ROUTER=$(node -e 'console.log(require(process.argv[1]).contracts.router.address)' "$WORK/plan.json")
FACTORY=$(node -e 'console.log(require(process.argv[1]).contracts.factory.address)' "$WORK/plan.json")
WRAPPED=$(node -e 'console.log(require(process.argv[1]).contracts.wrappedNative.address)' "$WORK/plan.json")
PAIR=$(cast call "$FACTORY" "getPair(address,address)(address)" "$WRAPPED" "$ASSET" --rpc-url "$RPC" | tr 'A-F' 'a-f')
[ "$(cast call "$FACTORY" "feeTo()(address)" --rpc-url "$RPC" | tr 'A-F' 'a-f')" = "$BLOCH_INC" ] || { echo "FAIL: feeTo is not Bloch Inc"; exit 1; }
if cast send "$FACTORY" "setFeeTo(address)" "$DEPLOYER" --gas-limit 100000 --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" > "$WORK/setter.log" 2>&1; then
  grep -q "(failed)" "$WORK/setter.log" || { echo "FAIL: the fee recipient was changed"; exit 1; }
fi
echo "== guarded launch: seed 50% of each cap, then an over-cap deposit reverts"
cast send "$ASSET" "approve(address,uint256)" "$ROUTER" 1000000000000 --rpc-url "$RPC" --private-key "$ISSUER_KEY" > /dev/null
cast send "$ROUTER" "addLiquidityBLCH(address,uint256,uint256,uint256,address,uint256)" "$ASSET" 500000000 0 0 "$ISSUER" 99999999999 \
  --value 5000000000000000000 --rpc-url "$RPC" --private-key "$ISSUER_KEY" > /dev/null
if cast send "$ROUTER" "addLiquidityBLCH(address,uint256,uint256,uint256,address,uint256)" "$ASSET" 600000000 0 0 "$ISSUER" 99999999999 \
  --value 6000000000000000000 --gas-limit 3000000 --rpc-url "$RPC" --private-key "$ISSUER_KEY" > "$WORK/overcap.log" 2>&1; then
  grep -q "(failed)" "$WORK/overcap.log" || { echo "FAIL: over-cap liquidity accepted"; exit 1; }
fi
echo "refused as expected"
echo "== protocol fee accrues to the Bloch Inc multisig and it redeems with 2 of 3"
for _ in 1 2 3; do
  cast send "$ROUTER" "swapExactTokensForBLCH(uint256,uint256,address[],address,uint256)" 100000000 0 "[$ASSET,$WRAPPED]" "$ISSUER" 99999999999 \
    --rpc-url "$RPC" --private-key "$ISSUER_KEY" > /dev/null
  cast send "$ROUTER" "swapExactBLCHForTokens(uint256,address[],address,uint256)" 0 "[$WRAPPED,$ASSET]" "$ISSUER" 99999999999 \
    --value 1000000000000000000 --rpc-url "$RPC" --private-key "$ISSUER_KEY" > /dev/null
done
cast send "$ROUTER" "addLiquidityBLCH(address,uint256,uint256,uint256,address,uint256)" "$ASSET" 1000000 0 0 "$ISSUER" 99999999999 \
  --value 10000000000000000 --rpc-url "$RPC" --private-key "$ISSUER_KEY" > /dev/null
FEE=$(cast call "$PAIR" "balanceOf(address)(uint256)" "$BLOCH_INC" --rpc-url "$RPC" | awk '{print $1}')
[ "$FEE" != 0 ] || { echo "FAIL: no protocol fee minted to Bloch Inc"; exit 1; }
TRANSFER=$(cast calldata "transfer(address,uint256)" "$PAIR" "$FEE")
BURN=$(cast calldata "burn(address)" "$BLOCH_INC")
for CALL in "$TRANSFER" "$BURN"; do
  cast send "$BLOCH_INC" "confirm(address,bytes)" "$PAIR" "$CALL" --rpc-url "$RPC" --private-key "$OWNER_A_KEY" > /dev/null
  cast send "$BLOCH_INC" "confirm(address,bytes)" "$PAIR" "$CALL" --rpc-url "$RPC" --private-key "$OWNER_B_KEY" > /dev/null
done
USD_OUT=$(cast call "$ASSET" "balanceOf(address)(uint256)" "$BLOCH_INC" --rpc-url "$RPC" | awk '{print $1}')
W_OUT=$(cast call "$WRAPPED" "balanceOf(address)(uint256)" "$BLOCH_INC" --rpc-url "$RPC" | awk '{print $1}')
[ "$USD_OUT" != 0 ] && [ "$W_OUT" != 0 ] || { echo "FAIL: Bloch Inc could not redeem its fee"; exit 1; }
echo "Bloch Inc fee: $FEE LP -> $W_OUT WBLCH base units + $USD_OUT bUSDC base units"
echo "REHEARSAL OK ($WORK)"
