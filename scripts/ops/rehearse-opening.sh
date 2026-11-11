#!/usr/bin/env bash
# The owner's opening, end to end, from a filled opening form, on two loopback anvils with
# throwaway keys generated here (agent 178). Nothing here can reach a public chain.
#
#   "Ethereum": anvil chain 1, a mock USDC and the real ProvenanceSourceVault (mode 1).
#   L2: anvil chain 700770 (plus the anvil finality shim), the real BridgedStablecoinV3 bound to
#   that vault (2-of-3, T = 0, 12 h delay), the Safe, Multicall3/CREATE2 infra and the DEX.
#
# Sequence: infra, Safe, bridge deposit and credit (executed by the relayer, never by the first
# depositor), the opening form filled with example values (P = 100) and applied, the DEX deploy
# with the generated config, the finality gate, the seed through plan --write-txs and
# sign-and-publish.sh, verify, the monitor with the bridge exit check and the floor, a keeper dry
# run. Every transaction file is printed as a table. Section X runs the seeder-exit scenes (A98-5)
# from snapshots: full exit, repricing the dust, a donation fill, the same with a floor kept, and
# the owner's reopening after a full exit.
#
# Agent 227: with the bridge RC (eb5c981 or later) the vault takes the decided 5/5 bps fee to a throwaway
# recipient (minDeposit 11 USDC; the L2 mints the net amount), and the token is the rebuilt V3 (T = 0 rule,
# MAX_PENDING). The gate and the monitor check the token against a bridge plan and record in the shape of the
# bridge's deploy_pontes.py (agent 180 L-3), and refuse a look-alike's record and a record with other signers.
#
#   SAFE_ARTIFACTS=<safe 1.4.1 build/artifacts> BRIDGE_OUT=<bridge forge out/ with BridgedStablecoinV3,
#   ProvenanceSourceVault and its test mock MockStable (a plain `forge build` of the bridge RC)>
#   scripts/ops/rehearse-opening.sh [port] [work]
set -euo pipefail

PORT=${1:-37810}
ETH_PORT=$((PORT + 2))
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
WORK=${2:-$(mktemp -d)}
mkdir -p "$WORK/evidence"
EV=$WORK/evidence
RPC=http://127.0.0.1:$PORT
SHIM=http://127.0.0.1:$((PORT + 1))
ETH=http://127.0.0.1:$ETH_PORT
[ -d "${SAFE_ARTIFACTS:-}/contracts" ] || { echo "SAFE_ARTIFACTS is required" >&2; exit 1; }
[ -f "${BRIDGE_OUT:-}/BridgedStablecoinV3.sol/BridgedStablecoinV3.json" ] || { echo "BRIDGE_OUT is required" >&2; exit 1; }
MAXFEE=5000000000; TIP=1000000000; FUTURE=99999999999; MINT_DELAY_S=43200
PASSES=0
log() { echo "== $*" | tee -a "$EV/steps.log"; }
pass() { PASSES=$((PASSES + 1)); echo "PASS $*" | tee -a "$EV/steps.log"; }
die() { echo "FAIL $*" | tee -a "$EV/steps.log" >&2; exit 1; }
note() { echo "     $*" | tee -a "$EV/steps.log"; }

umask 077
cast wallet new --number 24 --json > "$WORK/keys.json"
umask 022
key() { node -e 'console.log(require(process.argv[1])[Number(process.argv[2])].private_key)' "$WORK/keys.json" "$1"; }
addr() { node -e 'console.log(require(process.argv[1])[Number(process.argv[2])].address.toLowerCase())' "$WORK/keys.json" "$1"; }
BOOT_KEY=$(key 0); BOOT=$(addr 0); INFRA_KEY=$(key 1); INFRA=$(addr 1); DEPLOYER_KEY=$(key 2); DEPLOYER=$(addr 2)
DEPOSITOR_KEY=$(key 3); DEPOSITOR=$(addr 3); LP_KEY=$(key 4); LP=$(addr 4); KEEPER_KEY=$(key 5); KEEPER=$(addr 5)
RELAYER_KEY=$(key 6); RELAYER=$(addr 6); STRANGER_KEY=$(key 7); STRANGER=$(addr 7)
OWNERS=("$(addr 8)" "$(addr 9)" "$(addr 10)" "$(addr 11)" "$(addr 12)")
EUSER_KEY=$(key 17); EUSER=$(addr 17); L2G=$(addr 16); EGUARD=$(addr 21); FEE_TO=$(addr 22)
for i in 13 14 15; do echo "$(addr $i) $(key $i)"; done | sort > "$WORK/l2-signers.txt"
for i in 18 19 20; do echo "$(addr $i) $(key $i)"; done | sort > "$WORK/eth-signers.txt"
FUNDED=("$BOOT" "$INFRA" "$DEPLOYER" "$DEPOSITOR" "$LP" "$KEEPER" "$RELAYER" "$STRANGER")

PIDS=()
cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
trap 'exit 143' TERM INT

forge build > "$WORK/build.log" 2>&1 || { tail -n 30 "$WORK/build.log"; exit 1; }
# The planners' deadlines are wall-clock times: start the L2 one mint delay (plus 10 min) in the past.
anvil --chain-id 700770 --port "$PORT" --host 127.0.0.1 --timestamp $(( $(date +%s) - MINT_DELAY_S - 600 )) --silent > "$WORK/anvil.log" 2>&1 &
PIDS+=($!)
anvil --chain-id 1 --port "$ETH_PORT" --host 127.0.0.1 --silent > "$WORK/anvil-eth.log" 2>&1 &
PIDS+=($!)
node scripts/fixtures/anvil-finality-shim.mjs "$RPC" $((PORT + 1)) > "$WORK/shim.log" 2>&1 &
PIDS+=($!)
for u in "$RPC" "$ETH"; do for _ in $(seq 50); do cast chain-id --rpc-url "$u" > /dev/null 2>&1 && break; sleep 0.2; done; done
sleep 1
for a in "${FUNDED[@]}"; do cast rpc anvil_setBalance "$a" 0x56bc75e2d63100000 --rpc-url "$RPC" > /dev/null; done
cast rpc anvil_setBalance "$EUSER" 0x56bc75e2d63100000 --rpc-url "$ETH" > /dev/null
GENESIS=$(cast block 0 --field hash --rpc-url "$RPC")
log "L2 anvil chain $(cast chain-id --rpc-url "$RPC") genesis $GENESIS; Ethereum anvil chain $(cast chain-id --rpc-url "$ETH")"

