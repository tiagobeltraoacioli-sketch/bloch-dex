// The DEX on public EVM chains other than the Bloch L2 (docs/MULTICHAIN-DEPLOY.md): shared, pure helpers.
//
// Inputs are two reviewed files, deployments/multichain.json (salt, fee recipient, the chain list) and
// deployments/<chain>/chain.json (chain id, genesis hash, wrapped native token, token list, RPC endpoints), plus the
// compiled artifacts of the unchanged contracts. From them a plan is derived: the three CREATE2 addresses, the init
// code and runtime code hash of each contract, and the pair addresses. Nothing in this file talks to an RPC, signs
// or broadcasts. The Bloch L2 procedure (scripts/staging) is separate and is not touched by anything here.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { keccak256, encodeAbiParameters, encodePacked, getAddress, stringToHex, concat } = requireFromFrontend("viem");

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const SHARED_DOMAIN = "postern.dex.multichain.v1";
export const CHAIN_DOMAIN = "postern.dex.multichain-chain.v1";
export const PLAN_DOMAIN = "postern.dex.multichain-plan.v1";
export const GATE_DOMAIN = "postern.dex.multichain-gate.v1";
export const PENDING = "TBD-owner";
export const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
export const EMPTY_CODE_HASH = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";
export const UINT112_MAX = (1n << 112n) - 1n;
/** The Bloch L2 chains have their own procedure and are never a target of this kit. */
export const BLOCH_L2_CHAIN_IDS = Object.freeze([700770, 700771]);
/** EIP-7702: an externally owned account that delegates to code reads `0xef0100 ++ address`. */
export const EIP7702_PREFIX = "0xef0100";
/**
 * The first depositor of the reference (rehearsal) plan: the last 20 bytes of
 * keccak256("postern-dex.multichain.reference-first-depositor"). Nobody holds a key for it, so a factory deployed
 * from the reference plan can never have a pool opened; rehearsals impersonate it on a loopback fork. It is not
 * the fee address: the depositing account is a dedicated key (review R328-1).
 */
export const REFERENCE_FIRST_DEPOSITOR_PREIMAGE = "postern-dex.multichain.reference-first-depositor";
export const REFERENCE_FIRST_DEPOSITOR = getAddress(`0x${keccak256(stringToHex(REFERENCE_FIRST_DEPOSITOR_PREIMAGE)).slice(26)}`);

const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS_ANY = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL = /^[1-9][0-9]*$/;

export class MultichainError extends Error {}
export function refuse(condition, message) {
  if (!condition) throw new MultichainError(`multichain: ${message}`);
}
export const isPending = (value) => value === null || value === PENDING;
export const lower = (address) => address.toLowerCase();

/** An address exactly as EIP-55 writes it; a wrong capital is a typo and is refused. */
export function checksummed(value, field) {
  refuse(typeof value === "string" && ADDRESS_ANY.test(value), `${field} is not an address`);
  let expected;
  try {
    expected = getAddress(value.toLowerCase());
  } catch {
    refuse(false, `${field} is not an address`);
  }
  refuse(value === expected, `${field} is not EIP-55 checksummed (expected ${expected})`);
  return value;
}

/**
 * A public endpoint that fails once (a dropped connection, a rate limit) is asked again, twice, with a pause: a
 * refused request is not the chain's answer. An execution error (a revert) is, and is returned at once.
 */
export function retrying(request, { tries = 3, delayMs = 1500 } = {}) {
  return async (method, params) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await request(method, params);
      } catch (error) {
        if (attempt >= tries || /execution reverted|revert/i.test(String(error?.message ?? error))) throw error;
        await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
      }
    }
  };
}

export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
export const loadShared = (root = ROOT) => validateShared(readJson(join(root, "deployments/multichain.json")));
export const loadChain = (key, root = ROOT) => {
  refuse(/^[a-z0-9-]{2,24}$/.test(key), "the chain key is not a directory name of deployments/");
  return validateChain(readJson(join(root, "deployments", key, "chain.json")), key);
};

