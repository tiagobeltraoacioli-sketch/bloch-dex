#!/usr/bin/env bash
# End-to-end rehearsal of the DEX operations kit on a private, loopback-only
# chain with throwaway keys generated here. Nothing here can reach a public chain.
#
#   anvil       anvil --chain-id 700770 plus the anvil finality shim; includes the
#               scenes that need snapshots or state edits. Its genesis is not the
#               mainnet pin, so the monitor runs with --rehearsal (generic gate).
#   private-l2  the v2.1 L2 binaries under the mainnet rules (real settled-RPC,
#               pinned genesis, SYNTHETIC finality: no L1, no proof). Runs the
#               scenes that need no snapshots, to prove the kit against the RPC it
#               will really talk to. ANCHOR_EXPIRY=1 adds the 256-block window test.
#
# The token is the real bridge token: BridgedStablecoinV3 (the launch token, bridge
# codex/bridge-v3-r7-20261102) or BridgedStablecoinV2, told apart by its ABI. With V3 the
# token has the mainnet shape: T = 0 (every mint queues for MINT_DELAY_S, default the
# mainnet 43200 s on anvil and 30 s on the private L2), slots by deposit nonce, a 2-of-3
# committee with a 3-signature unpause and switch, and 3 guardians (cancel quorum 2).
# Section 10 (anvil) covers the V3 incidents: held, cancelled and paused mints, the
# provenance chain on burns, a forged credit and the one-way verifier switch.
#
#   SAFE_ARTIFACTS=<safe 1.4.1 build/artifacts> BUSDC_ARTIFACT=<BridgedStablecoinV3.json|V2.json> \
#     [PRODUCE_DEV=… SETTLED_RPC=…] scripts/ops/rehearse-ops.sh anvil|private-l2 [port] [work]
set -euo pipefail

MODE=${1:?usage: rehearse-ops.sh anvil|private-l2 [port] [work]}
PORT=${2:-28931}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
WORK=${3:-$(mktemp -d)}
mkdir -p "$WORK/evidence"
EV=$WORK/evidence
RPC=http://127.0.0.1:$PORT
[ -d "${SAFE_ARTIFACTS:-}/contracts" ] || { echo "SAFE_ARTIFACTS is required" >&2; exit 1; }
[ -f "${BUSDC_ARTIFACT:-}" ] || { echo "BUSDC_ARTIFACT is required" >&2; exit 1; }
REVISION=$(printf '0%.0s' {1..40})
MAXFEE=5000000000; TIP=1000000000
ZERO=0x0000000000000000000000000000000000000000
FUTURE=99999999999
EXEC="execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)"
PASSES=0
log() { echo "== $*" | tee -a "$EV/steps.log"; }
pass() { PASSES=$((PASSES + 1)); echo "PASS $*" | tee -a "$EV/steps.log"; }
die() { echo "FAIL $*" | tee -a "$EV/steps.log" >&2; exit 1; }

umask 077
cast wallet new --number 18 --json > "$WORK/keys.json"
umask 022
key() { node -e 'console.log(require(process.argv[1])[Number(process.argv[2])].private_key)' "$WORK/keys.json" "$1"; }
addr() { node -e 'console.log(require(process.argv[1])[Number(process.argv[2])].address.toLowerCase())' "$WORK/keys.json" "$1"; }
BOOT_KEY=$(key 0); BOOT=$(addr 0); DEPLOYER_KEY=$(key 1); DEPLOYER=$(addr 1)
SEEDER_KEY=$(key 2); SEEDER=$(addr 2); GRIEFER_KEY=$(key 3); GRIEFER=$(addr 3)
KEEPER_KEY=$(key 4); KEEPER=$(addr 4); THIEF_KEY=$(key 5); THIEF=$(addr 5)
SIGNER_KEY=$(key 6); SIGNER=$(addr 6); GUARDIAN_KEY=$(key 7); GUARDIAN=$(addr 7)
OWNER_KEYS=("$(key 8)" "$(key 9)" "$(key 10)" "$(key 11)" "$(key 12)")
OWNERS=("$(addr 8)" "$(addr 9)" "$(addr 10)" "$(addr 11)" "$(addr 12)")
SIGNER_KEYS=("$SIGNER_KEY" "$(key 13)" "$(key 14)"); SIGNERS=("$SIGNER" "$(addr 13)" "$(addr 14)")
GUARDIAN_KEYS=("$GUARDIAN_KEY" "$(key 15)" "$(key 16)"); GUARDIANS=("$GUARDIAN" "$(addr 15)" "$(addr 16)")
RELAYER_KEY=$(key 17); RELAYER=$(addr 17)
FUNDED=("$BOOT" "$DEPLOYER" "$SEEDER" "$GRIEFER" "$KEEPER" "$THIEF" "$SIGNER" "$GUARDIAN" "${SIGNERS[1]}" "${SIGNERS[2]}" "${GUARDIANS[1]}" "${GUARDIANS[2]}" "$RELAYER")
IS_V3=$(node -e 'const a=require(require("path").resolve(process.argv[1]));console.log(a.abi.some((f)=>f.name==="slotFor")?1:0)' "$BUSDC_ARTIFACT")
TOKEN_KIND=$([ "$IS_V3" = 1 ] && echo BridgedStablecoinV3 || echo BridgedStablecoinV2)
if [ "$MODE" = anvil ]; then MINT_DELAY_S=${MINT_DELAY_S:-43200}; else MINT_DELAY_S=${MINT_DELAY_S:-30}; fi
# The planners' deadlines are wall-clock times, so a V3 anvil starts one mint delay (plus 10 min) in the past: after
# the first mints' delay passes, the chain clock is back near the wall clock.
ANVIL_TS=()
[ "$IS_V3" = 1 ] && ANVIL_TS=(--timestamp $(( $(date +%s) - MINT_DELAY_S - 600 )))

PIDS=()
cleanup() {
  [ "$MODE" = private-l2 ] && scripts/staging/private-l2.sh stop "$WORK/l2" > /dev/null 2>&1 || true
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done
}
trap cleanup EXIT
trap 'exit 143' TERM INT

forge build > "$WORK/build.log" 2>&1 || { tail -n 30 "$WORK/build.log"; exit 1; }
case "$MODE" in
  anvil)
    anvil --chain-id 700770 --port "$PORT" --host 127.0.0.1 "${ANVIL_TS[@]}" --silent > "$WORK/anvil.log" 2>&1 &
    PIDS+=($!)
    node scripts/fixtures/anvil-finality-shim.mjs "$RPC" $((PORT + 1)) > "$WORK/shim.log" 2>&1 &
    PIDS+=($!)
    for _ in $(seq 50); do cast chain-id --rpc-url "$RPC" > /dev/null 2>&1 && break; sleep 0.2; done
    sleep 1
    for a in "${FUNDED[@]}"; do cast rpc anvil_setBalance "$a" 0x56bc75e2d63100000 --rpc-url "$RPC" > /dev/null; done
    OPS_RPC=http://127.0.0.1:$((PORT + 1))
    GATE_FLAGS=(--rehearsal)
    ;;
  private-l2)
    : "${PRODUCE_DEV:?}" "${SETTLED_RPC:?}"
    export PRODUCE_DEV SETTLED_RPC
    mkdir -p "$WORK/l2"
    LIST=$(IFS=,; echo "${FUNDED[*]}")
    scripts/staging/private-l2.sh init "$WORK/l2" "$LIST" 10000000000 | tee -a "$EV/steps.log"
    scripts/staging/private-l2.sh start "$WORK/l2" "$PORT" | tee -a "$EV/steps.log"
    OPS_RPC=$RPC
    GATE_FLAGS=(--safe-plan "$EV/safe.plan.json")
    ;;
  *) die "mode must be anvil or private-l2" ;;
esac
GENESIS=$(cast block 0 --field hash --rpc-url "$RPC")
log "chain $(cast chain-id --rpc-url "$RPC") genesis $GENESIS ($MODE)"

# send KEY TO|create DATA VALUE GAS -> prints the receipt status and contract address
send() {
  local k=$1 to=$2 data=$3 value=$4 gas=$5 from nonce raw hash receipt block
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
      block=$(node -e 'console.log(BigInt(JSON.parse(process.argv[1]).blockNumber).toString())' "$receipt")
      until [ "$(cast block-number --rpc-url "$RPC")" -ge "$block" ]; do sleep 1; done
      node -e 'const r=JSON.parse(process.argv[1]);console.log(r.status, r.contractAddress ?? "", BigInt(r.gasUsed).toString())' "$receipt"
      return
    fi
    sleep 0.5
  done
  echo "no receipt for $hash" >&2; return 1
}
must() { local out; out=$(send "$@"); [ "${out%% *}" = 0x1 ] || die "transaction reverted: to $2"; echo "$out"; }
must_fail() { local out; out=$(send "$@"); [ "${out%% *}" = 0x0 ] || die "transaction succeeded: to $2"; }
jsonget() { node -e 'const v=process.argv[2].split(".").reduce((o,k)=>o[k],JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")));console.log(typeof v==="object"?JSON.stringify(v):v)' "$1" "$2"; }
# expect EXIT NAME COMMAND...: run, keep the output as evidence, compare the exit status.
expect() {
  local want=$1 name=$2 got=0; shift 2
  "$@" > "$EV/$name.out" 2>&1 || got=$?
  [ "$got" = "$want" ] || { cat "$EV/$name.out" >&2; die "$name exited $got, expected $want"; }
  pass "$name (exit $got)"
}
num() { awk '{print $1}'; }
# expect_revert ERROR TO DATA [FROM]: an eth_call at latest reverts with exactly this custom error.
expect_revert() {
  local want got from=${4:-$RELAYER}
  want=$(cast sig "$1()")
  got=$(cast rpc eth_call "{\"from\":\"$from\",\"to\":\"$2\",\"data\":\"$3\"}" latest --rpc-url "$RPC" 2>&1 || true)
  echo "$got" | grep -qi "${want#0x}" || die "expected revert $1 ($want), got: $(echo "$got" | tail -1 | cut -c1-200)"
}
view() { cast call "$@" --rpc-url "$RPC" | num; }
BAL="balanceOf(address)(uint256)"
snapshot() { cast rpc evm_snapshot --rpc-url "$RPC" | tr -d '"'; }
restore() { cast rpc evm_revert "$1" --rpc-url "$RPC" > /dev/null; }
settle() {
  if [ "$MODE" = anvil ]; then cast rpc anvil_mine 0x60 --rpc-url "$RPC" > /dev/null
  else scripts/staging/private-l2.sh finalize "$WORK/l2" "$PORT" >> "$EV/steps.log"; fi
}
monitor() { node scripts/ops/dex-monitor.mjs --config "$EV/gate.json" --rpc "$OPS_RPC" --lp-recipient "$SEEDER" "${GATE_FLAGS[@]}" "$@"; }
keeper_run() { node scripts/ops/dex-skim-keeper.mjs --config "$EV/gate.json" --rpc "$OPS_RPC" --keeper "$KEEPER" "$@"; }

