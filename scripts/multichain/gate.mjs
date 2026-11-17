#!/usr/bin/env node
// The per-chain gate of the multichain deployments (docs/MULTICHAIN-DEPLOY.md): the Bloch L2 mainnet gate's idea
// for a public EVM chain. Read-only: eth_chainId, block reads, eth_getCode, eth_call. Nothing is signed or sent.
//
//   node scripts/multichain/gate.mjs <chain> pre  [--reference] [--rpc URL --rehearsal] [--out report.json]
//   node scripts/multichain/gate.mjs <chain> post [--reference] [--rpc URL --rehearsal] [--out report.json]
//                                                 [--opening WETH/USDC=0xTRANSACTION ...]
//
// pre   before deploying: the chain is the pinned one (chain id and genesis hash, on every endpoint that serves
//       block 0, at least one), `finalized` is served, the CREATE2 deployer, the wrapped native token, every listed
//       token and Multicall3 have the pinned code and answer name()/symbol()/decimals() as listed, the fee address
//       is an externally owned account (no code, or an EIP-7702 delegation, which is reported), the depositing
//       account (the factory's first depositor) is a plain key account with NO code and NO delegation that has
//       never sent a transaction on this chain while the factory is not deployed (a dedicated key: the pair
//       accepts a first mint by transaction origin, review R328-1), and each planned address is empty or already
//       holds exactly the planned code.
// post  after deploying, read at the `finalized` block: the three contracts hold the planned code, the factory's
//       feeTo, firstDepositor (never the zero address) and every cap are the planned values, the router and the
//       lens point at the factory and the wrapped native token. Each planned pair is reported with its state:
//       "absent" (not created: the first deposit creates it), "empty", "donated" (tokens sit in it, no shares:
//       anyone may skim them), or "open" with its reserves and share supply. An OPEN pair passes only with its
//       opening PROVEN (opening.mjs): the transaction given by --opening (first-deposit.mjs verify prints the
//       option; a hash already in the report at --out is used again) must be the pair's first mint, sent by the
//       first depositor straight to the router with minimums equal to its amounts. "Open" alone does not show
//       who opened a pool, or at which price (review R328-1). Run the gate after the deployment (before any
//       deposit) and again after the first deposits: the frontend record is made only from a report whose
//       pairs are all open and proven. A contract that has the planned code at the latest block but not yet at
//       the finalized one is reported as WAIT: nothing is wrong, the chain has not finalized the deployment yet.
//
// The Bloch-L2-only rules (bridge token pin, Safe pin, new-slot fee, credit rule, idle-chain rule) are off for these
// chains by configuration: deployments/multichain.json `l2Only` and deployments/<chain>/gate.json `l2Only`. The
// Bloch L2 gate (scripts/staging/finality-gate.mjs, check-finality-gate-mainnet.mjs) is separate and unchanged.
// Exit status: 0 pass, 1 a check failed, 2 usage or configuration.
import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isMain } from "../staging/is-main.mjs";
import { createRpcTransport } from "../staging/rpc-transport.mjs";
import {
  EIP7702_PREFIX, EMPTY_CODE_HASH, GATE_DOMAIN, MultichainError, ZERO_ADDRESS, loadArtifacts, loadChain, loadShared, lower, planChain, planSummary, refuse, retrying,
} from "./lib.mjs";
import { openingRecord, priceShiftBps, readOpening } from "./opening.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { keccak256, encodeFunctionData, decodeFunctionResult, parseAbi } = requireFromFrontend("viem");

const ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function feeTo() view returns (address)",
  "function firstDepositor() view returns (address)",
  "function reserveCap(address) view returns (uint256)",
  "function INIT_CODE_PAIR_HASH() view returns (bytes32)",
  "function allPairsLength() view returns (uint256)",
  "function getPair(address,address) view returns (address)",
  "function factory() view returns (address)",
  "function WBLCH() view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function reserveCaps() view returns (uint112,uint112)",
  "function getChainId() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function balanceOf(address) view returns (uint256)",
]);

const codeHashOf = (code) => {
  refuse(typeof code === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(code), "eth_getCode returned malformed code");
  return code === "0x" ? EMPTY_CODE_HASH : keccak256(code);
};

