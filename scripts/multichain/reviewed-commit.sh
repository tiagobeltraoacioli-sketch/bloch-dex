#!/bin/bash
# Is this copy of the repository exactly the reviewed commit? (review finding R402-4)
#
#   /bin/bash scripts/multichain/reviewed-commit.sh <the 40-digit commit id you received outside the repository>
#
# The id is NOT written anywhere in this repository, on purpose: a commit cannot contain its own id, and a copy of
# the repository that someone altered could state any id it likes. The owner receives the 40 digits outside the
# repository (the integrator's and the coordinator's message; his own Portuguese copy of the guide, which is not in
# the repository) and gives them to this script, which refuses (exit 1, last line starting "reviewed commit: FAIL")
# unless:
#   - the argument is exactly 40 hexadecimal digits in lower case (the guide's placeholder, a short form of seven
#     digits, capitals or a missing argument are refused: nothing can be skipped by leaving the line as printed);
#   - the commit this copy is at (HEAD) is that id, all 40 digits;
#   - no tracked file differs from that commit (nothing edited or staged since).
# The last line is exactly "reviewed commit: PASS <id>" only then.
#
# What it cannot do: a script inside a copy cannot vouch for a copy that was altered to lie, which is why the guide's
# first comparison (before anything from the clone is run) is a line of macOS's own programs, not this script. This
# script is the second comparison, after `git pull`, and adds the check of the files.
# It runs only /usr/bin/git and shell builtins, with an empty environment, and never reads a key.
set -uo pipefail
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
export LC_ALL=C

fail() {
  echo "FAIL $*" >&2
  echo "reviewed commit: FAIL; stop here and run nothing else from this copy" >&2
  exit 1
}

[ $# -eq 1 ] || fail "give exactly one argument: the 40-digit commit id you received outside the repository"
ID="$1"
case "$ID" in
  *[!0-9a-f]* | "") fail "'$ID' is not a commit id: replace it with the 40-digit id you received outside the repository (digits 0-9 and letters a-f, lower case)" ;;
esac
[ "${#ID}" -eq 40 ] || fail "'$ID' has ${#ID} digits; the full commit id has 40 (a short form can be imitated: compare all 40)"

HERE=$(cd "${BASH_SOURCE[0]%/*}" && pwd -P) || fail "cannot find this script's directory"
ROOT=$(cd "$HERE/../.." && pwd -P) || fail "cannot find the repository"
# git with nothing of the caller's environment (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, a pager, a config override).
g() { /usr/bin/env -i HOME="${HOME:-/var/empty}" PATH="$PATH" LC_ALL=C GIT_CONFIG_NOSYSTEM=1 GIT_OPTIONAL_LOCKS=0 /usr/bin/git -C "$ROOT" "$@"; }

TOP=$(g rev-parse --show-toplevel 2>/dev/null) || fail "$ROOT is not a git repository"
[ "$(cd "$TOP" && pwd -P)" = "$ROOT" ] || fail "this script is not at scripts/multichain/ of the repository it is in ($TOP)"
HEAD_ID=$(g rev-parse --verify --quiet 'HEAD^{commit}') || fail "this copy has no commit"
case "$HEAD_ID" in
  *[!0-9a-f]* | "") fail "git printed no commit id" ;;
esac
[ "${#HEAD_ID}" -eq 40 ] || fail "git printed a commit id of ${#HEAD_ID} digits, not 40"
if [ "$HEAD_ID" != "$ID" ]; then
  echo "this copy is at $HEAD_ID" >&2
  echo "you gave        $ID" >&2
  fail "this copy is not the reviewed commit"
fi
CHANGED=$(g status --porcelain --untracked-files=no 2>&1) || fail "git status failed: $CHANGED"
if [ -n "$CHANGED" ]; then
  printf '%s\n' "$CHANGED" | /usr/bin/head -10 >&2
  fail "files of this copy differ from the commit (listed above): take a fresh clone"
fi
echo "reviewed commit: PASS $ID"
