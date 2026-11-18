#!/usr/bin/env node
// The two files the page bundles per chain (frontend/src/multichain/config.ts), derived, never typed by hand:
//
//   node scripts/multichain/frontend-files.mjs <chain>|all [--gate-report FILE] [--out DIR] [--rpc URL --rehearsal]
//
//   deployments/<chain>/frontend.network.json   wallet network parameters, the reviewed RPC endpoints, the explorer,
//                                               the wrapped native token and the token list, each with its pinned
//                                               code hash; every Bloch-L2-only rule stated off
//   deployments/<chain>/frontend.record.json    "not-deployed", or the deployment as the post gate verified it
//                                               (--gate-report: a report of `gate.mjs <chain> post` with decision
//                                               "pass" and at least one planned pair open. The record lists
//                                               exactly the pairs the gate reports OPEN WITH THEIR OPENING
//                                               PROVEN, and names every other planned pair under `notOpen`
//                                               (round 20: pairs open one at a time; the page shows such a
//                                               pair as "not open yet" and sends nothing for it). A
//                                               rehearsal or reference-plan report is refused unless
//                                               --rehearsal is given, which also replaces the endpoints by --rpc)
// --out writes both files into DIR/<chain>/ instead of deployments/<chain>/ (rehearsals). No RPC is contacted.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMain } from "../staging/is-main.mjs";
import { GATE_DOMAIN, MultichainError, ROOT, ZERO_ADDRESS, chainSymbolOf, loadChain, loadShared, lower, refuse } from "./lib.mjs";

export const FRONTEND_NETWORK_DOMAIN = "postern.dex.multichain-frontend-network.v1";
export const FRONTEND_RECORD_DOMAIN = "postern.dex.multichain-frontend-record.v1";

export function frontendNetwork(shared, chain, { rpc = null } = {}) {
  return {
    schemaVersion: 1,
    domain: FRONTEND_NETWORK_DOMAIN,
    key: chain.chain.key,
    chainId: chain.chain.chainId,
    chainName: chain.chain.name,
    nativeCurrency: chain.nativeCurrency,
    genesisHash: chain.chain.genesisHash,
    rpc: { urls: rpc ? [rpc] : chain.rpc, rehearsal: Boolean(rpc) },
    explorer: { url: rpc ? null : chain.explorer },
    wrappedNative: { address: lower(chain.wrappedNative.address), symbol: chain.wrappedNative.symbol, codeHash: chain.wrappedNative.codeHash },
    // `label` and `note` (optional): what the page shows instead of the contract's own symbol, and one line under it
    // (BNB Smart Chain's Binance-Peg "USDC" is never shown as plain USDC).
    // `symbol` is the contract's own symbol (the page pins it against the chain): `chainSymbol` where the
    // configuration gives one (Arbitrum One's "USD₮0"; the tools' key "USDT0" is not a symbol of the chain).
    // `approve: "zero-first"` (round 20): the token's approve reverts on a change from one non-zero allowance to
    // another (Tether on Ethereum); the page then asks for a reset to zero before a new approval.
    tokens: chain.tokens.map((t) => ({ address: lower(t.address), symbol: chainSymbolOf(t), ...(t.label ? { label: t.label, note: t.note } : {}), name: t.name, decimals: t.decimals, codeHash: t.codeHash, kind: t.kind, ...(t.behaviour?.approveZeroFirst ? { approve: "zero-first" } : {}) })),
    multicall3: { address: lower(chain.multicall3.address), codeHash: chain.multicall3.codeHash },
    feeTo: lower(shared.feeTo.address),
    l2Only: { ...shared.l2Only },
    // Optional fields (added by review R309-MC-2 and MC-6; a page that does not know them keeps `finalized` and
    // its own default deadline).
    confirmation: { settle: chain.confirmation.settle, strict: chain.confirmation.strict, ...(chain.confirmation.reverted ? { reverted: chain.confirmation.reverted } : {}), blockSeconds: chain.confirmation.measured.blockSeconds },
    swap: { deadlineMinutes: chain.swap.deadlineMinutes },
  };
}