/** The committed gate configuration of one chain (deployments/<chain>/gate.json): pins and switches, no plan. */
export function gateConfig(shared, chain) {
  return {
    schemaVersion: 1,
    domain: GATE_DOMAIN,
    chain: { key: chain.chain.key, chainId: chain.chain.chainId, genesisHash: chain.chain.genesisHash },
    readAt: "finalized",
    pins: {
      create2Deployer: { address: shared.create2.deployer, codeHash: shared.create2.deployerCodeHash },
      wrappedNative: { address: chain.wrappedNative.address, symbol: chain.wrappedNative.symbol, codeHash: chain.wrappedNative.codeHash },
      tokens: chain.tokens.map((t) => ({ address: t.address, symbol: t.symbol, decimals: t.decimals, codeHash: t.codeHash })),
      multicall3: chain.multicall3,
      feeTo: { address: shared.feeTo.address, mustBe: "externally owned account (an EIP-7702 delegation is reported, not refused)" },
      firstDepositor: { mustBe: "a dedicated key account: not the fee address, no code, no EIP-7702 delegation, no transaction on the chain before the factory is deployed" },
      pairInitCodeHash: shared.source.pairInitCodeHash,
    },
    ownerChoices: { firstDepositor: shared.firstDepositor, reserveCaps: chain.reserveCaps, openingPrice: chain.openingPrice },
    expected: "derived by scripts/multichain/plan.mjs from the compiled release candidate and the owner's choices: factory, router, lens and pair addresses and runtime code hashes",
    l2Only: { ...shared.l2Only },
  };
}

/**
 * Evaluate the gate. `request(method, params)` is one endpoint's JSON-RPC; `others` are further endpoints that must
 * agree on the chain. Returns the report; `report.decision` is "pass" or "fail".
 */
