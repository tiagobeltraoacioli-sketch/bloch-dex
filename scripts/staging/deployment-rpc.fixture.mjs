// Synthetic deployment RPC responses only. No deployed contracts or finality.
import { createRequire } from "node:module";
const requireFromFrontend = createRequire(
  new URL("../../frontend/package.json", import.meta.url),
);
const { keccak256 } = requireFromFrontend("viem");
export const hash = (byte) => `0x${byte.repeat(64)}`;
export const address = (byte) => `0x${byte.repeat(40)}`;
const code = Object.freeze({
  factory: "0x6001",
  router: "0x6002",
  lens: "0x6003",
  collector: "0x6004",
  wrappedNative: "0x6005",
  busdc: "0x6006",
  feeAuthority: "0x",
  treasury: "0x",
});
const identity = (name, byte) => ({
  address: address(byte),
  runtimeCodeHash: keccak256(code[name]),
});

export function valid() {
  return {
    schemaVersion: 5,
    environment: "staging",
    host: "bloch-dex",
    frontendMode: "preview",
    liquidityEnabled: false,
    activation: {
      chainIdentityQualified: false,
      finalityQualified: false,
      deploymentQualified: false,
      executionEnabled: false,
      liquidityEnabled: false,
    },
    chain: {
      id: 700771,
      genesisHash: hash("1"),
      rpcUrl: "https://rpc.invalid/",
    },
    deployment: {
      blockNumber: 32,
      blockHash: hash("2"),
      pairInitCodeHash: hash("3"),
      factory: identity("factory", "1"),
      router: identity("router", "2"),
      lens: identity("lens", "3"),
      collector: identity("collector", "4"),
      wrappedNative: identity("wrappedNative", "5"),
      feeAuthority: identity("feeAuthority", "7"),
      treasury: identity("treasury", "8"),
    },
    tokens: [
      {
        ...identity("wrappedNative", "5"),
        symbol: "WBLCH",
        name: "Wrapped BLCH",
        decimals: 18,
        wrappedNative: true,
        policy: { feeOnTransfer: false, rebasing: false },
      },
      {
        ...identity("busdc", "6"),
        symbol: "bUSDC",
        name: "Bloch USDC",
        decimals: 6,
        wrappedNative: false,
        policy: { feeOnTransfer: false, rebasing: false },
      },
    ],
    assetPlan: {
      blochL1: {
        nativeSymbol: "BLCH",
        evmExecution: false,
        authorizationBoundary: "external-post-quantum",
      },
      bridgeAsset: {
        sourceChain: "ethereum-mainnet",
        sourceChainId: 1,
        sourceSymbol: "USDC",
        sourceTokenAddress: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        destinationSymbol: "bUSDC",
        destinationTokenAddress: address("6"),
      },
      pilotPool: {
        baseSymbol: "BLCH",
        onchainBaseSymbol: "WBLCH",
        quoteSymbol: "bUSDC",
        liquidityEnabled: false,
        maxBaseBaseUnits: "10000000000000000000",
        maxQuoteBaseUnits: "10000000",
        policyCapApproval: {
          path: "approvals/pilot-cap.json",
          sha256: hash("4"),
        },
        requiresSeparateApproval: true,
      },
    },
  };
}

export function rpc(overrides = {}) {
  const config = valid();
  let snapshotReads = 0;
  let finalizedReads = 0;
  const calls = [];
  const codeByAddress = new Map([
    [address("1"), code.factory],
    [address("2"), code.router],
    [address("3"), code.lens],
    [address("4"), code.collector],
    [address("5"), code.wrappedNative],
    [address("6"), code.busdc],
    [address("7"), code.feeAuthority],
    [address("8"), code.treasury],
  ]);
  const request = async (method, params) => {
    calls.push([method, params]);
    if (method === "eth_chainId") return overrides.chainId ?? "0xab163";
    if (method === "eth_getCode")
      return (
        overrides.code?.(params[0], codeByAddress.get(params[0])) ??
        codeByAddress.get(params[0])
      );
    if (params[0] === "0x0")
      return {
        number: "0x0",
        hash: overrides.genesis ?? config.chain.genesisHash,
      };
    if (params[0] === "finalized") {
      finalizedReads += 1;
      return {
        number:
          finalizedReads === 2 && overrides.closingFinalized
            ? overrides.closingFinalized.number
            : (overrides.finalized ?? "0x28"),
        hash:
          finalizedReads === 2 && overrides.closingFinalized
            ? overrides.closingFinalized.hash
            : (overrides.finalizedHash ?? hash("9")),
      };
    }
    snapshotReads += 1;
    return {
      number: "0x20",
      hash:
        snapshotReads === 2 && overrides.closingSnapshot
          ? overrides.closingSnapshot
          : config.deployment.blockHash,
    };
  };
  return { request, calls };
}
