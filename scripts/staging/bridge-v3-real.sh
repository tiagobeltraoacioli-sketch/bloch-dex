# Sourced by rehearse-mainnet-package.sh (BRIDGE_REPO set) and e2e-settled/drive.sh.
#
# The REAL bridge token in a rehearsal: BridgedStablecoinV3 deployed by the bridge's own tools from a clean git
# checkout of the bridge repository (BRIDGE_REPO, at the bridge release candidate), under the mainnet policy:
#
#   "Ethereum"  a loopback anvil with chain id 1. A six-decimal mock is placed at the canonical USDC address
#               (anvil_setCode), so `vault_pontes.py validate` runs WITHOUT --rehearsal: 5 of 7 release signers,
#               3 guardians, 6 of 7 switch quorum, the decided 5 + 5 bps fee. The vault is created with the
#               arguments `vault_pontes.py args` prints and checked by `vault_pontes.py verify --unused`.
#   L2          `deploy_pontes.py validate / plan / run --broadcast / record` with the committed
#               busdc-mainnet.config.json template filled with throwaway keys: 5 of 7 signers, 3 guardians, T = 0,
#               12 h mint delay, MAX_PENDING 2048. The plan and record it writes ($EV/busdc.plan.json and
#               $EV/busdc.record.json) are the files the mainnet finality gate and the monitor take.
#
# Every key is a throwaway made here. Nothing leaves loopback. The bridge checkout is not modified (its forge
# `out/` and `cache/` are ignored by its .gitignore).
#
# The caller provides: WORK, EV, RPC (the L2), log(), must KEY TO|create DATA VALUE GAS (a mined L2 transaction that
# must succeed), BRIDGE_REPO, and either ETH_PORT (an anvil is started and added to PIDS) or BRIDGE_ETH_RPC.
# Functions, in order:
#   bridge_v3_keys                      throwaway keys (made once per WORK); sets BRIDGE_L2_DEPLOYER (needs L2 gas
#                                       before bridge_v3_token)
#   bridge_v3_load                      a staged driver's later invocation: restores VAULT, ASSET, BRIDGE_ARGS and the
#                                       totals from the files of an earlier invocation (needs BRIDGE_ETH_RPC)
#   bridge_v3_vault SAFE                Ethereum side; SAFE is the Bloch Inc Safe named as the funder in the configs
#   bridge_v3_token GENESIS SAFE        L2 side: sets ASSET, ASSET_CODE, BRIDGE_ARGS (gate and monitor arguments)
#   bridge_v3_open                      the vault's release committee enables deposits and releases (5 of 7)
#   bridge_v3_deposit NET RECIPIENT RELAYER_KEY   a real vault deposit, then the committee's mint (5 of 7); sets
#                                       BRIDGE_DEPOSIT_ID (call it in this shell, not in a substitution)
#   bridge_v3_credit ID RELAYER_KEY     executeMint after the 12 h delay has passed on the L2 clock
#   bridge_v3_fees                      the vault kept 5 bps of every deposit; sweepFees pays the fee recipient
#   bridge_v3_verify                    deploy_pontes.py verify at `finalized`, with the Ethereum vault cross-check

: "${BRIDGE_REPO:?BRIDGE_REPO=<clean git checkout of the bridge repository at its release candidate> is required}"
[ -f "$BRIDGE_REPO/tools/deploy-pontes/deploy_pontes.py" ] && [ -f "$BRIDGE_REPO/tools/deploy-pontes/vault_pontes.py" ] ||
  { echo "BRIDGE_REPO has no tools/deploy-pontes" >&2; exit 1; }
[ -z "$(git -C "$BRIDGE_REPO" status --porcelain)" ] || { echo "BRIDGE_REPO is not a clean checkout" >&2; exit 1; }
BRIDGE_REVISION=$(git -C "$BRIDGE_REPO" rev-parse HEAD)
BRIDGE_PYTHON=${PYTHON:-python3}
# The bridge tools look for forge and cast in FOUNDRY_BIN (default ~/.foundry/bin).
export FOUNDRY_BIN=${FOUNDRY_BIN:-$(dirname "$(command -v forge)")}
BRIDGE_USDC=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
BRIDGE_MINT_DELAY=43200
BRIDGE_FEE_BPS=5
BW=$WORK/bridge
mkdir -p "$BW"

