#!/usr/bin/env bash
# Private stack for the DEX end-to-end rehearsal with REAL settled finality:
# 5 validators of a forced native build through relays, the v2.1 settled RPC
# behind the production nginx gateway, follower, settler and real Groth16
# proofs under PROVING.lock. Loopback only (ports 25000-25099), throwaway keys.
# It reuses the L2 drill harness (bloch-l2-evm deployment/mainnet/rehearsal),
# copied to $F/src/rehearsal; `patch` moves it onto this port range.
#
#   stack.sh patch|net|up|down UNIT...|cut|heal|stop|check [--deep]
set -euo pipefail
F=${F:-$HOME/l2dexbridge-20261030/dex-e2e-r3}
export FS=$F DRILL_SETTLER_DIR=$F/src/settler
D="python3 -u $F/src/rehearsal/drills/drillctl.py"
case "${1:?command}" in
  patch)
    cd "$F/src/rehearsal/drills"
    sed -i -e 's/19801 + i/25001 + i/; s/19811 + i/25011 + i/; s/L2_RPC = fs.L2_RPC = 19820/L2_RPC = fs.L2_RPC = 25020/; s/L2_RPC_B = 19821/L2_RPC_B = 25021/; s/RELAY_BASE = 19900/RELAY_BASE = 25030/; s/RELAY_BASE + 16 \* i + j/RELAY_BASE + 5 * i + j/' \
      -e "s#l2dexbridge-20261030/l2-drills#l2dexbridge-20261030/dex-e2e-r3#" drillctl.py
    sed -i -e 's/16\*i/5*i/g; s/16 \* i/5 * i/g; s/16\*/5*/g' relay.py
    grep -n 'RELAY_BASE\|BASE +\|base +' drillctl.py relay.py
    cd "$F/src/public-rpc/tests"
    sed -i -e 's/19671/25071/g; s/19672/25072/g; s/19673/25073/g; s/19674/25074/g; s/19681/25081/g; s/19682/25082/g; s/19691/25091/g; s/19692/25092/g; s/19601/25061/g; s/19602/25062/g' pair.sh
    ;;
  net) $D net; sleep 1; $D l2init ;;
  up) shift; $D up "$@" ;;
  down) shift; $D down "$@" ;;
  check) shift; $D check "$@" ;;
  stop)
    $D stop || true
    [ -f "$F/gateway/a/conf/nginx.pid" ] && "$F/bin/nginx" -p "$F/gateway/a/conf" -c "$F/gateway/a/conf/nginx.conf" -s quit || true
    [ -f "$F/gateway/b/conf/nginx.pid" ] && "$F/bin/nginx" -p "$F/gateway/b/conf" -c "$F/gateway/b/conf/nginx.conf" -s quit || true
    ;;
  *) echo "unknown $1" >&2; exit 2 ;;
esac