# send KEY TO|create DATA VALUE GAS -> "status contractAddress gasUsed hash"
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
  receipt=$(cast rpc eth_getTransactionReceipt "$hash" --rpc-url "$RPC")
  node -e 'const r=JSON.parse(process.argv[1]);console.log(r.status, r.contractAddress ?? "-", BigInt(r.gasUsed).toString(), process.argv[2])' "$receipt" "$hash"
}
must() { local out; out=$(send "$@"); [ "${out%% *}" = 0x1 ] || { cast run "${out##* }" --rpc-url "$RPC" 2>&1 | tail -n 5 >&2; die "transaction reverted: to $2"; }; echo "$out"; }
must_fail() { local out; out=$(send "$@"); [ "${out%% *}" = 0x0 ] || die "transaction succeeded: to $2"; echo "$out"; }
jsonget() { node -e 'const v=process.argv[2].split(".").reduce((o,k)=>o[k],JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")));console.log(typeof v==="object"?JSON.stringify(v):v)' "$1" "$2"; }
expect() {
  local want=$1 name=$2 got=0; shift 2
  "$@" > "$EV/$name.out" 2>&1 || got=$?
  [ "$got" = "$want" ] || { cat "$EV/$name.out" >&2; die "$name exited $got, expected $want"; }
  pass "$name (exit $got)"
}
view() { cast call "$@" --rpc-url "$RPC" | awk '{print $1}'; }
snapshot() { cast rpc evm_snapshot --rpc-url "$RPC" | tr -d '"'; }
restore() { cast rpc evm_revert "$1" --rpc-url "$RPC" > /dev/null; }
settle() { cast rpc anvil_mine 0x60 --rpc-url "$RPC" > /dev/null; }
BAL="balanceOf(address)(uint256)"
# txtable FILE HASHES: one line per transaction, with the gas each one used.
txtable() {
  node -e '
const fs = require("fs");
const t = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const hashes = process.argv[2] && fs.existsSync(process.argv[2]) ? fs.readFileSync(process.argv[2], "utf8").trim().split(/\s+/) : [];
console.log(`file ${require("path").basename(process.argv[1])}: from ${t.from}, chain ${t.chainId}, ${t.transactions.length} tx, configSha256 ${t.configSha256}`);
t.transactions.forEach((x, i) => {
  const name = x.label ?? x.action ?? x.name ?? x.step ?? "?";
  const to = x.to ?? "(create)";
  console.log(`  nonce ${x.nonce}  ${String(name).padEnd(28)} to ${to}  selector ${x.data ? x.data.slice(0, 10) : "-"}  value ${x.value}  gasLimit ${x.gasLimit}  ${hashes[i] ? "hash " + hashes[i] : ""}`);
});' "$1" "${2:-}" | tee -a "$EV/transactions.txt"
  if [ -n "${2:-}" ] && [ -f "$2" ]; then
    for h in $(cat "$2"); do
      cast rpc eth_getTransactionReceipt "$h" --rpc-url "$RPC" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d);console.log(`    ${r.transactionHash.slice(0,18)}… status ${r.status} gasUsed ${BigInt(r.gasUsed)} block ${BigInt(r.blockNumber)}${r.contractAddress?" created "+r.contractAddress:""}`)})' | tee -a "$EV/transactions.txt"
    done
  fi
}
: > "$EV/transactions.txt"

# ---------------------------------------------------------------- 0 infra and Safe (earlier steps of the package)
log "0 infra (Multicall3, CREATE2 deployer)"
node -e 'const c=JSON.parse(require("fs").readFileSync("deployments/mainnet/700770/infra.config.json","utf8"));c.network.genesisHash=process.argv[1];c.deployer.address=process.argv[2];console.log(JSON.stringify(c,null,2))' "$GENESIS" "$INFRA" > "$EV/infra.config.json"
I=(node scripts/staging/deploy-infra.mjs)
"${I[@]}" validate --config "$EV/infra.config.json" > "$EV/infra.validate.json"
"${I[@]}" plan --config "$EV/infra.config.json" --write "$EV/infra.plan.json" > /dev/null
"${I[@]}" txs --config "$EV/infra.config.json" --plan "$EV/infra.plan.json" --write "$EV/infra.txs.json" > /dev/null
scripts/staging/sign-and-publish.sh --txs "$EV/infra.txs.json" --rpc "$RPC" --confirm "$(jsonget "$EV/infra.validate.json" configSha256)" --max-fee-wei $MAXFEE --priority-fee-wei $TIP \
  --hashes-out "$EV/infra.hashes.txt" -- --private-key "$INFRA_KEY" > "$EV/infra.publish.log" 2>&1
txtable "$EV/infra.txs.json" "$EV/infra.hashes.txt"
log "0 Safe (5 owners, 3 of 5)"
OWNERS_JSON=$(printf '"%s",' "${OWNERS[@]}"); OWNERS_JSON="[${OWNERS_JSON%,}]"
node -e 'const c=JSON.parse(require("fs").readFileSync("deployments/mainnet/700770/safe.config.json","utf8"));const [g,b,o]=process.argv.slice(1);c.network.genesisHash=g;c.bootstrap.address=b;c.safe.owners=JSON.parse(o);console.log(JSON.stringify(c,null,2))' "$GENESIS" "$BOOT" "$OWNERS_JSON" > "$EV/safe.config.json"
S=(node scripts/staging/deploy-safe.mjs)
"${S[@]}" validate --config "$EV/safe.config.json" > "$EV/safe.validate.json"
"${S[@]}" plan --config "$EV/safe.config.json" --artifacts "$SAFE_ARTIFACTS" --write "$EV/safe.plan.json" > /dev/null
"${S[@]}" txs --config "$EV/safe.config.json" --artifacts "$SAFE_ARTIFACTS" --plan "$EV/safe.plan.json" --write "$EV/safe.txs.json" > /dev/null
scripts/staging/sign-and-publish.sh --txs "$EV/safe.txs.json" --rpc "$RPC" --confirm "$(jsonget "$EV/safe.validate.json" configSha256)" --max-fee-wei $MAXFEE --priority-fee-wei $TIP \
  --hashes-out "$EV/safe.hashes.txt" -- --private-key "$BOOT_KEY" > "$EV/safe.publish.log" 2>&1
txtable "$EV/safe.txs.json" "$EV/safe.hashes.txt"
"${S[@]}" blochinc --plan "$EV/safe.plan.json" > "$EV/blochinc.json"
SAFE=$(jsonget "$EV/blochinc.json" address | tr A-F a-f)
note "Bloch Inc Safe $SAFE"

# ---------------------------------------------------------------- 1 bridge: vault, V3 token, the seed's bUSDC
log "1 bridge: ProvenanceSourceVault on Ethereum, BridgedStablecoinV3 on the L2"
ecreate() { # KEY ARTIFACT CTOR_HEX -> address on Ethereum
  local init; init=$(node -e 'console.log(require(process.argv[1]).bytecode.object)' "$2")$3
  cast send --private-key "$1" --rpc-url "$ETH" --json --create "$init" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).contractAddress.toLowerCase()))'
}
# The six-decimal mock USDC: agent 178's scratch mock if the out/ has it, else the bridge repository's own test mock
# (same mintTo / approve / transfer / transferFrom surface), so a plain `forge build` of the bridge RC is enough.
USDC_ART="$BRIDGE_OUT/MockUsdcA178.sol/MockUsdcA178.json"
[ -f "$USDC_ART" ] || USDC_ART="$BRIDGE_OUT/BridgedStablecoin.t.sol/MockStable.json"
[ -f "$USDC_ART" ] || die "BRIDGE_OUT has no mock USDC (MockUsdcA178 or the bridge's MockStable)"
USDC=$(ecreate "$EUSER_KEY" "$USDC_ART" "")
ESIGNERS="[$(awk '{print $1}' "$WORK/eth-signers.txt" | paste -sd, -)]"
LSIGNERS="[$(awk '{print $1}' "$WORK/l2-signers.txt" | paste -sd, -)]"
VAULT_ART="$BRIDGE_OUT/ProvenanceSourceVault.sol/ProvenanceSourceVault.json"
HAS_FEE=$(node -e 'const a=require(process.argv[1]);console.log(a.abi.some((f)=>f.name==="depositFeeBps")?1:0)' "$VAULT_ART")
if [ "$HAS_FEE" = 1 ]; then
  # The decided launch fee (agent 197, owner 2026-11-02): 5 bps on deposit and on release, minDeposit 11 USDC.
  FEE_BPS=5
  VCTOR=$(cast abi-encode "c(bytes32,bytes32,bytes32,address,uint64,uint8,address[],uint8,(uint64,uint64,uint8,uint64,uint64,uint64),(address[],uint64,uint64),(uint8,uint64,address,(address,uint16,uint16)))" \
    "$(cast keccak ethereum-mainnet)" "$(cast keccak bloch-l2-700770)" "$(cast keccak USDC)" "$USDC" 100000000000 0 "$ESIGNERS" 2 "(10000000000,86400,3,1209600,11000000,10000000)" "([$EGUARD],259200,259200)" "(1,0,0x0000000000000000000000000000000000000000,($FEE_TO,$FEE_BPS,$FEE_BPS))" | cut -c3-)