# ---------------------------------------------------------------- deployment
log "deploy: Safe, real $TOKEN_KIND ($(cast keccak "$(node -e 'console.log(require(require("path").resolve(process.argv[1])).bytecode.object)' "$BUSDC_ARTIFACT")") creation), DEX, gate file, with the deployment package's own tools"
OWNERS_JSON=$(printf '"%s",' "${OWNERS[@]}"); OWNERS_JSON="[${OWNERS_JSON%,}]"
node -e '
const c = JSON.parse(require("fs").readFileSync("deployments/mainnet/700770/safe.config.json", "utf8"));
const [genesis, boot, owners] = process.argv.slice(1);
c.network.genesisHash = genesis; c.bootstrap.address = boot; c.safe.owners = JSON.parse(owners);
console.log(JSON.stringify(c, null, 2));' "$GENESIS" "$BOOT" "$OWNERS_JSON" > "$EV/safe.config.json"
S=(node scripts/staging/deploy-safe.mjs)
"${S[@]}" validate --config "$EV/safe.config.json" > "$EV/safe.validate.json"
"${S[@]}" plan --config "$EV/safe.config.json" --artifacts "$SAFE_ARTIFACTS" --write "$EV/safe.plan.json" > /dev/null
"${S[@]}" txs --config "$EV/safe.config.json" --artifacts "$SAFE_ARTIFACTS" --plan "$EV/safe.plan.json" --write "$WORK/safe.txs.json" > /dev/null
scripts/staging/sign-and-publish.sh --txs "$WORK/safe.txs.json" --rpc "$RPC" --confirm "$(jsonget "$EV/safe.validate.json" configSha256)" --max-fee-wei $MAXFEE --priority-fee-wei $TIP \
  --hashes-out "$EV/safe.hashes.txt" -- --private-key "$BOOT_KEY" > "$EV/safe.publish.log" 2>&1
"${S[@]}" blochinc --plan "$EV/safe.plan.json" > "$EV/blochinc.json"
SAFE=$(jsonget "$EV/blochinc.json" address)

USD_BUCKET=10000000000
if [ "$IS_V3" = 1 ]; then
  SORTED_SIGNERS=$(printf '%s\n' "${SIGNERS[@]}" | sort | paste -sd, -)
  SORTED_GUARDIANS=$(printf '%s\n' "${GUARDIANS[@]}" | sort | paste -sd, -)
  CTOR=$(cast abi-encode "c(string,string,uint256,address,bytes32,address[],uint256,(uint256,uint256,uint256,uint256,uint256,uint256),(address[],uint256,uint256),(uint256,uint64))" \
    "Bridged USDC" bUSDC 1 0x00000000000000000000000000000000000000aa 0x00000000000000000000000000000000000000000000000000000000000000bb \
    "[$SORTED_SIGNERS]" 2 "(100000000000,$USD_BUCKET,115740,0,$MINT_DELAY_S,1000000)" "([$SORTED_GUARDIANS],259200,259200)" "(3,1209600)" | cut -c3-)
  CREATE_GAS=5000000
else
  CTOR=$(cast abi-encode "c(string,string,uint256,address,bytes32,address[],uint256,(uint256,uint256,uint256,uint256,uint256,uint256),(address[],uint256,uint256))" \
    "Bridged USDC" bUSDC 1 0x00000000000000000000000000000000000000aa 0x00000000000000000000000000000000000000000000000000000000000000bb \
    "[$SIGNER]" 1 "(100000000000,$USD_BUCKET,115740,1000000000,43200,1000000)" "([$GUARDIAN],259200,259200)" | cut -c3-)
  CREATE_GAS=4000000
fi
INIT=$(node -e 'console.log(require(require("path").resolve(process.argv[1])).bytecode.object)' "$BUSDC_ARTIFACT")$CTOR
USD_CREATE=$(must "$SIGNER_KEY" create "$INIT" 0 $CREATE_GAS)
USD=$(echo "$USD_CREATE" | awk '{print tolower($2)}')
echo "$TOKEN_KIND at $USD, creation gas $(echo "$USD_CREATE" | awk '{print $3}')" | tee -a "$EV/steps.log"
USD_CODE=$(cast keccak "$(cast code "$USD" --rpc-url "$RPC")")
# sigs DIGEST K: K committee signatures in ascending signer order (the token's rule).
sigs() {
  local out=0x k
  for k in $(for i in 0 1 2; do echo "${SIGNERS[$i]} ${SIGNER_KEYS[$i]}"; done | sort | head -n "$2" | awk '{print $2}'); do
    out+=$(cast wallet sign --no-hash "$1" --private-key "$k" | cut -c3-)
  done
  echo "$out"
}
# V3 deposit id: the deposit nonce in the top 8 bytes, as ProvenanceSourceVault makes it.
dep_id() { printf '0x%016x%s' "$1" "$(cast keccak "deposit-$1" | cut -c19-)"; }
time_passes() { # SECONDS: let the chain clock pass the mint delay
  if [ "$MODE" = anvil ]; then
    cast rpc evm_increaseTime "$1" --rpc-url "$RPC" > /dev/null; cast rpc evm_mine --rpc-url "$RPC" > /dev/null
  else
    local until=$(( $(cast block latest --field timestamp --rpc-url "$RPC") + $1 ))
    while [ "$(cast block latest --field timestamp --rpc-url "$RPC")" -le "$until" ]; do must "$RELAYER_KEY" "$RELAYER" 0x 0 30000 > /dev/null; sleep 5; done
  fi
}
pending_amount() { cast call "$USD" "pendingMints(bytes32)(address,uint64,uint64)" "$1" --rpc-url "$RPC" | sed -n 2p | num; }
DEP_NONCE=$([ "$IS_V3" = 1 ] && echo -1 || echo 0)
QUEUED=()
queue_usd() { # RECIPIENT AMOUNT: signed by the throwaway committee; V3 queues it (T = 0)
  # V3: the next slot is read from the chain, since a snapshot restore rewinds it.
  if [ "$IS_V3" = 1 ]; then DEP_NONCE=$(view "$USD" "nextSlot()(uint64)"); else DEP_NONCE=$((DEP_NONCE + 1)); fi
  local id digest
  if [ "$IS_V3" = 1 ]; then id=$(dep_id "$DEP_NONCE"); else id=$(cast keccak "deposit-$DEP_NONCE"); fi
  digest=$(cast call "$USD" "mintDigest(bytes32,uint64,uint64,address)(bytes32)" "$id" "$DEP_NONCE" "$2" "$1" --rpc-url "$RPC")
  if [ "$IS_V3" = 1 ]; then
    must "$RELAYER_KEY" "$USD" "$(cast calldata "mint(bytes32,uint64,uint64,address,bytes)" "$id" "$DEP_NONCE" "$2" "$1" "$(sigs "$digest" 2)")" 0 400000 > /dev/null
    QUEUED+=("$id")
  else
    must "$SIGNER_KEY" "$USD" "$(cast calldata "mint(bytes32,uint64,uint64,address,bytes)" "$id" "$DEP_NONCE" "$2" "$1" "$(cast wallet sign --no-hash "$digest" --private-key "$SIGNER_KEY")")" 0 400000 > /dev/null
  fi
  LAST_ID=$id
}
release_usd() { # after the delay, execute every queued mint still pending, in slot order
  [ "$IS_V3" = 1 ] && [ "${#QUEUED[@]}" -gt 0 ] || return 0
  time_passes "$MINT_DELAY_S"
  local id
  for id in "${QUEUED[@]}"; do
    [ "$(pending_amount "$id")" = 0 ] || must "$RELAYER_KEY" "$USD" "$(cast calldata "executeMint(bytes32)" "$id")" 0 1500000 > /dev/null
  done
  QUEUED=()
}
mint_usd() { queue_usd "$@"; release_usd; }
queue_usd "$SEEDER" 900000000
queue_usd "$GRIEFER" 900000000
queue_usd "$GRIEFER" 900000000
queue_usd "$THIEF" 5000000
if [ "$IS_V3" = 1 ]; then
  [ "$(view "$USD" "$BAL" "$SEEDER")" = 0 ] || die "a V3 mint at T = 0 credited at once"
  pass "v3: four committee mints queued (T = 0); nothing credited before the delay"
fi
release_usd
[ "$(view "$USD" "$BAL" "$SEEDER")" = 900000000 ] || die "the seeder's bUSDC did not arrive"
if [ "$IS_V3" = 1 ]; then
  [ "$(view "$USD" "mintCount()(uint64)")" = 4 ] || die "mintCount should be 4"
  pass "v3: the four mints credited in slot order after the delay (mintCount 4, pendingSupply $(view "$USD" "pendingSupply()(uint256)"))"
fi

FIRST_DEPOSITOR=$SEEDER node -e '
const c = JSON.parse(require("fs").readFileSync("deployments/mainnet/dex-mainnet.config.json", "utf8"));
const [genesis, revision, deployer, blochInc, token, codeHash] = process.argv.slice(1);
c.network.genesisHash = genesis; c.source.revision = revision; c.deployer.address = deployer; c.firstDepositor = process.env.FIRST_DEPOSITOR;
c.blochInc = JSON.parse(require("fs").readFileSync(blochInc, "utf8"));
Object.assign(c.reserveCaps[1], { token, codeHash });
// Opening at 25.5 bUSDC per BLCH needs a cap near 10 x that price.
c.openingPrice.quotePerWrapped = "25500000";
c.reserveCaps[1].cap = "255000000";
console.log(JSON.stringify(c, null, 2));' "$GENESIS" "$REVISION" "$DEPLOYER" "$EV/blochinc.json" "$USD" "$USD_CODE" > "$EV/dex.config.json"
D=(node scripts/staging/deploy-dex.mjs)
# The committed 1,000 bUSDC cap at this price is refused before any plan exists.
node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));c.reserveCaps[1].cap="1000000000";console.log(JSON.stringify(c))' "$EV/dex.config.json" > "$WORK/dex.highcap.json"
if "${D[@]}" validate --config "$WORK/dex.highcap.json" 2> "$EV/dex.highcap-refusal.txt"; then die "a cap 4x above the balanced value was accepted"; fi
grep -q "too high for the opening price" "$EV/dex.highcap-refusal.txt" || die "wrong refusal for the high cap"
pass "plan: a 1000 bUSDC cap at a price of 25.5 is refused before deployment"
"${D[@]}" validate --config "$EV/dex.config.json" > "$EV/dex.validate.json"
"${D[@]}" plan --config "$EV/dex.config.json" --write "$EV/dex.plan.json" > /dev/null
"${D[@]}" txs --config "$EV/dex.config.json" --plan "$EV/dex.plan.json" --write "$WORK/dex.txs.json" > /dev/null
scripts/staging/sign-and-publish.sh --txs "$WORK/dex.txs.json" --rpc "$RPC" --confirm "$(jsonget "$EV/dex.validate.json" configSha256)" --max-fee-wei $MAXFEE --priority-fee-wei $TIP \
  --hashes-out "$EV/dex.hashes.txt" -- --private-key "$DEPLOYER_KEY" > "$EV/dex.publish.log" 2>&1
"${D[@]}" record --config "$EV/dex.config.json" --plan "$EV/dex.plan.json" --rpc "$RPC" --tx-hashes "$EV/dex.hashes.txt" --write "$EV/gate.json" > /dev/null
ROUTER=$(jsonget "$EV/dex.plan.json" contracts.router.address)
WRAPPED=$(jsonget "$EV/dex.plan.json" contracts.wrappedNative.address)
PAIR=$(jsonget "$EV/dex.plan.json" pairs.0.address)
WRAP_CAP=10000000000000000000; USD_CAP=255000000
log "safe $SAFE, pair $PAIR, router $ROUTER, bUSDC $USD, wrapped $WRAPPED"
BAL="balanceOf(address)(uint256)"
TRANSFER="transfer(address,uint256)"

