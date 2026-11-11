// Review r15 (agent 309), finding R309-B1, as a regression test (the reviewer's demonstration, commit 665fb6b on
// codex/dex-review-r15-20261110, with the assertions turned to the corrected behaviour).
// On chain 700770 with the pinned genesis only a report of the mainnet wrapper (pinned chain, official Safe hashes,
// 3 of 5, bridge plan and record, launch policy) may lead to a frontend record or be named by a runbook. The generic
// gate library still enables liquidity there without reading the bridged token's signers, guardians or T (it is the
// engine the wrapper calls), so: its command-line tool refuses the pinned genesis, frontend-record.mjs and the page
// refuse its report, and the runbook names the wrapper.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GATE_DOMAIN, SAFE, evaluateFinalityGate } from "./finality-gate.mjs";
import { PINS, checkPinned, checkBridgePinned } from "./check-finality-gate-mainnet.mjs";
import { assembleRecord } from "./frontend-record.mjs";

const { keccak256, toFunctionSelector } = createRequire(new URL("../../frontend/package.json", import.meta.url))("viem");
const addr = (c) => `0x${c.repeat(40)}`;
const hash = (c) => `0x${c.repeat(64)}`;
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const sel = toFunctionSelector;
const GENESIS = PINS.l2.genesisHash; // the real pinned mainnet genesis
const A = { deployer: addr("d"), depositor: `0x${"f1d0".repeat(10)}`, wrapped: addr("1"), busdc: addr("2"), factory: addr("f"), router: addr("3"), lens: addr("4"), pair: addr("e"), safe: addr("7"), singleton: addr("8"), handler: addr("9") };
const CODE = { [A.wrapped]: "0x01", [A.busdc]: "0x02", [A.factory]: "0x0f", [A.router]: "0x03", [A.lens]: "0x04", [A.pair]: "0x0e", [A.safe]: "0x0b", [A.singleton]: "0x5a", [A.handler]: "0x5b" };
const OWNERS = ["a1", "a2", "a3", "a4", "a5"].map((p) => `0x${p.repeat(20)}`);
const TX = hash("a");
const FINAL = { number: "0x12c", hash: hash("b") };
const contract = (address) => ({ address, codeHash: keccak256(CODE[address]) });

function mainnetGateFile() {
  return {
    schemaVersion: 2, domain: GATE_DOMAIN, chain: { id: 700770, genesisHash: GENESIS },
    deployment: {
      deployer: A.deployer, firstDepositor: A.depositor,
      contracts: { wrappedNative: contract(A.wrapped), factory: contract(A.factory), router: contract(A.router), lens: contract(A.lens) },
      pairInitCodeHash: hash("1"), feeTo: A.safe,
      // A "Safe" whose singleton and handler are NOT the official v1.4.1 builds, 2 of 5.
      roles: { blochInc: { ...contract(A.safe), safe: { version: "1.4.1", singleton: contract(A.singleton), fallbackHandler: contract(A.handler), threshold: 2, owners: [...OWNERS] } } },
      reserveCaps: [{ token: A.wrapped, cap: "10000000000000000000" }, { token: A.busdc, cap: "1000000000" }],
      tokens: [{ token: A.busdc, symbol: "bUSDC", codeHash: keccak256(CODE[A.busdc]), bridgeBucketCapacity: "10000000000" }],
      pairs: [{ address: A.pair, token0: A.wrapped, token1: A.busdc, codeHash: keccak256(CODE[A.pair]) }],
      transactions: [TX],
    },
    limits: { maxWrappedReserveCap: "10000000000000000000" },
  };
}

/// A chain that is exactly the gate file's deployment. It records every eth_call selector made on the bUSDC token.
function chain(gate, tokenSelectors) {
  const d = gate.deployment;
  const caps = new Map(d.reserveCaps.map((c) => [c.token, BigInt(c.cap)]));
  const w = (v) => `0x${word(v)}`;
  return async (method, params) => {
    if (method === "eth_chainId") return "0xab162";
    if (method === "bloch_finality") return { finalized: FINAL, trust: "native-ffg" };
    if (method === "eth_getBlockByNumber") return params[0] === "0x0" ? { number: "0x0", hash: GENESIS } : FINAL;
    if (method === "eth_getTransactionReceipt") return { transactionHash: params[0], status: "0x1", from: d.deployer, blockNumber: FINAL.number, blockHash: FINAL.hash };
    if (method === "eth_getCode") return CODE[params[0]] ?? "0x";
    if (method === "eth_getTransactionCount") return "0x0";
    if (method === "eth_getStorageAt") {
      const [, key] = params;
      if (key === SAFE.singletonSlot) return w(A.singleton);
      if (key === SAFE.fallbackHandlerSlot) return w(A.handler);
      return w(0);
    }
    assert.equal(method, "eth_call");
    const { to, data } = params[0];
    const s = data.slice(0, 10);
    if (to === A.busdc) tokenSelectors.push(s);
    if (s === sel("bucketCapacity()")) return w(10_000_000_000n);
    if (s === sel("INIT_CODE_PAIR_HASH()")) return d.pairInitCodeHash;
    if (s === sel("feeTo()")) return w(A.safe);
    if (s === sel("firstDepositor()")) return w(A.depositor);
    if (s === "0xbb75fd60") return w(caps.get(`0x${data.slice(34)}`) ?? 0n); // reserveCap(address)
    if (s === sel("factory()")) return w(A.factory);
    if (s === sel("WBLCH()")) return w(A.wrapped);
    if (s === "0x0dfe1681") return w(A.wrapped);
    if (s === "0xd21220a7") return w(A.busdc);
    if (s === "0xe6a43905") return w(A.pair);
    if (s === "0xd3dc9b31") return `0x${word(caps.get(A.wrapped))}${word(caps.get(A.busdc))}`;
    if (s === sel("totalSupply()")) return w(0);
    if (s === SAFE.selectors.getThreshold) return w(2);
    if (s === SAFE.selectors.getOwners) return `0x${word(32)}${word(OWNERS.length)}${OWNERS.map((o) => word(o)).join("")}`;
    if (s === SAFE.selectors.getModulesPaginated) return `0x${word(64)}${word(1)}${word(0)}`;
    if (s === SAFE.selectors.VERSION) return `0x${word(32)}${word(5)}${Buffer.from("1.4.1").toString("hex").padEnd(64, "0")}`;
    throw new Error(`unexpected call ${s} on ${to}`);
  };
}

