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
# finality. On the mainnet path Bloch Inc is the official Safe v1.4.1 (SafeL2
# singleton, CompatibilityFallbackHandler, 3-of-5 proxy of anvil accounts),
# deployed from SAFE_ARTIFACTS (the build/artifacts directory of the npm
# package @safe-global/safe-contracts@1.4.1) and pinned in the config; on the
# --rehearsal path it is played by a test-only 2-of-3 multisig contract. The
# two pilot counter-assets (wGSMH, bUSDC) are test-only tokens exposing the
# bridge's bucketCapacity(); the caps are the committed mainnet values.
#
# BLOCH_INC_MODE=owner-eoa (mainnet path only; owner decision of 2026-11-17): Bloch Inc is the owner's
# pinned plain fee address 0x775a…0544 instead of the Safe (no SAFE_ARTIFACTS needed). The preflight
# then reads "no code, no EIP-7702 delegation" from two endpoints at one block hash (--rpc2; here the
# finality shim in front of the same anvil, so it proves the wiring, not operator independence); the
# rehearsal shows the refusals (no --rpc2; a delegation designator set on the address) and redeems the
# protocol fee from the address by anvil impersonation (the owner signs it with the real key).
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
OWNER_C_KEY=0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a
OWNER_D=0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc
OWNER_D_KEY=0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba
OWNER_E=0x976ea74026e726554db657fa54763abd0c3a0aa9
ZERO=0x0000000000000000000000000000000000000000
EXEC="execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)"
ISSUER_KEY=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
ISSUER=0x90f79bf6eb2c4f870365e785982e1f101e93b906
# The factory's first-depositor rule (F1): only this fresh account may make a pair's first deposit
# (anvil's public development account 9; it sends nothing before the seed, so its nonce is 0 at deployment).
DEPOSITOR_KEY=0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6
DEPOSITOR=0xa0ee7a142d267c1f36714e4a8f75612f20a79720
# Committed mainnet caps and the bridge buckets they imply (cap = bucket / 10).
WBLCH_CAP=10000000000000000000
GSMH_CAP=100000000; GSMH_BUCKET=1000000000
USD_CAP=1000000000; USD_BUCKET=10000000000

MODE=${BLOCH_INC_MODE:-safe}
OWNER_FEE_EOA=0x775a993f09bd80aecf8f8c2ade0c84158e3a0544
EMPTY_CODE_HASH=0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470
case "$MODE" in safe|owner-eoa) ;; *) echo "BLOCH_INC_MODE must be safe or owner-eoa" >&2; exit 2 ;; esac
case "$CHAIN_ID" in
  700771|31337) FLAG=--rehearsal; NAME=local-rehearsal; REHEARSAL=true
     [ "$MODE" = safe ] || { echo "BLOCH_INC_MODE=owner-eoa is a mainnet-path rehearsal (chain 700770)" >&2; exit 2; } ;;
  *) FLAG=; NAME=bloch-l2-mainnet; REHEARSAL=false
     [ "$MODE" = owner-eoa ] || [ -d "${SAFE_ARTIFACTS:-}/contracts" ] || {
       echo "the mainnet path needs SAFE_ARTIFACTS=<@safe-global/safe-contracts@1.4.1 build/artifacts>: Bloch Inc is the pinned Safe v1.4.1" >&2; exit 1; } ;;
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
if [ "$MODE" = owner-eoa ]; then
  BLOCH_INC=$OWNER_FEE_EOA
  BLOCH_INC_JSON="{ \"address\": \"$BLOCH_INC\", \"codeHash\": \"$EMPTY_CODE_HASH\" }"
elif [ -n "$FLAG" ]; then
  BLOCH_INC=$(forge create test/mocks/RehearsalMultisig.sol:RehearsalMultisig --rpc-url "$RPC" --private-key "$ISSUER_KEY" \
    --broadcast --constructor-args "[$OWNER_A,$OWNER_B,$OWNER_C]" 2 | created)
  BLOCH_INC_JSON="{ \"address\": \"$BLOCH_INC\", \"codeHash\": \"$(codehash "$BLOCH_INC")\" }"