must "$GRIEFER_KEY" "$USD" "$(cast calldata "approve(address,uint256)" "$ROUTER" 100000000000)" 0 100000 > /dev/null
must "$GRIEFER_KEY" "$WRAPPED" "$(cast calldata "deposit()")" 40000000000000000000 100000 > /dev/null
must "$THIEF_KEY" "$WRAPPED" "$(cast calldata "deposit()")" 1000000000000000000 100000 > /dev/null
SWAP_USD_IN="swapExactTokensForBLCH(uint256,uint256,address[],address,uint256)"
SWAP_BLCH_IN="swapExactBLCHForTokens(uint256,address[],address,uint256)"
PATH_U_W="[$USD,$WRAPPED]"; PATH_W_U="[$WRAPPED,$USD]"
PRICE=25.5

log "1 monitor on the empty pair: the gate refuses before finality, then passes"
expect 2 monitor-before-finality monitor
settle
expect 0 monitor-preseed monitor
expect 1 monitor-expect-seeded monitor --expect-seeded

# ---------------------------------------------------------------- griefing the empty pair
if [ "$MODE" = anvil ]; then
  log "2 DEX-09: donations at both caps cannot be synced into an empty pair"
  SNAP=$(snapshot)
  must "$GRIEFER_KEY" "$USD" "$(cast calldata "$TRANSFER" "$PAIR" $USD_CAP)" 0 100000 > /dev/null
  must "$GRIEFER_KEY" "$WRAPPED" "$(cast calldata "$TRANSFER" "$PAIR" $WRAP_CAP)" 0 100000 > /dev/null
  must_fail "$GRIEFER_KEY" "$PAIR" "$(cast calldata "sync()")" 0 150000
  [ "$(view "$PAIR" "totalSupply()(uint256)")" = 0 ] || die "the pair should still have no LP shares"
  expect 1 dex09-monitor monitor
  expect 1 dex09-seed-plan node scripts/ops/dex-seed-plan.mjs plan --config "$EV/gate.json" --rpc "$OPS_RPC" --price $PRICE --to "$SEEDER"
  grep -q '"decision": "skim-first"' "$EV/dex09-seed-plan.out" || die "seed plan did not ask for a skim"
  must "$GRIEFER_KEY" "$PAIR" "$(cast calldata "skim(address)" "$GRIEFER")" 0 200000 > /dev/null
  expect 0 dex09-plan-after-skim node scripts/ops/dex-seed-plan.mjs plan --config "$EV/gate.json" --rpc "$OPS_RPC" --price $PRICE --to "$SEEDER"
  pass "dex09: sync refused; the donation stayed outside the reserves; skim cleared it and the seed plan works"
  restore "$SNAP"

  log "3 DEX-04: an unsynced donation is skimmed first, and it cannot be synced"
  SNAP=$(snapshot)
  must "$GRIEFER_KEY" "$USD" "$(cast calldata "$TRANSFER" "$PAIR" 5000000)" 0 100000 > /dev/null
  expect 1 dex04-monitor-unsynced monitor
  expect 1 dex04-plan-unsynced node scripts/ops/dex-seed-plan.mjs plan --config "$EV/gate.json" --rpc "$OPS_RPC" --price $PRICE --to "$SEEDER"
  must_fail "$GRIEFER_KEY" "$PAIR" "$(cast calldata "sync()")" 0 150000
  pass "dex04: the synced form is closed; the unsynced form is reported and skimmed"
  restore "$SNAP"

  log "3a F1: nobody but the first depositor can make the first deposit"
  SNAP=$(snapshot)
  must "$GRIEFER_KEY" "$WRAPPED" "$(cast calldata "$TRANSFER" "$PAIR" 1000000000000000)" 0 100000 > /dev/null
  must "$GRIEFER_KEY" "$USD" "$(cast calldata "$TRANSFER" "$PAIR" 1000000)" 0 100000 > /dev/null
  must_fail "$GRIEFER_KEY" "$PAIR" "$(cast calldata "mint(address)" "$GRIEFER")" 0 300000
  must_fail "$GRIEFER_KEY" "$PAIR" "$(cast calldata "mint(address)" "$SEEDER")" 0 300000
  must_fail "$GRIEFER_KEY" "$ROUTER" "$(cast calldata "addLiquidityBLCH(address,uint256,uint256,uint256,address,uint256)" "$USD" 1000000 0 0 "$SEEDER" 9999999999)" 10000000000000000 1000000
  pass "f1: a third party's first deposit is refused, also with the shares sent to the depositor"
  restore "$SNAP"

  log "3b L1: a depositor key that has been used is refused before the seed"
  SNAP=$(snapshot)
  must "$SEEDER_KEY" "$SEEDER" 0x 0 30000 > /dev/null
  expect 2 l1-seed-plan-refused node scripts/ops/dex-seed-plan.mjs plan --config "$EV/gate.json" --rpc "$OPS_RPC" --price $PRICE --to "$SEEDER"
  grep -q 'nonce 0 before the seed' "$EV/l1-seed-plan-refused.out" || die "the planner did not name the used key"
  settle
  expect 2 l1-gate-refused monitor
  grep -q 'not single-purpose' "$EV/l1-gate-refused.out" || die "the gate did not name the used key"
  pass "l1: a used depositor key is refused by the planner and by the gate"
  restore "$SNAP"

  # send_hash KEY TO DATA VALUE GAS: publish and wait; prints the hash and the status.
  send_hash() {
    local k=$1 to=$2 data=$3 value=$4 gas=$5 from nonce raw hash
    from=$(cast wallet address --private-key "$k")
    nonce=$(cast nonce "$from" --block latest --rpc-url "$RPC")
    raw=$(cast mktx --chain 700770 --nonce "$nonce" --gas-limit "$gas" --gas-price $MAXFEE --priority-gas-price $TIP --value "$value" --private-key "$k" "$to" "$data")
    hash=$(cast keccak "$raw")
    cast publish --rpc-url "$RPC" "$raw" > /dev/null
    echo "$hash $(cast rpc eth_getTransactionReceipt "$hash" --rpc-url "$RPC" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).status))')"
  }
  note_tx() { node scripts/ops/dex-seed-plan.mjs note-tx --config "$EV/gate.json" --rpc "$OPS_RPC" --tx "$1"; }

  log "3c N1: a griefer makes the seed revert, twice; the seed resent after a checked history lands"
  SNAP=$(snapshot)
  cp "$EV/gate.json" "$WORK/gate.before-n1.json"
  expect 0 n1-plan node scripts/ops/dex-seed-plan.mjs plan --config "$EV/gate.json" --rpc "$OPS_RPC" --price $PRICE --to "$SEEDER"
  N1_DEPOSIT=$(jsonget "$EV/n1-plan.out" depositQuote)
  N1_VALUE=$(jsonget "$EV/n1-plan.out" steps.1.value)
  OVER=$((USD_CAP - N1_DEPOSIT + 1))
  griefer_usd_0=$(view "$USD" "$BAL" "$GRIEFER")
  set -- $(send_hash "$SEEDER_KEY" "$USD" "$(jsonget "$EV/n1-plan.out" steps.0.data)" 0 100000); [ "$2" = 0x1 ] || die "approve failed"
  expect 2 n1-plan-after-approve node scripts/ops/dex-seed-plan.mjs plan --config "$EV/gate.json" --rpc "$OPS_RPC" --price $PRICE --to "$SEEDER"
  expect 0 n1-note-approve note_tx "$1"
  for round in 1 2; do
    must "$GRIEFER_KEY" "$USD" "$(cast calldata "$TRANSFER" "$PAIR" "$OVER")" 0 100000 > /dev/null
    expect 1 "n1-plan-skim-first-$round" node scripts/ops/dex-seed-plan.mjs plan --config "$EV/gate.json" --rpc "$OPS_RPC" --price $PRICE --to "$SEEDER"
    set -- $(send_hash "$SEEDER_KEY" "$(jsonget "$EV/n1-plan.out" steps.1.to)" "$(jsonget "$EV/n1-plan.out" steps.1.data)" "$N1_VALUE" 1000000); SEED_FAILED=$1
    [ "$2" = 0x0 ] || die "the griefed seed should revert"
    must "$GRIEFER_KEY" "$PAIR" "$(cast calldata "skim(address)" "$GRIEFER")" 0 200000 > /dev/null
    expect 2 "n1-plan-refused-$round" node scripts/ops/dex-seed-plan.mjs plan --config "$EV/gate.json" --rpc "$OPS_RPC" --price $PRICE --to "$SEEDER"
    expect 0 "n1-note-seed-$round" note_tx "$SEED_FAILED"
    expect 0 "n1-plan-after-$round" node scripts/ops/dex-seed-plan.mjs plan --config "$EV/gate.json" --rpc "$OPS_RPC" --price $PRICE --to "$SEEDER"
    [ "$(jsonget "$EV/n1-plan-after-$round.out" steps.0.skip)" = true ] || die "the retry should not approve again"
    settle
    expect 0 "n1-gate-$round" monitor
  done
  [ "$(view "$USD" "$BAL" "$GRIEFER")" = "$griefer_usd_0" ] || die "the griefer should have its donation back"
  pass "n1: griefed twice for gas; the depositor's history checks out, so planner and gate continue at supply 0"
  must "$SEEDER_KEY" "$(jsonget "$EV/n1-plan-after-2.out" steps.1.to)" "$(jsonget "$EV/n1-plan-after-2.out" steps.1.data)" "$N1_VALUE" 1000000 > /dev/null
  expect 0 n1-verify node scripts/ops/dex-seed-plan.mjs verify --config "$EV/gate.json" --rpc "$OPS_RPC" --price $PRICE --to "$SEEDER"
  pass "n1: the resent seed landed and verifies"
  restore "$SNAP"
  cp "$WORK/gate.before-n1.json" "$EV/gate.json"

  log "3d N1: any other transaction in the depositor's history stays refused"
  SNAP=$(snapshot)
  set -- $(send_hash "$SEEDER_KEY" "$USD" "$(cast calldata "approve(address,uint256)" "$GRIEFER" 1)" 0 100000); WRONG=$1
  expect 2 n1-note-wrong-spender note_tx "$WRONG"
  grep -q 'not a planned approve or seed' "$EV/n1-note-wrong-spender.out" || die "the wrong spender was not named"
  expect 2 n1-plan-wrong-spender node scripts/ops/dex-seed-plan.mjs plan --config "$EV/gate.json" --rpc "$OPS_RPC" --price $PRICE --to "$SEEDER"
  cmp -s "$EV/gate.json" "$WORK/gate.before-n1.json" || die "a refused history must not change the gate file"
  pass "n1: an approve of another spender is refused and not recorded"
  restore "$SNAP"

  log "3e spent rule: a dust first mint at a bad price; correcting swap, top-up and verify"
  SNAP=$(snapshot)
  must "$GRIEFER_KEY" "$WRAPPED" "$(cast calldata "$TRANSFER" "$PAIR" 1000000000000000)" 0 100000 > /dev/null
  must "$GRIEFER_KEY" "$USD" "$(cast calldata "$TRANSFER" "$PAIR" 1000000)" 0 100000 > /dev/null
  # Stands in for a hostile contract reaching the pair through the depositor's tx.origin.
  must "$SEEDER_KEY" "$PAIR" "$(cast calldata "mint(address)" "$GRIEFER")" 0 300000 > /dev/null
  expect 1 spent-monitor monitor
  grep -q 'LP shares exist' "$EV/spent-monitor.out" || die "the monitor did not name the foreign LP shares"
  expect 2 spent-verify-early node scripts/ops/dex-seed-plan.mjs verify --config "$EV/gate.json" --rpc "$OPS_RPC" --price $PRICE --to "$SEEDER"
  grep -q 'seed-not-ours' "$EV/spent-verify-early.out" || die "verify did not see that the shares are not ours"
  expect 1 spent-plan-correct node scripts/ops/dex-seed-plan.mjs plan --config "$EV/gate.json" --rpc "$OPS_RPC" --price $PRICE --to "$SEEDER"
  grep -q '"decision": "correct-price"' "$EV/spent-plan-correct.out" || die "the planner did not ask for a correcting swap"
  for i in 0 1; do
    STEP_TO=$(jsonget "$EV/spent-plan-correct.out" steps.$i.to 2>/dev/null) || break
    [ -n "$STEP_TO" ] && [ "$STEP_TO" != undefined ] || break
    must "$SEEDER_KEY" "$STEP_TO" "$(jsonget "$EV/spent-plan-correct.out" steps.$i.data)" "$(jsonget "$EV/spent-plan-correct.out" steps.$i.value)" 400000 > /dev/null
  done
  expect 0 spent-plan-top-up node scripts/ops/dex-seed-plan.mjs plan --config "$EV/gate.json" --rpc "$OPS_RPC" --price $PRICE --to "$SEEDER"
  grep -q '"decision": "top-up"' "$EV/spent-plan-top-up.out" || die "the planner did not offer a top-up"
  must "$SEEDER_KEY" "$(jsonget "$EV/spent-plan-top-up.out" steps.0.to)" "$(jsonget "$EV/spent-plan-top-up.out" steps.0.data)" 0 200000 > /dev/null
  must "$SEEDER_KEY" "$(jsonget "$EV/spent-plan-top-up.out" steps.1.to)" "$(jsonget "$EV/spent-plan-top-up.out" steps.1.data)" "$(jsonget "$EV/spent-plan-top-up.out" steps.1.value)" 1000000 > /dev/null
  expect 0 spent-verify node scripts/ops/dex-seed-plan.mjs verify --config "$EV/gate.json" --rpc "$OPS_RPC" --price $PRICE --to "$SEEDER"
  pass "spent rule: foreign dust reported; correcting swap and top-up reached the price, and the recipient holds the pool"
  restore "$SNAP"

  log "3f N2: a spent rule and a hostile fill at the planned price are not our seed"
  SNAP=$(snapshot)
  must "$GRIEFER_KEY" "$WRAPPED" "$(cast calldata "$TRANSFER" "$PAIR" 1000000000000000)" 0 100000 > /dev/null
  must "$GRIEFER_KEY" "$USD" "$(cast calldata "$TRANSFER" "$PAIR" 25500)" 0 100000 > /dev/null
  must "$SEEDER_KEY" "$PAIR" "$(cast calldata "mint(address)" "$GRIEFER")" 0 300000 > /dev/null
  must "$GRIEFER_KEY" "$ROUTER" "$(cast calldata "addLiquidityBLCH(address,uint256,uint256,uint256,address,uint256)" "$USD" 180000000 0 0 "$GRIEFER" 9999999999)" 7000000000000000000 1000000 > /dev/null
  expect 2 n2-verify node scripts/ops/dex-seed-plan.mjs verify --config "$EV/gate.json" --rpc "$OPS_RPC" --price $PRICE --to "$SEEDER"
  grep -q 'seed-not-ours' "$EV/n2-verify.out" || die "verify accepted an attacker's pool"
  expect 2 n2-monitor monitor --expect-seeded
  grep -q 'lp_recipient' "$EV/n2-monitor.out" || die "the monitor accepted an attacker's pool"
  pass "n2: verify and monitor refuse a pool at the right price that holds none of our seed"
  restore "$SNAP"
