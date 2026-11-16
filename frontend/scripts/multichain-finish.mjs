#!/usr/bin/env node
// Second step of the multichain site's build (after `vite build --config vite.multichain.config.ts`):
//
//   node scripts/multichain-finish.mjs [OUT_DIR] [--bundle FILE]
//
// multichain.html becomes index.html, and _headers is written with a Content-Security-Policy that names every
// endpoint of every bundled chain (--bundle: the same rehearsal file the build was given; then the policy names
// the loopback forks and drops upgrade-insecure-requests, because a rehearsal is served over plain http).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderHeadersFile } from "../src/mainnet/headers.ts";
import { multichainHeadersFile } from "../src/multichain/headers.ts";

const here = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
const at = argv.indexOf("--bundle");
const bundleFile = at >= 0 ? argv[at + 1] : null;
const out = resolve(argv.find((a, i) => !a.startsWith("--") && i !== at + 1) ?? join(here, "dist-multichain"));
let networks;
if (bundleFile) networks = JSON.parse(readFileSync(bundleFile, "utf8")).map((entry) => entry.network);
else {
  const shared = JSON.parse(readFileSync(join(here, "../deployments/multichain.json"), "utf8"));
  networks = shared.chains.map((key) => JSON.parse(readFileSync(join(here, "../deployments", key, "frontend.network.json"), "utf8")));
}
const urls = networks.flatMap((n) => n.rpc.urls);
let headers = multichainHeadersFile(urls, renderHeadersFile);
if (bundleFile) headers = headers.replace(/; *upgrade-insecure-requests/, "");
if (existsSync(join(out, "multichain.html"))) renameSync(join(out, "multichain.html"), join(out, "index.html"));
if (!existsSync(join(out, "index.html"))) throw new Error(`${out} holds no built page`);
writeFileSync(join(out, "_headers"), headers);
console.log(`multichain site: ${out}/index.html and _headers (${new Set(urls.map((u) => new URL(u).origin)).size} RPC origins in connect-src)`);
