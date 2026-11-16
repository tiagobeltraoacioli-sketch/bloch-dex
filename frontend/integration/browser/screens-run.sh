#!/usr/bin/env bash
# Screenshot tooling for the frontend: brings up the rehearsal chain with wallet-hook.sh held (WALLET_HOOK_HOLD) and
# runs screens.mjs against it. Throwaway keys, loopback only; nothing is published anywhere. See screens.mjs for the
# states, the variants and the output.
#
#   frontend/integration/browser/screens-run.sh [--only a,b]          full run: chain up, screenshots, chain down
#   frontend/integration/browser/screens-run.sh --keep [--only a,b]   the same, but the chain and the static server
#                                                                     stay up; prints the work dir, the harness json
#                                                                     and the dist dir
#   frontend/integration/browser/screens-run.sh --shoot <work> [--only a,b] [--variants dark-390,…]
#                                                                     screenshots only, against a kept chain
#                                                                     (= node screens.mjs <work>/wallet-harness.json …)
#   frontend/integration/browser/screens-run.sh --rebuild <work> [--shoot [--only a,b]]
#                                                                     the hook's vite build again, into the same
#                                                                     <work>/dist-wallet (same network and record
#                                                                     files, same _headers adaptation); the static
#                                                                     server serves the new files at once
#   frontend/integration/browser/screens-run.sh --stop <work>         release the hold; waits for the rehearsal to end
#
# Environment:
#   SAFE_ARTIFACTS   @safe-global/safe-contracts@1.4.1 build/artifacts (required to bring the chain up)
#   WALLET_PORT      first of 13 consecutive loopback ports (default 43100; run.mjs uses 28900)
#   SCREENS_OUT      output directory of screens.mjs (default ~/Desktop/BLOCH-L2-DEX-BRIDGE-20261030/agents/318-evidence/screens)
#   SCREENS_WORK     work directory of the rehearsal (default: a new temporary directory)
#   SCREENS_BUILD_RETRIES / SCREENS_BUILD_WAIT   a tree that does not build yet (someone is mid-edit) is tried again:
#                    default 5 times, 60 s apart. The check runs BEFORE the chain is brought up.
#   CHROME_EXE       browser binary (default: Google Chrome on macOS, else chromium/google-chrome)
#   DEX_TOOLS        tool directory used when node/anvil are not on PATH (default ~/.local/share/dex-tools)
#   SCREENS_DYLD_LIBRARY_PATH   macOS: library path the foundry binaries need (default $DEX_TOOLS/libusb/lib when it
#                    exists). /bin/bash is a protected binary and drops DYLD_LIBRARY_PATH, so the rehearsal script
#                    would lose it; small shims of anvil/cast/forge in <work>/toolshim set it again.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
FRONT=$ROOT/frontend
say() { echo "screens-run: $*"; }
die() { echo "screens-run: $*" >&2; exit 2; }

# ---- tools ----
DEX_TOOLS=${DEX_TOOLS:-$HOME/.local/share/dex-tools}
if ! command -v node > /dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]; then
  for d in "$DEX_TOOLS"/node/node-v24*/bin; do [ -x "$d/node" ] && PATH=$d:$PATH; done
fi
command -v node > /dev/null 2>&1 || die "node 24 is not on PATH"
if ! command -v anvil > /dev/null 2>&1; then
  for d in "$DEX_TOOLS/foundry" "$DEX_TOOLS/foundry/bin" "$HOME/.foundry/bin"; do [ -x "$d/anvil" ] && { PATH=$d:$PATH; break; }; done
fi
export PATH
[ -n "${SCREENS_DYLD_LIBRARY_PATH:-}" ] || { [ -d "$DEX_TOOLS/libusb/lib" ] && SCREENS_DYLD_LIBRARY_PATH=$DEX_TOOLS/libusb/lib || true; }
# Shims that give the foundry binaries their library path back (see the header).
toolshim() {
  [ -n "${SCREENS_DYLD_LIBRARY_PATH:-}" ] || return 0
  mkdir -p "$1/toolshim"
  local tool real
  for tool in anvil cast forge; do
    real=$(PATH=${PATH//$1\/toolshim:/} command -v "$tool") || die "$tool is not on PATH"
    printf '#!/bin/sh\nDYLD_LIBRARY_PATH=%q exec %q "$@"\n' "$SCREENS_DYLD_LIBRARY_PATH" "$real" > "$1/toolshim/$tool"
    chmod 700 "$1/toolshim/$tool"
  done
  case ":$PATH:" in *":$1/toolshim:"*) ;; *) PATH=$1/toolshim:$PATH ;; esac
  export PATH
}