else
  # Official Safe v1.4.1 by CREATE (runbook step 0, fallback path), then a 3-of-5 proxy.
  artifact() { node -e 'console.log(require(process.argv[1])[process.argv[2]])' "$SAFE_ARTIFACTS/contracts/$1" "$2"; }
  deploy() { cast send --rpc-url "$RPC" --private-key "$ISSUER_KEY" --create "$(artifact "$1" bytecode)" --json | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).contractAddress.toLowerCase())'; }
  SINGLETON=$(deploy SafeL2.sol/SafeL2.json)
  SAFE_FACTORY=$(deploy proxies/SafeProxyFactory.sol/SafeProxyFactory.json)
  HANDLER=$(deploy handler/CompatibilityFallbackHandler.sol/CompatibilityFallbackHandler.json)
  OWNERS=$(printf '%s\n' "$OWNER_A" "$OWNER_B" "$OWNER_C" "$OWNER_D" "$OWNER_E" | sort | paste -sd, -)
  SETUP=$(cast calldata "setup(address[],uint256,address,bytes,address,address,uint256,address)" "[$OWNERS]" 3 "$ZERO" 0x "$HANDLER" "$ZERO" 0 "$ZERO")
  BLOCH_INC=$(cast call "$SAFE_FACTORY" "createProxyWithNonce(address,bytes,uint256)(address)" "$SINGLETON" "$SETUP" 1 --from "$ISSUER" --rpc-url "$RPC" | tr 'A-F' 'a-f')
  cast send "$SAFE_FACTORY" "createProxyWithNonce(address,bytes,uint256)" "$SINGLETON" "$SETUP" 1 --rpc-url "$RPC" --private-key "$ISSUER_KEY" > /dev/null
  BLOCH_INC_JSON=$(node -e '
const [address, codeHash, singleton, singletonHash, handler, handlerHash, owners] = process.argv.slice(1);
console.log(JSON.stringify({ address, codeHash, safe: { version: "1.4.1", singleton: { address: singleton, codeHash: singletonHash },
  fallbackHandler: { address: handler, codeHash: handlerHash }, threshold: 3, owners: owners.split(",") } }));
' "$BLOCH_INC" "$(codehash "$BLOCH_INC")" "$SINGLETON" "$(codehash "$SINGLETON")" "$HANDLER" "$(codehash "$HANDLER")" "$OWNERS")
fi
GSMH=$(forge create test/mocks/RehearsalBridgedToken.sol:RehearsalBridgedToken --rpc-url "$RPC" --private-key "$ISSUER_KEY" \
  --broadcast --constructor-args "Rehearsal wGSMH" "wGSMH" 8 100000000000000 "$ISSUER" "$GSMH_BUCKET" | created)
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
  "firstDepositor": "${FIRST_DEPOSITOR:-$DEPOSITOR}",
  "blochInc": $BLOCH_INC_JSON,
  "wrappedNative": { "deploy": true },
  "fees": { "feeTo": "blochInc" },
  "reserveCaps": [
    { "token": "WBLCH", "cap": "$WBLCH_CAP" },
    { "symbol": "wGSMH", "token": "$GSMH", "codeHash": "$(codehash "$GSMH")", "bridgeBucketCapacity": "$GSMH_BUCKET", "cap": "$GSMH_CAP" },
    { "symbol": "bUSDC", "token": "$ASSET", "codeHash": "$(codehash "$ASSET")", "bridgeBucketCapacity": "$USD_BUCKET", "cap": "$USD_CAP" }
  ],
  "openingPrice": { "symbol": "bUSDC", "quotePerWrapped": "100000000" },
  "initialPairs": [ { "tokenA": "WBLCH", "tokenB": "wGSMH" }, { "tokenA": "WBLCH", "tokenB": "bUSDC" } ],
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
RPC2=()
if [ "$MODE" = owner-eoa ]; then
  RPC2=(--rpc2 "$SHIM")
  echo "== owner-eoa: a preflight without a second endpoint is refused"
  if $D preflight --config "$CONFIG" --plan "$WORK/plan.json" --rpc "$RPC" 2> "$WORK/refusal.txt"; then echo "FAIL: one endpoint accepted"; exit 1; fi
  cat "$WORK/refusal.txt"
  echo "== owner-eoa: an EIP-7702 delegation on the fee address is refused"
  cast rpc anvil_setCode "$BLOCH_INC" 0xef010063c0c19a282a1b52b07dd5a65b58948a07dae32b --rpc-url "$RPC" > /dev/null
  if $D preflight --config "$CONFIG" --plan "$WORK/plan.json" --rpc "$RPC" "${RPC2[@]}" 2> "$WORK/refusal.txt"; then echo "FAIL: delegated fee address accepted"; exit 1; fi
  cat "$WORK/refusal.txt"
  cast rpc anvil_setCode "$BLOCH_INC" 0x --rpc-url "$RPC" > /dev/null
  echo "== owner-eoa: preflight from two endpoints at one block hash"
  $D preflight --config "$CONFIG" --plan "$WORK/plan.json" --rpc "$RPC" "${RPC2[@]}" | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")); if(!r.ownerFeeEoa||r.ownerFeeEoa.endpoints!==2){console.error("FAIL: no two-endpoint check");process.exit(1)} console.log("owner fee address: no code at block", r.ownerFeeEoa.block.number, r.ownerFeeEoa.block.hash, "on", r.ownerFeeEoa.endpoints, "endpoints")'
fi
echo "== broadcast without --confirm is refused"
if $D run --config "$CONFIG" --plan "$WORK/plan.json" --rpc "$RPC" $FLAG --broadcast 2> "$WORK/refusal.txt"; then
  echo "FAIL: broadcast without confirmation"; exit 1
fi
cat "$WORK/refusal.txt"
echo "== dry run"
$D run --config "$CONFIG" --plan "$WORK/plan.json" --rpc "$RPC" ${RPC2[@]+"${RPC2[@]}"} $FLAG > "$WORK/dry-run.log"
tail -n 4 "$WORK/dry-run.log"
[ "$(cast nonce "$DEPLOYER" --rpc-url "$RPC")" = 0 ] || { echo "FAIL: dry run changed the chain"; exit 1; }
echo "== broadcast"
$D run --config "$CONFIG" --plan "$WORK/plan.json" --rpc "$RPC" ${RPC2[@]+"${RPC2[@]}"} $FLAG --broadcast --confirm "$SHA" -- --private-key "$DEPLOYER_KEY" > "$WORK/broadcast.log"
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
if node scripts/staging/check-finality-gate.mjs --rehearsal-chain --config "$WORK/gate.json" --rpc "$SHIM" 2> "$WORK/refusal.txt"; then
  echo "FAIL: gate passed before finality"; exit 1
fi
cat "$WORK/refusal.txt"
cast rpc anvil_mine 0x80 --rpc-url "$RPC" > /dev/null
echo "== gate after finality"
node scripts/staging/check-finality-gate.mjs --rehearsal-chain --config "$WORK/gate.json" --rpc "$SHIM" | head -n 12
ROUTER=$(node -e 'console.log(require(process.argv[1]).contracts.router.address)' "$WORK/plan.json")
FACTORY=$(node -e 'console.log(require(process.argv[1]).contracts.factory.address)' "$WORK/plan.json")
WRAPPED=$(node -e 'console.log(require(process.argv[1]).contracts.wrappedNative.address)' "$WORK/plan.json")
PAIR=$(cast call "$FACTORY" "getPair(address,address)(address)" "$WRAPPED" "$ASSET" --rpc-url "$RPC" | tr 'A-F' 'a-f')
[ "$(cast call "$FACTORY" "feeTo()(address)" --rpc-url "$RPC" | tr 'A-F' 'a-f')" = "$BLOCH_INC" ] || { echo "FAIL: feeTo is not Bloch Inc"; exit 1; }
if cast send "$FACTORY" "setFeeTo(address)" "$DEPLOYER" --gas-limit 100000 --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" > "$WORK/setter.log" 2>&1; then
  grep -q "(failed)" "$WORK/setter.log" || { echo "FAIL: the fee recipient was changed"; exit 1; }
fi
echo "== guarded launch: a first deposit by anyone but the first depositor reverts; the depositor seeds 50% of each cap; an over-cap deposit reverts"
cast send "$ASSET" "approve(address,uint256)" "$ROUTER" 1000000000000 --rpc-url "$RPC" --private-key "$ISSUER_KEY" > /dev/null
if cast send "$ROUTER" "addLiquidityBLCH(address,uint256,uint256,uint256,address,uint256)" "$ASSET" 500000000 0 0 "$ISSUER" 99999999999 \
  --value 5000000000000000000 --gas-limit 3000000 --rpc-url "$RPC" --private-key "$ISSUER_KEY" > "$WORK/stranger.log" 2>&1; then
  grep -q "(failed)" "$WORK/stranger.log" || { echo "FAIL: a stranger made the first deposit"; exit 1; }
fi
cast send "$ASSET" "transfer(address,uint256)" "$DEPOSITOR" 500000000 --rpc-url "$RPC" --private-key "$ISSUER_KEY" > /dev/null
cast send "$ASSET" "approve(address,uint256)" "$ROUTER" 500000000 --rpc-url "$RPC" --private-key "$DEPOSITOR_KEY" > /dev/null
cast send "$ROUTER" "addLiquidityBLCH(address,uint256,uint256,uint256,address,uint256)" "$ASSET" 500000000 0 0 "$DEPOSITOR" 99999999999 \
  --value 5000000000000000000 --rpc-url "$RPC" --private-key "$DEPOSITOR_KEY" > /dev/null
if cast send "$ROUTER" "addLiquidityBLCH(address,uint256,uint256,uint256,address,uint256)" "$ASSET" 600000000 0 0 "$ISSUER" 99999999999 \
  --value 6000000000000000000 --gas-limit 3000000 --rpc-url "$RPC" --private-key "$ISSUER_KEY" > "$WORK/overcap.log" 2>&1; then
  grep -q "(failed)" "$WORK/overcap.log" || { echo "FAIL: over-cap liquidity accepted"; exit 1; }
fi
echo "refused as expected"
echo "== protocol fee accrues to Bloch Inc and it redeems it (Safe: 3 of 5; test multisig: 2 of 3)"
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
if [ "$MODE" = owner-eoa ]; then
  # The owner's plain address sends the two calls itself (here by anvil impersonation; for real, with the owner's key).
  cast rpc anvil_impersonateAccount "$BLOCH_INC" --rpc-url "$RPC" > /dev/null
  cast rpc anvil_setBalance "$BLOCH_INC" 0x16345785d8a0000 --rpc-url "$RPC" > /dev/null
  cast send "$PAIR" "transfer(address,uint256)" "$PAIR" "$FEE" --unlocked --from "$BLOCH_INC" --rpc-url "$RPC" > /dev/null
  cast send "$PAIR" "burn(address)" "$BLOCH_INC" --unlocked --from "$BLOCH_INC" --rpc-url "$RPC" > /dev/null
  cast rpc anvil_stopImpersonatingAccount "$BLOCH_INC" --rpc-url "$RPC" > /dev/null
fi
for CALL in "$TRANSFER" "$BURN"; do
  [ "$MODE" = owner-eoa ] && break
  if [ -n "$FLAG" ]; then
    cast send "$BLOCH_INC" "confirm(address,bytes)" "$PAIR" "$CALL" --rpc-url "$RPC" --private-key "$OWNER_A_KEY" > /dev/null
    cast send "$BLOCH_INC" "confirm(address,bytes)" "$PAIR" "$CALL" --rpc-url "$RPC" --private-key "$OWNER_B_KEY" > /dev/null
    continue
  fi
  # Safe: 3 of 5 owner signatures over the Safe transaction hash, packed in owner order.
  NONCE=$(cast call "$BLOCH_INC" "nonce()(uint256)" --rpc-url "$RPC")
  HASH=$(cast call "$BLOCH_INC" "getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)(bytes32)" \
    "$PAIR" 0 "$CALL" 0 0 0 0 "$ZERO" "$ZERO" "$NONCE" --rpc-url "$RPC")
  SIGS=0x
  for KEY in $(for K in "$OWNER_A_KEY" "$OWNER_C_KEY" "$OWNER_D_KEY"; do echo "$(cast wallet address --private-key "$K" | tr 'A-F' 'a-f') $K"; done | sort | awk '{print $2}'); do
    SIGS+=$(cast wallet sign --no-hash "$HASH" --private-key "$KEY" | cut -c3-)
  done
  TWO=${SIGS:0:262}
  if cast send "$BLOCH_INC" "$EXEC" "$PAIR" 0 "$CALL" 0 0 0 0 "$ZERO" "$ZERO" "$TWO" --gas-limit 300000 \
    --rpc-url "$RPC" --private-key "$ISSUER_KEY" > "$WORK/two-sigs.log" 2>&1; then
    grep -q "(failed)" "$WORK/two-sigs.log" || { echo "FAIL: the Safe executed with two signatures"; exit 1; }
  fi
  cast send "$BLOCH_INC" "$EXEC" "$PAIR" 0 "$CALL" 0 0 0 0 "$ZERO" "$ZERO" "$SIGS" --rpc-url "$RPC" --private-key "$ISSUER_KEY" > /dev/null
done
USD_OUT=$(cast call "$ASSET" "balanceOf(address)(uint256)" "$BLOCH_INC" --rpc-url "$RPC" | awk '{print $1}')
W_OUT=$(cast call "$WRAPPED" "balanceOf(address)(uint256)" "$BLOCH_INC" --rpc-url "$RPC" | awk '{print $1}')
[ "$USD_OUT" != 0 ] && [ "$W_OUT" != 0 ] || { echo "FAIL: Bloch Inc could not redeem its fee"; exit 1; }
[ -n "$FLAG" ] || [ "$MODE" = owner-eoa ] || echo "Bloch Inc Safe v1.4.1 $BLOCH_INC (3 of 5) redeemed with execTransaction; two signatures were refused"
[ "$MODE" != owner-eoa ] || echo "Bloch Inc = the owner's plain fee address $BLOCH_INC (no code at deployment, read from two endpoints); fee redeemed by the address itself"
echo "Bloch Inc fee: $FEE LP -> $W_OUT WBLCH base units + $USD_OUT bUSDC base units"
echo "REHEARSAL OK ($WORK)"