bjson() { node -e 'const v=process.argv[2].split(".").reduce((o,k)=>o[k],JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")));console.log(typeof v==="object"?JSON.stringify(v):v)' "$1" "$2"; }
# btool TOOL OUT ARGS…: run a bridge tool, keep its JSON answer in OUT, fail with its reason.
btool() {
  local tool=$1 out=$2; shift 2
  "$BRIDGE_PYTHON" "$BRIDGE_REPO/tools/deploy-pontes/$tool" "$@" > "$out" 2> "$out.err" || {
    echo "FAIL: $tool $1: $(cat "$out" "$out.err" | tail -c 1500)" >&2; exit 1; }
}
bkey() { node -e 'console.log(require(process.argv[1])[Number(process.argv[2])][process.argv[3]].toLowerCase())' "$BW/keys.json" "$1" "$2"; }
# Committee files: "address key" per line, ascending by address (the order the contracts require).
bcommittee() { local i; for i in $(seq "$1" "$2"); do echo "$(bkey "$i" address) $(bkey "$i" private_key)"; done | sort > "$3"; }

bridge_v3_keys() {
  if [ ! -s "$BW/keys.json" ]; then umask 077; cast wallet new --number 24 --json > "$BW/keys.json"; umask 022; fi
  BRIDGE_ETH_DEPLOYER_KEY=$(bkey 0 private_key); BRIDGE_ETH_DEPLOYER=$(bkey 0 address)
  BRIDGE_ETH_USER_KEY=$(bkey 1 private_key); BRIDGE_ETH_USER=$(bkey 1 address)
  bcommittee 2 8 "$BW/eth-signers.txt"; bcommittee 9 11 "$BW/eth-guardians.txt"
  BRIDGE_FEE_TO=$(bkey 12 address)
  BRIDGE_L2_DEPLOYER_KEY=$(bkey 13 private_key); BRIDGE_L2_DEPLOYER=$(bkey 13 address)
  bcommittee 14 20 "$BW/l2-signers.txt"; bcommittee 21 23 "$BW/l2-guardians.txt"
}

bridge_v3_load() {
  bridge_v3_keys
  : "${BRIDGE_ETH_RPC:?BRIDGE_ETH_RPC is required to continue an earlier invocation}"
  if [ -s "$EV/busdc-vault.verify.json" ]; then
    VAULT=$(bjson "$EV/busdc-vault.verify.json" busdcEthereum.vault); VAULT_CODE=$(bjson "$EV/busdc-vault.verify.json" busdcEthereum.vaultCodeHash)
  fi
  if [ -s "$EV/busdc.record.json" ]; then
    ASSET=$(bjson "$EV/busdc.record.json" address); ASSET_CODE=$(bjson "$EV/busdc.record.json" runtimeCodeHash)
    BRIDGE_ARGS=(--bridge-plan "$EV/busdc.plan.json" --bridge-record "$EV/busdc.record.json")
  fi
  if [ -s "$BW/totals" ]; then read -r BRIDGE_NET_TOTAL BRIDGE_FEE_TOTAL < "$BW/totals"; fi
}

