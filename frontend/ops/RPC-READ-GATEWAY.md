# Read-only RPC gateway

This is a bounded HTTP forwarding service to **one explicit primary RPC**. It is
not a full node, consensus replica, bridge verifier, finality service, or independent
source of chain data. Two deployments still depend on the same primary.

Install `rpc_read_gateway.py` and `probe_rpc.py` together in a root-owned,
non-writable `/opt/bloch-rpc-read-gateway/`. The supplied systemd template uses a
dynamic unprivileged user, read-only filesystem, 128 MiB memory maximum and 20%
CPU quota. Configure a root-owned `/etc/bloch-rpc-read-gateway.env` with explicit
`BLOCH_RPC_UPSTREAM` (HTTPS, no credentials/query/fragment), `BLOCH_RPC_CHAIN_ID`
(decimal), and `BLOCH_RPC_GENESIS` (32-byte hex). Obtain these values from reviewed
deployment configuration. Never replace a failing primary with a different chain.
No real endpoint is selected or deployed by this component.

The listener defaults to `127.0.0.1:18601`. Keep it loopback-only behind an
operator-controlled TLS proxy/tunnel with request deadlines and rate limits. Do
not expose the Python HTTP server directly to the public Internet. It sends no
CORS permission headers. Paths and request content are not logged. Endpoints are
never accepted from a request. Python socket timeouts bound idle network operations,
not total streaming duration; the outer proxy must impose wall-clock deadlines.

Startup, failed probes, or identity health older than two probe intervals return
503 for RPC reads. A background thread probes chain ID, genesis and latest block
at startup and every 30 seconds after completion (minimum configured interval 30).
`GET /health` reads cached state only and returns 200/503. It does not probe on
request. A compatible but stalled node can pass; this is not a freshness proof.
All finality, mainnet and bridge readiness flags stay false.

`POST /` accepts one JSON-RPC 2.0 request with an ID; batches and notifications
are rejected. Allowed methods: `eth_chainId`, `eth_blockNumber`,
`eth_getBlockByNumber`, `eth_getBlockByHash`, `eth_getCode`, `eth_getBalance`,
`eth_getTransactionCount`, `eth_getTransactionReceipt`, `eth_call`. Block reads
must request transaction hashes (`false`), not full transaction objects. Only
canonical block quantities and `latest`, `earliest`, `safe`, `finalized` tags
are accepted. `pending`, state overrides, logs, traces, subscriptions and every
send/sign/wallet/admin method are rejected.

`eth_call` requires a destination and explicit nonzero gas capped at 500,000;
calldata is capped at 4 KiB, value must be zero, and only optional `from`, `data`,
`value` fields are supported. No transaction or wallet authorization is generated.
Applications omitting gas must deliberately set a bounded simulation budget.

The server limits input to 64 KiB, output to 256 KiB, active workers to eight,
and forwarding admissions to a global 10 requests/second with burst 20 (including
invalid requests). Body socket timeout is five seconds. Upstream transport reuses
the strict RPC probe: no redirects, proxy environment, compressed responses,
remote error text or credentials. Upstream failures invalidate cached health;
call reverts therefore temporarily close the gate too, a conservative availability
tradeoff. Restoring availability requires a successful identity probe. No balances,
blocks or successful RPC results are fabricated while the primary is unavailable.

Run tests with no remote connections:

```sh
python3 -m unittest discover -s frontend/ops/tests -v
```

Tests use mocked upstreams and loopback HTTP fixtures. Deployment still requires
review of the selected primary, reverse proxy, service resource limits and host
configuration. This template performs no chain activation or bridge deployment.
