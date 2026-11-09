#!/usr/bin/env bash
# DEX launch flow on the private stack of stack.sh, with REAL settled finality.
# Deployment steps use the unmodified kit (deploy-infra, deploy-safe, deploy-dex,
# sign-and-publish, record, verify-deployment, the mainnet gate). Launch steps
# after the gate are sent in bursts so that one L2 block (one real proof) covers
# several of them: the kit's sequential path would take one proof per step.
#
#   drive.sh keys|bridge-eth|fund|wait-funded|deploy|gate|bridge-credit|bridge-deposit|seed|swaps|safe-fee|cap-skim|ui-prep|budget|...
# State lives in $F/flow; each step records its result in $F/flow/evidence.
#
# bUSDC is the REAL bridge token (scripts/staging/bridge-v3-real.sh): BridgedStablecoinV3 from the bridge's own
# deploy_pontes.py under the mainnet policy, over a ProvenanceSourceVault on a loopback "Ethereum" anvil. Set
#   BRIDGE_REPO=<clean git checkout of the bridge repository at its release candidate>  ETH_PORT=<free loopback port>
# for every step. The mainnet gate and the monitor take the bridge's busdc.plan.json and busdc.record.json; without
# them they refuse (agent 227, L-3). The token's 12 h mint delay is real here (the L2 clock follows the private L1):
# `deploy` queues the issuer's mint, and `bridge-credit` executes it once the delay has passed, before `seed`.
#
# Order of the run of record (one flow, 13 keys): keys, bridge-eth, fund, wait-funded, deploy, gate, [12 h],
# bridge-credit, rec-fund, seed, safe-fee, cap-skim, fund-user, pending-probe, big-swap 30, ui-prep, donate,
# fill 300 3, close 200 2, keeper run, reopened, fill 100 2, budget. Derived flows on the same L2 (new DEX, same
# Safe, infra and token): FLOW=f3 rec-init flow, fund, rec-fund, deploy, gate, failed-approve, grief; and
# FLOW=f2 ATTACK_CREATEPAIR=1 rec-init flow, fund, rec-fund, deploy. Measured need (proofless.sh, 2026-11-09):
# 3,200.16 bUSDC for the main flow and 2,100 for each derived flow, 7,399.18 in all, from the one 9,000 bUSDC deposit.
set -euo pipefail
F=${F:-$HOME/l2dexbridge-20261030/dex-e2e-r3}
. "$F/env.sh"
export HOME_REAL=$HOME HOME=$F/fhome
export FS=$F DRILL_SETTLER_DIR=$F/src/settler
export SAFE_ARTIFACTS=$F/safe/package/build/artifacts
# REDEPLOY at a new commit: sync it to $F/$REPO, then run the whole flow again with a
# new FLOW (fresh keys, so every contract gets new addresses on the same live L2).
ROOT=$F/${REPO:-repo}; cd "$ROOT"
WORK=$F/${FLOW:-flow}; EV=$WORK/evidence; mkdir -p "$EV"
# The settled stack's RPC and gateway. E2E_RPC / E2E_GW point the same steps at another loopback L2 (the proofless
# measuring run of docs/MAINNET-700770-PACKAGE.md: scripts/staging/private-l2.sh, no L1, no proof); there E2E_FINALIZE
# is the command that marks the head finalized (`private-l2.sh finalize WORK PORT`), run while waiting for finality.
RPC=${E2E_RPC:-http://127.0.0.1:25020}
GW=${E2E_GW:-http://127.0.0.1:25073}
case "$RPC$GW" in http://127.0.0.1:*http://127.0.0.1:*) ;; *) echo "E2E_RPC and E2E_GW must be loopback (http://127.0.0.1:<port>)" >&2; exit 2 ;; esac
STACK_KIND=$([ -n "${E2E_FINALIZE:-}" ] && echo "private L2, no proofs, synthetic finality" || echo "private stack, real settlement")
REVISION=${REVISION:-$(node -e 'console.log(require(process.argv[1]).source.revision)' "$ROOT/deployments/mainnet/dex-mainnet.config.json")}
MAXFEE=5000000000; TIP=1000000000; USD_BUCKET=10000000000
ZERO=0x0000000000000000000000000000000000000000
EXEC="execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)"
log() { echo "== $(date -u +%FT%TZ) $*" | tee -a "$EV/steps.log"; }
note() { echo "$*" | tee -a "$EV/steps.log"; }
jsonget() { node -e 'const v=process.argv[2].split(".").reduce((o,k)=>o[k],require(require("path").resolve(process.argv[1])));console.log(typeof v==="object"?JSON.stringify(v):v)' "$1" "$2"; }
key() { node -e 'console.log(require(process.argv[1])[Number(process.argv[2])].private_key)' "$WORK/keys.json" "$1"; }
addr() { node -e 'console.log(require(process.argv[1])[Number(process.argv[2])].address.toLowerCase())' "$WORK/keys.json" "$1"; }
if [ -f "$WORK/keys.json" ]; then
  BOOT_KEY=$(key 0); BOOT=$(addr 0); DEPLOYER_KEY=$(key 1); DEPLOYER=$(addr 1); ISSUER_KEY=$(key 2); ISSUER=$(addr 2); LP_RECIPIENT=$ISSUER
  OWNER_KEYS=("$(key 3)" "$(key 4)" "$(key 5)" "$(key 6)" "$(key 7)")
  OWNERS=("$(addr 3)" "$(addr 4)" "$(addr 5)" "$(addr 6)" "$(addr 7)")
  INFRA_KEY=$(key 8); INFRA=$(addr 8); USER_KEY=$(key 9); USER_ADDR=$(addr 9)
  # Run of record (option C): 10 fresh first depositor, 11 third party, 12 keeper.
  if [ "$(node -e 'console.log(require(process.argv[1]).length)' "$WORK/keys.json")" -gt 10 ]; then
    DEPOSITOR_KEY=$(key 10); DEPOSITOR=$(addr 10); ATTACKER_KEY=$(key 11); ATTACKER=$(addr 11); KEEPER_KEY=$(key 12); KEEPER=$(addr 12)
  fi
fi
# A closed level (-32001 before the first settlement) reads as "none", like a null block.
numtag() { (cast rpc eth_getBlockByNumber "$1" false --rpc-url "${2:-$RPC}" 2> /dev/null || echo null) | node -e 'const b=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(b?BigInt(b.number).toString():"none")'; }
heads() { echo "latest $(numtag latest) safe $(numtag safe) finalized $(numtag finalized)"; }
# Wait until the settled RPC's finalized tag reaches block $1; prints how long it took.
wait_final() {
  local want=$1 t0; t0=$(date +%s)
  until [ "$(numtag finalized)" != none ] && [ "$(numtag finalized)" -ge "$want" ]; do
    if [ -n "${E2E_FINALIZE:-}" ]; then $E2E_FINALIZE > /dev/null; else sleep 5; fi
  done
  note "finalized reached $want after $(( $(date +%s) - t0 ))s ($(heads))"
}

# Burst: Q holds "key|to|data|value|gas|expected status (0x0, 0x1 or any)[|tip]"; flush publishes them all at
# once with consecutive nonces, then requires each receipt with the expected status.
Q=()
q() { Q+=("$1|$2|$3|$4|$5|$6|${7:-$TIP}"); }
flush() {
  local -A nonces=(); local hashes=() line k to data value gas want tip from raw h
  for line in "${Q[@]}"; do
    IFS='|' read -r k to data value gas want tip <<< "$line"
    from=$(cast wallet address --private-key "$k")
    [ -n "${nonces[$from]:-}" ] || nonces[$from]=$(cast nonce "$from" --block pending --rpc-url "$RPC")
    if [ "$to" = create ]; then
      raw=$(cast mktx --chain 700770 --nonce "${nonces[$from]}" --gas-limit "$gas" --gas-price $MAXFEE --priority-gas-price "$tip" --value "$value" --private-key "$k" --create "$data")
    else
      raw=$(cast mktx --chain 700770 --nonce "${nonces[$from]}" --gas-limit "$gas" --gas-price $MAXFEE --priority-gas-price "$tip" --value "$value" --private-key "$k" "$to" "$data")
    fi
    nonces[$from]=$((nonces[$from] + 1))
    h=$(cast keccak "$raw"); cast publish --async --rpc-url "$RPC" "$raw" > /dev/null
    hashes+=("$h|$want")
  done
  local entry r status block t0 last=0 got
  t0=$(date +%s)
  for entry in "${hashes[@]}"; do
    h=${entry%%|*}; want=${entry##*|}
    while :; do
      r=$(cast rpc eth_getTransactionReceipt "$h" --rpc-url "$RPC")
      [ "$r" != null ] && break
      [ $(( $(date +%s) - t0 )) -lt 14400 ] || { echo "FAIL: no receipt for $h" >&2; exit 1; }
      sleep 3
    done
    got=$(node -e 'const r=JSON.parse(process.argv[1]);console.log(r.status, BigInt(r.blockNumber).toString(), r.contractAddress ?? "", BigInt(r.gasUsed).toString())' "$r")
    read -r status block _ <<< "$got"
    note "tx $h block $block status $status want $want"
    [ "$want" = any ] || [ "$status" = "$want" ] || { echo "FAIL: $h status $status, wanted $want" >&2; exit 1; }
    [ "$block" -gt "$last" ] && last=$block
  done
  until [ "$(numtag latest)" -ge "$last" ]; do sleep 1; done
  LAST_BLOCK=$last; echo "$last" > "$WORK/last-block"
  printf '%s\n' "${hashes[@]%%|*}" > "$WORK/last-hashes"
  Q=()
  note "burst done in $(( $(date +%s) - t0 ))s, last block $last ($(heads))"
  echo "$cmd ${#hashes[@]} $last" >> "$EV/bursts.txt"
}
# The kit's raw-tx file, published from the signer's next nonce in one burst, with the kit's checks
# on each receipt and the kit's hash file. For this rehearsal only: PROVING.lock is contended here
# (25-35 min per L2 block), and sign-and-publish.sh needs one block per transaction.
publish_burst() {
  local file=$1 k=$2 out=$3 from next count i
  from=$(jsonget "$file" from); next=$(cast nonce "$from" --block latest --rpc-url "$RPC"); count=$(jsonget "$file" transactions.length)
  : > "$out.new"
  for i in $(seq 0 $((count - 1))); do
    [ "$(jsonget "$file" "transactions.$i.nonce")" -ge "$next" ] || continue
    local to data gas value tip=$TIP raw h
    to=$(jsonget "$file" "transactions.$i.to"); data=$(jsonget "$file" "transactions.$i.data")
    gas=$(jsonget "$file" "transactions.$i.gasLimit"); value=$(jsonget "$file" "transactions.$i.value")
    if [ "$to" = null ]; then raw=$(cast mktx --chain 700770 --nonce "$(jsonget "$file" "transactions.$i.nonce")" --gas-limit "$gas" --gas-price $MAXFEE --priority-gas-price $tip --value "$value" --private-key "$k" --create "$data")
    else raw=$(cast mktx --chain 700770 --nonce "$(jsonget "$file" "transactions.$i.nonce")" --gas-limit "$gas" --gas-price $MAXFEE --priority-gas-price $tip --value "$value" --private-key "$k" "$to" "$data"); fi
    h=$(cast keccak "$raw"); cast publish --async --rpc-url "$RPC" "$raw" > /dev/null || note "publish refused (already in the spool?) $h"; echo "$h" >> "$out.new"
    note "published $(jsonget "$file" "transactions.$i.label") $h"
  done
  while read -r h; do
    local r
    until r=$(cast rpc eth_getTransactionReceipt "$h" --rpc-url "$RPC") && [ "$r" != null ]; do sleep 5; done
    if [ "$(node -e 'console.log(JSON.parse(process.argv[1]).status)' "$r")" != 0x1 ]; then
      [ -n "${ATTACK_CREATEPAIR:-}" ] || { echo "FAIL: reverted $h" >&2; exit 1; }
      note "reverted $h (expected for the deployer's createPair under F2)"
    fi
    echo "$h" >> "$out"
    note "mined $h block $(node -e 'console.log(BigInt(JSON.parse(process.argv[1]).blockNumber).toString())' "$r")"
  done < "$out.new"
  rm -f "$out.new"
}
state_load() {
  ASSET=$(cat "$WORK/asset"); ROUTER=$(jsonget "$EV/dex.plan.json" contracts.router.address)
  FACTORY=$(jsonget "$EV/dex.plan.json" contracts.factory.address); WRAPPED=$(jsonget "$EV/dex.plan.json" contracts.wrappedNative.address)
  PAIR=$(jsonget "$EV/dex.plan.json" pairs.0.address); LENS=$(jsonget "$EV/dex.plan.json" contracts.lens.address)
  BLOCH_INC=$(jsonget "$EV/blochinc.json" address); MULTICALL=$(jsonget "$EV/infra.plan.json" contracts.multicall3.address)
  CREATE2=$(jsonget "$EV/infra.plan.json" contracts.create2Deployer.address)
}
GATE="node scripts/staging/check-finality-gate-mainnet.mjs"
SWAP_IN="swapExactTokensForBLCH(uint256,uint256,address[],address,uint256)"
SWAP_OUT="swapExactBLCHForTokens(uint256,address[],address,uint256)"
ADD="addLiquidityBLCH(address,uint256,uint256,uint256,address,uint256)"
QUOTE="quoteExactInput(uint256,address[],uint256)((bool,uint256,uint256,uint256,uint256,uint256[],uint256[]))"
EXCESS="pendingExcess(address)((uint256,uint256,bool,bool))"
FAR=99999999999
mon_note() { # label [flags] -> stores the JSON and logs level and non-OK checks
  local label=$1; shift
  set +e; node scripts/ops/dex-monitor.mjs --config "$EV/gate.json" --safe-plan "$EV/safe.plan.json" "${BRIDGE_ARGS[@]}" --rpc "${MON_RPC:-$RPC}" --lp-recipient "$LP_RECIPIENT" "$@" --json > "$EV/monitor.$label.json"; local c=$?; set -e
  note "monitor[$label] exit $c: $(node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((r.checks||[]).filter(c=>c.level!==0&&c.status!=="OK"&&c.level!=="OK").map(c=>c.name+":"+(c.message||c.detail||"")).join("; ")||"all OK")' "$EV/monitor.$label.json" 2>/dev/null || echo unparsable)"
}

# The real bridge token (see the header). `must` is the library's "one mined L2 transaction that must succeed".
: "${BRIDGE_REPO:?BRIDGE_REPO=<clean bridge checkout> is required (the mainnet gate takes bUSDC from the bridge deployment record)}"
: "${ETH_PORT:?ETH_PORT=<free loopback port for the rehearsal Ethereum anvil> is required}"
BRIDGE_ETH_RPC=http://127.0.0.1:$ETH_PORT
# The issuer's bUSDC: `deploy` queues one vault deposit of BRIDGE_ISSUER_NET units (net of the vault's fee), and each
# `bridge-deposit` queues one more. The mainnet limits are real here: one deposit is at most the vault's windowLimit
# (10,000 USDC gross) and the token's mint bucket holds 10,000 bUSDC refilled over 24 h, so a second deposit of this
# size is refused (RateLimited) until about a day after the first. Measured need of each flow:
# docs/MAINNET-700770-PACKAGE.md, "Settled driver budget".
BRIDGE_ISSUER_NET=${BRIDGE_ISSUER_NET:-9000000000}
must() { q "$1" "$2" "$3" "$4" "$5" 0x1; flush; }
# shellcheck source=scripts/staging/bridge-v3-real.sh
. scripts/staging/bridge-v3-real.sh
BRIDGE_ARGS=()
if [ -s "$WORK/bridge/keys.json" ]; then bridge_v3_load; fi
FUNDED=("${BOOT:-}" "${DEPLOYER:-}" "${ISSUER:-}" "${INFRA:-}" "${BRIDGE_L2_DEPLOYER:-}"); NFUNDED=5

cmd=${1:?command}; shift || true
case "$cmd" in
keys)
  [ ! -e "$WORK/keys.json" ] || { echo "keys exist"; exit 1; }
  # 0 Safe bootstrap, 1 DEX deployer, 2 issuer, 3-7 Safe owners, 8 infra, 9 browser user, 10 first depositor (the
  # DEX config requires one), 11 third party, 12 keeper. 10-12 get gas and bUSDC from `rec-fund` after `bridge-credit`.
  umask 077; cast wallet new --number 13 --json > "$WORK/keys.json"; umask 022
  bridge_v3_keys
  echo "keys generated (throwaway) in $WORK/keys.json and $WORK/bridge/keys.json"
  ;;
bridge-eth)
  # The rehearsal "Ethereum": a loopback anvil with chain id 1 that outlives this invocation (`bridge-eth stop` ends it).
  if [ "${1:-}" = stop ]; then
    [ ! -e "$WORK/bridge/anvil-eth.pid" ] || { kill "$(cat "$WORK/bridge/anvil-eth.pid")" 2> /dev/null || true; rm -f "$WORK/bridge/anvil-eth.pid"; }
    echo "rehearsal Ethereum stopped"
  else
    [ ! -e "$WORK/bridge/anvil-eth.pid" ] || { echo "rehearsal Ethereum already started"; exit 1; }
    nohup anvil --chain-id 1 --port "$ETH_PORT" --host 127.0.0.1 --silent < /dev/null > "$WORK/bridge/anvil-eth.log" 2>&1 &
    echo $! > "$WORK/bridge/anvil-eth.pid"
    for _ in $(seq 50); do cast chain-id --rpc-url "$BRIDGE_ETH_RPC" > /dev/null 2>&1 && break; sleep 0.2; done
    echo "rehearsal Ethereum (anvil, chain id 1) on $BRIDGE_ETH_RPC, pid $(cat "$WORK/bridge/anvil-eth.pid")"
  fi
  ;;
fund)
  # L1 -> L2 deposits for the deployers, the issuer and the bridge token's deployer, through the real inbox.
  python3 - "${FUNDED[@]}" <<'PY'