bridge_v3_vault() {
  local safe=$1 a
  if [ -z "${BRIDGE_ETH_RPC:-}" ]; then
    : "${ETH_PORT:?ETH_PORT or BRIDGE_ETH_RPC is required}"
    BRIDGE_ETH_RPC=http://127.0.0.1:$ETH_PORT
    anvil --chain-id 1 --port "$ETH_PORT" --host 127.0.0.1 --silent > "$BW/anvil-eth.log" 2>&1 &
    PIDS+=($!)
    for _ in $(seq 50); do cast chain-id --rpc-url "$BRIDGE_ETH_RPC" > /dev/null 2>&1 && break; sleep 0.2; done
  fi
  [ "$(cast chain-id --rpc-url "$BRIDGE_ETH_RPC")" = 1 ] || { echo "FAIL: the rehearsal Ethereum is not chain id 1" >&2; exit 1; }
  for a in "$BRIDGE_ETH_DEPLOYER" "$BRIDGE_ETH_USER"; do cast rpc anvil_setBalance "$a" 0x56bc75e2d63100000 --rpc-url "$BRIDGE_ETH_RPC" > /dev/null; done
  (cd "$BRIDGE_REPO" && forge build > "$BW/bridge-build.log" 2>&1) || { tail -n 20 "$BW/bridge-build.log"; exit 1; }
  [ -z "$(git -C "$BRIDGE_REPO" status --porcelain)" ] || { echo "FAIL: the bridge build changed its checkout" >&2; exit 1; }
  # A six-decimal mock at the canonical USDC address: the vault config stays a mainnet config.
  cast rpc anvil_setCode "$BRIDGE_USDC" "$(bjson "$BRIDGE_REPO/out/BridgedStablecoin.t.sol/MockStable.json" deployedBytecode.object)" --rpc-url "$BRIDGE_ETH_RPC" > /dev/null
  node -e '
const fs = require("fs");
const [template, out, revision, deployer, safe, feeTo, signers, guardians] = process.argv.slice(1);
const list = (f) => fs.readFileSync(f, "utf8").trim().split("\n").map((l) => l.split(" ")[0]);
const c = JSON.parse(fs.readFileSync(template, "utf8"));
c.source.revision = revision;
c.deployer.address = deployer; c.deployer.fundedBy.safe = safe;
c.vault.signers.set = list(signers).map((address, i) => ({ operator: `rehearsal-operator-${i}`, address }));
c.vault.guard.guardians = list(guardians).map((address, i) => ({ operator: `rehearsal-guardian-org-${i}`, address }));
c.vault.provenance.fees.recipient = feeTo;
fs.writeFileSync(out, JSON.stringify(c, null, 2));' "$BRIDGE_REPO/deployments/mainnet/busdc-vault-mainnet.config.json" "$EV/busdc-vault.config.json" \
    "$BRIDGE_REVISION" "$BRIDGE_ETH_DEPLOYER" "$safe" "$BRIDGE_FEE_TO" "$BW/eth-signers.txt" "$BW/eth-guardians.txt"
  btool vault_pontes.py "$EV/busdc-vault.validate.json" validate --config "$EV/busdc-vault.config.json"
  btool vault_pontes.py "$EV/busdc-vault.args.json" args --config "$EV/busdc-vault.config.json"
  local args=(); while IFS= read -r a; do args+=("$a"); done < <(node -e 'for (const a of JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).constructorArgs) console.log(a)' "$EV/busdc-vault.args.json")
  VAULT=$( (cd "$BRIDGE_REPO" && forge create --broadcast --rpc-url "$BRIDGE_ETH_RPC" --private-key "$BRIDGE_ETH_DEPLOYER_KEY" \
    "$(bjson "$EV/busdc-vault.config.json" vault.contract)" --constructor-args "${args[@]}") | awk '/Deployed to:/{print tolower($3)}')
  [ -n "$VAULT" ] || { echo "FAIL: the vault was not created" >&2; exit 1; }
  cast rpc anvil_mine 0x80 --rpc-url "$BRIDGE_ETH_RPC" > /dev/null
  btool vault_pontes.py "$EV/busdc-vault.verify.json" verify --config "$EV/busdc-vault.config.json" --rpc "$BRIDGE_ETH_RPC" --address "$VAULT" --unused
  [ "$(bjson "$EV/busdc-vault.verify.json" decision)" = verified ] || { echo "FAIL: vault verify"; exit 1; }
  VAULT_CODE=$(bjson "$EV/busdc-vault.verify.json" busdcEthereum.vaultCodeHash)
  log "bridge (Ethereum): ProvenanceSourceVault $VAULT (code $VAULT_CODE) from vault_pontes.py under the mainnet policy, bridge revision $BRIDGE_REVISION"
}

