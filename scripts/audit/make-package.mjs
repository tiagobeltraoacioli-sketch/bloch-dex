#!/usr/bin/env node
// Generate the external audit package of postern-dex FOR ONE COMMIT, from that commit's own
// files: the commit is exported with `git archive` into a temporary directory, so nothing in
// the working tree (uncommitted edits, build output) can leak into the figures.
//
//   node scripts/audit/make-package.mjs --commit <rev> [--out docs/audit/package] [--logs <dir>]
//        [--skip-tests] [--bridge-repo <clean bridge checkout, built with forge>]
//        [--safe-artifacts <@safe-global/safe-contracts@1.4.1 build/artifacts>] [--port 40730]
//
// Written to --out (default docs/audit/package of this checkout):
//   PACKAGE.json       the commit, its contracts commit, toolchain, digests of every file below
//   SCOPE.md           scope by tier with sizes, out-of-scope list, code hashes
//   MANIFEST.tsv       tier, path, sha256, git blob, bytes, lines, code lines, SLOC, nSLOC
//   TEST-EVIDENCE.md   every command that was run at the commit, with its counts and log digest
//   KNOWN-ISSUES.md    the commit's docs/audit/KNOWN-ISSUES.md, copied
//
// The scope is scripts/audit/scope.json of the audited commit (of this checkout when the
// commit predates it). Tests need forge, cast, anvil and node 24 on PATH and
// frontend/node_modules of this checkout (its package-lock.json must equal the commit's).
// With --bridge-repo the V3 suites run on the bridge's real token bytecode; with
// --safe-artifacts too, the opening, ops and both package rehearsals run on loopback anvils.
// Exit status: 0 package written and every command that ran passed; 1 otherwise.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const name = process.argv[i];
  if (name === "--skip-tests") { args[name] = true; continue; }
  if (!["--commit", "--out", "--logs", "--bridge-repo", "--safe-artifacts", "--port"].includes(name) || process.argv[i + 1] === undefined) {
    console.error("usage: make-package.mjs --commit <rev> [--out DIR] [--logs DIR] [--skip-tests] [--bridge-repo DIR] [--safe-artifacts DIR] [--port N]");
    process.exit(1);
  }
  args[name] = process.argv[++i];
}
if (!args["--commit"]) { console.error("--commit <rev> is required: the package is always for one named commit"); process.exit(1); }

const git = (...a) => execFileSync("git", ["-C", ROOT, ...a], { encoding: "utf8", maxBuffer: 1 << 28 }).trim();
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const commit = git("rev-parse", "--verify", `${args["--commit"]}^{commit}`);
const out = resolve(args["--out"] ?? join(ROOT, "docs/audit/package"));
const logs = resolve(args["--logs"] ?? mkdtempSync(join(tmpdir(), "dex-audit-logs-")));
const port = Number(args["--port"] ?? 40730);
mkdirSync(out, { recursive: true });
mkdirSync(logs, { recursive: true });

// ---- export the commit
const work = mkdtempSync(join(tmpdir(), "dex-audit-"));
const tree = join(work, "tree");
mkdirSync(tree);
const archive = spawnSync("git", ["-C", ROOT, "archive", "--format=tar", commit], { maxBuffer: 1 << 30 });
if (archive.status !== 0) throw new Error(`git archive failed: ${archive.stderr}`);
const untar = spawnSync("tar", ["-x", "-C", tree], { input: archive.stdout, maxBuffer: 1 << 30 });
if (untar.status !== 0) throw new Error(`tar failed: ${untar.stderr}`);
const inTree = (path) => join(tree, path);

const scopePath = existsSync(inTree("scripts/audit/scope.json")) ? inTree("scripts/audit/scope.json") : join(ROOT, "scripts/audit/scope.json");
const scopeFrom = scopePath.startsWith(tree) ? "the audited commit" : "the generating checkout (the commit predates scripts/audit/scope.json)";
const scope = JSON.parse(readFileSync(scopePath, "utf8"));

