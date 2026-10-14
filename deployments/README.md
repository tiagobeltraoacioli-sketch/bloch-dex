# Deployment records

The Bloch L2 mainnet deployment procedure (one reviewed config, deterministic
plan, dry run, broadcast, on-chain record, schema-2 finality gate) is in
[docs/MAINNET-READINESS.md](../docs/MAINNET-READINESS.md).

| File | Role |
| --- | --- |
| `networks.json` | Single source of chain IDs: Bloch L2 mainnet `700770`, development chains (devnet4 `700771`, local anvil `31337`) and retired IDs (`8400`, `84001`). Read by `scripts/staging/dex-deploy-config.mjs` and `frontend/src/network-identity.ts`; a Node test keeps `script/DeployMainnet.s.sol` equal to it. |
| `mainnet/dex-mainnet.config.json` | The reviewed mainnet input. Pending decisions are `null` and the tooling refuses them. |

No verified mainnet deployment exists. The frontend must remain in preview mode.

## Removed legacy staging tooling

The closed-staging pipeline built around devnet chain 700771 (the staging
manifest's preflight/build, signed pilot cap approvals, the version-3 launch
gate, the semantic launch package, the disposable-cycle package, pilot-pool
inspection/capture/replay, RPC verification and deployment evidence, plus their
templates and tests) was removed on 2026-10-14. Its limits are now fixed in
the factory constructor and its launch decision is the finality gate, so it was
dead code with hard-coded devnet assumptions. It remains in git history (last
present at commit `84b3f03`).

Kept because the frontend's read-only live staging path still uses it:
`scripts/staging/manifest.mjs` (`validateStagingConfig`, imported by
`scripts/live-auth/envelope.mjs` and the publication-quorum tooling) with its
test and `staging.template.json`. Its staging chain ID now comes from
`networks.json`.

The devnet4 gate (schema 1) and its record are described in
[docs/DEVNET4-REHEARSAL.md](../docs/DEVNET4-REHEARSAL.md).
