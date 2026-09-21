# BLCH/bUSDC pilot-pool readiness

`scripts/staging/check-pilot-readiness.mjs` is the final read-only composition
gate before a separately operated initial-liquidity ceremony. It never connects
to RPC, signs, broadcasts, creates a pool, enables the frontend, adds liquidity
or activates a service. A successful report authorizes only the reviewed
ceremony; it does not claim that liquidity was added.

The command accepts one strict `postern.dex.pilot-readiness.v1` bundle and a
separately reviewed local verifier executable pinned by SHA-256. The bundle
must contain all of the following:

1. the disabled-liquidity chain-700771 staging configuration and its finalized
   RPC observation, with every deployed runtime identity reproduced;
2. the authenticated bridge-readiness decision;
3. a separate, fresh `postern.bridge-activation-receipt.v1` proving that the
   bridge was actually activated, finalized and operational on canonical
   Ethereum and Bloch—not merely approved for activation;
4. authenticated DEX deployment controls showing preview mode, liquidity and
   live execution disabled, protocol fees off and no pending fee-authority
   transfer;
5. exactly one factory pool, the canonical WBLCH/bUSDC pair, finalized, empty
   and free of donated token balances or LP supply;
6. the existing canonical cap approval, never above 10 BLCH and 10 bUSDC;
7. separated fee-authority and treasury approvals binding the bridge receipt,
   deployment artifact, pool inspection and rehearsal;
8. a post-activation rehearsal on an isolated finalized fork covering wrap,
   add, swap and remove, the AMM invariant, full snapshot rollback and exact
   reconciliation, with no broadcast or persistent state change.

The bridge receipt binds the exact bridge route and readiness commitment. Its
Ethereum and Bloch activation records must both be canonical and finalized,
deposits/mint/releases must be operational, and `paused` must be false. The
receipt expires after at most 15 minutes. Source or native genesis substitution,
stale receipts, non-final activation, fork drift and a rehearsal timestamp from
before activation are refused.

The pool inspection binds the configured factory, sorted WBLCH/bUSDC token
identities, both registry directions, runtime hash, cap approval and finalized
block. `factoryPairCount` and `pilotPairCount` must both equal one. Reserves,
raw pair balances and LP supply must all be zero before the real ceremony.

The isolated rehearsal amounts and minima are canonical positive integers and
cannot exceed the approved cap. A maximum 15-minute transaction deadline is
enforced. Its before/after values describe the state on each side of the
verified snapshot rollback; this avoids falsely requiring a persistent V2 pair
to undo its permanently locked minimum liquidity.

## Authentication boundary

The complete canonical bundle is passed under
`POSTERN_DEX_PILOT_READINESS_V1` to a regular, single-link,
non-group/world-writable verifier. The checker copies the verified inode to a
private temporary location, checks the operator-supplied SHA-256 pin, bounds
execution time and output, and accepts exactly the lowercase SHA-256 of the
request followed by one newline.

The production verifier must be independently reviewed and package-specific:
it must embed or cryptographically verify the trusted bridge, chain, authority
and rehearsal commitments. In particular, it must authenticate the pool
inspection block hash, its canonicality and the claimed finalized checkpoint;
the structural layer performs no RPC query. A program that merely echoes the
request digest is used only to test transport behavior and is **not** a
production verifier. Hash-shaped fields and true booleans are not authentication
by themselves.

After real retained evidence and the reviewed verifier exist:

```sh
node scripts/staging/check-pilot-readiness.mjs \
  --bundle /private/reviewed/pilot-readiness.json \
  --verifier /opt/postern/bin/pilot-readiness-verifier \
  --verifier-sha256 0xREVIEWED_SHA256
```

Any missing, unknown, mismatched, stale, active, funded or unauthenticated
input exits nonzero and reports all readiness/authorization capabilities false.
Successful output carries both the evaluation time and its time/block expiry;
it is not a durable authorization that can be replayed later.
Even success keeps `liquidityEnabled`, `liquidityAdded`,
`activationPerformed` and `broadcastPerformed` false. This repository contains
no production bundle, bridge activation receipt or production verifier today,
so pilot liquidity is not currently authorized.
