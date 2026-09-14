# Read-only RPC identity and health probe

Run with Python 3 (standard library only). Supply an endpoint and the chain ID
and genesis hash obtained from a separately trusted deployment configuration:

```sh
python3 frontend/ops/probe_rpc.py --endpoint https://YOUR_RPC_HOST \
  --expected-chain-id 84001 \
  --expected-genesis 0x81e8a274272183bd17f71ece585d03bb7c74d82bd3e7a03b396182c1b0d56edf
python3 -m unittest discover -s frontend/ops/tests -v
```

Those example identity values describe the current DEX testnet expectation,
not permission to substitute any reachable endpoint. A server reporting chain
8400 fails this check against 84001. The script has no default endpoint or
identity and does not read browser query parameters or modify application config.

Only `eth_chainId` and `eth_getBlockByNumber` (genesis and latest) are called.
Exit code 0 means all three read-only responses passed validation; exit code 1
means the check failed. The JSON output never includes the endpoint or remote
error text. A successful response is an assertion made by this RPC server,
not independent authentication of consensus. Latest height/hash describe one
observation; they prove neither advancing blocks, freshness nor finality.
`mainnet_ready`, `bridge_ready` and `finality_verified` always remain false.

HTTPS is required except for loopback IP literals used in local testing.
Userinfo, query strings, fragments, redirects, implicit environment proxies,
compressed responses, malformed JSON/RPC and responses over 256 KiB are rejected.
The timeout is per network operation (default 5 seconds, maximum 30), not an
overall wall-clock deadline across all three requests. No credentials are
supported: avoid putting tokens in URL paths or shell history. An operator must
choose the explicit endpoint; do not expose this CLI as an unauthenticated web
service that accepts arbitrary URLs.

Tests use local HTTP fixtures and mocks only. They never contact production or
send transactions, signatures or wallet authorization requests.
