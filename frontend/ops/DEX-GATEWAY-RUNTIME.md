# DEX gateway runtime dependency

The restricted DEX RPC gateway forwards to `http://127.0.0.1:8547` and listens
on port 80, exposing `/rpc` and `/health`. Its existing origin, method, payload,
concurrency and request-rate restrictions remain unchanged. The faucet code and
database were not modified by this dependency repair.

After the authorized testnet relaunch, the canonical systemd gateway unit must
use these dependencies:

```ini
[Unit]
Requires=bloch-dex-anvil-v2.service
After=network.target bloch-dex-anvil-v2.service
```

Replace the retired `bloch-dex-anvil.service` references in the canonical unit
while preserving its other directives, then run `systemctl daemon-reload` and
start the gateway. Empty `Requires=`/`After=` assignments in a drop-in do not
remove the inherited old dependencies; do not rely on that approach. The
ineffective temporary drop-in from the repair was removed after the canonical
unit was corrected. A copy of the former canonical unit was preserved locally
on the host as `bloch-dex-gateway.service.before-anvil-v2`.

Verify `systemctl show bloch-dex-gateway.service -p Requires -p After -p ActiveState`
references only the current Anvil service, and confirm `/health` before public
RPC checks. This repair changes no G4 forwarding services and exposes no Anvil
administrative API. The gateway still permits only its existing method allowlist;
use a read-only excluded method, such as `anvil_nodeInfo`, to verify denial.
Never test administrative mutation methods against the live endpoint.

## Public read verification after repair

On 2026-09-14, `https://blochdex.com/rpc` returned chain ID 84001 and the
relaunch genesis
`0x81e8a274272183bd17f71ece585d03bb7c74d82bd3e7a03b396182c1b0d56edf`.
All 16 pinned deployed runtime hashes matched, and all seven configured pools
matched the factory and reported positive reserves. A read-only administrative
`anvil_nodeInfo` request was rejected with an unsupported-request error.

Factory lookup confirmed that a **direct tBLCH/tUSDT pair does not exist**.
Read-only router calls returned positive quotes through existing test pools:
1 tBLCH → tUSDC → tUSDT returned 0.919251 tUSDT at that observed state; the reverse
1 tUSDT → tUSDC → tBLCH returned 1.033664134830905458 tBLCH. These are point-in-time
synthetic test-token quotes, not executed swaps, real USDT backing, or Bloch L1
settlement evidence. No transaction, approval, faucet call or mining request was
sent during verification.
