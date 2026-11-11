// Bridge token identity for the DEX finality gate (agent 180 L-3, agent 227).
//
// The gate's token pin (address plus runtime code hash) cannot tell the real
// bUSDC from a look-alike: BridgedStablecoinV3 keeps its signer and guardian
// sets in storage, so a token with the same vault, route and limits but other
// signers has the same code hash. This module takes the token's identity from
// the bridge's own deployment files (`deploy_pontes.py plan` and `record`, bridge
// repo `tools/deploy-pontes`), never from an RPC or a hand-filled field, and
// checks at the gate's finalized block that the token on chain is that one:
//
//   static  plan and record agree (config hash, address, init and runtime code
//           hashes, chain, genesis, contract); they are for the gate's chain;
//           the gate's token entry (address, code hash, bucket) is the record's;
//           the plan's compiler and contract are the reviewed build (pin file);
//           T (largeMintThreshold) is 0.
//   chain   the deployment block is canonical and finalized; the runtime code
//           is the record's, and with its immutables zeroed it is the reviewed
//           template (deployments/mainnet/bridge-token.pin.json); signers(),
//           guardians(), threshold(), switchThreshold(), cancelQuorum(), the
//           limits (T = 0), the source vault, route and chain, the pause policy,
//           instantCapacity() = 0 and MAX_PENDING() equal the plan and the pin.
//
// The mainnet wrapper (check-finality-gate-mainnet.mjs) also applies the
// owner's launch policy from the pin: 5 of 7 signers, 6 for the switch and the
// unpause, 3 guardians, and a non-rehearsal plan.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { keccak256, toFunctionSelector } = requireFromFrontend("viem");

const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const ZERO_HASH = `0x${"0".repeat(64)}`;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
export const BRIDGE_DEPLOY_DOMAIN = "bloch.bridge.mainnet-deploy.v1";
export const BRIDGE_PIN_DOMAIN = "postern.dex.bridge-token-pin.v1";

export const BRIDGE_TOKEN_PIN = Object.freeze(
  JSON.parse(readFileSync(new URL("../../deployments/mainnet/bridge-token.pin.json", import.meta.url), "utf8")),
);

/// Views compared with the plan's `expected` values, as deploy_pontes.py verify reads them.
const UINT_VIEWS = Object.freeze([
  "decimals", "threshold", "pauseDuration", "pauseCooldown",
  "supplyCap", "bucketCapacity", "refillPerSecond", "largeMintThreshold", "largeMintDelay", "minBurn",
  "sourceChainId", "switchThreshold", "switchDelay", "cancelQuorum",
]);
const SEL = Object.freeze(
  Object.fromEntries(
    [...UINT_VIEWS, "sourceVault", "sourceRoute", "signers", "guardians", "instantCapacity", "MAX_PENDING", "unpauseThreshold"].map(
      (name) => [name, toFunctionSelector(`${name}()`)],
    ),
  ),
);

function refuse(condition, message) {
  if (!condition) throw new Error(`finality gate: bridge token: ${message}`);
}

const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);
const lower = (v) => (typeof v === "string" ? v.toLowerCase() : v);
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function addressList(list, field) {
  refuse(Array.isArray(list) && list.length > 0 && list.length <= 16, `${field} must list 1 to 16 addresses`);
  list.forEach((a, i) => refuse(typeof a === "string" && ADDRESS.test(a) && a !== ZERO_ADDRESS, `${field}[${i}] must be a nonzero lowercase address`));
  refuse(new Set(list).size === list.length, `${field} repeats an address`);
  return list;
}

function nonNegativeInteger(v, field) {
  refuse(Number.isSafeInteger(v) && v >= 0, `${field} must be a non-negative integer`);
  return BigInt(v);
}

