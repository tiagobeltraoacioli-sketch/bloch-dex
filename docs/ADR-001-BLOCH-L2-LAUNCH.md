# ADR 001: Prepare for Bloch L2 EVM

Status: target family accepted by the owner; production configuration pending.
Date: 2026-09-11.

Amendment 2026-09-14: the owner selected L1 BLCH/USDT as the current target,
with USDT ingress from both Ethereum ERC-20 and TRON TRC-20. Future native
stablecoin support is a separate issuance concern. L2 EVM pools remain an
independent execution path.
The Bloch repository now includes `bloch_euvm::ustav::pairs`, an atomic,
jointly PQ-authorized settlement kernel for two registered native assets.
It is not a deployed L1 AMM and does not integrate base BLCH, peg management or
Genesis-4 consensus. No network configuration is approved by this amendment.

The native repository also contains a federated USDT gateway reference with
PQ issuer/quorum authorization, source-specific reserves, replay protection and
snapshot validation. The bridge repository contains the corresponding source
vault and shared wire vectors. These are locally tested components, not an
operational bridge: source finality services, TVM qualification, deployments,
Genesis4 activation, base-BLCH integration and the L1 AMM remain outstanding.
The project is not yet at a liquidity-only launch stage.

The original September 11 selection was Bloch L2 EVM; the amendment above
records the current L1 priority. Historical L2 observations follow.
The public RPC https://l2rpc.posternlabs.com returned eth_chainId 0x20d0 (8400),
eth_blockNumber 0x1b6410, and empty code at the bridge scaffold's wrapper address
0x4200000000000000000000000000000000000006. The DEX README calls 8400 retired;
the L2 source describes 700771 as a placeholder. Neither source is sufficient
as a production deployment manifest. Preserve this discrepancy until resolved.

Preparation defaults: protocol fees off; no production broadcast; no wallet
signing from the sample-data UI; no claim of independent audit. Existing LP
branding is unchanged pending an explicit decision. The collector conversion
policy is unchanged pending a choice between sweep-only and controlled conversion.

Required operator decisions: network genesis identity and release provenance;
verified wrapper address/code and custody implications; fee authority and treasury
custody; conversion policy; legal entity and licensing review; initial token list,
pairs and liquidity; LP branding; external audit provider and budget; public
security contact; swap-only versus liquidity-enabled frontend launch scope.

The audit PDF must distinguish implemented fixes, executed tests, untested
assumptions and remaining launch blockers. Internal AI-assisted review is not
an independent external audit and does not satisfy that release gate.
