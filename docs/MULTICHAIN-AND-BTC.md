# Ethereum, Arbitrum, Base and BTC markets

## EVM delivery boundary

The preview frontend now recognizes Ethereum (1), Arbitrum One (42161) and Base
(8453), and explicitly requests wallet network switching through EIP-3326. It
verifies `eth_chainId` after the request. Unknown targets are refused; unknown
wallet networks are not automatically added. Only the connected provider is used,
and late results after disconnect are ignored. Conflicting chain events prevent
reporting the requested network as verified.

This is wallet navigation, not a deployed DEX integration. Demo markets, balances
and positions remain illustrative. Before enabling trading, each chain needs a
reviewed manifest containing factory/router identities and code hashes, token
addresses and decimals, deployment block and chain checks. Token identity must
include chain ID and address. Never reuse a symbol or a deployment address across
chains as evidence that a token or router is equivalent. Quotes, approvals and
pending transaction reviews must be invalidated on account/network changes.

Sources checked on 2026-09-15:
- [EIP-3326](https://eips.ethereum.org/EIPS/eip-3326)
- [Arbitrum chain information](https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info)
- [Base RPC overview](https://docs.base.org/base-chain/api-reference/rpc-overview)

## BTC as the Bloch market quote asset

The requested direction is BTC-denominated Bloch markets, including BLCH/BTC and
USDT/BTC. This is a product direction, not an enabled asset or existing bridge.
The current native paired-custody executor fixes BLCH as one pool leg. BLCH/BTC
can use that model after a backed BTC representation exists. Arbitrary token/BTC
markets require a separately reviewed two-native-asset custody/execution path,
including LP accounting, fees in BLCH, wallet intent review and atomic settlement.
The displayed BTC market price must not imply that trading happens on Bitcoin.

A Bitcoin bridge must identify deposits by Bitcoin network plus txid/vout and
validate amount, locking script, inclusion and confirmations against a validated
chain. It must handle reorganizations, duplicate deposits and interrupted scans.
No token may be minted merely because an RPC or explorer reports a transaction.
A Merkle inclusion proof alone does not establish control over custody or guarantee
redemption. See [Bitcoin's block chain guide](https://developer.bitcoin.org/devguide/block_chain.html).

Before activation, settle the custody and redemption design: who can spend the
Bitcoin UTXOs, signing quorum, key recovery, limits, fee funding and failure handling.
A federated design must be labeled as such; PQ signatures on Bloch do not change
Bitcoin's own signing rules. Withdrawal processing must bind the native burn to an
exact Bitcoin destination, reserve funds before creating the payout, and track
replacement transactions/reorganizations without paying the same claim twice.
Reserve accounting must reconcile minted liability, pending redemptions, spendable
BTC and Bitcoin fees. Bitcoin RPC credentials and signing keys must never enter
the frontend or public deployment manifests.

Initial acceptance work should run on Bitcoin regtest with deposit/reorg/replay,
burn/payout/restart and reserve-conservation scenarios before a funded deployment.
No BTC token identifier, deposit address, custody key or mainnet bridge is selected
or activated by the network-selection change.