import os, sys, time, json
sys.path.insert(0, os.environ['FS'] + '/src/rehearsal/drills')
import drillctl as d
fs = d.fs
def ok():
    v = d.safe_rpc('getl2settlement'); c = d.safe_rpc('getchaininfo')
    return isinstance(v, dict) and 'error' not in v and (c.get('height') or 0) > 5
for _ in range(120):
    if ok(): break
    time.sleep(5)
fs.save(**{f'l2_address_a{i}': a[2:] for i, a in enumerate(sys.argv[1:])})
for i in range(len(sys.argv) - 1):
    for _ in range(40):
        try:
            fs.deposit(f'a{i}', 10_000_000_000)
            break
        except SystemExit as e:
            print('retry', str(e)[:200], flush=True); time.sleep(5)
    time.sleep(8)
PY
  log "fund: $NFUNDED deposits of 100 BLCH sent on L1"
  ;;
wait-funded)
  for a in "${FUNDED[@]}"; do
    until [ "$(cast balance "$a" --rpc-url "$RPC" 2>/dev/null || echo 0)" != 0 ]; do sleep 10; done
  done
  log "fund: all $NFUNDED addresses funded on L2 ($(heads))"
  ;;
deploy)
  GENESIS=$(cast block 0 --field hash --rpc-url "$RPC")
  log "chain $(cast chain-id --rpc-url "$RPC") genesis $GENESIS ($STACK_KIND)"
  forge build > "$WORK/build.log" 2>&1 || { tail -n 30 "$WORK/build.log"; exit 1; }
  if [ ! -e "$WORK/infra.txs.json" ]; then
  # infra
  node scripts/staging/deploy-infra.mjs pending --config deployments/mainnet/700770/infra.config.json > "$EV/infra.pending.json"
  node -e '
