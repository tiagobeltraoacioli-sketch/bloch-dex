#!/usr/bin/env node
// Page rehearsal of the multichain site against loopback forks of every chain (docs/MULTICHAIN-DEPLOY.md,
// "Page rehearsal"):
//
//   node scripts/multichain/rehearse-page.mjs --port BASE --out DIR [--chains key,key,…]
//
// For each chain, in turn: rehearse-fork.mjs in hold mode (an anvil fork on BASE+i, the owner's deploy command, the
// post gate, the first depositor's first deposit as first-deposit.mjs prints it, the post gate again, a pool that
// stays). Then the rehearsal files of the page are derived from each fork's gate
// report, the multichain site is built with them (a "not for publication" build), served on BASE+10 with its own
// headers, and frontend/integration/browser/multichain.mjs drives it in headless Chrome (DevTools on BASE+11).
// The page reads each fork through TWO stand-in endpoints (endpoint-proxy.mjs on BASE+20+2i and BASE+21+2i), as it
// reads a public chain through two endpoints; the browser scenarios make them disagree, limit requests and
// recover (set MULTICHAIN_SHOTS=<dir> for screenshots of each state).
// Everything is loopback and throwaway; the forks read the public endpoints. Exit status 0 only when every fork
// rehearsal and every browser assertion passed.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ROOT, loadChain, loadShared, lower } from "./lib.mjs";

