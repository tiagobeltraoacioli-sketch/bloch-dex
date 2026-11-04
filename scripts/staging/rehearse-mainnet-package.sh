#!/usr/bin/env bash
# Full dry run of the Bloch L2 mainnet (700770) deployment package on a
# private, loopback-only chain with throwaway keys generated here:
#
#   anvil       anvil --chain-id 700770 (its genesis differs from the pin, so
#               the mainnet gate wrapper must refuse it; the generic gate is
#               run through the anvil finality shim)
#   private-l2  the v2.1 L2 binaries under the mainnet rules: chain 700770 and
#               the pinned genesis 0x632e45ae…f468 (scripts/staging/private-l2.sh),
#               so the mainnet gate wrapper itself must pass
#
# Steps (every transaction signed offline with `cast mktx` and published with
# `cast publish`, explicit nonce, gas limit and fees):
#   infra: Multicall3 and the CREATE2 deployer, ordinary deployments (recorded
#     addresses, canonical runtime hashes checked);
#   0 Safe: config -> plan -> preflight -> txs -> sign-and-publish (bootstrap
#     key: SafeL2 singleton, SafeProxyFactory, CompatibilityFallbackHandler,
#     3-of-5 proxy) -> verify;
#   1 DEX: config (Bloch Inc from the Safe plan) -> plan -> preflight + forge
#     dry run -> txs -> sign-and-publish (WBLCH, factory, router, lens,
#     createPair WBLCH/bUSDC) -> record -> verify-deployment;
#   2 gate before finality refused; finality; gate passes;
#   3 guarded launch: 50% seed, over-cap refused, swaps, protocol fee to the
#     Safe, the Safe redeems it with 3 of 5 signatures after 2 are refused;
#     an over-cap swap reverts and the lens says so; a donation above the cap
#     is reported by the lens, blocks swaps and is cleared by skim; both
#     utility contracts work in real calls.
#   With RENDER_HOOK=scripts/staging/render/render-hook.sh: browser phase.
#
#   SAFE_ARTIFACTS=<safe-contracts 1.4.1 build/artifacts> \
#     scripts/staging/rehearse-mainnet-package.sh anvil <revision> [port] [work]
#   SAFE_ARTIFACTS=… PRODUCE_DEV=… SETTLED_RPC=… \
#     scripts/staging/rehearse-mainnet-package.sh private-l2 <revision> [port] [work]
set -euo pipefail

MODE=${1:?usage: rehearse-mainnet-package.sh anvil|private-l2 <revision> [port] [work]}
REVISION=${2:?40-hex revision required}
PORT=${3:-28771}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
WORK=${4:-$(mktemp -d)}
mkdir -p "$WORK/evidence"
EV=$WORK/evidence
RPC=http://127.0.0.1:$PORT
[ -d "${SAFE_ARTIFACTS:-}/contracts" ] || { echo "SAFE_ARTIFACTS=<@safe-global/safe-contracts@1.4.1 build/artifacts> is required" >&2; exit 1; }
MAXFEE=5000000000; TIP=1000000000
ZERO=0x0000000000000000000000000000000000000000
EXEC="execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)"
USD_BUCKET=10000000000
log() { echo "== $*" | tee -a "$EV/steps.log"; }

# Throwaway keys, generated for this run only.
umask 077
cast wallet new --number 10 --json > "$WORK/keys.json"
umask 022
key() { node -e 'console.log(require(process.argv[1])[Number(process.argv[2])].private_key)' "$WORK/keys.json" "$1"; }
addr() { node -e 'console.log(require(process.argv[1])[Number(process.argv[2])].address.toLowerCase())' "$WORK/keys.json" "$1"; }
BOOT_KEY=$(key 0); BOOT=$(addr 0); DEPLOYER_KEY=$(key 1); DEPLOYER=$(addr 1); ISSUER_KEY=$(key 2); ISSUER=$(addr 2)
OWNER_KEYS=("$(key 3)" "$(key 4)" "$(key 5)" "$(key 6)" "$(key 7)")
OWNERS=("$(addr 3)" "$(addr 4)" "$(addr 5)" "$(addr 6)" "$(addr 7)")
INFRA_KEY=$(key 8); INFRA=$(addr 8)
DEPOSITOR_KEY=$(key 9); DEPOSITOR=$(addr 9)