bridge_v3_token() {
  local genesis=$1 safe=$2
  node -e '
const fs = require("fs");
const [template, out, verify, genesis, revision, deployer, safe, signers, guardians] = process.argv.slice(1);
const list = (f) => fs.readFileSync(f, "utf8").trim().split("\n").map((l) => l.split(" ")[0]);
const c = JSON.parse(fs.readFileSync(template, "utf8"));
c.network.genesisHash = genesis;
c.source.revision = revision;
c.deployer.address = deployer; c.deployer.fundedBy.safe = safe;
c.signers.set = list(signers).map((address, i) => ({ operator: `rehearsal-operator-${i}`, address }));
c.guardians.set = list(guardians).map((address, i) => ({ operator: `rehearsal-guardian-org-${i}`, address }));
c.ethereum = JSON.parse(fs.readFileSync(verify, "utf8")).busdcEthereum;
c.tx.maxGasPriceWei = 100000000000;
fs.writeFileSync(out, JSON.stringify(c, null, 2));' "$BRIDGE_REPO/deployments/mainnet/busdc-mainnet.config.json" "$EV/busdc.config.json" "$EV/busdc-vault.verify.json" \
    "$genesis" "$BRIDGE_REVISION" "$BRIDGE_L2_DEPLOYER" "$safe" "$BW/l2-signers.txt" "$BW/l2-guardians.txt"
  btool vault_pontes.py "$EV/busdc-vault.cross.json" validate --config "$EV/busdc-vault.config.json" --token-config "$EV/busdc.config.json"
  btool deploy_pontes.py "$EV/busdc.validate.json" validate --config "$EV/busdc.config.json"
  local sha; sha=$(bjson "$EV/busdc.validate.json" configSha256)
  btool deploy_pontes.py "$BW/plan.out.json" plan --config "$EV/busdc.config.json" --write "$EV/busdc.plan.json"
  [ "$(bjson "$EV/busdc.plan.json" chain.rehearsal)" = false ] || { echo "FAIL: the bridge plan is a rehearsal plan" >&2; exit 1; }
  btool deploy_pontes.py "$EV/busdc.dry-run.json" run --config "$EV/busdc.config.json" --plan "$EV/busdc.plan.json" --rpc "$RPC" --source-rpc "$BRIDGE_ETH_RPC"
  btool deploy_pontes.py "$EV/busdc.broadcast.out.json" run --config "$EV/busdc.config.json" --plan "$EV/busdc.plan.json" --rpc "$RPC" --source-rpc "$BRIDGE_ETH_RPC" \
    --broadcast --confirm "$sha" --write "$BW/busdc.broadcast.json" -- --private-key "$BRIDGE_L2_DEPLOYER_KEY"
  btool deploy_pontes.py "$BW/record.out.json" record --config "$EV/busdc.config.json" --plan "$EV/busdc.plan.json" --rpc "$RPC" --source-rpc "$BRIDGE_ETH_RPC" \
    --broadcast-file "$BW/busdc.broadcast.json" --write "$EV/busdc.record.json"
  ASSET=$(bjson "$EV/busdc.record.json" address)
  ASSET_CODE=$(cast keccak "$(cast code "$ASSET" --rpc-url "$RPC")")
  [ "$ASSET_CODE" = "$(bjson "$EV/busdc.plan.json" contract.runtimeCodeHash)" ] || { echo "FAIL: the token's code is not the planned code" >&2; exit 1; }
  BRIDGE_ARGS=(--bridge-plan "$EV/busdc.plan.json" --bridge-record "$EV/busdc.record.json")
  log "bridge (L2): BridgedStablecoinV3 $ASSET from deploy_pontes.py (5 of 7 signers, 3 guardians, T = 0, MAX_PENDING $(cast call "$ASSET" "MAX_PENDING()(uint256)" --rpc-url "$RPC" | awk '{print $1}')), init code $(bjson "$EV/busdc.plan.json" contract.initCodeHash)"
}

bridge_v3_open() {
  local valid dig sigs
  valid=$(( $(cast block latest --field timestamp --rpc-url "$BRIDGE_ETH_RPC") + 3600 ))
  dig=$(cast call "$VAULT" "controlDigest(bool,bool,uint64,uint256)(bytes32)" true true 0 "$valid" --rpc-url "$BRIDGE_ETH_RPC")
  sigs="[$(head -n 5 "$BW/eth-signers.txt" | while read -r _ k; do cast wallet sign --no-hash --private-key "$k" "$dig"; done | paste -sd, -)]"
  cast send "$VAULT" "setControls(bool,bool,uint64,uint256,bytes[])" true true 0 "$valid" "$sigs" --private-key "$BRIDGE_ETH_USER_KEY" --rpc-url "$BRIDGE_ETH_RPC" > /dev/null
  [ "$(cast call "$VAULT" "depositsEnabled()(bool)" --rpc-url "$BRIDGE_ETH_RPC")" = true ] || { echo "FAIL: deposits are not enabled" >&2; exit 1; }
}

# The smallest deposit whose net after the vault's deposit fee is NET.
bridge_gross_for() {
  node -e 'const [n,b]=process.argv.slice(1).map(BigInt);let g=(n*10000n+9999n-b)/(10000n-b);while(g-(g*b)/10000n>n)g--;while(g-(g*b)/10000n<n)g++;if(g-(g*b)/10000n!==n)process.exit(1);console.log(g.toString())' "$1" "$BRIDGE_FEE_BPS"
}