export function validateShared(shared) {
  refuse(shared && shared.domain === SHARED_DOMAIN && shared.schemaVersion === 1, "unsupported deployments/multichain.json");
  const c = shared.source?.compiler;
  refuse(
    c && c.solc === "0.8.24" && c.evmVersion === "paris" && c.optimizer === true && c.optimizerRuns === 200 && c.bytecodeHash === "none",
    "source.compiler is not the release candidate's (solc 0.8.24, paris, optimizer 200 runs, no metadata hash)",
  );
  refuse(HASH.test(shared.source.pairInitCodeHash ?? ""), "source.pairInitCodeHash");
  checksummed(shared.create2?.deployer, "create2.deployer");
  refuse(HASH.test(shared.create2.deployerCodeHash ?? ""), "create2.deployerCodeHash");
  refuse(typeof shared.create2.saltPreimage === "string" && shared.create2.saltPreimage.length > 0, "create2.saltPreimage");
  refuse(shared.create2.salt === keccak256(stringToHex(shared.create2.saltPreimage)), "create2.salt is not keccak256 of create2.saltPreimage");
  checksummed(shared.feeTo?.address, "feeTo.address");
  refuse(lower(shared.feeTo.address) !== ZERO_ADDRESS, "feeTo.address is the zero address (the protocol fee would be off for ever)");
  if (!isPending(shared.firstDepositor)) {
    checksummed(shared.firstDepositor, "firstDepositor");
    // Review R309-MC-1: on a public chain a factory whose first deposits are open lets anyone open a pool at a
    // false price before the owner's deposit. There is no override: the factory cannot be changed afterwards.
    refuse(lower(shared.firstDepositor) !== ZERO_ADDRESS, "firstDepositor is the zero address: first deposits would be open to anyone. Name the owner's depositing account (an ordinary key account)");
    refuse(lower(shared.firstDepositor) !== lower(shared.create2.deployer), "firstDepositor is the CREATE2 deployer, not an account");
    refuseDepositorInUse(shared);
  }
  refuse(Array.isArray(shared.chains) && shared.chains.length > 0 && new Set(shared.chains).size === shared.chains.length, "chains");
  const off = shared.l2Only;
  refuse(
    off && ["bridgeTokenPin", "safePin", "newSlotFee", "creditRule", "idleChainRule"].every((k) => off[k] === false),
    "l2Only: every Bloch-L2-only rule must be stated off (false) for these chains",
  );
  return shared;
}

/**
 * Review R328-1: the pair accepts a first mint whose transaction ORIGIN is the first depositor, whoever the sender
 * is. Any contract that account calls can therefore open a still-unopened pair at any price. So the depositing
 * account is a dedicated key that sends nothing but the transactions first-deposit.mjs prints: never the fee
 * address (a wallet in daily use), never the reference address (nobody has its key).
 */
function refuseDepositorInUse(shared) {
  refuse(
    lower(shared.firstDepositor) !== lower(shared.feeTo.address),
    "firstDepositor is the fee address. The depositing account must be a dedicated key used for nothing but first deposits: any contract it calls could open a pool in its name (the pair accepts the transaction origin)",
  );
  refuse(lower(shared.firstDepositor) !== lower(REFERENCE_FIRST_DEPOSITOR), "firstDepositor is the reference rehearsal address: nobody holds its key");
}

function validateToken(token, field) {
  checksummed(token?.address, `${field}.address`);
  refuse(typeof token.symbol === "string" && /^[A-Za-z0-9.]{2,12}$/.test(token.symbol), `${field}.symbol`);
  refuse(typeof token.name === "string" && token.name.length > 0 && token.name.length <= 40, `${field}.name`);
  refuse(Number.isInteger(token.decimals) && token.decimals >= 0 && token.decimals <= 36, `${field}.decimals`);
  refuse(HASH.test(token.codeHash ?? "") && token.codeHash !== EMPTY_CODE_HASH, `${field}.codeHash`);
  refuse(typeof token.kind === "string" && typeof token.source === "string" && token.source.length > 0, `${field}: kind and source are required`);
}

/**
 * One confirmation rule: the chain's own `finalized` or `safe` block, or the block `depth` blocks behind the head.
 * (review R309-MC-2: `finalized` is minutes to hours behind on most of these chains.)
 */
