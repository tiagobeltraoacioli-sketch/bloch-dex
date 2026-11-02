# Agent 144: sourced by rehearse-mainnet-package.sh (HOLD_TOKEN=this file) in place of the RehearsalBridgedToken step.
# BRIDGE_SRC = an extracted `git archive 9f91a56` of the bridge repo (a mock USDC is written into it), ETH_PORT a free port.
#   HOLD_TOKEN=…/hold-token.sh RENDER_HOOK=…/hold-hook.sh HOLD_SHOT=…/hold-shot.mjs BRIDGE_SRC=… ETH_PORT=33981 \
#   SAFE_ARTIFACTS=… BROWSER_EXE=… PLAYWRIGHT_DIR=… scripts/staging/rehearse-mainnet-package.sh anvil <revision> 33960 <work>
# The V3 bridge of codex/bridge-v3-r7-20261102 9f91a56 on two loopback anvils:
#   "Ethereum" anvil chain 1 at ETH_PORT: a mock USDC and ProvenanceSourceVault (mode 1, 2-of-3 committee, 1 guardian)
#   the L2 anvil (chain 700770, $RPC): BridgedStablecoinV3 bound to that vault and route (2-of-3, T = 0, 12 h delay)
# The issuer's bUSDC comes from a real vault deposit, minted on the L2 with the same deposit id, nonce, amount and
# recipient (what the bridge signers do), so the token's mint chain equals the vault's deposit chain. Throwaway keys.
: "${BRIDGE_SRC:?}" "${ETH_PORT:?}"
ETH=http://127.0.0.1:$ETH_PORT
anvil --chain-id 1 --port "$ETH_PORT" --host 127.0.0.1 --silent > "$WORK/anvil-eth.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 50); do cast chain-id --rpc-url "$ETH" > /dev/null 2>&1 && break; sleep 0.2; done
umask 077; cast wallet new --number 9 --json > "$WORK/bridge-keys.json"; umask 022
bk() { node -e 'console.log(require(process.argv[1])[Number(process.argv[2])][process.argv[3]])' "$WORK/bridge-keys.json" "$1" "$2"; }
EDEP_KEY=$(bk 0 private_key); EDEP=$(bk 0 address)
GUARD_KEY=$(bk 1 private_key); GUARD=$(bk 1 address)
for a in "$EDEP" "$GUARD"; do cast rpc anvil_setBalance "$a" 0x56bc75e2d63100000 --rpc-url "$ETH" > /dev/null; done
# committees: 3 Ethereum signers (vault), 3 L2 signers (token), sorted by address
for i in 2 3 4; do echo "$(bk $i address | tr A-F a-f) $(bk $i private_key)"; done | sort > "$WORK/eth-signers.txt"
for i in 5 6 7; do echo "$(bk $i address | tr A-F a-f) $(bk $i private_key)"; done | sort > "$WORK/l2-signers.txt"
L2G=$(bk 8 address)
ESIGNERS="[$(awk '{print $1}' "$WORK/eth-signers.txt" | paste -sd, -)]"
LSIGNERS="[$(awk '{print $1}' "$WORK/l2-signers.txt" | paste -sd, -)]"
cat > "$BRIDGE_SRC/solidity-tests/MockUsdc144.sol" <<'SOL'
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;
// Agent 144 rehearsal stand-in for USDC (6 decimals). Scratch copy only.
contract MockUsdc144 {
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mintTo(address to, uint256 v) external { balanceOf[to] += v; }
    function approve(address s, uint256 v) external returns (bool) { allowance[msg.sender][s] = v; return true; }
    function transfer(address to, uint256 v) external returns (bool) { balanceOf[msg.sender] -= v; balanceOf[to] += v; return true; }
    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        allowance[f][msg.sender] -= v; balanceOf[f] -= v; balanceOf[to] += v; return true;
    }
}
SOL
(cd "$BRIDGE_SRC" && forge build > "$WORK/bridge-build.log" 2>&1) || { tail -n 20 "$WORK/bridge-build.log"; exit 1; }
fcreate() {
  local extra=(); [ $# -gt 3 ] && extra=(--constructor-args "${@:4}")
  (cd "$BRIDGE_SRC" && forge create --broadcast --rpc-url "$1" --private-key "$2" "$3" "${extra[@]}") | awk '/Deployed to:/{print tolower($3)}'
}
USDC_MOCK=$(fcreate "$ETH" "$EDEP_KEY" solidity-tests/MockUsdc144.sol:MockUsdc144)
VAULT=$(fcreate "$ETH" "$EDEP_KEY" contracts/usdt/ProvenanceSourceVault.sol:ProvenanceSourceVault \
  "$(cast keccak ethereum-mainnet)" "$(cast keccak bloch-l2-700770)" "$(cast keccak USDC)" "$USDC_MOCK" 100000000000 0 \
  "$ESIGNERS" 2 "(10000000000,86400,3,1209600,10000000,10000000)" "([$GUARD],259200,259200)" "(1,0,0x0000000000000000000000000000000000000000)")
ROUTE=$(cast call "$VAULT" "routeId()(bytes32)" --rpc-url "$ETH")
VALID=$(( $(date +%s) + 3600 ))
DIG=$(cast call "$VAULT" "controlDigest(bool,bool,uint64,uint256)(bytes32)" true true 0 "$VALID" --rpc-url "$ETH")
ESIGS="[$(head -n 2 "$WORK/eth-signers.txt" | while read -r _ k; do cast wallet sign --no-hash --private-key "$k" "$DIG"; done | paste -sd, -)]"
cast send "$VAULT" "setControls(bool,bool,uint64,uint256,bytes[])" true true 0 "$VALID" "$ESIGS" --private-key "$EDEP_KEY" --rpc-url "$ETH" > /dev/null
log "1 DEX (agent 144): Ethereum anvil $ETH, mock USDC $USDC_MOCK, ProvenanceSourceVault $VAULT (mode $(cast call "$VAULT" "provenanceMode()(uint8)" --rpc-url "$ETH")), route $ROUTE"
CTOR=$(cast abi-encode "c(string,string,uint256,address,bytes32,address[],uint256,(uint256,uint256,uint256,uint256,uint256,uint256),(address[],uint256,uint256),(uint256,uint64))" \
  "Bridged USDC" bUSDC 1 "$VAULT" "$ROUTE" "$LSIGNERS" 2 "(100000000000,$USD_BUCKET,115740,0,43200,10000000)" "([$L2G],259200,259200)" "(3,1209600)" | cut -c3-)
TOKEN_INIT=$(node -e 'console.log(require(process.argv[1]).bytecode.object)' "$BRIDGE_SRC/out/BridgedStablecoinV3.sol/BridgedStablecoinV3.json")$CTOR
ASSET=$(must "$ISSUER_KEY" create "$TOKEN_INIT" 0 5000000 | awk '{print tolower($2)}')
ASSET_CODE=$(cast keccak "$(cast code "$ASSET" --rpc-url "$RPC")")
log "1 DEX (agent 144): BridgedStablecoinV3 $ASSET (genesis head $(cast call "$ASSET" "mintHead()(bytes32)" --rpc-url "$RPC"), vault genesis $(cast call "$VAULT" "chainHeadAt(uint64)(bytes32)" 0 --rpc-url "$ETH"))"
# l2sigs DIGEST: 2 L2 committee signatures in ascending signer order
l2sigs() { local out=0x; while read -r _ k; do out+=$(cast wallet sign --no-hash "$1" --private-key "$k" | cut -c3-); done < <(head -n 2 "$WORK/l2-signers.txt"); echo "$out"; }
# deposit_and_mint AMOUNT L2RECIPIENT: a real vault deposit, then the matching L2 mint (queued, credited after the delay)
deposit_and_mint() {
  cast send "$USDC_MOCK" "mintTo(address,uint256)" "$EDEP" "$1" --private-key "$EDEP_KEY" --rpc-url "$ETH" > /dev/null
  cast send "$USDC_MOCK" "approve(address,uint256)" "$VAULT" "$1" --private-key "$EDEP_KEY" --rpc-url "$ETH" > /dev/null
  local nonce id dig
  nonce=$(cast call "$VAULT" "depositCount()(uint64)" --rpc-url "$ETH")
  cast send "$VAULT" "deposit(uint64,bytes32)" "$1" "0x000000000000000000000000${2#0x}" --private-key "$EDEP_KEY" --rpc-url "$ETH" > /dev/null
  id=$(cast call "$VAULT" "depositId(uint64,address,uint64,bytes32)(bytes32)" "$nonce" "$EDEP" "$1" "0x000000000000000000000000${2#0x}" --rpc-url "$ETH")
  dig=$(cast call "$ASSET" "mintDigest(bytes32,uint64,uint64,address)(bytes32)" "$id" "$nonce" "$1" "$2" --rpc-url "$RPC")
  must "$ISSUER_KEY" "$ASSET" "$(cast calldata "mint(bytes32,uint64,uint64,address,bytes)" "$id" "$nonce" "$1" "$2" "$(l2sigs "$dig")")" 0 400000 > /dev/null
  echo "$id"
}
SEED_ID=$(deposit_and_mint 9000000000 "$ISSUER")
cast rpc anvil_mine 0x48 --rpc-url "$ETH" > /dev/null
cast rpc evm_increaseTime 43300 --rpc-url "$RPC" > /dev/null; cast rpc evm_mine --rpc-url "$RPC" > /dev/null
must "$ISSUER_KEY" "$ASSET" "$(cast calldata "executeMint(bytes32)" "$SEED_ID")" 0 1500000 > /dev/null
[ "$(cast call "$ASSET" "balanceOf(address)(uint256)" "$ISSUER" --rpc-url "$RPC" | awk '{print $1}')" = 9000000000 ] || { echo "FAIL: the seed bUSDC did not credit"; exit 1; }
[ "$(cast call "$ASSET" "mintHead()(bytes32)" --rpc-url "$RPC")" = "$(cast call "$VAULT" "chainHeadAt(uint64)(bytes32)" 1 --rpc-url "$ETH")" ] || { echo "FAIL: mint chain differs from the vault after an honest deposit"; exit 1; }
log "1 DEX (agent 144): 9000 bUSDC from vault deposit $SEED_ID credited; token mintHead equals vault chainHeadAt(1)"
printf '{"eth":"%s","vault":"%s","usdc":"%s","token":"%s","route":"%s","guardianKey":"%s","l2SignersFile":"%s","depositorKey":"%s","depositor":"%s"}\n' \
  "$ETH" "$VAULT" "$USDC_MOCK" "$ASSET" "$ROUTE" "$GUARD_KEY" "$WORK/l2-signers.txt" "$EDEP_KEY" "$EDEP" > "$WORK/bridge-facts.json"
chmod 600 "$WORK/bridge-facts.json"
