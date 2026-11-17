#!/usr/bin/env node
// Review r17 (agent 328): R309-MC-5 at 0566af3 on a loopback fork. The post gate run before the chain's
// `finalized` block has reached the deployment must say WAIT (and fail), and pass once it has.
//   node scripts/review/r328-fork-wait.mjs <chain> --port PORT --out DIR --pid-file FILE
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ROOT, loadChain } from "../multichain/lib.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { privateKeyToAccount, generatePrivateKey } = requireFromFrontend("viem/accounts");
const [key, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.reduce((out, v, i, all) => (v.startsWith("--") ? [...out, [v.slice(2), all[i + 1]]] : out), []));
const chain = loadChain(key);
const url = `http://127.0.0.1:${Number(opt.port)}`;
mkdirSync(opt.out, { recursive: true });
let id = 0;
const rpc = async (method, params = []) => {
  const body = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) })).json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
};
if (await rpc("eth_chainId").then(() => true, () => false)) process.exit(2);
const anvil = spawn("anvil", ["--fork-url", chain.rpc[0], "--port", String(opt.port), "--host", "127.0.0.1", "--silent", "--compute-units-per-second", "40", "--retries", "8", "--fork-retry-backoff", "3000"], { stdio: ["ignore", "ignore", "inherit"] });
writeFileSync(opt["pid-file"], `${anvil.pid} anvil --fork-url ${chain.rpc[0]} --port ${opt.port}\n`);
process.on("exit", () => anvil.kill("SIGTERM"));
let bad = 0;
const check = (name, ok, detail) => {
  if (!ok) bad++;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};
try {
  for (let i = 0; i < 120; i++) if (await rpc("eth_chainId").then(() => true, () => false)) break; else await delay(500);
  const deployerKey = generatePrivateKey();
  await rpc("anvil_setBalance", [privateKeyToAccount(deployerKey).address, "0x3635c9adc5dea00000"]);
  const run = spawnSync("bash", ["scripts/multichain/deploy.sh", key, "broadcast", "--rehearsal-rpc", url, "--reference", "--", "--private-key", deployerKey], { cwd: ROOT, encoding: "utf8", env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1" } });
  check("deploy.sh broadcast exits 0", run.status === 0);
  const gate = (name) => {
    const r = spawnSync("node", ["scripts/multichain/gate.mjs", key, "post", "--reference", "--rpc", url, "--rehearsal", "--out", join(opt.out, `${name}.json`)], { cwd: ROOT, encoding: "utf8" });
    writeFileSync(join(opt.out, `${name}.log`), `${r.stdout}\n${r.stderr}`);
    return { status: r.status, text: r.stdout };
  };
  const early = gate("gate-early");
  const wait = early.text.split("\n").find((l) => l.startsWith("WAIT"));
  check("the post gate run at once fails (exit 1) and prints a WAIT line that names the three contracts", early.status === 1 && /factory.*router.*lens|factory, router, lens/.test(wait ?? ""), wait?.slice(0, 200));
  check("its failing checks are only the three 'holds the planned code at the finalized block' lines", early.text.split("\n").filter((l) => l.startsWith("FAIL")).every((l) => l.includes("holds the planned code at the finalized block")), String(early.text.split("\n").filter((l) => l.startsWith("FAIL")).length));
  await rpc("anvil_mine", ["0x46"]);
  const later = gate("gate-later");
  check("after the fork's finalized block passed the deployment the same gate passes", later.status === 0 && !later.text.includes("WAIT"));
} catch (error) {
  bad++;
  console.error(error);
}
console.log(`r328 fork wait ${key}: ${bad ? "NOT AS EXPECTED" : "AS EXPECTED"}`);
process.exit(bad ? 1 : 0);
