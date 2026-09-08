# Repository contributions

Use English for code, comments, documentation, commit messages and pull requests.
Keep this repository contracts-only. Do not claim a live deployment or post-quantum
security for EVM accounts and EIP-2612 permits. Bloch L1 authorization remains a
separate post-quantum boundary; these contracts target an explicitly selected EVM
environment. Do not activate protocol fees or deploy contracts as part of a code change.

Pin compiler settings and run `forge test` for contract changes. Preserve the
constant-product invariant and factory-derived pair identity. Add adversarial
tests for security-sensitive changes; never weaken checks to make tests pass.
