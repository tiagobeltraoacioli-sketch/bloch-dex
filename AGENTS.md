# Repository contributions

Use English for code, comments, documentation, commit messages and pull requests.
Keep contracts in `contracts/` and the approved frontend in `frontend/`.
The frontend is a sample-data preview until a reviewed deployment integration
is implemented. Do not turn wallet connection into signing or fund movement
without an explicit transaction flow and a verified deployment configuration.
Do not claim a live deployment or post-quantum security for EVM accounts and
EIP-2612 permits. Bloch L1 authorization remains a
separate post-quantum boundary; these contracts target an explicitly selected EVM
environment. Do not activate protocol fees or deploy contracts as part of a code change.

Pin compiler settings and run `forge test` for contract changes. Preserve the
constant-product invariant and factory-derived pair identity. Add adversarial
tests for security-sensitive changes; never weaken checks to make tests pass.

For frontend changes, use Node 24 and the committed npm lockfile. Run `npm test`
and `npm run build` from `frontend/`. Keep all visible UI text in English, preserve
the preview labels, and use integer base units for quote arithmetic. Keep wallet
identity separate from demo balances and positions. Do not commit build output,
dependencies, wallet data or credentials. Browser-based responsive and wallet
extension testing is a separate validation step from jsdom interaction tests.
