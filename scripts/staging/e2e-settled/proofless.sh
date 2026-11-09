#!/usr/bin/env bash
# Proofless measuring run of drive.sh: the same steps and the real bridge token on scripts/staging/private-l2.sh
# (release binaries, pinned genesis, no L1, no proof, synthetic finality, `warp` for the token's 12 h delay).
# It measures what the settled run needs (bUSDC from the bridge deposit, BLCH per key, bursts) in about ten minutes.
# It does not replace the settled run: finality, the gateway, the browser scenes and block cadence are not exercised.
#
#   F=<work dir holding env.sh, repo/ (this repository with frontend/node_modules), bridge/ (clean bridge checkout),
#      safe -> a directory with package/build/artifacts (safe-contracts 1.4.1), fhome/>
#   L2_PORT=<free loopback port> ETH_PORT=<free loopback port> proofless.sh STAGE
#   stages, in order: boot deploy credit launch rest [boot-gas f3] [boot-gas f2] stop   (topup: one more deposit after a warped day)
#   env.sh must put forge, cast, anvil and node on PATH and export PRODUCE_DEV, SETTLED_RPC and SVM_HOME.
# Run of record 2026-11-09 (docs/MAINNET-700770-PACKAGE.md, "Settled driver budget"); this copy differs from the
# script that produced it only in taking F and the two ports from the environment.
set -euo pipefail
: "${F:?F=<work dir> is required}" "${L2_PORT:?L2_PORT is required}" "${ETH_PORT:?ETH_PORT is required}"
. "$F/env.sh"
export F PRODUCE_DEV SETTLED_RPC
export BRIDGE_REPO=$F/bridge ETH_PORT
export E2E_RPC=http://127.0.0.1:$L2_PORT E2E_GW=http://127.0.0.1:$L2_PORT
export E2E_FINALIZE="$F/repo/scripts/staging/private-l2.sh finalize $F/l2 $L2_PORT"
L2="$F/repo/scripts/staging/private-l2.sh"
D() { echo "### drive ${FLOW:-flow}: $*"; bash "$F/repo/scripts/staging/e2e-settled/drive.sh" "$@"; }
cd "$F"
case "$1" in
  boot)
    D keys
    D bridge-eth
    # A throwaway "bank" (three 100 BLCH deposits) stands for later L1 deposits: the proofless chain has no L1.
    umask 077; cast wallet new --number 1 --json > "$F/bank.json"; umask 022
    ADDRS=$(node -e 'const k=require(process.argv[1]),b=require(process.argv[2]),n=require(process.argv[3]);console.log([k[0],k[1],k[2],k[8],b[13],n[0],n[0],n[0]].map(x=>x.address.toLowerCase()).join(","))' "$F/flow/keys.json" "$F/flow/bridge/keys.json" "$F/bank.json")
    "$L2" init "$F/l2" "$ADDRS" 10000000000
    "$L2" start "$F/l2" "$L2_PORT"
    D wait-funded
    ;;
  deploy) D deploy; D gate ;;
  credit) "$L2" warp "$F/l2" 43300; D bridge-credit; D budget; D rec-fund; D budget ;;
  tick)
    # One block after a warp, so views read the new clock. Sent by the bank, never by a key the kit pins a nonce of.
    B=$(node -e 'console.log(require(process.argv[1])[0].address)' "$F/bank.json")
    cast send "$B" --value 1 --private-key "$(node -e 'console.log(require(process.argv[1])[0].private_key)' "$F/bank.json")" --rpc-url "$E2E_RPC" --gas-price 5000000000 --priority-gas-price 1000000000 > /dev/null ;;
  topup) "$L2" warp "$F/l2" 86400; bash "$0" tick; D bridge-deposit; "$L2" warp "$F/l2" 43300; D bridge-credit; D budget ;;
  launch) for s in seed swaps safe-fee cap-skim fund-user "big-swap 30" donate; do D $s; D budget; done ;;
  rest)
    for s in "fill 300 3" "close 200 2" "keeper dry" "keeper run"; do D $s; D budget; done
    $E2E_FINALIZE; D keeper run; D reopened; D budget; D fill 100 2; D budget
    ;;
  boot-gas)
    # Proofless only: the bank lends the issuer the gas a second `drive.sh fund` would bring on the settled stack.
    cast send "$(node -e 'console.log(require(process.argv[1])[2].address)' "$F/flow/keys.json")" --value 80ether --private-key "$(node -e 'console.log(require(process.argv[1])[0].private_key)' "$F/bank.json")" --rpc-url "$E2E_RPC" --gas-price 5000000000 --priority-gas-price 1000000000 > /dev/null ;;
  f3) export FLOW=${FLOWNAME:-f3}; D rec-init flow; D rec-fund; D deploy; D gate; D failed-approve; D budget
    # grief waits for a block and for the next ones: the bank ticks stand for the settled stack's block cadence.
    (for _ in 1 2 3 4 5 6 7 8; do sleep 4; bash "$0" tick || true; done) > /dev/null 2>&1 &
    timeout 240 bash "$F/repo/scripts/staging/e2e-settled/drive.sh" grief || echo "grief exit $?"; wait; D budget ;;
  f2) export FLOW=${FLOWNAME:-f2} ATTACK_CREATEPAIR=1; D rec-init flow; D rec-fund; D deploy; D budget ;;
  b) export FLOW=$2; D budget ;;
  stop) D bridge-eth stop || true; "$L2" stop "$F/l2" ;;
esac
