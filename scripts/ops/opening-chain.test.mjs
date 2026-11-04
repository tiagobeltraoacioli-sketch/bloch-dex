import assert from "node:assert/strict";
import test from "node:test";
import { checkChain } from "./opening-form.mjs";
import { encodeFunctionData, keccak256, parseAbi } from "./dex-ops-lib.mjs";

const address = (byte) => `0x${byte.repeat(40)}`;
const hash = (byte) => `0x${byte.repeat(64)}`;
const code = "0x60006000";
const word = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
const abi = parseAbi([
  "function bucketCapacity() view returns (uint256)",
  "function sourceChainId() view returns (uint256)",
  "function sourceVault() view returns (address)",
]);
const selector = (functionName) => encodeFunctionData({ abi, functionName });
const values = {
  token: address("1"), tokenCodeHash: keccak256(code), bucket: 10_000_000_000n,
  status: { vault: address("2"), vaultCodeHash: keccak256(code) },
};

function providers({ bucket = word(values.bucket), vault = word(values.status.vault), chain = word(1), finalized = { number: "0x20", hash: hash("3") } } = {}) {
  return {
    async l2(method, params) {
      if (method === "eth_getCode") return code;
      assert.equal(method, "eth_call");
      assert.equal(params[0].to, values.token);
      if (params[0].data === selector("bucketCapacity")) {
        if (bucket instanceof Error) throw bucket;
        return bucket;
      }
      if (params[0].data === selector("sourceVault")) return vault;
      if (params[0].data === selector("sourceChainId")) return chain;
      throw new Error("unexpected call selector");
    },
    async eth(method) {
      if (method === "eth_getCode") return code;
      assert.equal(method, "eth_getBlockByNumber");
      return finalized;
    },
  };
}

test("opening chain check accepts the pinned token, source vault and capacity", async () => {
  assert.deepEqual(await checkChain(values, providers()), []);
});

for (const [name, bucket] of [
  ["reverted capacity call", new Error("execution reverted")],
  ["transport failure", new Error("request timed out")],
  ["zero capacity", word(0)],
  ["empty ABI result", "0x"],
  ["non-word ABI result", "0x01"],
  ["extra ABI word", `${word(values.bucket)}${"0".repeat(64)}`],
  ["mismatched capacity", word(values.bucket + 1n)],
]) {
  test(`opening chain check refuses ${name}`, async () => {
    assert.ok((await checkChain(values, providers({ bucket }))).some((p) => /bucketCapacity/.test(p)));
  });
}

test("opening chain check refuses another source vault", async () => {
  assert.ok((await checkChain(values, providers({ vault: word(address("4")) }))).some((p) => /sourceVault/.test(p)));
});

test("opening chain check refuses a source chain other than Ethereum", async () => {
  assert.ok((await checkChain(values, providers({ chain: word(2) }))).some((p) => /sourceChainId/.test(p)));
});

for (const [name, finalized] of [
  ["absent finalized block", null],
  ["empty finalized object", {}],
  ["genesis as finalized", { number: "0x0", hash: hash("3") }],
  ["zero finalized hash", { number: "0x20", hash: hash("0") }],
]) {
  test(`opening chain check refuses ${name}`, async () => {
    assert.ok((await checkChain(values, providers({ finalized }))).some((p) => /finalized/.test(p)));
  });
}