# ---- arguments ----
MODE=full; WORK=; SHOOT_AFTER=0; PASS=()
while [ $# -gt 0 ]; do
  case $1 in
    --keep) MODE=keep ;;
    --rebuild | --stop) MODE=${1#--}; WORK=${2:?$1 <work>}; shift ;;
    --shoot) if [ "$MODE" = rebuild ]; then SHOOT_AFTER=1; else MODE=shoot; WORK=${2:?--shoot <work>}; shift; fi ;;
    --only | --variants | --out) PASS+=("$1" "${2:?$1 needs a value}"); shift ;;
    -h | --help) sed -n '2,32p' "$0"; exit 0 ;;
    *) die "unknown argument $1 (see --help)" ;;
  esac
  shift
done
shoot() { nice -n 10 node "$HERE/screens.mjs" "$1/wallet-harness.json" ${PASS[@]+"${PASS[@]}"}; }
held() { [ -f "$1/wallet-harness.json" ] && [ -e "$1/hold" ] || die "$1 is not a kept screens work dir (no wallet-harness.json or the hold was released)"; }

# The hook's build, again (wallet-hook.sh: same network and record files, same outDir, same _headers adaptation).
rebuild() {
  local work=$1 ev=$1/evidence gateway
  gateway=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).gatewayPort' "$work/wallet-harness.json")
  (cd "$FRONT" && POSTERN_MAINNET_NETWORK=$ev/wallet.frontend.network.json POSTERN_MAINNET_RECORD=$ev/wallet.frontend.record.json \
    nice -n 10 node node_modules/vite/bin/vite.js build --outDir "$work/dist-wallet" --emptyOutDir > "$work/build-wallet.log" 2>&1) || { tail -n 30 "$work/build-wallet.log"; return 1; }
  node -e '
const fs = require("fs"); const f = process.argv[1] + "/_headers";
const before = fs.readFileSync(f, "utf8");
const after = before.replace("https://l2rpc.blochl1.com", process.argv[2]).replace(/; *upgrade-insecure-requests/, "");
if (after === before) throw new Error("the CSP of the built bundle was not adapted to the loopback gateway");
fs.writeFileSync(f, after);' "$work/dist-wallet" "http://127.0.0.1:$gateway"
  # serve.mjs read _headers when it started; the files themselves are read on every request.
  if [ -f "$work/headers.served" ] && ! cmp -s "$work/headers.served" "$work/dist-wallet/_headers"; then
    say "WARNING: _headers changed since the static server started; it still sends the old headers (stop and bring the chain up again to serve the new ones)"
  fi
}

case $MODE in
  stop)
    [ -d "$WORK" ] || die "$WORK is not a directory"
    rm -f "$WORK/hold"
    pid=$(cat "$WORK/rehearsal.pid" 2> /dev/null || true)
    if [ -n "$pid" ]; then
      for _ in $(seq 60); do kill -0 "$pid" 2> /dev/null || break; sleep 1; done
      if kill -0 "$pid" 2> /dev/null; then die "the rehearsal (pid $pid) is still running 60 s after the hold was released; see $WORK/rehearsal.log"; fi
    fi
    if grep -q '^REHEARSAL OK' "$WORK/rehearsal.log" 2> /dev/null; then say "released; the rehearsal ended cleanly ($(grep '^REHEARSAL OK' "$WORK/rehearsal.log"))"; else say "released; the rehearsal did not report OK, see $WORK/rehearsal.log"; exit 1; fi
    exit 0 ;;
  shoot)
    held "$WORK"; shoot "$WORK"; exit $? ;;
  rebuild)
    held "$WORK"
    rebuild "$WORK" || exit 1
    say "rebuilt $WORK/dist-wallet"
    [ "$SHOOT_AFTER" = 1 ] && { shoot "$WORK"; exit $?; }
    exit 0 ;;
esac

# ---- full run and --keep: bring the chain up the way run.mjs does ----
CHROME_EXE=${CHROME_EXE:-}
if [ -z "$CHROME_EXE" ]; then
  for c in '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/google-chrome; do [ -x "$c" ] && { CHROME_EXE=$c; break; }; done