const c = JSON.parse(require("fs").readFileSync("deployments/mainnet/700770/infra.config.json", "utf8"));
const [genesis, key] = process.argv.slice(1);
c.network.genesisHash = genesis; c.deployer.address = key;
console.log(JSON.stringify(c, null, 2));' "$GENESIS" "$INFRA" > "$EV/infra.config.json"
  I="node scripts/staging/deploy-infra.mjs"
  $I validate --config "$EV/infra.config.json" > "$EV/infra.validate.json"
  INFRA_SHA=$(jsonget "$EV/infra.validate.json" configSha256)
  $I plan --config "$EV/infra.config.json" --write "$EV/infra.plan.json" > /dev/null
  $I preflight --config "$EV/infra.config.json" --plan "$EV/infra.plan.json" --rpc "$RPC" > "$EV/infra.preflight.json"
  $I txs --config "$EV/infra.config.json" --plan "$EV/infra.plan.json" --write "$WORK/infra.txs.json" >> "$EV/steps.log"
  fi
  if [ ! -e "$WORK/safe.txs.json" ]; then
  # Safe
  OWNERS_JSON=$(printf '"%s",' "${OWNERS[@]}"); OWNERS_JSON="[${OWNERS_JSON%,}]"
  node -e '
const c = JSON.parse(require("fs").readFileSync("deployments/mainnet/700770/safe.config.json", "utf8"));
const [genesis, boot, owners] = process.argv.slice(1);
c.network.genesisHash = genesis; c.bootstrap.address = boot; c.safe.owners = JSON.parse(owners);
console.log(JSON.stringify(c, null, 2));' "$GENESIS" "$BOOT" "$OWNERS_JSON" > "$EV/safe.config.json"
  S="node scripts/staging/deploy-safe.mjs"
  $S validate --config "$EV/safe.config.json" > "$EV/safe.validate.json"
  SAFE_SHA=$(jsonget "$EV/safe.validate.json" configSha256)
  $S plan --config "$EV/safe.config.json" --artifacts "$SAFE_ARTIFACTS" --write "$EV/safe.plan.json" > /dev/null
  $S preflight --config "$EV/safe.config.json" --artifacts "$SAFE_ARTIFACTS" --plan "$EV/safe.plan.json" --rpc "$RPC" > "$EV/safe.preflight.json"
  $S txs --config "$EV/safe.config.json" --artifacts "$SAFE_ARTIFACTS" --plan "$EV/safe.plan.json" --write "$WORK/safe.txs.json" >> "$EV/steps.log"
  $S blochinc --plan "$EV/safe.plan.json" > "$EV/blochinc.json"
  fi
  log "infra and Safe: one burst"
  P=scripts/staging/sign-and-publish.sh
  publish_burst "$WORK/infra.txs.json" "$INFRA_KEY" "$EV/infra.hashes.txt" &
  PA=$!
  publish_burst "$WORK/safe.txs.json" "$BOOT_KEY" "$EV/safe.hashes.txt" &
  PB=$!
  wait $PA; wait $PB
  log "infra and Safe published ($(heads))"
  if [ ! -e "$WORK/asset" ]; then
    # The real bUSDC: vault_pontes.py and deploy_pontes.py under the mainnet policy; the Safe is the named funder.
    BLOCH_INC=$(jsonget "$EV/blochinc.json" address)
    bridge_v3_vault "$BLOCH_INC"
    bridge_v3_token "$GENESIS" "$BLOCH_INC"
    echo "$ASSET" > "$WORK/asset"
    bridge_v3_open
    # The issuer's bUSDC: a real vault deposit and the committee's mint now; `bridge-credit` executes it after 12 h.
    bridge_v3_deposit "$BRIDGE_ISSUER_NET" "$ISSUER" "$ISSUER_KEY"
    echo "$BRIDGE_DEPOSIT_ID" > "$WORK/bridge/issuer-deposit-id"
    bridge_v3_fees
    note "bridge: $BRIDGE_ISSUER_NET bUSDC units queued for the issuer (deposit $BRIDGE_DEPOSIT_ID); run bridge-credit after the $BRIDGE_MINT_DELAY s delay"
  fi
  ASSET=$(cat "$WORK/asset"); ASSET_CODE=$(cast keccak "$(cast code "$ASSET" --rpc-url "$RPC")")
  note "bUSDC (BridgedStablecoinV3 from deploy_pontes.py) $ASSET code $ASSET_CODE"
  FIRST_DEPOSITOR=${DEPOSITOR:-} node -e '
const c = JSON.parse(require("fs").readFileSync("deployments/mainnet/dex-mainnet.config.json", "utf8"));
const [genesis, revision, deployer, blochInc, token, codeHash] = process.argv.slice(1);
c.network.genesisHash = genesis; c.source.revision = revision; c.deployer.address = deployer;
c.openingPrice.quotePerWrapped = "100000000";
if ("firstDepositor" in c) c.firstDepositor = process.env.FIRST_DEPOSITOR;
c.blochInc = JSON.parse(require("fs").readFileSync(blochInc, "utf8"));
Object.assign(c.reserveCaps[1], { token, codeHash });
console.log(JSON.stringify(c, null, 2));' "$GENESIS" "$REVISION" "$DEPLOYER" "$EV/blochinc.json" "$ASSET" "$ASSET_CODE" > "$EV/dex.config.json"
  DX="node scripts/staging/deploy-dex.mjs"
  $DX validate --config "$EV/dex.config.json" > "$EV/dex.validate.json"
  DEX_SHA=$(jsonget "$EV/dex.validate.json" configSha256)
  $DX plan --config "$EV/dex.config.json" --write "$EV/dex.plan.json" > /dev/null
  log "DEX: preflight and forge dry run"
  $DX run --config "$EV/dex.config.json" --plan "$EV/dex.plan.json" --rpc "$RPC" > "$EV/dex.dry-run.log" 2>&1 || { tail -n 30 "$EV/dex.dry-run.log"; exit 1; }
  tail -n 4 "$EV/dex.dry-run.log" | tee -a "$EV/steps.log"
  [ "$(cast nonce "$DEPLOYER" --rpc-url "$RPC")" = 0 ] || { echo "FAIL: dry run changed the chain"; exit 1; }
  $DX txs --config "$EV/dex.config.json" --plan "$EV/dex.plan.json" --write "$WORK/dex.txs.json" >> "$EV/steps.log"
  if [ -n "${ATTACK_CREATEPAIR:-}" ]; then
    # F2: a third party calls createPair as soon as the factory is on chain.
    (
      FACTORY=$(jsonget "$EV/dex.plan.json" contracts.factory.address); WRAPPED=$(jsonget "$EV/dex.plan.json" contracts.wrappedNative.address)
      until [ "$(cast code "$FACTORY" --rpc-url "$RPC")" != 0x ]; do sleep 2; done
      note "F2: factory $FACTORY is on chain; third party sends createPair"
      q "$ISSUER_KEY" "$FACTORY" "$(cast calldata "createPair(address,address)" "$WRAPPED" "$ASSET")" 0 3000000 any 3000000000; flush
    ) &
    ATTACKER=$!
  fi
  log "DEX: sign-and-publish (factory, router, lens, WBLCH, pair)"
  if [ -n "${ATTACK_CREATEPAIR:-}" ]; then
    # F2: the third party's createPair lands in the block before the deployer's own (higher tip, same block at worst).
    node -e 'const t=require(process.argv[1]);t.transactions=t.transactions.slice(0,-1);console.log(JSON.stringify(t))' "$WORK/dex.txs.json" > "$WORK/dex.head.txs.json"
    publish_burst "$WORK/dex.head.txs.json" "$DEPLOYER_KEY" "$EV/dex.hashes.txt" 2>&1 | tee "$EV/dex.publish.log"
    FACTORY=$(jsonget "$EV/dex.plan.json" contracts.factory.address); WRAPPED=$(jsonget "$EV/dex.plan.json" contracts.wrappedNative.address)
    note "F2: factory on chain; third party $ATTACKER sends createPair, tip 3 gwei"
    q "$ATTACKER_KEY" "$FACTORY" "$(cast calldata "createPair(address,address)" "$WRAPPED" "$ASSET")" 0 3000000 any 3000000000; flush &
    ATT=$!
    sleep 2
    publish_burst "$WORK/dex.txs.json" "$DEPLOYER_KEY" "$EV/dex.hashes.txt" 2>&1 | tee -a "$EV/dex.publish.log" || note "F2: the deployer's createPair did not succeed"
    wait $ATT
  else
    publish_burst "$WORK/dex.txs.json" "$DEPLOYER_KEY" "$EV/dex.hashes.txt" 2>&1 | tee "$EV/dex.publish.log"
  fi
  $DX record --config "$EV/dex.config.json" --plan "$EV/dex.plan.json" --rpc "$RPC" --tx-hashes "$EV/dex.hashes.txt" --write "$EV/gate.json" >> "$EV/steps.log"
  node scripts/staging/verify-deployment.mjs --safe-plan "$EV/safe.plan.json" --dex-plan "$EV/dex.plan.json" --infra-plan "$EV/infra.plan.json" --rpc "$RPC" \
    --safe-hashes "$EV/safe.hashes.txt" --dex-hashes "$EV/dex.hashes.txt" --infra-hashes "$EV/infra.hashes.txt" --expect-empty > "$EV/verify.latest.json"
  note "verify at latest: $(node -e 'const r=require(process.argv[1]);console.log(r.decision, r.checks.length, "checks")' "$EV/verify.latest.json")"
  log "deploy done ($(heads))"
  ;;
