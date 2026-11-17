#!/usr/bin/env node
// Is this address fit to be the depositing account (the factory's `firstDepositor`)? (docs/MULTICHAIN-DEPLOY.md,
// section 2, "The depositing key".) Read-only: eth_chainId, eth_blockNumber, eth_getCode, eth_getTransactionCount,
// eth_getBalance on the reviewed endpoints of every chain. It takes an ADDRESS, never a key; nothing is signed.
//
//   node scripts/multichain/check-depositor.mjs <address> [--record] [--out FILE]
//
// The pair accepts a first mint whose transaction ORIGIN is the first depositor (review R328-1), so the account
// must be a key that has done nothing and will do nothing but the printed first deposits. The address is refused
// unless, on EVERY chain of deployments/multichain.json and on at least two endpoints of each, it has
//   - no code (not a contract) and no EIP-7702 delegation (which is code at the account that others may drive),
//   - nonce 0 at the latest block and no pending transaction: it has never sent anything,
// and unless it is none of: the zero address, the fee address, the CREATE2 deployer, the reference rehearsal
// address, an accepted EIP-7702 delegate, an address the plan would deploy to, or ANY address written anywhere
// under deployments/ (a token, a pool, a feed, an old deployment, a multisig: nothing this repository has used).
// The address must be written exactly as EIP-55 writes it (a wrong capital is a typo and is refused).
//
// --record  when every check held: write the address into deployments/multichain.json as `firstDepositor`,
//           together with `firstDepositorCheck` (what was read, where and when). That file is the ONE place the
//           plan, the deploy script's inputs, the gate and first-deposit.mjs read the depositing account from;
//           lib.mjs refuses a `firstDepositor` that is not the recorded address. A balance is reported, not refused
//           (the account is funded before its first deposit; anyone can send dust to any address).
// Exit status: 0 fit, 1 a check failed (nothing is written), 2 usage or configuration.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMain } from "../staging/is-main.mjs";
import { createRpcTransport } from "../staging/rpc-transport.mjs";
import {
  EIP7702_PREFIX, MultichainError, PENDING, REFERENCE_FIRST_DEPOSITOR, ROOT, ZERO_ADDRESS, addressesInDeployments, checksummed, loadArtifacts, loadChain, lower, planChain, readJson, refuse, retrying, validateShared,
} from "./lib.mjs";

export const DEPOSITOR_CHECK_SCHEMA = "postern.dex.multichain-depositor-check.v1";

/** The checks that need no chain: what the address must not be. Pure apart from reading deployments/. */
export function offlineProblems(address, shared, { root = ROOT, planned = [] } = {}) {
  const a = lower(address);
  const problems = [];
  if (a === ZERO_ADDRESS) problems.push("it is the zero address");
  if (a === lower(shared.feeTo.address)) problems.push("it is the fee address: the depositing account is a dedicated key, never the fee wallet");
  if (a === lower(shared.create2.deployer)) problems.push("it is the CREATE2 deployer");
  if (a === lower(REFERENCE_FIRST_DEPOSITOR)) problems.push("it is the reference rehearsal address: nobody holds its key");
  if (shared.feeTo.delegation.accepted.some((d) => lower(d.delegate) === a)) problems.push("it is an EIP-7702 delegate contract");
  for (const p of planned) if (lower(p.address) === a) problems.push(`it is the address the plan would deploy ${p.what} to`);
  const places = addressesInDeployments(root).get(a);
  if (places) problems.push(`it appears in the repository's deployments (${places.join(", ")}): the depositing account must be an address used for nothing else`);
  return problems;
}

/** What one endpoint's answers say about the address on one chain. Pure. */
export function endpointVerdict({ chainId, expectedChainId, code, nonce, pendingNonce }) {
  const problems = [];
  if (chainId !== expectedChainId) problems.push(`the endpoint is chain ${chainId}, not ${expectedChainId}`);
  if (code !== "0x") problems.push(String(code).toLowerCase().startsWith(EIP7702_PREFIX) ? `it carries an EIP-7702 delegation (${code})` : "it holds contract code");
  if (nonce !== 0) problems.push(`it has already sent ${nonce} transaction${nonce === 1 ? "" : "s"} (nonce ${nonce})`);
  if (pendingNonce !== nonce) problems.push(`it has a pending transaction (pending nonce ${pendingNonce})`);
  return problems;
}

/**
 * Check `address` on every chain. `transportFor(url)` gives a JSON-RPC function (tests pass their own).
 * Returns { fit, address, problems, chains: { key: { endpoints: [...], problems } } }.
 */
