import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  createJsonRpcRequest,
  verifyStagingDeployment,
} from "./rpc-verifier.mjs";

const requireFromFrontend = createRequire(
  new URL("../../frontend/package.json", import.meta.url),
);
const { keccak256 } = requireFromFrontend("viem");
const hash = (byte) => `0x${byte.repeat(64)}`;
const address = (byte) => `0x${byte.repeat(40)}`;
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

function valid() {
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

function rpc(overrides = {}) {
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

test("records every identity against one finalized deployment snapshot", async () => {
  const { request, calls } = rpc();
  const result = await verifyStagingDeployment(valid(), request);
  assert.equal(result.domain, "postern.dex.staging-rpc-observation.v1");
  assert.equal(result.snapshot.number, 32);
  assert.equal(result.identities.length, 8);
  assert.deepEqual(
    result.identities.find((item) => item.address === address("5")).labels,
    ["deployment.wrappedNative", "tokens[0]"],
  );
  assert.equal(
    result.identities.find((item) => item.address === address("7")).codeBytes,
    0,
  );
  const codeCalls = calls.filter(([method]) => method === "eth_getCode");
  assert.equal(codeCalls.length, 8);
  assert.ok(codeCalls.every(([, params]) => params[1] === "0x20"));
});

test("fails closed for chain, genesis, finality, bytecode and reorg mismatches", async () => {
  for (const [overrides, pattern] of [
    [{ chainId: "0x1" }, /chain ID/],
    [{ genesis: hash("a") }, /genesis hash/],
    [{ finalized: "0x0" }, /finalized head has not advanced beyond genesis/],
    [
      { finalizedHash: hash("1") },
      /finalized head has not advanced beyond genesis/,
    ],
    [{ finalized: "0x1f" }, /not finalized/],
    [
      {
        code: (target, original) =>
          target === address("2") ? "0x6009" : original,
      },
      /runtime code hash/,
    ],
    [
      {
        code: (target, original) => (target === address("3") ? "0x" : original),
      },
      /has no runtime code/,
    ],
    [{ closingSnapshot: hash("a") }, /snapshot changed/],
    [
      { closingFinalized: { number: "0x27", hash: hash("9") } },
      /finalized head regressed/,
    ],
    [
      { closingFinalized: { number: "0x0", hash: hash("1") } },
      /closing finalized head has not advanced beyond genesis/,
    ],
    [
      { closingFinalized: { number: "0x28", hash: hash("a") } },
      /finalized head changed/,
    ],
  ]) {
    const { request } = rpc(overrides);
    await assert.rejects(verifyStagingDeployment(valid(), request), pattern);
  }
});

test("rejects malformed observations and invalid manifests before trust", async () => {
  const malformed = rpc();
  const request = async (method, params) =>
    method === "eth_chainId" ? "0x014821" : malformed.request(method, params);
  await assert.rejects(verifyStagingDeployment(valid(), request), /canonical/);

  const invalid = valid();
  invalid.liquidityEnabled = true;
  let called = false;
  await assert.rejects(
    verifyStagingDeployment(invalid, async () => {
      called = true;
    }),
    /liquidity must remain disabled/,
  );
  assert.equal(called, false);
});

test("same-height finality must identify the deployment block before code reads", async () => {
  const config = valid();
  const matching = rpc({finalized:"0x20", finalizedHash:config.deployment.blockHash});
  const result = await verifyStagingDeployment(config, matching.request);
  assert.deepEqual(result.finalizedBefore, result.snapshot);
  assert.deepEqual(result.finalizedAfter, result.snapshot);

  const conflicting = rpc({finalized:"0x20", finalizedHash:hash("a")});
  await assert.rejects(
    verifyStagingDeployment(config, conflicting.request),
    /finalized head conflicts with the deployment snapshot/,
  );
  assert.equal(conflicting.calls.some(([method]) => method === "eth_getCode"), false);
});

test("closing same-height finality conflicts and zero finalized hashes are refused", async () => {
  const config = valid();
  const changed = rpc({
    finalized:"0x20",
    finalizedHash:config.deployment.blockHash,
    closingFinalized:{number:"0x20", hash:hash("a")},
  });
  await assert.rejects(
    verifyStagingDeployment(config, changed.request),
    /closing finalized head conflicts with the deployment snapshot/,
  );
  for (const overrides of [
    {finalizedHash:hash("0")},
    {closingFinalized:{number:"0x28", hash:hash("0")}},
  ]) {
    const {request} = rpc(overrides);
    await assert.rejects(verifyStagingDeployment(config, request), /hash is invalid or zero/);
  }
});

test("JSON-RPC transport binds concurrent response IDs and bounds bodies", async () => {
  const fetchImpl = async (_url, options) => {
    const payload = JSON.parse(options.body);
    if (payload.id === 1)
      await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: payload.id,
        result: payload.method,
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  const request = createJsonRpcRequest("https://rpc.invalid/", { fetchImpl });
  assert.deepEqual(
    await Promise.all([request("first", []), request("second", [])]),
    ["first", "second"],
  );

  const oversized = createJsonRpcRequest("https://rpc.invalid/", {
    fetchImpl: async () =>
      new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": "1048577",
        },
      }),
  });
  await assert.rejects(oversized("large", []), /too large/);
});
