#!/bin/bash
# The owner's own copy of the tools that sign and check the deployment (review finding R369-16).
#
#   /bin/bash scripts/multichain/owner-toolchain.sh install DIR [--from ARCHIVE_DIR] [--no-run] [--platform P]
#   /bin/bash scripts/multichain/owner-toolchain.sh check   DIR [--no-run] [--platform P]
#
# install: DIR must not exist. The publishers' release archives named in owner-toolchain.pins (Foundry, Node.js and,
#   on Intel Macs, the libusb library Foundry loads) are downloaded over HTTPS from the pinned URLs (or copied from
#   ARCHIVE_DIR), each archive's SHA-256 is compared with the pinned value BEFORE anything is unpacked, and DIR is
#   built from them with access for its owner only. It ends with the check below; on any failure DIR is removed.
# check: refuses (exit 1, lines starting FAIL) unless DIR and everything in it is owned by the user running the
#   check and closed to group and others, every pinned program has the pinned SHA-256, the whole directory (every
#   file's SHA-256, every link, every executable bit, every directory name) has the pinned digest, the terminal's
#   PATH is exactly DIR/bin followed by macOS's own /usr/bin, /bin, /usr/sbin, /sbin (review R402-1: no other
#   directory may supply a program to the session), every helper the guide and the kit start by name is found in
#   those four, no variable that redirects or reconfigures a program is set (R402-6, list below), nothing carries
#   an access-control list (R402-7), each program started through its launcher reports the pinned version, and forge
#   reports the pinned compiler inside DIR as the one it will run, offline (R402-2).
#   Hashes and permissions are checked first: nothing in DIR is run before they pass.
#   The last line is exactly "owner tools: PASS" only when every check passed and the programs were run.
#
# This script runs only programs of macOS itself, by absolute path, and never a program from DIR before DIR passed.
# It never reads a key. --no-run and --platform exist for rehearsals (they never print the PASS line of a real
# check): the owner's guide uses neither.
set -uo pipefail
CALLER_PATH="${PATH:-}"
CALLER_ENV=$(/usr/bin/env)
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
unset CDPATH BASH_ENV ENV PERL5LIB PERL5OPT PERLLIB PERL5DB GREP_OPTIONS
IFS=$' \t\n'
export LC_ALL=C
umask 077

HERE=$(cd "${BASH_SOURCE[0]%/*}" && pwd -P) || exit 1
PINS="$HERE/owner-toolchain.pins"
TOOLS="forge cast anvil node npm"
SYSTEM_DIRS="/usr/bin /bin /usr/sbin /sbin"
# Every program the guide's blocks and the kit's scripts start by bare name besides the five tools (deploy.sh:
# dirname, grep, mktemp, rm; lib.mjs: git; the guide: git, pgrep, mkdir, python3; interpreters: bash, sh, env).
# With the PATH rule they can only come from macOS's directories; each is looked up to say so by name.
HELPERS="bash sh env git mkdir pgrep python3 dirname grep mktemp rm cat"
# Variables refused while set in the terminal (the guide's commands need none), and why. The launchers drop the
# same names again right before starting a program. DYLD_* cannot be listed here: macOS removes them before this
# script starts, as it does before each launcher (/bin/sh), which is what keeps them from the programs.
#   NODE_*            NODE_OPTIONS / NODE_PATH load other code; NODE_TLS_REJECT_UNAUTHORIZED=0 and NODE_EXTRA_CA_CERTS
#                     let one network position forge both endpoints of a gate; NODE_COMPILE_CACHE names a code cache
#   npm_config_* NPM_CONFIG_*   another registry or script settings for npm ci
#   FOUNDRY_* DAPP_*  another profile, compiler, RPC or signer default for forge and cast
#   ETH_*             ETH_RPC_URL / ETH_FROM / ETH_KEYSTORE change where and as whom cast sends
#   *_PROXY *_proxy   every HTTPS read and send through a chosen host
#   SSL_CERT_* OPENSSL_CONF SSLKEYLOGFILE   other trust roots, or session keys written to a file
#   GIT_CONFIG* GIT_EXEC_PATH GIT_SSH GIT_SSH_COMMAND GIT_DIR GIT_WORK_TREE   another git program or repository
#   BASH_ENV ENV PYTHONPATH PYTHONSTARTUP PYTHONHOME PERL5LIB PERL5OPT   code run at the start of bash, python3, perl
REFUSED_ENV='^((NODE|NPM|npm|FOUNDRY|DAPP|ETH|SSL_CERT|GIT_CONFIG)_[A-Za-z0-9_]*|[A-Za-z_]*_(PROXY|proxy)|OPENSSL_CONF|SSLKEYLOGFILE|GIT_EXEC_PATH|GIT_SSH|GIT_SSH_COMMAND|GIT_DIR|GIT_WORK_TREE|BASH_ENV|ENV|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|PERL5LIB|PERL5OPT)='

