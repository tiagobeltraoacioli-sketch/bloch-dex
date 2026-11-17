#!/usr/bin/env node
// Review r17, third pass (agent 328): the built multichain page loaded in a real browser engine against the REAL
// reviewed endpoints, read-only: no wallet, no transaction, nothing signed.
//
//   node scripts/review/r328-live-page.mjs --port BASE --out DIR [--seconds 25] [--chains key,key]
//
// No deployment exists on any public chain, and a "not-deployed" record makes the page send nothing. So each chain
// gets a record that says "deployed" at the REFERENCE PLAN's addresses (where nothing is deployed) with a real,
// recent finalized block. The page then does everything it does at a page load up to the first code check: chain
// id, block 0, the settle block from two endpoints, and reads pinned to that block's hash on two endpoints; the
// expected end is its refusal "code differs" (nothing is deployed there). What this shows: the page's
// Content-Security-Policy lets the browser reach the listed endpoints, the endpoints answer a browser from
// another origin, and the two-endpoint reads work from a browser. What it cannot show: pools, quotes, a wallet.
// The site is built with the line's own build (a "local render" build, because the bundle is a file), served on
// BASE with its _headers, and driven through the DevTools protocol on BASE+1. PIDs are written to DIR/pids.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ROOT, loadArtifacts, loadChain, loadShared, lower, planChain } from "../multichain/lib.mjs";