/// Validate the pin file's shape once; the gate trusts nothing else in it.
export function validateBridgePin(pin = BRIDGE_TOKEN_PIN) {
  refuse(isObject(pin) && pin.schemaVersion === 1 && pin.domain === BRIDGE_PIN_DOMAIN, "the pin file is not a bridge token pin");
  refuse(isObject(pin.tokens) && Object.keys(pin.tokens).length > 0, "the pin file lists no token");
  for (const [symbol, t] of Object.entries(pin.tokens)) {
    refuse(typeof t.contract === "string" && t.contract.length > 0, `pin ${symbol}.contract is invalid`);
    refuse(HASH.test(t.initCodeKeccak) && HASH.test(t.runtimeTemplateKeccak), `pin ${symbol} hashes are invalid`);
    refuse(Number.isSafeInteger(t.runtimeLength) && t.runtimeLength > 0, `pin ${symbol}.runtimeLength is invalid`);
    refuse(
      Array.isArray(t.immutableOffsets) && t.immutableOffsets.length > 0 &&
        t.immutableOffsets.every((o, i) => Number.isSafeInteger(o) && o >= 0 && o + 32 <= t.runtimeLength && (i === 0 || o >= t.immutableOffsets[i - 1] + 32)),
      `pin ${symbol}.immutableOffsets must be sorted, non-overlapping 32-byte slots inside the code`,
    );
    refuse(isObject(t.compiler), `pin ${symbol}.compiler is invalid`);
    refuse(Number.isSafeInteger(t.maxPending) && t.maxPending > 0, `pin ${symbol}.maxPending is invalid`);
    const p = t.mainnetPolicy;
    refuse(isObject(p), `pin ${symbol}.mainnetPolicy is invalid`);
    for (const k of ["signers", "threshold", "switchThreshold", "guardians", "cancelQuorum", "minLargeMintDelay", "minSwitchDelay"]) {
      refuse(Number.isSafeInteger(p[k]) && p[k] > 0, `pin ${symbol}.mainnetPolicy.${k} is invalid`);
    }
    refuse(typeof p.maxSupplyCap === "string" && /^[1-9][0-9]{0,30}$/.test(p.maxSupplyCap), `pin ${symbol}.mainnetPolicy.maxSupplyCap is invalid`);
    // A pin that contradicts itself could never be met, or would accept a quorum the guardians cannot form.
    refuse(p.threshold <= p.signers && p.switchThreshold <= p.signers && p.switchThreshold >= p.threshold, `pin ${symbol}.mainnetPolicy signer quorums are inconsistent`);
    refuse(p.cancelQuorum === Math.floor(p.guardians / 2) + 1, `pin ${symbol}.mainnetPolicy.cancelQuorum must be guardians / 2 + 1`);
  }
  return pin;
}

/// The runtime code with every immutable slot zeroed: the reviewed build's template, whatever the deployment's
/// constructor arguments were.
export function runtimeTemplateKeccak(code, offsets) {
  refuse(typeof code === "string" && /^0x(?:[0-9a-f]{2})+$/.test(code), "runtime code is malformed");
  const hex = code.slice(2).split("");
  for (const o of offsets) {
    for (let i = 2 * o; i < 2 * (o + 32); i++) hex[i] = "0";
  }
  return keccak256(`0x${hex.join("")}`);
}