gate)
  GATE_ARGS=(--config "$EV/gate.json" --safe-plan "$EV/safe.plan.json" "${BRIDGE_ARGS[@]}" --rpc "$RPC")
  log "gate before finality"
  if $GATE "${GATE_ARGS[@]}" 2> "$EV/gate.early.txt" > /dev/null; then note "gate passed already: deployment block was finalized before this check"; else note "refused: $(cat "$EV/gate.early.txt")"; fi
  LAST=$(BN=$(tail -1 "$EV/dex.hashes.txt"); cast rpc eth_getTransactionReceipt "$BN" --rpc-url "$RPC" | node -e 'console.log(BigInt(JSON.parse(require("fs").readFileSync(0,"utf8")).blockNumber).toString())')
  log "waiting for real finality of block $LAST"
  wait_final "$LAST"
  cast rpc bloch_finality --rpc-url "$RPC" > "$EV/bloch_finality.json" || true
  bridge_v3_verify
  $GATE "${GATE_ARGS[@]}" > "$EV/gate-report.json"
  note "gate: $(node -e 'const r=require(process.argv[1]);console.log(r.decision, "finalized", r.finalized.number, r.genesisHash)' "$EV/gate-report.json")"
  node scripts/staging/verify-deployment.mjs --safe-plan "$EV/safe.plan.json" --dex-plan "$EV/dex.plan.json" --infra-plan "$EV/infra.plan.json" --rpc "$RPC" --at finalized \
    --safe-hashes "$EV/safe.hashes.txt" --dex-hashes "$EV/dex.hashes.txt" --infra-hashes "$EV/infra.hashes.txt" --expect-empty > "$EV/verify.finalized.json"
  note "verify at finalized: $(node -e 'const r=require(process.argv[1]);console.log(r.decision, r.checks.length, "checks")' "$EV/verify.finalized.json")"
  ;;
bridge-credit)
  # The issuer's queued mint, executed by the issuer as the relayer once the token's delay has passed on the L2 clock.
  state_load
  # Every queued deposit not yet credited, in one burst (one L2 block). A mint whose delay is not over reverts.
  touch "$WORK/bridge/issuer-credited"
  BEFORE=$(cast call "$ASSET" "balanceOf(address)(uint256)" "$ISSUER" --rpc-url "$RPC" | awk '{print $1}'); COUNT=0
  while read -r ID; do
    grep -qx "$ID" "$WORK/bridge/issuer-credited" && continue
    q "$ISSUER_KEY" "$ASSET" "$(cast calldata "executeMint(bytes32)" "$ID")" 0 1500000 0x1; COUNT=$((COUNT + 1))
  done < "$WORK/bridge/issuer-deposit-id"
  [ "$COUNT" -gt 0 ] || { echo "bridge: every queued deposit is already credited"; exit 0; }
  flush
  [ "$(cast call "$ASSET" "balanceOf(address)(uint256)" "$ISSUER" --rpc-url "$RPC" | awk '{print $1}')" = "$((BEFORE + COUNT * BRIDGE_ISSUER_NET))" ] || { echo "FAIL: the issuer's bUSDC did not credit"; exit 1; }
  cp "$WORK/bridge/issuer-deposit-id" "$WORK/bridge/issuer-credited"
  log "bridge: $((COUNT * BRIDGE_ISSUER_NET)) bUSDC units credited to the issuer ($COUNT deposit(s)) ($(heads))"
  ;;
bridge-deposit)
  # One more vault deposit for the issuer, queued on the L2 (the delay starts now). Refused while the token's mint
  # bucket has less than the deposit: on the settled stack that is about a day after the previous one.
  state_load
  AVAILABLE=$(cast call "$ASSET" "availableToMint()(uint256)" --rpc-url "$RPC" | awk '{print $1}')
  [ "$AVAILABLE" -ge "$BRIDGE_ISSUER_NET" ] || { echo "FAIL: the token's mint bucket holds $AVAILABLE units, the deposit needs $BRIDGE_ISSUER_NET (10,000 bUSDC refill over 24 h)"; exit 1; }
  bridge_v3_deposit "$BRIDGE_ISSUER_NET" "$ISSUER" "$ISSUER_KEY"
  echo "$BRIDGE_DEPOSIT_ID" >> "$WORK/bridge/issuer-deposit-id"
  # The fee of this deposit too reaches the immutable recipient (bridge_v3_fees checks a first sweep only).
  cast send "$VAULT" "sweepFees()" --private-key "$BRIDGE_ETH_USER_KEY" --rpc-url "$BRIDGE_ETH_RPC" > /dev/null
  [ "$(cast call "$BRIDGE_USDC" "balanceOf(address)(uint256)" "$BRIDGE_FEE_TO" --rpc-url "$BRIDGE_ETH_RPC" | awk '{print $1}')" = "$BRIDGE_FEE_TOTAL" ] || { echo "FAIL: sweepFees did not pay the fee recipient"; exit 1; }
  log "bridge: one more deposit of $BRIDGE_ISSUER_NET bUSDC units queued for the issuer (deposit $BRIDGE_DEPOSIT_ID); run bridge-credit after the $BRIDGE_MINT_DELAY s delay"
  ;;
seed)
  state_load
  log "seed plan (kit) for price 100"
  node scripts/ops/dex-seed-plan.mjs plan --config "$EV/gate.json" --rpc "$RPC" --price 100 --to "$ISSUER" > "$EV/seed-plan.json" || note "seed plan exit $?"
  log "first liquidity burst: setFeeTo reverts, approve, 50% seed, over-cap deposit reverts"
  q "$DEPLOYER_KEY" "$FACTORY" "$(cast calldata "setFeeTo(address)" "$DEPLOYER")" 0 100000 0x0
  q "$ISSUER_KEY" "$ASSET" "$(cast calldata "approve(address,uint256)" "$ROUTER" 1000000000000)" 0 100000 0x1 2000000000
  if [ -n "${DEPOSITOR:-}" ]; then
    [ "$(cast nonce "$DEPOSITOR" --rpc-url "$RPC")" = 0 ] || { echo "FAIL: the first depositor is not fresh"; exit 1; }
    # Tip order inside the block: third party first (must revert FIRST_DEPOSITOR), then the seed, then the rest.
    q "$ATTACKER_KEY" "$ASSET" "$(cast calldata "approve(address,uint256)" "$ROUTER" 1000000000000)" 0 100000 0x1 3000000000
    q "$ATTACKER_KEY" "$ROUTER" "$(cast calldata "$ADD" "$ASSET" 1000000 0 0 "$ATTACKER" $FAR)" 10000000000000000 1000000 0x0 3000000000
    q "$DEPOSITOR_KEY" "$ASSET" "$(cast calldata "approve(address,uint256)" "$ROUTER" 500000000)" 0 100000 0x1 2000000000
    q "$DEPOSITOR_KEY" "$ROUTER" "$(cast calldata "$ADD" "$ASSET" 500000000 0 0 "$ISSUER" $FAR)" 5000000000000000000 1000000 0x1 2000000000
    TIP=500000000
  else
    q "$ISSUER_KEY" "$ROUTER" "$(cast calldata "$ADD" "$ASSET" 500000000 0 0 "$ISSUER" $FAR)" 5000000000000000000 1000000 0x1
  fi
  q "$ISSUER_KEY" "$ROUTER" "$(cast calldata "$ADD" "$ASSET" 600000000 0 0 "$ISSUER" $FAR)" 6000000000000000000 1000000 0x0
  log "same block: 3 swap pairs and a top-up that mints the protocol fee"
  for _ in 1 2 3; do
    q "$ISSUER_KEY" "$ROUTER" "$(cast calldata "$SWAP_IN" 100000000 0 "[$ASSET,$WRAPPED]" "$ISSUER" $FAR)" 0 400000 0x1
    q "$ISSUER_KEY" "$ROUTER" "$(cast calldata "$SWAP_OUT" 0 "[$WRAPPED,$ASSET]" "$ISSUER" $FAR)" 1000000000000000000 400000 0x1
  done
  q "$ISSUER_KEY" "$ROUTER" "$(cast calldata "$ADD" "$ASSET" 1000000 0 0 "$ISSUER" $FAR)" 10000000000000000 1000000 0x1
  flush
  note "protocol fee to the Safe: $(cast call "$PAIR" "balanceOf(address)(uint256)" "$BLOCH_INC" --rpc-url "$RPC") LP"
  [ -z "${DEPOSITOR:-}" ] || { [ "$(cast nonce "$DEPOSITOR" --rpc-url "$RPC")" = 2 ] || { echo "FAIL: the first depositor must send exactly two transactions"; exit 1; }; note "first depositor sent exactly 2 transactions"; }
  node scripts/ops/dex-seed-plan.mjs verify --config "$EV/gate.json" --rpc "$RPC" --price 100 --to "$LP_RECIPIENT" > "$EV/seed-verify.json" || note "seed verify exit $?"
  note "seed verify: $(cat "$EV/seed-verify.json" | head -c 300)"
  ;;