export async function evaluateGate({ shared, chain, plan, phase, request, others = [], identityOnly = [], rehearsal = false, openings = {} }) {
  const checks = [];
  const waiting = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
    return Boolean(ok);
  };
  const call = async (to, functionName, args = [], at = "latest") => {
    const data = await request("eth_call", [{ to, data: encodeFunctionData({ abi: ABI, functionName, args }) }, at]);
    return decodeFunctionResult({ abi: ABI, functionName, data });
  };
  const soft = async (work) => {
    try {
      return await work();
    } catch (error) {
      return { failed: String(error.message ?? error).slice(0, 200) };
    }
  };

  // 1. The chain: id and genesis on every endpoint; block 0 must be served by at least one.
  // `identityOnly` endpoints answer for the chain id and block 0 only (a rehearsal fork shares the chain's history
  // up to its fork block, and its upstream may not serve block 0: the reviewed endpoints then name the genesis).
  const endpoints = [request, ...others, ...identityOnly];
  const ids = await Promise.all(endpoints.map((r) => soft(() => r("eth_chainId", []))));
  check("every endpoint reports the pinned chain id", ids.every((id) => typeof id === "string" && Number(BigInt(id)) === chain.chain.chainId), ids);
  const genesis = await Promise.all(endpoints.map((r) => soft(async () => (await r("eth_getBlockByNumber", ["0x0", false]))?.hash ?? null)));
  const served = genesis.filter((h) => typeof h === "string");
  check("block 0 is the pinned genesis on every endpoint that serves it, and at least one serves it", served.length > 0 && served.every((h) => h === chain.chain.genesisHash), genesis);
  const finalized = await soft(() => request("eth_getBlockByNumber", ["finalized", false]));
  const hasFinalized = check("the `finalized` block is served", finalized && typeof finalized.hash === "string" && /^0x[0-9a-f]+$/.test(finalized.number ?? ""), finalized?.failed);
  if (!hasFinalized) return report();
  const at = finalized.number;
  if (others.length) {
    const same = await Promise.all(others.map((r) => soft(async () => (await r("eth_getBlockByNumber", [at, false]))?.hash ?? null)));
    check("the other endpoints have the same block at the finalized height", same.every((h) => h === finalized.hash), same);
  }

  // 2. What the deployment builds on.
  const codeAt = async (address) => codeHashOf(await request("eth_getCode", [address, at]));
  check("the CREATE2 deployer holds the pinned code", (await codeAt(shared.create2.deployer)) === shared.create2.deployerCodeHash);
  for (const token of [chain.wrappedNative, ...chain.tokens]) {
    check(`${token.symbol} at ${token.address} holds the pinned code`, (await codeAt(token.address)) === token.codeHash);
    const facts = await soft(async () => ({ name: (await call(token.address, "name", [], at)), symbol: await call(token.address, "symbol", [], at), decimals: Number(await call(token.address, "decimals", [], at)) }));
    check(`${token.symbol} answers the listed name, symbol and decimals`, facts.name === token.name && facts.symbol === token.symbol && facts.decimals === token.decimals, facts);
  }
  check("Multicall3 holds the pinned code", (await codeAt(chain.multicall3.address)) === chain.multicall3.codeHash);
  const multicallChain = await soft(() => call(chain.multicall3.address, "getChainId", [], at));
  check("Multicall3 answers getChainId() with the chain id", typeof multicallChain === "bigint" && Number(multicallChain) === chain.chain.chainId, typeof multicallChain === "bigint" ? multicallChain.toString() : multicallChain);
  const feeCode = await request("eth_getCode", [shared.feeTo.address, at]);
  const delegated = feeCode.toLowerCase().startsWith(EIP7702_PREFIX) && feeCode.length === 2 + 46;
  check("the fee address is an externally owned account (no code, or an EIP-7702 delegation)", feeCode === "0x" || delegated, feeCode.slice(0, 60));
  const feeTo = { address: shared.feeTo.address, code: feeCode === "0x" ? "none" : delegated ? "EIP-7702 delegation" : "contract", delegate: delegated ? `0x${feeCode.slice(8)}` : null };

  // 3. The deployment.
  const contracts = {};
  for (const c of Object.values(plan.contracts)) {
    const hash = await codeAt(c.address);
    contracts[c.name] = { address: c.address, codeHash: hash, planned: c.runtimeCodeHash };
    if (phase === "pre") check(`${c.name} ${c.address} is empty, or already holds exactly the planned code`, hash === EMPTY_CODE_HASH || hash === c.runtimeCodeHash, hash);
    else {
      const ok = check(`${c.name} ${c.address} holds the planned code at the finalized block`, hash === c.runtimeCodeHash, hash);
      // Review R309-MC-5: deployed but not finalized yet is "wait", not "something is wrong".
      if (!ok && hash === EMPTY_CODE_HASH) {
        const latest = await soft(async () => codeHashOf(await request("eth_getCode", [c.address, "latest"])));
        if (latest === c.runtimeCodeHash) waiting.push(c.name);
      }
    }
  }
  check("the plan's firstDepositor is an account, not the zero address (first deposits are never open on a public chain)", lower(plan.arguments.firstDepositor) !== ZERO_ADDRESS);
  // Review R328-1: the depositing account. The pair accepts a first mint whose transaction origin is this account,
  // so code at the address (a contract, or an EIP-7702 delegation that others may be able to drive) or a history
  // of calls to other contracts is how someone else opens a pool in its name.
  const depositor = plan.arguments.firstDepositor;
  check("the plan's firstDepositor is not the fee address (the depositing account is a dedicated key)", lower(depositor) !== lower(shared.feeTo.address));
  const depositorCode = await request("eth_getCode", [depositor, at]);
  check("the depositing account has no code and no EIP-7702 delegation", depositorCode === "0x", depositorCode.slice(0, 60));
  const depositorNonce = await soft(async () => Number(BigInt(await request("eth_getTransactionCount", [depositor, at]))));
  const firstDepositor = { address: depositor, code: depositorCode === "0x" ? "none" : depositorCode.toLowerCase().startsWith(EIP7702_PREFIX) ? "EIP-7702 delegation" : "contract", transactions: Number.isInteger(depositorNonce) ? depositorNonce : null };
  if (phase === "pre" && contracts.factory?.codeHash === EMPTY_CODE_HASH)
    check("the depositing account has never sent a transaction on this chain (a new, dedicated key), while the factory is not deployed", depositorNonce === 0, depositorNonce);
  const pairs = [];
  if (phase === "post" && Object.values(contracts).every((c) => c.codeHash === c.planned)) {
    const f = plan.contracts.factory.address;
    const same = (a, b) => typeof a === "string" && lower(a) === lower(b);
    check("factory.feeTo() is the owner's fee address", same(await soft(() => call(f, "feeTo", [], at)), plan.arguments.feeTo));
    check("factory.firstDepositor() is the planned value", same(await soft(() => call(f, "firstDepositor", [], at)), plan.arguments.firstDepositor));
    check("factory.INIT_CODE_PAIR_HASH() is the release candidate's", (await soft(() => call(f, "INIT_CODE_PAIR_HASH", [], at))) === plan.pair.initCodeHash);
    const capOf = new Map(plan.arguments.reserveCaps.map((c) => [lower(c.token), BigInt(c.cap)]));
    for (const token of [chain.wrappedNative, ...chain.tokens]) {
      const cap = await soft(() => call(f, "reserveCap", [token.address], at));
      check(`factory.reserveCap(${token.symbol}) is the planned value (${capOf.get(lower(token.address)) ?? 0n})`, cap === (capOf.get(lower(token.address)) ?? 0n), typeof cap === "bigint" ? cap.toString() : cap);
    }
    check("router.factory() is the factory", same(await soft(() => call(plan.contracts.router.address, "factory", [], at)), f));
    check("router.WBLCH() is the chain's wrapped native token", same(await soft(() => call(plan.contracts.router.address, "WBLCH", [], at)), plan.arguments.wrappedNative));
    check("lens.factory() is the factory", same(await soft(() => call(plan.contracts.lens.address, "factory", [], at)), f));
    for (const p of plan.pairs) {
      const got = await soft(() => call(f, "getPair", [p.token0, p.token1], at));
      const created = same(got, p.address);
      const entry = { tokenA: p.tokenA, tokenB: p.tokenB, address: p.address, token0: p.token0, token1: p.token1, created, state: "absent" };
      // Tokens can be sent to the pair's address before it exists; they would join the first deposit.
      const held = await soft(async () => [await call(p.token0, "balanceOf", [p.address], at), await call(p.token1, "balanceOf", [p.address], at)]);
      check(`the token balances at the pair address ${p.tokenA}/${p.tokenB} can be read`, Array.isArray(held), held?.failed);
      if (Array.isArray(held)) entry.balances = held.map(String);
      if (!created) {
        // Not an error: the first depositor's first deposit creates the pair in the same transaction.
        check(`pair ${p.tokenA}/${p.tokenB} is not created yet, or is created at the planned address`, typeof got === "string" && /^0x0{40}$/.test(got), got);
        if (Array.isArray(held) && held.some((b) => b > 0n)) entry.state = "donated";
      }
      if (created) {
        entry.codeHash = await codeAt(p.address);
        check(`pair ${p.tokenA}/${p.tokenB} ${p.address} holds the release candidate's pair code`, entry.codeHash === plan.pair.runtimeCodeHash, entry.codeHash);
        check(`pair ${p.tokenA}/${p.tokenB} has the planned token0 and token1`, same(await soft(() => call(p.address, "token0", [], at)), p.token0) && same(await soft(() => call(p.address, "token1", [], at)), p.token1));
        const caps = await soft(() => call(p.address, "reserveCaps", [], at));
        const want = [capOf.get(lower(p.token0)) ?? 0n, capOf.get(lower(p.token1)) ?? 0n];
        check(`pair ${p.tokenA}/${p.tokenB} copied the planned caps`, Array.isArray(caps) && caps[0] === want[0] && caps[1] === want[1], Array.isArray(caps) ? caps.map(String) : caps);
        entry.reserveCaps = want.map(String);
        const supply = await soft(() => call(p.address, "totalSupply", [], at));
        const reserves = await soft(() => call(p.address, "getReserves", [], at));
        const read = check(`pair ${p.tokenA}/${p.tokenB} answers totalSupply() and getReserves()`, typeof supply === "bigint" && Array.isArray(reserves), supply?.failed ?? reserves?.failed);
        if (read && Array.isArray(held)) {
          entry.totalSupply = supply.toString();
          entry.reserves = [reserves[0].toString(), reserves[1].toString()];
          entry.state = supply > 0n ? "open" : held.some((b) => b > 0n) ? "donated" : "empty";
          if (supply > 0n) {
            check(`pair ${p.tokenA}/${p.tokenB} is open with both reserves above zero`, reserves[0] > 0n && reserves[1] > 0n, entry.reserves);
            // "Open" does not say who opened it or at which price (the pair accepts a first mint by transaction
            // origin): the opening transaction must prove it (review R328-1).
            const name = `${p.tokenA}/${p.tokenB}`;
            const hash = openings[name] ?? openings[`${p.tokenB}/${p.tokenA}`];
            const wrappedIs0 = lower(p.token0) === lower(chain.wrappedNative.address);
            const hasWrapped = wrappedIs0 || lower(p.token1) === lower(chain.wrappedNative.address);
            if (!hash || !hasWrapped) {
              entry.opening = { proven: false, problems: [hasWrapped ? "no opening transaction was given" : "the opening of a pair without the wrapped native token is not supported by this gate"], transaction: null };
              check(`pair ${name} is open: its opening is proven by its transaction (--opening ${name}=0xHASH; first-deposit.mjs verify prints it). If the depositing account did not open this pool with first-deposit.mjs, STOP: someone else opened it (docs/MULTICHAIN-DEPLOY.md section 10)`, false, entry.opening.problems);
            } else {
              const opening = await readOpening({ request, others, hash: hash.toLowerCase(), finalizedNumber: Number(BigInt(at)), pair: p.address, router: plan.contracts.router.address, depositor, token: wrappedIs0 ? p.token1 : p.token0, wrappedIs0 });
              entry.opening = openingRecord(opening);
              if (opening.proven) entry.opening.priceShiftBps = Number(priceShiftBps(opening));
              check(`pair ${name} was opened by the first depositor's own deposit, sent straight to the router with minimums equal to its amounts (transaction ${hash})`, opening.proven, opening.problems);
            }
          }
        }
      }
      pairs.push(entry);
    }
  }
  return report();

  function report() {
    const failed = checks.filter((c) => !c.ok).map((c) => c.name);
    return {
      schemaVersion: 1,
      domain: GATE_DOMAIN,
      phase,
      decision: failed.length === 0 ? "pass" : "fail",
      rehearsal,
      referencePlan: plan.reference,
      chain: { key: chain.chain.key, chainId: chain.chain.chainId, genesisHash: chain.chain.genesisHash },
      finalized: finalized && typeof finalized.hash === "string" ? { number: Number(BigInt(finalized.number)), hash: finalized.hash, timestamp: Number(BigInt(finalized.timestamp ?? "0x0")) } : null,
      feeTo: typeof feeTo === "undefined" ? null : feeTo,
      firstDepositor: typeof firstDepositor === "undefined" ? null : firstDepositor,
      plan: planSummary(plan),
      pairs,
      l2Only: { ...shared.l2Only },
      waiting,
      checks,
      failed,
    };
  }
}

