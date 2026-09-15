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

## Initial Bloch L1 markets

### Bridged asset naming

Every asset represented on Bloch from another network must use a lowercase `b`
prefix followed by its registered source symbol: BTC → bBTC, ETH → bETH,
SOL → bSOL, USDC → bUSDC, USDT → bUSDT and LTC → bLTC. BLCH retains its native
symbol. This naming rule applies consistently to wallet, DEX and bridge display
metadata; source-network assets keep their original symbols on the source side.
The launch catalog derives the display symbol from the source asset symbol.

The prefix does not grant issuer approval, establish reserves or change the
underlying asset's controls. bUSDC and bUSDT are included in the development scope; their naming does not
activate deposits or establish an issuer-native deployment. Asset selection still requires the registered native asset
ID and an authenticated source chain, token identity and custody route. Assets
with the same ticker must not be merged; display their network and route when
needed to distinguish them. Existing protocol identifiers and signed payloads
must not be renamed by a display-symbol migration.

### Launch scope

The initial launch scope is **bETH/BLCH, bBTC/BLCH, bSOL/BLCH, bUSDT/BLCH and
bUSDC/BLCH**. The native page lists these five markets as
pending bridge integration, with no funded pool or deposit action.

BLCH remains one leg of each pool, matching the current paired-custody executor.
The `b` symbols name proposed Bloch representations backed by ETH, BTC and SOL;
they are not issuer-native deployments, staking receipts, or existing registered
asset IDs. Each needs a distinct authenticated native registration and source
route, custody, reserves, finality handling and burn-to-payout replay protection.
Symbols alone must never select an asset or authorize a deposit.

Start bETH with native ETH on Ethereum, bBTC with Bitcoin and bSOL with native SOL
on Solana. Additional Ethereum-origin routes through Arbitrum or Base need their
own chain identity, escrow and settlement checks before sharing the bETH supply.
Do not treat token transfer logs as evidence of native ETH or SOL custody, reuse
the six-decimal USDT route ABI for native coins, or relabel an old route's asset.

Start bUSDT and bUSDC with separately registered Ethereum ERC-20 custody routes.
Each route must bind the source chain, exact token contract, decimals, escrow
and destination asset ID. Never interpret a USDC event through a USDT route or
share replay keys across token identities. Source token controls still apply to
custodied tokens; the prefix does not remove freeze or blacklist capabilities.

Amounts need an explicit representation policy before registration. In
particular, the reference native token ledger uses uint64 amounts: copying ETH's
18-decimal units would cap the representable total below 19 ETH. Review a scaled
native denomination or a wider amount type, exact conversion, dust refusal,
withdrawal symmetry and aggregate route caps before enabling bETH. BTC/SOL also
need their own checked native-unit mappings. Display names do not settle this.

A later candidate is **bLTC/BLCH**, subject to a dedicated Litecoin custody and
validation adapter. This is an engineering suggestion, not an enabled additional
market; concentrate initial liquidity and testing on the selected pairs.

Native-asset references:
- [Ethereum: ETH](https://ethereum.org/what-is-ether/)
- [Solana account balances](https://solana.com/docs/core/accounts)
- [Litecoin Core](https://github.com/litecoin-project/litecoin)

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
