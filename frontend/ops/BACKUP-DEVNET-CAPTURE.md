# Selected devnet incident backup

`backup_devnet_capture.py` preserves exactly `latest.json`, `previous.json`,
`state.json`, and `faucet.sqlite` from an already captured directory. It never
reads SSH keys, environment files or other adjacent files. Capture SQLite with
its read-only online backup API, not a raw copy while writers may be active.

The archive contains a SHA256 and length manifest. Verification re-reads every
member, checks the exact file set and bounded sizes, parses both account caches,
and runs SQLite `integrity_check` on a disposable copy. Empty or invalid
`state.json` is retained as incident evidence and explicitly reported; a
successful backup does **not** mean the chain can be fully restored.

```sh
python3 backup_devnet_capture.py preserve CAPTURE_DIR /var/lib/postern-backups --keep 7
python3 backup_devnet_capture.py verify /var/lib/postern-backups/capture-SHA256.zip
```

The destination must be private (0700), archives are 0600. Retention accepts
1–30 captures and only removes verified `capture-<64 hex>.zip` files within the
selected dedicated directory. Archive writes and directory entries are fsynced;
identical captures produce the same archive and are verified idempotently.
Unrelated files, symlinks and source files are
never deleted. Corrupt older captures fail retention rather than being deleted.
No automatic service or scheduler is installed. This utility is intended for a
single operator invocation at a time.

The 2026-09-14 incident capture uses the two verified historical account caches
at heights 59887 and 59886. They contain identical account/storage state and
lack full block headers, transactions and receipts. The empty main state dump
is preserved, not repaired. The failed full-tar transfer is not included.
Off-host upload must be followed by verification on the backup host and a
round-trip download with SHA256 comparison. A later restore must independently
validate chain identity and missing history; these backups alone cannot restore
the published chain. No operator SSH private key is copied to the backup host.
A scheduled backup requires separately provisioned, restricted credentials and
monitoring before it can be advertised as operational.