die() {
  echo "FAIL $*" >&2
  echo "owner tools: FAIL; do not use these tools with any key" >&2
  exit 1
}
sha256() { /usr/bin/shasum -a 256 "$1" | /usr/bin/cut -d' ' -f1; }

# pins <kind>: the lines of the pins file for this platform and kind, as "sha256 name url".
pins() {
  /usr/bin/awk -v p="$PLATFORM" -v k="$1" '$1 == p && $2 == k { print $3, $4, $5 }' "$PINS"
}

usage() {
  echo "usage: owner-toolchain.sh install DIR [--from ARCHIVE_DIR] [--no-run] [--platform P] | check DIR [--no-run] [--platform P]" >&2
  exit 2
}

MODE="${1:-}"
ROOT="${2:-}"
[ "$MODE" = install ] || [ "$MODE" = check ] || usage
[ -n "$ROOT" ] || usage
shift 2
FROM=""
RUN=1
PLATFORM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from) [ "$MODE" = install ] && [ $# -ge 2 ] || usage; FROM="$2"; shift 2 ;;
    --no-run) RUN=0; shift ;;
    --platform) [ $# -ge 2 ] || usage; PLATFORM="$2"; shift 2 ;;
    *) usage ;;
  esac
done

[ -f "$PINS" ] && [ ! -L "$PINS" ] || die "the pins file $PINS is missing"
[ "$(/usr/bin/uname -s)" = Darwin ] || die "these pins are for macOS only (this is $(/usr/bin/uname -s))"
case "$(/usr/bin/uname -m)" in
  x86_64) HOST_PLATFORM=darwin-x64 ;;
  arm64) HOST_PLATFORM=darwin-arm64 ;;
  *) die "no pins for the processor $(/usr/bin/uname -m)" ;;
