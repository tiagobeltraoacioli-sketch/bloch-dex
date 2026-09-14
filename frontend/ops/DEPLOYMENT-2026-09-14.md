# Operations deployment, 2026-09-14

Two existing spare fleet hosts now run `postern-network-watch.service` and
`bloch-rpc-read-gateway.service`, enabled at boot. Private host mappings remain
in the operator inventory outside Git. Existing chain processes and public
routing were preserved.

Both services pin `https://blochdex.com/rpc`, chain ID 84001 and genesis
`0x81e8a274272183bd17f71ece585d03bb7c74d82bd3e7a03b396182c1b0d56edf`
after the operator-authorized testnet relaunch. Earlier configurations are
preserved privately on each host.
The monitor listens only on `127.0.0.1:18600`; the gateway only on
`127.0.0.1:18601`. Neither interface is publicly routed. Gateway publication
requires a reviewed outer proxy with absolute request deadlines.

Remote checks confirmed active/enabled units, zero restarts, loopback listeners,
source checksum matches and the configured resource limits. Each service has a
128 MiB memory cap; monitor CPU quota is 10%, gateway quota 20%. Combined observed
memory use was approximately 26 MB per host.

Initial health checks correctly returned 503 while the original primary was
unavailable. The installed gateway validator rejects transaction submission,
signing, wallet and administrative methods. No transactions were sent.

After recovery, both hosts' monitor and read gateway returned HTTP 200 with
`rpc_healthy: true` (all four services). Each read gateway also forwarded a
read-only genesis query that returned the exact new hash pinned above. The
public edge initially rejected Python's default user agent with HTTP 403; the
shared probe now identifies itself as `PosternNetworkMonitor/1.0`. A transport
regression test checks that header. Chain/genesis verification, TLS validation,
redirect refusal, method restrictions and readiness flags were not relaxed.
All four installed probe copies have SHA-256
`77b7243ca86547622c9ac2a3aa8ea69f4d693dd1611d98cfbbf5ba60ab8a4927`.

These installations provide two monitoring/gateway instances against one primary.
They do not replicate chain state or remove that primary's failure dependency.
They are not bridge attesters or L2 consensus nodes. All bridge, mainnet and
finality readiness flags remain false.

Validation: 35 monitor/probe/gateway tests, four snapshot converter tests,
six backup tests and 11 atomic checkpoint tests passed. Backup retention includes
a regression check that reselecting an older capture cannot delete the selected
archive. See the individual component documents and the
[recovery evidence](RECOVERY-2026-09-14.md) for remaining restoration limits.