/// Static checks of one bridge deployment (`plan` and `record` from deploy_pontes.py) against the gate file and the
/// pin. Returns the identity the on-chain check compares with.
export function checkBridgeRecord(gate, { plan, record }, pin = BRIDGE_TOKEN_PIN) {
  validateBridgePin(pin);
  refuse(isObject(plan) && isObject(record), "the bridge plan and record are required");
  refuse(plan.domain === BRIDGE_DEPLOY_DOMAIN && record.domain === BRIDGE_DEPLOY_DOMAIN, "the plan or record is not a bridge deployment file");
  refuse(plan.bridge === "stable" && record.bridge === "stable", "only bridged stablecoins are supported");
  refuse(HASH.test(plan.configSha256) && record.configSha256 === plan.configSha256, "the record is for another bridge config");
  const c = plan.contract;
  refuse(isObject(c) && ADDRESS.test(c.address) && HASH.test(c.runtimeCodeHash) && HASH.test(c.initCodeHash), "plan.contract is invalid");
  refuse(record.address === c.address, "the record is for another address than the plan");
  refuse(record.runtimeCodeHash === c.runtimeCodeHash && record.initCodeHash === c.initCodeHash, "the record's code hashes differ from the plan");
  refuse(record.contract === c.name, "the record names another contract than the plan");
  const t = pin.tokens[plan.expected?.symbol];
  refuse(t, `no reviewed build is pinned for ${plan.expected?.symbol}`);
  refuse(c.name === t.contract, `${plan.expected.symbol} is a ${c.name}, the reviewed build is a ${t.contract}`);
  for (const [k, v] of Object.entries(t.compiler)) {
    const got = JSON.stringify(plan.source?.compiler?.[k]);
    refuse(got === JSON.stringify(v), `the plan's compiler ${k} is ${got}, the reviewed build uses ${JSON.stringify(v)}`);
  }
  // Chain: the plan, the record and the gate name the same chain and genesis.
  refuse(plan.chain?.id === gate.chain.id && record.chainId === gate.chain.id, "the bridge deployment is for another chain than the gate");
  refuse(lower(plan.chain.genesisHash) === gate.chain.genesisHash && lower(record.genesisHash) === gate.chain.genesisHash, "the bridge deployment is for another genesis than the gate");
  refuse(Number.isSafeInteger(record.blockNumber) && record.blockNumber > 0 && HASH.test(record.blockHash), "the record's deployment block is invalid");
  // The gate's token entry comes from this record, not from a hand-filled value.
  const e = plan.expected;
  refuse(isObject(e), "plan.expected is missing");
  const entry = gate.deployment.tokens.find((x) => x.token === c.address);
  refuse(entry, `the gate does not pin the recorded token ${c.address}`);
  refuse(entry.codeHash === record.runtimeCodeHash, "the gate's token code hash is not the recorded one");
  refuse(entry.symbol === e.symbol, `the gate names the token ${entry.symbol}, the bridge plan ${e.symbol}`);
  refuse(entry.bridgeBucketCapacity === String(e.bucketCapacity), "the gate's bucket capacity is not the bridge plan's");
  // T = 0 (owner decision 2026-11-02): every mint queues for the delay and stays cancellable.
  refuse(e.largeMintThreshold === 0, `T (largeMintThreshold) is ${e.largeMintThreshold}, it must be 0`);
  const signers = addressList(e.signers, "plan.expected.signers");
  const guardians = addressList(e.guardians, "plan.expected.guardians");
  refuse(guardians.every((g) => !signers.includes(g)), "a guardian is also a signer");
  for (const k of UINT_VIEWS) nonNegativeInteger(e[k], `plan.expected.${k}`);
  refuse(ADDRESS.test(lower(e.sourceVault)) && HASH.test(lower(e.sourceRoute)), "plan.expected source vault or route is invalid");
  return Object.freeze({
    symbol: e.symbol, address: c.address, runtimeCodeHash: record.runtimeCodeHash, pin: t,
    block: Object.freeze({ number: BigInt(record.blockNumber), hash: lower(record.blockHash) }),
    rehearsal: plan.chain.rehearsal === true,
    expected: Object.freeze({ ...e, signers, guardians, sourceVault: lower(e.sourceVault), sourceRoute: lower(e.sourceRoute) }),
  });
}

/// The owner's launch policy (mainnet only): checked on the plan, and through it on chain.
export function checkMainnetPolicy(identity) {
  const p = identity.pin.mainnetPolicy;
  const e = identity.expected;
  refuse(identity.rehearsal === false, "a rehearsal bridge plan cannot open the mainnet gate");
  refuse(e.signers.length === p.signers && e.threshold === p.threshold, `the token must have ${p.threshold} of ${p.signers} signers, the plan has ${e.threshold} of ${e.signers.length}`);
  refuse(e.switchThreshold === p.switchThreshold, `the switch and unpause quorum must be ${p.switchThreshold}, the plan has ${e.switchThreshold}`);
  refuse(e.guardians.length === p.guardians, `the token must have ${p.guardians} guardians, the plan has ${e.guardians.length}`);
  // The bridge line's mainnet minimums (round 15, F-L3). verifyBridgeToken compares each of these views with the plan
  // on chain, so a figure checked here is the figure of the deployed token.
  refuse(e.cancelQuorum === p.cancelQuorum, `the guardians' cancel quorum must be ${p.cancelQuorum}, the plan has ${e.cancelQuorum}`);
  refuse(e.largeMintDelay >= p.minLargeMintDelay, `the mint delay must be at least ${p.minLargeMintDelay} s, the plan has ${e.largeMintDelay}`);
  refuse(e.switchDelay >= p.minSwitchDelay, `the verifier switch delay must be at least ${p.minSwitchDelay} s, the plan has ${e.switchDelay}`);
  refuse(BigInt(e.supplyCap) <= BigInt(p.maxSupplyCap), `the supply cap must not exceed ${p.maxSupplyCap}, the plan has ${e.supplyCap}`);
  refuse(BigInt(e.supplyCap) >= BigInt(e.bucketCapacity) && BigInt(e.bucketCapacity) > 0n, `the supply cap ${e.supplyCap} is below the mint bucket ${e.bucketCapacity}`);
  return true;
}

