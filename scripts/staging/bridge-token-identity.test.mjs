// Agent 227: the gate compares the bridge token with the bridge's own deployment record (agent 180 L-3).
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  BRIDGE_TOKEN_PIN, checkBridgeRecord, checkMainnetPolicy, runtimeTemplateKeccak, validateBridgePin, verifyBridgeToken,
} from "./bridge-token-identity.mjs";
import { checkBridgePinned } from "./check-finality-gate-mainnet.mjs";
import { planAndRecord, testPin, tokenCode, tokenRpc, tokenViews, SIGNERS, GUARDIANS } from "./bridge-token-identity.fixture.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { keccak256 } = requireFromFrontend("viem");

const TOKEN = `0x${"2".repeat(40)}`;
const GENESIS = `0x${"9".repeat(64)}`;
const BLOCK = `0x${"b".repeat(64)}`;
const FINAL = `0x${"c".repeat(64)}`;
const AT = { blockHash: FINAL, requireCanonical: true };

function gateFor(record, change = () => {}) {
  const g = {
    chain: { id: 700770, genesisHash: GENESIS },
    deployment: {
      tokens: [{ token: record.address, symbol: "bUSDC", codeHash: record.runtimeCodeHash, bridgeBucketCapacity: "10000000000" }],
    },
  };
  change(g);
  return g;
}

function fixture({ planChange = () => {}, viewOverrides = {}, code = tokenCode(), deployedCode } = {}) {
  const { plan, record } = planAndRecord({ token: TOKEN, genesisHash: GENESIS, blockHash: BLOCK, code });
  planChange(plan, record);
  const views = tokenViews(plan.expected, viewOverrides);
  const request = async (method, params) => {
    const r = tokenRpc({ token: TOKEN, code: deployedCode ?? code, views, blocks: { "0x12c": { number: "0x12c", hash: BLOCK } } })(method, params);
    if (r === undefined) throw new Error(`unexpected ${method} ${JSON.stringify(params)}`);
    if (method === "eth_call" || method === "eth_getCode") assert.deepEqual(params[1], AT);
    return r;
  };
  return { plan, record, request };
}

test("the repository pin is the rebuilt V3 token of the bridge RC", () => {
  validateBridgePin(BRIDGE_TOKEN_PIN);
  const t = BRIDGE_TOKEN_PIN.tokens.bUSDC;
  assert.equal(t.contract, "BridgedStablecoinV3");
  assert.equal(t.initCodeKeccak, "0xe560441f37e247e387cebd23bb3dd798a29d34174a9fb19a4bb3877c6c721de7");
  assert.equal(t.runtimeTemplateKeccak, "0x405c2834bea460d321d8a0590ad4189b19238fd0a96c23297667892f51da9ca7");
  assert.equal(t.runtimeLength, 18859);
  assert.equal(t.immutableOffsets.length, 51);
  assert.equal(t.maxPending, 2048);
  assert.deepEqual(t.compiler, { solc: "0.8.24+commit.e11b9ed9", optimizer: { enabled: true, runs: 1 }, evmVersion: "shanghai" });
  assert.deepEqual(t.mainnetPolicy, { signers: 7, threshold: 5, switchThreshold: 6, guardians: 3, cancelQuorum: 2, minLargeMintDelay: 43200, minSwitchDelay: 1209600, maxSupplyCap: "100000000000" });
});

test("the template hash ignores immutables and nothing else", () => {
  const pin = testPin().tokens.bUSDC;
  assert.equal(runtimeTemplateKeccak(tokenCode(["11", "22", "33"]), pin.immutableOffsets), pin.runtimeTemplateKeccak);
  assert.equal(runtimeTemplateKeccak(tokenCode(["44", "55", "66"]), pin.immutableOffsets), pin.runtimeTemplateKeccak);
  assert.notEqual(runtimeTemplateKeccak(tokenCode(["11", "22", "33"], "5c"), pin.immutableOffsets), pin.runtimeTemplateKeccak);
});

test("a token that is its bridge deployment passes, and the report names its signers, guardians and T", async () => {
  const { plan, record, request } = fixture();
  const id = checkBridgeRecord(gateFor(record), { plan, record }, testPin());
  const out = await verifyBridgeToken(id, request, AT, 400n);
  assert.deepEqual(out.signers, SIGNERS);
  assert.deepEqual(out.guardians, GUARDIANS);
  assert.equal(out.threshold, 5);
  assert.equal(out.switchThreshold, 6);
  assert.equal(out.largeMintThreshold, "0");
  assert.equal(out.maxPending, 2048);
  assert.equal(checkMainnetPolicy(id), true);
});