PIDS=()
cleanup() {
  [ "$MODE" = private-l2 ] && scripts/staging/private-l2.sh stop "$WORK/l2" > /dev/null 2>&1 || true
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
}
trap cleanup EXIT

forge build > "$WORK/build.log" 2>&1 || { tail -n 30 "$WORK/build.log"; exit 1; }
case "$MODE" in
  anvil)
    # HOLD_TOKEN (agent 144): the V3 token's 12 h mint delay passes on the chain clock, so the chain starts that far back.
    ANVIL_ARGS=(--chain-id 700770 --port "$PORT" --host 127.0.0.1)
    [ -n "${HOLD_TOKEN:-}" ] && ANVIL_ARGS+=(--timestamp $(( $(date +%s) - 43900 )))
    anvil "${ANVIL_ARGS[@]}" --silent > "$WORK/anvil.log" 2>&1 &
    PIDS+=($!)
    node scripts/fixtures/anvil-finality-shim.mjs "$RPC" $((PORT + 1)) > "$WORK/shim.log" 2>&1 &
    PIDS+=($!)
    for _ in $(seq 50); do cast chain-id --rpc-url "$RPC" > /dev/null 2>&1 && break; sleep 0.2; done
    for a in "$BOOT" "$DEPLOYER" "$ISSUER" "$INFRA" "$DEPOSITOR"; do cast rpc anvil_setBalance "$a" 0x56bc75e2d63100000 --rpc-url "$RPC" > /dev/null; done
    ;;
  private-l2)
    : "${PRODUCE_DEV:?}" "${SETTLED_RPC:?}"
    export PRODUCE_DEV SETTLED_RPC
    mkdir -p "$WORK/l2"
    scripts/staging/private-l2.sh init "$WORK/l2" "$BOOT,$DEPLOYER,$ISSUER,$INFRA,$DEPOSITOR" 10000000000 | tee -a "$EV/steps.log"
    scripts/staging/private-l2.sh start "$WORK/l2" "$PORT" | tee -a "$EV/steps.log"
    ;;
  *) echo "mode must be anvil or private-l2" >&2; exit 2 ;;
esac
GENESIS=$(cast block 0 --field hash --rpc-url "$RPC")
log "chain $(cast chain-id --rpc-url "$RPC") genesis $GENESIS ($MODE)"

# send KEY TO|create DATA VALUE GAS -> prints the receipt status (0x1/0x0)
send() {
  local k=$1 to=$2 data=$3 value=$4 gas=$5 from nonce raw hash receipt
  from=$(cast wallet address --private-key "$k")
  nonce=$(cast nonce "$from" --block latest --rpc-url "$RPC")
  if [ "$to" = create ]; then
    raw=$(cast mktx --chain 700770 --nonce "$nonce" --gas-limit "$gas" --gas-price $MAXFEE --priority-gas-price $TIP --value "$value" --private-key "$k" --create "$data")
  else
    raw=$(cast mktx --chain 700770 --nonce "$nonce" --gas-limit "$gas" --gas-price $MAXFEE --priority-gas-price $TIP --value "$value" --private-key "$k" "$to" "$data")
  fi
  hash=$(cast keccak "$raw")
  cast publish --rpc-url "$RPC" "$raw" > /dev/null
  for _ in $(seq 300); do
    receipt=$(cast rpc eth_getTransactionReceipt "$hash" --rpc-url "$RPC")
    if [ "$receipt" != null ]; then
      # Wait until `latest` reaches the receipt's block (the settled RPC's view can lag its receipts).
      local block; block=$(node -e 'console.log(BigInt(JSON.parse(process.argv[1]).blockNumber).toString())' "$receipt")
      until [ "$(cast block-number --rpc-url "$RPC")" -ge "$block" ]; do sleep 1; done
      node -e 'const r=JSON.parse(process.argv[1]);console.log(r.status, r.contractAddress ?? "")' "$receipt"; return
    fi
    sleep 1
  done
  echo "no receipt for $hash" >&2; return 1
}
must() { local out; out=$(send "$@"); [ "${out%% *}" = 0x1 ] || { echo "FAIL: transaction reverted" >&2; exit 1; }; echo "$out"; }
must_fail() { local out; out=$(send "$@"); [ "${out%% *}" = 0x0 ] || { echo "FAIL: transaction succeeded" >&2; exit 1; }; }
jsonget() { node -e 'const v=process.argv[2].split(".").reduce((o,k)=>o[k],require(require("path").resolve(process.argv[1])));console.log(typeof v==="object"?JSON.stringify(v):v)' "$1" "$2"; }