else
  FEE_BPS=0
  VCTOR=$(cast abi-encode "c(bytes32,bytes32,bytes32,address,uint64,uint8,address[],uint8,(uint64,uint64,uint8,uint64,uint64,uint64),(address[],uint64,uint64),(uint8,uint64,address))" \
    "$(cast keccak ethereum-mainnet)" "$(cast keccak bloch-l2-700770)" "$(cast keccak USDC)" "$USDC" 100000000000 0 "$ESIGNERS" 2 "(10000000000,86400,3,1209600,10000000,10000000)" "([$EGUARD],259200,259200)" "(1,0,0x0000000000000000000000000000000000000000)" | cut -c3-)
fi
VAULT=$(ecreate "$EUSER_KEY" "$VAULT_ART" "$VCTOR")
ROUTE=$(cast call "$VAULT" "routeId()(bytes32)" --rpc-url "$ETH")
VALID=$(( $(date +%s) + 3600 ))
DIG=$(cast call "$VAULT" "controlDigest(bool,bool,uint64,uint256)(bytes32)" true true 0 "$VALID" --rpc-url "$ETH")
ESIGS="[$(head -n 2 "$WORK/eth-signers.txt" | while read -r _ k; do cast wallet sign --no-hash --private-key "$k" "$DIG"; done | paste -sd, -)]"
cast send "$VAULT" "setControls(bool,bool,uint64,uint256,bytes[])" true true 0 "$VALID" "$ESIGS" --private-key "$EUSER_KEY" --rpc-url "$ETH" > /dev/null
VAULT_CODE=$(cast keccak "$(cast code "$VAULT" --rpc-url "$ETH")")
USD_BUCKET=10000000000
TCTOR=$(cast abi-encode "c(string,string,uint256,address,bytes32,address[],uint256,(uint256,uint256,uint256,uint256,uint256,uint256),(address[],uint256,uint256),(uint256,uint64))" \
  "Bridged USDC" bUSDC 1 "$VAULT" "$ROUTE" "$LSIGNERS" 2 "(100000000000,$USD_BUCKET,115740,0,$MINT_DELAY_S,10000000)" "([$L2G],259200,259200)" "(3,1209600)" | cut -c3-)
TOKEN_INIT=$(node -e 'console.log(require(process.argv[1]).bytecode.object)' "$BRIDGE_OUT/BridgedStablecoinV3.sol/BridgedStablecoinV3.json")$TCTOR
USD_TX=$(must "$RELAYER_KEY" create "$TOKEN_INIT" 0 5000000)
USD=$(echo "$USD_TX" | awk '{print tolower($2)}')
USD_CODE=$(cast keccak "$(cast code "$USD" --rpc-url "$RPC")")
[ "$(cast call "$USD" "MAX_PENDING()(uint256)" --rpc-url "$RPC" 2>/dev/null | awk '{print $1}')" = 2048 ] || die "BRIDGE_OUT is not the rebuilt V3 token (no MAX_PENDING = 2048)"
# A V3 token at T > 0 is refused by its own constructor (owner decision 2026-11-02).
TCTOR_T=$(cast abi-encode "c(string,string,uint256,address,bytes32,address[],uint256,(uint256,uint256,uint256,uint256,uint256,uint256),(address[],uint256,uint256),(uint256,uint64))" \
  "Bridged USDC" bUSDC 1 "$VAULT" "$ROUTE" "$LSIGNERS" 2 "(100000000000,$USD_BUCKET,115740,1000000000,$MINT_DELAY_S,10000000)" "([$L2G],259200,259200)" "(3,1209600)" | cut -c3-)
must_fail "$RELAYER_KEY" create "$(node -e 'console.log(require(process.argv[1]).bytecode.object)' "$BRIDGE_OUT/BridgedStablecoinV3.sol/BridgedStablecoinV3.json")$TCTOR_T" 0 5000000 > /dev/null
pass "bridge: the rebuilt V3 refuses T = 1,000 USDC in its constructor; MAX_PENDING() = 2048"
# bridge_plan_record TOKEN TX_HASH SIGNERS_FILE OUT_PREFIX: the token's plan and record in the shape deploy_pontes.py writes
# (plan --write, record --write). On mainnet these come from the bridge deployment itself; here they are made from the
# rehearsal's own constructor values, so the gate can compare the chain with them.
bridge_plan_record() {
  local token=$1 tx=$2 signers=$3 out=$4 receipt code
  receipt=$(cast rpc eth_getTransactionReceipt "$tx" --rpc-url "$RPC")
  code=$(cast code "$token" --rpc-url "$RPC")
  node -e '
const fs = require("fs");
const [art, token, receipt, code, signers, guardian, vault, route, delay, genesis, initHash, out] = process.argv.slice(1);
const a = JSON.parse(fs.readFileSync(art, "utf8")); const r = JSON.parse(receipt);
const { keccak256 } = require(require("path").resolve("frontend/node_modules/viem"));
const configSha256 = keccak256(Buffer.from(`rehearsal ${token}`));
const runtimeCodeHash = keccak256(code);
const plan = { domain: "bloch.bridge.mainnet-deploy.v1", bridge: "stable", configSha256, chain: { id: 700770, genesisHash: genesis, rehearsal: true },
  source: { revision: "rehearsal", compiler: { solc: a.metadata.compiler.version, optimizer: a.metadata.settings.optimizer, evmVersion: a.metadata.settings.evmVersion } },
  contract: { name: "BridgedStablecoinV3", source: "contracts/stable/BridgedStablecoinV3.sol", address: token, initCodeHash: initHash, runtimeCodeHash },
  expected: { name: "Bridged USDC", symbol: "bUSDC", decimals: 6, threshold: 2, signers: fs.readFileSync(signers, "utf8").trim().split(/\n/).map((l) => l.split(" ")[0].toLowerCase()),
    guardians: [guardian], pauseDuration: 259200, pauseCooldown: 259200, supplyCap: 100000000000, bucketCapacity: 10000000000, refillPerSecond: 115740,
    largeMintThreshold: 0, largeMintDelay: Number(delay), minBurn: 10000000, sourceChainId: 1, sourceVault: vault, sourceRoute: route,
    switchThreshold: 3, switchDelay: 1209600, cancelQuorum: 1 } };
const record = { domain: plan.domain, bridge: "stable", configSha256, chainId: 700770, genesisHash: genesis, contract: "BridgedStablecoinV3", address: token,
  runtimeCodeHash, initCodeHash: initHash, transactionHash: r.transactionHash, blockNumber: Number(BigInt(r.blockNumber)), blockHash: r.blockHash };
fs.writeFileSync(`${out}.plan.json`, JSON.stringify(plan, null, 2)); fs.writeFileSync(`${out}.record.json`, JSON.stringify(record, null, 2));
' "$BRIDGE_OUT/BridgedStablecoinV3.sol/BridgedStablecoinV3.json" "$token" "$receipt" "$code" "$signers" "$L2G" "$VAULT" "$ROUTE" "$MINT_DELAY_S" "$GENESIS" "${5}" "$out"
}
bridge_plan_record "$USD" "${USD_TX##* }" "$WORK/l2-signers.txt" "$EV/busdc" "$(cast keccak "$TOKEN_INIT")"
BRIDGE_ARGS=(--bridge-plan "$EV/busdc.plan.json" --bridge-record "$EV/busdc.record.json")
# A look-alike: the same constructor except the committee (3 other keys). Same code hash as the real token.
for i in 22 23 18; do echo "$(addr $i) $(key $i)"; done | sort > "$WORK/fake-signers.txt"
FSIGNERS="[$(awk '{print $1}' "$WORK/fake-signers.txt" | paste -sd, -)]"
FAKE_INIT=$(node -e 'console.log(require(process.argv[1]).bytecode.object)' "$BRIDGE_OUT/BridgedStablecoinV3.sol/BridgedStablecoinV3.json")$(cast abi-encode "c(string,string,uint256,address,bytes32,address[],uint256,(uint256,uint256,uint256,uint256,uint256,uint256),(address[],uint256,uint256),(uint256,uint64))" \
  "Bridged USDC" bUSDC 1 "$VAULT" "$ROUTE" "$FSIGNERS" 2 "(100000000000,$USD_BUCKET,115740,0,$MINT_DELAY_S,10000000)" "([$L2G],259200,259200)" "(3,1209600)" | cut -c3-)
