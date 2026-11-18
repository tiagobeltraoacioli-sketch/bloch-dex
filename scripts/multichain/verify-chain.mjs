#!/usr/bin/env node
// What deployments/<chain>/chain.json says about a chain, compared with the chain itself (docs/MULTICHAIN-DEPLOY.md
// section 4; the tool each chain file's `verified.how` names). Read-only: eth_chainId, block reads, eth_getCode,
// eth_getStorageAt, eth_call. Nothing is signed or sent.
//
//   node scripts/multichain/verify-chain.mjs <chain>|all [--json] [--candidate ADDRESS ...]
//                                            [--rpc http://127.0.0.1:PORT --rehearsal]
//
// Every state answer is read at ONE block hash from every reviewed endpoint and used only when two answered and all
// that answered agree (lib.mjs `pinnedStateReader`, review R369-1). Per chain it checks and prints:
//   - the chain id on every endpoint, and block 0 against the pinned genesis hash (at least one endpoint serves it);
//   - the wrapped native token, every listed token and Multicall3: runtime code hash, name(), symbol() (the
//     configuration's `chainSymbol` where it has one) and decimals();
//   - per token, what a code hash does not show (token-behaviour.mjs): the transfer-fee getters and the declared
//     switches, which must read zero and false; the functions of interest its code dispatches on (a PUSH4 scan of
//     the runtime, and of the implementation behind an EIP-1967 proxy), compared with its `behaviour` block; the
//     implementation address and code hash of a proxy, for the record (the pin is the proxy's, as for USDC);
//   - per planned pair, its two price references exactly as market.mjs validates them (feed code, description and
//     decimals; the pool the publisher's factory names, its code and its depth) and the market they give now.
// --candidate ADDRESS prints the same facts for a contract that is not listed yet: what the owner needs before a
// token is added (section 8, "How the owner adds one"). The address itself must come from the issuer's or the
// chain's own published page; this tool cannot tell a token from its imitation.
//
// Exit status: 0 every listed fact holds, 1 one does not, 2 usage or configuration.
import { createRequire } from "node:module";
import { isMain } from "../staging/is-main.mjs";
import { createRpcTransport } from "../staging/rpc-transport.mjs";
import { BLOCKLIST_GETTERS, EMPTY_CODE_HASH, FEE_PARAMETER_GETTERS, MultichainError, SWITCH_GETTERS, chainSymbolOf, checksummed, loadChain, loadShared, pinnedStateReader, refuse, retrying } from "./lib.mjs";
import { marketRecord, pinnedBlock, readMarket } from "./market.mjs";
import { tokenBehaviourState } from "./token-behaviour.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { keccak256, encodeFunctionData, decodeFunctionResult, getAddress, parseAbi, toFunctionSelector } = requireFromFrontend("viem");

const ABI = parseAbi(["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)", "function getChainId() view returns (uint256)"]);
const EIP1967 = { implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc", admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" };
/** Functions whose presence says what an issuer can do. Reported per token; the first groups are compared with `behaviour`. */
export const FUNCTIONS_OF_INTEREST = Object.freeze({
  transferFee: FEE_PARAMETER_GETTERS.map((g) => `${g}()`).concat("setParams(uint256,uint256)"),
  switches: SWITCH_GETTERS.map((g) => `${g}()`).concat("pause()", "deprecate(address)"),
  blocklist: BLOCKLIST_GETTERS.map((g) => `${g}(address)`).concat("addBlackList(address)", "destroyBlackFunds(address)", "addToBlockedList(address)", "destroyBlockedFunds(address)", "blacklist(address)"),
  supply: ["issue(uint256)", "redeem(uint256)", "mint(address,uint256)", "mint(uint256)", "burn(address,uint256)", "burn(uint256)"],
  control: ["owner()", "transferOwnership(address)", "upgradeTo(address)", "upgradeToAndCall(address,bytes)", "l1Token()", "l2Bridge()", "oftContract()"],
});

