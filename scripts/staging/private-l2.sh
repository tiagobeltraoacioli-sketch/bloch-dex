#!/usr/bin/env bash
# A private, loopback-only Bloch L2 under the mainnet rules (chain 700770,
# the pinned genesis 0x632e45ae…f468), built from the v2 release binaries
# (bloch-l2-produce-dev, bloch-l2-settled-rpc). Rehearsal only: there is no
# L1, no proof and no settlement. Block 1 mints synthetic deposits to
# throwaway addresses; a producer loop includes spooled transactions; the
# `finalize` command writes a follower-status file (schema v2) that marks
# every block up to the head as finalized, so `finalized` and bloch_finality
# can be exercised. Never point a wallet holding value at it.
#
#   PRODUCE_DEV=… SETTLED_RPC=… scripts/staging/private-l2.sh init     WORK ADDR[,ADDR…] [SATS_EACH]
#   PRODUCE_DEV=… SETTLED_RPC=… scripts/staging/private-l2.sh start    WORK PORT
#   PRODUCE_DEV=… SETTLED_RPC=… scripts/staging/private-l2.sh finalize WORK PORT
#                               scripts/staging/private-l2.sh stop     WORK
set -euo pipefail

CMD=${1:?usage: private-l2.sh init|start|finalize|stop WORK ...}
WORK=${2:?WORK directory required}
PINS=$(cd "$(dirname "$0")/../.." && pwd)/deployments/mainnet/700770/pins.json
pin() { node -e 'const p=require(process.argv[1]);console.log(process.argv[2].split(".").reduce((o,k)=>o[k],p))' "$PINS" "$1"; }
DOMAIN=$(pin l2.rulesDomain); GENESIS_TIME=$(pin l2.genesisTime); GENESIS=$(pin l2.genesisHash)
L1_GENESIS=$(pin l1.genesisTime); SLOT_MS=$(( $(pin l1.slotSeconds) * 1000 )); NETPIN=$(pin l1.networkPin)
NET=(--rules mainnet --domain "$DOMAIN" --genesis-time "$GENESIS_TIME")
RULE=1:$L1_GENESIS:$SLOT_MS

head_hash() { "$PRODUCE_DEV" head --target "$WORK/canonical" "${NET[@]}" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).hash)'; }
slot_now() { echo $(( ($(date +%s) - L1_GENESIS) * 1000 / SLOT_MS )); }
anchor() { printf '%064x' "$1"; }

case "$CMD" in
  init)
    ADDRS=${3:?comma-separated recipient addresses required}; SATS=${4:-10000000000}
    [ ! -e "$WORK/canonical" ] || { echo "$WORK/canonical exists" >&2; exit 1; }
    mkdir -p "$WORK/txpool"
    OUT=$("$PRODUCE_DEV" init --target "$WORK/canonical" "${NET[@]}")
    HASH=$(node -e 'console.log(JSON.parse(process.argv[1]).hash)' "$OUT")
    [ "0x$HASH" = "$GENESIS" ] || { echo "genesis 0x$HASH is not the pinned $GENESIS" >&2; exit 1; }
    node -e '