FAKE_TX=$(must "$STRANGER_KEY" create "$FAKE_INIT" 0 5000000)
FAKE=$(echo "$FAKE_TX" | awk '{print tolower($2)}')
[ "$(cast keccak "$(cast code "$FAKE" --rpc-url "$RPC")")" = "$USD_CODE" ] || die "the look-alike should have the real token's code hash"
bridge_plan_record "$FAKE" "${FAKE_TX##* }" "$WORK/fake-signers.txt" "$WORK/fake" "$(cast keccak "$FAKE_INIT")"
pass "bridge: a look-alike bUSDC with another committee has the same runtime code hash ($USD_CODE)"
note "mock USDC $USDC, vault $VAULT (code $VAULT_CODE), BridgedStablecoinV3 $USD (code $USD_CODE)"
l2sigs() { local out=0x; while read -r _ k; do out+=$(cast wallet sign --no-hash "$1" --private-key "$k" | cut -c3-); done < <(head -n 2 "$WORK/l2-signers.txt"); echo "$out"; }
gross_for() { # NET: the smallest deposit whose net after the vault's deposit fee is NET
  node -e 'const [n,b]=process.argv.slice(1).map(BigInt);let g=b===0n?n:(n*10000n+9999n-b)/(10000n-b);while(g-(g*b)/10000n>n)g--;while(g-(g*b)/10000n<n)g++;if(g-(g*b)/10000n!==n)process.exit(1);console.log(g.toString())' "$1" "$FEE_BPS"
}
bridge_in() { # NET L2RECIPIENT: a real vault deposit (gross, less the fee), the committee's mint of the net, the relayer's execute after the delay
  local gross; gross=$(gross_for "$1")
  cast send "$USDC" "mintTo(address,uint256)" "$EUSER" "$gross" --private-key "$EUSER_KEY" --rpc-url "$ETH" > /dev/null
  cast send "$USDC" "approve(address,uint256)" "$VAULT" "$gross" --private-key "$EUSER_KEY" --rpc-url "$ETH" > /dev/null
  local nonce id dig
  nonce=$(cast call "$VAULT" "depositCount()(uint64)" --rpc-url "$ETH")
  cast send "$VAULT" "deposit(uint64,bytes32)" "$gross" "0x000000000000000000000000${2#0x}" --private-key "$EUSER_KEY" --rpc-url "$ETH" > /dev/null
  id=$(cast call "$VAULT" "depositId(uint64,address,uint64,bytes32)(bytes32)" "$nonce" "$EUSER" "$1" "0x000000000000000000000000${2#0x}" --rpc-url "$ETH")
  dig=$(cast call "$USD" "mintDigest(bytes32,uint64,uint64,address)(bytes32)" "$id" "$nonce" "$1" "$2" --rpc-url "$RPC")
  must "$RELAYER_KEY" "$USD" "$(cast calldata "mint(bytes32,uint64,uint64,address,bytes)" "$id" "$nonce" "$1" "$2" "$(l2sigs "$dig")")" 0 400000 > /dev/null
  echo "$id"
}
# Seed bUSDC to the first depositor (kit: a day ahead, executed by the relayer, never by key 8a), and some to a stranger.
SEED_ID=$(bridge_in 600000000 "$DEPOSITOR")
STR_ID=$(bridge_in 2000000000 "$STRANGER")
[ "$(view "$USD" "$BAL" "$DEPOSITOR")" = 0 ] || die "a V3 mint at T = 0 credited at once"
cast rpc anvil_mine 0x48 --rpc-url "$ETH" > /dev/null
cast rpc evm_increaseTime $((MINT_DELAY_S + 100)) --rpc-url "$RPC" > /dev/null; cast rpc evm_mine --rpc-url "$RPC" > /dev/null
must "$RELAYER_KEY" "$USD" "$(cast calldata "executeMint(bytes32)" "$SEED_ID")" 0 1500000 > /dev/null
# executeMint credits every due mint at the head of the queue, so the second one may be done already.
[ "$(view "$USD" "$BAL" "$STRANGER")" != 0 ] || must "$RELAYER_KEY" "$USD" "$(cast calldata "executeMint(bytes32)" "$STR_ID")" 0 1500000 > /dev/null
[ "$(view "$USD" "$BAL" "$DEPOSITOR")" = 600000000 ] || die "the seed bUSDC did not credit"
[ "$(cast nonce "$DEPOSITOR" --rpc-url "$RPC")" = 0 ] || die "the depositor key was used"
pass "bridge: 600 bUSDC credited to the first depositor by the relayer after the 12 h delay; depositor nonce still 0"
if [ "$HAS_FEE" = 1 ]; then
  FEES=$(( $(gross_for 600000000) - 600000000 + $(gross_for 2000000000) - 2000000000 ))
  ev() { cast call "$VAULT" "$1" --rpc-url "$ETH" | awk '{print $1}'; }
  [ "$(ev "feesAccrued()(uint64)")" = "$FEES" ] || die "vault fees $(ev "feesAccrued()(uint64)") != $FEES"
  [ "$(ev "totalLocked()(uint64)")" = 2600000000 ] || die "the vault does not lock the net amounts"
  [ "$(cast call "$USDC" "balanceOf(address)(uint256)" "$VAULT" --rpc-url "$ETH" | awk '{print $1}')" = $((2600000000 + FEES)) ] || die "vault USDC != locked + fees"
  [ "$(view "$USD" "totalSupply()(uint256)")" = 2600000000 ] || die "the L2 minted more than the net"
  cast send "$VAULT" "sweepFees()" --private-key "$EUSER_KEY" --rpc-url "$ETH" > /dev/null
  [ "$(cast call "$USDC" "balanceOf(address)(uint256)" "$FEE_TO" --rpc-url "$ETH" | awk '{print $1}')" = "$FEES" ] || die "sweepFees did not pay the recipient"
  pass "bridge fee: 5 bps of each deposit kept by the vault ($FEES units), the L2 minted the net (2600 bUSDC), sweepFees paid the immutable recipient"
fi