/** The four-byte constants a runtime pushes (its function dispatch among them). Pure. */
export function pushedSelectors(code) {
  const bytes = Buffer.from(code.slice(2), "hex");
  const seen = new Set();
  for (let i = 0; i < bytes.length; i++) {
    const op = bytes[i];
    if (op === 0x63 && i + 4 < bytes.length) seen.add(`0x${bytes.subarray(i + 1, i + 5).toString("hex")}`);
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
  }
  return seen;
}
/** The functions of interest a runtime dispatches on, by group. Pure. */
export function functionsIn(code) {
  const seen = pushedSelectors(code);
  return Object.fromEntries(Object.entries(FUNCTIONS_OF_INTEREST).map(([group, list]) => [group, list.filter((f) => seen.has(toFunctionSelector(f)))]));
}
/** How a token's `behaviour` block differs from what its code dispatches on. Pure; [] when it describes the code. */
export function behaviourMismatch(token, functions) {
  const problems = [];
  const has = (signature) => Object.values(functions).some((list) => list.includes(signature));
  const declaredFee = token.behaviour?.transferFee?.parameters ?? [];
  for (const g of FEE_PARAMETER_GETTERS) if (has(`${g}()`) !== declaredFee.includes(g)) problems.push(`the code ${has(`${g}()`) ? "has" : "does not have"} ${g}() and the configuration ${declaredFee.includes(g) ? "declares" : "does not declare"} it (behaviour.transferFee)`);
  const declaredSwitches = token.behaviour?.switches ?? [];
  for (const g of SWITCH_GETTERS) if (token.behaviour && has(`${g}()`) !== declaredSwitches.includes(g)) problems.push(`the code ${has(`${g}()`) ? "has" : "does not have"} ${g}() and the configuration ${declaredSwitches.includes(g) ? "declares" : "does not declare"} it (behaviour.switches)`);
  const found = BLOCKLIST_GETTERS.filter((g) => has(`${g}(address)`));
  if (token.behaviour && (token.behaviour.blocklist ?? null) !== (found[0] ?? null)) problems.push(`the code's blocklist getter is ${found[0] ?? "none"} and the configuration says ${token.behaviour.blocklist ?? "none"} (behaviour.blocklist)`);
  return problems;
}