export function validateRule(rule, field) {
  const keys = rule && typeof rule === "object" ? Object.keys(rule) : [];
  refuse(keys.length === 1 && (keys[0] === "tag" || keys[0] === "depth"), `${field} must be {"tag": "finalized"|"safe"} or {"depth": N}`);
  if (keys[0] === "tag") refuse(rule.tag === "finalized" || rule.tag === "safe", `${field}.tag must be finalized or safe`);
  else refuse(Number.isInteger(rule.depth) && rule.depth >= 1 && rule.depth <= 100_000, `${field}.depth must be a whole number of blocks from 1 to 100000`);
  return rule;
}
/** Seconds a rule lags the head, by the chain's measured block time; null for a tag (the chain decides). */
export const ruleSeconds = (rule, blockSeconds) => ("depth" in rule ? Math.round(rule.depth * blockSeconds) : null);
function validateConfirmation(c) {
  refuse(c && typeof c === "object", "confirmation: the chain's confirmation rule is required (settle, strict, measured, residualRisk)");
  validateRule(c.settle, "confirmation.settle");
  validateRule(c.strict, "confirmation.strict");
  refuse(c.measured && typeof c.measured.at === "string" && typeof c.measured.blockSeconds === "number" && c.measured.blockSeconds > 0 && c.measured.blockSeconds <= 60, "confirmation.measured: at and blockSeconds");
  // The strict rule ends a hold without a receipt: it is never weaker than the settle rule.
  const rank = (r) => ("depth" in r ? r.depth : r.tag === "safe" ? 1e6 : 1e7);
  refuse(rank(c.strict) >= rank(c.settle), "confirmation.strict is weaker than confirmation.settle");
  // Optional: the rule that settles a REVERTED swap (after it the user may retry); between the two (R328-3P-3).
  if (c.reverted !== undefined) {
    validateRule(c.reverted, "confirmation.reverted");
    refuse(rank(c.reverted) >= rank(c.settle) && rank(c.reverted) <= rank(c.strict), "confirmation.reverted must lie between confirmation.settle and confirmation.strict");
    refuse(typeof c.revertedWhy === "string" && c.revertedWhy.length >= 40, "confirmation.revertedWhy: say why a deeper replacement is not credible on this chain");
  }
  refuse(typeof c.residualRisk === "string" && c.residualRisk.length >= 40, "confirmation.residualRisk: state the residual risk of the choice");
}