// ---- sizes. Solidity: the method of docs/audit/nsloc.py (comments and blank lines removed;
// nSLOC counts a construct wrapped over several lines, while ( or [ is open, once).
function solidityCounts(source) {
  let code = "", inString = null;
  for (let i = 0; i < source.length;) {
    const c = source[i];
    if (inString) {
      code += c;
      if (c === "\\" && i + 1 < source.length) { code += source[i + 1]; i += 2; continue; }
      if (c === inString) inString = null;
      i++;
    } else if (c === '"' || c === "'") { inString = c; code += c; i++; }
    else if (source.startsWith("//", i)) { const j = source.indexOf("\n", i); i = j < 0 ? source.length : j; }
    else if (source.startsWith("/*", i)) {
      const j = source.indexOf("*/", i + 2);
      const segment = source.slice(i, j < 0 ? source.length : j + 2);
      code += "\n".repeat(segment.split("\n").length - 1);
      i = j < 0 ? source.length : j + 2;
    } else { code += c; i++; }
  }
  const lines = code.split("\n").map((l) => l.trim()).filter(Boolean);
  let nsloc = 0, depth = 0;
  for (const line of lines) {
    if (depth === 0) nsloc++;
    for (const ch of line) {
      if (ch === "(" || ch === "[") depth++;
      else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    }
  }
  return { sloc: lines.length, nsloc };
}
/// Other languages: non-blank lines that are not comment-only lines.
const codeLines = (source) => source.split("\n").map((l) => l.trim()).filter((l) => l && !/^(\/\/|#|\*|\/\*)/.test(l)).length;

// ---- manifest, and the scope's closure under relative imports
const tierOf = new Map();
for (const [tier, { files }] of Object.entries(scope.tiers)) for (const file of files) tierOf.set(file, tier);
const excluded = scope.outOfScope.map((e) => e.path.replace(/[*(].*$/, "").trim());
const isExcluded = (path) => excluded.some((prefix) => path === prefix || path.startsWith(prefix));
const rows = [], absent = [], openImports = [];
for (const [path, tier] of tierOf) {
  if (!existsSync(inTree(path))) { absent.push(path); continue; }
  const data = readFileSync(inTree(path));
  const text = data.toString("utf8");
  const sol = path.endsWith(".sol") ? solidityCounts(text) : null;
  rows.push({ tier, path, sha256: sha256(data), blob: git("rev-parse", `${commit}:${path}`), bytes: data.length, lines: text.split("\n").length - (text.endsWith("\n") ? 1 : 0), code: sol ? sol.sloc : codeLines(text), sloc: sol?.sloc ?? "", nsloc: sol?.nsloc ?? "" });
  if (!/\.(mjs|ts|tsx)$/.test(path)) continue;
  for (const match of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+|new URL\(\s*)["'](\.{1,2}\/[^"']+)["']/g)) {
    let target = join(dirname(path), match[1]);
    if (target.endsWith("/package.json") || target.includes("node_modules")) continue;
    const candidates = [target, `${target}.ts`, `${target}.tsx`, `${target}.mjs`, `${target}/index.ts`];
    target = candidates.find((c) => existsSync(inTree(c)) && !c.endsWith("/")) ?? target;
    if (!tierOf.has(target) && !isExcluded(target)) openImports.push(`${path} imports ${target}`);
  }
}
rows.sort((a, b) => a.tier.localeCompare(b.tier) || 0);

// ---- toolchain and code hashes
const tool = (cmd, a) => { try { return execFileSync(cmd, a, { encoding: "utf8" }).trim().split("\n")[0]; } catch { return "unavailable"; } };
const toolchain = { forge: tool("forge", ["--version"]), node: process.version, platform: `${process.platform} ${process.arch}` };
const run = (name, command, { cwd = tree, env = {}, parse } = {}) => {
  const started = Date.now();
  const result = spawnSync("bash", ["-c", command], { cwd, env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 1 << 30 });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  writeFileSync(join(logs, `${name}.log`), text);
  const entry = { name, command, env: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v).replaceAll(work, "<export>").replaceAll(logs, "<logs>")])), exit: result.status, seconds: Math.round((Date.now() - started) / 1000), logSha256: sha256(text), ...(parse ? parse(text) : {}) };
  entry.ok = result.status === 0 && entry.failed !== true && !(entry.fail > 0);
  console.error(`${entry.ok ? "ok  " : "FAIL"} ${name} (${entry.seconds}s) ${entry.summary ?? ""}`);
  return entry;
};
const evidence = [];
const build = run("forge-build", "forge build", {});
evidence.push(build);
const hashes = [];
if (build.ok) {
  for (const contract of scope.contracts) {
    const inspect = (field) => execFileSync("forge", ["inspect", contract, field], { cwd: tree, encoding: "utf8", maxBuffer: 1 << 28 }).trim();
    const keccak = (hexData) => execFileSync("cast", ["keccak", hexData], { encoding: "utf8", maxBuffer: 1 << 28 }).trim();
    const creation = inspect("bytecode"), runtime = inspect("deployedBytecode");
    hashes.push({ contract, creationKeccak: keccak(creation), creationBytes: (creation.length - 2) / 2, runtimeKeccak: keccak(runtime), runtimeBytes: (runtime.length - 2) / 2 });
  }
}
const initCodeHash = hashes.find((h) => h.contract === "UniswapV2Pair")?.creationKeccak ?? null;
const contractsCommit = git("log", "-1", "--format=%H", commit, "--", "contracts", "foundry.toml");