const argv = process.argv.slice(2);
const opt = Object.fromEntries(argv.reduce((o, v, i, all) => (v.startsWith("--") ? [...o, [v.slice(2), all[i + 1]]] : o), []));
const base = Number(opt.port);
const out = resolve(opt.out);
const seconds = Number(opt.seconds ?? 25);
const shared = loadShared();
const keys = opt.chains ? opt.chains.split(",") : shared.chains;
mkdirSync(out, { recursive: true });
const post = async (url, method, params) => (await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;

const bundle = [];
for (const key of keys) {
  const chain = loadChain(key);
  const plan = planChain(shared, chain, loadArtifacts(), { reference: true });
  const network = JSON.parse(readFileSync(join(ROOT, "deployments", key, "frontend.network.json"), "utf8"));
  let final = null;
  for (const url of chain.rpc) { try { final = await post(url, "eth_getBlockByNumber", ["finalized", false]); if (final) break; } catch {} }
  const c = plan.contracts;
  bundle.push({
    network,
    record: {
      schemaVersion: 1, domain: "postern.dex.multichain-frontend-record.v1", key, chainId: chain.chain.chainId, status: "deployed", rehearsal: false,
      genesisHash: chain.chain.genesisHash, finalized: { number: Number(BigInt(final.number)) - 2000, hash: final.hash },
      feeTo: lower(shared.feeTo.address), firstDepositor: lower(plan.arguments.firstDepositor),
      factory: { address: lower(c.factory.address), codeHash: c.factory.runtimeCodeHash }, router: { address: lower(c.router.address), codeHash: c.router.runtimeCodeHash }, lens: { address: lower(c.lens.address), codeHash: c.lens.runtimeCodeHash },
      wrappedNative: lower(chain.wrappedNative.address), reserveCaps: [], pairCodeHash: plan.pair.runtimeCodeHash,
      pairs: plan.pairs.map((p) => ({ address: lower(p.address), token0: lower(p.token0), token1: lower(p.token1) })),
    },
  });
}
const bundleFile = join(out, "bundle.json");
writeFileSync(bundleFile, `${JSON.stringify(bundle, null, 2)}\n`);
const dist = join(out, "dist");
const front = join(ROOT, "frontend");
const build = spawnSync("node", ["node_modules/vite/bin/vite.js", "build", "--config", "vite.multichain.config.ts"], { cwd: front, encoding: "utf8", env: { ...process.env, POSTERN_MULTICHAIN_BUNDLE: bundleFile, POSTERN_MULTICHAIN_OUT: dist } });
if (build.status !== 0) { console.error(`${build.stdout}\n${build.stderr}`.slice(-1200)); process.exit(1); }
const finish = spawnSync("node", ["scripts/multichain-finish.mjs", dist, "--bundle", bundleFile], { cwd: front, encoding: "utf8" });
if (finish.status !== 0) { console.error(finish.stderr); process.exit(1); }
const csp = readFileSync(join(dist, "_headers"), "utf8").split("\n").find((l) => /content-security-policy/i.test(l)) ?? "";
writeFileSync(join(out, "csp.txt"), `${csp.trim()}\n`);

const chrome = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(existsSync);
const server = spawn("node", ["scripts/staging/render/serve.mjs", dist, String(base)], { cwd: ROOT, stdio: "ignore" });
const browser = spawn(chrome, ["--headless=new", `--remote-debugging-port=${base + 1}`, `--user-data-dir=${join(out, "profile")}`, "--no-first-run", "--disable-extensions", "about:blank"], { stdio: "ignore" });
writeFileSync(join(out, "pids"), `${server.pid} serve.mjs ${base}\n${browser.pid} chrome headless ${base + 1}\n`);
const stop = () => { server.kill("SIGTERM"); browser.kill("SIGTERM"); };
process.on("exit", stop);
const results = [];
try {
  let target;
  for (let i = 0; i < 60 && !target; i++) { await delay(500); target = await fetch(`http://127.0.0.1:${base + 1}/json`).then((r) => r.json()).then((l) => l.find((t) => t.type === "page"), () => null); }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  let events = [];
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result ?? d.error); pending.delete(d.id); } else if (d.method) events.push(d); };
  const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  await send("Network.enable"); await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");
  for (const key of keys) {
    events = [];
    await send("Page.navigate", { url: "about:blank" });
    await delay(300);
    events = [];
    await send("Page.navigate", { url: `http://127.0.0.1:${base}/#/${key}` });
    await delay(seconds * 1000);
    const text = (await send("Runtime.evaluate", { expression: "document.querySelector('main')?.innerText ?? document.body.innerText", returnByValue: true })).result?.value ?? "";
    const requests = new Map();
    for (const e of events) if (e.method === "Network.requestWillBeSent" && /^https:/.test(e.params.request.url)) requests.set(e.params.requestId, { host: new URL(e.params.request.url).host, method: e.params.request.method });
    const hosts = {};
    for (const e of events) {
      const r = requests.get(e.params?.requestId);
      if (!r || r.method !== "POST") continue;
      const h = (hosts[r.host] ??= { answered: 0, failed: 0, statuses: {} });
      if (e.method === "Network.responseReceived") { h.answered++; h.statuses[e.params.response.status] = (h.statuses[e.params.response.status] ?? 0) + 1; }
      if (e.method === "Network.loadingFailed") { h.failed++; h.lastError = `${e.params.errorText}${e.params.blockedReason ? ` (${e.params.blockedReason})` : ""}`; }
    }
    const consoleProblems = events.filter((e) => (e.method === "Log.entryAdded" && ["error", "warning"].includes(e.params.entry.level)) || e.method === "Runtime.exceptionThrown").map((e) => (e.params.entry?.text ?? e.params.exceptionDetails?.text ?? "").slice(0, 200));
    const row = { chain: key, hosts, csp: consoleProblems.filter((t) => /Content Security Policy/i.test(t)).length, cors: consoleProblems.filter((t) => /CORS|Access-Control/i.test(t)).length, otherConsole: consoleProblems.filter((t) => !/Content Security Policy|CORS|Access-Control/i.test(t)).slice(0, 4), page: text.replace(/\s+/g, " ").slice(0, 6000) };
    results.push(row);
    console.log(JSON.stringify(row));
  }
  ws.close();
} finally {
  writeFileSync(join(out, "result.json"), `${JSON.stringify({ at: new Date().toISOString(), seconds, results }, null, 2)}\n`);
  stop();
}