swaps)
  state_load
  [ "$(cast call "$PAIR" "balanceOf(address)(uint256)" "$BLOCH_INC" --rpc-url "$RPC" | awk '{print $1}')" = 0 ] || { note "swaps: already done with the seed"; exit 0; }
  log "swaps: 3 pairs and a top-up that mints the protocol fee"
  for _ in 1 2 3; do
    q "$ISSUER_KEY" "$ROUTER" "$(cast calldata "$SWAP_IN" 100000000 0 "[$ASSET,$WRAPPED]" "$ISSUER" $FAR)" 0 400000 0x1
    q "$ISSUER_KEY" "$ROUTER" "$(cast calldata "$SWAP_OUT" 0 "[$WRAPPED,$ASSET]" "$ISSUER" $FAR)" 1000000000000000000 400000 0x1
  done
  q "$ISSUER_KEY" "$ROUTER" "$(cast calldata "$ADD" "$ASSET" 1000000 0 0 "$ISSUER" $FAR)" 10000000000000000 1000000 0x1
  flush
  FEE=$(cast call "$PAIR" "balanceOf(address)(uint256)" "$BLOCH_INC" --rpc-url "$RPC" | awk '{print $1}')
  note "protocol fee to the Safe: $FEE LP"; [ "$FEE" != 0 ] || { echo "FAIL: no fee"; exit 1; }
  ;;
safe-fee)
  state_load
  FEE=$(cast call "$PAIR" "balanceOf(address)(uint256)" "$BLOCH_INC" --rpc-url "$RPC" | awk '{print $1}')
  APPROVE=$(cast calldata "approve(address,uint256)" "$ROUTER" "$FEE")
  REMOVE=$(cast calldata "removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)" "$ASSET" "$WRAPPED" "$FEE" 1 1 "$BLOCH_INC" $FAR)
  NONCE=$(cast call "$BLOCH_INC" "nonce()(uint256)" --rpc-url "$RPC")
  log "fee redemption: 2 of 5 refused and 3 of 5 executed, approve then removeLiquidity, one block"
  for STEP in "$PAIR $APPROVE" "$ROUTER $REMOVE"; do
    TARGET=${STEP%% *}; CALL=${STEP##* }
    HASH=$(cast call "$BLOCH_INC" "getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)(bytes32)" "$TARGET" 0 "$CALL" 0 0 0 0 "$ZERO" "$ZERO" "$NONCE" --rpc-url "$RPC")
    SIGS=0x
    for K in $(for i in 0 2 4; do echo "${OWNERS[$i]} ${OWNER_KEYS[$i]}"; done | sort | awk '{print $2}'); do
      SIGS+=$(cast wallet sign --no-hash "$HASH" --private-key "$K" | cut -c3-)
    done
    q "$ISSUER_KEY" "$BLOCH_INC" "$(cast calldata "$EXEC" "$TARGET" 0 "$CALL" 0 0 0 0 "$ZERO" "$ZERO" "${SIGS:0:262}")" 0 500000 0x0
    q "$ISSUER_KEY" "$BLOCH_INC" "$(cast calldata "$EXEC" "$TARGET" 0 "$CALL" 0 0 0 0 "$ZERO" "$ZERO" "$SIGS")" 0 500000 0x1
    NONCE=$((NONCE + 1))
  done
  flush
  note "Safe got $(cast call "$WRAPPED" "balanceOf(address)(uint256)" "$BLOCH_INC" --rpc-url "$RPC") WBLCH units, $(cast call "$ASSET" "balanceOf(address)(uint256)" "$BLOCH_INC" --rpc-url "$RPC") bUSDC units"
  ;;
cap-skim)
  state_load
  available() { cast call "$LENS" "$QUOTE" "$1" "[$ASSET,$WRAPPED]" 50 --rpc-url "$RPC" | cut -d, -f1 | tr -d '('; }
  log "cap and donation: lens says unavailable, swaps revert, excess reported"
  [ "$(available 900000000)" = false ] || { echo "FAIL: lens quoted an over-cap swap"; exit 1; }
  q "$ISSUER_KEY" "$ROUTER" "$(cast calldata "$SWAP_IN" 900000000 0 "[$ASSET,$WRAPPED]" "$ISSUER" $FAR)" 0 400000 0x0
  q "$ISSUER_KEY" "$ASSET" "$(cast calldata "transfer(address,uint256)" "$PAIR" 1000000000)" 0 100000 0x1
  q "$ISSUER_KEY" "$ROUTER" "$(cast calldata "$SWAP_IN" 1000000 0 "[$ASSET,$WRAPPED]" "$ISSUER" $FAR)" 0 400000 0x0
  flush
  note "pending excess at latest: $(cast call "$LENS" "$EXCESS" "$PAIR" --rpc-url "$RPC")"
  [ "$(available 1000000)" = false ] || { echo "FAIL: lens quoted through the blocking donation"; exit 1; }
  log "skim, swap ok, utility contracts, DEX-09 pair"
  SALT=0x$(printf '%064x' 1); INIT=0x600a600c600039600a6000f3602a60005260206000f3
  q "$ISSUER_KEY" "$PAIR" "$(cast calldata "skim(address)" "$ISSUER")" 0 200000 0x1
  q "$ISSUER_KEY" "$ROUTER" "$(cast calldata "$SWAP_IN" 1000000 0 "[$ASSET,$WRAPPED]" "$ISSUER" $FAR)" 0 400000 0x1
  q "$ISSUER_KEY" "$CREATE2" "$SALT${INIT:2}" 0 200000 0x1
  q "$ISSUER_KEY" "$FACTORY" "$(cast calldata "createPair(address,address)" "$ASSET" "$MULTICALL")" 0 3000000 0x1
  flush
  EXPECT=0x$(cast keccak "0xff${CREATE2:2}${SALT:2}$(cast keccak "$INIT" | cut -c3-)" | cut -c27-)
  [ "$(cast to-dec "$(cast call "$EXPECT" --rpc-url "$RPC")")" = 42 ] || { echo "FAIL: CREATE2"; exit 1; }
  AGG=$(cast calldata "aggregate3((address,bool,bytes)[])" "[($MULTICALL,false,$(cast calldata "getChainId()")),($MULTICALL,false,$(cast calldata "getEthBalance(address)" "$BLOCH_INC"))]")
  cast call "$MULTICALL" "$AGG" --rpc-url "$RPC" | grep -q "$(printf '%064x' 700770)" || { echo "FAIL: aggregate3"; exit 1; }
  note "CREATE2 at $EXPECT and aggregate3 ok"
  EMPTY=$(cast call "$FACTORY" "getPair(address,address)(address)" "$ASSET" "$MULTICALL" --rpc-url "$RPC")
  echo "$EMPTY" > "$WORK/empty-pair"
  ;;
fund-user)
  # The browser user gets gas and bUSDC; DEX-09's refused sync on the empty pair rides along.
  state_load
  log "browser user $USER_ADDR: gas and 100 bUSDC; sync refused on the empty pair"
  q "$ISSUER_KEY" "$USER_ADDR" 0x 2000000000000000000 100000 0x1
  q "$ISSUER_KEY" "$ASSET" "$(cast calldata "transfer(address,uint256)" "$USER_ADDR" 100000000)" 0 100000 0x1
  q "$ISSUER_KEY" "$(cat "$WORK/empty-pair")" "$(cast calldata "sync()")" 0 150000 0x0
  flush
  ;;
big-swap)
  # A large swap that only `latest` sees for now.
  state_load
  log "a swap of ${1:-50} bUSDC that moves the pool"
  q "$ISSUER_KEY" "$ROUTER" "$(cast calldata "$SWAP_IN" "${1:-50}000000" 0 "[$ASSET,$WRAPPED]" "$ISSUER" $FAR)" 0 400000 0x1
  flush
  ;;
donate)
  state_load
  log "donation above the cap in the pair"
  q "$ISSUER_KEY" "$ASSET" "$(cast calldata "transfer(address,uint256)" "$PAIR" 1000000000)" 0 100000 0x1
  flush
  ;;
f1)
  # F1: a third party mints to both caps, then both swap directions are tried.
  # Without a contract fix the mint succeeds and swaps revert; with one the mint reverts.
  state_load
  log "F1: third party adds ${1:-1000} bUSDC + ${2:-10} BLCH (up to both caps), then swaps both ways"
  q "$ISSUER_KEY" "$ASSET" "$(cast calldata "approve(address,uint256)" "$ROUTER" 1000000000000)" 0 100000 0x1
  q "$ISSUER_KEY" "$ROUTER" "$(cast calldata "$ADD" "$ASSET" "${1:-1000}000000" 0 0 "$ISSUER" $FAR)" "${2:-10}000000000000000000" 1000000 any
  q "$ISSUER_KEY" "$ROUTER" "$(cast calldata "$SWAP_IN" 1000000 0 "[$ASSET,$WRAPPED]" "$ISSUER" $FAR)" 0 400000 any
  q "$ISSUER_KEY" "$ROUTER" "$(cast calldata "$SWAP_OUT" 0 "[$WRAPPED,$ASSET]" "$ISSUER" $FAR)" 10000000000000000 400000 any
  flush
  note "F1: reserves $(cast call "$PAIR" "getReserves()(uint112,uint112,uint32)" --rpc-url "$RPC" | tr '\n' ' ') caps $(cast call "$PAIR" "reserveCaps()(uint112,uint112)" --rpc-url "$RPC" | tr '\n' ' ')"
  mon_note f1
  ;;