# ---------------------------------------------------------------- 2 the owner's form
log "2 the opening form, filled with example values"
FORM=$EV/opening-form.example.json
node -e '
const f = JSON.parse(require("fs").readFileSync("deployments/mainnet/opening-form.json", "utf8"));
const [dep, lp, keeper, deployer, owners, token, code, eth, vault, vcode, rpc] = process.argv.slice(1);
Object.assign(f, { openingPrice: "100", busdcCap: "auto", firstDepositor: dep, lpRecipient: lp });
f.seederExit = { policy: "keep-floor", floorBps: 1000 };
Object.assign(f.keeper, { address: keeper, keystore: "/etc/bloch-dex-ops/keeper.keystore", passwordFile: "/etc/bloch-dex-ops/keeper.password" });
f.bridgeStatus = { ethRpcUrl: eth, vault, vaultCodeHash: vcode };
f.site = { rpcUrl: rpc, rpcStatus: "live", explorerUrl: null, depositUrl: null, withdrawUrl: null, docsUrl: null };
f.fromEarlierSteps = { dexDeployer: deployer, safeOwners: JSON.parse(owners), busdcToken: token, busdcCodeHash: code, busdcBucketCapacity: "10000000000" };
console.log(JSON.stringify(f, null, 2));' "$DEPOSITOR" "$LP" "$KEEPER" "$DEPLOYER" "$OWNERS_JSON" "$USD" "$USD_CODE" "$ETH" "$VAULT" "$VAULT_CODE" "$RPC" > "$FORM"
F=(node scripts/ops/opening-form.mjs)
expect 2 form-template-refused "${F[@]}" check --form deployments/mainnet/opening-form.json
node -e 'const f=JSON.parse(require("fs").readFileSync(process.argv[1]));f.keeper.address=f.firstDepositor;console.log(JSON.stringify(f))' "$FORM" > "$WORK/form-bad-keeper.json"
expect 2 form-depositor-is-keeper "${F[@]}" check --form "$WORK/form-bad-keeper.json" --bloch-inc "$EV/blochinc.json" --genesis "$GENESIS"
grep -q 'firstDepositor equals keeper.address' "$EV/form-depositor-is-keeper.out" || die "depositor = keeper not named"
node -e 'const f=JSON.parse(require("fs").readFileSync(process.argv[1]));f.openingPrice="50";f.busdcCap="1000";console.log(JSON.stringify(f))' "$FORM" > "$WORK/form-bad-cap.json"
expect 2 form-cap-too-high "${F[@]}" check --form "$WORK/form-bad-cap.json" --bloch-inc "$EV/blochinc.json" --genesis "$GENESIS"
grep -q 'too high for the opening price' "$EV/form-cap-too-high.out" || die "the cap band was not applied"
node -e 'const f=JSON.parse(require("fs").readFileSync(process.argv[1]));f.fromEarlierSteps.busdcCodeHash="0x"+"11".repeat(32);console.log(JSON.stringify(f))' "$FORM" > "$WORK/form-bad-code.json"
expect 2 form-wrong-token-code "${F[@]}" check --form "$WORK/form-bad-code.json" --bloch-inc "$EV/blochinc.json" --genesis "$GENESIS" --rpc "$RPC" --eth-rpc "$ETH"
pass "form: the unfilled template, depositor = keeper, cap 1000 at P = 50 and a wrong token code hash are refused"
expect 0 form-apply "${F[@]}" apply --form "$FORM" --bloch-inc "$EV/blochinc.json" --out "$EV/applied" --genesis "$GENESIS" --rpc "$RPC" --eth-rpc "$ETH"
pass "form: applied ($(jsonget "$EV/applied/opening.json" seed.human), floor $(jsonget "$EV/applied/opening.json" seederExit.floorShares) shares)"
FLOOR=$(jsonget "$EV/applied/opening.json" seederExit.floorShares)
PRICE=100

# ---------------------------------------------------------------- 3 DEX deploy from the generated config
log "3 DEX: validate, plan, txs, sign-and-publish --plan, record, verify-deployment"
D=(node scripts/staging/deploy-dex.mjs)
"${D[@]}" validate --config "$EV/applied/dex-mainnet.config.json" > "$EV/dex.validate.json"
[ "$(jsonget "$EV/dex.validate.json" configSha256)" = "$(jsonget "$EV/applied/opening.json" dexConfigSha256)" ] || die "the form's config hash differs from deploy-dex validate"
"${D[@]}" plan --config "$EV/applied/dex-mainnet.config.json" --write "$EV/dex.plan.json" > /dev/null
"${D[@]}" txs --config "$EV/applied/dex-mainnet.config.json" --plan "$EV/dex.plan.json" --write "$EV/dex.txs.json" > /dev/null
scripts/staging/sign-and-publish.sh --txs "$EV/dex.txs.json" --rpc "$RPC" --confirm "$(jsonget "$EV/dex.validate.json" configSha256)" --max-fee-wei $MAXFEE --priority-fee-wei $TIP \
  --plan "$EV/dex.plan.json" --hashes-out "$EV/dex.hashes.txt" -- --private-key "$DEPLOYER_KEY" > "$EV/dex.publish.log" 2>&1
txtable "$EV/dex.txs.json" "$EV/dex.hashes.txt"
"${D[@]}" record --config "$EV/applied/dex-mainnet.config.json" --plan "$EV/dex.plan.json" --rpc "$RPC" --tx-hashes "$EV/dex.hashes.txt" --write "$EV/gate.json" > /dev/null
VD=(node scripts/staging/verify-deployment.mjs --safe-plan "$EV/safe.plan.json" --dex-plan "$EV/dex.plan.json" --infra-plan "$EV/infra.plan.json" --rpc "$RPC" --safe-hashes "$EV/safe.hashes.txt" --dex-hashes "$EV/dex.hashes.txt" --infra-hashes "$EV/infra.hashes.txt" --expect-empty)
expect 0 verify-deployment-latest "${VD[@]}"
ROUTER=$(jsonget "$EV/dex.plan.json" contracts.router.address); WRAPPED=$(jsonget "$EV/dex.plan.json" contracts.wrappedNative.address); PAIR=$(jsonget "$EV/dex.plan.json" pairs.0.address)
note "pair $PAIR router $ROUTER WBLCH $WRAPPED"