BRIDGE_NET_TOTAL=0; BRIDGE_FEE_TOTAL=0
bridge_v3_deposit() {
  local net=$1 to=$2 relayer=$3 gross nonce id dig sigs=0x k before
  before=$(cast call "$ASSET" "balanceOf(address)(uint256)" "$to" --rpc-url "$RPC" | awk '{print $1}')
  gross=$(bridge_gross_for "$net")
  cast send "$BRIDGE_USDC" "mintTo(address,uint256)" "$BRIDGE_ETH_USER" "$gross" --private-key "$BRIDGE_ETH_USER_KEY" --rpc-url "$BRIDGE_ETH_RPC" > /dev/null
  cast send "$BRIDGE_USDC" "approve(address,uint256)" "$VAULT" "$gross" --private-key "$BRIDGE_ETH_USER_KEY" --rpc-url "$BRIDGE_ETH_RPC" > /dev/null
  nonce=$(cast call "$VAULT" "depositCount()(uint64)" --rpc-url "$BRIDGE_ETH_RPC")
  cast send "$VAULT" "deposit(uint64,bytes32)" "$gross" "0x000000000000000000000000${to#0x}" --private-key "$BRIDGE_ETH_USER_KEY" --rpc-url "$BRIDGE_ETH_RPC" > /dev/null
  id=$(cast call "$VAULT" "depositId(uint64,address,uint64,bytes32)(bytes32)" "$nonce" "$BRIDGE_ETH_USER" "$net" "0x000000000000000000000000${to#0x}" --rpc-url "$BRIDGE_ETH_RPC")
  dig=$(cast call "$ASSET" "mintDigest(bytes32,uint64,uint64,address)(bytes32)" "$id" "$nonce" "$net" "$to" --rpc-url "$RPC")
  while read -r _ k; do sigs+=$(cast wallet sign --no-hash "$dig" --private-key "$k" | cut -c3-); done < <(head -n 5 "$BW/l2-signers.txt")
  must "$relayer" "$ASSET" "$(cast calldata "mint(bytes32,uint64,uint64,address,bytes)" "$id" "$nonce" "$net" "$to" "$sigs")" 0 600000 > /dev/null
  [ "$(cast call "$ASSET" "balanceOf(address)(uint256)" "$to" --rpc-url "$RPC" | awk '{print $1}')" = "$before" ] ||
    { echo "FAIL: a V3 mint at T = 0 credited without the delay" >&2; exit 1; }
  BRIDGE_NET_TOTAL=$((BRIDGE_NET_TOTAL + net)); BRIDGE_FEE_TOTAL=$((BRIDGE_FEE_TOTAL + gross - net))
  BRIDGE_DEPOSIT_ID=$id
  echo "$BRIDGE_NET_TOTAL $BRIDGE_FEE_TOTAL" > "$BW/totals"
}

bridge_v3_credit() {
  must "$2" "$ASSET" "$(cast calldata "executeMint(bytes32)" "$1")" 0 1500000 > /dev/null
}

bridge_v3_fees() {
  local accrued locked
  accrued=$(cast call "$VAULT" "feesAccrued()(uint64)" --rpc-url "$BRIDGE_ETH_RPC" | awk '{print $1}')
  locked=$(cast call "$VAULT" "totalLocked()(uint64)" --rpc-url "$BRIDGE_ETH_RPC" | awk '{print $1}')
  [ "$accrued" = "$BRIDGE_FEE_TOTAL" ] && [ "$locked" = "$BRIDGE_NET_TOTAL" ] || { echo "FAIL: vault fees $accrued (want $BRIDGE_FEE_TOTAL), locked $locked (want $BRIDGE_NET_TOTAL)" >&2; exit 1; }
  cast send "$VAULT" "sweepFees()" --private-key "$BRIDGE_ETH_USER_KEY" --rpc-url "$BRIDGE_ETH_RPC" > /dev/null
  [ "$(cast call "$BRIDGE_USDC" "balanceOf(address)(uint256)" "$BRIDGE_FEE_TO" --rpc-url "$BRIDGE_ETH_RPC" | awk '{print $1}')" = "$BRIDGE_FEE_TOTAL" ] ||
    { echo "FAIL: sweepFees did not pay the fee recipient" >&2; exit 1; }
  log "bridge fee: the vault kept $BRIDGE_FEE_TOTAL units ($BRIDGE_FEE_BPS bps) of the deposits, locked the net $BRIDGE_NET_TOTAL, and sweepFees paid the immutable recipient"
}

bridge_v3_verify() {
  cast rpc anvil_mine 0x80 --rpc-url "$BRIDGE_ETH_RPC" > /dev/null
  btool deploy_pontes.py "$EV/busdc.verify.json" verify --config "$EV/busdc.config.json" --plan "$EV/busdc.plan.json" --rpc "$RPC" --record "$EV/busdc.record.json" \
    --source-rpc "$BRIDGE_ETH_RPC" --block finalized
  [ "$(bjson "$EV/busdc.verify.json" decision)" = verified ] || { echo "FAIL: deploy_pontes.py verify: $(cat "$EV/busdc.verify.json")" >&2; exit 1; }
  log "bridge: deploy_pontes.py verify at finalized passes (immutables, signers, guardians, domain separator, Ethereum vault)"
}
