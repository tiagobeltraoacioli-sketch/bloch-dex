#!/usr/bin/env node
// Second step of the multichain site's build (after `vite build --config vite.multichain.config.ts`):
//
//   node scripts/multichain-finish.mjs [OUT_DIR] [--bundle FILE]
//
// multichain.html becomes index.html, and _headers is written with a Content-Security-Policy that names every
// endpoint of every bundled chain (--bundle: the same rehearsal file the build was given; then the policy names
// the loopback forks and drops upgrade-insecure-requests, because a rehearsal is served over plain http).
// The files of public/ are shared with the Bloch L2 site and say "Postern"; the multichain site is "Bloch DEX"
// (owner, 2026-11-18; review R412-7). Three of them name the site and are put right here, in the output only:
// the 404 page's title, the first sentence of THIRD-PARTY-NOTICES.txt, and social-preview.png, which is replaced
// by multichain-public/social-preview.png (rendered from its SVG source by scripts/render-social-preview.mjs;
// refused when the source changed since). A sentence that is no longer there is an error, not a silent skip.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderHeadersFile } from "../src/mainnet/headers.ts";
import { multichainHeadersFile } from "../src/multichain/headers.ts";

const here = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
const at = argv.indexOf("--bundle");
const bundleFile = at >= 0 ? argv[at + 1] : null;
// The value of --bundle is not the output directory. (Without --bundle, `at` is -1: the first argument IS the
// directory; before agent 410 it was skipped as if it followed the flag, and the default directory was written.)
const out = resolve(argv.find((a, i) => !a.startsWith("--") && (at < 0 || i !== at + 1)) ?? join(here, "dist-multichain"));
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

const SITE = "Bloch DEX";
/** Replace one exact text in a file of the output; the text must be there exactly once (or already replaced). */
function rename(file, from, to) {
  const path = join(out, file);
  if (!existsSync(path)) throw new Error(`${out} holds no ${file}`);
  const text = readFileSync(path, "utf8");
  if (text.includes(to) && !text.includes(from)) return;
  if (text.split(from).length !== 2) throw new Error(`${file}: expected exactly one "${from}"`);
  writeFileSync(path, text.replace(from, to));
}
rename("404.html", "<title>Postern: no gate here</title>", `<title>${SITE}: no gate here</title>`);
rename("THIRD-PARTY-NOTICES.txt", "This page is built from PosternDEX's own code", `This page is built from ${SITE}'s own code`);
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
// POSTERN_MULTICHAIN_PUBLIC: another directory for the image, its source and their record (the test of the refusals below).
const art = process.env.POSTERN_MULTICHAIN_PUBLIC ?? join(here, "multichain-public");
const made = JSON.parse(readFileSync(join(art, "social-preview.json"), "utf8"));
if (sha256(readFileSync(join(art, made.source.file))) !== made.source.sha256) throw new Error("multichain-public/social-preview.svg changed since the image was rendered: run scripts/render-social-preview.mjs");
if (sha256(readFileSync(join(art, made.image.file))) !== made.image.sha256) throw new Error("multichain-public/social-preview.png is not the image scripts/render-social-preview.mjs wrote");
copyFileSync(join(art, made.image.file), join(out, "social-preview.png"));
console.log(`multichain site: ${out}/index.html and _headers (${new Set(urls.map((u) => new URL(u).origin)).size} RPC origins in connect-src)`);