# ---------------------------------------------------------------- infra
log "infra: committed config lists what is pending"
node scripts/staging/deploy-infra.mjs pending --config deployments/mainnet/700770/infra.config.json | tee "$EV/infra.pending.json"
if node scripts/staging/deploy-infra.mjs validate --config deployments/mainnet/700770/infra.config.json 2> "$EV/infra.refusal.txt"; then
  echo "FAIL: committed infra config with TBD-owner accepted"; exit 1
fi
cat "$EV/infra.refusal.txt"
node -e '
const c = JSON.parse(require("fs").readFileSync("deployments/mainnet/700770/infra.config.json", "utf8"));
const [genesis, key] = process.argv.slice(1);
c.network.genesisHash = genesis; c.deployer.address = key;
console.log(JSON.stringify(c, null, 2));' "$GENESIS" "$INFRA" > "$EV/infra.config.json"
INFRA_CMD=node\ scripts/staging/deploy-infra.mjs
$INFRA_CMD validate --config "$EV/infra.config.json" | tee "$EV/infra.validate.json"
INFRA_SHA=$(jsonget "$EV/infra.validate.json" configSha256)
$INFRA_CMD plan --config "$EV/infra.config.json" --write "$EV/infra.plan.json" > /dev/null
$INFRA_CMD preflight --config "$EV/infra.config.json" --plan "$EV/infra.plan.json" --rpc "$RPC" | tee "$EV/infra.preflight.json"
$INFRA_CMD txs --config "$EV/infra.config.json" --plan "$EV/infra.plan.json" --write "$WORK/infra.txs.json" | tee -a "$EV/steps.log"
log "infra: sign (cast mktx) and publish (cast publish)"
scripts/staging/sign-and-publish.sh --txs "$WORK/infra.txs.json" --rpc "$RPC" --confirm "$INFRA_SHA" --max-fee-wei $MAXFEE --priority-fee-wei $TIP \
  --hashes-out "$EV/infra.hashes.txt" -- --private-key "$INFRA_KEY" 2>&1 | tee "$EV/infra.publish.log"
MULTICALL=$(jsonget "$EV/infra.plan.json" contracts.multicall3.address)
CREATE2=$(jsonget "$EV/infra.plan.json" contracts.create2Deployer.address)
log "infra: Multicall3 $MULTICALL, CREATE2 deployer $CREATE2"

# ---------------------------------------------------------------- 0 Safe
log "0 Safe: committed mainnet config lists what is pending"
node scripts/staging/deploy-safe.mjs pending --config deployments/mainnet/700770/safe.config.json | tee "$EV/safe.pending.json"
if node scripts/staging/deploy-safe.mjs validate --config deployments/mainnet/700770/safe.config.json 2> "$EV/safe.refusal.txt"; then
  echo "FAIL: committed Safe config with TBD-owner accepted"; exit 1
fi
cat "$EV/safe.refusal.txt"
OWNERS_JSON=$(printf '"%s",' "${OWNERS[@]}"); OWNERS_JSON="[${OWNERS_JSON%,}]"
node -e '
const c = JSON.parse(require("fs").readFileSync("deployments/mainnet/700770/safe.config.json", "utf8"));
const [genesis, boot, owners] = process.argv.slice(1);
c.network.genesisHash = genesis; c.bootstrap.address = boot; c.safe.owners = JSON.parse(owners);
console.log(JSON.stringify(c, null, 2));' "$GENESIS" "$BOOT" "$OWNERS_JSON" > "$EV/safe.config.json"
SAFE=node\ scripts/staging/deploy-safe.mjs
$SAFE validate --config "$EV/safe.config.json" | tee "$EV/safe.validate.json"
SAFE_SHA=$(jsonget "$EV/safe.validate.json" configSha256)
$SAFE plan --config "$EV/safe.config.json" --artifacts "$SAFE_ARTIFACTS" --write "$EV/safe.plan.json" > /dev/null
$SAFE preflight --config "$EV/safe.config.json" --artifacts "$SAFE_ARTIFACTS" --plan "$EV/safe.plan.json" --rpc "$RPC" | tee "$EV/safe.preflight.json"
$SAFE txs --config "$EV/safe.config.json" --artifacts "$SAFE_ARTIFACTS" --plan "$EV/safe.plan.json" --write "$WORK/safe.txs.json" | tee -a "$EV/steps.log"
log "0 Safe: wrong confirmation is refused"
if scripts/staging/sign-and-publish.sh --txs "$WORK/safe.txs.json" --rpc "$RPC" --confirm 0x00 --max-fee-wei $MAXFEE --priority-fee-wei $TIP \
  --hashes-out "$WORK/never.txt" -- --private-key "$BOOT_KEY" 2> "$EV/safe.no-confirm.txt"; then echo "FAIL: published without confirmation"; exit 1; fi