export async function verifyChain({ chain, requests, candidates = [], rehearsal = false }) {
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok: Boolean(ok), ...(detail === undefined || ok ? {} : { detail }) });
    return Boolean(ok);
  };
  const soft = (work) => work().then((v) => v, (error) => ({ failed: String(error?.message ?? error).slice(0, 200) }));
  const ids = await Promise.all(requests.map((r) => soft(() => r("eth_chainId", []))));
  check("every endpoint reports the pinned chain id", ids.every((id) => typeof id === "string" && Number(BigInt(id)) === chain.chain.chainId), ids);
  if (!rehearsal) {
    const genesis = (await Promise.all(requests.map((r) => soft(async () => (await r("eth_getBlockByNumber", ["0x0", false]))?.hash ?? null)))).filter((h) => typeof h === "string");
    check("block 0 is the pinned genesis on every endpoint that serves it, and at least one serves it", genesis.length > 0 && genesis.every((h) => h === chain.chain.genesisHash), genesis);
  }
  const at = await pinnedBlock(requests);
  const state = pinnedStateReader(requests, at.hash);
  const codeOf = (address) => state("eth_getCode", [address, "pinned"]);
  const hashOf = (code) => (code === "0x" ? EMPTY_CODE_HASH : keccak256(code));
  const ethCall = (to, data) => state("eth_call", [{ to, data }, "pinned"]);
  const call = async (to, functionName) => decodeFunctionResult({ abi: ABI, functionName, data: await ethCall(to, encodeFunctionData({ abi: ABI, functionName })) });
  const facts = async (address) => {
    const code = await codeOf(address);
    const out = { address, codeHash: hashOf(code), codeBytes: (code.length - 2) / 2 };
    for (const fn of ["name", "symbol", "decimals"]) {
      const v = await soft(() => call(address, fn));
      out[fn] = v?.failed ? null : fn === "decimals" ? Number(v) : v;
    }
    const slot = await soft(() => state("eth_getStorageAt", [address, EIP1967.implementation, "pinned"]));
    const implementation = typeof slot === "string" && !/^0x0{64}$/.test(slot) ? checksummedAddress(slot) : null;
    out.functions = functionsIn(code);
    if (implementation) {
      const inner = await codeOf(implementation);
      const admin = await soft(() => state("eth_getStorageAt", [address, EIP1967.admin, "pinned"]));
      out.proxy = { kind: "EIP-1967", implementation, implementationCodeHash: hashOf(inner), admin: typeof admin === "string" && !/^0x0{64}$/.test(admin) ? checksummedAddress(admin) : null };
      out.functions = functionsIn(inner);
    }
    return out;
  };
  const tokens = [];
  for (const token of [chain.wrappedNative, ...chain.tokens]) {
    const f = await facts(token.address);
    check(`${token.symbol} at ${token.address} holds the pinned code`, f.codeHash === token.codeHash, f.codeHash);
    check(`${token.symbol} answers the listed name, symbol and decimals`, f.name === token.name && f.symbol === chainSymbolOf(token) && f.decimals === token.decimals, { name: f.name, symbol: f.symbol, decimals: f.decimals });
    const behaviour = await tokenBehaviourState(ethCall, token);
    check(`${token.symbol} takes no fee on transfer and none of its declared switches is on`, behaviour.ok, behaviour.problems);
    const mismatch = behaviourMismatch(token, f.functions);
    check(`${token.symbol}: its configuration describes the fee parameters, switches and blocklist its code has`, mismatch.length === 0, mismatch);
    tokens.push({ key: token.symbol, ...f, state: behaviour.read });
  }
  const multicall = hashOf(await codeOf(chain.multicall3.address));
  check("Multicall3 holds the pinned code", multicall === chain.multicall3.codeHash, multicall);
  // Each planned pair's references, by the code that prices a first deposit.
  const markets = [];
  for (const pair of chain.initialPairs) {
    const name = `${pair.tokenA}/${pair.tokenB}`;
    const token = chain.tokens.find((t) => t.symbol === (pair.tokenA === chain.wrappedNative.symbol ? pair.tokenB : pair.tokenA));
    const market = await readMarket({ chain, token, requests, at });
    check(`${name}: its two price references hold their pinned code, are the publisher's, and agree`, market.ok, market.problems);
    markets.push({ pair: name, ...marketRecord(market) });
  }
  const others = [];
  for (const address of candidates) {
    const f = await facts(address);
    const state2 = await tokenBehaviourState(ethCall, { address, symbol: f.symbol ?? address, behaviour: { transferFee: { parameters: [...FEE_PARAMETER_GETTERS] }, switches: [] } });
    others.push({ ...f, feeParameters: Object.fromEntries(FEE_PARAMETER_GETTERS.map((g) => [g, state2.read[g]])) });
  }
  const failed = checks.filter((c) => !c.ok).map((c) => c.name);
  return { schema: "postern.dex.multichain-verify-chain.v1", chain: chain.chain.key, chainId: chain.chain.chainId, endpoints: requests.length, block: { number: Number(BigInt(at.number)), hash: at.hash, timestamp: Number(BigInt(at.timestamp)) }, tokens, multicall3: { address: chain.multicall3.address, codeHash: multicall }, markets, candidates: others, checks, failed, decision: failed.length === 0 ? "pass" : "fail" };
}
const checksummedAddress = (word) => getAddress(`0x${word.slice(-40)}`);

