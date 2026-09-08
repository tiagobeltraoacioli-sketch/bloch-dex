# PosternDEX

Uniswap-V2-lineage AMM contracts for the Bloch ecosystem: `UniswapV2Factory`,
`UniswapV2Pair`, `UniswapV2ERC20`, the periphery (router/library), and a
`TreasuryFeeCollector` that routes protocol fees to the treasury. Solidity
`^0.8.24`, MIT-licensed, integrated from the three PosternDEX lineages of the
legacy repository into one tree.

## Status — read this first

**There is no EVM execution layer operating on Bloch Genesis-4 today.** Chain
id 8400 refers to a retired legacy scaffold; the successor ("EVM at L1",
ADR-040, alongside the Ustav token charter) is an explicit draft with no live
code on either track. These contracts therefore have **no live Bloch network
to deploy to** — they are prepared, reviewed source awaiting that decision.
Do not deploy against chain id 8400 expecting a current network, and do not
represent this repository as a live product.

The retired swap front-end (`swap-posterndex`) stays in the legacy repo's
attic on purpose; this repository is contracts only.

No audit is claimed. See https://blochprotocol.dev for the current state of
the chain and its developer surface.

## Layout

- `contracts/` — core pair/factory/ERC20, `interfaces/`, `libraries/`,
  `periphery/`, `TreasuryFeeCollector.sol`