cat "$EV/safe.no-confirm.txt"
log "0 Safe: sign (cast mktx) and publish (cast publish)"
scripts/staging/sign-and-publish.sh --txs "$WORK/safe.txs.json" --rpc "$RPC" --confirm "$SAFE_SHA" --max-fee-wei $MAXFEE --priority-fee-wei $TIP \
  --hashes-out "$EV/safe.hashes.txt" -- --private-key "$BOOT_KEY" 2>&1 | tee "$EV/safe.publish.log"
$SAFE blochinc --plan "$EV/safe.plan.json" > "$EV/blochinc.json"
BLOCH_INC=$(jsonget "$EV/blochinc.json" address)
log "0 Safe: Bloch Inc = $BLOCH_INC"

# ---------------------------------------------------------------- 1 DEX
log "1 DEX: test bUSDC with bucketCapacity() (stands in for the bridge token)"
if [ -n "${HOLD_TOKEN:-}" ]; then
  # agent 144: BridgedStablecoinV3 over a ProvenanceSourceVault on a second anvil (scripts/staging/render/hold-token.sh)
  # shellcheck source=/dev/null
  . "$HOLD_TOKEN"
else
  TOKEN_INIT=$(node -e 'const a=require(process.argv[1]);console.log(a.bytecode.object)' "$ROOT/out/RehearsalBridgedToken.sol/RehearsalBridgedToken.json")$(cast abi-encode "c(string,string,uint8,uint256,address,uint256)" "Rehearsal bUSDC" bUSDC 6 1000000000000 "$ISSUER" $USD_BUCKET | cut -c3-)
  ASSET=$(must "$ISSUER_KEY" create "$TOKEN_INIT" 0 3000000 | awk '{print tolower($2)}')
  ASSET_CODE=$(cast keccak "$(cast code "$ASSET" --rpc-url "$RPC")")
fi
log "1 DEX: committed mainnet config lists what is pending"
node scripts/staging/deploy-dex.mjs pending --config deployments/mainnet/dex-mainnet.config.json | tee "$EV/dex.pending.json"
FIRST_DEPOSITOR=$DEPOSITOR node -e '
const c = JSON.parse(require("fs").readFileSync("deployments/mainnet/dex-mainnet.config.json", "utf8"));
const [genesis, revision, deployer, blochInc, token, codeHash] = process.argv.slice(1);
c.network.genesisHash = genesis; c.source.revision = revision; c.deployer.address = deployer;
c.openingPrice.quotePerWrapped = "100000000";
c.firstDepositor = process.env.FIRST_DEPOSITOR;
c.blochInc = JSON.parse(require("fs").readFileSync(blochInc, "utf8"));
Object.assign(c.reserveCaps[1], { token, codeHash });
console.log(JSON.stringify(c, null, 2));' "$GENESIS" "$REVISION" "$DEPLOYER" "$EV/blochinc.json" "$ASSET" "$ASSET_CODE" > "$EV/dex.config.json"
D=node\ scripts/staging/deploy-dex.mjs
$D validate --config "$EV/dex.config.json" | tee "$EV/dex.validate.json"
DEX_SHA=$(jsonget "$EV/dex.validate.json" configSha256)
$D plan --config "$EV/dex.config.json" --write "$EV/dex.plan.json" > /dev/null
log "1 DEX: preflight and forge dry run (simulation only)"
$D run --config "$EV/dex.config.json" --plan "$EV/dex.plan.json" --rpc "$RPC" > "$EV/dex.dry-run.log" 2>&1 || { tail -n 30 "$EV/dex.dry-run.log"; exit 1; }
tail -n 6 "$EV/dex.dry-run.log"
[ "$(cast nonce "$DEPLOYER" --rpc-url "$RPC")" = 0 ] || { echo "FAIL: the dry run changed the chain"; exit 1; }
$D txs --config "$EV/dex.config.json" --plan "$EV/dex.plan.json" --write "$WORK/dex.txs.json" | tee -a "$EV/steps.log"
log "1 DEX: sign (cast mktx) and publish (cast publish)"
if [ "${FRONT_RUN_PAIR:-0}" = 1 ]; then
  # F2: a third party creates the planned pair as soon as the factory has code.
  PLAN_FACTORY=$(jsonget "$EV/dex.plan.json" contracts.factory.address)
  PLAN_STEP=$(node -e 'const p=require(process.argv[1]);const s=p.steps.find(x=>x.action==="createPair");console.log(s.tokenA,s.tokenB)' "$(realpath "$EV/dex.plan.json")")
  (
    until [ "$(cast code "$PLAN_FACTORY" --rpc-url "$RPC")" != 0x ]; do sleep 1; done
    set -- $PLAN_STEP
    send "$ISSUER_KEY" "$PLAN_FACTORY" "$(cast calldata "createPair(address,address)" "$1" "$2")" 0 3300000 > "$EV/frontrun.status"
  ) &
  FRONT_PID=$!