fi
[ -x "$CHROME_EXE" ] || die "no browser found; set CHROME_EXE to a Chrome or Chromium binary"
[ -d "${SAFE_ARTIFACTS:-}/contracts" ] || die "SAFE_ARTIFACTS=<@safe-global/safe-contracts@1.4.1 build/artifacts> is required (docs/OPS-OPENING-KIT.md)"
[ -d "$FRONT/node_modules/viem" ] || die "frontend/node_modules is missing; run \`npm ci --ignore-scripts\` in frontend/ first"
PORT=${WALLET_PORT:-43100}
WORK=${SCREENS_WORK:-$(mktemp -d "${TMPDIR:-/tmp}/postern-screens-work-XXXXXX")}
mkdir -p "$WORK"
WORK=$(cd "$WORK" && pwd)
toolshim "$WORK"
for tool in anvil cast forge; do "$tool" --version > /dev/null 2>&1 || die "$tool does not run (PATH, or SCREENS_DYLD_LIBRARY_PATH on macOS)"; done
for p in "$PORT" $((PORT + 1)) $((PORT + 10)) $((PORT + 11)) $((PORT + 12)); do
  if node -e 'const s = require("net").connect(Number(process.argv[1]), "127.0.0.1"); s.on("connect", () => process.exit(0)); s.on("error", () => process.exit(1));' "$p"; then
    die "port $p is in use; set WALLET_PORT to the first of 13 free consecutive ports"
  fi
done
REVISION=$(git -C "$ROOT" rev-parse HEAD 2> /dev/null || echo "${WALLET_REVISION:-}")
[[ $REVISION =~ ^[0-9a-f]{40}$ ]] || REVISION=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).source.revision' "$ROOT/deployments/mainnet/dex-mainnet.config.json")

# The tree may be mid-edit: check that it builds before the chain is brought up (a failing build inside the hook
# would end the whole rehearsal).
tries=${SCREENS_BUILD_RETRIES:-5}
for attempt in $(seq "$tries"); do
  if (cd "$FRONT" && nice -n 10 node node_modules/vite/bin/vite.js build --outDir "$WORK/dist-check" --emptyOutDir > "$WORK/build-check.log" 2>&1); then break; fi
  [ "$attempt" = "$tries" ] && { tail -n 30 "$WORK/build-check.log"; die "the frontend does not build ($tries attempts)"; }
  say "the frontend does not build yet (attempt $attempt of $tries); waiting ${SCREENS_BUILD_WAIT:-60} s"
  sleep "${SCREENS_BUILD_WAIT:-60}"
done
rm -rf "$WORK/dist-check"

say "revision $REVISION, ports $PORT-$((PORT + 12)), work $WORK"
(
  cd "$ROOT"
  CHROME_EXE=$CHROME_EXE RENDER_HOOK=$HERE/wallet-hook.sh WALLET_EVIDENCE=$WORK/wallet-evidence WALLET_REVISION=$REVISION \
    WALLET_HOOK_HOLD=$WORK/hold BRIDGE_REPO='' HOLD_TOKEN='' \
    nohup nice -n 10 bash scripts/staging/rehearse-mainnet-package.sh anvil "$REVISION" "$PORT" "$WORK" > "$WORK/rehearsal.log" 2>&1 < /dev/null &
  echo $! > "$WORK/rehearsal.pid"
)
PID=$(cat "$WORK/rehearsal.pid")
say "rehearsal started (pid $PID, log $WORK/rehearsal.log); waiting for the hook to hold the chain"
until [ -e "$WORK/hold" ] && [ -f "$WORK/wallet-harness.json" ]; do
  kill -0 "$PID" 2> /dev/null || { tail -n 30 "$WORK/rehearsal.log"; die "the rehearsal ended before the hook held the chain"; }
  sleep 2
done
cp "$WORK/dist-wallet/_headers" "$WORK/headers.served"

status=0
shoot "$WORK" || status=$?

if [ "$MODE" = keep ]; then
  cat <<EOF
screens-run: the chain and the static server stay up (rehearsal pid $PID)
  work dir      $WORK
  harness json  $WORK/wallet-harness.json
  dist dir      $WORK/dist-wallet
  rebuild       $0 --rebuild $WORK
  screenshots   $0 --shoot $WORK [--only a,b]      (or: node $HERE/screens.mjs $WORK/wallet-harness.json [--only a,b])
  stop          $0 --stop $WORK
EOF
  exit "$status"
fi
rm -f "$WORK/hold"
wait_status=0
for _ in $(seq 60); do kill -0 "$PID" 2> /dev/null || break; sleep 1; done
kill -0 "$PID" 2> /dev/null && { say "the rehearsal (pid $PID) is still running 60 s after the hold was released"; wait_status=1; }
grep -q '^REHEARSAL OK' "$WORK/rehearsal.log" || { tail -n 20 "$WORK/rehearsal.log"; say "the rehearsal did not report OK"; wait_status=1; }
[ "$wait_status" = 0 ] && say "the rehearsal ended cleanly; work dir $WORK"
[ "$status" = 0 ] && exit "$wait_status"
exit "$status"