esac
[ -n "$PLATFORM" ] || PLATFORM="$HOST_PLATFORM"
# A rehearsal for another platform cannot run that platform's programs here.
[ "$PLATFORM" = "$HOST_PLATFORM" ] || RUN=0
[ -n "$(pins tree)" ] || die "no pins for the platform $PLATFORM in $PINS"
# The compiler's place inside the tools directory (the one `file` pin under solc/).
SOLC=$(pins file | /usr/bin/awk 'index($2, "solc/") == 1 { print $2 }')
[ -n "$SOLC" ] || die "no compiler pinned for the platform $PLATFORM in $PINS"
case "$ROOT" in
  /*) ;;
  *) die "give the tools directory as an absolute path (got: $ROOT)" ;;
esac
ROOT="${ROOT%/}"
ME=$(/usr/bin/id -u) || exit 1
[ "$ME" != 0 ] || die "do not run this as root"

# The digest of a whole directory: every file's SHA-256 and path, the executable files, every link with its target,
# every directory. Any added, removed, renamed or changed entry changes it.
tree_digest() {
  (
    cd "$1" || exit 1
    {
      /usr/bin/find . -type f -print0 | /usr/bin/sort -z | /usr/bin/xargs -0 /usr/bin/shasum -a 256 || echo "hash-error"
      echo "--- executable"
      /usr/bin/find . -type f -perm -100 -print | /usr/bin/sort
      echo "--- links"
      /usr/bin/find . -type l -print | /usr/bin/sort | while IFS= read -r l; do echo "$l -> $(/usr/bin/readlink "$l")"; done
      echo "--- directories"
      /usr/bin/find . -type d -print | /usr/bin/sort
    } | /usr/bin/shasum -a 256 | /usr/bin/cut -d' ' -f1
  )
}

# check_tree <skip PATH check: 0|1>: prints FAIL lines; returns the number of failures (capped at 1 as status).
check_tree() {
  local skip_path="$1" bad=0 line sum name url actual mode owner dir t found out want entry first ok
  fail() { echo "FAIL $*"; bad=1; }

  if [ -L "$ROOT" ] || [ ! -d "$ROOT" ]; then
    fail "$ROOT is not a directory (or is a link)"
    return 1
  fi
  [ "$(cd "$ROOT" && pwd -P)" = "$ROOT" ] || fail "$ROOT is reached through a link: give its real path ($(cd "$ROOT" && pwd -P))"

  # 1. Owner and access: the directory itself owner-only, nothing inside owned by anyone else or writable by
  #    group or others, every directory above it owned by this user or root and not writable by group or others.
  owner=$(/usr/bin/stat -f '%u' "$ROOT")
  mode=$(/usr/bin/stat -f '%Lp' "$ROOT")
  [ "$owner" = "$ME" ] || fail "$ROOT is owned by user id $owner, not by you (user id $ME)"
  [ "$mode" = 700 ] || fail "$ROOT has access mode $mode; it must be 700 (owner only)"
  dir="$ROOT"
  while [ "$dir" != / ]; do
    dir=$(/usr/bin/dirname "$dir")
    owner=$(/usr/bin/stat -f '%u' "$dir")
    mode=$(/usr/bin/stat -f '%Lp' "$dir")
    [ "$owner" = "$ME" ] || [ "$owner" = 0 ] || fail "the directory $dir above the tools is owned by user id $owner (neither you nor root)"
    case "$mode" in
      *[2367]? | *[2367]) fail "the directory $dir above the tools is writable by group or others (mode $mode)" ;;
    esac
    [ ! -L "$dir" ] || fail "$dir above the tools is a link"
    # An access-control list can grant what the mode bits deny (R402-7): no "allow" entry above the tools.
    out=$(/bin/ls -lde "$dir" | /usr/bin/tail -n +2 | /usr/bin/grep ' allow ' | /usr/bin/head -2)
    [ -z "$out" ] || fail "the directory $dir above the tools has an access-control list that allows: $out"
  done
  out=$(/usr/bin/find "$ROOT" -acl -print 2>&1 | /usr/bin/head -5)
  [ -z "$out" ] || fail "carries an access-control list (remove it with chmod -N, or install again): $out"
  out=$(/usr/bin/find "$ROOT" ! -user "$ME" -print 2>&1 | /usr/bin/head -5)
  [ -z "$out" ] || fail "not owned by you: $out"
  out=$(/usr/bin/find "$ROOT" ! -type l -perm +022 -print 2>&1 | /usr/bin/head -5)
  [ -z "$out" ] || fail "writable by group or others: $out"
  out=$(/usr/bin/find "$ROOT" ! -type f ! -type d ! -type l -print 2>&1 | /usr/bin/head -5)
  [ -z "$out" ] || fail "neither file, directory nor link: $out"
  out=$(/usr/bin/find "$ROOT" -name '*
*' -print 2>&1 | /usr/bin/head -5)
  [ -z "$out" ] || fail "a name with a line break: $out"

  # 2. Every pinned program, by name.
  while read -r sum name url; do
    [ -n "$sum" ] || continue
    if [ -L "$ROOT/$name" ] || [ ! -f "$ROOT/$name" ]; then
      fail "$name is missing (or is a link)"
      continue
    fi
    actual=$(sha256 "$ROOT/$name")
    [ "$actual" = "$sum" ] || fail "$name has SHA-256 $actual; pinned $sum"
  done <<EOF
$(pins file)
EOF

  # 3. The whole directory.
  want=$(pins tree | /usr/bin/cut -d' ' -f1)
  actual=$(tree_digest "$ROOT")
  [ "$actual" = "$want" ] || fail "the directory as a whole has digest $actual; pinned $want (a file was added, removed or changed: remove the directory and install again)"

  # 4. The terminal's PATH: the tools first, then macOS's own four directories, and nothing else; the five programs
  #    are found here, every helper in macOS's directories.
  if [ "$skip_path" = 0 ]; then
    first=1
    while IFS= read -r entry; do
      if [ "$first" = 1 ]; then
        first=0
        [ "$entry" = "$ROOT/bin" ] || fail "this terminal's PATH starts with '$entry', not with $ROOT/bin (paste the PATH line of the guide first)"
        continue
      fi
      ok=0
      for dir in $SYSTEM_DIRS; do [ "$entry" = "$dir" ] && ok=1; done
      [ "$ok" = 1 ] || fail "this terminal's PATH has the entry '$entry': only $ROOT/bin and $SYSTEM_DIRS may be in it (paste the PATH line of the guide)"
    done <<EOF
$(printf '%s\n' "$CALLER_PATH" | /usr/bin/tr ':' '\n')
EOF
    for dir in $SYSTEM_DIRS; do
      owner=$(/usr/bin/stat -f '%u' "$dir")
      mode=$(/usr/bin/stat -f '%Lp' "$dir")
      [ "$owner" = 0 ] && [ ! -L "$dir" ] || fail "$dir is not a directory owned by root"
      case "$mode" in
        *[2367]? | *[2367]) fail "$dir is writable by group or others (mode $mode)" ;;
      esac
    done
    for t in $TOOLS; do
      found=$(PATH="$CALLER_PATH" type -P "$t" || true)
      [ "$found" = "$ROOT/bin/$t" ] || fail "this terminal's PATH finds $t at '${found:-nowhere}', not at $ROOT/bin/$t (paste the PATH line of the guide first)"
    done
    for t in $HELPERS; do
      found=$(PATH="$CALLER_PATH" type -P "$t" || true)
      ok=0
      for dir in $SYSTEM_DIRS; do [ "$found" = "$dir/$t" ] && ok=1; done
      [ "$ok" = 1 ] || fail "this terminal's PATH finds the helper $t at '${found:-nowhere}', not in macOS's own $SYSTEM_DIRS"
    done
    # 5. No variable that redirects or reconfigures a program (the list and the reasons are at the top).
    out=$(printf '%s\n' "$CALLER_ENV" | /usr/bin/grep -E "$REFUSED_ENV" | /usr/bin/cut -d= -f1 | /usr/bin/tr '\n' ' ')
    [ -z "$out" ] || fail "these variables are set in this terminal and must not be (open a new terminal, or unset them): $out"
  fi
  return $bad
}

# run_tools: each program through its launcher, from this script (macOS removes DYLD_* variables when a script
# starts, exactly as when deploy.sh starts forge), compared with the pinned version text.
run_tools() {
  local bad=0 sum name url out repo
  while read -r sum name url; do
    [ -n "$name" ] || continue
    # The pinned text is one of the first three lines of the program's --version, with "_" for each space.
    url=$(echo "$url" | /usr/bin/tr _ ' ')
    out=$("$ROOT/$name" --version 2>&1 </dev/null | /usr/bin/head -3) || true
    if ! printf '%s\n' "$out" | /usr/bin/grep -qxF "$url"; then
      echo "FAIL $ROOT/$name --version does not print the line '$url' (it starts: $(printf '%s' "$out" | /usr/bin/head -1))"
      bad=1
    fi
  done <<EOF
$(pins version)
EOF
  # The compiler forge will run (R402-2): asked of forge itself, in this repository (whose foundry.toml names the
  # version): it must be the pinned file inside the tools directory, with fetching another one switched off.
  repo=$(cd "$HERE/../.." && pwd -P)
  out=$(cd "$repo" && "$ROOT/bin/forge" config --json 2>&1 </dev/null) || true
  if ! printf '%s\n' "$out" | /usr/bin/grep -qxF "  \"solc\": \"$ROOT/$SOLC\","; then
    echo "FAIL forge would not compile with $ROOT/$SOLC: forge config says: $(printf '%s\n' "$out" | /usr/bin/grep '"solc"' | /usr/bin/head -1)"
    bad=1
  fi
  if ! printf '%s\n' "$out" | /usr/bin/grep -qxF '  "offline": true,'; then
    echo "FAIL forge is not offline (it could fetch or pick another compiler)"
    bad=1
  fi
  return $bad
}

verdict() {
  # $1: failures (0|1), $2: skip PATH (0|1)
  if [ "$1" != 0 ]; then
    echo "owner tools: FAIL; do not use these tools with any key"
    return 1
  fi
  if [ "$RUN" = 1 ] && [ "$2" = 0 ]; then
    echo "platform $PLATFORM, directory $ROOT, digest $(pins tree | /usr/bin/cut -d' ' -f1)"
    echo "owner tools: PASS"
  elif [ "$RUN" = 1 ]; then
    echo "owner tools: installed and verified in $ROOT ($PLATFORM); now paste the PATH line and run the check"
  else
    echo "owner tools: HASHES PASS, programs not run (rehearsal: --no-run or another platform); this is not the owner's check"
  fi
  return 0
}

if [ "$MODE" = check ]; then
  bad=0
  check_tree 0 || bad=1
  if [ "$bad" = 0 ] && [ "$RUN" = 1 ]; then run_tools || bad=1; fi
  verdict "$bad" 0
  exit $?
fi

# ------------------------------------------------------------------ install
[ ! -e "$ROOT" ] && [ ! -L "$ROOT" ] || die "$ROOT already exists: the tools go into a NEW directory (to install again, remove it first: it holds nothing but the tools)"
[ -d "$(/usr/bin/dirname "$ROOT")" ] || die "the directory above $ROOT does not exist"
if [ -n "$FROM" ]; then
  [ -d "$FROM" ] || die "--from $FROM is not a directory"
fi
# Every pinned URL is https, checked before anything is fetched or created.
while read -r sum name url; do
  [ -n "$sum" ] || continue
  case "$url" in
    https://*) ;;
    *) die "the pinned URL of $name is not https" ;;
  esac
done <<EOF
$(pins archive)
EOF
/bin/mkdir "$ROOT" || die "cannot create $ROOT"
ROOT=$(cd "$ROOT" && pwd -P)
cleanup() {
  /bin/rm -rf "$ROOT"
  echo "removed $ROOT (nothing was installed)" >&2
}
abort() {
  echo "FAIL $*" >&2
  cleanup
  echo "owner tools: FAIL; do not use these tools with any key" >&2
  exit 1
}
trap 'cleanup; exit 130' INT TERM HUP
IN="$ROOT/.incoming"
/bin/mkdir "$IN" "$ROOT/bin" "$ROOT/foundry" "$ROOT/node" || abort "cannot create the directories"

# 1. The archives: fetched (or copied), then compared with the pins before anything is unpacked.
while read -r sum name url; do
  [ -n "$sum" ] || continue
  if [ -n "$FROM" ]; then
    echo "copy  $FROM/$name"
    /bin/cp "$FROM/$name" "$IN/$name" || abort "cannot copy $FROM/$name"
  else
    echo "fetch $url"
    # ghcr.io (Homebrew's bottles) answers anonymous downloads only with this fixed, public, empty token.
    case "$url" in
      https://ghcr.io/*) /usr/bin/curl -q --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --location --max-redirs 5 --silent --show-error --retry 3 -H 'Authorization: Bearer QQ==' -o "$IN/$name" "$url" || abort "download failed: $url" ;;
      *) /usr/bin/curl -q --proto '=https' --proto-redir '=https' --tlsv1.2 --fail --location --max-redirs 5 --silent --show-error --retry 3 -o "$IN/$name" "$url" || abort "download failed: $url" ;;
    esac
  fi
  actual=$(sha256 "$IN/$name")
  [ "$actual" = "$sum" ] || abort "$name has SHA-256 $actual; pinned $sum (not unpacked)"
  echo "ok    $name sha256 $sum"
done <<EOF
$(pins archive)
EOF

# 2. Unpack: only the named programs of Foundry, Node.js whole, only the library file of libusb.
archive_of() { pins archive | /usr/bin/awk -v r="$1" 'index($2, r) == 1 { print $2 }'; }
A=$(archive_of foundry_)
[ -n "$A" ] || abort "no Foundry archive pinned for $PLATFORM"
/usr/bin/tar -xzf "$IN/$A" -C "$ROOT/foundry" forge cast anvil || abort "cannot unpack $A"
A=$(archive_of node-)
[ -n "$A" ] || abort "no Node.js archive pinned for $PLATFORM"
/usr/bin/tar -xzf "$IN/$A" -C "$ROOT/node" --strip-components 1 || abort "cannot unpack $A"
A=$(archive_of libusb-)
if [ -n "$A" ]; then
  MEMBER=$(pins member | /usr/bin/cut -d' ' -f2)
  [ -n "$MEMBER" ] || abort "no libusb member pinned for $PLATFORM"
  /bin/mkdir "$IN/libusb" "$ROOT/libusb" "$ROOT/libusb/lib" || abort "cannot create the libusb directory"
  /usr/bin/tar -xzf "$IN/$A" -C "$IN/libusb" "$MEMBER" || abort "cannot unpack $MEMBER from $A"
  /bin/mv "$IN/libusb/$MEMBER" "$ROOT/libusb/lib/libusb-1.0.0.dylib" || abort "cannot place the libusb library"
fi
A=$(archive_of solc-)
[ -n "$A" ] || abort "no compiler pinned for $PLATFORM"
/bin/mkdir "$ROOT/solc" || abort "cannot create the compiler's directory"
/bin/mv "$IN/$A" "$ROOT/$SOLC" || abort "cannot place the compiler"
/bin/chmod 700 "$ROOT/$SOLC" || abort "cannot set the compiler's access"
/bin/rm -rf "$IN"

# 3. The launchers (the only files not taken from an archive; their text is fixed here and covered by the pinned
#    digest). /bin/sh is a protected macOS program: starting it drops every DYLD_* variable of the terminal, so a
#    launcher starts its program with exactly the one library path below and nothing injected. The Foundry binaries
#    for Intel Macs look for libusb at a Homebrew path; the launcher points them at this directory's verified copy
#    (on Apple silicon the path does not exist and nothing is loaded from it).
#    Every launcher first drops the variables of REFUSED_ENV that reach a program (R402-6). The forge launcher
#    names the compiler: the pinned file in this directory, and offline, so forge neither uses the copy in the
#    user's Library folder nor fetches one (R402-2).
SCRUB='for v in $(/usr/bin/env | /usr/bin/sed -nE '"'"'s/^((NODE|NPM|npm|FOUNDRY|DAPP|ETH|SSL_CERT|GIT_CONFIG)_[A-Za-z0-9_]*|[A-Za-z_]*_(PROXY|proxy)|OPENSSL_CONF|SSLKEYLOGFILE|GIT_EXEC_PATH|GIT_SSH|GIT_SSH_COMMAND|GIT_DIR|GIT_WORK_TREE|BASH_ENV|ENV|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|PERL5LIB|PERL5OPT)=.*/\1/p'"'"'); do unset "$v"; done'
HEAD='d=$(cd "${0%/*}/.." && pwd -P) || exit 1'
launcher() {
  # $1: name, $2: the last line
  printf '#!/bin/sh\n%s\n%s\n%s\n' "$HEAD" "$SCRUB" "$2" > "$ROOT/bin/$1" || abort "cannot write the launcher of $1"
}
launcher forge "FOUNDRY_SOLC=\"\$d/$SOLC\" FOUNDRY_OFFLINE=true DYLD_LIBRARY_PATH=\"\$d/libusb/lib\" exec \"\$d/foundry/forge\" \"\$@\""
for t in cast anvil; do
  launcher "$t" "DYLD_LIBRARY_PATH=\"\$d/libusb/lib\" exec \"\$d/foundry/$t\" \"\$@\""
done
launcher node 'exec "$d/node/bin/node" "$@"'
launcher npm 'exec "$d/node/bin/node" "$d/node/lib/node_modules/npm/bin/npm-cli.js" "$@"'
/bin/chmod -R go-rwx "$ROOT" || abort "cannot close the directory to group and others"
/bin/chmod 700 "$ROOT" "$ROOT/bin"/* || abort "cannot set the launchers' access"

# 4. The same check the owner runs in every terminal (without the PATH part: the PATH line comes after this).
bad=0
check_tree 1 || bad=1
if [ "$bad" = 0 ] && [ "$RUN" = 1 ]; then run_tools || bad=1; fi
trap - INT TERM HUP
if [ "$bad" != 0 ]; then
  cleanup
  echo "owner tools: FAIL; do not use these tools with any key"
  exit 1
fi
verdict 0 1
