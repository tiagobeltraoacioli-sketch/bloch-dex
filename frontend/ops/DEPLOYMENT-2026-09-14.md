# Operations deployment, 2026-09-14

Two existing spare fleet hosts now run `postern-network-watch.service` and
`bloch-rpc-read-gateway.service`, enabled at boot. Private host mappings remain
in the operator inventory outside Git. Existing chain processes and public
routing were preserved.

Both services pin `https://blochdex.com/rpc`, chain ID 84001 and genesis
`0xd696c34e864365fffdfe5c758c271e50666e5023d44f036143f20d5f1c8147bb`.
The monitor listens only on `127.0.0.1:18600`; the gateway only on
`127.0.0.1:18601`. Neither interface is publicly routed. Gateway publication
requires a reviewed outer proxy with absolute request deadlines.

Remote checks confirmed active/enabled units, zero restarts, loopback listeners,
source checksum matches and the configured resource limits. Each service has a
128 MiB memory cap; monitor CPU quota is 10%, gateway quota 20%. Combined observed
memory use was approximately 26 MB per host.

Both health endpoints correctly returned 503 because the pinned DEX primary is
unavailable. The installed gateway validator rejects transaction submission,
signing, wallet and administrative methods. No transactions were sent.

These installations provide two monitoring/gateway instances against one primary.
They do not replicate chain state or remove that primary's failure dependency.
They are not bridge attesters or L2 consensus nodes. All bridge, mainnet and
finality readiness flags remain false.

Validation: 35 monitor/probe/gateway tests, four snapshot converter tests and
six backup tests passed. Backup retention includes a regression check that
reselecting an older capture cannot delete the selected archive. See the individual component documents and the
[recovery evidence](RECOVERY-2026-09-14.md) for remaining restoration limits.
