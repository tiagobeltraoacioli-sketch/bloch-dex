#!/usr/bin/env node
// Third-party notices of the page's bundle (docs/LICENSING.md section 4).
//
//   node scripts/third-party-notices.mjs            write public/THIRD-PARTY-NOTICES.txt
//   node scripts/third-party-notices.mjs --check    exit 1 when the committed file is not the generated one
//
// Source of truth: package-lock.json. Every package that is not development-only (no `dev` flag in the lockfile)
// and is not a platform-specific binary is listed with its version and declared licence, and each distinct licence
// text found in the packages is printed once, with the packages it came from. That is a SUPERSET of what the
// bundler puts into a build (it leaves out what no page imports), so nothing that ships is missing. The file lives
// in public/, which both builds (the Bloch L2 site and the multichain site) copy into their output as it is.
// Needs `npm ci --ignore-scripts` first. No network.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("..", import.meta.url));
const OUT = join(here, "public/THIRD-PARTY-NOTICES.txt");
const lock = JSON.parse(readFileSync(join(here, "package-lock.json"), "utf8"));
const packages = [];
const absent = [];
for (const [path, entry] of Object.entries(lock.packages)) {
  if (!path.startsWith("node_modules/") || entry.dev) continue;
  // A package built for one operating system or processor (the lockfile lists every platform's binaries of the
  // build tools) is never part of a page; leaving these out also makes the file the same on every machine.
  if (entry.os || entry.cpu) {
    absent.push(path);
    continue;
  }
  const dir = join(here, path);
  if (!existsSync(join(dir, "package.json"))) throw new Error(`${path} is in the lockfile but not installed: run npm ci --ignore-scripts`);
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const declared = typeof manifest.license === "string" ? manifest.license : Array.isArray(manifest.licenses) ? manifest.licenses.map((l) => l.type).join(" OR ") : (manifest.license?.type ?? "NOT DECLARED");
  const files = readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)([.-].*)?$/i.test(f)).sort();
  const texts = files.map((f) => ({ file: f, text: readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n").trim() }));
  packages.push({ name: path.slice(path.lastIndexOf("node_modules/") + 13), path, version: manifest.version, declared, texts });
}
packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || a.path.localeCompare(b.path));
const seen = new Set();
const unique = packages.filter((p) => !seen.has(`${p.name}@${p.version}`) && seen.add(`${p.name}@${p.version}`));
const byText = new Map();
for (const p of unique)
  for (const t of p.texts) {
    const key = createHash("sha256").update(t.text).digest("hex");
    if (!byText.has(key)) byText.set(key, { text: t.text, from: [] });
    byText.get(key).from.push(`${p.name}@${p.version} (${t.file})`);
  }
const counts = {};
for (const p of unique) counts[p.declared] = (counts[p.declared] ?? 0) + 1;
const noText = unique.filter((p) => p.texts.length === 0);
const lines = [
  "THIRD-PARTY NOTICES",
  "",
  "This page is built from PosternDEX's own code (MIT License, see the repository's LICENSE) and from the",
  "third-party packages listed below, each under its own licence. The list is every non-development package of",
  "the build's lockfile: a superset of what a given build contains.",
  "",
  "Portions (c) 2025 Reown, Inc. All Rights Reserved",
  "(Reown AppKit and WalletConnect, under the Reown Community License Agreement and the WalletConnect Community",
  "License Agreement, both reproduced below.)",
  "",
  "The Inter typeface: Copyright (c) The Inter Project Authors (https://github.com/rsms/inter), SIL Open Font",
  "License 1.1, reproduced below (package @fontsource-variable/inter).",
  "",
  `Packages: ${unique.length}. Declared licences: ${Object.entries(counts).sort().map(([k, v]) => `${k} (${v})`).join(", ")}.`,
  "",
  "PACKAGES",
  "",
  ...unique.map((p) => `${p.name} ${p.version}  --  ${p.declared}`),
  "",
  ...(noText.length ? ["Packages that ship no licence file of their own (their declared licence above applies):", ...noText.map((p) => `  ${p.name} ${p.version}  --  ${p.declared}`), ""] : []),
  "LICENCE TEXTS",
];
for (const { text, from } of [...byText.values()].sort((a, b) => a.from[0].localeCompare(b.from[0]))) {
  lines.push("", "=".repeat(100), `From: ${from.join(", ")}`, "=".repeat(100), "", text);
}
const output = `${lines.join("\n")}\n`;
if (process.argv.includes("--check")) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== output) {
    console.error("public/THIRD-PARTY-NOTICES.txt is not the generated one: run node scripts/third-party-notices.mjs");
    process.exit(1);
  }
  console.log(`public/THIRD-PARTY-NOTICES.txt is current (${unique.length} packages, ${byText.size} licence texts)`);
} else {
  writeFileSync(OUT, output);
  console.log(`wrote public/THIRD-PARTY-NOTICES.txt: ${unique.length} packages, ${byText.size} licence texts, ${output.length} bytes; ${absent.length} platform-specific binaries of build tools are not listed; ${noText.length} packages ship no licence file`);
}