export function frontendRecord(shared, chain, report = null, { rehearsal = false } = {}) {
  const base = { schemaVersion: 1, domain: FRONTEND_RECORD_DOMAIN, key: chain.chain.key, chainId: chain.chain.chainId };
  if (!report) return { ...base, status: "not-deployed" };
  refuse(report.domain === GATE_DOMAIN && report.phase === "post" && report.decision === "pass" && report.failed?.length === 0, "the gate report is not a passed post gate");
  refuse(report.chain?.chainId === chain.chain.chainId && report.chain?.genesisHash === chain.chain.genesisHash, "the gate report is for another chain");
  refuse(rehearsal || (!report.rehearsal && !report.referencePlan), "the gate report is a rehearsal or a reference plan; a page for the public chain needs the real one");
  refuse(lower(report.plan.arguments.feeTo) === lower(shared.feeTo.address), "the gate report has another fee address");
  refuse(report.finalized && Number.isSafeInteger(report.finalized.number) && /^0x[0-9a-f]{64}$/.test(report.finalized.hash), "the gate report has no finalized block");
  refuse(lower(report.plan.arguments.firstDepositor) !== ZERO_ADDRESS, "the gate report is of a factory with open first deposits");
  // Round 20: pairs open one at a time (a chain live with its first pool stays live while a second is planned).
  // What is kept, word for word, while NO planned pair is open: the two refusals below, as before.
  const open = report.pairs.filter((p) => p.state === "open");
  if (open.length === 0) {
    const created = report.pairs.filter((p) => p.created);
    refuse(created.length === report.pairs.length && created.length > 0, "the gate report does not show every planned pair created: make the first deposit of each (first-deposit.mjs), then run the post gate again");
    // A page for a pool nobody opened would show an empty market; and an opened pool is the proof that the first
    // deposit went through the guarded path (only the first depositor can open a pool of this factory).
    refuse(false, "the gate report shows a planned pair that is not open yet: make its first deposit (first-deposit.mjs), then run the post gate again");
  }
  // "Open" does not say who opened a pool (the pair accepts a first mint by transaction origin): the gate must
  // have proven each opening from its transaction (review R328-1). EVERY open pair, not only the listed ones: a
  // report with one open pair that is not proven writes no record at all.
  refuse(open.every((p) => p.opening?.proven === true), "the gate report does not prove who opened each pool: run the post gate with --opening PAIR=HASH (first-deposit.mjs verify prints it)");
  // The page lists `pairs` and nothing else. A planned pair that is absent, empty or holds tokens without shares
  // is named under `notOpen` with its state: the page shows it as not open yet, never as a market, and builds no
  // transaction for it (frontend/src/multichain/config.ts).
  const pairs = open;
  const notOpen = report.pairs.filter((p) => p.state !== "open");
  refuse(pairs.length <= 8 && notOpen.every((p) => ["absent", "empty", "donated"].includes(p.state)), "the gate report has a pair in a state this tool does not know");
  const contracts = report.plan.contracts;
  return {
    ...base,
    status: "deployed",
    rehearsal: Boolean(report.rehearsal),
    genesisHash: report.chain.genesisHash,
    finalized: { number: report.finalized.number, hash: report.finalized.hash },
    feeTo: lower(report.plan.arguments.feeTo),
    firstDepositor: lower(report.plan.arguments.firstDepositor),
    factory: { address: lower(contracts.factory.address), codeHash: contracts.factory.runtimeCodeHash },
    router: { address: lower(contracts.router.address), codeHash: contracts.router.runtimeCodeHash },
    lens: { address: lower(contracts.lens.address), codeHash: contracts.lens.runtimeCodeHash },
    wrappedNative: lower(report.plan.arguments.wrappedNative),
    reserveCaps: report.plan.arguments.reserveCaps.map((c) => ({ token: lower(c.token), cap: c.cap })),
    pairCodeHash: report.plan.pair.runtimeCodeHash,
    pairs: pairs.map((p) => ({ address: lower(p.address), token0: lower(p.token0), token1: lower(p.token1) })),
    // Only when a planned pair is not open (round 20), so that a record of a chain whose pairs are all open is the
    // record it always was.
    ...(notOpen.length ? { notOpen: notOpen.map((p) => ({ address: lower(p.address), token0: lower(p.token0), token1: lower(p.token1), state: p.state })) } : {}),
  };
}

export function main(argv) {
  const [target, ...rest] = argv;
  refuse(target, "usage: frontend-files.mjs <chain>|all [--gate-report FILE] [--out DIR] [--rpc URL --rehearsal]");
  const o = { rehearsal: false };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--rehearsal") o.rehearsal = true;
    else if (["--gate-report", "--out", "--rpc"].includes(rest[i])) o[rest[i].slice(2)] = rest[++i];
    else refuse(false, `unknown option ${rest[i]}`);
  }
  refuse(!o.rpc || (o.rehearsal && /^http:\/\/127\.0\.0\.1:\d{2,5}\/?$/.test(o.rpc)), "--rpc is a loopback URL and needs --rehearsal");
  refuse(!o.rehearsal || o.out, "--rehearsal never writes into deployments/: give --out DIR");
  const shared = loadShared();
  const keys = target === "all" ? shared.chains : [target];
  refuse(target === "all" || shared.chains.includes(target), `${target} is not in deployments/multichain.json chains`);
  refuse(!o["gate-report"] || keys.length === 1, "--gate-report takes one chain");
  for (const key of keys) {
    const chain = loadChain(key);
    const dir = o.out ? join(o.out, key) : join(ROOT, "deployments", key);
    mkdirSync(dir, { recursive: true });
    const report = o["gate-report"] ? JSON.parse(readFileSync(o["gate-report"], "utf8")) : null;
    writeFileSync(join(dir, "frontend.network.json"), `${JSON.stringify(frontendNetwork(shared, chain, { rpc: o.rpc ?? null }), null, 2)}\n`);
    // Without a report an existing committed record is left as it is: "all" refreshes the network files only.
    if (report || o.out || target !== "all" || !existsRecord(dir)) writeFileSync(join(dir, "frontend.record.json"), `${JSON.stringify(frontendRecord(shared, chain, report, { rehearsal: o.rehearsal }), null, 2)}\n`);
    console.log(`wrote ${dir}/frontend.network.json and frontend.record.json (${report ? "deployed" : "not-deployed or kept"})`);
  }
}
function existsRecord(dir) {
  try {
    readFileSync(join(dir, "frontend.record.json"));
    return true;
  } catch {
    return false;
  }
}

// isMain: a start through a symbolic link must not do nothing and exit 0 (review R309-MC-4).
if (isMain(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof MultichainError ? error.message : error);
    process.exit(2);
  }
}