fi

# ---------------------------------------------------------------- seed
log "4 seed from the plan: 50% of the tighter cap at $PRICE bUSDC per BLCH"
expect 0 seed-plan node scripts/ops/dex-seed-plan.mjs plan --config "$EV/gate.json" --rpc "$OPS_RPC" --price $PRICE --to "$SEEDER" --write-txs "$WORK/seed.txs.json"
expect 2 seed-plan-fraction-too-high node scripts/ops/dex-seed-plan.mjs plan --config "$EV/gate.json" --rpc "$OPS_RPC" --price $PRICE --to "$SEEDER" --fraction-bps 8001
SEED_CONFIRM=$(jsonget "$EV/seed-plan.out" txsFile.configSha256)
node -e 'const fs=require("fs"),t=JSON.parse(fs.readFileSync(process.argv[1]));t.chainId=1;fs.writeFileSync(process.argv[2],JSON.stringify(t))' "$WORK/seed.txs.json" "$WORK/seed-wrong-chain.txs.json"
expect 1 seed-wrong-chain scripts/staging/sign-and-publish.sh --txs "$WORK/seed-wrong-chain.txs.json" --rpc "$RPC" --confirm "$SEED_CONFIRM" --max-fee-wei $MAXFEE --priority-fee-wei $TIP --hashes-out "$WORK/seed-wrong.hashes" -- --private-key "$SEEDER_KEY"
grep -q 'chain ID differs' "$EV/seed-wrong-chain.out" || die "sign-and-publish did not refuse the wrong chain"
expect 1 seed-wrong-signer scripts/staging/sign-and-publish.sh --txs "$WORK/seed.txs.json" --rpc "$RPC" --confirm "$SEED_CONFIRM" --max-fee-wei $MAXFEE --priority-fee-wei $TIP --hashes-out "$WORK/seed-wrong2.hashes" -- --private-key "$GRIEFER_KEY"
[ "$(cast nonce "$SEEDER" --rpc-url "$RPC")" = 0 ] || die "a refused signing sent something"
[ "$(cast nonce "$SEEDER" --rpc-url "$RPC")" = 0 ] || die "the first depositor is not fresh"
expect 0 seed-sign-and-publish scripts/staging/sign-and-publish.sh --txs "$WORK/seed.txs.json" --rpc "$RPC" --confirm "$SEED_CONFIRM" --max-fee-wei $MAXFEE --priority-fee-wei $TIP --hashes-out "$EV/seed.hashes.txt" -- --private-key "$SEEDER_KEY"
pass "the depositor's approve and seed went through sign-and-publish.sh, with chain, genesis, signer and nonce checked"
[ "$(cast nonce "$SEEDER" --rpc-url "$RPC")" = 2 ] || die "the first depositor must send exactly two transactions"
pass "the first depositor sent the approve and the seed, and nothing else"
must "$SEEDER_KEY" "$USD" "$(cast calldata "approve(address,uint256)" "$ROUTER" 100000000000)" 0 100000 > /dev/null
expect 0 seed-verify node scripts/ops/dex-seed-plan.mjs verify --config "$EV/gate.json" --rpc "$OPS_RPC" --price $PRICE --to "$SEEDER"
expect 2 seed-verify-wrong-price node scripts/ops/dex-seed-plan.mjs verify --config "$EV/gate.json" --rpc "$OPS_RPC" --price 30 --to "$SEEDER"
expect 2 seed-plan-refused node scripts/ops/dex-seed-plan.mjs plan --config "$EV/gate.json" --rpc "$OPS_RPC" --price $PRICE --to "$SEEDER"
for _ in 1 2 3; do
  must "$GRIEFER_KEY" "$ROUTER" "$(cast calldata "$SWAP_USD_IN" 5000000 0 "$PATH_U_W" "$GRIEFER" $FUTURE)" 0 400000 > /dev/null
  must "$GRIEFER_KEY" "$ROUTER" "$(cast calldata "$SWAP_BLCH_IN" 0 "$PATH_W_U" "$GRIEFER" $FUTURE)" 200000000000000000 400000 > /dev/null
done
settle
expect 0 monitor-seeded monitor --expect-seeded --json
expect 0 monitor-reference-near monitor --expect-seeded --ref-price $PRICE
expect 2 monitor-reference-far monitor --expect-seeded --ref-price 40

# ---------------------------------------------------------------- DEX-02 and the keeper
log "5 keeper: dust is ignored"
STATE=$WORK/keeper/state.json
KFLAGS=(--state "$STATE" --cooldown-s 1)
must "$GRIEFER_KEY" "$USD" "$(cast calldata "$TRANSFER" "$PAIR" 1000)" 0 100000 > /dev/null
expect 0 keeper-dust keeper_run "${KFLAGS[@]}" --execute -- --private-key "$KEEPER_KEY"
grep -q nothing-to-do "$EV/keeper-dust.out" || die "dust triggered the keeper"
[ "$(cast nonce "$KEEPER" --rpc-url "$RPC")" = 0 ] || die "the keeper sent a transaction for dust"
expect 0 monitor-dust monitor --expect-seeded

log "5 DEX-02: a donation above the cap blocks swaps into that side"
USD_BALANCE=$(view "$USD" "$BAL" "$PAIR")
DONATE=$((USD_CAP - USD_BALANCE + 1))
must "$GRIEFER_KEY" "$USD" "$(cast calldata "$TRANSFER" "$PAIR" "$DONATE")" 0 100000 > /dev/null
must_fail "$SEEDER_KEY" "$ROUTER" "$(cast calldata "$SWAP_USD_IN" 1000000 0 "$PATH_U_W" "$SEEDER" $FUTURE)" 0 400000
pass "dex02: swap into bUSDC reverts with a standing donation of $DONATE"
expect 1 monitor-donation-latest monitor --expect-seeded
settle
expect 2 monitor-donation-finalized monitor --expect-seeded
log "5 keeper: limits refuse, a dry run sends nothing, then it clears the donation"
for spec in "budget-exhausted --budget-wei 1" "fee-above-ceiling --max-fee-wei 1" "gas-limit-exceeded --max-gas 1000" "tx-count-exhausted --max-tx 0"; do
  set -- $spec
  expect 1 "keeper-$1" keeper_run "${KFLAGS[@]}" "$2" "$3" --execute -- --private-key "$KEEPER_KEY"
  grep -q "$1" "$EV/keeper-$1.out" || die "expected $1"
done
expect 0 keeper-dry-run keeper_run "${KFLAGS[@]}"
grep -q would-skim "$EV/keeper-dry-run.out" || die "expected would-skim"
[ "$(cast nonce "$KEEPER" --rpc-url "$RPC")" = 0 ] || die "limits or the dry run sent a transaction"
SAFE_USD_0=$(view "$USD" "$BAL" "$SAFE")
expect 0 keeper-execute keeper_run "${KFLAGS[@]}" --execute -- --private-key "$KEEPER_KEY"
grep -q '"sent"' "$EV/keeper-execute.out" || die "expected sent"
for _ in $(seq 240); do
  H=$(jsonget "$EV/keeper-execute.out" hash)
  [ "$(cast rpc eth_getTransactionReceipt "$H" --rpc-url "$RPC")" != null ] && break
  sleep 0.5