function parseArgs(argv) {
  const [key, phase, ...rest] = argv;
  refuse(key && (phase === "pre" || phase === "post"), "usage: gate.mjs <chain> pre|post [--reference] [--rpc URL --rehearsal] [--out FILE] [--opening A/B=0xTRANSACTION ...]");
  const options = { key, phase, reference: false, rehearsal: false, rpc: null, out: null, openings: {} };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--reference") options.reference = true;
    else if (rest[i] === "--rehearsal") options.rehearsal = true;
    else if (rest[i] === "--rpc" || rest[i] === "--out") {
      refuse(rest[i + 1] && !rest[i + 1].startsWith("--"), `${rest[i]} needs a value`);
      options[rest[i].slice(2)] = rest[++i];
    } else if (rest[i] === "--opening") {
      const match = /^([A-Za-z0-9.]{2,12}\/[A-Za-z0-9.]{2,12})=(0x[0-9a-fA-F]{64})$/.exec(rest[++i] ?? "");
      refuse(match, "--opening takes PAIR=TRANSACTION, for example --opening WETH/USDC=0x… (the hash of the first deposit)");
      options.openings[match[1]] = match[2].toLowerCase();
    } else refuse(false, `unknown option ${rest[i]}`);
  }
  refuse(!options.rpc || options.rehearsal, "--rpc replaces the chain's reviewed endpoints and is for a rehearsal only: add --rehearsal");
  refuse(!options.rehearsal || /^http:\/\/127\.0\.0\.1:\d{2,5}\/?$/.test(options.rpc ?? ""), "--rehearsal needs --rpc http://127.0.0.1:PORT (a loopback fork)");
  refuse(phase === "post" || Object.keys(options.openings).length === 0, "--opening belongs to the post gate");
  return options;
}