const [addrs, sats] = process.argv.slice(1);
console.log(JSON.stringify(addrs.split(",").map((a, i) => ({ height: 1, tx_index: i, txid: (i + 1).toString(16).padStart(64, "0"),
  vout: 0, sats: Number(sats), recipient: a.toLowerCase() }))));' "$ADDRS" "$SATS" > "$WORK/deposits.json"
    "$PRODUCE_DEV" extend --target "$WORK/canonical" --parent "$HASH" --anchor "$(anchor 1)" --anchor-slot "$(slot_now)" \
      --timestamp-rule "$RULE" --deposits "$WORK/deposits.json" "${NET[@]}" > "$WORK/block1.json"
    echo "private L2 at pinned genesis $GENESIS; block 1 minted $(node -e 'console.log(require(process.argv[1]).length)' "$WORK/deposits.json") deposit(s)"
    ;;
  start)
    PORT=${3:?PORT required}
    [ ! -e "$WORK/rpc.pid" ] || { echo "already started" >&2; exit 1; }
    rm -rf "$WORK/rpc-view"
    nohup nice -n 10 "$SETTLED_RPC" --data-dir "$WORK/canonical" --view-dir "$WORK/rpc-view" --finality-status "$WORK/status.json" \
      --network "$NETPIN" --port "$PORT" --poll-ms 1000 "${NET[@]}" --txpool "$WORK/txpool" < /dev/null > "$WORK/rpc.log" 2>&1 &
    echo $! > "$WORK/rpc.pid"
    (
      N=2
      while [ -e "$WORK/rpc.pid" ]; do
        if compgen -G "$WORK/txpool/*.tx" > /dev/null; then
          "$PRODUCE_DEV" extend --target "$WORK/canonical" --parent "$(head_hash)" --anchor "$(anchor "$N")" --anchor-slot "$(slot_now)" \
            --timestamp-rule "$RULE" --txs "$WORK/txpool" "${NET[@]}" >> "$WORK/producer.log" 2>&1 || echo "extend failed" >> "$WORK/producer.log"
          N=$((N + 1))
        fi
        sleep 1
      done
    ) < /dev/null > /dev/null 2>&1 &
    echo $! > "$WORK/producer.pid"
    for _ in $(seq 60); do
      curl -sf -m 2 -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "http://127.0.0.1:$PORT" > /dev/null && break
      sleep 0.5
    done
    echo "settled RPC on 127.0.0.1:$PORT (pid $(cat "$WORK/rpc.pid")), producer pid $(cat "$WORK/producer.pid")"
    ;;
  finalize)
    PORT=${3:?PORT required}
    RPC=http://127.0.0.1:$PORT
    HEAD=$(cast block-number --rpc-url "$RPC")
    node -e '
const { execFileSync } = require("node:child_process");
const [rpc, head, net, genesis, chain] = process.argv.slice(1);
const settlements = [];
for (let n = 1; n <= Number(head); n++) {
  const b = JSON.parse(execFileSync("cast", ["block", String(n), "--json", "--rpc-url", rpc]).toString());
  settlements.push({ l2_number: n, l2_hash: b.hash, l2_state_root: b.stateRoot, commitment: null, native_slot: null, native_block: null, withdrawals: 0 });
}
const status = { schema: "bloch.l2.native-follower-status.v2", network: net, production_finality: false, chain_id: Number(chain),
  l2_genesis: { hash: genesis, finalized: true }, finalized_settlements: settlements, safe_settlement: null,
  native_finalized_epoch: null, native_finalized_block: null, native_finalized_slot: null, verified_tip: null, verified_blocks: null,
  note: "private rehearsal: synthetic finality, no L1" };
require("fs").writeFileSync(process.argv[6] + ".tmp", JSON.stringify(status));
require("fs").renameSync(process.argv[6] + ".tmp", process.argv[6]);
' "$RPC" "$HEAD" "$NETPIN" "$GENESIS" "$(pin l2.chainId)" "$WORK/status.json"
    for _ in $(seq 30); do
      F=$(cast rpc eth_getBlockByNumber finalized false --rpc-url "$RPC" | node -e 'const b=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(b?BigInt(b.number).toString():"none")')
      [ "$F" = "$HEAD" ] && break
      sleep 1
    done
    echo "finalized block $F (head $HEAD)"
    ;;
  stop)
    for f in producer rpc; do
      if [ -e "$WORK/$f.pid" ]; then P=$(cat "$WORK/$f.pid"); rm -f "$WORK/$f.pid"; kill "$P" 2>/dev/null || true; fi
    done
    sleep 2
    echo "stopped"
    ;;
  *) echo "unknown command $CMD" >&2; exit 2 ;;
esac