done
RECEIPT=$(cast receipt "$H" --json --rpc-url "$RPC")
SKIM_GAS=$(node -e 'console.log(BigInt(JSON.parse(process.argv[1]).gasUsed).toString())' "$RECEIPT")
echo "skim gas used: $SKIM_GAS" | tee -a "$EV/steps.log"
SAFE_USD_1=$(view "$USD" "$BAL" "$SAFE")
[ "$((SAFE_USD_1 - SAFE_USD_0))" -ge "$DONATE" ] || die "the donation did not reach the Safe"
pass "keeper: the donation went to the Safe ($((SAFE_USD_1 - SAFE_USD_0)) base units), gas $SKIM_GAS"
must "$SEEDER_KEY" "$ROUTER" "$(cast calldata "$SWAP_USD_IN" 1000000 0 "$PATH_U_W" "$SEEDER" $FUTURE)" 0 400000 > /dev/null
pass "keeper: swaps work again"
sleep 2
settle
expect 0 monitor-after-skim monitor --expect-seeded

if [ "$MODE" = anvil ]; then
  log "5 griefing: a griefer front-runs the keeper's skim and takes the donation back; the keeper backs off"
  USD_BALANCE=$(view "$USD" "$BAL" "$PAIR")
  DONATE=$((USD_CAP - USD_BALANCE + 1))
  GRIEFER_USD=$(view "$USD" "$BAL" "$GRIEFER")
  must "$GRIEFER_KEY" "$USD" "$(cast calldata "$TRANSFER" "$PAIR" "$DONATE")" 0 100000 > /dev/null
  cast rpc evm_setAutomine false --rpc-url "$RPC" > /dev/null
  expect 0 keeper-frontrun-send keeper_run --state "$STATE" --cooldown-s 1 --execute -- --private-key "$KEEPER_KEY"
  grep -q '"sent"' "$EV/keeper-frontrun-send.out" || { cat "$EV/keeper-frontrun-send.out"; die "the keeper did not send"; }
  GN=$(cast nonce "$GRIEFER" --rpc-url "$RPC")
  cast publish --async --rpc-url "$RPC" "$(cast mktx --chain 700770 --nonce "$GN" --gas-limit 200000 --gas-price 50000000000 --priority-gas-price 20000000000 --private-key "$GRIEFER_KEY" "$PAIR" "$(cast calldata "skim(address)" "$GRIEFER")")" > /dev/null
  cast rpc evm_mine --rpc-url "$RPC" > /dev/null
  cast rpc evm_setAutomine true --rpc-url "$RPC" > /dev/null
  [ "$(view "$USD" "$BAL" "$GRIEFER")" = "$GRIEFER_USD" ] || die "the griefer should have recovered the donation"
  expect 0 keeper-after-frontrun keeper_run --state "$STATE" --cooldown-s 60 --execute -- --private-key "$KEEPER_KEY"
  node -e 'const s=require(process.argv[1]);const t=s.txs.at(-1);if(t.status!=="wasted"||s.consecutiveWasted!==1)process.exit(1);console.log("wasted skim cost",t.spentWei,"wei; next allowed in",s.nextAllowedAt-t.at,"s")' "$STATE" | tee -a "$EV/steps.log"
  must "$GRIEFER_KEY" "$USD" "$(cast calldata "$TRANSFER" "$PAIR" "$DONATE")" 0 100000 > /dev/null
  N=$(cast nonce "$KEEPER" --rpc-url "$RPC")
  expect 1 keeper-backoff keeper_run --state "$STATE" --cooldown-s 60 --execute -- --private-key "$KEEPER_KEY"
  grep -q '"backoff"' "$EV/keeper-backoff.out" || die "expected backoff"
  [ "$(cast nonce "$KEEPER" --rpc-url "$RPC")" = "$N" ] || die "the keeper sent during backoff"
  must "$GRIEFER_KEY" "$PAIR" "$(cast calldata "skim(address)" "$GRIEFER")" 0 200000 > /dev/null
  pass "griefing: a front-run costs the keeper one skim and then it waits"

  log "5 L3: unrecorded balance fills both caps; a griefer races the keeper, and the keeper does not back off"
  fill_both() {
    must "$GRIEFER_KEY" "$USD" "$(cast calldata "$TRANSFER" "$PAIR" $((USD_CAP - $(view "$USD" "$BAL" "$PAIR"))))" 0 100000 > /dev/null
    local need; need=$(node -e 'console.log(String(BigInt(process.argv[1])-BigInt(process.argv[2])))' $WRAP_CAP "$(view "$WRAPPED" "$BAL" "$PAIR")")
    must "$GRIEFER_KEY" "$WRAPPED" "$(cast calldata "$TRANSFER" "$PAIR" "$need")" 0 100000 > /dev/null
  }
  fill_both
  must_fail "$SEEDER_KEY" "$ROUTER" "$(cast calldata "$SWAP_USD_IN" 1000000 0 "$PATH_U_W" "$SEEDER" $FUTURE)" 0 400000
  must_fail "$SEEDER_KEY" "$ROUTER" "$(cast calldata "$SWAP_BLCH_IN" 0 "$PATH_W_U" "$SEEDER" $FUTURE)" 100000000000000000 400000
  pass "l3: both directions revert while the excess stands"
  expect 2 l3-monitor monitor --expect-seeded
  grep -q 'closed_by_excess' "$EV/l3-monitor.out" || die "the monitor did not report closed_by_excess"
  node -e 'const fs=require("fs"),p=process.argv[1],s=JSON.parse(fs.readFileSync(p));if(s.consecutiveWasted<1)process.exit(1);s.nextAllowedAt=Math.floor(Date.now()/1000)+21600;fs.writeFileSync(p,JSON.stringify(s));' "$STATE"
  cast rpc evm_setAutomine false --rpc-url "$RPC" > /dev/null
  expect 0 l3-keeper-race keeper_run --state "$STATE" --cooldown-s 60 --execute -- --private-key "$KEEPER_KEY"
  grep -q '"sent"' "$EV/l3-keeper-race.out" || { cat "$EV/l3-keeper-race.out"; die "the keeper did not send during backoff with a closed pair"; }
  GN=$(cast nonce "$GRIEFER" --rpc-url "$RPC")
  cast publish --async --rpc-url "$RPC" "$(cast mktx --chain 700770 --nonce "$GN" --gas-limit 200000 --gas-price 50000000000 --priority-gas-price 20000000000 --private-key "$GRIEFER_KEY" "$PAIR" "$(cast calldata "skim(address)" "$GRIEFER")")" > /dev/null
  cast rpc evm_mine --rpc-url "$RPC" > /dev/null
  cast rpc evm_setAutomine true --rpc-url "$RPC" > /dev/null
  must "$SEEDER_KEY" "$ROUTER" "$(cast calldata "$SWAP_USD_IN" 1000000 0 "$PATH_U_W" "$SEEDER" $FUTURE)" 0 400000 > /dev/null
  pass "l3: the griefer won the race and took its donation back, which reopened the pair; its only cost was gas"
  fill_both
  SAFE_USD=$(view "$USD" "$BAL" "$SAFE")
  expect 0 l3-keeper-wins keeper_run --state "$STATE" --cooldown-s 60 --execute -- --private-key "$KEEPER_KEY"
  grep -q '"sent"' "$EV/l3-keeper-wins.out" || { cat "$EV/l3-keeper-wins.out"; die "the keeper did not clear the closed pair"; }
  [ "$(view "$USD" "$BAL" "$SAFE")" != "$SAFE_USD" ] || die "the donation did not reach the Safe"
  must "$SEEDER_KEY" "$ROUTER" "$(cast calldata "$SWAP_USD_IN" 1000000 0 "$PATH_U_W" "$SEEDER" $FUTURE)" 0 400000 > /dev/null
  must "$SEEDER_KEY" "$ROUTER" "$(cast calldata "$SWAP_BLCH_IN" 0 "$PATH_W_U" "$SEEDER" $FUTURE)" 100000000000000000 400000 > /dev/null
  pass "l3: the keeper cleared a closed pair during its backoff; the donation went to the Safe; both directions work"
fi

# ---------------------------------------------------------------- anchored swaps (DEX-05)
log "6 DEX-05: anchored swaps against this node"
ANCH="swapExactBLCHForTokensAnchored(uint256,address[],address,uint256,uint256,bytes32)"
AMOUNT=10000000000000000
anchored_call() { cast calldata "$ANCH" 0 "$PATH_W_U" "$SEEDER" $FUTURE "$1" "$2"; }
probe_call() { # TAG NUMBER HASH: eth_call and eth_estimateGas
  local data; data=$(anchored_call "$2" "$3")
  local call_r est_r
  call_r=$(cast rpc eth_call "{\"from\":\"$SEEDER\",\"to\":\"$ROUTER\",\"data\":\"$data\",\"value\":\"0x$(printf %x $AMOUNT)\"}" "$1" --rpc-url "$RPC" 2>&1 | tail -1 | cut -c1-120) || true
  est_r=$(cast rpc eth_estimateGas "{\"from\":\"$SEEDER\",\"to\":\"$ROUTER\",\"data\":\"$data\",\"value\":\"0x$(printf %x $AMOUNT)\"}" --rpc-url "$RPC" 2>&1 | tail -1 | cut -c1-120) || true
  echo "tag=$1 anchor=$2 call=$call_r estimate=$est_r" | tee -a "$EV/anchor-probe.txt"
}
HEAD=$(cast block-number --rpc-url "$RPC"); HEAD_HASH=$(cast block "$HEAD" --field hash --rpc-url "$RPC")
PREV=$((HEAD - 1)); PREV_HASH=$(cast block "$PREV" --field hash --rpc-url "$RPC")
probe_call latest "$HEAD" "$HEAD_HASH"
probe_call pending "$HEAD" "$HEAD_HASH"
probe_call latest "$PREV" "$PREV_HASH"
must "$SEEDER_KEY" "$ROUTER" "$(anchored_call "$HEAD" "$HEAD_HASH")" $AMOUNT 400000 > /dev/null
pass "anchored swap with anchor = the head when signed"
HEAD=$(cast block-number --rpc-url "$RPC"); PREV=$((HEAD - 1)); PREV_HASH=$(cast block "$PREV" --field hash --rpc-url "$RPC")
must "$SEEDER_KEY" "$ROUTER" "$(anchored_call "$PREV" "$PREV_HASH")" $AMOUNT 400000 > /dev/null
pass "anchored swap with anchor = head - 1"
HEAD=$(cast block-number --rpc-url "$RPC"); PREV=$((HEAD - 1))
must_fail "$SEEDER_KEY" "$ROUTER" "$(anchored_call "$PREV" 0x1111111111111111111111111111111111111111111111111111111111111111)" $AMOUNT 400000
must_fail "$SEEDER_KEY" "$ROUTER" "$(anchored_call $((HEAD + 1000)) "$HEAD_HASH")" $AMOUNT 400000
pass "anchored swap fails closed on a wrong hash and a future block"
OLD=2; OLD_HASH=$(cast block $OLD --field hash --rpc-url "$RPC")
if [ "$MODE" = anvil ]; then
  cast rpc anvil_mine 0x110 --rpc-url "$RPC" > /dev/null
  must_fail "$SEEDER_KEY" "$ROUTER" "$(anchored_call $OLD "$OLD_HASH")" $AMOUNT 400000
  pass "anchored swap fails closed outside the 256-block window"