log "4 finality gate (generic gate behind the anvil shim; anvil genesis is not the mainnet pin)"
expect 1 gate-before-finality node scripts/staging/check-finality-gate.mjs --rehearsal-chain --config "$EV/gate.json" --rpc "$SHIM" "${BRIDGE_ARGS[@]}"
cast rpc anvil_mine 0x80 --rpc-url "$RPC" > /dev/null
expect 0 gate-after-finality node scripts/staging/check-finality-gate.mjs --rehearsal-chain --config "$EV/gate.json" --rpc "$SHIM" "${BRIDGE_ARGS[@]}"
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const b=r.bridgeTokens[0];console.log("     bridge token", b.address, "template", b.template, "threshold", b.threshold, "of", b.signers.length, "switch", b.switchThreshold, "guardians", b.guardians.length, "T", b.largeMintThreshold, "MAX_PENDING", b.maxPending)' "$EV/gate-after-finality.out" | tee -a "$EV/steps.log"
# L-3: the record of a look-alike (same code hash, other committee) does not match the gate's token ...
expect 1 gate-lookalike-record node scripts/staging/check-finality-gate.mjs --rehearsal-chain --config "$EV/gate.json" --rpc "$SHIM" --bridge-plan "$WORK/fake.plan.json" --bridge-record "$WORK/fake.record.json"
grep -q 'does not pin the recorded token' "$EV/gate-lookalike-record.out" || die "look-alike record not named"
# ... and a record whose committee differs from the token on chain is refused at the finalized block.
node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1]));p.expected.signers=fs.readFileSync(process.argv[2],"utf8").trim().split("\n").map((l)=>l.split(" ")[0].toLowerCase());fs.writeFileSync(process.argv[3],JSON.stringify(p))' "$EV/busdc.plan.json" "$WORK/fake-signers.txt" "$WORK/other-signers.plan.json"
expect 1 gate-other-signers node scripts/staging/check-finality-gate.mjs --rehearsal-chain --config "$EV/gate.json" --rpc "$SHIM" --bridge-plan "$WORK/other-signers.plan.json" --bridge-record "$EV/busdc.record.json"
grep -q 'signers() differ from the bridge plan' "$EV/gate-other-signers.out" || die "other signers not named"
node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1]));p.expected.largeMintThreshold=1000000000;fs.writeFileSync(process.argv[2],JSON.stringify(p))' "$EV/busdc.plan.json" "$WORK/t-plan.json"
expect 1 gate-t-above-zero node scripts/staging/check-finality-gate.mjs --rehearsal-chain --config "$EV/gate.json" --rpc "$SHIM" --bridge-plan "$WORK/t-plan.json" --bridge-record "$EV/busdc.record.json"
grep -q 'must be 0' "$EV/gate-t-above-zero.out" || die "T > 0 not named"
pass "L-3: the gate takes the token's identity from the bridge record: a look-alike's record, other signers and T > 0 are refused"
expect 0 verify-deployment-finalized "${VD[@]}" --at finalized

MON=(node scripts/ops/dex-monitor.mjs --config "$EV/gate.json" --rpc "$SHIM" --rehearsal "${BRIDGE_ARGS[@]}" --eth-rpc "$ETH" --bridge-vault "$VAULT" --bridge-vault-code-hash "$VAULT_CODE" --bridge-token "$USD")
SEEDED=(--expect-seeded --lp-recipient "$LP" --lp-min-shares "$FLOOR")
expect 0 monitor-preseed "${MON[@]}"

# ---------------------------------------------------------------- 5 the seed
log "5 seed: plan --write-txs, sign-and-publish.sh with the depositor key, verify"
SP=(node scripts/ops/dex-seed-plan.mjs)
expect 0 seed-plan "${SP[@]}" plan --config "$EV/gate.json" --rpc "$SHIM" --price $PRICE --to "$LP" --fraction-bps 5000 --deadline-min 120 --write-txs "$EV/seed.txs.json"
txtable "$EV/seed.txs.json"
[ "$(jsonget "$EV/seed-plan.out" expectedLiquidity)" = "$(jsonget "$EV/applied/opening.json" seed.expectedShares)" ] || die "the form's expected shares differ from the planner's"
pass "seed plan: the form's seed and share count equal the planner's ($(jsonget "$EV/seed-plan.out" expectedLiquidity) shares)"
SEED_CONFIRM=$(jsonget "$EV/seed-plan.out" txsFile.configSha256)
expect 1 seed-wrong-signer scripts/staging/sign-and-publish.sh --txs "$EV/seed.txs.json" --rpc "$RPC" --confirm "$SEED_CONFIRM" --max-fee-wei $MAXFEE --priority-fee-wei $TIP --hashes-out "$WORK/seed-wrong.hashes" -- --private-key "$LP_KEY"
expect 0 seed-sign-and-publish scripts/staging/sign-and-publish.sh --txs "$EV/seed.txs.json" --rpc "$RPC" --confirm "$SEED_CONFIRM" --max-fee-wei $MAXFEE --priority-fee-wei $TIP --hashes-out "$EV/seed.hashes.txt" -- --private-key "$DEPOSITOR_KEY"
txtable "$EV/seed.txs.json" "$EV/seed.hashes.txt"
[ "$(cast nonce "$DEPOSITOR" --rpc-url "$RPC")" = 2 ] || die "the first depositor must send exactly two transactions"
pass "the first depositor sent the approve and the seed, nothing else"
expect 0 seed-verify "${SP[@]}" verify --config "$EV/gate.json" --rpc "$SHIM" --price $PRICE --to "$LP"
settle
expect 0 seed-verify-finalized "${SP[@]}" verify --config "$EV/gate.json" --rpc "$SHIM" --price $PRICE --to "$LP"
SHARES=$(view "$PAIR" "$BAL" "$LP")
note "LP recipient holds $SHARES shares; totalSupply $(view "$PAIR" "totalSupply()(uint256)"); floor $FLOOR"
expect 0 monitor-seeded "${MON[@]}" "${SEEDED[@]}" --ref-price $PRICE --json
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const c of r.checks.filter(c=>/bridge_exit|lp_|closed|reserve_cap/.test(c.name)))console.log("     ",c.name,["OK","WARN","CRIT","UNKNOWN"][c.level],c.detail)' "$EV/monitor-seeded.out" | tee -a "$EV/steps.log"
KP=(node scripts/ops/dex-skim-keeper.mjs --config "$EV/gate.json" --rpc "$SHIM" --keeper "$KEEPER" --state "$WORK/keeper-state.json" --budget-wei 50000000000000000 --max-tx 48 --eth-rpc "$ETH" --bridge-vault "$VAULT")
expect 0 keeper-dry-run "${KP[@]}"
SNAP_SEEDED=$(snapshot)

# ---------------------------------------------------------------- X seeder exit (A98-5)
APPROVE="approve(address,uint256)"
REMOVE="removeLiquidityBLCH(address,uint256,uint256,uint256,address,uint256)"
ADD="addLiquidityBLCH(address,uint256,uint256,uint256,address,uint256)"
TRANSFER="transfer(address,uint256)"
state() { # LABEL: one line of pair state
  local r; r=$(cast call "$PAIR" "getReserves()(uint112,uint112,uint32)" --rpc-url "$RPC" | awk '{print $1}' | paste -sd' ' -)
  local t0; t0=$(cast call "$PAIR" "token0()(address)" --rpc-url "$RPC" | tr A-F a-f)
  note "$1: token0 $([ "$t0" = "$USD" ] && echo bUSDC || echo WBLCH), reserves $r, totalSupply $(view "$PAIR" "totalSupply()(uint256)"), LP $(view "$PAIR" "$BAL" "$LP"), Safe $(view "$PAIR" "$BAL" "$SAFE"), locked $(view "$PAIR" "$BAL" 0x0000000000000000000000000000000000000000)"
}
exit_lp() { # SHARES: the LP recipient removes SHARES through the router
  must "$LP_KEY" "$PAIR" "$(cast calldata "$APPROVE" "$ROUTER" "$1")" 0 100000 > /dev/null
  must "$LP_KEY" "$ROUTER" "$(cast calldata "$REMOVE" "$USD" "$1" 0 0 "$LP" $FUTURE)" 0 400000
}
T0IS=$( [ "$(cast call "$PAIR" "token0()(address)" --rpc-url "$RPC" | tr A-F a-f)" = "$USD" ] && echo usd || echo wrapped)
reserves_usd_w() { # prints "usdReserve wrappedReserve"
  local a b; read -r a b < <(cast call "$PAIR" "getReserves()(uint112,uint112,uint32)" --rpc-url "$RPC" | awk 'NR<3{print $1}' | paste -sd' ' -)
  if [ "$T0IS" = usd ]; then echo "$a $b"; else echo "$b $a"; fi
}
price_of() { read -r u w < <(reserves_usd_w); node -e 'const [u,w]=process.argv.slice(1).map(BigInt);console.log(w===0n?"inf":(Number(u*10n**18n/w)/1e6).toPrecision(6))' "$u" "$w"; }