fi
scripts/staging/sign-and-publish.sh --txs "$WORK/dex.txs.json" --rpc "$RPC" --confirm "$DEX_SHA" --max-fee-wei $MAXFEE --priority-fee-wei $TIP \
  --plan "$EV/dex.plan.json" --hashes-out "$EV/dex.hashes.txt" -- --private-key "$DEPLOYER_KEY" 2>&1 | tee "$EV/dex.publish.log"
if [ "${FRONT_RUN_PAIR:-0}" = 1 ]; then
  wait "$FRONT_PID"
  grep -q '^0x1' "$EV/frontrun.status" || { echo "FAIL: the front-run did not land first"; cat "$EV/frontrun.status"; exit 1; }
  grep -q 'the identical pair already exists' "$EV/dex.publish.log" || { echo "FAIL: createPair was not front-run"; exit 1; }
  log "F2: createPair was front-run; the deployer's reverted step was accepted because the pair is identical"
fi
$D record --config "$EV/dex.config.json" --plan "$EV/dex.plan.json" --rpc "$RPC" --tx-hashes "$EV/dex.hashes.txt" --write "$EV/gate.json" | tee -a "$EV/steps.log"
log "1 verify-deployment (latest, pairs empty)"
node scripts/staging/verify-deployment.mjs --safe-plan "$EV/safe.plan.json" --dex-plan "$EV/dex.plan.json" --infra-plan "$EV/infra.plan.json" --rpc "$RPC" \
  --safe-hashes "$EV/safe.hashes.txt" --dex-hashes "$EV/dex.hashes.txt" --infra-hashes "$EV/infra.hashes.txt" --expect-empty > "$EV/verify.latest.json"
node -e 'const r=require(process.argv[1]);console.log(r.decision, r.checks.length, "checks")' "$EV/verify.latest.json" | tee -a "$EV/steps.log"

# ---------------------------------------------------------------- 2 gate
GATE=node\ scripts/staging/check-finality-gate-mainnet.mjs
if [ "$MODE" = private-l2 ]; then
  log "2 mainnet gate before finality is refused"
  if $GATE --config "$EV/gate.json" --safe-plan "$EV/safe.plan.json" --rpc "$RPC" 2> "$EV/gate.early.txt"; then echo "FAIL: gate passed before finality"; exit 1; fi
  cat "$EV/gate.early.txt"
  log "2 finality (synthetic follower status on the private L2)"
  scripts/staging/private-l2.sh finalize "$WORK/l2" "$PORT" | tee -a "$EV/steps.log"
  cast rpc bloch_finality --rpc-url "$RPC" > "$EV/bloch_finality.json"
  log "2 mainnet gate (chain 700770, pinned genesis, pinned Safe)"
  $GATE --config "$EV/gate.json" --safe-plan "$EV/safe.plan.json" --rpc "$RPC" > "$EV/gate-report.json"
  GATE_RPC=$RPC