elif [ "${ANCHOR_EXPIRY:-0}" = 1 ]; then
  log "6 window test: extending the private L2 past 256 blocks, one transaction per block"
  must "$SEEDER_KEY" "$ROUTER" "$(anchored_call $OLD "$OLD_HASH")" $AMOUNT 400000 > /dev/null
  pass "anchored swap succeeds while the anchor is inside the window (head $(cast block-number --rpc-url "$RPC"), anchor $OLD)"
  until [ "$(cast block-number --rpc-url "$RPC")" -gt $((OLD + 257)) ]; do
    must "$THIEF_KEY" "$THIEF" 0x 0 30000 > /dev/null
  done
  must_fail "$SEEDER_KEY" "$ROUTER" "$(anchored_call $OLD "$OLD_HASH")" $AMOUNT 400000
  pass "anchored swap fails closed outside the 256-block window (head $(cast block-number --rpc-url "$RPC"), anchor $OLD)"
fi

# ---------------------------------------------------------------- fee redemption
log "7 fee: a liquidity event mints the fee to the Safe"
expect 0 fee-plan-before node scripts/ops/dex-fee-redeem.mjs plan --config "$EV/gate.json" --rpc "$OPS_RPC" --out "$WORK/fee-none"
ADD="addLiquidityBLCH(address,uint256,uint256,uint256,address,uint256)"
if grep -q nothing-minted "$EV/fee-plan-before.out"; then pass "fee: nothing minted before the first liquidity event"; fi
must "$SEEDER_KEY" "$ROUTER" "$(cast calldata "$ADD" "$USD" 1000000 0 0 "$SEEDER" $FUTURE)" 100000000000000000 1000000 > /dev/null
FEE=$(view "$PAIR" "$BAL" "$SAFE")
[ "$FEE" != 0 ] || die "no fee minted"
echo "fee minted to the Safe: $FEE LP" | tee -a "$EV/steps.log"

safe_exec_typed() { # TX_JSON TYPED_JSON [owners...]: sign the typed data, assemble, execute
  local tx=$1 typed=$2 out sigs=()
  for i in 0 2 4; do sigs+=(--sig "$(cast wallet sign --data --from-file "$typed" --private-key "${OWNER_KEYS[$i]}")"); done
  node scripts/ops/dex-fee-redeem.mjs assemble --config "$EV/gate.json" --tx "$tx" "${sigs[@]}" > "$WORK/assembled.json"
  must "$THIEF_KEY" "$SAFE" "$(jsonget "$WORK/assembled.json" calldata)" 0 500000 > /dev/null
}

if [ "$MODE" = anvil ]; then
  log "7 the transfer + burn path loses the shares to anyone who burns first"
  SNAP=$(snapshot)
  NONCE=$(view "$SAFE" "nonce()(uint256)")
  CALL=$(cast calldata "$TRANSFER" "$PAIR" "$FEE")
  HASH=$(cast call "$SAFE" "getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)(bytes32)" "$PAIR" 0 "$CALL" 0 0 0 0 "$ZERO" "$ZERO" "$NONCE" --rpc-url "$RPC")
  SIGS=0x
  for K in $(for i in 0 2 4; do echo "${OWNERS[$i]} ${OWNER_KEYS[$i]}"; done | sort | awk '{print $2}'); do
    SIGS+=$(cast wallet sign --no-hash "$HASH" --private-key "$K" | cut -c3-)
  done
  must "$SEEDER_KEY" "$SAFE" "$(cast calldata "$EXEC" "$PAIR" 0 "$CALL" 0 0 0 0 "$ZERO" "$ZERO" "$SIGS")" 0 500000 > /dev/null
  expect 2 fee-monitor-lp-in-pair monitor --expect-seeded
  grep -q "CRIT    lp_in_pair" "$EV/fee-monitor-lp-in-pair.out" || die "the monitor did not flag the stranded shares"
  T_USD=$(view "$USD" "$BAL" "$THIEF")
  must "$THIEF_KEY" "$PAIR" "$(cast calldata "burn(address)" "$THIEF")" 0 300000 > /dev/null
  [ "$(view "$USD" "$BAL" "$THIEF")" -gt "$T_USD" ] || die "the thief should have been paid"
  pass "fee: a third party burned the Safe's $FEE LP to itself between the two transactions; never use that path"
  restore "$SNAP"
fi

log "7 redemption through the router, with EIP-712 signatures"
expect 0 fee-plan node scripts/ops/dex-fee-redeem.mjs plan --config "$EV/gate.json" --rpc "$OPS_RPC" --out "$WORK/fee" --deadline-h 240
TYPED0=$(jsonget "$EV/fee-plan.out" files.0.typedData); TX0=$(jsonget "$EV/fee-plan.out" files.0.tx)
TYPED1=$(jsonget "$EV/fee-plan.out" files.1.typedData); TX1=$(jsonget "$EV/fee-plan.out" files.1.tx)
SIG0=$(cast wallet sign --data --from-file "$TYPED0" --private-key "${OWNER_KEYS[0]}")
SIG1=$(cast wallet sign --data --from-file "$TYPED0" --private-key "${OWNER_KEYS[1]}")
expect 2 fee-two-signatures-refused node scripts/ops/dex-fee-redeem.mjs assemble --config "$EV/gate.json" --tx "$TX0" --sig "$SIG0" --sig "$SIG1"
SAFE_USD_0=$(view "$USD" "$BAL" "$SAFE"); SAFE_W_0=$(view "$WRAPPED" "$BAL" "$SAFE")
safe_exec_typed "$TX0" "$TYPED0"
[ "$(view "$PAIR" "allowance(address,address)(uint256)" "$SAFE" "$ROUTER")" = "$FEE" ] || die "the approval is not exact"
safe_exec_typed "$TX1" "$TYPED1"
[ "$(view "$PAIR" "allowance(address,address)(uint256)" "$SAFE" "$ROUTER")" = 0 ] || die "allowance left over"
[ "$(view "$PAIR" "$BAL" "$PAIR")" = 0 ] || die "shares left in the pair"
SAFE_USD_1=$(view "$USD" "$BAL" "$SAFE"); SAFE_W_1=$(view "$WRAPPED" "$BAL" "$SAFE")
[ "$SAFE_USD_1" -gt "$SAFE_USD_0" ] && [ "$(node -e 'console.log(BigInt(process.argv[2])>BigInt(process.argv[1]))' "$SAFE_W_0" "$SAFE_W_1")" = true ] || die "the Safe was not paid"
echo "fee redeemed: $FEE LP -> +$((SAFE_USD_1 - SAFE_USD_0)) bUSDC base units, WBLCH $SAFE_W_0 -> $SAFE_W_1; LP left in the Safe (minted by this burn): $(view "$PAIR" "$BAL" "$SAFE")" | tee -a "$EV/steps.log"
pass "fee: redeemed with 3 of 5 typed-data signatures through the router; hashes matched the Safe's own"
settle
expect 0 monitor-after-fee monitor --expect-seeded --json

if [ "$MODE" = anvil ]; then
  # -------------------------------------------------------------- drift
  log "8 drift: Safe threshold, pair code and a dead node"
  SNAP=$(snapshot)
  cast rpc anvil_setStorageAt "$SAFE" 0x4 "0x$(printf '%064x' 1)" --rpc-url "$RPC" > /dev/null
  expect 2 drift-safe-threshold monitor --expect-seeded
  grep -q "CRIT    safe_pinned\[latest\]" "$EV/drift-safe-threshold.out" || die "Safe drift not flagged at latest"
  restore "$SNAP"; SNAP=$(snapshot)
  cast rpc anvil_setCode "$PAIR" 0x60006000fd --rpc-url "$RPC" > /dev/null
  expect 2 drift-pair-code monitor --expect-seeded
  expect 2 drift-pair-keeper keeper_run --state "$WORK/keeper/drift.json" --execute -- --private-key "$KEEPER_KEY"
  restore "$SNAP"
  expect 3 monitor-dead-node node scripts/ops/dex-monitor.mjs --config "$EV/gate.json" --rpc http://127.0.0.1:9 --rehearsal
  expect 3 keeper-dead-node node scripts/ops/dex-skim-keeper.mjs --config "$EV/gate.json" --rpc http://127.0.0.1:9 --keeper "$KEEPER" --state "$WORK/keeper/dead.json"

  # -------------------------------------------------------------- bUSDC incidents
  log "9 bUSDC pause: mints stop, swaps, transfers, LP exits and burns continue"
  SNAP=$(snapshot)
  must "$GUARDIAN_KEY" "$USD" "$(cast calldata "pause()")" 0 200000 > /dev/null
  expect 1 pause-monitor monitor --expect-seeded
  grep -q "WARN    bridge_token" "$EV/pause-monitor.out" || die "pause not flagged"
  must "$GRIEFER_KEY" "$ROUTER" "$(cast calldata "$SWAP_USD_IN" 1000000 0 "$PATH_U_W" "$GRIEFER" $FUTURE)" 0 400000 > /dev/null
  must "$GRIEFER_KEY" "$USD" "$(cast calldata "$TRANSFER" "$SEEDER" 1)" 0 100000 > /dev/null
  must "$GRIEFER_KEY" "$USD" "$(cast calldata "burn(uint64,address)" 1000000 "$GRIEFER")" 0 200000 > /dev/null
  LP=$(view "$PAIR" "$BAL" "$SEEDER")
  must "$SEEDER_KEY" "$PAIR" "$(cast calldata "approve(address,uint256)" "$ROUTER" "$LP")" 0 100000 > /dev/null
  must "$SEEDER_KEY" "$ROUTER" "$(cast calldata "removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)" "$USD" "$WRAPPED" $((LP / 10)) 0 0 "$SEEDER" $FUTURE)" 0 500000 > /dev/null
  if [ "$IS_V3" = 1 ]; then
    N3=$(view "$USD" "nextSlot()(uint64)"); ID=$(dep_id "$N3")
    DIGEST=$(cast call "$USD" "mintDigest(bytes32,uint64,uint64,address)(bytes32)" "$ID" "$N3" 1000000 "$SEEDER" --rpc-url "$RPC")
    expect_revert IsPaused "$USD" "$(cast calldata "mint(bytes32,uint64,uint64,address,bytes)" "$ID" "$N3" 1000000 "$SEEDER" "$(sigs "$DIGEST" 2)")"
  else
    ID=$(cast keccak "deposit-paused")
    DIGEST=$(cast call "$USD" "mintDigest(bytes32,uint64,uint64,address)(bytes32)" "$ID" 999 1000000 "$SEEDER" --rpc-url "$RPC")
    SIG=$(cast wallet sign --no-hash "$DIGEST" --private-key "$SIGNER_KEY")
    must_fail "$SIGNER_KEY" "$USD" "$(cast calldata "mint(bytes32,uint64,uint64,address,bytes)" "$ID" 999 1000000 "$SEEDER" "$SIG")" 0 400000
  fi
  pass "pause: mint refused; swap, transfer, burn and LP exit all succeeded"
  restore "$SNAP"

  log "9 bUSDC depeg: selling worthless bUSDC stops at the cap"
  SNAP=$(snapshot)
  must "$GRIEFER_KEY" "$USD" "$(cast calldata "approve(address,uint256)" "$ROUTER" 100000000000)" 0 100000 > /dev/null
  USD_R=$(view "$USD" "$BAL" "$PAIR"); W_R=$(view "$WRAPPED" "$BAL" "$PAIR")
  ROOM=$((USD_CAP - USD_R))
  must "$GRIEFER_KEY" "$ROUTER" "$(cast calldata "$SWAP_USD_IN" "$ROOM" 0 "$PATH_U_W" "$GRIEFER" $FUTURE)" 0 400000 > /dev/null
  must_fail "$GRIEFER_KEY" "$ROUTER" "$(cast calldata "$SWAP_USD_IN" 1000000 0 "$PATH_U_W" "$GRIEFER" $FUTURE)" 0 400000
  W_R2=$(view "$WRAPPED" "$BAL" "$PAIR")
  echo "depeg dump: bUSDC reserve $USD_R -> $USD_CAP (cap), WBLCH reserve $W_R -> $W_R2 ($(node -e 'console.log((BigInt(process.argv[1])-BigInt(process.argv[2]))*10000n/BigInt(process.argv[1]))' "$W_R" "$W_R2") bps of the WBLCH side lost)" | tee -a "$EV/steps.log"
  expect 2 depeg-monitor monitor --expect-seeded --ref-price $PRICE
  grep -q "CRIT    reference_price" "$EV/depeg-monitor.out" || die "depeg not flagged"
  LP=$(view "$PAIR" "$BAL" "$SEEDER")
  must "$SEEDER_KEY" "$PAIR" "$(cast calldata "approve(address,uint256)" "$ROUTER" "$LP")" 0 100000 > /dev/null
  must "$SEEDER_KEY" "$ROUTER" "$(cast calldata "removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)" "$USD" "$WRAPPED" "$LP" 0 0 "$SEEDER" $FUTURE)" 0 500000 > /dev/null
  pass "depeg: the dump stops at the cap and the LP exits in full at the capped pool"
  restore "$SNAP"