export function validateChain(chain, key) {
  refuse(chain && chain.domain === CHAIN_DOMAIN && chain.schemaVersion === 1, `unsupported deployments/${key}/chain.json`);
  refuse(chain.chain?.key === key, `chain.key is not ${key}`);
  refuse(Number.isSafeInteger(chain.chain.chainId) && chain.chain.chainId > 0, "chain.chainId");
  refuse(!BLOCH_L2_CHAIN_IDS.includes(chain.chain.chainId), "the Bloch L2 has its own procedure (scripts/staging) and is not a target here");
  refuse(chain.chain.chainId !== 31337, "chain id 31337 is a local chain");
  refuse(HASH.test(chain.chain.genesisHash ?? ""), "chain.genesisHash");
  refuse(typeof chain.chain.name === "string" && chain.chain.name.length > 0 && chain.chain.name.length <= 40, "chain.name");
  const n = chain.nativeCurrency;
  refuse(n && typeof n.name === "string" && /^[A-Z]{2,6}$/.test(n.symbol ?? "") && n.decimals === 18, "nativeCurrency");
  refuse(
    Array.isArray(chain.rpc) && chain.rpc.length >= 2 && new Set(chain.rpc).size === chain.rpc.length && chain.rpc.every((u) => typeof u === "string" && /^https:\/\/[a-z0-9.-]+(\/[A-Za-z0-9/_-]*)?$/.test(u)),
    "rpc: at least two distinct https endpoints without credentials or query strings",
  );
  refuse(typeof chain.explorer === "string" && /^https:\/\/[a-z0-9.-]+$/.test(chain.explorer), "explorer");
  validateToken(chain.wrappedNative, "wrappedNative");
  refuse(chain.wrappedNative.decimals === 18, "wrappedNative.decimals");
  refuse(Array.isArray(chain.tokens) && chain.tokens.length >= 1 && chain.tokens.length <= 8, "tokens");
  chain.tokens.forEach((t, i) => validateToken(t, `tokens[${i}]`));
  const addresses = [chain.wrappedNative, ...chain.tokens].map((t) => lower(t.address));
  refuse(new Set(addresses).size === addresses.length, "a token is listed twice");
  const symbols = [chain.wrappedNative, ...chain.tokens].map((t) => t.symbol);
  refuse(new Set(symbols).size === symbols.length, "a symbol is listed twice");
  checksummed(chain.multicall3?.address, "multicall3.address");
  refuse(HASH.test(chain.multicall3.codeHash ?? ""), "multicall3.codeHash");
  validateConfirmation(chain.confirmation);
  refuse(chain.swap && Number.isInteger(chain.swap.deadlineMinutes) && chain.swap.deadlineMinutes >= 10 && chain.swap.deadlineMinutes <= 60, "swap.deadlineMinutes: the page's default swap deadline, 10 to 60 minutes (the swap form accepts 10 to 180)");
  refuse(Array.isArray(chain.initialPairs) && chain.initialPairs.length <= 4, "initialPairs");
  for (const [i, p] of chain.initialPairs.entries())
    refuse(symbols.includes(p.tokenA) && symbols.includes(p.tokenB) && p.tokenA !== p.tokenB, `initialPairs[${i}] names a token that is not listed`);
  if (!isPending(chain.reserveCaps)) {
    refuse(Array.isArray(chain.reserveCaps) && chain.reserveCaps.length <= 8, "reserveCaps must be TBD-owner or a list (an empty list means no caps)");
    const seen = new Set();
    for (const [i, cap] of chain.reserveCaps.entries()) {
      refuse(symbols.includes(cap.token) && !seen.has(cap.token), `reserveCaps[${i}].token is not a listed symbol, or is listed twice`);
      seen.add(cap.token);
      refuse(typeof cap.cap === "string" && DECIMAL.test(cap.cap) && BigInt(cap.cap) <= UINT112_MAX, `reserveCaps[${i}].cap must be a decimal string of base units, at most 2^112 - 1`);
    }
  }
  return chain;
}

/** Every owner choice that is still open for this chain, as a path. */
export function pendingChoices(shared, chain) {
  const open = [];
  if (isPending(shared.firstDepositor)) open.push("deployments/multichain.json: firstDepositor");
  if (isPending(chain.reserveCaps)) open.push(`deployments/${chain.chain.key}/chain.json: reserveCaps`);
  return open;
}

/**
 * The owner's choices a plan is made for. `reference: true` replaces every open choice with the reference
 * rehearsal values (first deposits by REFERENCE_FIRST_DEPOSITOR only, no reserve caps) and marks the plan as not
 * for a real deployment. No plan, reference or real, has open first deposits (review R309-MC-1), and none has the
 * fee address as its depositing account (review R328-1).
 */
export function choicesFor(shared, chain, { reference = false } = {}) {
  const open = pendingChoices(shared, chain);
  refuse(reference || open.length === 0, `owner choices are still open (${open.join("; ")}); use --reference for a rehearsal plan`);
  // Also here, for a caller that builds its own configuration object: no plan has open first deposits.
  refuse(isPending(shared.firstDepositor) || lower(shared.firstDepositor) !== ZERO_ADDRESS, "firstDepositor is the zero address: first deposits would be open to anyone");
  if (!isPending(shared.firstDepositor)) refuseDepositorInUse(shared);
  const bySymbol = new Map([chain.wrappedNative, ...chain.tokens].map((t) => [t.symbol, t]));
  const caps = isPending(chain.reserveCaps) ? [] : chain.reserveCaps.map((c) => ({ token: bySymbol.get(c.token).address, symbol: c.token, cap: c.cap }));
  return {
    reference: open.length > 0,
    firstDepositor: isPending(shared.firstDepositor) ? REFERENCE_FIRST_DEPOSITOR : shared.firstDepositor,
    caps,
  };
}

