# Read-only network watch service

This Python-standard-library service checks operator-pinned RPC identities and
health. It does not replicate an L2, attest bridge events, sign transactions,
authenticate consensus, or establish block progress/finality. Every report
keeps `bridge_ready`, `mainnet_ready`, and `finality_verified` false, including
when every RPC check passes. Two installations give two observations of the
same source, not independent blockchain validators.

Create an explicit configuration (the endpoint is an operator placeholder):

```json
{
  "interval_seconds": 60,
  "timeout_seconds": 5,
  "targets": [
    {
      "name": "dex-testnet-84001",
      "endpoint": "https://YOUR_RPC_HOST",
      "expected_chain_id": 84001,
      "expected_genesis": "0xd696c34e864365fffdfe5c758c271e50666e5023d44f036143f20d5f1c8147bb"
    }
  ]
}
```

The identity above is the DEX testnet expectation; obtain and verify the correct
identity for each target from its deployment records. Never substitute the older
chain 8400 for 84001. No default endpoint exists. Configuration has 1–8 uniquely
named targets, an integer interval of 30–3600 seconds, and per-operation timeout
greater than zero and at most 5 seconds. Unknown/duplicate JSON fields, invalid
identities and files above 16 KiB are rejected. HTTPS is required except for
loopback IP literals. No authentication or secrets are supported: do not place
tokens in paths. Reports and logs omit source URLs and remote error text.

The service calls the unchanged `probe_rpc.py`: only `eth_chainId` and
`eth_getBlockByNumber` for genesis/latest. Targets run sequentially in disposable
worker processes; each has an overall deadline of `3 * timeout_seconds + 2`
seconds (17 seconds maximum), in addition to the probe's socket timeouts. The
interval begins after a cycle completes, so slow sources never create overlapping
cycles or an increasing worker queue. There is no automatic transaction or
bridge recovery action.

```sh
python3 frontend/ops/monitor_networks.py --config /path/to/config.json \
  --report /existing/writable/directory/latest.json --once
python3 -m unittest discover -s frontend/ops/tests -v
```

`--once` exits 0 only when all configured targets pass, otherwise 1. Without it,
the service repeats. `--serve` enables a GET-only status server bound exclusively
to `127.0.0.1:18600`. `/health` and `/status` return cached JSON (200 when healthy,
503 otherwise). Requests never trigger probes and cannot select URLs or forward
RPC. Unknown paths return 404; other implemented HTTP methods return 405. Do not
publish this loopback interface directly as a public RPC endpoint.

Each process starts pending and overwrites the earlier report before reading its
configuration. Each cycle also starts pending; probe errors become unhealthy,
without carrying forward the previous block sample as success. Persistence uses
a same-directory temporary file, file `fsync`, atomic replacement and directory
`fsync`; files are mode 0600. A storage failure clears cached health and stops the
process. If the filesystem itself cannot accept a replacement, the old file may
remain: **file consumers must enforce `valid_until` and check service liveness**.
They must never trust `rpc_healthy` alone. The status server turns expired success
into `stale`/503 without contacting any source. Per-target `observed_at` describes
sample age; an available RPC is not proof of advancing blocks or source freshness.

For systemd, install `monitor_networks.py` and `probe_rpc.py` together as
root-owned, non-writable files under `/opt/postern-network-watch`. Create the
dedicated system account `postern-watch` with no login shell/home, and a
root-owned `/etc/postern-network-watch/config.json` readable by that group
(0640). Install `postern-network-watch.service` under `/etc/systemd/system/`.
The unit creates its state directory, grants writes only there plus private tmp,
uses no capabilities, limits memory to 128 MiB, CPU to 10%, tasks to 16 and file
descriptors to 128. Verify the unit on the target distro before enabling it.
Outbound HTTPS/DNS and local status connections must remain permitted; there is
no need for incoming public ports. A status request requires local access or an
explicitly authenticated monitoring transport.

Do not duplicate validator keys, activate standby Anvil state as another writer,
reset genesis, or promote a restored chain through this service. Backup recovery,
source finality integration and genuine L2 replication are separate work.
