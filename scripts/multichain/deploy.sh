#!/usr/bin/env bash
# The DEX on one public EVM chain (docs/MULTICHAIN-DEPLOY.md). The owner runs this; nothing else in the repository
# sends a transaction to a public chain.
#
#   scripts/multichain/deploy.sh <chain> dry-run   [-- forge signer options]
#   scripts/multichain/deploy.sh <chain> broadcast  -- forge signer options (--ledger, --trezor or --account NAME)
#   scripts/multichain/deploy.sh <chain> broadcast --rehearsal-rpc http://127.0.0.1:PORT [--reference] -- --private-key KEY
#
# Steps: build the unchanged contracts, derive the plan, run the pre gate (read-only), run
# script/DeployMultichain.s.sol (three CREATE2 deployments through 0x4e59…956C; a step whose address already has
# code is skipped; NO pair is created: the first depositor's first deposit creates each pair in the same
# transaction, scripts/multichain/first-deposit.mjs), print what to do next. `dry-run` simulates and sends nothing.
# A plan with open owner choices (TBD-owner) is refused unless --reference is given, and --reference broadcasts
# only to a loopback fork. No plan has open first deposits: `firstDepositor` must name the owner's depositing
# account (review R309-MC-1). MC_RPC_URL replaces the first reviewed endpoint as the RPC the
# transactions are sent through (an owner's own provider); the gate always reads the reviewed endpoints.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
CHAIN=${1:?usage: deploy.sh <chain> dry-run|broadcast [--rehearsal-rpc URL] [--reference] [-- forge options]}
MODE=${2:?usage: deploy.sh <chain> dry-run|broadcast [--rehearsal-rpc URL] [--reference] [-- forge options]}
shift 2
[ "$MODE" = dry-run ] || [ "$MODE" = broadcast ] || { echo "the mode is dry-run or broadcast" >&2; exit 2; }
REHEARSAL_RPC=""; REFERENCE=""; FORGE_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --rehearsal-rpc) REHEARSAL_RPC=${2:?--rehearsal-rpc needs a URL}; shift 2 ;;
    --reference) REFERENCE=--reference; shift ;;
    --) shift; FORGE_ARGS=("$@"); break ;;
    *) echo "unknown option $1 (forge options go after --)" >&2; exit 2 ;;
  esac
done
if [ -n "$REHEARSAL_RPC" ]; then
  [[ "$REHEARSAL_RPC" =~ ^http://127\.0\.0\.1:[0-9]{2,5}/?$ ]] || { echo "--rehearsal-rpc must be a loopback URL (http://127.0.0.1:PORT)" >&2; exit 2; }
  GATE_ARGS=(--rpc "$REHEARSAL_RPC" --rehearsal)
  RPC_URL=$REHEARSAL_RPC
else
  [ -z "$REFERENCE" ] || [ "$MODE" = dry-run ] || { echo "a reference plan (owner choices still TBD-owner) is never broadcast to a public chain" >&2; exit 2; }
  GATE_ARGS=()
  RPC_URL=${MC_RPC_URL:-$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).rpc[0])' "deployments/$CHAIN/chain.json")}
fi
for arg in ${FORGE_ARGS[@]+"${FORGE_ARGS[@]}"}; do
  case "$arg" in --broadcast|--rpc-url|--fork-url|-f) echo "$arg is set by this script; remove it" >&2; exit 2 ;; esac
done

echo "== build (solc 0.8.24, paris, as foundry.toml pins)"
forge build > /dev/null
echo "== plan"
node scripts/multichain/plan.mjs "$CHAIN" $REFERENCE
echo "== pre gate (read-only)"
ENV_FILE=$(mktemp)
GATE_OUT=$(mktemp)
trap 'rm -f "$ENV_FILE" "$GATE_OUT"' EXIT
GATE_STATUS=0
node scripts/multichain/gate.mjs "$CHAIN" pre $REFERENCE ${GATE_ARGS[@]+"${GATE_ARGS[@]}"} > "$GATE_OUT" 2>&1 || GATE_STATUS=$?
grep -v '^ok  ' "$GATE_OUT" || true
[ "$GATE_STATUS" = 0 ] || { echo "the pre gate did not pass; nothing was sent" >&2; exit 1; }
node scripts/multichain/plan.mjs "$CHAIN" $REFERENCE --env > "$ENV_FILE"
# Review R369-6: the forge script reads optional MC_* variables (MC_PAIR_TOKENS, MC_CAP_TOKENS, MC_CAPS) with a
# default; one left in the caller's shell by a rehearsal or a test must not reach a broadcast. Only what the plan
# prints below is passed (MC_RPC_URL was read above and is not used by the forge script).
while IFS= read -r name; do unset "$name"; done < <(compgen -e | grep '^MC_' || true)
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
BROADCAST=()
[ "$MODE" = dry-run ] || BROADCAST=(--broadcast --slow)
echo "== forge script ($MODE) through $RPC_URL"
forge script script/DeployMultichain.s.sol:DeployMultichain --rpc-url "$RPC_URL" ${BROADCAST[@]+"${BROADCAST[@]}"} ${FORGE_ARGS[@]+"${FORGE_ARGS[@]}"}
if [ "$MODE" = broadcast ]; then
  echo "== sent. When the chain has finalized these transactions (docs/MULTICHAIN-DEPLOY.md gives the wait), run:"
  echo "node scripts/multichain/gate.mjs $CHAIN post --out deployments/$CHAIN/gate-report.json"
  echo "then open each pool ONLY with scripts/multichain/first-deposit.mjs (it prints the transactions; minimums equal the amounts)"
else
  echo "== dry run only: nothing was sent"
fi