export async function main(argv, print = console.log) {
  const usage = "usage: verify-chain.mjs <chain>|all [--json] [--candidate ADDRESS ...] [--rpc URL --rehearsal]";
  const [target, ...rest] = argv;
  refuse(target && !target.startsWith("--"), usage);
  const o = { json: false, rehearsal: false, candidates: [] };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--json") o.json = true;
    else if (rest[i] === "--rehearsal") o.rehearsal = true;
    else if (rest[i] === "--candidate" || rest[i] === "--rpc") {
      refuse(rest[i + 1] !== undefined && !rest[i + 1].startsWith("--"), `${rest[i]} needs a value`);
      if (rest[i] === "--rpc") o.rpc = rest[++i];
      else o.candidates.push(checksummed(rest[++i], "--candidate"));
    } else refuse(false, `unknown option ${rest[i]}\n${usage}`);
  }
  refuse(!o.rpc || o.rehearsal, "--rpc replaces the chain's reviewed endpoints and is for a rehearsal only: add --rehearsal");
  refuse(!o.rehearsal || /^http:\/\/127\.0\.0\.1:\d{2,5}\/?$/.test(o.rpc ?? ""), "--rehearsal needs --rpc http://127.0.0.1:PORT (a loopback fork)");
  const shared = loadShared();
  const keys = target === "all" ? shared.chains : [target];
  refuse(target === "all" || shared.chains.includes(target), `${target} is not in deployments/multichain.json chains`);
  refuse(keys.length === 1 || (o.candidates.length === 0 && !o.rehearsal), "--candidate and --rehearsal take one chain");
  const reports = [];
  for (const key of keys) {
    const chain = loadChain(key);
    const requests = (o.rehearsal ? [o.rpc] : chain.rpc).map((url) => retrying(createRpcTransport(url, { timeoutMs: 30_000 })));
    const report = await verifyChain({ chain, requests, candidates: o.candidates, rehearsal: o.rehearsal });
    reports.push(report);
    if (o.json) continue;
    print(`${chain.chain.name} (chain id ${report.chainId}), block ${report.block.number} (${report.block.hash}), ${report.endpoints} endpoint${report.endpoints === 1 ? "" : "s"}`);
    for (const c of report.checks) print(`${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok || c.detail === undefined ? "" : ` (${JSON.stringify(c.detail)})`}`);
    const line = (title, t, read) => {
      print(`     ${title}: code ${t.codeHash} (${t.codeBytes} bytes), name ${JSON.stringify(t.name)}, symbol ${JSON.stringify(t.symbol)}, decimals ${t.decimals}${t.proxy ? `; ${t.proxy.kind} proxy, implementation ${t.proxy.implementation} (code ${t.proxy.implementationCodeHash}), admin ${t.proxy.admin ?? "none in the standard slot"}` : "; not an EIP-1967 proxy"}`);
      print(`       read: ${Object.entries(read).map(([k, v]) => `${k} ${v}`).join(", ") || "no getter declared"}; functions found: ${Object.entries(t.functions).map(([g, list]) => `${g} [${list.join(", ")}]`).join("; ")}`);
    };
    for (const t of report.tokens) line(t.key, t, t.state);
    for (const c of report.candidates) line(`candidate ${c.address}`, c, c.feeParameters);
    for (const m of report.markets) print(`     ${m.pair}: ${m.ok ? `market ${m.market} token base units per whole native coin (references ${(m.spreadBps / 100).toFixed(2)}% apart)` : `NO MARKET PRICE: ${m.problems.join("; ")}`}`);
    print(`multichain verify-chain ${key}: ${report.decision.toUpperCase()}${report.failed.length ? ` (${report.failed.length} check${report.failed.length === 1 ? "" : "s"} failed)` : ""}`);
  }
  if (o.json) print(JSON.stringify(keys.length === 1 ? reports[0] : reports, null, 2));
  return reports.every((r) => r.decision === "pass") ? 0 : 1;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof MultichainError ? error.message : error);
      process.exit(2);
    },
  );
}