export async function checkDepositor(address, shared, { root = ROOT, transportFor, artifacts = null, print = () => {} } = {}) {
  checksummed(address, "the address");
  const candidate = { ...structuredClone(shared), firstDepositor: address, firstDepositorCheck: { address, at: "candidate", chains: {} } };
  const planned = [];
  const chains = {};
  const problems = [];
  for (const key of shared.chains) {
    const chain = loadChain(key, root);
    if (artifacts && !Array.isArray(chain.reserveCaps)) refuse(false, `deployments/${key}/chain.json: reserveCaps is still open`);
    if (artifacts) {
      const plan = planChain(candidate, chain, artifacts);
      for (const c of Object.values(plan.contracts)) planned.push({ address: c.address, what: `the ${c.name} of ${key}` });
      for (const p of plan.pairs) planned.push({ address: p.address, what: `the pair ${p.tokenA}/${p.tokenB} of ${key}` });
    }
    const entry = { chainId: chain.chain.chainId, endpoints: [], problems: [] };
    for (const url of chain.rpc) {
      const request = transportFor(url);
      try {
        const chainId = Number(BigInt(await request("eth_chainId", [])));
        const block = Number(BigInt(await request("eth_blockNumber", [])));
        const code = await request("eth_getCode", [address, "latest"]);
        const nonce = Number(BigInt(await request("eth_getTransactionCount", [address, "latest"])));
        const pendingNonce = Number(BigInt(await request("eth_getTransactionCount", [address, "pending"])));
        const balance = BigInt(await request("eth_getBalance", [address, "latest"])).toString();
        const found = endpointVerdict({ chainId, expectedChainId: chain.chain.chainId, code, nonce, pendingNonce });
        entry.endpoints.push({ url, block, code: code === "0x" ? "none" : code, nonce, pendingNonce, balanceWei: balance, problems: found });
        for (const f of found) entry.problems.push(`${url}: ${f}`);
      } catch (error) {
        entry.endpoints.push({ url, unreachable: String(error?.message ?? error).slice(0, 120) });
      }
    }
    const answered = entry.endpoints.filter((e) => !e.unreachable);
    if (answered.length < 2) entry.problems.push(`only ${answered.length} endpoint${answered.length === 1 ? "" : "s"} answered; two are needed`);
    chains[key] = entry;
    print(`${entry.problems.length ? "FAIL" : "ok  "} ${chain.chain.name}: ${answered.map((e) => `${new URL(e.url).host} block ${e.block}: code ${e.code}, nonce ${e.nonce}, balance ${e.balanceWei} wei`).join(" | ")}${entry.problems.length ? `  ${entry.problems.join("; ")}` : ""}`);
    for (const p of entry.problems) problems.push(`${key}: ${p}`);
  }
  const offline = offlineProblems(address, shared, { root, planned });
  print(`${offline.length ? "FAIL" : "ok  "} not the zero address, the fee address, the CREATE2 deployer, the reference address, a delegate, a planned address, nor any address written under deployments/${offline.length ? `  ${offline.join("; ")}` : ""}`);
  problems.push(...offline);
  return { schema: DEPOSITOR_CHECK_SCHEMA, address, fit: problems.length === 0, problems, chains, planned };
}

/** The record written into deployments/multichain.json. */
export function checkRecord(result, at) {
  return {
    address: result.address,
    tool: "scripts/multichain/check-depositor.mjs",
    at,
    found: "no code, no EIP-7702 delegation, nonce 0 and no pending transaction on every endpoint listed; not the fee address, and not an address written under deployments/",
    chains: Object.fromEntries(Object.entries(result.chains).map(([key, c]) => [key, c.endpoints.filter((e) => !e.unreachable).map((e) => ({ endpoint: new URL(e.url).host, block: e.block, nonce: e.nonce, code: e.code, balanceWei: e.balanceWei }))])),
  };
}

export async function main(argv, print = console.log) {
  const usage = "usage: check-depositor.mjs <address> [--record] [--out FILE]";
  const [address, ...rest] = argv;
  refuse(address && /^0x[0-9a-fA-F]{40}$/.test(address), `${usage}\n(an ADDRESS: 0x and 40 hex digits. Never give this tool, or any tool, the key)`);
  const o = { record: false, out: null };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--record") o.record = true;
    else if (rest[i] === "--out" && rest[i + 1]) o.out = rest[++i];
    else refuse(false, `unknown option ${rest[i]}\n${usage}`);
  }
  const path = join(ROOT, "deployments/multichain.json");
  const raw = readJson(path);
  // The file as it is, but judged without a depositor of its own: this run decides about <address>.
  const shared = validateShared({ ...structuredClone(raw), firstDepositor: PENDING, firstDepositorCheck: undefined });
  const artifacts = existsSync(join(ROOT, "out/UniswapV2Factory.sol/UniswapV2Factory.json")) ? loadArtifacts() : null;
  if (!artifacts) print("note: the contracts are not built (forge build), so the planned addresses are not compared");
  const result = await checkDepositor(address, shared, { transportFor: (url) => retrying(createRpcTransport(url, { timeoutMs: 30_000 })), artifacts, print });
  if (o.out) writeFileSync(o.out, `${JSON.stringify(result, null, 2)}\n`);
  if (!result.fit) {
    print(`check-depositor ${address}: NOT FIT (${result.problems.length} problem${result.problems.length === 1 ? "" : "s"}); nothing was written. Create another key.`);
    return 1;
  }
  print(`check-depositor ${address}: FIT on ${Object.keys(result.chains).length} chains`);
  if (o.record) {
    refuse(raw.firstDepositor === PENDING || raw.firstDepositor === address, `deployments/multichain.json already names another depositing account (${raw.firstDepositor}). Changing it changes every address of the plan; set firstDepositor back to "${PENDING}" and remove firstDepositorCheck by hand first, if that is what you mean`);
    const next = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k === "firstDepositorCheck") continue;
      next[k] = k === "firstDepositor" ? address : v;
      if (k === "firstDepositor") next.firstDepositorCheck = checkRecord(result, new Date().toISOString().replace(/\.\d+Z$/, "Z"));
    }
    validateShared(structuredClone(next));
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
    print(`recorded in deployments/multichain.json (firstDepositor, firstDepositorCheck). Next: node scripts/multichain/plan.mjs all`);
  } else if (raw.firstDepositor !== address) print("not recorded (run again with --record to write it into deployments/multichain.json)");
  return 0;
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