const ARTIFACTS = Object.freeze({
  factory: ["UniswapV2Factory.sol", "UniswapV2Factory"],
  router: ["BDexRouter.sol", "BDexRouter"],
  lens: ["BDexLens.sol", "BDexLens"],
  pair: ["UniswapV2Pair.sol", "UniswapV2Pair"],
});
export function loadArtifacts(outDir = join(ROOT, "out")) {
  const artifacts = {};
  for (const [key, [file, name]] of Object.entries(ARTIFACTS)) {
    const json = readJson(join(outDir, file, `${name}.json`));
    artifacts[key] = {
      bytecode: json.bytecode?.object,
      deployedBytecode: json.deployedBytecode?.object,
      immutableReferences: json.deployedBytecode?.immutableReferences ?? {},
    };
    for (const field of ["bytecode", "deployedBytecode"])
      refuse(/^0x(?:[0-9a-f]{2})+$/.test(artifacts[key][field] ?? ""), `artifact ${name}.${field} is not hex bytecode (run forge build)`);
  }
  return artifacts;
}

/** Fill a runtime's immutable words; solc numbers them in declaration order (as scripts/staging does). */
export function linkImmutables(artifact, values, field) {
  const ids = Object.keys(artifact.immutableReferences).map(Number).sort((a, b) => a - b);
  refuse(ids.length === values.length, `${field} has ${ids.length} immutables, expected ${values.length}`);
  const bytes = artifact.deployedBytecode.slice(2).split("");
  ids.forEach((id, index) => {
    const word = values[index].slice(2).toLowerCase().padStart(64, "0");
    for (const { start, length } of artifact.immutableReferences[id]) {
      refuse(length === 32, `${field} immutable ${id} is not one word`);
      for (let i = 0; i < 64; i++) bytes[start * 2 + i] = word[i];
    }
  });
  return `0x${bytes.join("")}`;
}

export const create2Address = (deployer, salt, initCodeHash) =>
  getAddress(`0x${keccak256(concat(["0xff", deployer, salt, initCodeHash])).slice(26)}`);

export function pairAddress(factory, tokenA, tokenB, pairInitCodeHash) {
  const [token0, token1] = lower(tokenA) < lower(tokenB) ? [tokenA, tokenB] : [tokenB, tokenA];
  return { token0, token1, address: create2Address(factory, keccak256(encodePacked(["address", "address"], [token0, token1])), pairInitCodeHash) };
}

/** The deterministic plan of one chain. Pure: no RPC, no clock, no randomness. */
export function planChain(shared, chain, artifacts, options = {}) {
  const choices = choicesFor(shared, chain, options);
  const pairInitCodeHash = keccak256(artifacts.pair.bytecode);
  refuse(pairInitCodeHash === shared.source.pairInitCodeHash, `the compiled pair init code hash ${pairInitCodeHash} is not the release candidate's ${shared.source.pairInitCodeHash}`);
  const { deployer, salt } = shared.create2;
  const feeTo = shared.feeTo.address;
  const wrapped = chain.wrappedNative.address;
  const step = (name, artifact, types, values, immutables) => {
    const constructorArguments = encodeAbiParameters(types.map((type) => ({ type })), values);
    const initCode = concat([artifact.bytecode, constructorArguments]);
    const address = create2Address(deployer, salt, keccak256(initCode));
    const runtime = linkImmutables(artifact, immutables(address), name);
    return { name, address, initCodeHash: keccak256(initCode), initCodeBytes: (initCode.length - 2) / 2, constructorArguments, runtimeCodeHash: keccak256(runtime), runtimeBytes: (runtime.length - 2) / 2, transaction: { to: deployer, data: concat([salt, initCode]) } };
  };
  const factory = step(
    "factory",
    artifacts.factory,
    ["address", "address", "address[]", "uint256[]"],
    [feeTo, choices.firstDepositor, choices.caps.map((c) => c.token), choices.caps.map((c) => BigInt(c.cap))],
    () => [feeTo, choices.firstDepositor],
  );
  const router = step("router", artifacts.router, ["address", "address"], [factory.address, wrapped], () => [factory.address, wrapped]);
  const lens = step("lens", artifacts.lens, ["address"], [factory.address], () => [factory.address]);
  const bySymbol = new Map([chain.wrappedNative, ...chain.tokens].map((t) => [t.symbol, t]));
  const pairs = chain.initialPairs.map((p) => ({ tokenA: p.tokenA, tokenB: p.tokenB, ...pairAddress(factory.address, bySymbol.get(p.tokenA).address, bySymbol.get(p.tokenB).address, pairInitCodeHash) }));
  return {
    schemaVersion: 1,
    domain: PLAN_DOMAIN,
    reference: choices.reference,
    chain: { key: chain.chain.key, name: chain.chain.name, chainId: chain.chain.chainId, genesisHash: chain.chain.genesisHash },
    create2: { deployer, deployerCodeHash: shared.create2.deployerCodeHash, salt },
    arguments: { feeTo, firstDepositor: choices.firstDepositor, wrappedNative: wrapped, reserveCaps: choices.caps },
    contracts: { factory, router, lens },
    pair: { initCodeHash: pairInitCodeHash, runtimeCodeHash: keccak256(artifacts.pair.deployedBytecode) },
    pairs,
  };
}

