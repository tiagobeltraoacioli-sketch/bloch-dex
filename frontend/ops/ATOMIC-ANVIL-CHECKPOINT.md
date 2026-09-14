# Atomic Anvil 1.7.1 checkpoints

`atomic_anvil_checkpoint.py` reads only `anvil_dumpState` with params `[false]`
from `127.0.0.1:8547`. The response is hex-encoded gzip containing the full
`SerializableState` JSON. The helper persists that decompressed JSON unchanged;
Anvil consumes it using `--load-state /var/lib/bloch-dex-devnet-v2/state.json`.
Do not combine this with `--state`, `--dump-state` or `--state-interval`: Anvil's
built-in writer would bypass atomic replacement and violate immutable backups.

Format checked against Foundry commit
`4072e48705af9d93e3c0f6e29e93b5e9a40caed8` (Anvil 1.7.1),
[SerializableState](https://github.com/foundry-rs/foundry/blob/4072e48705af9d93e3c0f6e29e93b5e9a40caed8/crates/anvil/src/eth/backend/db.rs)
and [dump_state](https://github.com/foundry-rs/foundry/blob/4072e48705af9d93e3c0f6e29e93b5e9a40caed8/crates/anvil/src/eth/backend/mem/mod.rs).
Current block environment, best block number, accounts, best block header,
transaction records and disabled historical states are structurally checked.
Account-only recovery artifacts are refused. This is structural integrity and
bounded persistence, not independent validation of transaction execution or
state roots. Qualify a new Anvil version and perform an isolated load/restart
test before changing the pinned format.

The RPC operation has a ten-second wall deadline. Both the HTTP JSON body and
decompressed state are limited to 64 MiB. Validation limits accounts to 100,000,
storage slots to 1,000,000 and block/transaction records to 100,000 each. At least
512 MiB free space is required before fetching and before writing. Failure
leaves the current checkpoint untouched before commit; diagnostics contain only
counts, size, digest and a generic failure, never account contents or keys.

`state.json.previous-1` and `state.json.previous-2` retain the preceding files.
The helper locks `.checkpoint.lock`, writes mode 0600 to a fixed same-directory
temporary file, fsyncs it, hardlinks immutable previous files into rotated
backups, fsyncs the directory, and atomically replaces the current filename.
A final directory fsync completes persistence. The fixed temporary names keep
crash debris bounded and are cleaned on the next successful attempt. Symlinks
and unexpected owners are refused. If interrupted during rotation, duplicate
previous snapshots may exist, while the current file remains complete. An error
after the final rename can mean the new complete file is present but its final
directory durability was not confirmed; inspect before restoring.

Install the helper root-owned under `/opt/bloch-dex-devnet/ops/`. The existing
state directory and snapshots must be owned by `bloch-dex-dev:bloch-dex-dev`.
For a user-authorized reset bootstrapped from a known account-only artifact,
the first manual invocation may use `--initial-state-sha256 <verified-digest>`.
It requires that exact initial file and account-only shape, preserves it as
`state.json.initial-accounts`, and atomically installs the newly fetched full
state. The option refuses repeat bootstrap and is never present in the timer.
The preserved account-only file is evidence, not a full-chain rollback checkpoint.
Install `bloch-dex-checkpoint.service` and `.timer`; verify units first. The
oneshot runs as that unprivileged account with 512 MiB memory, CPU 25%, a 90-second
service limit, and only loopback networking. It depends on
`bloch-dex-anvil-v2.service`. The timer runs 60 seconds after boot and 60 seconds
after each completed invocation, without overlapping writers.

```sh
python3 -m unittest discover -s frontend/ops/tests -p test_atomic_anvil_checkpoint.py -v
sudo -u bloch-dex-dev python3 /opt/bloch-dex-devnet/ops/atomic_anvil_checkpoint.py
```

Keep off-host backups separately. Minute checkpoints can lose changes since the
last successful save; two local files do not protect against host loss. Never
reset genesis, select another chain, mint funds or broadcast transactions as a
checkpoint recovery action. Historical pruning is explicit: a checkpoint does
not restore already-pruned historical execution states.

The checked-in `tests/fixtures/anvil-1.7.1-transaction-state.json` is a real
dump from a disposable local Anvil 1.7.1 with one zero-value self-transfer using
its generated test account. It contains public test state and a receipt, no
private keys. The rehearsal verified the entire six-field state, genesis and
successful receipt after restarting with the saved file and fixed timestamp.
The recovered remote testnet was separately restarted with its first full dump:
all 21 accounts, 173 storage slots and its new genesis survived byte-identically
at the decoded state level. No transactions were submitted in that remote check.