// ---- tests at the commit
const forgeCounts = (text) => {
  const m = [...text.matchAll(/Ran (\d+) test suites?[^\n]*?: (\d+) tests passed, (\d+) failed, (\d+) skipped/g)].at(-1);
  return m ? { suites: +m[1], pass: +m[2], fail: +m[3], skipped: +m[4], summary: `${m[1]} suites, ${m[2]} passed, ${m[3]} failed, ${m[4]} skipped` } : { failed: true, summary: "no forge summary line" };
};
const nodeCounts = (text) => {
  const n = (k) => Number(text.match(new RegExp(`^ℹ ${k} (\\d+)`, "m"))?.[1] ?? NaN);
  const c = { tests: n("tests"), pass: n("pass"), fail: n("fail"), skipped: n("skipped") };
  return Number.isNaN(c.tests) ? { failed: true, summary: "no node:test summary" } : { ...c, summary: `${c.tests} tests, ${c.pass} passed, ${c.fail} failed, ${c.skipped} skipped` };
};
const vitestCounts = (text) => {
  const line = text.replace(/\x1b\[[0-9;]*m/g, "").match(/^\s*Tests\s+(.*)$/m)?.[1];
  if (!line) return { failed: true, summary: "no vitest summary" };
  const n = (k) => Number(line.match(new RegExp(`(\\d+) ${k}`))?.[1] ?? 0);
  return { pass: n("passed"), fail: n("failed"), skipped: n("skipped"), summary: line.trim() };
};
const rehearsal = (text) => {
  const line = text.match(/^REHEARSAL OK[^\n]*/m)?.[0];
  return line ? { checks: Number(line.match(/(\d+) checks/)?.[1] ?? NaN), summary: line.replaceAll(work, "<export>") } : { failed: true, summary: "no REHEARSAL OK line" };
};
let skipped = [];
if (args["--skip-tests"]) skipped.push("every test command (--skip-tests)");
else if (build.ok) {
  const lockSame = existsSync(join(ROOT, "frontend/node_modules")) && sha256(readFileSync(join(ROOT, "frontend/package-lock.json"))) === sha256(readFileSync(inTree("frontend/package-lock.json")));
  if (!lockSame) throw new Error("frontend/node_modules of this checkout is missing or its package-lock.json differs from the commit's; run `npm --prefix frontend ci --ignore-scripts` in a checkout of that commit and generate from there");
  symlinkSync(join(ROOT, "frontend/node_modules"), inTree("frontend/node_modules"), "dir");
  const persist = () => mkdtempSync(join(work, "invariant-"));
  evidence.push(run("forge-test", "forge test --offline", { env: { FOUNDRY_INVARIANT_FAILURE_PERSIST_DIR: persist() }, parse: forgeCounts }));
  const bridge = args["--bridge-repo"] ? resolve(args["--bridge-repo"]) : null;
  const v3Artifact = bridge ? join(bridge, "out/BridgedStablecoinV3.sol/BridgedStablecoinV3.json") : null;
  let bridgeInfo = null;
  if (bridge && existsSync(v3Artifact)) {
    const initcode = JSON.parse(readFileSync(v3Artifact, "utf8")).bytecode.object;
    bridgeInfo = { revision: tool("git", ["-C", bridge, "rev-parse", "HEAD"]), dirty: tool("git", ["-C", bridge, "status", "--porcelain", "--untracked-files=no"]) !== "", v3CreationKeccak: execFileSync("cast", ["keccak", initcode], { encoding: "utf8", maxBuffer: 1 << 28 }).trim() };
    evidence.push(run("forge-test-v3-real-token", "forge test --offline --evm-version shanghai --match-path 'test/V3*.t.sol'", { env: { V3_INITCODE: initcode, FOUNDRY_INVARIANT_FAILURE_PERSIST_DIR: persist() }, parse: forgeCounts }));
    evidence.at(-1).env.V3_INITCODE = `<creation code of ${v3Artifact.replace(bridge, "<bridge-repo>")}, keccak ${bridgeInfo.v3CreationKeccak}>`;
  } else skipped.push("V3 suites on the real bridge token bytecode (no --bridge-repo with a built out/)");
  evidence.push(run("node-staging", "node --test scripts/staging/*.test.mjs", { parse: nodeCounts }));
  evidence.push(run("node-ops", "node --test scripts/ops/*.test.mjs", { parse: nodeCounts }));
  const fe = { cwd: inTree("frontend") };
  evidence.push(run("frontend-vitest", "npx vitest run", { ...fe, parse: vitestCounts }));
  evidence.push(run("frontend-tsc", "npx tsc --noEmit", fe));
  evidence.push(run("frontend-build", "npx vite build", fe));
  evidence.push(run("frontend-bundle-check", "node scripts/check-production-bundle.mjs dist", { ...fe, parse: (t) => ({ summary: t.trim().split("\n").at(-1) }) }));
  const safe = args["--safe-artifacts"] ? resolve(args["--safe-artifacts"]) : null;
  if (bridgeInfo && safe && existsSync(join(safe, "contracts"))) {
    const revision = JSON.parse(readFileSync(inTree("deployments/mainnet/dex-mainnet.config.json"), "utf8")).source.revision;
    const dir = (n) => join(work, `rehearsal-${n}`);
    evidence.push(run("rehearse-opening", `scripts/ops/rehearse-opening.sh ${port} ${dir("opening")}`, { env: { SAFE_ARTIFACTS: safe, BRIDGE_OUT: join(bridge, "out") }, parse: rehearsal }));
    evidence.push(run("rehearse-ops-anvil", `scripts/ops/rehearse-ops.sh anvil ${port + 10} ${dir("ops")}`, { env: { SAFE_ARTIFACTS: safe, BUSDC_ARTIFACT: v3Artifact }, parse: rehearsal }));
    evidence.push(run("rehearse-package-standin", `scripts/staging/rehearse-mainnet-package.sh anvil ${revision} ${port + 20} ${dir("package-standin")}`, { env: { SAFE_ARTIFACTS: safe }, parse: rehearsal }));
    evidence.push(run("rehearse-package-real-v3", `scripts/staging/rehearse-mainnet-package.sh anvil ${revision} ${port + 30} ${dir("package-real")}`, { env: { SAFE_ARTIFACTS: safe, BRIDGE_REPO: bridge, ETH_PORT: String(port + 35) }, parse: rehearsal }));
    for (const e of evidence.slice(-4)) for (const k of Object.keys(e.env)) e.env[k] = e.env[k].replace(bridge, "<bridge-repo>").replace(safe, "<safe-artifacts>");
  } else skipped.push("opening, ops and package rehearsals (need --bridge-repo and --safe-artifacts)");
  evidence.bridge = bridgeInfo;
}

// ---- write the package
const table = (header, lines) => [`| ${header.join(" | ")} |`, `|${header.map((_, i) => (i === 0 ? "---" : "---:")).join("|")}|`, ...lines.map((l) => `| ${l.join(" | ")} |`)].join("\n");
const tsv = ["tier\tpath\tsha256\tgit_blob\tbytes\tlines\tcode_lines\tsloc\tnsloc", ...rows.map((r) => [r.tier, r.path, r.sha256, r.blob, r.bytes, r.lines, r.code, r.sloc, r.nsloc].join("\t"))].join("\n") + "\n";
const sum = (list, key) => list.reduce((a, r) => a + (Number(r[key]) || 0), 0);
const scopeMd = [
  `# Postern DEX audit scope at \`${commit}\``,
  "",
  "Generated by `scripts/audit/make-package.mjs`; do not edit. Regenerate for any commit with:",
  "",
  "```",
  "node scripts/audit/make-package.mjs --commit <commit> --bridge-repo <built bridge checkout> --safe-artifacts <safe 1.4.1 build/artifacts>",
  "```",
  "",
  `Scope definition: \`scripts/audit/scope.json\` of ${scopeFrom}. Contracts last changed in \`${contractsCommit}\` (\`git diff ${contractsCommit.slice(0, 7)} ${commit.slice(0, 7)} -- contracts foundry.toml\` is empty).`,
  "",
  ...Object.entries(scope.tiers).flatMap(([tier, { title }]) => {
    const mine = rows.filter((r) => r.tier === tier);
    const solidity = mine.some((r) => r.nsloc !== "");
    return [`## Tier ${tier}: ${title}`, "",
      table(["File", "Lines", "Code lines", ...(solidity ? ["SLOC", "nSLOC"] : [])], [
        ...mine.map((r) => [`\`${r.path}\``, r.lines, r.code, ...(solidity ? [r.sloc, r.nsloc] : [])]),
        [`**Total (${mine.length} files)**`, sum(mine, "lines"), sum(mine, "code"), ...(solidity ? [sum(mine, "sloc"), sum(mine, "nsloc")] : [])],
      ]), ""];
  }),
  "Solidity SLOC and nSLOC follow `docs/audit/nsloc.py` (comments and blank lines removed; a construct wrapped over several lines counted once). Code lines of other files are non-blank lines that are not comment-only lines. SHA-256 and git blob of every file: `MANIFEST.tsv`.",
  "",
  ...(absent.length ? ["Listed in the scope but absent at this commit: " + absent.map((p) => `\`${p}\``).join(", ") + ".", ""] : []),
  "## Out of scope",
  "",
  ...scope.outOfScope.map((e) => `- \`${e.path}\`: ${e.why}.`),
  "- The bridged quote token (bUSDC, `BridgedStablecoinV3`) and its bridge: a separate engagement. The L2 node, settled RPC, prover and guest.",
  "",
  "## Code hashes at this commit",
  "",
  "Creation code includes constructor code but not constructor arguments. Runtime hashes of contracts with immutables are before the immutables are filled in.",
  "",
  hashes.length ? table(["Contract", "Creation keccak", "Bytes", "Runtime keccak", "Bytes"], hashes.map((h) => [`\`${h.contract}\``, `\`${h.creationKeccak}\``, h.creationBytes, `\`${h.runtimeKeccak}\``, h.runtimeBytes])) : "The build failed; no hashes.",
  "",
  `Pair init code hash (\`INIT_CODE_PAIR_HASH\`): \`${initCodeHash}\`.`,
  "",
].join("\n");
const describe = (e) => [`### ${e.name}: ${e.ok ? "passed" : "FAILED"}`, "", "```", `${Object.entries(e.env).map(([k, v]) => `${k}=${v} `).join("")}${e.command}`, "```", "", `Exit ${e.exit}, ${e.seconds} s${e.summary ? `, ${e.summary}` : ""}. Log sha256 \`${e.logSha256}\` (\`${e.name}.log\`).`, ""].join("\n");
const evidenceMd = [
  `# Test evidence at \`${commit}\``,
  "",
  `Generated by \`scripts/audit/make-package.mjs\` from a \`git archive\` export of the commit, on ${toolchain.platform}, ${toolchain.forge}, node ${toolchain.node}. Every command below ran in that export (frontend commands in \`frontend/\`); \`<export>\` is its temporary directory.`,
  "",
  ...(evidence.bridge ? [`Bridge repository used for the token bytecode and the rehearsals: revision \`${evidence.bridge.revision}\`${evidence.bridge.dirty ? " (tracked files modified)" : ""}, \`BridgedStablecoinV3\` creation keccak \`${evidence.bridge.v3CreationKeccak}\`.`, ""] : []),
  table(["Run", "Result", "Counts"], evidence.map((e) => [`\`${e.name}\``, e.ok ? "passed" : "**FAILED**", e.summary ?? ""])),
  "",
  ...(skipped.length ? ["Not run: " + skipped.join("; ") + ".", ""] : []),
  "Not part of these suites: `node --test scripts/*.test.mjs` (legacy publication tooling, out of scope, Linux only).",
  "",
  "## Commands",
  "",
  ...evidence.map(describe),
].join("\n");
const knownSource = existsSync(inTree("docs/audit/KNOWN-ISSUES.md")) ? inTree("docs/audit/KNOWN-ISSUES.md") : null;
const files = { "SCOPE.md": scopeMd, "MANIFEST.tsv": tsv, "TEST-EVIDENCE.md": evidenceMd };
if (knownSource) files["KNOWN-ISSUES.md"] = readFileSync(knownSource, "utf8");
for (const [name, body] of Object.entries(files)) writeFileSync(join(out, name), body);
const allOk = evidence.every((e) => e.ok) && openImports.length === 0;
const packageJson = {
  schema: "postern.dex.audit-package.v1",
  commit,
  contractsCommit,
  tree: git("rev-parse", `${commit}^{tree}`),
  generatedAt: new Date().toISOString(),
  generator: { path: "scripts/audit/make-package.mjs", sha256: sha256(readFileSync(fileURLToPath(import.meta.url))), scopeFrom },
  toolchain,
  initCodeHash,
  codeHashes: hashes,
  bridge: evidence.bridge ?? null,
  scopeOpenImports: openImports,
  absentFiles: absent,
  knownIssues: knownSource ? "KNOWN-ISSUES.md" : "absent at this commit",
  tests: evidence.map(({ name, command, exit, ok, summary, logSha256, suites, tests, pass, fail, skipped: s, checks }) => ({ name, command, exit, ok, summary, suites, tests, pass, fail, skipped: s, checks, logSha256 })),
  notRun: skipped,
  files: Object.fromEntries(Object.entries(files).map(([name, body]) => [name, sha256(body)])),
  result: allOk ? (skipped.length ? "passed, with commands not run" : "passed") : "FAILED",
};
writeFileSync(join(out, "PACKAGE.json"), `${JSON.stringify(packageJson, null, 2)}\n`);
if (existsSync(join(tree, "frontend/dist"))) cpSync(join(tree, "frontend/dist"), join(logs, "frontend-dist"), { recursive: true });
rmSync(work, { recursive: true, force: true });
for (const line of openImports) console.error(`scope is not closed: ${line}`);
console.log(JSON.stringify({ commit, out, logs, result: packageJson.result, initCodeHash, tests: packageJson.tests.map((t) => `${t.name}: ${t.ok ? "ok" : "FAILED"} ${t.summary ?? ""}`), notRun: skipped }, null, 2));
process.exit(allOk ? 0 : 1);