log "X1 full exit: the LP recipient removes every share, with no trading before (no protocol-fee shares)"
state "seeded"
note "exit: $(exit_lp "$SHARES")"
state "after full exit"
note "pool price after full exit: $(price_of) bUSDC/BLCH (seed price $PRICE)"
[ "$(view "$PAIR" "totalSupply()(uint256)")" = 1000 ] || die "only the 1000 locked shares should remain"
pass "x1: a full exit works and leaves totalSupply 1000 (MINIMUM_LIQUIDITY, owned by address(0)) over dust reserves"
settle
expect 2 x1-monitor "${MON[@]}" "${SEEDED[@]}"
grep -E 'lp_recipient|lp_floor|closed' "$EV/x1-monitor.out" | sed 's/^/     /' | tee -a "$EV/steps.log" || true
set +e; "${KP[@]}" > "$EV/x1-keeper.out" 2>&1; note "keeper dry run after full exit: exit $?: $(grep -o '"action": *"[a-z-]*"' "$EV/x1-keeper.out" | head -2 | paste -sd' ' -)"; set -e
set +e; "${SP[@]}" plan --config "$EV/gate.json" --rpc "$SHIM" --price $PRICE --to "$LP" > "$EV/x1-plan.out" 2>&1; XC=$?; set -e
note "seed planner after full exit: exit $XC, decision $(jsonget "$EV/x1-plan.out" decision 2>/dev/null || head -c 200 "$EV/x1-plan.out")"
X1=$(snapshot)

log "X2 after a full exit, a stranger reprices the dust by donation and sync (to 50 bUSDC/BLCH), then fills the pair at its own price"
read -r u0 w0 < <(reserves_usd_w)
# Price 50 over the dust: WBLCH reserve = bUSDC reserve * 1e18 / 50e6.
DW=$(node -e 'const [u,w]=process.argv.slice(1).map(BigInt);console.log((u*10n**18n/50000000n-w).toString())' "$u0" "$w0")
must "$STRANGER_KEY" "$WRAPPED" "$(cast calldata "deposit()")" 10000000000000000000 100000 > /dev/null
must "$STRANGER_KEY" "$WRAPPED" "$(cast calldata "$TRANSFER" "$PAIR" "$DW")" 0 100000 > /dev/null
must "$STRANGER_KEY" "$PAIR" "$(cast calldata "sync()")" 0 150000 > /dev/null
note "stranger donated $DW wei WBLCH ($(node -e 'console.log(Number(process.argv[1])/1e18)' "$DW") WBLCH) and called sync: pool price now $(price_of) bUSDC/BLCH"
must "$STRANGER_KEY" "$USD" "$(cast calldata "$APPROVE" "$ROUTER" 100000000000)" 0 100000 > /dev/null
read -r u1 w1 < <(reserves_usd_w)
NEED_USD=$(node -e 'const [u,w]=process.argv.slice(1).map(BigInt);console.log((99n*10n**17n*u/w).toString())' "$u1" "$w1")
note "fill 9.9 BLCH + $NEED_USD bUSDC units at the stranger's price: $(must "$STRANGER_KEY" "$ROUTER" "$(cast calldata "$ADD" "$USD" "$NEED_USD" 0 0 "$STRANGER" $FUTURE)" 9900000000000000000 1000000)"
state "after the stranger's fill"
note "pool price $(price_of) bUSDC/BLCH; the owner's seed price was $PRICE; stranger holds $(view "$PAIR" "$BAL" "$STRANGER") shares"
pass "x2: after a full exit a third party set its own price with a dust donation and deposited at it; the first-deposit rule does not return"
set +e; "${SP[@]}" plan --config "$EV/gate.json" --rpc "$SHIM" --price $PRICE --to "$LP" > "$EV/x2-plan.out" 2>&1; XC=$?; set -e
note "owner's planner now: exit $XC, decision $(jsonget "$EV/x2-plan.out" decision 2>/dev/null || head -c 200 "$EV/x2-plan.out"): $(jsonget "$EV/x2-plan.out" reason 2>/dev/null || true)"
must "$STRANGER_KEY" "$USD" "$(cast calldata "$APPROVE" "$ROUTER" 100000000000)" 0 100000 > /dev/null
set +e; OUT=$(send "$STRANGER_KEY" "$ROUTER" "$(cast calldata "$ADD" "$USD" 100000000 0 0 "$STRANGER" $FUTURE)" 1000000000000000000 1000000); set -e
note "a further deposit of 1 BLCH at the pool ratio: ${OUT%% *} (0x0 = reverted: filled pool, L5)"
restore "$X1"; X1=$(snapshot)

log "X3 after a full exit, a donation synced to the k ceiling leaves liquidity nobody owns"
# The ceiling is 64% of cap0*cap1 = 6400 WBLCH*bUSDC: 8 WBLCH + 800 bUSDC at P = 100.
must "$STRANGER_KEY" "$WRAPPED" "$(cast calldata "deposit()")" 8000000000000000000 100000 > /dev/null
must "$STRANGER_KEY" "$WRAPPED" "$(cast calldata "$TRANSFER" "$PAIR" 7999999999000000000)" 0 100000 > /dev/null
must "$STRANGER_KEY" "$USD" "$(cast calldata "$TRANSFER" "$PAIR" 799999000)" 0 100000 > /dev/null
must "$STRANGER_KEY" "$PAIR" "$(cast calldata "sync()")" 0 150000 > /dev/null
state "after donation and sync"
note "pool price $(price_of); value donated about 1600 bUSDC at P = 100, all of it owned by the 1000 locked shares"
must "$STRANGER_KEY" "$USD" "$(cast calldata "$APPROVE" "$ROUTER" 100000000000)" 0 100000 > /dev/null
must_fail "$STRANGER_KEY" "$ROUTER" "$(cast calldata "$ADD" "$USD" 10000000 0 0 "$STRANGER" $FUTURE)" 100000000000000000 1000000 > /dev/null
must "$STRANGER_KEY" "$ROUTER" "$(cast calldata "swapExactBLCHForTokens(uint256,address[],address,uint256)" 0 "[$WRAPPED,$USD]" "$STRANGER" $FUTURE)" 100000000000000000 400000 > /dev/null
pass "x3: no deposit passes (k ceiling), no LP can burn the locked shares, swaps still work: the pair is permanently full for about 1600 bUSDC of donated value"
set +e; "${SP[@]}" plan --config "$EV/gate.json" --rpc "$SHIM" --price $PRICE --to "$LP" > "$EV/x3-plan.out" 2>&1; XC=$?; set -e
note "owner's planner: exit $XC, decision $(jsonget "$EV/x3-plan.out" decision 2>/dev/null || head -c 200 "$EV/x3-plan.out")"
restore "$X1"; X1=$(snapshot)