else
  log "2 mainnet gate refuses a chain whose genesis is not the pin"
  if $GATE --config "$EV/gate.json" --safe-plan "$EV/safe.plan.json" --rpc "$RPC" 2> "$EV/gate.pin-refusal.txt"; then echo "FAIL: mainnet gate accepted anvil"; exit 1; fi
  cat "$EV/gate.pin-refusal.txt"
  GATE_RPC=http://127.0.0.1:$((PORT + 1))
  log "2 generic gate before finality is refused"
  if node scripts/staging/check-finality-gate.mjs --config "$EV/gate.json" --rpc "$GATE_RPC" 2> "$EV/gate.early.txt"; then echo "FAIL: gate passed before finality"; exit 1; fi
  cat "$EV/gate.early.txt"
  cast rpc anvil_mine 0x80 --rpc-url "$RPC" > /dev/null
  log "2 generic gate after finality (anvil shim)"
  node scripts/staging/check-finality-gate.mjs --config "$EV/gate.json" --rpc "$GATE_RPC" > "$EV/gate-report.json"
fi
node -e 'const r=require(process.argv[1]);console.log(r.decision, "finalized", r.finalized.number, r.genesisHash)' "$EV/gate-report.json" | tee -a "$EV/steps.log"
[ "$(jsonget "$EV/gate-report.json" decision)" = liquidity-enabled ] || { echo "FAIL: gate"; exit 1; }
node scripts/staging/verify-deployment.mjs --safe-plan "$EV/safe.plan.json" --dex-plan "$EV/dex.plan.json" --infra-plan "$EV/infra.plan.json" --rpc "$RPC" --at finalized \
  --safe-hashes "$EV/safe.hashes.txt" --dex-hashes "$EV/dex.hashes.txt" --infra-hashes "$EV/infra.hashes.txt" --expect-empty > "$EV/verify.finalized.json"
node -e 'const r=require(process.argv[1]);console.log("verify at finalized:", r.decision, r.checks.length, "checks")' "$EV/verify.finalized.json" | tee -a "$EV/steps.log"

# ---------------------------------------------------------------- 3 launch
ROUTER=$(jsonget "$EV/dex.plan.json" contracts.router.address)
FACTORY=$(jsonget "$EV/dex.plan.json" contracts.factory.address)
WRAPPED=$(jsonget "$EV/dex.plan.json" contracts.wrappedNative.address)
PAIR=$(jsonget "$EV/dex.plan.json" pairs.0.address)
log "3 the fee recipient cannot be changed (no setter)"
must_fail "$DEPLOYER_KEY" "$FACTORY" "$(cast calldata "setFeeTo(address)" "$DEPLOYER")" 0 100000
log "3 guarded launch: seed 50% of each cap (5 WBLCH + 500 bUSDC), then an over-cap deposit reverts"
must "$ISSUER_KEY" "$ASSET" "$(cast calldata "approve(address,uint256)" "$ROUTER" 1000000000000)" 0 100000 > /dev/null
ADD="addLiquidityBLCH(address,uint256,uint256,uint256,address,uint256)"
must_fail "$ISSUER_KEY" "$ROUTER" "$(cast calldata "$ADD" "$ASSET" 1000000 0 0 "$ISSUER" 99999999999)" 10000000000000000 1000000
echo "a first deposit by anyone but the first depositor is refused" | tee -a "$EV/steps.log"
must "$ISSUER_KEY" "$ASSET" "$(cast calldata "transfer(address,uint256)" "$DEPOSITOR" 500000000)" 0 100000 > /dev/null
[ "$(cast nonce "$DEPOSITOR" --rpc-url "$RPC")" = 0 ] || { echo "FAIL: the first depositor is not fresh"; exit 1; }
must "$DEPOSITOR_KEY" "$ASSET" "$(cast calldata "approve(address,uint256)" "$ROUTER" 500000000)" 0 100000 > /dev/null
must "$DEPOSITOR_KEY" "$ROUTER" "$(cast calldata "$ADD" "$ASSET" 500000000 0 0 "$ISSUER" 99999999999)" 5000000000000000000 1000000 > /dev/null
[ "$(cast nonce "$DEPOSITOR" --rpc-url "$RPC")" = 2 ] || { echo "FAIL: the first depositor must send exactly two transactions"; exit 1; }
must_fail "$ISSUER_KEY" "$ROUTER" "$(cast calldata "$ADD" "$ASSET" 600000000 0 0 "$ISSUER" 99999999999)" 6000000000000000000 1000000
echo "over-cap deposit refused" | tee -a "$EV/steps.log"
log "3 swaps accrue the protocol fee to Bloch Inc"
for _ in 1 2 3; do
  must "$ISSUER_KEY" "$ROUTER" "$(cast calldata "swapExactTokensForBLCH(uint256,uint256,address[],address,uint256)" 100000000 0 "[$ASSET,$WRAPPED]" "$ISSUER" 99999999999)" 0 400000 > /dev/null
  must "$ISSUER_KEY" "$ROUTER" "$(cast calldata "swapExactBLCHForTokens(uint256,address[],address,uint256)" 0 "[$WRAPPED,$ASSET]" "$ISSUER" 99999999999)" 1000000000000000000 400000 > /dev/null