pending-probe)
  # F3, visibility: what does a third party see through the gateway of a transaction in the spool?
  # F3, ordering: the producer orders by effective tip (src/node_execution/select.rs). The attacker
  # only polls the victim's pending nonce, then brackets the swap with a higher and a lower tip.
  state_load
  OUT=$EV/f3-sandwich.txt; : > "$OUT"
  jr() { curl -s -m 20 -H 'content-type: application/json' -H 'origin: https://attacker.example' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" "$GW"; }
  START=$(numtag latest)
  until [ "$(numtag latest)" -gt "$START" ]; do sleep 2; done
  log "F3: a block was just produced, the spool is empty, the window is open"
  V_IN=500000000000000000
  V_QUOTE=$(cast call "$LENS" "$QUOTE" "$V_IN" "[$WRAPPED,$ASSET]" 500 --rpc-url "$RPC")
  echo "victim quote at latest, 5% slippage: $V_QUOTE" >> "$OUT"
  V_MIN=$(node -e 'const m=process.argv[1].match(/^\(\w+, \d+[^,]*, \d+[^,]*, (\d+)[^,]*, (\d+)/);console.log(m[2])' "$V_QUOTE")
  V_NOATTACK=$(node -e 'const m=process.argv[1].match(/^\(\w+, \d+[^,]*, \d+[^,]*, (\d+)/);console.log(m[1])' "$V_QUOTE")
  echo "victim minimum $V_MIN, output with no attack $V_NOATTACK" >> "$OUT"
  VN=$(cast nonce "$USER_ADDR" --block latest --rpc-url "$RPC")
  echo "victim pending nonce before: $(jr eth_getTransactionCount "[\"$USER_ADDR\",\"pending\"]")" >> "$OUT"
  RAWV=$(cast mktx --chain 700770 --nonce "$VN" --gas-limit 400000 --gas-price $MAXFEE --priority-gas-price $TIP --value "$V_IN" --private-key "$USER_KEY" "$ROUTER" "$(cast calldata "$SWAP_OUT" "$V_MIN" "[$WRAPPED,$ASSET]" "$USER_ADDR" $FAR)")
  VH=$(cast keccak "$RAWV"); jr eth_sendRawTransaction "[\"$RAWV\"]" >> "$OUT"; echo >> "$OUT"
  sleep 3
  {
    echo "--- what a third party sees of spooled $VH, through the gateway"
    for c in 'eth_getTransactionCount|["'$USER_ADDR'","pending"]' 'eth_getTransactionCount|["'$USER_ADDR'","latest"]' 'eth_getTransactionByHash|["'$VH'"]' 'eth_getRawTransactionByHash|["'$VH'"]' 'eth_getTransactionReceipt|["'$VH'"]' 'eth_getBlockTransactionCountByNumber|["pending"]' 'eth_pendingTransactions|[]' 'txpool_content|[]' 'txpool_status|[]'; do
      echo "${c%%|*} ${c#*|} => $(jr "${c%%|*}" "${c#*|}" | cut -c1-300)"
    done
    echo "eth_getBlockByNumber pending, tx list => $(jr eth_getBlockByNumber '["pending",true]' | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(JSON.stringify({number:r.result?.number,txs:r.result?.transactions?.length,error:r.error}))')"
    echo "swap quote at pending vs latest (does pending state include the spool?): $(cast call "$LENS" "$QUOTE" 1000000000000000 "[$WRAPPED,$ASSET]" 50 --block pending --rpc-url "$GW" | cut -c1-120) / $(cast call "$LENS" "$QUOTE" 1000000000000000 "[$WRAPPED,$ASSET]" 50 --rpc-url "$GW" | cut -c1-120)"
  } >> "$OUT" 2>&1
  # The attacker: it saw only the nonce. Front at 3 gwei, approve at 3 gwei, back at tip 0.
  AN=$(cast nonce "$DEPLOYER" --block latest --rpc-url "$RPC")
  B0=$(cast balance "$DEPLOYER" --rpc-url "$RPC")
  F_IN=250000000000000000
  F_OUT=$(cast call "$LENS" "$QUOTE" "$F_IN" "[$WRAPPED,$ASSET]" 50 --rpc-url "$RPC" | node -e 'const m=require("fs").readFileSync(0,"utf8").match(/^\(\w+, \d+[^,]*, \d+[^,]*, (\d+)/);console.log(m[1])')
  m() { cast mktx --chain 700770 --nonce "$1" --gas-limit "$2" --gas-price $MAXFEE --priority-gas-price "$3" --value "$4" --private-key "$DEPLOYER_KEY" "$5" "$6"; }
  R1=$(m "$AN" 400000 3000000000 "$F_IN" "$ROUTER" "$(cast calldata "$SWAP_OUT" 0 "[$WRAPPED,$ASSET]" "$DEPLOYER" $FAR)")
  R2=$(m $((AN+1)) 100000 3000000000 0 "$ASSET" "$(cast calldata "approve(address,uint256)" "$ROUTER" "$F_OUT")")
  R3=$(m $((AN+2)) 400000 0 0 "$ROUTER" "$(cast calldata "$SWAP_IN" "$F_OUT" 0 "[$ASSET,$WRAPPED]" "$DEPLOYER" $FAR)")
  H3=$(cast keccak "$R3")
  for r in "$R1" "$R2" "$R3"; do cast publish --async --rpc-url "$RPC" "$r" > /dev/null; done
  echo "attacker sent front (tip 3 gwei), approve, back (tip 0) AFTER the victim, knowing only its pending nonce" >> "$OUT"
  until [ "$(cast rpc eth_getTransactionReceipt "$VH" --rpc-url "$RPC")" != null ] && [ "$(cast rpc eth_getTransactionReceipt "$H3" --rpc-url "$RPC")" != null ]; do sleep 5; done
  for h in "$(cast keccak "$R1")" "$(cast keccak "$R2")" "$VH" "$H3"; do
    cast rpc eth_getTransactionReceipt "$h" --rpc-url "$RPC" | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(process.argv[1], "block", BigInt(r.blockNumber), "index", BigInt(r.transactionIndex), "status", r.status, "gas", BigInt(r.gasUsed))' "$h" >> "$OUT"
  done
  echo "victim bUSDC units got: see Swap log; attacker BLCH before $B0 after $(cast balance "$DEPLOYER" --rpc-url "$RPC")" >> "$OUT"
  cast rpc eth_getTransactionReceipt "$VH" --rpc-url "$RPC" > "$EV/f3-victim-receipt.json"
  cat "$OUT" | tee -a "$EV/steps.log"
  ;;
poll)
  # F4: the UI's receipt poll, every 10 s with the same 20 s timeout, through the real gateway.
  setsid nohup node scripts/staging/e2e-settled/gw-poll.mjs "$GW" "$F/gw-polls.jsonl" < /dev/null > /dev/null 2>&1 &
  echo $! > "$F/gw-poll.pid"
  ;;
poll-summary)
  node -e '
const lines=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n").map(JSON.parse);
const out={polls:lines.length,from:lines[0]?.t,to:lines.at(-1)?.t,byOutcome:{},maxMs:0,bad:[]};
for(const l of lines){out.byOutcome[l.outcome]=(out.byOutcome[l.outcome]??0)+1;out.maxMs=Math.max(out.maxMs,l.ms);if(l.outcome!=="ok")out.bad.push(l)}
out.bad=out.bad.slice(0,40);console.log(JSON.stringify(out,null,1))' "$F/gw-polls.jsonl"
  ;;
ui)
  # node ui.mjs <scene> <device> [args] with the browser and this flow's keys.
  export BROWSER_EXE=$F/tools/browser/browsers/chromium_headless_shell-1194/chrome-linux/headless_shell PLAYWRIGHT_DIR=$F/tools/browser
  export OUT=$EV/ui GW LIVE=http://127.0.0.1:25058 COMMITTED=http://127.0.0.1:25057 USER_ADDR USER_KEY
  export LD_LIBRARY_PATH=$(find "$F/tools/browser/libs" -type f -name '*.so*' -printf '%h\n' | sort -u | paste -sd:)
  exec timeout 21600 node scripts/staging/e2e-settled/ui.mjs "$@"
  ;;
rec-init)
  # New flow on the live L2 reusing a finished flow's Safe, infra and bridge bUSDC (their addresses
  # do not depend on the pair), with fresh DEX deployer, user, first depositor, third party, keeper.
  SRC=$F/${1:?source flow}; [ ! -e "$WORK/keys.json" ] || { echo "$WORK has keys"; exit 1; }
  umask 077; cast wallet new --number 5 --json > "$WORK/new.json"
  node -e '
