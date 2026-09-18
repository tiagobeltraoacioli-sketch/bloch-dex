# Deployment records

No verified deployment manifest is present. The frontend must remain in preview mode.

A release manifest must include chain ID, genesis block hash, RPC URL, deployment
block/hash, source revision, compiler settings, factory/router/lens/collector and
wrapper addresses, runtime code hashes, pair creation-code hash, fee authority,
treasury, token list, and review evidence. Never use example or zero addresses.

The public Bloch L2 RPC returned chain ID 8400 on 2026-09-11. The scaffold wrapper
address 0x4200000000000000000000000000000000000006 returned empty code. This is
an observation, not verification that the chain is suitable for real funds.

## Closed staging build

`staging.template.json` documents the required shape but is intentionally
invalid: all network and deployment identities are null. Never fill it from an
untrusted RPC response alone or commit credentials. Prepare a separately
reviewed JSON file and run the local preflight:

```sh
node scripts/staging/preflight.mjs --config /path/to/reviewed-staging.json
```

The preflight requires a positive chain ID, nonzero genesis/deployment/pair
hashes, a public HTTPS RPC origin without credentials, query data or a secret
path, and unique nonzero addresses plus runtime-code hashes for the factory, router, lens,
collector and wrapped-native contract. The target must remain `bloch-dex` in
`preview` mode with liquidity explicitly disabled. It performs no RPC, SSH,
wallet or deployment action.

After the reviewed configuration exists and all tracked changes are committed,
build a static bundle and a self-contained artifact manifest:

```sh
node scripts/staging/build.mjs \
  --config /path/to/reviewed-staging.json \
  --output artifacts/bloch-dex-staging.json
```

Configuration validation happens before the frontend build. The build refuses
a dirty tracked worktree and refuses to overwrite an existing manifest. Its
manifest records the exact Git revision, reviewed deployment configuration and
fingerprint, npm lockfile hash, and SHA-256 plus byte length for every static
file. `artifacts/` and `frontend/dist/` are local outputs and remain ignored.
This command does not publish the bundle; host access and release approval are
separate operational steps.

Validate this automation with Node 24:

```sh
node --test scripts/staging/manifest.test.mjs
```
