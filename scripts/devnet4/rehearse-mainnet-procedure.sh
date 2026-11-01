#!/usr/bin/env bash
# Live rehearsal of the mainnet DEX deployment procedure
# (docs/MAINNET-READINESS.md §6) on the Bloch L2 devnet4 (chain 700771,
# zero-value), against the real bridged bUSDC token, followed by a pilot
# liquidity ceremony, swaps and a protocol-fee redemption by the Bloch Inc
# stand-in multisig.
#
#   scripts/devnet4/rehearse-mainnet-procedure.sh <work-dir> <step>...
#
# Steps, in order (`all` runs every step; each is resumable):
#   keys    fresh deployer and owner keystores; import the funder and dev keys
#   fund    funder deploys the 2-of-3 RehearsalMultisig (TEST ONLY stand-in for
#           the Bloch Inc Safe) and funds the deployer and owners A, B with gas
#   config  write config.json, validate, plan, refusal checks
#   deploy  dry run, broadcast (--slow), record, on-chain hash check,
#           gate before finality (must refuse)
#   gate    wait for finality, gate (must say liquidity-enabled)
#   seed    dev account approves the router and seeds WBLCH/bUSDC
#   trade   swaps both ways, then a small deposit that mints the protocol fee
#   fee     Bloch Inc multisig redeems its fee LP: transfer + burn, 2 of 3
#   report  balances, reserves and every recorded transaction
#
# Two-pair mode (set WGSMH_TOKEN, the bridged GSMH token, 8 dp): the config
# caps and pairs WBLCH/wGSMH and WBLCH/bUSDC exactly like the mainnet config,
# and `all` runs keys fund config deploy gate seed2 multihop report:
#   seed2     dev seeds WBLCH/bUSDC; the wGSMH holder seeds WBLCH/wGSMH
#   multihop  dev swaps bUSDC -> WBLCH -> wGSMH (output to the holder) and the
#             holder swaps wGSMH -> WBLCH -> bUSDC, both through the router
#
# Safe mode (also set BLOCH_INC_MODE=safe and SAFE_ARTIFACTS=<the build/artifacts
# directory of the npm package @safe-global/safe-contracts@1.4.1>): Bloch Inc
# is a real Safe v1.4.1 instead of the test multisig (runbook step 0, fallback
# path), and `all` runs keys safe fund config deploy gate seed3 trade3 fee3 report:
#   safe    a fresh bootstrap key deploys the official SafeL2 singleton,
#           SafeProxyFactory and CompatibilityFallbackHandler by CREATE (runtime
#           code hashes must equal safe-deployments' canonical v1.4.1 hashes),
#           then a 3-of-5 proxy via createProxyWithNonce; five fresh owner keys
#           stand in for the hardware wallets; everything is verified on chain
#   seed3   tiny seeds of both pools (dev: bUSDC; holder: wGSMH)
#   trade3  one swap each way in WBLCH/bUSDC and a top-up that mints the fee
#   fee3    the Safe redeems its fee LP: two execTransaction calls (transfer,
#           burn), each with 3 of 5 owner signatures packed in address order,
#           submitted by the funder; 2 signatures are shown to be refused first
#
# Environment: RPC (default http://127.0.0.1:18945); REVISION (40-hex commit
# of this tree, config step); FUNDER_KEY_FILE and DEV_KEY_FILE (raw hex keys,
# keys step only); HOLDER_KEY_FILE (two-pair mode: the wGSMH holder's key). Keys live as encrypted keystores in <work-dir>/keys (0700,
# random password file 0600) and are never printed. Every transaction hash is
# written to <work-dir>/tx/<label> before it is awaited, so a rerun waits for
# it instead of sending it again.
#
# The L2 produces one block per settlement proof (~10 min) and rejects
# `pending`-state gas estimation, so every cast transaction carries an
# explicit gas limit and forge waits up to 30 min per receipt.
set -euo pipefail