const s=require(process.argv[1]),n=require(process.argv[2]);
s[1]=n[0];s[9]=n[1];s[10]=n[2];s[11]=n[3];s[12]=n[4];require("fs").writeFileSync(process.argv[3],JSON.stringify(s));' "$SRC/keys.json" "$WORK/new.json" "$WORK/keys.json"
  rm -f "$WORK/new.json"; umask 022
  cp "$SRC/asset" "$SRC/safe.txs.json" "$SRC/infra.txs.json" "$WORK/"
  for f in infra.config.json infra.plan.json infra.hashes.txt safe.config.json safe.plan.json safe.hashes.txt blochinc.json; do cp "$SRC/evidence/$f" "$EV/"; done
  # The real bridge token of the source flow: its keys, plan, record and vault files (the gate and the monitor take them).
  cp "$SRC/bridge/keys.json" "$SRC/bridge/totals" "$WORK/bridge/"
  cp "$SRC"/evidence/busdc*.json "$EV/"
  echo "$WORK ready"
  ;;
rec-fund)
  # Fresh accounts get gas and bUSDC from the issuer: 76 BLCH and 2,100 bUSDC (500 depositor, 1,500 third party, 100
  # user). Run it after `bridge-credit`. The payer is not the Safe bootstrap key: verify-deployment --expect-empty pins
  # that key's nonce to the Safe plan. The third party's largest use is 1,001 bUSDC (failed-approve + grief); with the
  # 4,000 of the stand-in era, the main flow and two derived flows needed 14,899 bUSDC, more than one bridge deposit
  # (10,000 USDC window, 10,000 bUSDC mint bucket per 24 h).
  state_asset=$(cat "$WORK/asset")
  for a in "$DEPLOYER:10" "$DEPOSITOR:20" "$ATTACKER:40" "$USER_ADDR:5" "$KEEPER:1"; do
    q "$ISSUER_KEY" "${a%%:*}" 0x "${a##*:}000000000000000000" 100000 0x1
  done
  q "$ISSUER_KEY" "$state_asset" "$(cast calldata "transfer(address,uint256)" "$DEPOSITOR" 500000000)" 0 100000 0x1
  q "$ISSUER_KEY" "$state_asset" "$(cast calldata "transfer(address,uint256)" "$ATTACKER" "${REC_FUND_THIRD_PARTY:-1500000000}")" 0 100000 0x1
  q "$ISSUER_KEY" "$state_asset" "$(cast calldata "transfer(address,uint256)" "$USER_ADDR" 100000000)" 0 100000 0x1
  flush
  ;;
fill)
  # Third party mints at the pool's ratio up to the k ceiling, then past it; swaps run both ways.
  state_load
  log "ceiling: third party adds ${1:-300} bUSDC + ${2:-3} BLCH, then 10 + 0.1 more (want K_CEILING); swaps both ways still run"
  q "$ATTACKER_KEY" "$ROUTER" "$(cast calldata "$ADD" "$ASSET" "${1:-300}000000" 0 0 "$ATTACKER" $FAR)" "${2:-3}000000000000000000" 1000000 any 3000000000
  q "$ATTACKER_KEY" "$ROUTER" "$(cast calldata "$ADD" "$ASSET" 10000000 0 0 "$ATTACKER" $FAR)" 100000000000000000 1000000 any 3000000000
  q "$ISSUER_KEY" "$ROUTER" "$(cast calldata "$SWAP_IN" 1000000 0 "[$ASSET,$WRAPPED]" "$ISSUER" $FAR)" 0 400000 any
  q "$ISSUER_KEY" "$ROUTER" "$(cast calldata "$SWAP_OUT" 0 "[$WRAPPED,$ASSET]" "$ISSUER" $FAR)" 10000000000000000 400000 any
  flush
  note "ceiling: reserves $(cast call "$PAIR" "getReserves()(uint112,uint112,uint32)" --rpc-url "$RPC" | tr '\n' ' ') excess $(cast call "$LENS" "$EXCESS" "$PAIR" --rpc-url "$RPC")"
  mon_note ceiling --expect-seeded
  ;;
close)
  # L3 of report 61: unrecorded balance past both rooms closes both directions until anyone skims.
  state_load
  log "closing the pair: donation ${1:-200} bUSDC + ${2:-2} WBLCH"
  q "$ATTACKER_KEY" "$WRAPPED" "$(cast calldata "deposit()")" "${2:-2}000000000000000000" 100000 0x1 3000000000
  q "$ATTACKER_KEY" "$WRAPPED" "$(cast calldata "transfer(address,uint256)" "$PAIR" "${2:-2}000000000000000000")" 0 100000 0x1 3000000000
  q "$ATTACKER_KEY" "$ASSET" "$(cast calldata "transfer(address,uint256)" "$PAIR" "${1:-200}000000")" 0 100000 0x1 3000000000
  q "$ISSUER_KEY" "$ROUTER" "$(cast calldata "$SWAP_IN" 1000000 0 "[$ASSET,$WRAPPED]" "$ISSUER" $FAR)" 0 400000 any
  q "$ISSUER_KEY" "$ROUTER" "$(cast calldata "$SWAP_OUT" 0 "[$WRAPPED,$ASSET]" "$ISSUER" $FAR)" 10000000000000000 400000 any
  flush
  note "closed? reserves $(cast call "$PAIR" "getReserves()(uint112,uint112,uint32)" --rpc-url "$RPC" | tr '\n' ' ') excess $(cast call "$LENS" "$EXCESS" "$PAIR" --rpc-url "$RPC")"
  mon_note closed --expect-seeded
  ;;
keeper)
  # The kit's keeper. "dry" sends nothing; "run" sends; prints its JSON and exit status.
  STATE=$WORK/keeper-state.json
  case "${1:?dry|run}" in
    dry) set +e; node scripts/ops/dex-skim-keeper.mjs --config "$EV/gate.json" --rpc "$RPC" --keeper "$KEEPER" --state "$STATE" --max-fee-wei $MAXFEE 2>&1 | tee -a "$EV/keeper.log"; note "keeper dry exit ${PIPESTATUS[0]}" ;;
    run) set +e; node scripts/ops/dex-skim-keeper.mjs --config "$EV/gate.json" --rpc "$RPC" --keeper "$KEEPER" --state "$STATE" --max-fee-wei $MAXFEE --execute -- --private-key "$KEEPER_KEY" 2>&1 | tee -a "$EV/keeper.log"; note "keeper run exit ${PIPESTATUS[0]}" ;;
  esac
  ;;
reopened)
  state_load
  log "after skim: swaps both ways"
  q "$ISSUER_KEY" "$ROUTER" "$(cast calldata "$SWAP_IN" 1000000 0 "[$ASSET,$WRAPPED]" "$ISSUER" $FAR)" 0 400000 0x1
  q "$ISSUER_KEY" "$ROUTER" "$(cast calldata "$SWAP_OUT" 0 "[$WRAPPED,$ASSET]" "$ISSUER" $FAR)" 10000000000000000 400000 0x1
  flush
  note "Safe bUSDC $(cast call "$ASSET" "balanceOf(address)(uint256)" "$BLOCH_INC" --rpc-url "$RPC") WBLCH $(cast call "$WRAPPED" "balanceOf(address)(uint256)" "$BLOCH_INC" --rpc-url "$RPC")"
  mon_note reopened --expect-seeded
  ;;
failed-approve)
  # Report 61 and the kit: a failed approve spends the depositor's nonce 0. Planner and gate must refuse,
  # and the operator must be told what to do. Records the exact words.
  state_load
  log "failed approve: depositor sends an approve with a gas limit that runs out"
  # The third party also funds the depositor for the seed later (tip order: funding first).
  q "$ATTACKER_KEY" "$DEPOSITOR" 0x 6000000000000000000 100000 0x1 3000000000
  q "$ATTACKER_KEY" "$ASSET" "$(cast calldata "transfer(address,uint256)" "$DEPOSITOR" 500000000)" 0 100000 0x1 3000000000
  q "$DEPOSITOR_KEY" "$ASSET" "$(cast calldata "approve(address,uint256)" "$ROUTER" 500000000)" 0 25000 0x0
  flush
  tail -1 "$WORK/last-hashes" > "$WORK/failed-approve-hash"
  note "depositor nonce now $(cast nonce "$DEPOSITOR" --rpc-url "$RPC")"
  set +e
  node scripts/ops/dex-seed-plan.mjs plan --config "$EV/gate.json" --rpc "$RPC" --price 100 --to "$ISSUER" > "$EV/failed-approve.plan.txt" 2>&1; note "seed plan exit $?"
  head -c 1200 "$EV/failed-approve.plan.txt" | tee -a "$EV/steps.log"; echo
  $GATE --config "$EV/gate.json" --safe-plan "$EV/safe.plan.json" --rpc "$RPC" > "$EV/failed-approve.gate.txt" 2>&1; note "gate exit $?"
  head -c 800 "$EV/failed-approve.gate.txt" | tee -a "$EV/steps.log"; echo
  node scripts/ops/dex-monitor.mjs --config "$EV/gate.json" --safe-plan "$EV/safe.plan.json" "${BRIDGE_ARGS[@]}" --rpc "$RPC" --json > "$EV/failed-approve.monitor.json" 2>&1; note "monitor exit $?"
  node scripts/ops/dex-seed-plan.mjs note-tx --config "$EV/gate.json" --rpc "$RPC" --tx "$(cat "$WORK/failed-approve-hash")" > "$EV/failed-approve.note-tx.txt" 2>&1; note "note-tx exit $?: $(head -c 500 "$EV/failed-approve.note-tx.txt")"
  node scripts/ops/dex-seed-plan.mjs plan --config "$EV/gate.json" --rpc "$RPC" --price 100 --to "$ISSUER" > "$EV/failed-approve.plan2.txt" 2>&1; note "plan after note-tx exit $?: $(head -c 400 "$EV/failed-approve.plan2.txt")"
  set -e
  ;;
