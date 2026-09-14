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

## Verified incident preservation record

On 2026-09-14, the selected capture was uploaded to a separate backup host under
`/var/lib/postern-backups` (0700), with archive and verifier mode 0600. Its archive
is `capture-4b045c3ae6989b11acb97b92658df8734eebec1bd859eb93728d3a5fc952164b.zip`
(5,085,259 bytes). Remote verification checked every manifest member and SQLite
integrity, followed by filesystem synchronization. A full download back to the
operator workstation matched archive SHA256
`4b045c3ae6989b11acb97b92658df8734eebec1bd859eb93728d3a5fc952164b`
and passed member verification again.

| Member | Bytes | SHA256 |
| --- | ---: | --- |
| latest.json | 4,741,378 | `2e9229091108c872297374a0d85633c85784b63fbb89dd096b233f08fa3671e5` |
| previous.json | 4,741,300 | `fd794dc00ba7c726bed556c36821b35dab59acfe37b03f421a881621d13e9f0f` |
| state.json | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| faucet.sqlite | 12,288 | `711c4cd4249c5d4c5b51a45f3614b91fde800a0d738b74b4d6a04d4fd5bedab0` |

The deployed verifier source SHA256 is
`56dad20136e11960889cb606087efa7413fa965c15a0f84eb20920ab792ea3df`.
Its six unit tests include round-trip validation, private-file exclusion,
symlink/corruption rejection, scoped retention, idempotence, and preservation of
an older capture when it becomes the current verified target again.
This record attests a single incident backup, not an ongoing scheduler or a
complete-chain recovery. It excludes the separate full-source archive.