done
must "$ISSUER_KEY" "$ROUTER" "$(cast calldata "$ADD" "$ASSET" 1000000 0 0 "$ISSUER" 99999999999)" 10000000000000000 1000000 > /dev/null
FEE=$(cast call "$PAIR" "balanceOf(address)(uint256)" "$BLOCH_INC" --rpc-url "$RPC" | awk '{print $1}')
[ "$FEE" != 0 ] || { echo "FAIL: no protocol fee minted to Bloch Inc"; exit 1; }
log "3 Bloch Inc redeems: 2 of 5 signatures refused, 3 of 5 executed (approve, then router.removeLiquidity)"
# Never transfer + burn as two Safe transactions: anyone can burn the shares in between.
APPROVE=$(cast calldata "approve(address,uint256)" "$ROUTER" "$FEE")
REMOVE=$(cast calldata "removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)" "$ASSET" "$WRAPPED" "$FEE" 1 1 "$BLOCH_INC" 99999999999)
for STEP in "$PAIR $APPROVE" "$ROUTER $REMOVE"; do
  TARGET=${STEP%% *}; CALL=${STEP##* }
  NONCE=$(cast call "$BLOCH_INC" "nonce()(uint256)" --rpc-url "$RPC")
  HASH=$(cast call "$BLOCH_INC" "getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)(bytes32)" \
    "$TARGET" 0 "$CALL" 0 0 0 0 "$ZERO" "$ZERO" "$NONCE" --rpc-url "$RPC")
  SIGS=0x
  for K in $(for i in 0 2 4; do echo "${OWNERS[$i]} ${OWNER_KEYS[$i]}"; done | sort | awk '{print $2}'); do
    SIGS+=$(cast wallet sign --no-hash "$HASH" --private-key "$K" | cut -c3-)
  done
  must_fail "$ISSUER_KEY" "$BLOCH_INC" "$(cast calldata "$EXEC" "$TARGET" 0 "$CALL" 0 0 0 0 "$ZERO" "$ZERO" "${SIGS:0:262}")" 0 500000
  must "$ISSUER_KEY" "$BLOCH_INC" "$(cast calldata "$EXEC" "$TARGET" 0 "$CALL" 0 0 0 0 "$ZERO" "$ZERO" "$SIGS")" 0 500000 > /dev/null
done
USD_OUT=$(cast call "$ASSET" "balanceOf(address)(uint256)" "$BLOCH_INC" --rpc-url "$RPC" | awk '{print $1}')
W_OUT=$(cast call "$WRAPPED" "balanceOf(address)(uint256)" "$BLOCH_INC" --rpc-url "$RPC" | awk '{print $1}')
[ "$USD_OUT" != 0 ] && [ "$W_OUT" != 0 ] || { echo "FAIL: Bloch Inc could not redeem its fee"; exit 1; }
echo "Bloch Inc fee: $FEE LP -> $W_OUT WBLCH base units + $USD_OUT bUSDC base units" | tee -a "$EV/steps.log"

LENS=$(jsonget "$EV/dex.plan.json" contracts.lens.address)
SWAP_IN="swapExactTokensForBLCH(uint256,uint256,address[],address,uint256)"
QUOTE="quoteExactInput(uint256,address[],uint256)((bool,uint256,uint256,uint256,uint256,uint256[],uint256[]))"
EXCESS="pendingExcess(address)((uint256,uint256,bool,bool))"
available() { cast call "$LENS" "$QUOTE" "$1" "[$ASSET,$WRAPPED]" 50 --rpc-url "$RPC" | cut -d, -f1 | tr -d '('; }
log "3 cap: an over-cap swap is unavailable in the lens and reverts on chain"
[ "$(available 900000000)" = false ] || { echo "FAIL: the lens quoted an over-cap swap"; exit 1; }
must_fail "$ISSUER_KEY" "$ROUTER" "$(cast calldata "$SWAP_IN" 900000000 0 "[$ASSET,$WRAPPED]" "$ISSUER" 99999999999)" 0 400000
echo "over-cap swap refused" | tee -a "$EV/steps.log"
log "3 DEX-02: a donation above the cap is reported, blocks swaps and is cleared by skim"
must "$ISSUER_KEY" "$ASSET" "$(cast calldata "transfer(address,uint256)" "$PAIR" 1000000000)" 0 100000 > /dev/null
cast call "$LENS" "$EXCESS" "$PAIR" --rpc-url "$RPC" | tee -a "$EV/steps.log"
cast call "$LENS" "$EXCESS" "$PAIR" --rpc-url "$RPC" | grep -q true || { echo "FAIL: the lens does not report the blocking excess"; exit 1; }
[ "$(available 1000000)" = false ] || { echo "FAIL: the lens quoted through a blocking donation"; exit 1; }
must_fail "$ISSUER_KEY" "$ROUTER" "$(cast calldata "$SWAP_IN" 1000000 0 "[$ASSET,$WRAPPED]" "$ISSUER" 99999999999)" 0 400000
must "$ISSUER_KEY" "$PAIR" "$(cast calldata "skim(address)" "$ISSUER")" 0 200000 > /dev/null
[ "$(available 1000000)" = true ] || { echo "FAIL: the lens stays unavailable after skim"; exit 1; }
must "$ISSUER_KEY" "$ROUTER" "$(cast calldata "$SWAP_IN" 1000000 0 "[$ASSET,$WRAPPED]" "$ISSUER" 99999999999)" 0 400000 > /dev/null
echo "donation reported, swap blocked, skim cleared it, swap ok" | tee -a "$EV/steps.log"
log "3 utility contracts in real calls"
AGG=$(cast calldata "aggregate3((address,bool,bytes)[])" "[($MULTICALL,false,$(cast calldata "getChainId()")),($MULTICALL,false,$(cast calldata "getEthBalance(address)" "$BLOCH_INC"))]")
cast call "$MULTICALL" "$AGG" --rpc-url "$RPC" | grep -q "$(printf '%064x' 700770)" || { echo "FAIL: Multicall3 did not aggregate"; exit 1; }
SALT=0x$(printf '%064x' 1); INIT=0x600a600c600039600a6000f3602a60005260206000f3
EXPECT=0x$(cast keccak "0xff${CREATE2:2}${SALT:2}$(cast keccak "$INIT" | cut -c3-)" | cut -c27-)
must "$ISSUER_KEY" "$CREATE2" "$SALT${INIT:2}" 0 200000 > /dev/null
[ "$(cast to-dec "$(cast call "$EXPECT" --rpc-url "$RPC")")" = 42 ] || { echo "FAIL: CREATE2 deployer did not place the contract at $EXPECT"; exit 1; }
echo "Multicall3 aggregate3 and a CREATE2 deployment at $EXPECT work" | tee -a "$EV/steps.log"

log "3 DEX-09: sync is refused on an empty pair"
EMPTY=$(must "$ISSUER_KEY" "$FACTORY" "$(cast calldata "createPair(address,address)" "$ASSET" "$MULTICALL")" 0 3000000 > /dev/null; cast call "$FACTORY" "getPair(address,address)(address)" "$ASSET" "$MULTICALL" --rpc-url "$RPC")
must_fail "$ISSUER_KEY" "$EMPTY" "$(cast calldata "sync()")" 0 150000
echo "sync refused on the empty pair $EMPTY" | tee -a "$EV/steps.log"

if [ -n "${RENDER_HOOK:-}" ]; then
  if [ "$MODE" = private-l2 ]; then
    FINALIZE_CMD="scripts/staging/private-l2.sh finalize $WORK/l2 $PORT"
  else
    FINALIZE_CMD="cast rpc anvil_mine 0x80 --rpc-url $RPC"
  fi
  # shellcheck source=/dev/null
  . "$RENDER_HOOK"
fi
echo "REHEARSAL OK ($MODE, $WORK)" | tee -a "$EV/steps.log"