/** The MC_* environment of script/DeployMultichain.s.sol for this plan. */
export function forgeEnvironment(plan, chain, { createPairs = false } = {}) {
  const bySymbol = new Map([chain.wrappedNative, ...chain.tokens].map((t) => [t.symbol, t]));
  const env = {
    MC_CHAIN_ID: String(plan.chain.chainId),
    MC_FEE_TO: plan.arguments.feeTo,
    MC_FIRST_DEPOSITOR: plan.arguments.firstDepositor,
    MC_WRAPPED: plan.arguments.wrappedNative,
    MC_WRAPPED_CODE_HASH: chain.wrappedNative.codeHash,
    MC_EXPECT_FACTORY: plan.contracts.factory.address,
    MC_EXPECT_ROUTER: plan.contracts.router.address,
    MC_EXPECT_LENS: plan.contracts.lens.address,
  };
  if (plan.arguments.reserveCaps.length) {
    env.MC_CAP_TOKENS = plan.arguments.reserveCaps.map((c) => c.token).join(",");
    env.MC_CAPS = plan.arguments.reserveCaps.map((c) => c.cap).join(",");
  }
  // By default the deployment creates no pair (review R309-MC-1): each planned pair is created by the first
  // depositor's first deposit, in the same transaction (the router calls createPair), so no pair of the owner's
  // ever exists empty. `createPairs` is kept for tests of the script's own pair step.
  const w = chain.wrappedNative.symbol;
  const others = plan.pairs.filter((p) => p.tokenA === w || p.tokenB === w).map((p) => bySymbol.get(p.tokenA === w ? p.tokenB : p.tokenA).address);
  if (createPairs && others.length) env.MC_PAIR_TOKENS = others.join(",");
  return env;
}

/** A plan without the bulky transaction data, for files and reports. */
export function planSummary(plan) {
  const strip = ({ transaction: _transaction, ...rest }) => rest;
  return { ...plan, contracts: Object.fromEntries(Object.entries(plan.contracts).map(([k, v]) => [k, strip(v)])) };
}

/**
 * Opcodes a byte string can execute, walking it as the EVM does (PUSH data skipped). Used to show that the
 * deployed code needs nothing newer than the oldest fork the six chains have in common.
 */
export function opcodesOf(code) {
  const bytes = Buffer.from(code.slice(2), "hex");
  const seen = new Set();
  for (let i = 0; i < bytes.length; i++) {
    const op = bytes[i];
    seen.add(op);
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
  }
  return seen;
}
/** Opcodes introduced after the Paris target: Shanghai PUSH0; Cancun TLOAD, TSTORE, MCOPY, BLOBHASH, BLOBBASEFEE. */
export const POST_PARIS_OPCODES = Object.freeze({ 0x5f: "PUSH0", 0x5c: "TLOAD", 0x5d: "TSTORE", 0x5e: "MCOPY", 0x49: "BLOBHASH", 0x4a: "BLOBBASEFEE" });
/** Opcodes whose meaning differs between the six chains (docs/MULTICHAIN-DEPLOY.md, "EVM differences"). */
export const CHAIN_DEPENDENT_OPCODES = Object.freeze({ 0x40: "BLOCKHASH", 0x41: "COINBASE", 0x42: "TIMESTAMP", 0x43: "NUMBER", 0x44: "PREVRANDAO", 0x45: "GASLIMIT", 0x46: "CHAINID", 0x48: "BASEFEE", 0x3a: "GASPRICE", 0xff: "SELFDESTRUCT", 0x32: "ORIGIN" });
