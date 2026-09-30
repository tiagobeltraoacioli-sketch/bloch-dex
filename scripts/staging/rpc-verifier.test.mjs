import test from "node:test";
import assert from "node:assert/strict";
import {
  createJsonRpcRequest,
  verifyStagingDeployment,
} from "./rpc-verifier.mjs";

import { hash, address, valid, rpc } from "./deployment-rpc.fixture.mjs";

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
  assert.ok(codeCalls.every(([, params]) => params[1].blockHash === hash("2") && params[1].requireCanonical === true));
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


test("an unsupported canonical hash selector is refused without height fallback", async () => {
  const fixture = rpc(); let codeCalls = 0;
  await assert.rejects(verifyStagingDeployment(valid(), async (method, params) => {
    if (method === "eth_getCode") {
      codeCalls++;
      assert.deepEqual(params[1], {blockHash:hash("2"), requireCanonical:true});
      throw new Error("EIP-1898 unavailable");
    }
    return fixture.request(method, params);
  }), /EIP-1898/);
  assert.equal(codeCalls,1);
});

test("async caller mutation cannot replace the reviewed configuration", async () => {
  const config=valid(), fixture=rpc();
  const result=await verifyStagingDeployment(config,async (method,params)=>{
    config.deployment.blockHash=hash("f");
    config.deployment.router.runtimeCodeHash=hash("e");
    return fixture.request(method,params);
  });
  assert.equal(result.snapshot.hash,hash("2"));
});