test("R309-B1: a generic-gate report for the pinned genesis is refused by the record tool, and the generic command refuses the mainnet gate file", async () => {
  const gate = mainnetGateFile();
  const tokenSelectors = [];
  const report = await evaluateFinalityGate(gate, chain(gate, tokenSelectors)); // what check-finality-gate.mjs runs
  assert.equal(report.decision, "liquidity-enabled");
  assert.equal(report.chainId, 700770);
  assert.equal(report.genesisHash, GENESIS);
  assert.equal(report.bridgeTokens, undefined, "no bridge token was checked");
  assert.equal(report.pinned, undefined, "the report carries no mainnet pin block");
  // The only thing ever asked of the bUSDC token is bucketCapacity(): signers(), guardians(), threshold(),
  // largeMintThreshold() (T) and the reviewed template were never read.
  assert.deepEqual([...new Set(tokenSelectors)], [sel("bucketCapacity()")]);
  // The mainnet wrapper refuses the same file statically, for each of the checks the generic gate skipped.
  const safePlan = { chain: { id: 700770, genesisHash: GENESIS, rehearsal: false }, blochInc: gate.deployment.roles.blochInc, contracts: { proxy: { address: A.safe } } };
  assert.throws(() => checkPinned(gate, safePlan), /Safe proxy code is not the official/);
  assert.throws(() => checkBridgePinned(gate, []), /has no bridge deployment record/);

  // The record tool no longer wraps the generic report into the frontend's "liquidity-enabled" record.
  const plan = { domain: "postern.dex.mainnet-plan.v1", chain: { id: 700770, genesisHash: GENESIS, rehearsal: false }, pairs: gate.deployment.pairs,
    feeTo: A.safe, contracts: { wrappedNative: { address: A.wrapped } }, reserveCaps: gate.deployment.reserveCaps };
  const wrap = (gateReport) => assembleRecord({
    config: { network: { chainId: 700770, genesisHash: GENESIS } }, plan, gateReport,
    infra: { domain: "postern.dex.mainnet-infra-plan.v1", chain: { id: 700770, genesisHash: GENESIS }, contracts: {} },
  });
  assert.throws(() => wrap(report), /not written by the mainnet gate/);
  // The shape the wrapper adds is what is accepted.
  const wrapped = { ...report, pinned: { chainId: 700770, genesisHash: GENESIS, safe: A.safe }, bridgeTokens: [{ symbol: "bUSDC", address: A.busdc }] };
  assert.equal(wrap(wrapped).status, "liquidity-enabled");

  // The generic command itself refuses a gate file for the pinned genesis before it contacts any node.
  const file = join(mkdtempSync(join(tmpdir(), "generic-gate-")), "gate.json");
  writeFileSync(file, JSON.stringify(gate));
  const cli = fileURLToPath(new URL("./check-finality-gate.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [cli, "--config", file, "--rpc", "http://127.0.0.1:9"], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /pinned mainnet genesis.*check-finality-gate-mainnet\.mjs/s);
  assert.equal(run.stdout, "");
  // Another genesis is still served by the generic command (here: refused only because no node answers).
  const other = structuredClone(gate);
  other.chain.genesisHash = hash("9");
  writeFileSync(file, JSON.stringify(other));
  const rehearsal = spawnSync(process.execPath, [cli, "--config", file, "--rpc", "http://127.0.0.1:9"], { encoding: "utf8" });
  assert.equal(rehearsal.status, 1);
  assert.doesNotMatch(rehearsal.stderr, /pinned mainnet genesis/);
});

test("R309-B1: the runbooks and the record tool name the mainnet wrapper for the mainnet gate file", () => {
  const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
  const readiness = read("docs/MAINNET-READINESS.md");
  assert.doesNotMatch(readiness, /check-finality-gate\.mjs --config deployments\/mainnet/);
  assert.match(readiness, /node scripts\/staging\/check-finality-gate-mainnet\.mjs --config deployments\/mainnet\/finality-gate\.mainnet\.json --safe-plan .* --bridge-plan .* --bridge-record .* --rpc <own-node-url>/);
  assert.match(read("scripts/staging/frontend-record.mjs"), /check-finality-gate-mainnet\.mjs/);
  // The page's verifier asks for the wrapper's fields on the pinned genesis.
  assert.match(read("frontend/src/mainnet/config.ts"), /requireMainnetGateReport/);
});
