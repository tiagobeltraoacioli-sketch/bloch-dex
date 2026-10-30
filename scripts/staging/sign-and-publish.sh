#!/usr/bin/env bash
# Sign each transaction of an unsigned-transaction file (domain
# postern.dex.raw-txs.v1, written by `deploy-safe.mjs txs` or
# `deploy-dex.mjs txs`) offline with `cast mktx`, publish it with
# `cast publish` (eth_sendRawTransaction) and wait for its receipt before the
# next one. Nonce, gas limit and fees are explicit, so nothing depends on the
# RPC's `pending` view or on gas estimation.
#
#   scripts/staging/sign-and-publish.sh --txs T --rpc URL --confirm <configSha256>
#       --max-fee-wei N --priority-fee-wei N --hashes-out H [--timeout SECONDS]
#       -- <cast signer arguments, e.g. --ledger or --private-key ...>
#
# Refuses unless: the confirmation equals the file's configSha256; the RPC's
# chain ID and genesis hash equal the file's; the signer is the file's `from`;
# it holds enough for every gas limit at the max fee; and before each
# transaction its latest nonce equals the transaction's nonce and a planned
# creation address is still empty. After each receipt: status 1 and, for a
# creation, the planned address. Hashes are appended to H in nonce order.
set -euo pipefail

TXS= RPC= CONFIRM= MAXFEE= TIP= OUT= TIMEOUT=3600
while [ $# -gt 0 ]; do
  case "$1" in
    --txs) TXS=$2; shift 2 ;;
    --rpc) RPC=$2; shift 2 ;;
    --confirm) CONFIRM=$2; shift 2 ;;
    --max-fee-wei) MAXFEE=$2; shift 2 ;;
    --priority-fee-wei) TIP=$2; shift 2 ;;
    --hashes-out) OUT=$2; shift 2 ;;
    --timeout) TIMEOUT=$2; shift 2 ;;
    --) shift; break ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