WORK=$(realpath -m "${1:?usage: rehearse-mainnet-procedure.sh <work-dir> <step>...}")
shift
[ $# -gt 0 ] || { echo "no step given" >&2; exit 2; }
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
RPC=${RPC:-http://127.0.0.1:18945}

CHAIN_ID=700771
GENESIS=0xaec9844384415c8ba7157298fa13f7e6c951a6ba9332f516180a4aa22208fefa
BUSDC=0x1b7c0fb59f34683cd9214566636e63a0f7e092f6
BUSDC_BUCKET=10000000000
BUSDC_CAP=1000000000
WBLCH_CAP=10000000000000000000
DEADLINE=99999999999
DEPLOYER_GAS_FUNDS=${DEPLOYER_GAS_FUNDS:-0.1ether}
OWNER_GAS_FUNDS=${OWNER_GAS_FUNDS:-0.005ether}
WGSMH=${WGSMH_TOKEN:-}
WGSMH=${WGSMH,,}
WGSMH_BUCKET=${WGSMH_BUCKET:-1000000000}
WGSMH_CAP=${WGSMH_CAP:-100000000}
# Two-pair ceremony amounts: WBLCH/bUSDC at ~16.5 bUSDC per BLCH,
# WBLCH/wGSMH at 0.2 BLCH per wGSMH (50% of the 1 wGSMH cap).
SEED2_USD=5000000
SEED2_USD_BLCH=0.30303030303030303ether
SEED2_GSMH=50000000
SEED2_GSMH_BLCH=0.1ether
HOP_USD=1000000
HOP_GSMH=20000000
SAFE_MODE=${BLOCH_INC_MODE:-}
SAFE_THRESHOLD=3
SAFE_SALT=${SAFE_SALT:-20261016}
SAFE_BOOTSTRAP_FUNDS=0.03ether
# Canonical Safe v1.4.1 runtime code hashes (safe-global/safe-deployments
# src/assets/v1.4.1; the proxy hash is SafeProxy's runtime from the same build).
SAFE_L2_HASH=0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff
SAFE_FACTORY_HASH=0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317
SAFE_HANDLER_HASH=0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9
SAFE_PROXY_HASH=0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c
ZERO_ADDR=0x0000000000000000000000000000000000000000
SEED3_USD=1000000
SEED3_USD_BLCH=0.060606060606060606ether
SEED3_GSMH=5000000
SEED3_GSMH_BLCH=0.01ether
TRADE3_USD=300000
TRADE3_BLCH=0.02ether
TOP3_USD=100000
TOP3_BLCH=0.01ether
# Pilot ceremony amounts (each at most 50% of its cap).
SEED_USD=10000000
SEED_BLCH=0.5ether
SWAP_USD=2500000
SWAP_BLCH=0.125ether
ROUNDS=3
TOP_USD=1000000
TOP_BLCH=0.06ether
FORGE_TIMEOUT=1800

KEYS=$WORK/keys
TX=$WORK/tx
mkdir -p "$WORK" "$TX"
D="node scripts/staging/deploy-dex.mjs"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$WORK/progress.log" >&2; }
done_mark() { touch "$WORK/done.$1"; }
is_done() { [ -e "$WORK/done.$1" ]; }
addr() { cat "$KEYS/$1.addr"; }
signer() { echo "--keystore $KEYS/$1.json --password-file $KEYS/password"; }
json() { node -e "const v=JSON.parse(require('fs').readFileSync(0,'utf8'));const r=($1);console.log(typeof r==='object'?JSON.stringify(r):r)"; }
plan_field() { json "v.$1" < "$WORK/plan.json"; }
call() { cast call --rpc-url "$RPC" "$@" | awk '{print $1}'; }

# ---------------------------------------------------------------- tx helpers
# batch <signer>: the next send()s use consecutive nonces from the signer's
# nonce at the first run of this batch (stored, so a rerun reuses it).
BATCH_SIGNER=; BATCH_NONCE=
batch() {
  BATCH_SIGNER=$1
  local file="$TX/$2.nonce"
  [ -e "$file" ] || cast nonce "$(addr "$1")" --rpc-url "$RPC" > "$file"
  BATCH_NONCE=$(cat "$file")
}
# send <label> <cast send args...>
send() {
  local label=$1; shift
  local nonce=$BATCH_NONCE
  BATCH_NONCE=$((BATCH_NONCE + 1))
  [ -e "$TX/$label" ] && return 0
  local hash
  hash=$(cast send --async --rpc-url "$RPC" $(signer "$BATCH_SIGNER") --nonce "$nonce" "$@")
  [[ $hash =~ ^0x[0-9a-f]{64}$ ]] || { echo "send $label: unexpected output $hash" >&2; exit 1; }
  echo "$hash" > "$TX/$label"
  log "sent $label nonce $nonce $hash"
}
# await <label>...: wait for receipts, require status 1, record them.
await() {
  local label hash receipt deadline
  for label in "$@"; do
    hash=$(cat "$TX/$label")
    deadline=$((SECONDS + 3600))
    while :; do
      receipt=$(cast rpc eth_getTransactionReceipt "$hash" --rpc-url "$RPC")
      [ "$receipt" != null ] && break
      [ $SECONDS -lt $deadline ] || { echo "await $label: no receipt for $hash after 1 h" >&2; exit 1; }
      sleep 20
    done
    local row
    row=$(echo "$receipt" | json "[BigInt(v.blockNumber), BigInt(v.gasUsed), BigInt(v.effectiveGasPrice), v.status].join('\t')")
    grep -q "^$label	" "$WORK/txs.tsv" 2>/dev/null || printf '%s\t%s\t%s\n' "$label" "$hash" "$row" >> "$WORK/txs.tsv"
    [ "${row##*	}" = 0x1 ] || { echo "await $label: $hash reverted" >&2; exit 1; }
    log "mined $label: block/gas/price/status $(echo "$row" | tr '\t' ' ')"
  done
}

# ---------------------------------------------------------------------- steps
step_keys() {
  is_done keys && return 0
  (umask 077; mkdir -p "$KEYS"; [ -e "$KEYS/password" ] || openssl rand -hex 32 > "$KEYS/password")
  local name
  local fresh="deployer ownerA ownerB ownerC"
  [ "$SAFE_MODE" != safe ] || fresh="deployer bootstrap safe1 safe2 safe3 safe4 safe5"
  for name in $fresh; do
    [ -e "$KEYS/$name.json" ] && continue
    CAST_PASSWORD=$(cat "$KEYS/password") cast wallet new "$KEYS" "$name.json" > /dev/null
    cast wallet address --keystore "$KEYS/$name.json" --password-file "$KEYS/password" | tr 'A-F' 'a-f' > "$KEYS/$name.addr"
  done
  local names="funder dev"; [ -z "$WGSMH" ] || names="$names holder"
  for name in $names; do
    [ -e "$KEYS/$name.json" ] && continue
    local file=FUNDER_KEY_FILE; [ $name = dev ] && file=DEV_KEY_FILE; [ $name = holder ] && file=HOLDER_KEY_FILE
    [ -r "${!file:-}" ] || { echo "$file must name a readable raw key file" >&2; exit 1; }
    CAST_UNSAFE_PASSWORD=$(cat "$KEYS/password") cast wallet import "$name.json" --keystore-dir "$KEYS" \
      --private-key "$(tr -d ' \n' < "${!file}")" > /dev/null
    cast wallet address --keystore "$KEYS/$name.json" --password-file "$KEYS/password" | tr 'A-F' 'a-f' > "$KEYS/$name.addr"
  done
  chmod 600 "$KEYS"/*
  [ "$(cast nonce "$(addr deployer)" --rpc-url "$RPC")" = 0 ] || { echo "deployer nonce is not 0" >&2; exit 1; }
  for name in $fresh $names; do log "$name $(addr "$name")"; done
  done_mark keys
}

step_fund() {
  is_done fund && return 0
  if [ "$SAFE_MODE" = safe ]; then
    is_done safe || { echo "the safe step has not run" >&2; exit 1; }
    json "v.address" < "$WORK/safe.json" > "$WORK/blochinc.addr"
    batch funder fund
    send fund.deployer --gas-limit 21000 --value "$DEPLOYER_GAS_FUNDS" "$(addr deployer)"
    await fund.deployer
    done_mark fund
    return 0
  fi
  forge build > "$WORK/build.log" 2>&1 || { tail -n 30 "$WORK/build.log"; exit 1; }
  local initcode args
  initcode=$(json "v.bytecode.object" < out/RehearsalMultisig.sol/RehearsalMultisig.json)
  args=$(cast abi-encode "constructor(address[],uint256)" "[$(addr ownerA),$(addr ownerB),$(addr ownerC)]" 2)
  batch funder fund
  send multisig.deploy --gas-limit 1500000 --create "$initcode${args#0x}"
  send fund.deployer --gas-limit 21000 --value "$DEPLOYER_GAS_FUNDS" "$(addr deployer)"
  local labels=(multisig.deploy fund.deployer)
  if [ "$OWNER_GAS_FUNDS" != 0 ]; then
    send fund.ownerA --gas-limit 21000 --value "$OWNER_GAS_FUNDS" "$(addr ownerA)"
    send fund.ownerB --gas-limit 21000 --value "$OWNER_GAS_FUNDS" "$(addr ownerB)"
    labels+=(fund.ownerA fund.ownerB)
  fi
  await "${labels[@]}"
  cast rpc eth_getTransactionReceipt "$(cat "$TX/multisig.deploy")" --rpc-url "$RPC" | json "v.contractAddress.toLowerCase()" > "$WORK/blochinc.addr"
  local ms; ms=$(cat "$WORK/blochinc.addr")
  [ "$(call "$ms" "threshold()(uint256)")" = 2 ] || { echo "multisig threshold is not 2" >&2; exit 1; }
  for name in ownerA ownerB ownerC; do
    [ "$(call "$ms" "isOwner(address)(bool)" "$(addr $name)")" = true ] || { echo "$name is not an owner" >&2; exit 1; }
  done
  log "Bloch Inc stand-in (RehearsalMultisig 2-of-3) $ms"
  done_mark fund
}

step_config() {
  is_done config && return 0
  [[ ${REVISION:-} =~ ^[0-9a-f]{40}$ ]] || { echo "REVISION must be the 40-hex commit of this tree" >&2; exit 1; }
  forge build > "$WORK/build.log" 2>&1 || { tail -n 30 "$WORK/build.log"; exit 1; }
  local ms ms_hash usd_hash bucket
  ms=$(cat "$WORK/blochinc.addr")
  ms_hash=$(cast keccak "$(cast code "$ms" --rpc-url "$RPC")")
  local blochinc="{ \"address\": \"$ms\", \"codeHash\": \"$ms_hash\" }"
  [ "$SAFE_MODE" != safe ] || blochinc=$(json "({ address: v.address, codeHash: v.codeHash, safe: v.safe })" < "$WORK/safe.json")
  usd_hash=$(cast keccak "$(cast code "$BUSDC" --rpc-url "$RPC")")
  bucket=$(call "$BUSDC" "bucketCapacity()(uint256)")
  [ "$bucket" = "$BUSDC_BUCKET" ] || { echo "bUSDC bucketCapacity() is $bucket, expected $BUSDC_BUCKET" >&2; exit 1; }
  [ "$(cast block 0 --field hash --rpc-url "$RPC")" = "$GENESIS" ] || { echo "genesis differs" >&2; exit 1; }
  local gsmh_cap="" pairs='{ "tokenA": "WBLCH", "tokenB": "bUSDC" }'
  if [ -n "$WGSMH" ]; then
    local gsmh_hash gsmh_bucket
    gsmh_hash=$(cast keccak "$(cast code "$WGSMH" --rpc-url "$RPC")")
    gsmh_bucket=$(call "$WGSMH" "bucketCapacity()(uint256)")
    [ "$gsmh_bucket" = "$WGSMH_BUCKET" ] || { echo "wGSMH bucketCapacity() is $gsmh_bucket, expected $WGSMH_BUCKET" >&2; exit 1; }
    [ "$(call "$WGSMH" "decimals()(uint8)")" = 8 ] || { echo "wGSMH decimals differ" >&2; exit 1; }
    gsmh_cap="{ \"symbol\": \"wGSMH\", \"token\": \"$WGSMH\", \"codeHash\": \"$gsmh_hash\", \"bridgeBucketCapacity\": \"$WGSMH_BUCKET\", \"cap\": \"$WGSMH_CAP\" },"
    pairs='{ "tokenA": "WBLCH", "tokenB": "wGSMH" }, { "tokenA": "WBLCH", "tokenB": "bUSDC" }'
  fi
  cat > "$WORK/config.json" <<JSON
{
  "schemaVersion": 1,
  "domain": "postern.dex.mainnet-deploy.v1",
  "network": { "name": "bloch-l2-devnet4-rehearsal", "chainId": $CHAIN_ID, "genesisHash": "$GENESIS", "rehearsal": true },
  "source": { "revision": "$REVISION", "compiler": { "solc": "0.8.24", "evmVersion": "paris", "optimizer": true, "optimizerRuns": 200, "bytecodeHash": "none" } },
  "deployer": { "address": "$(addr deployer)", "startNonce": 0 },
  "firstDepositor": "${FIRST_DEPOSITOR:-0x000000000000000000000000000000000000f1d0}",
  "blochInc": $blochinc,
  "wrappedNative": { "deploy": true },
  "fees": { "feeTo": "blochInc" },
  "reserveCaps": [
    { "token": "WBLCH", "cap": "$WBLCH_CAP" },$gsmh_cap
    { "symbol": "bUSDC", "token": "$BUSDC", "codeHash": "$usd_hash", "bridgeBucketCapacity": "$BUSDC_BUCKET", "cap": "$BUSDC_CAP" }
  ],
  "initialPairs": [ $pairs ],
  "gate": { "maxWrappedReserveCap": "10000000000000000000" }
}
JSON
  $D validate --config "$WORK/config.json" --rehearsal | tee "$WORK/validate.json"
  json "v.configSha256" < "$WORK/validate.json" > "$WORK/config.sha256"
  rm -f "$WORK/plan.json"
  $D plan --config "$WORK/config.json" --rehearsal --write "$WORK/plan.json" > /dev/null
  log "configSha256 $(cat "$WORK/config.sha256")"
  log "== a development chain without --rehearsal is refused"
  if $D validate --config "$WORK/config.json" 2> "$WORK/refusal.no-rehearsal.txt"; then echo "FAIL: accepted without --rehearsal" >&2; exit 1; fi
  cat "$WORK/refusal.no-rehearsal.txt"
  log "== broadcast without --confirm is refused"
  if $D run --config "$WORK/config.json" --plan "$WORK/plan.json" --rpc "$RPC" --rehearsal --broadcast 2> "$WORK/refusal.no-confirm.txt"; then
    echo "FAIL: broadcast without confirmation" >&2; exit 1
  fi
  cat "$WORK/refusal.no-confirm.txt"
  done_mark config
}

step_deploy() {
  local common=(--config "$WORK/config.json" --plan "$WORK/plan.json" --rpc "$RPC" --rehearsal)
  if ! is_done dryrun; then
    log "== dry run"
    $D run "${common[@]}" > "$WORK/dry-run.log" 2>&1 || { tail -n 40 "$WORK/dry-run.log"; exit 1; }
    tail -n 6 "$WORK/dry-run.log"
    [ "$(cast nonce "$(addr deployer)" --rpc-url "$RPC")" = 0 ] || { echo "FAIL: dry run changed the chain" >&2; exit 1; }
    done_mark dryrun
  fi
  if ! is_done broadcast; then
    [ ! -e "$WORK/broadcast.started" ] || { echo "a broadcast was started before: inspect $WORK/broadcast.log, never rerun it blindly" >&2; exit 1; }
    touch "$WORK/broadcast.started"
    log "== broadcast (one transaction at a time; ~1 L2 block each)"
    $D run "${common[@]}" --broadcast --confirm "$(cat "$WORK/config.sha256")" -- \
      $(signer deployer) --timeout "$FORGE_TIMEOUT" > "$WORK/broadcast.log" 2>&1 || { tail -n 40 "$WORK/broadcast.log"; exit 1; }
    tail -n 6 "$WORK/broadcast.log"
    cp "broadcast/DeployMainnet.s.sol/$CHAIN_ID/run-latest.json" "$WORK/run-latest.json"
    done_mark broadcast
  fi
  if ! is_done record; then
    log "== record"
    rm -f "$WORK/gate.json"
    $D record "${common[@]}" --broadcast-file "$WORK/run-latest.json" --write "$WORK/gate.json" | tee "$WORK/record.json"
    node -e '
const plan = require(process.argv[1]);
const { execFileSync } = require("node:child_process");
const at = (a) => execFileSync("cast", ["keccak", execFileSync("cast", ["code", a, "--rpc-url", process.argv[2]]).toString().trim()]).toString().trim();
for (const [k, c] of Object.entries(plan.contracts)) if (at(c.address) !== c.codeHash) { console.error("FAIL", k); process.exit(1); }
for (const p of plan.pairs) if (at(p.address) !== p.codeHash) { console.error("FAIL pair"); process.exit(1); }
console.log("runtime hashes ok:", Object.keys(plan.contracts).join(", "), "+", plan.pairs.length, "pair(s); init code hash", plan.pairInitCodeHash);
' "$WORK/plan.json" "$RPC" | tee "$WORK/runtime-hashes.txt"
    local tx
    for tx in $(json "v.deployment.transactions.join(' ')" < "$WORK/gate.json"); do
      local label="deploy.$(cast tx "$tx" nonce --rpc-url "$RPC")"
      echo "$tx" > "$TX/$label"; await "$label"
    done
    done_mark record
  fi
  if ! is_done gate.early; then
    log "== gate before finality must refuse"
    local at; at=$(date -u +%FT%TZ)
    if node scripts/staging/check-finality-gate.mjs --config "$WORK/gate.json" --rpc "$RPC" > "$WORK/gate.early.out" 2> "$WORK/gate.early.err"; then
      echo "NOTE: gate already passed (finality caught up before this check): $(cat "$WORK/gate.early.out")" >&2
    else
      echo "$at $(cat "$WORK/gate.early.err")" | tee "$WORK/gate.early.txt"
    fi
    cast rpc bloch_finality --rpc-url "$RPC" > "$WORK/gate.early.finality.json"
    done_mark gate.early
  fi
}

step_gate() {
  is_done gate.final && return 0
  local last; last=$(awk -F'\t' '$1 ~ /^deploy\./ {print $3}' "$WORK/txs.tsv" | sort -n | tail -n 1)
  log "== waiting until the finalized L2 block reaches $last"
  while :; do
    local fin; fin=$(cast block finalized --field number --rpc-url "$RPC")
    [ "$fin" -ge "$last" ] && break
    sleep 60
  done
  local at; at=$(date -u +%FT%TZ)
  node scripts/staging/check-finality-gate.mjs --config "$WORK/gate.json" --rpc "$RPC" > "$WORK/gate.final.json"
  [ "$(json "v.decision" < "$WORK/gate.final.json")" = liquidity-enabled ] || { cat "$WORK/gate.final.json"; exit 1; }
  echo "$at" > "$WORK/gate.final.at"
  log "gate: liquidity-enabled at $at"
  head -n 20 "$WORK/gate.final.json"
  # The fee recipient is Bloch Inc and nobody can change it.
  local factory; factory=$(plan_field contracts.factory.address)
  [ "$(call "$factory" "feeTo()(address)" | tr 'A-F' 'a-f')" = "$(cat "$WORK/blochinc.addr")" ] || { echo "FAIL: feeTo" >&2; exit 1; }
  if cast call "$factory" "setFeeTo(address)" "$(addr deployer)" --from "$(addr deployer)" --rpc-url "$RPC" > /dev/null 2>&1; then
    echo "FAIL: setFeeTo exists" >&2; exit 1
  fi
  done_mark gate.final
}

pair_of() { json "v.pairs.find((p) => p.token0 === '$1' || p.token1 === '$1').address" < "$WORK/plan.json"; }
pair() { pair_of "$BUSDC"; }
reserves() { echo "$(call "$1" "getReserves()(uint112,uint112,uint32)" | head -n 2 | xargs) (token0 $(json "v.pairs.find((p) => p.address === '$1').token0" < "$WORK/plan.json"))"; }

step_seed() {
  is_done seed && return 0
  is_done gate.final || { echo "the gate has not enabled liquidity" >&2; exit 1; }
  local router; router=$(plan_field contracts.router.address)
  batch dev seed
  send seed.approve --gas-limit 100000 "$BUSDC" "approve(address,uint256)" "$router" 100000000
  send seed.add --gas-limit 3000000 --value "$SEED_BLCH" "$router" \
    "addLiquidityBLCH(address,uint256,uint256,uint256,address,uint256)" "$BUSDC" "$SEED_USD" "$SEED_USD" 0 "$(addr dev)" "$DEADLINE"
  await seed.approve seed.add
  log "reserves after seed: $(call "$(pair)" "getReserves()(uint112,uint112,uint32)" | xargs) (token0 $(plan_field "pairs[0].token0"))"
  done_mark seed
}

step_trade() {
  is_done trade && return 0
  local router wrapped dev i labels=()
  router=$(plan_field contracts.router.address); wrapped=$(plan_field contracts.wrappedNative.address); dev=$(addr dev)
  batch dev trade
  for i in $(seq "$ROUNDS"); do
    send "trade.$i.usd-to-blch" --gas-limit 400000 "$router" "swapExactTokensForBLCH(uint256,uint256,address[],address,uint256)" \
      "$SWAP_USD" 0 "[$BUSDC,$wrapped]" "$dev" "$DEADLINE"
    send "trade.$i.blch-to-usd" --gas-limit 400000 --value "$SWAP_BLCH" "$router" \
      "swapExactBLCHForTokens(uint256,address[],address,uint256)" 0 "[$wrapped,$BUSDC]" "$dev" "$DEADLINE"
    labels+=("trade.$i.usd-to-blch" "trade.$i.blch-to-usd")
  done
  send trade.top-up --gas-limit 600000 --value "$TOP_BLCH" "$router" \
    "addLiquidityBLCH(address,uint256,uint256,uint256,address,uint256)" "$BUSDC" "$TOP_USD" 0 0 "$dev" "$DEADLINE"
  await "${labels[@]}" trade.top-up
  local fee; fee=$(call "$(pair)" "balanceOf(address)(uint256)" "$(cat "$WORK/blochinc.addr")")
  [ "$fee" != 0 ] || { echo "FAIL: no protocol fee minted to Bloch Inc" >&2; exit 1; }
  echo "$fee" > "$WORK/fee.lp"
  log "protocol fee minted to Bloch Inc: $fee LP"
  done_mark trade
}

step_fee() {
  is_done fee && return 0
  local ms pair_ fee transfer burn
  ms=$(cat "$WORK/blochinc.addr"); pair_=$(pair); fee=$(cat "$WORK/fee.lp")
  transfer=$(cast calldata "transfer(address,uint256)" "$pair_" "$fee")
  burn=$(cast calldata "burn(address)" "$ms")
  # The multisig nonce is part of a confirmation's id, so the burn is
  # confirmed only after the transfer executed (next block).
  batch ownerA fee.ownerA; send fee.transfer.ownerA --gas-limit 300000 "$ms" "confirm(address,bytes)" "$pair_" "$transfer"
  batch ownerB fee.ownerB; send fee.transfer.ownerB --gas-limit 300000 "$ms" "confirm(address,bytes)" "$pair_" "$transfer"
  await fee.transfer.ownerA fee.transfer.ownerB
  [ "$(call "$pair_" "balanceOf(address)(uint256)" "$pair_")" = "$fee" ] || { echo "FAIL: fee LP not at the pair" >&2; exit 1; }
  batch ownerA fee.ownerA; BATCH_NONCE=$((BATCH_NONCE + 1)); send fee.burn.ownerA --gas-limit 300000 "$ms" "confirm(address,bytes)" "$pair_" "$burn"
  batch ownerB fee.ownerB; BATCH_NONCE=$((BATCH_NONCE + 1)); send fee.burn.ownerB --gas-limit 300000 "$ms" "confirm(address,bytes)" "$pair_" "$burn"
  await fee.burn.ownerA fee.burn.ownerB
  local usd w
  usd=$(call "$BUSDC" "balanceOf(address)(uint256)" "$ms"); w=$(call "$(plan_field contracts.wrappedNative.address)" "balanceOf(address)(uint256)" "$ms")
  [ "$usd" != 0 ] && [ "$w" != 0 ] || { echo "FAIL: Bloch Inc could not redeem its fee" >&2; exit 1; }
  log "Bloch Inc redeemed $fee LP -> $w WBLCH wei + $usd bUSDC base units"
  done_mark fee
}

step_seed2() {
  is_done seed2 && return 0
  is_done gate.final || { echo "the gate has not enabled liquidity" >&2; exit 1; }
  local router; router=$(plan_field contracts.router.address)
  batch dev seed2.dev
  send seed2.usd.approve --gas-limit 100000 "$BUSDC" "approve(address,uint256)" "$router" $((SEED2_USD + HOP_USD))
  send seed2.usd.add --gas-limit 3000000 --value "$SEED2_USD_BLCH" "$router" \
    "addLiquidityBLCH(address,uint256,uint256,uint256,address,uint256)" "$BUSDC" "$SEED2_USD" "$SEED2_USD" 0 "$(addr dev)" "$DEADLINE"
  batch holder seed2.holder
  send seed2.gsmh.approve --gas-limit 100000 "$WGSMH" "approve(address,uint256)" "$router" $((SEED2_GSMH + HOP_GSMH))
  send seed2.gsmh.add --gas-limit 3000000 --value "$SEED2_GSMH_BLCH" "$router" \
    "addLiquidityBLCH(address,uint256,uint256,uint256,address,uint256)" "$WGSMH" "$SEED2_GSMH" "$SEED2_GSMH" 0 "$(addr holder)" "$DEADLINE"
  await seed2.usd.approve seed2.usd.add seed2.gsmh.approve seed2.gsmh.add
  log "reserves WBLCH/bUSDC after seed: $(reserves "$(pair_of "$BUSDC")")"
  log "reserves WBLCH/wGSMH after seed: $(reserves "$(pair_of "$WGSMH")")"
  done_mark seed2
}

step_multihop() {
  is_done multihop && return 0
  is_done seed2 || { echo "seed2 has not run" >&2; exit 1; }
  local router wrapped; router=$(plan_field contracts.router.address); wrapped=$(plan_field contracts.wrappedNative.address)
  local sig="swapExactTokensForTokens(uint256,uint256,address[],address,uint256)"
  log "quote bUSDC->WBLCH->wGSMH: $(cast call --rpc-url "$RPC" "$router" "getAmountsOut(uint256,address[])(uint256[])" "$HOP_USD" "[$BUSDC,$wrapped,$WGSMH]")"
  log "quote wGSMH->WBLCH->bUSDC: $(cast call --rpc-url "$RPC" "$router" "getAmountsOut(uint256,address[])(uint256[])" "$HOP_GSMH" "[$WGSMH,$wrapped,$BUSDC]")"
  batch dev multihop.dev
  send hop.usd-to-gsmh --gas-limit 500000 "$router" "$sig" "$HOP_USD" 0 "[$BUSDC,$wrapped,$WGSMH]" "$(addr holder)" "$DEADLINE"
  batch holder multihop.holder
  send hop.gsmh-to-usd --gas-limit 500000 "$router" "$sig" "$HOP_GSMH" 0 "[$WGSMH,$wrapped,$BUSDC]" "$(addr holder)" "$DEADLINE"
  await hop.usd-to-gsmh hop.gsmh-to-usd
  log "reserves WBLCH/bUSDC after swaps: $(reserves "$(pair_of "$BUSDC")")"
  log "reserves WBLCH/wGSMH after swaps: $(reserves "$(pair_of "$WGSMH")")"
  done_mark multihop
}

safe_owner_names() { local n; for n in safe1 safe2 safe3 safe4 safe5; do echo "$(addr $n) $n"; done | sort | awk '{print $2}'; }
storage_address() { echo "0x$(cast storage "$1" "$2" --rpc-url "$RPC" | cut -c27-66)"; }

step_safe() {
  is_done safe && return 0
  [ -d "${SAFE_ARTIFACTS:-}/contracts" ] || { echo "SAFE_ARTIFACTS must be the safe-contracts 1.4.1 build/artifacts directory" >&2; exit 1; }
  local A=$SAFE_ARTIFACTS/contracts
  local -A init
  local key file expected
  for key in singleton:SafeL2.sol/SafeL2.json:$SAFE_L2_HASH factory:proxies/SafeProxyFactory.sol/SafeProxyFactory.json:$SAFE_FACTORY_HASH \
             handler:handler/CompatibilityFallbackHandler.sol/CompatibilityFallbackHandler.json:$SAFE_HANDLER_HASH \
             proxy:proxies/SafeProxy.sol/SafeProxy.json:$SAFE_PROXY_HASH; do
    IFS=: read -r name file expected <<< "$key"
    [ "$(cast keccak "$(json "v.deployedBytecode" < "$A/$file")")" = "$expected" ] || { echo "$file runtime is not the canonical v1.4.1 code" >&2; exit 1; }
    init[$name]=$(json "v.bytecode" < "$A/$file")
  done
  local b; b=$(addr bootstrap)
  if [ ! -e "$TX/safe.fund.bootstrap" ]; then
    [ "$(cast nonce "$b" --rpc-url "$RPC")" = 0 ] || { echo "bootstrap nonce is not 0" >&2; exit 1; }
  fi
  batch funder safe.fund
  send safe.fund.bootstrap --gas-limit 21000 --value "$SAFE_BOOTSTRAP_FUNDS" "$b"
  await safe.fund.bootstrap
  local singleton factory handler owners
  singleton=$(cast compute-address "$b" --nonce 0 | awk '{print tolower($NF)}')
  factory=$(cast compute-address "$b" --nonce 1 | awk '{print tolower($NF)}')
  handler=$(cast compute-address "$b" --nonce 2 | awk '{print tolower($NF)}')
  owners=$(for n in $(safe_owner_names); do addr "$n"; done | paste -sd, -)
  local setup
  setup=$(cast calldata "setup(address[],uint256,address,bytes,address,address,uint256,address)" \
    "[$owners]" "$SAFE_THRESHOLD" "$ZERO_ADDR" 0x "$handler" "$ZERO_ADDR" 0 "$ZERO_ADDR")
  batch bootstrap safe.bootstrap
  send safe.singleton --gas-limit 6500000 --create "${init[singleton]}"
  send safe.factory --gas-limit 1000000 --create "${init[factory]}"
  send safe.handler --gas-limit 1600000 --create "${init[handler]}"
  send safe.proxy --gas-limit 500000 "$factory" "createProxyWithNonce(address,bytes,uint256)" "$singleton" "$setup" "$SAFE_SALT"
  await safe.singleton safe.factory safe.handler safe.proxy
  local topic proxy
  topic=$(cast keccak "ProxyCreation(address,address)")
  proxy=$(cast rpc eth_getTransactionReceipt "$(cat "$TX/safe.proxy")" --rpc-url "$RPC" |
    json "'0x' + v.logs.find((l) => l.address.toLowerCase() === '$factory' && l.topics[0] === '$topic').topics[1].slice(26)")
  local hash_of; hash_of() { cast keccak "$(cast code "$1" --rpc-url "$RPC")"; }
  [ "$(hash_of "$singleton")" = "$SAFE_L2_HASH" ] && [ "$(hash_of "$factory")" = "$SAFE_FACTORY_HASH" ] &&
    [ "$(hash_of "$handler")" = "$SAFE_HANDLER_HASH" ] && [ "$(hash_of "$proxy")" = "$SAFE_PROXY_HASH" ] ||
    { echo "FAIL: a deployed Safe runtime differs from the canonical v1.4.1 code" >&2; exit 1; }
  [ "$(storage_address "$proxy" 0)" = "$singleton" ] || { echo "FAIL: singleton slot" >&2; exit 1; }
  [ "$(storage_address "$proxy" 0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5)" = "$handler" ] || { echo "FAIL: fallback handler slot" >&2; exit 1; }
  [ "$(storage_address "$proxy" 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8)" = "$ZERO_ADDR" ] || { echo "FAIL: a guard is set" >&2; exit 1; }
  [ "$(call "$proxy" "getThreshold()(uint256)")" = "$SAFE_THRESHOLD" ] || { echo "FAIL: threshold" >&2; exit 1; }
  [ "$(cast call "$proxy" "getOwners()(address[])" --rpc-url "$RPC" | tr -d '[] ' | tr 'A-F' 'a-f' | tr ',' '\n' | sort | paste -sd, -)" = "$owners" ] || { echo "FAIL: owners" >&2; exit 1; }
  [ "$(cast call "$proxy" "getModulesPaginated(address,uint256)(address[],address)" 0x0000000000000000000000000000000000000001 10 --rpc-url "$RPC" | head -n 1)" = "[]" ] || { echo "FAIL: a module is enabled" >&2; exit 1; }
  [ "$(cast call "$proxy" "VERSION()(string)" --rpc-url "$RPC" | tr -d '"')" = 1.4.1 ] || { echo "FAIL: version" >&2; exit 1; }
  node -e '
const [proxy, proxyHash, singleton, singletonHash, handler, handlerHash, factory, factoryHash, threshold, owners, salt, bootstrap] = process.argv.slice(1);
console.log(JSON.stringify({ address: proxy, codeHash: proxyHash,
  safe: { version: "1.4.1", singleton: { address: singleton, codeHash: singletonHash }, fallbackHandler: { address: handler, codeHash: handlerHash },
    threshold: Number(threshold), owners: owners.split(",") },
  proxyFactory: { address: factory, codeHash: factoryHash }, saltNonce: salt, bootstrap }, null, 2));
' "$proxy" "$SAFE_PROXY_HASH" "$singleton" "$SAFE_L2_HASH" "$handler" "$SAFE_HANDLER_HASH" "$factory" "$SAFE_FACTORY_HASH" \
    "$SAFE_THRESHOLD" "$owners" "$SAFE_SALT" "$b" > "$WORK/safe.json"
  log "Bloch Inc Safe v1.4.1 $proxy (3 of 5): singleton $singleton factory $factory handler $handler"
  done_mark safe
}

step_seed3() {
  is_done seed3 && return 0
  is_done gate.final || { echo "the gate has not enabled liquidity" >&2; exit 1; }
  local router; router=$(plan_field contracts.router.address)
  batch dev seed3.dev
  send seed3.usd.approve --gas-limit 100000 "$BUSDC" "approve(address,uint256)" "$router" $((SEED3_USD + TRADE3_USD + TOP3_USD))
  send seed3.usd.add --gas-limit 3000000 --value "$SEED3_USD_BLCH" "$router" \
    "addLiquidityBLCH(address,uint256,uint256,uint256,address,uint256)" "$BUSDC" "$SEED3_USD" "$SEED3_USD" 0 "$(addr dev)" "$DEADLINE"
  batch holder seed3.holder
  send seed3.gsmh.approve --gas-limit 100000 "$WGSMH" "approve(address,uint256)" "$router" "$SEED3_GSMH"
  send seed3.gsmh.add --gas-limit 3000000 --value "$SEED3_GSMH_BLCH" "$router" \
    "addLiquidityBLCH(address,uint256,uint256,uint256,address,uint256)" "$WGSMH" "$SEED3_GSMH" "$SEED3_GSMH" 0 "$(addr holder)" "$DEADLINE"
  await seed3.usd.approve seed3.usd.add seed3.gsmh.approve seed3.gsmh.add
  log "reserves WBLCH/bUSDC after seed: $(reserves "$(pair_of "$BUSDC")")"
  log "reserves WBLCH/wGSMH after seed: $(reserves "$(pair_of "$WGSMH")")"
  done_mark seed3
}

step_trade3() {
  is_done trade3 && return 0
  local router wrapped dev; router=$(plan_field contracts.router.address); wrapped=$(plan_field contracts.wrappedNative.address); dev=$(addr dev)
  batch dev trade3
  send trade3.usd-to-blch --gas-limit 400000 "$router" "swapExactTokensForBLCH(uint256,uint256,address[],address,uint256)" \
    "$TRADE3_USD" 0 "[$BUSDC,$wrapped]" "$dev" "$DEADLINE"
  send trade3.blch-to-usd --gas-limit 400000 --value "$TRADE3_BLCH" "$router" \
    "swapExactBLCHForTokens(uint256,address[],address,uint256)" 0 "[$wrapped,$BUSDC]" "$dev" "$DEADLINE"
  send trade3.top-up --gas-limit 600000 --value "$TOP3_BLCH" "$router" \
    "addLiquidityBLCH(address,uint256,uint256,uint256,address,uint256)" "$BUSDC" "$TOP3_USD" 0 0 "$dev" "$DEADLINE"
  await trade3.usd-to-blch trade3.blch-to-usd trade3.top-up
  local fee; fee=$(call "$(pair)" "balanceOf(address)(uint256)" "$(cat "$WORK/blochinc.addr")")
  [ "$fee" != 0 ] || { echo "FAIL: no protocol fee minted to the Safe" >&2; exit 1; }
  echo "$fee" > "$WORK/fee.lp"
  log "protocol fee minted to the Bloch Inc Safe: $fee LP"
  done_mark trade3
}

# Safe transaction hash for (to, data) at Safe nonce n: CALL, no refund.
safe_tx_hash() {
  cast call "$(cat "$WORK/blochinc.addr")" \
    "getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)(bytes32)" \
    "$1" 0 "$2" 0 0 0 0 "$ZERO_ADDR" "$ZERO_ADDR" "$3" --rpc-url "$RPC"
}
# Packed signatures of the given owners over a hash, ordered by owner address.
safe_signatures() {
  local hash=$1 n sigs=0x; shift
  for n in $(for n in "$@"; do echo "$(addr "$n") $n"; done | sort | awk '{print $2}'); do
    sigs+=$(cast wallet sign --no-hash "$hash" --keystore "$KEYS/$n.json" --password-file "$KEYS/password" | cut -c3-)
  done
  echo "$sigs"
}
EXEC_SIG="execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)"

step_fee3() {
  is_done fee3 && return 0
  local safe pair_ fee nonce transfer burn
  safe=$(cat "$WORK/blochinc.addr"); pair_=$(pair); fee=$(cat "$WORK/fee.lp")
  transfer=$(cast calldata "transfer(address,uint256)" "$pair_" "$fee")
  burn=$(cast calldata "burn(address)" "$safe")
  [ -e "$WORK/safe.nonce" ] || call "$safe" "nonce()(uint256)" > "$WORK/safe.nonce"
  nonce=$(cat "$WORK/safe.nonce")
  local signers; signers=$(safe_owner_names | sed -n '1p;3p;5p' | xargs)
  local h0 h1 s0 s1
  h0=$(safe_tx_hash "$pair_" "$transfer" "$nonce"); h1=$(safe_tx_hash "$pair_" "$burn" $((nonce + 1)))
  s0=$(safe_signatures "$h0" $signers); s1=$(safe_signatures "$h1" $signers)
  printf 'safeTxHash %s nonce %s\nsafeTxHash %s nonce %s\nsigners %s\n' "$h0" "$nonce" "$h1" $((nonce + 1)) \
    "$(for n in $signers; do addr "$n"; done | xargs)" | tee "$WORK/safe.fee.txt"
  if [ ! -e "$TX/safe.exec.transfer" ]; then
    log "== two signatures are refused (eth_call)"
    local two; two=$(safe_signatures "$h0" $(echo "$signers" | cut -d' ' -f1-2))
    if cast call --from "$(addr funder)" "$safe" "$EXEC_SIG" "$pair_" 0 "$transfer" 0 0 0 0 "$ZERO_ADDR" "$ZERO_ADDR" "$two" \
      --rpc-url "$RPC" > "$WORK/safe.two-sigs.txt" 2>&1; then
      echo "FAIL: the Safe accepted two signatures" >&2; exit 1
    fi
    { grep -o 'GS0[0-9][0-9]' "$WORK/safe.two-sigs.txt" || echo "reverted: $(tail -n 1 "$WORK/safe.two-sigs.txt")"; } | head -n 1 | tee -a "$WORK/safe.fee.txt"
  fi
  batch funder fee3
  send safe.exec.transfer --gas-limit 400000 "$safe" "$EXEC_SIG" "$pair_" 0 "$transfer" 0 0 0 0 "$ZERO_ADDR" "$ZERO_ADDR" "$s0"
  send safe.exec.burn --gas-limit 400000 "$safe" "$EXEC_SIG" "$pair_" 0 "$burn" 0 0 0 0 "$ZERO_ADDR" "$ZERO_ADDR" "$s1"
  await safe.exec.transfer safe.exec.burn
  local success; success=$(cast keccak "ExecutionSuccess(bytes32,uint256)")
  for l in safe.exec.transfer safe.exec.burn; do
    cast rpc eth_getTransactionReceipt "$(cat "$TX/$l")" --rpc-url "$RPC" |
      json "v.logs.some((g) => g.address.toLowerCase() === '$safe' && g.topics[0] === '$success')" | grep -qx true ||
      { echo "FAIL: $l did not emit ExecutionSuccess" >&2; exit 1; }
  done
  local usd w
  usd=$(call "$BUSDC" "balanceOf(address)(uint256)" "$safe"); w=$(call "$(plan_field contracts.wrappedNative.address)" "balanceOf(address)(uint256)" "$safe")
  [ "$usd" != 0 ] && [ "$w" != 0 ] || { echo "FAIL: the Safe could not redeem its fee" >&2; exit 1; }
  log "Bloch Inc Safe redeemed $fee LP -> $w WBLCH wei + $usd bUSDC base units (Safe nonce now $(call "$safe" "nonce()(uint256)"))"
  done_mark fee3
}

step_report() {
  local p; p=$(pair)
  {
    echo "at $(date -u +%FT%TZ) latest $(cast block-number --rpc-url "$RPC") finalized $(cast block finalized --field number --rpc-url "$RPC")"
    local q
    for q in $(json "v.pairs.map((x) => x.address).join(' ')" < "$WORK/plan.json"); do
      echo "pair $q reserves $(reserves "$q") totalSupply $(call "$q" "totalSupply()(uint256)") kLast $(call "$q" "kLast()(uint256)")"
    done
    local name a names="deployer ownerA ownerB ownerC funder dev blochinc"
    [ "$SAFE_MODE" != safe ] || names="deployer bootstrap funder dev blochinc"
    [ -z "$WGSMH" ] || names="$names holder"
    for name in $names; do
      if [ $name = blochinc ]; then a=$(cat "$WORK/blochinc.addr"); else a=$(addr $name); fi
      echo "$name $a BLCH $(cast balance "$a" --rpc-url "$RPC") nonce $(cast nonce "$a" --rpc-url "$RPC")" \
        "bUSDC $(call "$BUSDC" "balanceOf(address)(uint256)" "$a")" \
        "WBLCH $(call "$(plan_field contracts.wrappedNative.address)" "balanceOf(address)(uint256)" "$a")" \
        "LP(bUSDC pair) $(call "$p" "balanceOf(address)(uint256)" "$a")" \
        ${WGSMH:+"wGSMH $(call "$WGSMH" "balanceOf(address)(uint256)" "$a") LP(wGSMH pair) $(call "$(pair_of "$WGSMH")" "balanceOf(address)(uint256)" "$a")"}
    done
    echo "transactions (label hash block gasUsed effectiveGasPrice status):"
    cat "$WORK/txs.tsv"
  } | tee "$WORK/report.txt"
}

for step in "$@"; do
  case $step in
    all)
      if [ "$SAFE_MODE" = safe ]; then flow="keys safe fund config deploy gate seed3 trade3 fee3 report"
      elif [ -n "$WGSMH" ]; then flow="keys fund config deploy gate seed2 multihop report"
      else flow="keys fund config deploy gate seed trade fee report"; fi
      for s in $flow; do "step_$s"; done ;;
    keys|safe|fund|config|deploy|gate|seed|trade|fee|seed2|multihop|seed3|trade3|fee3|report) "step_$step" ;;
    *) echo "unknown step $step" >&2; exit 2 ;;
  esac
done
