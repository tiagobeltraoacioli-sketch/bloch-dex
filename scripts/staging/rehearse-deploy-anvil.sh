#!/usr/bin/env bash
# End-to-end rehearsal of the mainnet DEX deployment procedure on a throwaway
# local anvil chain: config -> plan -> dry run -> broadcast -> record ->
# finality gate (schema 2). Never point this at a real network: it starts its
# own anvil on 127.0.0.1 and uses anvil's public development keys.
#
#   scripts/staging/rehearse-deploy-anvil.sh <revision> [chain-id] [port]
#
# A non-development chain ID (default 7007700) exercises the mainnet path; 700771
# exercises the explicit --rehearsal path. The bloch_finality method is served
# by a local shim that mirrors anvil's `finalized` tag; it proves the tooling,
# not Bloch finality.
set -euo pipefail

REVISION=${1:?usage: rehearse-deploy-anvil.sh <40-hex revision> [chain-id] [port]}
CHAIN_ID=${2:-7007700}
PORT=${3:-18571}
SHIM_PORT=$((PORT + 1))
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
WORK=$(mktemp -d)
RPC=http://127.0.0.1:$PORT
SHIM=http://127.0.0.1:$SHIM_PORT

# anvil's well-known development accounts 0..3 (public test keys).
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
DEPLOYER=0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266
FEE_TO_SETTER=0x70997970c51812dc3a010c7d01b50e0d17dc79c8
TREASURY=0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc
ISSUER_KEY=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
ISSUER=0x90f79bf6eb2c4f870365e785982e1f101e93b906
EMPTY=0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470

case "$CHAIN_ID" in
  700771|31337) FLAG=--rehearsal; NAME=local-rehearsal; REHEARSAL=true ;;
  *) FLAG=; NAME=bloch-l2-mainnet-like; REHEARSAL=false ;;
esac

anvil --chain-id "$CHAIN_ID" --port "$PORT" --silent > "$WORK/anvil.log" 2>&1 &
ANVIL=$!
node scripts/fixtures/anvil-finality-shim.mjs "$RPC" "$SHIM_PORT" > "$WORK/shim.log" 2>&1 &
SHIMPID=$!
trap 'kill $ANVIL $SHIMPID 2>/dev/null || true' EXIT
for _ in $(seq 50); do cast chain-id --rpc-url "$RPC" > /dev/null 2>&1 && break; sleep 0.2; done

forge build > "$WORK/build.log" 2>&1 || { tail -n 30 "$WORK/build.log"; exit 1; }
ASSET=$(forge create contracts/assets/BlochAsset.sol:BlochAsset --rpc-url "$RPC" --private-key "$ISSUER_KEY" --broadcast \
  --constructor-args "Rehearsal USD" "rUSD" 6 1000000000000 "$ISSUER" | awk '/Deployed to:/ {print tolower($3)}')
ASSET_CODEHASH=$(cast keccak "$(cast code "$ASSET" --rpc-url "$RPC")")
GENESIS=$(cast block 0 --field hash --rpc-url "$RPC")
CONFIG="$WORK/config.json"
cat > "$CONFIG" <<JSON
{
  "schemaVersion": 1,
  "domain": "postern.dex.mainnet-deploy.v1",
  "network": { "name": "$NAME", "chainId": $CHAIN_ID, "genesisHash": "$GENESIS", "rehearsal": $REHEARSAL },
  "source": { "revision": "$REVISION", "compiler": { "solc": "0.8.24", "evmVersion": "paris", "optimizer": true, "optimizerRuns": 200, "bytecodeHash": "none" } },
  "deployer": { "address": "$DEPLOYER", "startNonce": 0 },
  "wrappedNative": { "deploy": true },
  "fees": { "feeTo": null, "feeToSetter": { "address": "$FEE_TO_SETTER", "codeHash": "$EMPTY" }, "treasury": { "address": "$TREASURY", "codeHash": "$EMPTY" } },
  "reserveCaps": [ { "token": "WBLCH", "cap": "1200000000000000000" }, { "token": "$ASSET", "symbol": "rUSD", "codeHash": "$ASSET_CODEHASH", "cap": "10000000" } ],
  "initialPairs": [ { "tokenA": "WBLCH", "tokenB": "$ASSET" } ],
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
echo "== over-cap liquidity reverts on chain"
ROUTER=$(node -e 'console.log(require(process.argv[1]).contracts.router.address)' "$WORK/plan.json")
cast send "$ASSET" "approve(address,uint256)" "$ROUTER" 10000000 --rpc-url "$RPC" --private-key "$ISSUER_KEY" > /dev/null
if cast send "$ROUTER" "addLiquidityBLCH(address,uint256,uint256,uint256,address,uint256)" "$ASSET" 1000000 0 0 "$ISSUER" 99999999999 \
  --value 1300000000000000000 --gas-limit 3000000 --rpc-url "$RPC" --private-key "$ISSUER_KEY" > "$WORK/overcap.log" 2>&1; then
  grep -q "(failed)" "$WORK/overcap.log" || { echo "FAIL: over-cap liquidity accepted"; exit 1; }
fi
echo "refused as expected"
echo "REHEARSAL OK ($WORK)"