SIGNER=("$@")
for v in TXS RPC CONFIRM MAXFEE TIP OUT; do [ -n "${!v}" ] || { echo "missing --$(echo "$v" | tr 'A-Z' 'a-z')" >&2; exit 2; }; done
[ ${#SIGNER[@]} -gt 0 ] || { echo "signer arguments are required after --" >&2; exit 2; }
[[ "$MAXFEE" =~ ^[1-9][0-9]*$ && "$TIP" =~ ^[0-9]+$ ]] || { echo "fees must be decimal wei" >&2; exit 2; }
[ "$TIP" -le "$MAXFEE" ] || { echo "the priority fee exceeds the max fee" >&2; exit 2; }
[ -e "$OUT" ] && { echo "$OUT exists; refusing to append to an old run" >&2; exit 1; }

field() { node -e 'const t=require(require("path").resolve(process.argv[1]));const v=process.argv[2].split(".").reduce((o,k)=>o[k],t);console.log(typeof v==="object"?JSON.stringify(v):String(v))' "$TXS" "$1"; }
[ "$(field domain)" = postern.dex.raw-txs.v1 ] || { echo "not a raw transaction file" >&2; exit 1; }
[ "$(field configSha256)" = "$CONFIRM" ] || { echo "--confirm does not match the file's configSha256 $(field configSha256)" >&2; exit 1; }
CHAIN=$(field chainId); FROM=$(field from); COUNT=$(node -e 'console.log(require(require("path").resolve(process.argv[1])).transactions.length)' "$TXS")
[ "$(cast chain-id --rpc-url "$RPC")" = "$CHAIN" ] || { echo "RPC chain ID differs from $CHAIN" >&2; exit 1; }
[ "$(cast block 0 --field hash --rpc-url "$RPC")" = "$(field genesisHash)" ] || { echo "RPC genesis differs from $(field genesisHash)" >&2; exit 1; }
SIGNER_ADDRESS=$(cast wallet address "${SIGNER[@]}" | tr 'A-F' 'a-f')
[ "$SIGNER_ADDRESS" = "$FROM" ] || { echo "the signer is $SIGNER_ADDRESS, the file needs $FROM" >&2; exit 1; }
NEED=$(node -e 'const t=require(require("path").resolve(process.argv[1]));console.log(t.transactions.reduce((s,x)=>s+BigInt(x.gasLimit)*BigInt(process.argv[2])+BigInt(x.value),0n).toString())' "$TXS" "$MAXFEE")
HAVE=$(cast balance "$FROM" --rpc-url "$RPC")
node -e 'process.exit(BigInt(process.argv[1])>=BigInt(process.argv[2])?0:1)' "$HAVE" "$NEED" || { echo "balance $HAVE < worst-case cost $NEED" >&2; exit 1; }

for i in $(seq 0 $((COUNT - 1))); do
  NONCE=$(field "transactions.$i.nonce"); TO=$(field "transactions.$i.to"); DATA=$(field "transactions.$i.data")
  GAS=$(field "transactions.$i.gasLimit"); VALUE=$(field "transactions.$i.value"); EXPECT=$(field "transactions.$i.expect"); LABEL=$(field "transactions.$i.label")
  [ "$(cast nonce "$FROM" --block latest --rpc-url "$RPC")" = "$NONCE" ] || { echo "$LABEL: latest nonce is not $NONCE" >&2; exit 1; }
  if [ "$TO" = null ]; then
    [ "$(cast code "$EXPECT" --rpc-url "$RPC")" = 0x ] || { echo "$LABEL: $EXPECT is already occupied" >&2; exit 1; }
    RAW=$(cast mktx --chain "$CHAIN" --nonce "$NONCE" --gas-limit "$GAS" --gas-price "$MAXFEE" --priority-gas-price "$TIP" --value "$VALUE" "${SIGNER[@]}" --create "$DATA")
  else
    RAW=$(cast mktx --chain "$CHAIN" --nonce "$NONCE" --gas-limit "$GAS" --gas-price "$MAXFEE" --priority-gas-price "$TIP" --value "$VALUE" "${SIGNER[@]}" "$TO" "$DATA")
  fi
  HASH=$(cast keccak "$RAW")
  cast publish --rpc-url "$RPC" "$RAW" > /dev/null
  echo "$LABEL nonce $NONCE published $HASH" >&2
  START=$(date +%s)
  while :; do
    RECEIPT=$(cast rpc eth_getTransactionReceipt "$HASH" --rpc-url "$RPC")
    [ "$RECEIPT" != null ] && break
    [ $(( $(date +%s) - START )) -lt "$TIMEOUT" ] || { echo "$LABEL: no receipt after ${TIMEOUT}s ($HASH)" >&2; exit 1; }
    sleep 2
  done
  # The RPC may expose a receipt before its `latest` view reaches that block.
  BLOCK=$(node -e 'console.log(BigInt(JSON.parse(process.argv[1]).blockNumber).toString())' "$RECEIPT")
  until [ "$(cast block-number --rpc-url "$RPC")" -ge "$BLOCK" ]; do sleep 1; done
  STATUS=$(node -e 'console.log(JSON.parse(process.argv[1]).status)' "$RECEIPT")
  [ "$STATUS" = 0x1 ] || { echo "$LABEL: reverted ($HASH)" >&2; exit 1; }
  if [ "$TO" = null ]; then
    CREATED=$(node -e 'console.log(String(JSON.parse(process.argv[1]).contractAddress).toLowerCase())' "$RECEIPT")
    [ "$CREATED" = "$EXPECT" ] || { echo "$LABEL: created $CREATED, planned $EXPECT" >&2; exit 1; }
  elif [ "$EXPECT" != null ] && [ -n "$EXPECT" ]; then
    [ "$(cast code "$EXPECT" --rpc-url "$RPC")" != 0x ] || { echo "$LABEL: nothing was created at the planned $EXPECT" >&2; exit 1; }
  fi
  GASUSED=$(node -e 'console.log(BigInt(JSON.parse(process.argv[1]).gasUsed).toString())' "$RECEIPT")
  echo "$HASH" >> "$OUT"
  echo "$LABEL ok: gasUsed $GASUSED of $GAS${EXPECT:+, at $EXPECT}" >&2
done
echo "published $COUNT transaction(s); hashes in $OUT" >&2