export async function main(argv) {
  const options = parseArgs(argv);
  const shared = loadShared();
  refuse(shared.chains.includes(options.key), `${options.key} is not in deployments/multichain.json chains`);
  const chain = loadChain(options.key);
  const plan = planChain(shared, chain, loadArtifacts(), { reference: options.reference });
  refuse(!plan.reference || options.rehearsal || options.phase === "pre", "a reference plan (owner choices open) can pass the post gate only in a rehearsal");
  const urls = options.rehearsal ? [options.rpc] : chain.rpc;
  const [request, ...others] = urls.map((url) => retrying(createRpcTransport(url, { timeoutMs: 30_000 })));
  const identityOnly = options.rehearsal ? chain.rpc.map((url) => retrying(createRpcTransport(url, { timeoutMs: 30_000 }))) : [];
  // A later run of the post gate needs the opening transactions again: those of the report already at --out (same
  // chain, same factory) are used when the option does not name the pair. They are verified again like any other.
  const openings = { ...previousOpenings(options, chain, plan), ...options.openings };
  const report = await evaluateGate({ shared, chain, plan, phase: options.phase, request, others, identityOnly, rehearsal: options.rehearsal, openings });
  if (options.out) writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
  for (const c of report.checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok || c.detail === undefined ? "" : ` (${JSON.stringify(c.detail)})`}`);
  for (const p of report.pairs) {
    console.log(`pair ${p.tokenA}/${p.tokenB} ${p.address}: ${p.state}${p.state === "open" ? `, reserves ${p.reserves.join(" / ")}, shares ${p.totalSupply}` : p.state === "donated" ? `, tokens sit in it without shares (${p.balances.join(" / ")}): anyone may call skim(to)` : ""}`);
    if (p.opening?.proven) console.log(`  opened by ${p.opening.by} in ${p.opening.transaction} (block ${p.opening.blockNumber}): ${p.opening.joined.native} native + ${p.opening.joined.token} token base units joined${p.opening.gift.native !== "0" || p.opening.gift.token !== "0" ? `, of which ${p.opening.gift.native} + ${p.opening.gift.token} were at the pair's address before the deposit (a gift to the pool; opening price moved by ${(p.opening.priceShiftBps / 100).toFixed(2)}%)` : ""}`);
    else if (p.state === "open") console.log(`  NOT PROVEN who opened this pool: ${p.opening?.problems.join("; ")}`);
  }
  if (report.waiting.length) console.log(`WAIT: ${report.waiting.join(", ")} ${report.waiting.length === 1 ? "has" : "have"} the planned code at the latest block but not at the finalized block yet. Nothing is wrong; run this gate again later (docs/MULTICHAIN-DEPLOY.md gives the wait per chain).`);
  console.log(`multichain gate ${options.key} ${options.phase}: ${report.decision.toUpperCase()}${report.finalized ? ` at finalized block ${report.finalized.number}` : ""}${plan.reference ? " (reference plan)" : ""}${report.feeTo?.delegate ? `; fee address has an EIP-7702 delegation to ${report.feeTo.delegate}` : ""}`);
  return report.decision === "pass" ? 0 : 1;
}

function previousOpenings(options, chain, plan) {
  if (options.phase !== "post" || !options.out || !existsSync(options.out)) return {};
  try {
    const old = JSON.parse(readFileSync(options.out, "utf8"));
    if (old.domain !== GATE_DOMAIN || old.chain?.chainId !== chain.chain.chainId || lower(old.plan?.contracts?.factory?.address ?? "") !== lower(plan.contracts.factory.address)) return {};
    return Object.fromEntries((old.pairs ?? []).filter((p) => /^0x[0-9a-f]{64}$/.test(p.opening?.transaction ?? "")).map((p) => [`${p.tokenA}/${p.tokenB}`, p.opening.transaction]));
  } catch {
    return {};
  }
}

// isMain: a start through a symbolic link must not do nothing and exit 0 (review R309-MC-4).
if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof MultichainError ? error.message : error);
      process.exit(2);
    },
  );
}
