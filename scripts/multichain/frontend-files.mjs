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
//                                               "pass"; a rehearsal or reference-plan report is refused unless
//                                               --rehearsal is given, which also replaces the endpoints by --rpc)
// --out writes both files into DIR/<chain>/ instead of deployments/<chain>/ (rehearsals). No RPC is contacted.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { GATE_DOMAIN, MultichainError, ROOT, loadChain, loadShared, lower, refuse } from "./lib.mjs";

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
    tokens: chain.tokens.map((t) => ({ address: lower(t.address), symbol: t.symbol, name: t.name, decimals: t.decimals, codeHash: t.codeHash, kind: t.kind })),
    multicall3: { address: lower(chain.multicall3.address), codeHash: chain.multicall3.codeHash },
    feeTo: lower(shared.feeTo.address),
    l2Only: { ...shared.l2Only },
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
  const pairs = report.pairs.filter((p) => p.created);
  refuse(pairs.length === report.pairs.length && pairs.length > 0, "the gate report does not show every planned pair created");
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof MultichainError ? error.message : error);
    process.exit(2);
  }
}