log "X4 the same donation when the LP recipient kept the floor: it goes to the LP, who can exit and reopen room"
restore "$SNAP_SEEDED"; SNAP_SEEDED=$(snapshot)
KEEP=$FLOOR
note "exit down to the floor: $(exit_lp $((SHARES - KEEP)))"
state "at the floor"
expect 0 x4-monitor-at-floor "${MON[@]}" "${SEEDED[@]}" --lp-min-bps 0
LPW0=$(cast balance "$LP" --rpc-url "$RPC"); LPU0=$(view "$USD" "$BAL" "$LP")
read -r uf wf < <(reserves_usd_w)
# Fill the room to the ceiling by donation, keeping the ratio (same value as X3).
DW=$(node -e 'const [u,w]=process.argv.slice(1).map(BigInt);const ceil=6400n*10n**18n*10n**6n;const s=(x)=>{let a=x,b=(x+1n)/2n;while(b<a){a=b;b=(x/b+b)/2n}return a};const k=u*w;const f=s(ceil*10n**12n/k);console.log((w*f/10n**6n-w-1000000000n).toString())' "$uf" "$wf")
DU=$(node -e 'const [u,w,dw]=process.argv.slice(1).map(BigInt);console.log((u*(w+dw)/w-u-1000n).toString())' "$uf" "$wf" "$DW")
must "$STRANGER_KEY" "$WRAPPED" "$(cast calldata "deposit()")" "$DW" 100000 > /dev/null
must "$STRANGER_KEY" "$WRAPPED" "$(cast calldata "$TRANSFER" "$PAIR" "$DW")" 0 100000 > /dev/null
must "$STRANGER_KEY" "$USD" "$(cast calldata "$TRANSFER" "$PAIR" "$DU")" 0 100000 > /dev/null
must "$STRANGER_KEY" "$PAIR" "$(cast calldata "sync()")" 0 150000 > /dev/null
state "after the donation, floor kept"
note "LP exits the rest: $(exit_lp "$(view "$PAIR" "$BAL" "$LP")")"
LPW1=$(cast balance "$LP" --rpc-url "$RPC"); LPU1=$(view "$USD" "$BAL" "$LP")
note "the LP recovered $(node -e 'console.log((Number(BigInt(process.argv[2])-BigInt(process.argv[1]))/1e18).toFixed(4))' "$LPW0" "$LPW1") BLCH (net of gas) and $(node -e 'console.log((Number(BigInt(process.argv[2])-BigInt(process.argv[1]))/1e6).toFixed(4))' "$LPU0" "$LPU1") bUSDC: the griefer's donation"
state "after the LP's exit"
pass "x4: with a floor the donation became the LP's; the LP's burn reopened the room (no permanent fill)"
restore "$SNAP_SEEDED"; SNAP_SEEDED=$(snapshot)

log "X5 the owner reopens after a full exit with the kit's planner (reprice-by-donation since 196's bf3dab5, then top-up)"
restore "$SNAP_SEEDED"; SNAP_SEEDED=$(snapshot)
exit_lp "$SHARES" > /dev/null
X5_DUST=$(snapshot)
X5_DECISIONS=""
for round in 1 2 3; do
  set +e; "${SP[@]}" plan --config "$EV/gate.json" --rpc "$SHIM" --price $PRICE --to "$LP" > "$EV/x5-plan-$round.out" 2>&1; XC=$?; set -e
  DEC=$(jsonget "$EV/x5-plan-$round.out" decision 2>/dev/null || echo error)
  note "round $round: planner exit $XC decision $DEC"
  case "$DEC" in
    correct-price|reprice-by-donation|top-up)
      X5_DECISIONS="$X5_DECISIONS $DEC"
      for i in 0 1 2; do
        TO=$(jsonget "$EV/x5-plan-$round.out" steps.$i.to 2>/dev/null) || break
        [ -n "$TO" ] && [ "$TO" != undefined ] || break
        [ "$(jsonget "$EV/x5-plan-$round.out" steps.$i.skip 2>/dev/null)" = true ] && continue
        OUT=$(send "$LP_KEY" "$TO" "$(jsonget "$EV/x5-plan-$round.out" steps.$i.data)" "$(jsonget "$EV/x5-plan-$round.out" steps.$i.value)" 1000000)
        note "  step $i to $TO: $OUT"
      done
      settle ;;
    *) break ;;
  esac
  [ "$DEC" = top-up ] && break
done
note "pool price after reopening: $(price_of)"
state "after reopening"
set +e; "${SP[@]}" verify --config "$EV/gate.json" --rpc "$SHIM" --price $PRICE --to "$LP" > "$EV/x5-verify.out" 2>&1; XC=$?; set -e
note "verify after reopening: exit $XC $(jsonget "$EV/x5-verify.out" decision 2>/dev/null || true)"
[ "$XC" = 0 ] && [ "$(echo $X5_DECISIONS)" = "reprice-by-donation top-up" ] || die "the planner did not reopen the dust pool by reprice-by-donation then top-up (decisions:$X5_DECISIONS, verify exit $XC)"
pass "x5: the kit's planner reopened the pair after a full exit (reprice-by-donation, then top-up), and verify passes"
restore "$X5_DUST"

log "X5b the manual route over the same dust (kept as a cross-check): the operator donates WBLCH to set P over the dust reserves, syncs, then the planner tops up"
read -r u0 w0 < <(reserves_usd_w)
DW=$(node -e 'const [u,w,p]=process.argv.slice(1).map(BigInt);console.log((u*10n**18n/p-w).toString())' "$u0" "$w0" "${PRICE}000000")
must "$LP_KEY" "$WRAPPED" "$(cast calldata "deposit()")" "$DW" 100000 > /dev/null
must "$LP_KEY" "$WRAPPED" "$(cast calldata "$TRANSFER" "$PAIR" "$DW")" 0 100000 > /dev/null
must "$LP_KEY" "$PAIR" "$(cast calldata "sync()")" 0 150000 > /dev/null
note "donated $DW wei WBLCH and synced: pool price $(price_of)"
expect 0 x5b-plan "${SP[@]}" plan --config "$EV/gate.json" --rpc "$SHIM" --price $PRICE --to "$LP"
[ "$(jsonget "$EV/x5b-plan.out" decision)" = top-up ] || die "the planner did not offer a top-up"
must "$LP_KEY" "$USD" "$(jsonget "$EV/x5b-plan.out" steps.0.data)" 0 100000 > /dev/null
must "$LP_KEY" "$(jsonget "$EV/x5b-plan.out" steps.1.to)" "$(jsonget "$EV/x5b-plan.out" steps.1.data)" "$(jsonget "$EV/x5b-plan.out" steps.1.value)" 1000000 > /dev/null
state "after the top-up"
expect 0 x5b-verify "${SP[@]}" verify --config "$EV/gate.json" --rpc "$SHIM" --price $PRICE --to "$LP"
pass "x5b: reopened at P after a full exit by a manual donate + sync + top-up (the same donation the planner plans in X5)"

log "X6 a full exit after trading: the Safe's protocol-fee shares stay in the pool"
restore "$SNAP_SEEDED"; SNAP_SEEDED=$(snapshot)
for _ in 1 2 3 4 5; do
  must "$STRANGER_KEY" "$ROUTER" "$(cast calldata "swapExactBLCHForTokens(uint256,address[],address,uint256)" 0 "[$WRAPPED,$USD]" "$STRANGER" $FUTURE)" 500000000000000000 400000 > /dev/null
  must "$STRANGER_KEY" "$USD" "$(cast calldata "$APPROVE" "$ROUTER" 100000000000)" 0 100000 > /dev/null
  must "$STRANGER_KEY" "$ROUTER" "$(cast calldata "swapExactTokensForBLCH(uint256,uint256,address[],address,uint256)" 50000000 0 "[$USD,$WRAPPED]" "$STRANGER" $FUTURE)" 0 400000 > /dev/null
done
note "exit: $(exit_lp "$SHARES")"
state "after trading and a full exit"
note "pool price $(price_of)"
pass "x6: after trading, a full exit by the LP leaves only the Safe's protocol-fee shares, worth dust (the same exposure as X1 for anything above it)"

echo "REHEARSAL OK, $PASSES checks" | tee -a "$EV/steps.log"