const argv = process.argv.slice(2);
const opt = Object.fromEntries(argv.reduce((out, v, i, all) => (v.startsWith("--") ? [...out, [v.slice(2), all[i + 1]]] : out), []));
if (!opt.port || !opt.out) {
  console.error("usage: rehearse-page.mjs --port BASE --out DIR [--chains key,key,…]");
  process.exit(2);
}
const base = Number(opt.port);
const out = resolve(opt.out);
const shared = loadShared();
const keys = opt.chains ? opt.chains.split(",") : shared.chains;
const chrome = process.env.CHROME_EXE ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(existsSync);
if (!chrome) {
  console.error("no browser found; set CHROME_EXE to a Chrome or Chromium binary");
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const hold = join(out, "hold");
writeFileSync(hold, "the forks stay up while this file exists\n");
const children = [];
const stop = () => {
  // Removing the hold file ends each fork rehearsal, which stops its own anvil; SIGTERM does the same.
  rmSync(hold, { force: true });
  for (const child of children) child.kill("SIGTERM");
};
process.on("SIGINT", () => (stop(), process.exit(130)));
process.on("SIGTERM", () => (stop(), process.exit(143)));
const say = (line) => console.log(line);
let status = 1;
try {
  // 1. One held fork per chain.
  const chains = [];
  for (const [i, key] of keys.entries()) {
    const chain = loadChain(key);
    const dir = join(out, key);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const port = base + i;
    say(`== fork of ${key} on 127.0.0.1:${port}`);
    const child = spawn("node", ["scripts/multichain/rehearse-fork.mjs", key, "--port", String(port), "--out", dir, "--hold", hold], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let log = "";
    child.stdout.on("data", (d) => (log += d));
    child.stderr.on("data", (d) => (log += d));
    let exited = null;
    child.on("exit", (code) => (exited = code));
    const ready = join(dir, "ready");
    for (let waited = 0; !existsSync(ready) && exited === null && waited < 1200; waited++) await delay(1000);
    writeFileSync(join(dir, "fork.log"), log);
    if (!existsSync(ready) || readFileSync(ready, "utf8").trim() !== "PASS") throw new Error(`the fork rehearsal of ${key} did not pass: ${log.split("\n").filter((l) => /^FAIL|rror/.test(l)).slice(0, 3).join(" | ")}`);
    say(`   fork rehearsal PASS`);
    const report = JSON.parse(readFileSync(join(dir, "gate-report.json"), "utf8"));
    chains.push({
      key,
      name: chain.chain.name,
      chainId: chain.chain.chainId,
      rpc: `http://127.0.0.1:${port}`,
      // The two endpoints the page reads this fork through.
      endpoints: [0, 1].map((n) => `http://127.0.0.1:${base + 20 + 2 * i + n}`),
      native: chain.nativeCurrency.symbol,
      wrapped: { address: lower(chain.wrappedNative.address), symbol: chain.wrappedNative.symbol },
      // `shown`: what the page prints for the token (its label where the network file gives one: BNB Smart Chain's
      // "USDC (Binance-Peg)", review R344-UI-16); `symbol` stays the contract's own.
      token: { address: lower(chain.tokens[0].address), symbol: chain.tokens[0].symbol, shown: chain.tokens[0].label ?? chain.tokens[0].symbol, note: chain.tokens[0].note ?? null },
      router: lower(report.plan.contracts.router.address),
      // The chain's confirmation rule and measured block time: the browser scenarios mine at that pace.
      confirmation: { settle: chain.confirmation.settle, strict: chain.confirmation.strict, blockSeconds: chain.confirmation.measured.blockSeconds },
      deadlineMinutes: chain.swap.deadlineMinutes,
    });
  }
  // 2. The page's rehearsal files, from each fork's gate report.
  const files = join(out, "files");
  const bundle = [];
  for (const chain of chains) {
    const made = spawnSync("node", ["scripts/multichain/frontend-files.mjs", chain.key, "--gate-report", join(out, chain.key, "gate-report.json"), "--out", files, "--rpc", chain.rpc, "--rehearsal"], { cwd: ROOT, encoding: "utf8" });
    if (made.status !== 0) throw new Error(`frontend-files.mjs ${chain.key}: ${made.stderr}`);
    const network = JSON.parse(readFileSync(join(files, chain.key, "frontend.network.json"), "utf8"));
    // The page's endpoints of this chain: two stand-ins in front of the fork (a rehearsal file may list several
    // loopback URLs; with two, every pinned read must agree on both, as in production).
    for (const endpoint of chain.endpoints) {
      const child = spawn("node", ["scripts/multichain/endpoint-proxy.mjs", new URL(endpoint).port, chain.rpc], { cwd: ROOT, stdio: "ignore" });
      children.push(child);
    }
    network.rpc.urls = chain.endpoints;
    bundle.push({ network, record: JSON.parse(readFileSync(join(files, chain.key, "frontend.record.json"), "utf8")) });
  }
  const bundleFile = join(out, "bundle.json");
  writeFileSync(bundleFile, `${JSON.stringify(bundle, null, 2)}\n`);
  // 3. The production build of the multichain site with that bundle, and its headers.
  say("== build of the multichain site with the rehearsal bundle");
  const dist = join(out, "dist");
  const front = join(ROOT, "frontend");
  const build = spawnSync("node", ["node_modules/vite/bin/vite.js", "build", "--config", "vite.multichain.config.ts"], { cwd: front, encoding: "utf8", env: { ...process.env, POSTERN_MULTICHAIN_BUNDLE: bundleFile, POSTERN_MULTICHAIN_OUT: dist } });
  if (build.status !== 0) throw new Error(`the build failed: ${`${build.stdout}\n${build.stderr}`.slice(-800)}`);
  const finish = spawnSync("node", ["scripts/multichain-finish.mjs", dist, "--bundle", bundleFile], { cwd: front, encoding: "utf8" });
  if (finish.status !== 0) throw new Error(`multichain-finish.mjs: ${finish.stderr}`);
  const server = spawn("node", ["scripts/staging/render/serve.mjs", dist, String(base + 10)], { cwd: ROOT, stdio: "ignore" });
  children.push(server);
  await delay(800);
  // 4. The browser scenarios.
  let revision = "export";
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  if (head.status === 0) revision = head.stdout.trim();
  const harness = join(out, "harness.json");
  writeFileSync(harness, `${JSON.stringify({ page: `http://127.0.0.1:${base + 10}/`, chrome, debugPort: base + 11, out, revision, chains }, null, 2)}\n`);
  say("== browser scenarios in headless Chrome");
  const run = spawnSync("node", ["frontend/integration/browser/multichain.mjs", harness], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  process.stdout.write(run.stdout);
  if (run.status !== 0) process.stderr.write(run.stderr);
  writeFileSync(join(out, "browser.log"), `${run.stdout}\n${run.stderr}`);
  status = run.status === 0 ? 0 : 1;
} catch (error) {
  console.error(String(error.message ?? error));
} finally {
  stop();
}
console.log(`multichain page rehearsal: ${status === 0 ? "PASS" : "FAIL"} (${out})`);
process.exit(status);