fi

if [ "$MODE" = anvil ] && [ "$IS_V3" = 1 ]; then
  # -------------------------------------------------------------- BridgedStablecoinV3 incidents
  SWAP_IN_OK() { must "$SEEDER_KEY" "$ROUTER" "$(cast calldata "$SWAP_USD_IN" 1000000 0 "$PATH_U_W" "$SEEDER" $FUTURE)" 0 400000 > /dev/null; }
  SWAP_OUT_OK() { must "$SEEDER_KEY" "$ROUTER" "$(cast calldata "$SWAP_BLCH_IN" 0 "$PATH_W_U" "$SEEDER" $FUTURE)" 10000000000000000 400000 > /dev/null; }
  LP_EXIT_OK() { # FRACTION_DIVISOR
    local lp; lp=$(view "$PAIR" "$BAL" "$SEEDER")
    must "$SEEDER_KEY" "$PAIR" "$(cast calldata "approve(address,uint256)" "$ROUTER" "$lp")" 0 100000 > /dev/null
    must "$SEEDER_KEY" "$ROUTER" "$(cast calldata "removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)" "$USD" "$WRAPPED" $((lp / $1)) 0 0 "$SEEDER" $FUTURE)" 0 500000 > /dev/null
  }
  reserve_usd() { cast call "$PAIR" "getReserves()(uint112,uint112,uint32)" --rpc-url "$RPC" | sed -n "$(node -e 'console.log(BigInt(process.argv[1])<BigInt(process.argv[2])?1:2)' "$USD" "$WRAPPED")p" | num; }
  k_ok() { # the k ceiling holds: reserve0 * reserve1 <= 64% of cap0 * cap1
    local r; r=$(cast call "$PAIR" "getReserves()(uint112,uint112,uint32)" --rpc-url "$RPC" | num | head -2 | paste -sd' ' -)
    node -e 'const [a,b]=process.argv[1].split(" ").map(BigInt);const k=a*b,c=BigInt(process.argv[2])*BigInt(process.argv[3])*64n/100n;if(k>c){console.error("k",k,"ceiling",c);process.exit(1)}' "$r" $WRAP_CAP $USD_CAP || die "k above the ceiling"
  }
  chain_state() { echo "$(view "$USD" "mintCount()(uint64)") $(view "$USD" "mintedTotal()(uint64)") $(cast call "$USD" "mintHead()(bytes32)" --rpc-url "$RPC")"; }
  vote_cancel() { # ID GUARDIAN_INDEX
    local p r a t
    p=$(cast call "$USD" "pendingMints(bytes32)(address,uint64,uint64)" "$1" --rpc-url "$RPC")
    r=$(echo "$p" | sed -n 1p); a=$(echo "$p" | sed -n 2p | num); t=$(echo "$p" | sed -n 3p | num)
    must "${GUARDIAN_KEYS[$2]}" "$USD" "$(cast calldata "voteCancelMint(bytes32,address,uint64,uint64)" "$1" "$r" "$a" "$t")" 0 200000 > /dev/null
  }

  log "10a V3 held mint: a mint queued to the pair adds nothing until it credits; then it is excess the keeper sends to the Safe"
  SNAP=$(snapshot)
  R_USD=$(view "$USD" "$BAL" "$PAIR")
  queue_usd "$PAIR" 3000000; HELD=$LAST_ID
  [ "$(view "$USD" "$BAL" "$PAIR")" = "$R_USD" ] || die "a queued mint moved the pair's balance"
  settle
  expect 0 v3-held-monitor monitor --expect-seeded
  grep -q '1 deposit slot(s) opened and not credited, 3000000 pending' "$EV/v3-held-monitor.out" || die "the monitor did not report the queued mint"
  SWAP_IN_OK; SWAP_OUT_OK; k_ok
  expect_revert NotReady "$USD" "$(cast calldata "executeMint(bytes32)" "$HELD")"
  release_usd
  EXCESS=$(( $(view "$USD" "$BAL" "$PAIR") - $(reserve_usd) ))
  [ "$EXCESS" = 3000000 ] || die "the credited mint should be excess of 3000000, got $EXCESS"
  settle
  expect 1 v3-held-excess-monitor monitor --expect-seeded
  grep -q 'material: 3000000 above the reserve' "$EV/v3-held-excess-monitor.out" || die "the monitor did not see the credited mint as excess"
  SAFE_USD=$(view "$USD" "$BAL" "$SAFE")
  expect 0 v3-held-keeper keeper_run --state "$WORK/keeper/v3.json" --cooldown-s 1 --execute -- --private-key "$KEEPER_KEY"
  grep -q '"sent"' "$EV/v3-held-keeper.out" || die "the keeper did not skim the credited mint"
  sleep 1
  [ $(( $(view "$USD" "$BAL" "$SAFE") - SAFE_USD )) -ge 3000000 ] || die "the credited mint did not reach the Safe"
  SWAP_IN_OK; k_ok
  pass "v3 held mint: queued to the pair, no effect; credited after the delay, it was excess and the keeper skimmed it to the Safe; swaps and k unaffected"
  restore "$SNAP"

  log "10b V3 cancelled mint: guardians cancel a mint to the pair; later mints wait for the slot; a remint fills it"
  SNAP=$(snapshot)
  R_USD=$(view "$USD" "$BAL" "$PAIR")
  queue_usd "$PAIR" 4000000; CANCELLED=$LAST_ID; CANCELLED_NONCE=$DEP_NONCE
  queue_usd "$SEEDER" 2000000; BEHIND=$LAST_ID
  QUEUED=()
  vote_cancel "$CANCELLED" 0
  [ "$(pending_amount "$CANCELLED")" = 4000000 ] || die "one vote cancelled the mint"
  vote_cancel "$CANCELLED" 1
  [ "$(pending_amount "$CANCELLED")" = 0 ] || die "the cancel quorum did not cancel"
  [ "$(view "$USD" "contested(uint64)(bool)" "$CANCELLED_NONCE")" = true ] || die "the slot should be contested"
  time_passes "$MINT_DELAY_S"
  expect_revert NotPending "$USD" "$(cast calldata "executeMint(bytes32)" "$CANCELLED")"
  expect_revert NotReady "$USD" "$(cast calldata "executeMint(bytes32)" "$BEHIND")"
  [ "$(view "$USD" "$BAL" "$PAIR")" = "$R_USD" ] || die "a cancel moved the pair's balance"
  SWAP_IN_OK; SWAP_OUT_OK; LP_EXIT_OK 20; k_ok
  settle
  expect 0 v3-cancel-monitor monitor --expect-seeded
  SEEDER_USD=$(view "$USD" "$BAL" "$SEEDER")
  RDIGEST=$(cast call "$USD" "remintDigest(bytes32,uint64,uint64,address,bool)(bytes32)" "$CANCELLED" "$CANCELLED_NONCE" 4000000 "$SEEDER" false --rpc-url "$RPC")
  must "$RELAYER_KEY" "$USD" "$(cast calldata "remint(bytes32,uint64,uint64,address,bool,bytes)" "$CANCELLED" "$CANCELLED_NONCE" 4000000 "$SEEDER" false "$(sigs "$RDIGEST" 2)")" 0 500000 > /dev/null
  time_passes "$MINT_DELAY_S"
  must "$RELAYER_KEY" "$USD" "$(cast calldata "executeMint(bytes32)" "$CANCELLED")" 0 1500000 > /dev/null
  [ "$(pending_amount "$BEHIND")" = 0 ] || die "the waiting mint did not drain behind the remint"
  [ $(( $(view "$USD" "$BAL" "$SEEDER") - SEEDER_USD )) = 6000000 ] || die "remint and waiting mint did not both credit"
  [ "$(view "$USD" "$BAL" "$PAIR")" = "$R_USD" ] || die "the pair got the cancelled mint"
  SWAP_IN_OK; k_ok
  pass "v3 cancel: the mint to the pair never reached it; the next slot waited (NotReady) while swaps and LP exits worked; the remint credited and drained the waiting mint"
  restore "$SNAP"

  log "10c V3 pause with a mint due: execution stops, the DEX does not; the unpause needs 3 signatures"
  SNAP=$(snapshot)
  queue_usd "$SEEDER" 2000000; DUE=$LAST_ID; QUEUED=()
  time_passes "$MINT_DELAY_S"
  must "${GUARDIAN_KEYS[2]}" "$USD" "$(cast calldata "pause()")" 0 200000 > /dev/null
  expect_revert IsPaused "$USD" "$(cast calldata "executeMint(bytes32)" "$DUE")"
  must "$RELAYER_KEY" "$USD" "$(cast calldata "drain()")" 0 300000 > /dev/null
  [ "$(pending_amount "$DUE")" = 2000000 ] || die "drain credited during a pause"
  SWAP_IN_OK; SWAP_OUT_OK; LP_EXIT_OK 20; k_ok
  must "$SEEDER_KEY" "$USD" "$(cast calldata "burn(uint64,address)" 1000000 "$SEEDER")" 0 200000 > /dev/null
  settle
  expect 1 v3-pause-monitor monitor --expect-seeded
  grep -q 'WARN    bridge_token' "$EV/v3-pause-monitor.out" || die "pause not flagged"
  expect 0 v3-pause-keeper keeper_run --state "$WORK/keeper/v3p.json" --cooldown-s 1
  UD=$(cast call "$USD" "unpauseDigest()(bytes32)" --rpc-url "$RPC")
  expect_revert BadSignatureCount "$USD" "$(cast calldata "unpause(bytes)" "$(sigs "$UD" 2)")"
  must "$RELAYER_KEY" "$USD" "$(cast calldata "unpause(bytes)" "$(sigs "$UD" 3)")" 0 300000 > /dev/null
  must "$RELAYER_KEY" "$USD" "$(cast calldata "executeMint(bytes32)" "$DUE")" 0 1500000 > /dev/null
  pass "v3 pause: due mint and drain held; swaps, LP exit, burn, monitor and keeper unaffected; 2 signatures cannot unpause, 3 can, then the mint credits"
  restore "$SNAP"

  log "10d V3 provenance: DEX activity never moves the mint chain; a burn of LP proceeds states the chain the vault checks"
  SNAP=$(snapshot)
  CHAIN0=$(chain_state)
  SWAP_IN_OK; SWAP_OUT_OK
  must "$GRIEFER_KEY" "$USD" "$(cast calldata "$TRANSFER" "$PAIR" 5000000)" 0 100000 > /dev/null
  must "$THIEF_KEY" "$PAIR" "$(cast calldata "skim(address)" "$THIEF")" 0 200000 > /dev/null
  LP_EXIT_OK 4
  [ "$(chain_state)" = "$CHAIN0" ] || die "DEX activity moved the mint chain"
  BURN_RX=$(cast send --json --private-key "$SEEDER_KEY" --rpc-url "$RPC" "$USD" "burn(uint64,address)" 10000000 "$SEEDER")
  node -e '