test("static refusals: the record, the plan and the gate file must agree before any RPC call", () => {
  const cases = [
    [(p, r) => (r.configSha256 = `0x${"d0".repeat(32)}`), /another bridge config/],
    [(p, r) => (r.address = `0x${"3".repeat(40)}`), /another address/],
    [(p, r) => (r.runtimeCodeHash = `0x${"3".repeat(64)}`), /code hashes differ/],
    [(p, r) => (r.contract = "BridgedStablecoinV2"), /another contract/],
    [(p, r) => (p.contract.name = r.contract = "BridgedStablecoinV2"), /reviewed build is a BridgedStablecoinV3/],
    [(p) => (p.source.compiler.optimizer.runs = 200), /compiler optimizer/],
    [(p) => (p.source.compiler.evmVersion = "paris"), /compiler evmVersion/],
    [(p) => (p.chain.id = 700771), /another chain/],
    [(p, r) => (r.genesisHash = `0x${"8".repeat(64)}`), /another genesis/],
    [(p) => (p.expected.largeMintThreshold = 1_000_000_000), /T \(largeMintThreshold\) is 1000000000/],
    [(p) => (p.expected.bucketCapacity = 20_000_000_000), /bucket capacity is not the bridge plan's/],
    [(p) => (p.expected.symbol = "wGSMH"), /no reviewed build is pinned for wGSMH/],
    [(p) => (p.expected.guardians[0] = p.expected.signers[0]), /guardian is also a signer/],
    [(p) => (p.expected.signers[1] = p.expected.signers[0]), /signers repeats/],
    [(p) => (p.domain = "something else"), /not a bridge deployment file/],
    [(p, r) => (r.blockHash = "0x"), /deployment block is invalid/],
  ];
  for (const [change, pattern] of cases) {
    const { plan, record } = fixture({ planChange: change });
    const g = gateFor(planAndRecord({ token: TOKEN, genesisHash: GENESIS, blockHash: BLOCK }).record);
    assert.throws(() => checkBridgeRecord(g, { plan, record }, testPin()), pattern, String(change));
  }
});

test("L-3: a look-alike token pinned by hand in the gate file is refused", () => {
  const { plan, record } = fixture();
  // The gate's address and code hash were typed from an RPC: same code, another address.
  const lookAlike = `0x${"4".repeat(40)}`;
  const g = gateFor(record, (x) => (x.deployment.tokens[0].token = lookAlike));
  assert.throws(() => checkBridgeRecord(g, { plan, record }, testPin()), /does not pin the recorded token/);
  const g2 = gateFor(record, (x) => (x.deployment.tokens[0].codeHash = `0x${"5".repeat(64)}`));
  assert.throws(() => checkBridgeRecord(g2, { plan, record }, testPin()), /code hash is not the recorded one/);
});

test("on-chain refusals: any difference from the bridge plan, the reviewed build or T = 0", async () => {
  const other = (list, i, c) => list.map((a, k) => (k === i ? `0x${c.repeat(40)}` : a));
  const cases = [
    [{ viewOverrides: { signers: other(SIGNERS, 3, "6") } }, /signers\(\) differ/],
    [{ viewOverrides: { signers: [...SIGNERS].reverse() } }, /signers\(\) differ/],
    [{ viewOverrides: { guardians: other(GUARDIANS, 0, "6") } }, /guardians\(\) differ/],
    [{ viewOverrides: { guardians: GUARDIANS.slice(0, 2) } }, /guardians\(\) differ/],
    [{ viewOverrides: { threshold: 4 } }, /threshold\(\) is 4/],
    [{ viewOverrides: { switchThreshold: 5 } }, /switchThreshold\(\) is 5/],
    [{ viewOverrides: { cancelQuorum: 1 } }, /cancelQuorum\(\) is 1/],
    [{ viewOverrides: { largeMintThreshold: 1 } }, /largeMintThreshold\(\) is 1/],
    [{ viewOverrides: { largeMintDelay: 60 } }, /largeMintDelay\(\) is 60/],
    [{ viewOverrides: { unpauseThreshold: 5 } }, /unpauseThreshold\(\) is not the switch quorum/],
    [{ viewOverrides: { instantCapacity: 10 } }, /instantCapacity\(\) is not 0/],
    [{ viewOverrides: { MAX_PENDING: 4096 } }, /MAX_PENDING\(\) is not the reviewed value/],
    [{ viewOverrides: { sourceVault: `0x${"8".repeat(40)}` } }, /sourceVault\(\) is/],
    [{ viewOverrides: { sourceRoute: `0x${"0".repeat(63)}1` } }, /sourceRoute\(\) is/],
    [{ deployedCode: tokenCode(["11", "22", "34"]) }, /runtime code is not the recorded one/],
  ];
  for (const [opts, pattern] of cases) {
    const { plan, record, request } = fixture(opts);
    const id = checkBridgeRecord(gateFor(record), { plan, record }, testPin());
    await assert.rejects(verifyBridgeToken(id, request, AT, 400n), pattern, JSON.stringify(opts).slice(0, 80));
  }
});

test("on-chain refusals: code that is not the reviewed build, even when the record agrees with it", async () => {
  const code = tokenCode(["11", "22", "33"], "5c"); // another build: the record was made from it, the pin is not
  const { plan, record, request } = fixture({ code });
  assert.equal(record.runtimeCodeHash, keccak256(code));
  const id = checkBridgeRecord(gateFor(record), { plan, record }, testPin());
  await assert.rejects(verifyBridgeToken(id, request, AT, 400n), /not the reviewed build \(template\)/);
});

test("the deployment block must be finalized and canonical", async () => {
  const { plan, record, request } = fixture();
  const id = checkBridgeRecord(gateFor(record), { plan, record }, testPin());
  await assert.rejects(verifyBridgeToken(id, request, AT, 299n), /deployment block 300 is not finalized/);
  const reorged = async (m, p) => (m === "eth_getBlockByNumber" ? { number: p[0], hash: `0x${"e".repeat(64)}` } : request(m, p));
  await assert.rejects(verifyBridgeToken(id, reorged, AT, 400n), /not on the canonical chain/);
});

test("mainnet policy: 5 of 7 signers, 6 for the switch and unpause, 3 guardians, the bridge minimums, no rehearsal plan", () => {
  const cases = [
    [(p) => (p.expected.threshold = 4), /5 of 7 signers/],
    [(p) => (p.expected.signers = p.expected.signers.slice(0, 3)), /5 of 7 signers/],
    [(p) => (p.expected.switchThreshold = 5), /quorum must be 6/],
    [(p) => (p.expected.guardians = p.expected.guardians.slice(0, 2)), /3 guardians/],
    [(p) => (p.chain.rehearsal = true), /rehearsal bridge plan/],
    // F-L3 (round 15): the bridge line's mainnet minimums.
    [(p) => (p.expected.largeMintDelay = 43199), /mint delay must be at least 43200 s/],
    [(p) => (p.expected.largeMintDelay = 0), /mint delay must be at least 43200 s/],
    [(p) => (p.expected.cancelQuorum = 1), /cancel quorum must be 2/],
    [(p) => (p.expected.cancelQuorum = 0), /cancel quorum must be 2/],
    [(p) => (p.expected.cancelQuorum = 3), /cancel quorum must be 2/],
    [(p) => (p.expected.switchDelay = 1209599), /switch delay must be at least 1209600 s/],
    [(p) => (p.expected.switchDelay = 604800), /switch delay must be at least 1209600 s/],
    [(p) => (p.expected.supplyCap = 100_000_000_001), /supply cap must not exceed 100000000000/],
    [(p) => (p.expected.supplyCap = 9_999_999_999), /below the mint bucket/],
  ];
  // The launch values themselves, and stricter ones, pass.
  for (const change of [() => {}, (p) => (p.expected.largeMintDelay = 86400), (p) => (p.expected.switchDelay = 2419200), (p) => (p.expected.supplyCap = 10_000_000_000)]) {
    const { plan, record } = fixture({ planChange: change });
    assert.equal(checkMainnetPolicy(checkBridgeRecord(gateFor(record), { plan, record }, testPin())), true);
  }
  for (const [change, pattern] of cases) {
    const { plan, record } = fixture({ planChange: change });
    const id = checkBridgeRecord(gateFor(record), { plan, record }, testPin());
    assert.throws(() => checkMainnetPolicy(id), pattern);
  }
});

test("the mainnet gate needs a bridge record for every capped token other than the wrapper", () => {
  const { plan, record } = fixture();
  const g = gateFor(record);
  assert.throws(() => checkBridgePinned(g, undefined), /records are required/);
  assert.throws(() => checkBridgePinned(g, []), /has no bridge deployment record/);
  const two = gateFor(record, (x) =>
    x.deployment.tokens.push({ token: `0x${"6".repeat(40)}`, symbol: "wGSMH", codeHash: `0x${"6".repeat(64)}`, bridgeBucketCapacity: "1000" }));
  assert.throws(() => checkBridgePinned(two, [{ plan, record }]), /wGSMH 0x6+ has no bridge deployment record/);
  assert.equal(checkBridgePinned(g, [{ plan, record }]).length, 1);
});

test("F-L3: a pin without the bridge minimums, or with a cancel quorum the guardians cannot form, is refused", () => {
  for (const [change, pattern] of [
    [(p) => delete p.minLargeMintDelay, /minLargeMintDelay is invalid/],
    [(p) => delete p.minSwitchDelay, /minSwitchDelay is invalid/],
    [(p) => delete p.cancelQuorum, /cancelQuorum is invalid/],
    [(p) => (p.maxSupplyCap = 100000000000), /maxSupplyCap is invalid/],
    [(p) => (p.cancelQuorum = 1), /guardians \/ 2 \+ 1/],
    [(p) => (p.switchThreshold = 4), /signer quorums are inconsistent/],
  ]) {
    const pin = structuredClone(testPin());
    change(pin.tokens.bUSDC.mainnetPolicy);
    assert.throws(() => validateBridgePin(pin), pattern);
  }
});