function word(data, index, field) {
  refuse(typeof data === "string" && /^0x(?:[0-9a-f]{64})+$/.test(data), `${field} returned malformed data`);
  const start = 2 + index * 64;
  refuse(data.length >= start + 64, `${field} returned too little data`);
  return BigInt(`0x${data.slice(start, start + 64)}`);
}

function addressArray(data, field) {
  const offset = word(data, 0, field);
  refuse(offset === 32n, `${field} returned a malformed array`);
  const length = word(data, 1, field);
  refuse(length <= 16n, `${field} returned too many entries`);
  return Array.from({ length: Number(length) }, (_, i) => {
    const v = word(data, 2 + i, field);
    refuse(v < 1n << 160n, `${field} is not an address list`);
    return `0x${v.toString(16).padStart(40, "0")}`;
  });
}

/// On-chain check of one identity at the gate's finalized block `at` (number `finalizedNumber`).
export async function verifyBridgeToken(identity, request, at, finalizedNumber) {
  const { address, expected: e, pin } = identity;
  refuse(identity.block.number <= finalizedNumber, `the token's deployment block ${identity.block.number} is not finalized`);
  const deployed = await request("eth_getBlockByNumber", [`0x${identity.block.number.toString(16)}`, false]);
  refuse(deployed && lower(deployed.hash) === identity.block.hash, "the token's deployment block is not on the canonical chain");
  const code = await request("eth_getCode", [address, at]);
  refuse(typeof code === "string" && code !== "0x" && keccak256(code) === identity.runtimeCodeHash, "the token's runtime code is not the recorded one");
  refuse((code.length - 2) / 2 === pin.runtimeLength, "the token's runtime code is not the reviewed build (length)");
  refuse(runtimeTemplateKeccak(code, pin.immutableOffsets) === pin.runtimeTemplateKeccak, "the token's runtime code is not the reviewed build (template)");
  const call = async (name) => {
    const result = await request("eth_call", [{ to: address, data: SEL[name] }, at]);
    refuse(typeof result === "string", `${name}() call failed`);
    return result;
  };
  const observed = {};
  for (const k of UINT_VIEWS) {
    const v = word(await call(k), 0, k);
    refuse(v === BigInt(e[k]), `${k}() is ${v}, the bridge plan says ${e[k]}`);
    observed[k] = v.toString();
  }
  const vault = `0x${word(await call("sourceVault"), 0, "sourceVault").toString(16).padStart(40, "0")}`;
  refuse(vault === e.sourceVault, `sourceVault() is ${vault}, the bridge plan says ${e.sourceVault}`);
  const route = `0x${word(await call("sourceRoute"), 0, "sourceRoute").toString(16).padStart(64, "0")}`;
  refuse(route === e.sourceRoute, `sourceRoute() is ${route}, the bridge plan says ${e.sourceRoute}`);
  const signers = addressArray(await call("signers"), "signers");
  refuse(sameList(signers, e.signers), "signers() differ from the bridge plan");
  const guardians = addressArray(await call("guardians"), "guardians");
  refuse(sameList(guardians, e.guardians), "guardians() differ from the bridge plan");
  refuse(word(await call("unpauseThreshold"), 0, "unpauseThreshold") === BigInt(e.switchThreshold), "unpauseThreshold() is not the switch quorum");
  refuse(word(await call("instantCapacity"), 0, "instantCapacity") === 0n, "instantCapacity() is not 0: a mint could credit without the delay");
  refuse(word(await call("MAX_PENDING"), 0, "MAX_PENDING") === BigInt(pin.maxPending), "MAX_PENDING() is not the reviewed value");
  return Object.freeze({
    symbol: identity.symbol, address, runtimeCodeHash: identity.runtimeCodeHash, template: pin.runtimeTemplateKeccak,
    deploymentBlock: Object.freeze({ number: identity.block.number.toString(), hash: identity.block.hash }),
    threshold: e.threshold, signers: Object.freeze([...signers]), switchThreshold: e.switchThreshold,
    guardians: Object.freeze([...guardians]), largeMintThreshold: "0", sourceVault: vault, sourceRoute: route,
    maxPending: pin.maxPending,
  });
}