const rx=JSON.parse(process.argv[1]), [count,total,head]=process.argv[2].split(" ");
const topic=process.argv[3].toLowerCase();
const log=rx.logs.find((l)=>l.topics[0].toLowerCase()===topic); if(!log) process.exit(2);
const w=log.data.slice(2).match(/.{64}/g);
const ok=BigInt("0x"+w[2])===BigInt(count)&&BigInt("0x"+w[3])===BigInt(total)&&("0x"+w[4])===head.toLowerCase();
console.log("burn states mintCount",BigInt("0x"+w[2]),"mintedTotal",BigInt("0x"+w[3]),"mintHead 0x"+w[4]); process.exit(ok?0:1);' \
    "$BURN_RX" "$CHAIN0" "$(cast keccak "Burned(bytes32,uint64,address,uint64,address,uint64,uint64,bytes32)")" | tee -a "$EV/steps.log" || die "the burn does not state the token's chain"
  # The vault's side of the chain, recomputed from the credits in slot order: it is what a real-deposit chain gives.
  GEN=$(cast keccak "$(cast abi-encode "f(bytes32,uint256,address,bytes32)" "$(cast format-bytes32-string BLOCH-USDT-MINT-CHAIN-v1)" 1 0x00000000000000000000000000000000000000aa 0x00000000000000000000000000000000000000000000000000000000000000bb)")
  H=$GEN
  while read -r key recip amt; do H=$(cast keccak "$(cast abi-encode "f(bytes32,bytes32,uint256,address)" "$H" "$key" "$amt" "$recip")"); done < <(
    cast logs --from-block 0 --to-block latest --address "$USD" "MintExecuted(bytes32,address,uint64)" --json --rpc-url "$RPC" |
      node -e 'for (const l of JSON.parse(require("fs").readFileSync(0,"utf8"))) console.log(l.topics[1], "0x"+l.topics[2].slice(26), BigInt(l.data).toString())')
  [ "$H" = "$(echo "$CHAIN0" | awk '{print $3}')" ] || die "the recomputed deposit chain $H differs from the token's"
  pass "v3 provenance: swaps, donation, skim and LP exit left the chain unchanged; the LP's burn states it, and it equals the chain recomputed from the credits"
  restore "$SNAP"

  log "10e V3 forged credit (committee keys misused, guardians absent): exits after it are held; the pool loses at most its cap"
  SNAP=$(snapshot)
  HONEST=$(chain_state)
  queue_usd "$GRIEFER" 900000000; release_usd
  [ "$(chain_state)" != "$HONEST" ] || die "the forged credit did not extend the chain"
  must "$GRIEFER_KEY" "$USD" "$(cast calldata "approve(address,uint256)" "$ROUTER" 100000000000)" 0 100000 > /dev/null
  W_BEFORE=$(view "$WRAPPED" "$BAL" "$PAIR")
  ROOM=$((USD_CAP - $(view "$USD" "$BAL" "$PAIR")))
  must "$GRIEFER_KEY" "$ROUTER" "$(cast calldata "$SWAP_USD_IN" "$ROOM" 0 "$PATH_U_W" "$GRIEFER" $FUTURE)" 0 400000 > /dev/null
  must_fail "$GRIEFER_KEY" "$ROUTER" "$(cast calldata "$SWAP_USD_IN" 1000000 0 "$PATH_U_W" "$GRIEFER" $FUTURE)" 0 400000
  W_AFTER=$(view "$WRAPPED" "$BAL" "$PAIR")
  echo "forged dump: WBLCH reserve $W_BEFORE -> $W_AFTER; bUSDC at its cap $USD_CAP" | tee -a "$EV/steps.log"
  k_ok
  LP_EXIT_OK 1
  BURN_RX=$(cast send --json --private-key "$SEEDER_KEY" --rpc-url "$RPC" "$USD" "burn(uint64,address)" 10000000 "$SEEDER")
  STATED=$(node -e 'const rx=JSON.parse(process.argv[1]);const l=rx.logs.find((l)=>l.topics[0].toLowerCase()===process.argv[2].toLowerCase());console.log("0x"+l.data.slice(2).match(/.{64}/g)[4])' "$BURN_RX" "$(cast keccak "Burned(bytes32,uint64,address,uint64,address,uint64,uint64,bytes32)")")
  [ "$STATED" != "$(echo "$HONEST" | awk '{print $3}')" ] || die "the burn states the honest chain"
  pass "v3 forged credit: the LP left the pool in full, but its burn states head $STATED, which no real-deposit chain matches, so ProvenanceSourceVault holds it (agent 109); the dump stopped at the bUSDC cap"
  restore "$SNAP"

  log "10f V3 one-way switch: committee retired; a queued mint and the proof path still credit; a pause then runs its full term"
  SNAP=$(snapshot)
  queue_usd "$SEEDER" 2000000; PRE=$LAST_ID; QUEUED=()
  SEL=$(cast sig "verifyMint(address,bytes32,bytes)" | cut -c3-)
  VERIFIER=$(must "$RELAYER_KEY" create "0x6010600c60003960106000f363${SEL}60e01b60005260206000f3" 0 200000 | awk '{print tolower($2)}')
  VALID=$(( $(cast block latest --field timestamp --rpc-url "$RPC") + 86400 ))
  SDIGEST=$(cast call "$USD" "mintSwitchDigest(bool,address,bytes32,uint64,uint256)(bytes32)" false "$VERIFIER" "$(cast keccak "$(cast code "$VERIFIER" --rpc-url "$RPC")")" 0 "$VALID" --rpc-url "$RPC")
  expect_revert BadSignatureCount "$USD" "$(cast calldata "proposeVerifier(address,uint64,uint256,bytes)" "$VERIFIER" 0 "$VALID" "$(sigs "$SDIGEST" 2)")"
  must "$RELAYER_KEY" "$USD" "$(cast calldata "proposeVerifier(address,uint64,uint256,bytes)" "$VERIFIER" 0 "$VALID" "$(sigs "$SDIGEST" 3)")" 0 300000 > /dev/null
  time_passes 1209601
  must "$THIEF_KEY" "$USD" "$(cast calldata "activateVerifier()")" 0 200000 > /dev/null
  [ "$(cast call "$USD" "verifier()(address)" --rpc-url "$RPC" | tr 'A-F' 'a-f')" = "$VERIFIER" ] || die "the verifier is not active"
  N3=$(view "$USD" "nextSlot()(uint64)"); ID=$(dep_id "$N3")
  D3=$(cast call "$USD" "mintDigest(bytes32,uint64,uint64,address)(bytes32)" "$ID" "$N3" 1000000 "$SEEDER" --rpc-url "$RPC")
  expect_revert CommitteeRetired "$USD" "$(cast calldata "mint(bytes32,uint64,uint64,address,bytes)" "$ID" "$N3" 1000000 "$SEEDER" "$(sigs "$D3" 2)")"
  must "$RELAYER_KEY" "$USD" "$(cast calldata "executeMint(bytes32)" "$PRE")" 0 1500000 > /dev/null
  pass "v3 switch: committee mint refused (CommitteeRetired); the mint queued before the switch credited"
  R_USD=$(reserve_usd)
  must "$RELAYER_KEY" "$USD" "$(cast calldata "mintWithProof(bytes32,uint64,uint64,address,bytes)" "$ID" "$N3" 3000000 "$PAIR" 0x)" 0 400000 > /dev/null
  [ "$(view "$USD" "uncancellable(bytes32)(bool)" "$ID")" = true ] || die "a proof mint should be uncancellable"
  time_passes "$MINT_DELAY_S"
  must "$RELAYER_KEY" "$USD" "$(cast calldata "executeMint(bytes32)" "$ID")" 0 1500000 > /dev/null
  [ $(( $(view "$USD" "$BAL" "$PAIR") - R_USD )) = 3000000 ] || die "the proof mint to the pair should be excess"
  must "${GUARDIAN_KEYS[0]}" "$USD" "$(cast calldata "pause()")" 0 200000 > /dev/null
  UD=$(cast call "$USD" "unpauseDigest()(bytes32)" --rpc-url "$RPC")
  expect_revert CommitteeRetired "$USD" "$(cast calldata "unpause(bytes)" "$(sigs "$UD" 3)")"
  settle
  expect 1 v3-switch-monitor monitor --expect-seeded
  grep -q 'no signer can end it early' "$EV/v3-switch-monitor.out" || die "the monitor did not say the pause cannot end early"
  grep -q 'the committee is retired' "$EV/v3-switch-monitor.out" || die "the monitor did not report the switch"
  expect 0 v3-switch-keeper keeper_run --state "$WORK/keeper/v3s.json" --cooldown-s 1 --execute -- --private-key "$KEEPER_KEY"
  grep -q '"sent"' "$EV/v3-switch-keeper.out" || die "the keeper did not skim the proof mint"
  sleep 1
  SWAP_IN_OK; SWAP_OUT_OK; LP_EXIT_OK 10; k_ok
  must "$SEEDER_KEY" "$USD" "$(cast calldata "burn(uint64,address)" 1000000 "$SEEDER")" 0 200000 > /dev/null
  time_passes 259201
  [ "$(cast call "$USD" "paused()(bool)" --rpc-url "$RPC")" = false ] || die "the pause did not expire"
  pass "v3 switch: a proof mint to the pair became excess the keeper skimmed; a guardian pause cannot be ended (CommitteeRetired) and expired on its own; swaps, LP exit and burn worked throughout"
  restore "$SNAP"
fi

echo "REHEARSAL OK ($MODE, $PASSES checks, $WORK)" | tee -a "$EV/steps.log"