grief)
  # N1 on real ordering. The griefer learns only the depositor's pending nonce through the gateway
  # (calldata is not visible), and bids a higher tip for a donation just over half the bUSDC cap.
  state_load
  N0=$(cast nonce "$DEPOSITOR" --block latest --rpc-url "$RPC")
  START=$(numtag latest); until [ "$(numtag latest)" -gt "$START" ]; do sleep 2; done
  log "N1: block just produced; griefer watches $DEPOSITOR's pending nonce (latest $N0)"
  (
    until [ "$(cast nonce "$DEPOSITOR" --block pending --rpc-url "$GW")" -gt "$N0" ]; do sleep 1; done
    note "N1: griefer saw the pending nonce move at $(date -u +%T); donates 501 bUSDC, tip 3 gwei"
    q "$ATTACKER_KEY" "$ASSET" "$(cast calldata "transfer(address,uint256)" "$PAIR" 501000000)" 0 100000 0x1 3000000000; flush
    cp "$WORK/last-hashes" "$WORK/grief-hash"
  ) &
  G=$!
  sleep 3
  q "$DEPOSITOR_KEY" "$ASSET" "$(cast calldata "approve(address,uint256)" "$ROUTER" 500000000)" 0 100000 any
  q "$DEPOSITOR_KEY" "$ROUTER" "$(cast calldata "$ADD" "$ASSET" 500000000 0 0 "$ISSUER" $FAR)" 5000000000000000000 1000000 any
  flush
  cp "$WORK/last-hashes" "$WORK/seed-hashes"; wait $G
  for h in $(cat "$WORK/grief-hash" "$WORK/seed-hashes"); do cast rpc eth_getTransactionReceipt "$h" --rpc-url "$RPC" | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(process.argv[1].slice(0,14),"block",BigInt(r.blockNumber),"index",BigInt(r.transactionIndex),"status",r.status)' "$h" | tee -a "$EV/steps.log"; done
  note "pair supply $(cast call "$PAIR" "totalSupply()(uint256)" --rpc-url "$RPC"), excess $(cast call "$LENS" "$EXCESS" "$PAIR" --rpc-url "$RPC")"
  set +e
  for h in $(cat "$WORK/seed-hashes"); do node scripts/ops/dex-seed-plan.mjs note-tx --config "$EV/gate.json" --rpc "$RPC" --tx "$h" > "$EV/grief.note.txt" 2>&1; note "note-tx exit $?: $(head -c 300 "$EV/grief.note.txt")"; done
  node scripts/ops/dex-seed-plan.mjs plan --config "$EV/gate.json" --rpc "$RPC" --price 100 --to "$ISSUER" > "$EV/grief.plan.txt" 2>&1; note "plan with the donation standing, exit $?: $(head -c 400 "$EV/grief.plan.txt")"
  set -e
  log "griefer skims its donation back; depositor seeds again in the same block (griefer's tip wins)"
  q "$ATTACKER_KEY" "$PAIR" "$(cast calldata "skim(address)" "$ATTACKER")" 0 200000 any 3000000000
  q "$DEPOSITOR_KEY" "$ROUTER" "$(cast calldata "$ADD" "$ASSET" 500000000 0 0 "$ISSUER" $FAR)" 5000000000000000000 1000000 any
  flush
  for h in $(cat "$WORK/last-hashes"); do cast rpc eth_getTransactionReceipt "$h" --rpc-url "$RPC" | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(process.argv[1].slice(0,14),"block",BigInt(r.blockNumber),"index",BigInt(r.transactionIndex),"status",r.status)' "$h" | tee -a "$EV/steps.log"; done
  set +e
  node scripts/ops/dex-seed-plan.mjs verify --config "$EV/gate.json" --rpc "$RPC" --price 100 --to "$ISSUER" > "$EV/grief.verify.txt" 2>&1; note "verify exit $?: $(head -c 400 "$EV/grief.verify.txt")"
  set -e
  ;;
budget)
  # Measured from chain state (budget.mjs): every key's bUSDC in, out and lowest balance, its transaction count and
  # BLCH left of the 100 BLCH deposit, the head, and the bursts this flow published (one L2 block each at best).
  state_load
  ACCOUNTS=$(node -e '
const k = require(process.argv[1]); const [pair, safe, bridgeDeployer] = process.argv.slice(2);
const names = ["boot", "deployer", "issuer", "owner0", "owner1", "owner2", "owner3", "owner4", "infra", "user", "depositor", "thirdParty", "keeper"];
const o = Object.fromEntries(k.map((x, i) => [names[i] ?? `key${i}`, x.address.toLowerCase()]));
console.log(JSON.stringify({ ...o, pair, safe, bridgeDeployer }));' "$WORK/keys.json" "$PAIR" "$BLOCH_INC" "$BRIDGE_L2_DEPLOYER")
  node scripts/staging/e2e-settled/budget.mjs --rpc "$RPC" --token "$ASSET" --accounts "$ACCOUNTS" --source issuer --funded-wei 100000000000000000000 > "$EV/budget.json"
  node -e '
const r = require(process.argv[1]); const fs = require("fs");
const bursts = fs.existsSync(process.argv[2]) ? fs.readFileSync(process.argv[2], "utf8").trim().split("\n").map((l) => l.split(" ")) : [];
console.log(`budget: bUSDC needed by ${r.budget.source} ${r.budget.neededUnits} of ${r.budget.creditedUnits} units credited (lowest balance ${r.budget.lowestUnits}); head ${r.head}; ` +
  `${bursts.length} bursts, ${bursts.reduce((n, b) => n + Number(b[1]), 0)} burst transactions`);' "$EV/budget.json" "$EV/bursts.txt" | tee -a "$EV/steps.log"
  ;;
wait-last-final)
  wait_final "$(cat "$WORK/last-block")"
  ;;
wait-final) wait_final "$1" ;;
heads) heads ;;
monitor) mon_note "$@" ;;
ui-prep)
  # Live and committed production builds. The live build reads the production gateway
  # (nginx + njs, CORS open) over the loopback plain listener: the only change to the
  # built files is that origin in `_headers`, and dropping upgrade-insecure-requests.
  log "record and builds"
  [ -e "$EV/frontend.record.json" ] || node scripts/staging/frontend-record.mjs --config "$EV/dex.config.json" --plan "$EV/dex.plan.json" --infra-plan "$EV/infra.plan.json" --gate-report "$EV/gate-report.json" --write "$EV/frontend.record.json"
  GENESIS=$(cast block 0 --field hash --rpc-url "$RPC")
  node -e '
const n = JSON.parse(require("fs").readFileSync("deployments/mainnet/frontend.network.json", "utf8"));
n.genesisHash = process.argv[1]; n.rpc = { url: process.argv[2], status: "live" };
console.log(JSON.stringify(n, null, 2));' "$GENESIS" "$GW" > "$EV/frontend.network.json"
  cd frontend
  npx vite build --outDir "$WORK/dist-committed" --emptyOutDir > "$WORK/build-committed.log" 2>&1
  POSTERN_MAINNET_NETWORK=$EV/frontend.network.json POSTERN_MAINNET_RECORD=$EV/frontend.record.json npx vite build --outDir "$WORK/dist-live" --emptyOutDir > "$WORK/build-live.log" 2>&1
  sed -i "s#https://l2rpc.blochl1.com#$GW#; s#; *upgrade-insecure-requests##" "$WORK/dist-live/_headers"
  cd "$ROOT"
  for p in committed:25057 live:25058; do
    n=${p%%:*}; port=${p##*:}
    [ -f "$WORK/serve-$n.pid" ] && kill "$(cat "$WORK/serve-$n.pid")" 2>/dev/null || true
    setsid nohup node scripts/staging/render/serve.mjs "$WORK/dist-$n" "$port" > "$WORK/serve-$n.log" 2>&1 < /dev/null &
    echo $! > "$WORK/serve-$n.pid"
  done
  log "builds served on 25057 (committed) and 25058 (live)"
  ;;
gw)
  # Production gateway pair; backend B is a replica rebuilt from L1 data only.
  case "${1:?start|stop|refresh-b}" in
    refresh-b)
      python3 - <<'PY'
import os, sys, shutil, time
sys.path.insert(0, os.environ['FS'] + '/src/rehearsal/drills')
import drillctl as d
fs = d.fs; s = fs.state(); rep = d.RUN / 'replica'
d.down('rpcb')
shutil.rmtree(rep, ignore_errors=True)
doc = fs.produce('reconstruct', '--target', rep, '--l1-follower', d.RUN / 'follower', '--timestamp-rule', f"1:{s['genesis_secs_approx']}:{fs.SLOT_MS}")
print('replica rebuilt from L1, head', doc['head'], 'settled', doc['settled'], flush=True)
d.up('rpcb')
PY
      ;;
    start|stop)
      HOME=$HOME_REAL WORK=$F/gateway NJS_SO=$F/ngx/root/usr/lib/nginx/modules/ngx_http_js_module.so A_RPC=127.0.0.1:25020 B_RPC=127.0.0.1:25021 EXTRA="--cors-any" bash "$F/src/public-rpc/tests/pair.sh" "$1"
      ;;
  esac
  ;;
*) echo "unknown $cmd" >&2; exit 2 ;;
esac
