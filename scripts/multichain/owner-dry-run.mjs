#!/usr/bin/env node
// Dry run of docs/OWNER-DEPLOY-NOW.md: the owner's own command blocks, executed on a loopback anvil fork of one
// chain, with a throwaway deploying key and the depositing account impersonated (no key of the owner's is used or
// needed). Nothing is sent to a public chain: every transaction goes to the fork; public endpoints are only READ
// (the public pre gate, the market, gas prices and rollup data-fee oracles for the cost).
//
//   node scripts/multichain/owner-dry-run.mjs once  --out DIR [--pt FILE] [--archives DIR]
//   node scripts/multichain/owner-dry-run.mjs <chain> --port PORT --out DIR [--fork-url URL] [--pid-dir DIR]
//                                                     [--clone DIR --tools DIR | --archives DIR]
//
// Where the blocks run (review R402-3): in a FRESH clone made by the document's own clone block (DIR/postern-dex),
// moved to the commit under test (fetched from this worktree, which must have no uncommitted change), with the
// document's `npm ci` and `forge build` blocks run in it: nothing an agent's worktree happens to hold (out/,
// node_modules) is used. A chain run makes its own clone, or takes an earlier run's (--clone DIR, which must be at
// the commit under test and unchanged).
// The tools (reviews R369-16, R402-1, -2): the run installs the owner's toolchain with the document's own install
// block into DIR/owner-tools (from the pinned official URLs; with --archives DIR from archives already fetched from
// them, each still compared with the pins), or checks an earlier run's directory (--tools DIR), always with the
// document's own PATH line and check block, and then runs every command with those tools, in an environment that
// holds only what a new terminal has (HOME, USER, LOGNAME, SHELL, TERM, TMPDIR, LANG) and the two keystore variables.
//
// The blocks are those of the document marked `<!-- run: <chain>|once <step> -->`; the run refuses to start when an
// expected block is missing. Each block is run as written, with only the changes listed in the document's section
// 10 (loopback flags, the dry run's own output paths, the throwaway keystore and its password file, the impersonated
// depositor's `--unlocked`, the values earlier steps printed). Every command actually run is written to
// DIR/commands.log next to the block it came from. Funding and waiting, which the owner does with a wallet and a
// clock, are anvil_setBalance / a token balance slot and 70 mined blocks (anvil's `finalized` is 64 behind).
//
// Midway-failure drills (section 6 of the document), each on an anvil snapshot that is reverted afterwards except
// the first: (M1) the deployment command run a second time sends nothing; (M2) the approve sent and the deposit not:
// `prepare` again prints a fresh pair of lines, which go through; (M3b) a deposit that runs out of gas reverts,
// nothing is deposited, and `prepare` again prints a pair that goes through; (M3) the deposit sent after its deadline reverts,
// nothing is deposited, and `prepare` again works; (M4) the post gate run before finality says WAIT.
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createRpcTransport } from "../staging/rpc-transport.mjs";
import { ROOT, loadArtifacts, loadChain, loadShared, lower, planChain, refuse } from "./lib.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { keccak256, encodeAbiParameters, encodeFunctionData, decodeFunctionResult, parseAbi, parseUnits, formatUnits, serializeTransaction, concat } = requireFromFrontend("viem");

export const DOC = "docs/OWNER-DEPLOY-NOW.md";
export const CHAIN_STEPS = ["pre-gate", "deployer-balance", "gas-price", "deploy-dry-run", "deploy-broadcast", "post-gate-deployed", "market", "depositor-native", "depositor-token", "prepare", "send-suffix", "verify", "post-gate-open", "frontend-record", "record-add", "record-commit"];
export const ONCE_STEPS = ["clone", "clone-commit", "no-agents", "tools-install", "env-path", "tools-check", "tools-type", "reviewed-commit", "npm-ci", "forge-build", "kit-tests", "check-depositor", "fee-proof-message", "fee-proof-page", "fee-proof-record", "fee-proof-verify", "deployer-dir", "deployer-new", "deployer-address", "plan"];
export const ORDER = ["op-mainnet", "base", "arbitrum-one", "linea", "bnb-smart-chain", "ethereum"];
const DEPOSITOR_KEYSTORE = '--keystore "$DEX_DEPOSITOR_KEYSTORE_DIR/depositante"';
// The document names the deploying key's directory only as DEX_DEPLOYER_KEYSTORE_DIR (H398-3); the dry run sets it
// to its own throwaway directory in every command's environment and keeps the command text as written.
const DEPLOYER_DIR = '"$DEX_DEPLOYER_KEYSTORE_DIR"';
// The owner's tools directory and the path of the toolchain script, as the document writes them.
export const OWNER_TOOLS = ["~/dex-owner-tools", "$HOME/dex-owner-tools"];
export const OWNER_CLONE = "~/postern-dex";
// Review R402-4: the reviewed commit id is not in the document; the owner pastes it over this placeholder, in both
// comparisons. The dry run pastes the id of the commit it is at, and shows that the lines refuse when left as printed.
export const COMMIT_PLACEHOLDER = "PASTE-THE-40-DIGIT-COMMIT-ID";
export const TOOLCHAIN_SCRIPT = `${OWNER_CLONE}/scripts/multichain/owner-toolchain.sh`;
// The pair's init code hash of the audited build (test/Core.t.sol pins it): unchanged by the pinned compiler.
export const PAIR_INIT_CODE_HASH = "0x16bd5cad7515499aa8c3f9b0f0e894a3ddeb41f5416ffe0357d7880444556683";
// What a new terminal's environment holds; the commands of a dry run get these and nothing else of the session.
export const TERMINAL_ENV = ["HOME", "USER", "LOGNAME", "SHELL", "TERM", "TMPDIR", "LANG"];
export const TOOL_NAMES = ["forge", "cast", "anvil", "node", "npm"];

// Section 8B of the document (a second pool on a chain, round 20): its blocks are marked `second-pool:`.
export const SECOND_ONCE_STEPS = ["cd", "fetch", "origin-main", "rebase", "own-commits", "forge-build", "kit-tests"];
export const SECOND_CHAIN_STEPS = ["verify-chain", "post-gate-two-pairs", "market", "depositor-native", "depositor-token", "prepare", "verify", "post-gate-open", "frontend-record", "record-add", "record-commit"];
/** The marked blocks of section 8B: { "<chain>|once <step>": command }, each one line without a comment or an angle bracket. */
export function secondBlocksOf(text) {
  const blocks = {};
  for (const m of text.matchAll(/<!-- second-pool: (\S+) (\S+) -->\n```\n([\s\S]*?)\n```/g)) {
    refuse(!blocks[`${m[1]} ${m[2]}`], `${DOC}: the block second-pool ${m[1]} ${m[2]} appears twice`);
    refuse(!m[3].includes("\n") && !/(^|\s)#/.test(m[3]) && !/[<>]/.test(m[3]), `${DOC}: the block second-pool ${m[1]} ${m[2]} must be one line without a comment or an angle bracket`);
    blocks[`${m[1]} ${m[2]}`] = m[3];
  }
  return blocks;
}

/** The pinned SHA-256 of each program of a platform (scripts/multichain/owner-toolchain.pins): { "foundry/forge": hex, … }. */
export function pinnedFiles(platform, text = readFileSync(join(ROOT, "scripts/multichain/owner-toolchain.pins"), "utf8")) {
  const pins = {};
  for (const l of text.split("\n")) {
    const f = l.split(" ");
    if (f[0] === platform && f[1] === "file") pins[f[3]] = f[2];
  }
  return pins;
}

/** The marked command blocks of the document: { "<scope> <step>": command }. */
export function blocksOf(text) {
  const blocks = {};
  for (const m of text.matchAll(/<!-- run: (\S+) (\S+) -->\n```\n([\s\S]*?)\n```/g)) {
    refuse(!blocks[`${m[1]} ${m[2]}`], `${DOC}: the block ${m[1]} ${m[2]} appears twice`);
    refuse(!m[3].includes("\n") && !/(^|\s)#/.test(m[3]), `${DOC}: the block ${m[1]} ${m[2]} must be one line without a comment`);
    blocks[`${m[1]} ${m[2]}`] = m[3];
  }
  // Text the owner appends to a printed line (not a command by itself): inline, marked `<!-- suffix: … -->`.
  for (const m of text.matchAll(/<!-- suffix: (\S+) (\S+) -->\n`([^`\n]+)`/g)) {
    refuse(!blocks[`${m[1]} ${m[2]}`], `${DOC}: the block ${m[1]} ${m[2]} appears twice`);
    blocks[`${m[1]} ${m[2]}`] = m[3];
  }
  return blocks;
}

/** The funding amounts the document states for a chain (steps 2 and 6 of that chain). */
export function fundingOf(text, key, symbol) {
  const deployer = text.match(new RegExp(`\\*\\*${key}-2\\. Fund the deploying account\\*\\* with \\*\\*([0-9.]+) ${symbol}\\*\\*`))?.[1];
  const allowance = text.match(new RegExp(`\\*\\*${key}-6\\. Fund the depositing account\\*\\*[^\\n]*?\\*\\*plus ([0-9.]+) ${symbol}\\*\\* for its two transactions`))?.[1];
  refuse(deployer && allowance, `${DOC}: the funding amounts of ${key} are not stated in the expected form`);
  return { deployer, allowance };
}

const opt = { pidDir: null };
const argv = process.argv.slice(2);
const scope = argv[0];
for (let i = 1; i < argv.length; i += 2) opt[argv[i].replace(/^--/, "").replace(/-(.)/g, (_, c) => c.toUpperCase())] = argv[i + 1];
if (import.meta.url === `file://${process.argv[1]}`) {
  refuse(scope && opt.out && (scope === "once" || (ORDER.includes(scope) && opt.port)), "usage: owner-dry-run.mjs once --out DIR [--pt FILE] [--archives DIR] | <chain> --port PORT --out DIR [--fork-url URL] [--pid-dir DIR] [--clone DIR --tools DIR | --archives DIR]");
  refuse(!((opt.tools || opt.clone) && scope === "once"), "once makes its own clone and installs the tools itself (--clone and --tools are for a chain run)");
  refuse(Boolean(opt.tools) === Boolean(opt.clone), "--clone and --tools come together (an earlier run's clone and tools directory)");
  await main();
}

async function main() {
  const text = readFileSync(join(ROOT, DOC), "utf8");
  const blocks = blocksOf(text);
  const expected = scope === "once" ? ONCE_STEPS : CHAIN_STEPS;
  const missing = expected.filter((s) => !blocks[`${scope} ${s}`]);
  refuse(missing.length === 0, `${DOC}: missing blocks for ${scope}: ${missing.join(", ")}`);
  const out = resolve(opt.out);
  mkdirSync(out, { recursive: true });
  const log = join(out, "commands.log");
  writeFileSync(log, `# ${DOC} dry run, ${scope}, ${new Date().toISOString()}, commit ${spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim()}\n`);
  const evidence = { schema: "postern.dex.owner-dry-run.v1", scope, doc: DOC, at: new Date().toISOString(), checks: [], steps: [] };
  const check = (name, ok, detail) => {
    evidence.checks.push({ name, ok: Boolean(ok), ...(ok || detail === undefined ? {} : { detail: String(detail).slice(0, 800) }) });
    console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok || detail === undefined ? "" : ` (${String(detail).slice(0, 300)})`}`);
    return Boolean(ok);
  };
  const save = () => writeFileSync(join(out, "evidence.json"), `${JSON.stringify(evidence, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`);
  // The commit under test, and the clone the blocks run in.
  const git = (args, cwd = ROOT) => spawnSync("/usr/bin/git", args, { cwd, encoding: "utf8" });
  const head = git(["rev-parse", "HEAD"]).stdout.trim();
  refuse(git(["status", "--porcelain", "--untracked-files=no"]).stdout.trim() === "", "the worktree has uncommitted changes: the dry run runs the blocks in a fresh clone at the committed HEAD; commit first");
  const REPO = opt.clone ? resolve(opt.clone) : join(out, "postern-dex");
  const terminal = Object.fromEntries(TERMINAL_ENV.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
  /** Run one shell command line and log it next to the document's block it came from. */
  const shell = (step, original, command, { timeoutMs = 900_000, cwd = REPO, env = {} } = {}) => {
    appendFileSync(log, `\n## ${step}\n# document: ${original}\n$ ${command}\n`);
    const started = Date.now();
    const r = spawnSync("/bin/bash", ["-c", command], { cwd, encoding: "utf8", timeout: timeoutMs, env: { ...terminal, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", ...env } });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    appendFileSync(log, `${output}\n# exit ${r.status} after ${Math.round((Date.now() - started) / 1000)} s\n`);
    writeFileSync(join(out, `${step}.log`), output);
    evidence.steps.push({ step, status: r.status, seconds: Math.round((Date.now() - started) / 1000) });
    save();
    return { status: r.status, output };
  };
  const toolsDir = opt.tools ? resolve(opt.tools) : join(out, "owner-tools");
  // The document's paths: the owner's clone and tools directory become this run's own (the owner's are never written).
  const swap = (cmd) => OWNER_TOOLS.reduce((c, d) => c.replaceAll(d, toolsDir), cmd).replaceAll(OWNER_CLONE, REPO);

  // ---------------------------------------------------------------- the fresh clone (review R402-3)
  evidence.clone = { directory: REPO, commit: head, madeBy: opt.clone ? "an earlier run (--clone)" : "this run" };
  if (!opt.clone) {
    rmSync(REPO, { recursive: true, force: true });
    // The repository, cloned as the document says (read-only from the public GitHub), into the dry run's directory.
    const r = shell("clone", blocks["once clone"], swap(blocks["once clone"]), { cwd: out });
    const reviewed = git(["merge-base", "--is-ancestor", "a99f761", "origin/main"], REPO);
    check("0 the clone succeeds and its main contains the reviewed a99f761", r.status === 0 && reviewed.status === 0, `${r.output.slice(-200)} ${reviewed.stderr}`);
    // R402-4, first comparison (macOS's own programs, nothing from the clone): the id the owner received, pasted
    // over the placeholder. Here: the id of the clone's own main (what the integrator announces for a real run).
    refuse(r.status === 0, `the document's clone block failed (network?): ${r.output.trim().split("\n").at(-1)}; nothing else was run`);
    const cloneHead = (git(["rev-parse", "origin/main"], REPO).stdout ?? "").trim();
    const pasted = (id) => swap(blocks["once clone-commit"]).replaceAll(COMMIT_PLACEHOLDER, id);
    const commit = shell("clone-commit", blocks["once clone-commit"], pasted(cloneHead), { cwd: out });
    check("0 the clone's commit compared in full (40 digits) with the id pasted over the placeholder: MATCH (R402-4)", /^[0-9a-f]{40}$/.test(cloneHead) && commit.status === 0 && commit.output === "reviewed commit: MATCH\n", commit.output);
    const unpasted = shell("clone-commit-as-printed", blocks["once clone-commit"], swap(blocks["once clone-commit"]), { cwd: out });
    const oneOff = shell("clone-commit-one-digit", blocks["once clone-commit"], pasted(`${cloneHead.slice(0, 39)}${cloneHead[39] === "0" ? "1" : "0"}`), { cwd: out });
    const short = shell("clone-commit-seven-digits", blocks["once clone-commit"], pasted(cloneHead.slice(0, 7)), { cwd: out });
    check("0 the same line left as printed, with one digit changed, or with seven digits: MISMATCH and no MATCH (R402-4)", [unpasted, oneOff, short].every((r) => r.output.startsWith("reviewed commit: MISMATCH; stop") && !/reviewed commit: MATCH/.test(r.output)), `${unpasted.output}${oneOff.output}${short.output}`);
    // The clone is of the public main; the blocks under test are this commit's: fetched from the worktree.
    const moved = git(["fetch", "-q", ROOT, head], REPO).status === 0 && git(["checkout", "-q", "--detach", head], REPO).status === 0;
    refuse(moved, `the clone could not be moved to the commit under test ${head}`);
  }
  check(`0 the blocks run in a ${opt.clone ? "clone of an earlier run, still" : "fresh clone moved"} at the commit under test ${head.slice(0, 7)}, with no change (R402-3)`, git(["rev-parse", "HEAD"], REPO).stdout.trim() === head && git(["status", "--porcelain", "--untracked-files=no"], REPO).stdout.trim() === "" && readFileSync(join(REPO, DOC), "utf8") === text);

  // ---------------------------------------------------------------- the owner's tools (reviews R369-16, R402-1, -2, -6)
  // The document's install block, PATH line and check block, as written.
  const passLine = /^owner tools: PASS$/;
  const lastLine = (output) => output.trim().split("\n").at(-1) ?? "";
  const docPath = swap(blocks["once env-path"]);
  const toolsCheck = (step, prefix = `${docPath}; `, env = {}) => shell(step, blocks["once tools-check"], `${prefix}${swap(blocks["once tools-check"])}`, { env });
  evidence.tools = { directory: toolsDir, installedBy: opt.tools ? "an earlier run (--tools)" : opt.archives ? "this run, from --archives" : "this run, from the pinned URLs" };
  if (!opt.tools) {
    rmSync(toolsDir, { recursive: true, force: true });
    const r = shell("tools-install", blocks["once tools-install"], `${swap(blocks["once tools-install"])}${opt.archives ? ` --from ${resolve(opt.archives)}` : ""}`);
    check(`tools: the document's install block builds the tools directory from the pinned archives (${evidence.tools.installedBy.replace("this run, ", "")}), every archive's SHA-256 checked first, and starts every program`, r.status === 0 && (r.output.match(/^ok {4}\S+ sha256 [0-9a-f]{64}$/gm) ?? []).length >= 3 && /^owner tools: installed and verified in /.test(lastLine(r.output)), r.output.slice(-500));
  }
  {
    const r = toolsCheck("tools-check");
    check("tools: the document's PATH line then its check block: the last line is exactly \"owner tools: PASS\"", r.status === 0 && passLine.test(lastLine(r.output)) && !/^FAIL/m.test(r.output), r.output.slice(-600));
  }
  if (scope === "once") {
    // Refusals on the real directory, each undone.
    const none = (r) => !/owner tools: (PASS|HASHES PASS)/.test(r.output);
    const cast = join(toolsDir, "foundry/cast");
    const size = statSync(cast).size;
    appendFileSync(cast, "\n");
    let r = toolsCheck("T1-cast-changed");
    truncateSync(cast, size);
    check("T1 one byte added to cast: the check refuses, names cast and prints no PASS", r.status === 1 && /^FAIL foundry\/cast has SHA-256 [0-9a-f]{64}; pinned [0-9a-f]{64}$/m.test(r.output) && none(r), r.output.slice(-400));
    chmodSync(toolsDir, 0o750);
    r = toolsCheck("T2-group-access");
    chmodSync(toolsDir, 0o700);
    check("T2 the directory opened to the group: the check refuses", r.status === 1 && /has access mode 750; it must be 700/.test(r.output) && none(r), r.output.slice(-400));
    r = toolsCheck("T3-no-path-line", "export PATH=/usr/bin:/bin; ");
    check("T3 without the document's PATH line: the check refuses", r.status === 1 && /FAIL this terminal's PATH finds forge at 'nowhere'/.test(r.output) && none(r), r.output.slice(-400));
    // R402-1: the PATH line of the guide before this fix (the terminal's own PATH kept behind the tools), with a
    // directory an agent can write in it.
    mkdirSync(join(out, "agent-bin"), { recursive: true });
    r = toolsCheck("T4-old-path-line", `export PATH="${toolsDir}/bin:${join(out, "agent-bin")}:/usr/bin:/bin:/usr/sbin:/sbin"; `);
    check("T4 (R402-1) another directory kept in the PATH behind the tools: the check refuses and names it", r.status === 1 && r.output.includes(`PATH has the entry '${join(out, "agent-bin")}'`) && none(r), r.output.slice(-400));
    // R402-2: the compiler changed by one byte.
    const solc = join(toolsDir, "solc/solc-0.8.24");
    const solcSize = statSync(solc).size;
    appendFileSync(solc, "\n");
    r = toolsCheck("T5-solc-changed");
    truncateSync(solc, solcSize);
    check("T5 (R402-2) one byte added to the compiler: the check refuses and names it", r.status === 1 && /^FAIL solc\/solc-0\.8\.24 has SHA-256/m.test(r.output) && none(r), r.output.slice(-400));
    // R402-6: a variable that switches TLS verification off, and one that points cast elsewhere.
    r = toolsCheck("T6-refused-variables", undefined, { NODE_TLS_REJECT_UNAUTHORIZED: "0", ETH_RPC_URL: "https://example.invalid" });
    check("T6 (R402-6) NODE_TLS_REJECT_UNAUTHORIZED and ETH_RPC_URL set in the terminal: the check refuses and names both", r.status === 1 && /must not be \(open a new terminal, or unset them\): (NODE_TLS_REJECT_UNAUTHORIZED ETH_RPC_URL|ETH_RPC_URL NODE_TLS_REJECT_UNAUTHORIZED) $/m.test(r.output) && none(r), r.output.slice(-400));
    // R402-7: an access-control list on cast (mode still 700).
    spawnSync("/bin/chmod", ["+a", "everyone allow write,append,delete", cast]);
    r = toolsCheck("T7-acl");
    spawnSync("/bin/chmod", ["-N", cast]);
    check("T7 (R402-7) an access-control list on cast: the check refuses", r.status === 1 && /FAIL carries an access-control list/.test(r.output) && none(r), r.output.slice(-400));
    r = toolsCheck("tools-check-again");
    check("tools: with the seven changes undone the check passes again", r.status === 0 && passLine.test(lastLine(r.output)), r.output.slice(-400));
  }
  const binDir = join(toolsDir, "bin");
  const envPrefix = `${docPath}; `;
  {
    const r = shell("tools-type", blocks["once tools-type"], `${envPrefix}${blocks["once tools-type"]}`);
    check("tools: `type` finds forge, cast, anvil, node and npm in the tools directory's bin and nowhere else", r.status === 0 && TOOL_NAMES.every((t) => r.output.split("\n").includes(`${t} is ${binDir}/${t}`)), r.output);
  }
  if (!opt.clone) {
    // Section 2.1 in the fresh clone: the packages and the build (R402-3), with the checked npm and forge.
    // R402-4, second comparison: the script of the clone, in the tools-checked terminal, before anything is built.
    {
      const block = blocks["once reviewed-commit"];
      const at = (id) => block.replaceAll(COMMIT_PLACEHOLDER, id);
      const last = (x) => x.output.trim().split("\n").at(-1) ?? "";
      let c = shell("reviewed-commit", block, `${envPrefix}${at(head)}`);
      check("2.1 the reviewed-commit line with the id pasted: last line \"reviewed commit: PASS <40 digits>\" (R402-4)", c.status === 0 && last(c) === `reviewed commit: PASS ${head}`, c.output.slice(-300));
      const refused = (x) => x.status === 1 && last(x).startsWith("reviewed commit: FAIL") && !/reviewed commit: PASS/.test(x.output);
      c = shell("reviewed-commit-as-printed", block, `${envPrefix}${block}`);
      check("2.1 the same line left as printed (placeholder not replaced): refused, no PASS", refused(c) && c.output.includes(COMMIT_PLACEHOLDER), c.output.slice(-300));
      c = shell("reviewed-commit-other", block, `${envPrefix}${at(git(["rev-parse", "HEAD~1"], REPO).stdout.trim())}`);
      check("2.1 the id of another commit (this one's parent): refused, both ids shown", refused(c) && c.output.includes(`this copy is at ${head}`), c.output.slice(-300));
      c = shell("reviewed-commit-seven", block, `${envPrefix}${at(head.slice(0, 7))}`);
      check("2.1 the seven-digit short form: refused", refused(c) && /has 7 digits/.test(c.output), c.output.slice(-300));
      const guide = join(REPO, DOC);
      appendFileSync(guide, "\n");
      c = shell("reviewed-commit-file-changed", block, `${envPrefix}${at(head)}`);
      writeFileSync(guide, text);
      check("2.1 one byte added to a tracked file of the clone: refused, the file named", refused(c) && c.output.includes(DOC), c.output.slice(-300));
      check("2.1 the clone is unchanged after these refusals", git(["status", "--porcelain", "--untracked-files=no"], REPO).stdout.trim() === "");
    }
    let r = shell("npm-ci", blocks["once npm-ci"], `${envPrefix}${blocks["once npm-ci"]}`);
    check("2.1 npm ci in the fresh clone installs the frontend's packages from the lockfile (no install script)", r.status === 0 && existsSync(join(REPO, "frontend/node_modules/viem/package.json")), r.output.slice(-400));
    r = shell("forge-build", blocks["once forge-build"], `${envPrefix}${blocks["once forge-build"]}`);
    check("2.1 forge build in the fresh clone compiles with Solc 0.8.24 (the pinned compiler; forge is offline)", r.status === 0 && /Compiler run successful/.test(r.output) && /Solc 0\.8\.24/.test(r.output), r.output.slice(0, 600));
  }
  {
    const pair = JSON.parse(readFileSync(join(REPO, "out/UniswapV2Pair.sol/UniswapV2Pair.json"), "utf8")).bytecode.object;
    evidence.pairInitCodeHash = keccak256(pair);
    check(`2.1 (R402-2) the pair's init code hash built by the pinned compiler is the audited ${PAIR_INIT_CODE_HASH.slice(0, 10)}…${PAIR_INIT_CODE_HASH.slice(-4)}`, evidence.pairInitCodeHash === PAIR_INIT_CODE_HASH, evidence.pairInitCodeHash);
  }
  const keyDir = join(out, "deployer-key");
  // A fresh throwaway key per run (a keystore left by an earlier run has another password).
  rmSync(keyDir, { recursive: true, force: true });
  const pwFile = join(out, "deployer-key.password");
  /** Run one shell command line (as the owner pastes it, after the documented changes) and log it. Every command
   * runs after the document's "every new terminal" PATH line (the checked tools first in PATH), exactly as the
   * owner's terminal has it. */
  const sh = (step, original, command, options = {}) => shell(step, original, `${envPrefix}${command}`, { ...options, env: { DEX_DEPLOYER_KEYSTORE_DIR: keyDir, DEX_DEPOSITOR_KEYSTORE_DIR: join(out, "no-depositor-key") } });

  if (scope === "once") {
    const t = (cmd) =>
      cmd
        .replaceAll("/tmp/fee-proof-page", join(out, "fee-proof-page"))
        .replaceAll(DEPLOYER_DIR, keyDir)
        .replace(/^(cast wallet new .*)$/, `$1 --unsafe-password "$(cat ${pwFile})"`)
        .replace(/^(cast wallet address --keystore .*)$/, `$1 --password-file ${pwFile}`);
    writeFileSync(pwFile, `dry-run-${Math.random().toString(36).slice(2)}\n`, { mode: 0o600 });
    const run = (step) => sh(step, blocks[`once ${step}`], t(blocks[`once ${step}`]));
    let r;
    // The line that lists running agents. This dry run is itself started by an agent session, so the line must find
    // one (status 0, something listed); run by a person with no agent on the machine it prints nothing (status 1).
    const agents = shell("no-agents", blocks["once no-agents"], blocks["once no-agents"]);
    evidence.agentsListed = agents.output.trim().split("\n").filter(Boolean).length;
    check("0 the no-agent line runs: it lists the agent session this dry run is started from, or nothing at all", (agents.status === 0 && evidence.agentsListed > 0) || (agents.status === 1 && evidence.agentsListed === 0), `${agents.status}: ${agents.output.slice(0, 200)}`);
    // Through a script (as deploy.sh runs forge): the launcher must survive macOS removing DYLD_* variables.
    writeFileSync(join(out, "tools-check.sh"), "#!/usr/bin/env bash\ncommand -v node; command -v forge; command -v cast; node --version; forge --version; cast --version; npm --version\n", { mode: 0o755 });
    r = sh("env-tools", `${blocks["once env-path"]} + a script`, join(out, "tools-check.sh"));
    check("0 the launchers and the PATH line give Node v24.21.0, npm 11.19.0 and Foundry 1.7.1, also inside a script", r.status === 0 && ["node", "forge", "cast"].every((t) => r.output.split("\n").includes(`${binDir}/${t}`)) && /^v24\.21\.0$/m.test(r.output) && /^11\.19\.0$/m.test(r.output) && /^forge Version: 1\.7\.1$/m.test(r.output) && /^cast Version: 1\.7\.1$/m.test(r.output), r.output);
    r = run("kit-tests");
    check("2.1 kit tests: fail 0", r.status === 0 && /ℹ fail 0/.test(r.output), r.output.slice(-400));
    r = run("check-depositor");
    check("2.2 check-depositor says FIT for 0x1ec3…C8f3 on the six chains (read-only, public endpoints)", r.status === 0 && /FIT/.test(r.output), r.output.slice(-600));
    r = run("fee-proof-message");
    check("2.3 the fee-proof message is the one printed in the document", r.status === 0 && text.includes(`> ${r.output.trim()}`), r.output);
    r = run("fee-proof-page");
    check("2.3 the local signing page is written", r.status === 0 && existsSync(join(out, "fee-proof-page", "index.html")), r.output);
    const proofFile = join(REPO, "deployments/fee-address-proof.json");
    const proofBefore = existsSync(proofFile) ? readFileSync(proofFile, "utf8") : null;
    r = run("fee-proof-verify");
    evidence.feeProofRecorded = proofBefore !== null;
    if (proofBefore === null) check("2.3 fee-proof verify with no proof recorded yet: NOT VALID, exit 1 (the owner has not signed; expected today)", r.status === 1 && /fee address proof: NOT VALID/.test(r.output), r.output);
    else check("2.3 fee-proof verify: VALID", r.status === 0 && /fee address proof: VALID/.test(r.output), r.output);
    r = run("deployer-dir");
    check("2.4 the deploying key's directory is created", r.status === 0 && existsSync(keyDir), r.output);
    r = run("deployer-new");
    const created = r.output.match(/Address:\s+(0x[0-9a-fA-F]{40})/)?.[1];
    check("2.4 cast wallet new writes an encrypted keystore and prints its address (no private key shown)", r.status === 0 && created && existsSync(join(keyDir, "deployer")) && !/private key/i.test(r.output), r.output);
    r = run("deployer-address");
    check("2.4 the address is read back from the keystore", r.status === 0 && created && r.output.trim() === created, r.output);
    const shared = loadShared();
    check("2.4 the deploying address is neither the depositing account nor the fee address", created && lower(created) !== lower(shared.firstDepositor) && lower(created) !== lower(shared.feeTo.address), created);
    // 2.3 record, with a signature of the exact message by the THROWAWAY key (not the fee address): it must refuse
    // and write nothing. (The accepting path needs the fee address's own key: the owner's.)
    {
      const message = sh("fee-proof-message-for-sign", "node scripts/multichain/fee-proof.mjs message", "node scripts/multichain/fee-proof.mjs message").output.trim();
      writeFileSync(join(out, "message.txt"), message);
      const sig = sh("throwaway-sign", "(dry run only) cast wallet sign by the throwaway key", `cast wallet sign --keystore ${join(keyDir, "deployer")} --password-file ${pwFile} "$(cat ${join(out, "message.txt")})"`).output.trim();
      check("2.3 (dry run) a throwaway key signs the message: 65 bytes", /^0x[0-9a-f]{130}$/.test(sig), sig);
      r = sh("fee-proof-record", blocks["once fee-proof-record"], blocks["once fee-proof-record"].replace("0xSIGNATURE", sig));
      const proofAfter = existsSync(proofFile) ? readFileSync(proofFile, "utf8") : null;
      check("2.3 record refuses a signature by any key but the fee address's, and writes nothing", r.status !== 0 && proofAfter === proofBefore, r.output);
    }
    if (opt.pt) {
      // The owner's Portuguese copy (kept outside this English-only repository) must carry the same blocks.
      const pt = blocksOf(readFileSync(resolve(opt.pt), "utf8"));
      // The owner's copy carries the reviewed commit id, pasted over the placeholder in the two commit-comparison
      // blocks (review R402-4: he receives the 40 digits outside the repository, and his own copy is where they are
      // written). That, and nothing else, may differ: the id must be 40 hexadecimal digits, the same in both.
      const ids = new Set();
      const same = (k) => {
        if (pt[k] === blocks[k]) return true;
        if (!["once clone-commit", "once reviewed-commit"].includes(k) || typeof pt[k] !== "string") return false;
        const id = pt[k].match(/(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/)?.[0];
        if (!id || pt[k].replaceAll(id, COMMIT_PLACEHOLDER) !== blocks[k]) return false;
        ids.add(id);
        return true;
      };
      const diff = [...new Set([...Object.keys(pt), ...Object.keys(blocks)])].filter((k) => !same(k));
      evidence.ptCopy = { blocks: Object.keys(pt).length, differing: diff, pastedCommitId: [...ids] };
      check(`the Portuguese copy has the same ${Object.keys(blocks).length} marked command blocks, byte for byte${ids.size ? ` (its two commit-comparison blocks carry one pasted commit id, ${[...ids].map((i) => i.slice(0, 7)).join(", ")}…, in place of the placeholder)` : ""}`, diff.length === 0 && ids.size <= 1, diff.join(", "));
    }
    r = run("plan");
    const want = ["0x47D4ae3D6d8e2d8261Ee7beEF510a217Bf4a4C50", "0x5709FF514a909aD0D994eC73D6128F38bF4F1Ca6", "0xc1D01eF14c0Cfe961f548398f9b12CfDC71172C9", "0xFf5f74c4Ca90Ae6024a29175c6d9d92CbD51C5E1", "0xf6046184F7267f0872BaB182C661f1C85695cAE2", "0x605E6b76402FF050BddC903Ea2326451272f7e32", "0x8A1DdC0BAE18A038D4E5Bb088eeDcdE10b61db53"];
    check("2.5 the plan prints exactly the addresses the document lists", r.status === 0 && want.every((a) => r.output.includes(a)) && want.every((a) => text.includes(a)), r.output.slice(-400));
    finish(evidence, out, save);
    return;
  }

  // ---------------------------------------------------------------- one chain
  const key = scope;
  const shared = loadShared();
  const chain = loadChain(key);
  const plan = planChain(shared, chain, loadArtifacts(join(REPO, "out")));
  const symbol = chain.nativeCurrency.symbol;
  const token = chain.tokens[0];
  const unit = 10n ** BigInt(token.decimals);
  const depositor = plan.arguments.firstDepositor;
  const funding = fundingOf(text, key, symbol);
  evidence.funding = funding;
  const port = Number(opt.port);
  const url = `http://127.0.0.1:${port}`;
  const FORK_SOURCE = { "bnb-smart-chain": "https://bsc-mainnet.public.blastapi.io", ethereum: chain.rpc[1] };
  const forkUrl = opt.forkUrl ?? FORK_SOURCE[key] ?? chain.rpc[0];
  evidence.fork = { source: forkUrl.replace(/^https?:\/\//, "").split("/")[0], port };
  const reportFile = join(out, "gate-report.json");
  writeFileSync(pwFile, `dry-run-${Math.random().toString(36).slice(2)}\n`, { mode: 0o600 });
  const values = {};
  const t = (cmd) => {
    let c = cmd
      .replaceAll(`deployments/${key}/gate-report.json`, reportFile)
      .replaceAll(DEPLOYER_DIR, keyDir)
      .replaceAll(DEPOSITOR_KEYSTORE, "--unlocked")
      .replace(/--rpc-url https:\/\/\S+/g, `--rpc-url ${url}`);
    for (const [k, v] of Object.entries(values)) c = c.replaceAll(k, v);
    if (/^node scripts\/multichain\/(gate|market|first-deposit|frontend-files|verify-chain)\.mjs /.test(c)) c += ` --rpc ${url} --rehearsal`;
    if (/^node scripts\/multichain\/frontend-files\.mjs /.test(c)) c += ` --out ${join(out, "files")}`;
    if (/^scripts\/multichain\/deploy\.sh /.test(c)) c = c.replace(" -- ", ` --rehearsal-rpc ${url} -- `) + ` --password-file ${pwFile}`;
    return c;
  };
  const run = (step, name = step) => sh(name, blocks[`${key} ${step}`], t(blocks[`${key} ${step}`]));

  // The owner's command, untransformed, against the PUBLIC chain (read-only): today it must fail on the fee-address
  // proof alone, and pass every other check.
  {
    const r = sh("public-pre-gate", blocks[`${key} pre-gate`], blocks[`${key} pre-gate`]);
    const fails = r.output.split("\n").filter((l) => l.startsWith("FAIL"));
    evidence.publicPreGate = { status: r.status, fails };
    if (evidence.feeProofRecorded === true || existsSync(join(REPO, "deployments/fee-address-proof.json")))
      check(`step 1 on the public chain (read-only): PASS with the recorded fee-address proof`, r.status === 0 && /pre: PASS/.test(r.output), fails.join(" | "));
    else
      check(`step 1 on the public chain (read-only): every check passes except the missing fee-address proof (the owner's signature, section 2.3)`, r.status !== 0 && fails.length === 1 && /proof of control of the fee address/.test(fails[0]), `${r.status}: ${fails.join(" | ") || r.output.slice(-300)}`);
  }

  // Review R402-5: the owner's deployment and prepare commands, untransformed, against the PUBLIC chain (read-only
  // up to where they stop): each runs the owner tools check itself and prints its PASS before anything else. Today
  // deploy.sh then stops at the pre gate (no fee-address proof) and prepare at the missing gate report: neither
  // reaches a key, and nothing is sent.
  if (!existsSync(join(REPO, "deployments/fee-address-proof.json"))) {
    const d = sh("public-deploy-dry-run", blocks[`${key} deploy-dry-run`], blocks[`${key} deploy-dry-run`]);
    check(`${key}-3 (R402-5) deploy.sh against the public chain runs the owner tools check itself (PASS on the tools directory), then stops at the pre gate: nothing was sent`, d.status === 1 && d.output.includes(`== owner tools: PASS (${toolsDir})`) && d.output.indexOf("== owner tools: PASS") < d.output.indexOf("== build") && /the pre gate did not pass; nothing was sent/.test(d.output), d.output.slice(-500));
    const p = sh("public-prepare", blocks[`${key} prepare`], blocks[`${key} prepare`]);
    check(`${key}-7 (R402-5) first-deposit prepare against the public chain runs the owner tools check itself (PASS), then stops without printing anything to send`, p.status !== 0 && p.output.includes(`owner tools: PASS (${toolsDir})`) && !/^cast send /m.test(p.output), p.output.slice(-500));
  }

  const anvil = spawn(join(binDir, "anvil"), ["--fork-url", forkUrl, "--port", String(port), "--host", "127.0.0.1", "--silent", "--retries", "20", "--fork-retry-backoff", "1500", "--timeout", "60000"], { stdio: ["ignore", "ignore", "inherit"] });
  if (opt.pidDir) writeFileSync(join(opt.pidDir, `anvil-${key}-${port}.pid`), `${anvil.pid} anvil --fork-url ${forkUrl} --port ${port}\n`);
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => (anvil.kill("SIGTERM"), process.exit(143)));
  process.on("exit", () => anvil.kill("SIGTERM"));
  let id = 0;
  const rpc = async (method, params = []) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const body = await res.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
  const hex = (n) => `0x${BigInt(n).toString(16)}`;
  const ABI = parseAbi(["function balanceOf(address) view returns (uint256)", "function getReserves() view returns (uint112,uint112,uint32)", "function getL1Fee(bytes) view returns (uint256)", "function gasEstimateL1Component(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)"]);
  const read = async (to, fn, args = []) => decodeFunctionResult({ abi: ABI, functionName: fn, data: await rpc("eth_call", [{ to, data: encodeFunctionData({ abi: ABI, functionName: fn, args }) }, "latest"]) });
  const nonceOf = async (a) => Number(BigInt(await rpc("eth_getTransactionCount", [a, "latest"])));
  const nativeOf = async (a) => BigInt(await rpc("eth_getBalance", [a, "latest"]));
  const mine = (n = 70) => rpc("anvil_mine", [hex(n)]);
  try {
    for (let i = 0; ; i++) {
      try {
        refuse(Number(BigInt(await rpc("eth_chainId"))) === chain.chain.chainId, "the fork is not the chain");
        break;
      } catch (error) {
        if (i > 120) throw error;
        await delay(500);
      }
    }
    const forkBlock = await rpc("eth_getBlockByNumber", ["latest", false]);
    evidence.fork.block = Number(BigInt(forkBlock.number));
    // As rehearse-fork.mjs: the EIP-2935 history slots of the blocks this run can mine are written locally first,
    // so that mining does not read the rate-limited public fork source once per block.
    const HISTORY = "0x0000F90827F1C53a10cb7A02335B175320002935";
    const slots = Array.from({ length: 1200 }, (_, i) => (BigInt(forkBlock.number) + BigInt(i)) % 8191n);
    for (let i = 0; i < slots.length; i += 100) await Promise.all(slots.slice(i, i + 100).map((s) => rpc("anvil_setStorageAt", [HISTORY, `0x${s.toString(16).padStart(64, "0")}`, `0x${"0".repeat(64)}`])));

    // Round 20 (finding F409-3): the owner has deployed on five chains, so a fork of today holds the factory, the
    // router and the lens, and the document's deployment blocks would send nothing. As rehearse-fork.mjs: the three
    // addresses must hold exactly the planned code; they are then cleared on the fork (code and nonce) so that the
    // blocks deploy the same bytes to the same addresses again.
    {
      const present = [];
      for (const c of Object.values(plan.contracts)) if ((await rpc("eth_getCode", [c.address, "latest"])) !== "0x") present.push(c);
      if (present.length) {
        const same = [];
        for (const c of present) same.push(keccak256(await rpc("eth_getCode", [c.address, "latest"])) === c.runtimeCodeHash);
        check(`${key}-0 the ${present.map((c) => c.name).join(", ")} already on the chain (the owner's deployment) hold exactly the planned code; cleared on the fork so that the document's blocks deploy them again`, same.every(Boolean), same.join());
        for (const p of plan.pairs) refuse((await rpc("eth_getCode", [p.address, "latest"])) === "0x", `the planned pair ${p.tokenA}/${p.tokenB} already exists on the forked chain: this dry run needs a fork from before its creation`);
        for (const c of present) {
          await rpc("anvil_setCode", [c.address, "0x"]);
          await rpc("anvil_setNonce", [c.address, "0x0"]);
        }
        evidence.ownerDeploymentCleared = present.map((c) => c.name);
      }
    }

    // The deploying key: the owner's commands of section 2.4 (cast wallet new), with a throwaway password.
    mkdirSync(keyDir, { recursive: true });
    const made = sh("deployer-new", 'cast wallet new "$DEX_DEPLOYER_KEYSTORE_DIR" deployer', `cast wallet new ${keyDir} deployer --unsafe-password "$(cat ${pwFile})"`);
    const deployer = made.output.match(/Address:\s+(0x[0-9a-fA-F]{40})/)?.[1];
    refuse(deployer, "no throwaway deploying key");
    values.DEPLOYER_ADDRESS = deployer;
    evidence.deployer = deployer;

    let r = run("pre-gate");
    check(`${key}-1 pre gate on the fork: PASS`, r.status === 0 && new RegExp(`multichain gate ${key} pre: PASS`).test(r.output), r.output.split("\n").filter((l) => l.startsWith("FAIL")).join(" | "));

    // Step 2: the owner funds the deploying account with the document's amount; nothing more.
    const deployerFund = parseUnits(funding.deployer, 18);
    await rpc("anvil_setBalance", [deployer, hex(deployerFund)]);
    r = run("deployer-balance");
    check(`${key}-2 the deploying account holds exactly the stated ${funding.deployer} ${symbol}`, r.status === 0 && Number(r.output.trim()) === Number(funding.deployer), r.output);
    r = run("gas-price");
    check(`${key}-2 cast gas-price answers`, r.status === 0 && /^[0-9]+$/.test(r.output.trim()), r.output);

    r = run("deploy-dry-run");
    check(`${key}-3 deploy.sh dry-run: ends "nothing was sent", no error`, r.status === 0 && /dry run only: nothing was sent/.test(r.output) && !/Error/.test(r.output), r.output.slice(-600));
    check(`${key}-3 the dry run sent nothing (deploying account nonce 0)`, (await nonceOf(deployer)) === 0);
    // forge's own upfront requirement at the fork's price (gas limits with its margin x its fee estimate): the
    // document's funding must cover it, or step 4 stops with "insufficient funds" (seen on Linea, 2026-11-17).
    {
      const est = r.output.match(new RegExp(`Estimated amount required: ([0-9.]+) ${symbol}`))?.[1];
      const price = r.output.match(/Estimated gas price: ([0-9.]+) gwei/)?.[1];
      evidence.forgeEstimate = { amountRequired: est ?? null, gasPriceGwei: price ?? null, totalGas: r.output.match(/Estimated total gas used for script: ([0-9]+)/)?.[1] ?? null };
      check(`${key}-3 the stated ${funding.deployer} ${symbol} covers forge's estimated amount required (${est} ${symbol} at ${price} gwei)`, est !== undefined && parseUnits(est, 18) < deployerFund, est);
    }

    r = run("deploy-broadcast");
    check(`${key}-4 deploy.sh broadcast: "== sent."`, r.status === 0 && /== sent\./.test(r.output), r.output.slice(-600));
    const broadcast = JSON.parse(readFileSync(join(REPO, "broadcast/DeployMultichain.s.sol", String(chain.chain.chainId), "run-latest.json"), "utf8"));
    const names = ["factory", "router", "lens"];
    const txs = [];
    for (const [i, receipt] of broadcast.receipts.entries()) {
      const tx = await rpc("eth_getTransactionByHash", [receipt.transactionHash]);
      txs.push({ step: `deploy ${names[i] ?? i}`, hash: receipt.transactionHash, from: tx.from, to: tx.to, input: tx.input, value: BigInt(tx.value), gasUsed: BigInt(receipt.gasUsed), status: receipt.status });
    }
    check(`${key}-4 three transactions, all successful, all from the throwaway deploying key`, txs.length === 3 && txs.every((x) => x.status === "0x1" && lower(x.from) === lower(deployer)), txs.map((x) => `${x.status} ${x.from}`));
    for (const [n, c] of Object.entries(plan.contracts)) check(`${key}-4 the ${n} is at the planned address ${c.address}`, (await rpc("eth_getCode", [c.address, "latest"])).length > 2);
    evidence.deployerLeft = formatUnits(await nativeOf(deployer), 18);

    // M1: the same deployment command, again (an interrupted or repeated step 4): nothing is sent.
    {
      const before = await nonceOf(deployer);
      const again = run("deploy-broadcast", "M1-deploy-again");
      check(`M1 ${key}-4 run a second time exits 0 and sends nothing (nonce ${before} unchanged)`, again.status === 0 && (await nonceOf(deployer)) === before, again.output.slice(-400));
    }
    // M4: the post gate before finality says WAIT, then PASS after the wait.
    r = run("post-gate-deployed", "M4-post-gate-too-early");
    // On a chain the owner has deployed, the fork's finalized block is a block of the REAL chain, where the three
    // contracts already are (clearing them on the fork changes the fork's own blocks only): the gate reads them there
    // and has nothing to wait for. The WAIT drill is shown by the run of a chain that is not deployed yet (Linea).
    if (evidence.ownerDeploymentCleared) check(`M4 ${key}-5 right after the deployment: PASS without a WAIT, because the fork's finalized block is the real chain's and already holds the owner's contracts (the WAIT drill needs a chain that is not deployed)`, /post: PASS/.test(r.output) && !/^WAIT/m.test(r.output), r.output.slice(-400));
    else check(`M4 ${key}-5 before finality: a WAIT line, no PASS`, /WAIT/.test(r.output) && !/post: PASS/.test(r.output), r.output.slice(-400));
    await mine();
    r = run("post-gate-deployed");
    const deployedReport = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, "utf8")) : null;
    check(`${key}-5 post gate: PASS, the pair absent`, r.status === 0 && /post: PASS/.test(r.output) && deployedReport?.pairs?.every((p) => p.state === "absent"), r.output.split("\n").filter((l) => /^(FAIL|WAIT)/.test(l)).join(" | "));

    // Step 6: market, then fund the depositing account as the document says (deposit + allowance; token + 1%).
    r = run("market");
    const at = r.output.match(new RegExp(`at that price: ([0-9.]+) ${symbol} \\+ ([0-9.]+) ${token.symbol}`));
    check(`${key}-6 market.mjs prints the token amount for the native amount`, r.status === 0 && at, r.output.slice(-400));
    const nativeAmount = at[1];
    const tokenAmount = parseUnits(at[2], token.decimals);
    const depositorNative = parseUnits(nativeAmount, 18) + parseUnits(funding.allowance, 18);
    const depositorToken = (tokenAmount * 101n) / 100n;
    evidence.depositorNonceBefore = await nonceOf(depositor);
    await rpc("anvil_impersonateAccount", [depositor]);
    await rpc("anvil_setBalance", [depositor, hex(depositorNative)]);
    let balanceSlot = null;
    for (let slot = 0n; slot < 80n && balanceSlot === null; slot++) {
      for (const k of [keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [depositor, slot])), keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "address" }], [slot, depositor]))]) {
        const before = await rpc("eth_getStorageAt", [token.address, k, "latest"]);
        await rpc("anvil_setStorageAt", [token.address, k, `0x${depositorToken.toString(16).padStart(64, "0")}`]);
        if ((await read(token.address, "balanceOf", [depositor])) === depositorToken) {
          balanceSlot = slot;
          break;
        }
        await rpc("anvil_setStorageAt", [token.address, k, before]);
      }
    }
    refuse(balanceSlot !== null, `no balance slot found for ${token.symbol}`);
    evidence.depositorFunded = { native: formatUnits(depositorNative, 18), token: formatUnits(depositorToken, token.decimals) };
    r = run("depositor-native");
    check(`${key}-6 the depositing account's native balance reads as funded`, r.status === 0 && Number(r.output.trim()) === Number(formatUnits(depositorNative, 18)), r.output);
    r = run("depositor-token");
    check(`${key}-6 the depositing account's ${token.symbol} balance reads as funded (base units)`, r.status === 0 && r.output.trim().split(" ")[0] === depositorToken.toString(), r.output);

    const prepareLines = (output) => output.split("\n").filter((l) => l.startsWith("cast send "));
    const sendLine = (line) => `${line} ${t(blocks[`${key} send-suffix`])}`;
    const hashOf = (output) => output.match(/transactionHash\s+(0x[0-9a-f]{64})/)?.[1];
    const statusOf = (output) => output.match(/\nstatus\s+(\d)/)?.[1];
    // Step 7 with the document's amount (the chain's minimum).
    const doPrepare = (name) => {
      const p = run("prepare", name);
      const lines = prepareLines(p.output);
      // prepare ends with "Then: node scripts/multichain/first-deposit.mjs <chain> verify ... --tx <hash of the deposit>".
      const verifyLine = p.output.match(new RegExp(`node scripts/multichain/first-deposit\\.mjs ${key} verify [^\\n]*`))?.[0];
      return { ...p, lines, verifyLine };
    };
    let p = doPrepare("prepare");
    check(`${key}-7 prepare: PASS with two cast send lines (approve, addLiquidityBLCH) from the depositing account, --chain ${chain.chain.chainId}`, p.status === 0 && p.lines.length === 2 && /approve\(address,uint256\)/.test(p.lines[0]) && /addLiquidityBLCH/.test(p.lines[1]) && p.lines.every((l) => l.includes(`--from ${depositor}`) && l.includes(`--chain ${chain.chain.chainId}`)), p.output.slice(-800));
    check(`${key}-7 prepare prints the verify line with the token amount filled in`, Boolean(p.verifyLine), p.output.slice(-400));
    values.TOKEN_AMOUNT = p.verifyLine?.match(/--token ([0-9.]+)/)?.[1] ?? "TOKEN_AMOUNT";

    // M2 and M3, on a snapshot (reverted afterwards).
    {
      const snap = await rpc("evm_snapshot");
      const a = sh("M2-approve-only", `${p.lines[0]} + suffix`, sendLine(p.lines[0]));
      check("M2 only the approve is sent (the deposit is not)", a.status === 0 && statusOf(a.output) === "1", a.output.slice(-300));
      const again = doPrepare("M2-prepare-again");
      check(`M2 prepare again after a lone approve: PASS, a fresh pair of lines`, again.status === 0 && again.lines.length === 2, again.output.slice(-500));
      const a2 = sh("M2-approve-again", again.lines[0], sendLine(again.lines[0]));
      const d2 = sh("M2-deposit", again.lines[1], sendLine(again.lines[1]));
      check("M2 the fresh pair goes through: the pool opens", a2.status === 0 && d2.status === 0 && statusOf(d2.output) === "1", d2.output.slice(-300));
      await rpc("evm_revert", [snap]);
      const snap2 = await rpc("evm_snapshot");
      const late = doPrepare("M3-prepare");
      sh("M3-approve", late.lines[0], sendLine(late.lines[0]));
      await rpc("evm_increaseTime", [21 * 60]);
      await mine(1);
      const d3 = sh("M3-deposit-after-deadline", late.lines[1], `${sendLine(late.lines[1])} --gas-limit 3000000`);
      const reserves = await rpc("eth_getCode", [plan.pairs[0].address, "latest"]);
      check("M3 the deposit sent after its 20-minute deadline reverts (status 0) and creates no pool", statusOf(d3.output) === "0" || /EXPIRED|revert/i.test(d3.output), d3.output.slice(-300));
      check("M3 nothing was deposited: the pair does not exist", reserves === "0x", reserves.length);
      // After 21 minutes of fork time the Chainlink feeds on the fork have not moved (nobody updates them on a
      // fork): prepare either still finds a market price or refuses with a stale feed. Both are correct; which one
      // depends on the feed's heartbeat. Recorded, not a pass condition (M3b is the pass condition).
      const after = doPrepare("M3-prepare-again");
      evidence.m3PrepareAfterDeadline = after.status === 0 && after.lines.length === 2 ? "PASS (feeds still fresh by their heartbeat)" : /s old at the pinned block/.test(after.output) ? "refused: a feed is stale on the fork after 21 minutes (no market price, nothing printed)" : `unexpected: ${after.output.slice(-300)}`;
      check("M3 prepare after the deadline revert: either PASS or the stale-feed refusal, never anything else", !evidence.m3PrepareAfterDeadline.startsWith("unexpected"), evidence.m3PrepareAfterDeadline);
      await rpc("evm_revert", [snap2]);
      // M3b: a deposit that runs out of gas (sent with too low a gas limit), without moving the clock: reverted,
      // nothing deposited, and prepare again prints a fresh pair that goes through.
      const snap3 = await rpc("evm_snapshot");
      const oog = doPrepare("M3b-prepare");
      sh("M3b-approve", oog.lines[0], sendLine(oog.lines[0]));
      const d3b = sh("M3b-deposit-out-of-gas", oog.lines[1], `${sendLine(oog.lines[1])} --gas-limit 300000`);
      check("M3b a deposit that runs out of gas is mined with status 0 and creates no pool", (statusOf(d3b.output) === "0" || /revert|out of gas/i.test(d3b.output)) && (await rpc("eth_getCode", [plan.pairs[0].address, "latest"])) === "0x", d3b.output.slice(-300));
      const again3 = doPrepare("M3b-prepare-again");
      check("M3b prepare again after the reverted deposit: PASS, two lines", again3.status === 0 && again3.lines.length === 2, again3.output.slice(-400));
      const a3 = sh("M3b-approve-again", again3.lines[0], sendLine(again3.lines[0]));
      const d3c = sh("M3b-deposit-again", again3.lines[1], sendLine(again3.lines[1]));
      check("M3b the fresh pair goes through: the pool opens", a3.status === 0 && statusOf(d3c.output) === "1", d3c.output.slice(-300));
      await rpc("evm_revert", [snap3]);
    }
    // The real sequence (the state before M2): prepare's lines as printed, approve then deposit.
    p = doPrepare("prepare-final");
    values.TOKEN_AMOUNT = p.verifyLine?.match(/--token ([0-9.]+)/)?.[1] ?? "TOKEN_AMOUNT";
    check(`${key}-7 prepare (the real sequence): PASS, two lines`, p.status === 0 && p.lines.length === 2, p.output.slice(-400));
    const approve = sh("send-approve", `${p.lines[0]} + ${blocks[`${key} send-suffix`]}`, sendLine(p.lines[0]));
    const deposit = sh("send-deposit", `${p.lines[1]} + ${blocks[`${key} send-suffix`]}`, sendLine(p.lines[1]));
    const approveHash = hashOf(approve.output);
    const depositHash = hashOf(deposit.output);
    check(`${key}-7 the approve and the deposit are mined with status 1 and print transactionHash`, approve.status === 0 && deposit.status === 0 && statusOf(approve.output) === "1" && statusOf(deposit.output) === "1" && approveHash && depositHash, `${approve.output.slice(-200)} ${deposit.output.slice(-200)}`);
    values.DEPOSIT_HASH = depositHash;
    for (const [name, hash] of [["approve", approveHash], ["first deposit (creates the pair)", depositHash]]) {
      const tx = await rpc("eth_getTransactionByHash", [hash]);
      const receipt = await rpc("eth_getTransactionReceipt", [hash]);
      txs.push({ step: name, hash, from: tx.from, to: tx.to, input: tx.input, value: BigInt(tx.value), gasUsed: BigInt(receipt.gasUsed), status: receipt.status });
    }
    check(`${key}-7 both from the depositing account ${depositor}`, txs.slice(3).every((x) => lower(x.from) === lower(depositor)));

    r = run("verify");
    check(`${key}-8 verify: PASS`, r.status === 0 && /verify .*: PASS/.test(r.output), r.output.slice(-500));
    await mine();
    r = run("post-gate-open");
    const openReport = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, "utf8")) : null;
    check(`${key}-9 post gate with the opening: PASS, the pair open and proven`, r.status === 0 && /post: PASS/.test(r.output) && openReport?.pairs?.every((x, i) => (i === 0 ? x.state === "open" && x.opening?.proven === true : x.state === "absent")), r.output.split("\n").filter((l) => /^(FAIL|WAIT)/.test(l)).join(" | "));
    r = run("frontend-record");
    const record = existsSync(join(out, "files", key, "frontend.record.json")) ? JSON.parse(readFileSync(join(out, "files", key, "frontend.record.json"), "utf8")) : null;
    check(`${key}-10 the page's record is written from the report`, r.status === 0 && record && record.status !== "not-deployed", r.output.slice(-400));
    evidence.depositorLeft = { native: formatUnits(await nativeOf(depositor), 18), token: formatUnits(await read(token.address, "balanceOf", [depositor]), token.decimals) };
    evidence.depositorNonceAfter = await nonceOf(depositor);
    check(`${key}-7 the depositing account sent exactly two transactions in the real sequence`, evidence.depositorNonceAfter - evidence.depositorNonceBefore === 2, `${evidence.depositorNonceBefore} -> ${evidence.depositorNonceAfter}`);

    // Cost today: gas used on the fork x the public chain's gas price now, plus the rollup's data fee from its own
    // oracle (the method of scripts/multichain/cost.mjs, applied to all five transactions).
    evidence.cost = await costToday({ chain, txs });
    evidence.transactions = txs.map(({ input, ...x }) => ({ ...x, calldataBytes: (input.length - 2) / 2 }));
    // Cross-check: cost.mjs itself, on the three deployment receipts.
    mkdirSync(join(out, "cost-evidence"), { recursive: true });
    writeFileSync(join(out, "cost-evidence", "evidence.json"), JSON.stringify({ deployment: txs.slice(0, 3).map((x) => ({ step: x.step, gasUsed: x.gasUsed.toString() })) }));
    const c = spawnSync(join(binDir, "node"), ["scripts/multichain/cost.mjs", key, "--evidence", join(out, "cost-evidence"), "--out", join(out, "cost-mjs.json")], { cwd: REPO, encoding: "utf8", env: { ...terminal, PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin` } });
    writeFileSync(join(out, "cost-mjs.log"), `${c.stdout}${c.stderr}`);
    evidence.costMjs = c.status === 0 ? JSON.parse(readFileSync(join(out, "cost-mjs.json"), "utf8")).total : `failed: ${c.stderr.slice(-200)}`;
    check(`cost: today's price read from the public chain for all five transactions`, evidence.cost && !evidence.cost.error, evidence.cost?.error);
    check(`the deploying account's stated ${funding.deployer} ${symbol} covers today's deployment cost`, evidence.cost && BigInt(evidence.cost.deploymentWei) < deployerFund, evidence.cost?.deployment);
    evidence.deployerCoversGwei = evidence.cost ? Number(formatUnits((deployerFund - BigInt(evidence.cost.deploymentDataFeeWei)) / BigInt(evidence.cost.deploymentGas), 9)) : null;
    evidence.allowanceCoversGwei = evidence.cost ? Number(formatUnits((parseUnits(funding.allowance, 18) - BigInt(evidence.cost.depositDataFeeWei)) / BigInt(evidence.cost.depositGas), 9)) : null;
    // ------------------------------------------------------------ section 8B: the chain's second pool (round 20)
    if (chain.initialPairs.length > 1) {
      const second = secondBlocksOf(text);
      const expectedSecond = [...SECOND_ONCE_STEPS.map((x) => `once ${x}`), ...SECOND_CHAIN_STEPS.map((x) => `${key} ${x}`)];
      refuse(expectedSecond.every((k) => second[k]), `${DOC}: missing second-pool blocks: ${expectedSecond.filter((k) => !second[k]).join(", ")}`);
      const base = "ba1455b5a5580c2226c767e625759654dd63cbc0";
      const G = (args, cwd) => {
        const g = spawnSync("/usr/bin/git", args, { cwd, encoding: "utf8" });
        refuse(g.status === 0, `git ${args.join(" ")}: ${g.stderr}`);
        return g.stdout;
      };
      // ---- 8B.0 on a throwaway copy of the owner's state: a clone of the published main as it was when he
      // started (ba1455b), with his own commits (a stand-in for the fee-address proof; this chain's record and gate
      // report, as steps 10 and 11 leave them) and an untracked report of another chain; then the published main
      // moves to the commit under test.
      const originDir = join(out, "owner-origin.git");
      const copy = join(out, "owner-copy");
      const dirty = join(out, "owner-copy-changed");
      for (const d of [originDir, copy, dirty]) rmSync(d, { recursive: true, force: true });
      G(["init", "-q", "--bare", originDir], out);
      G(["push", "-q", originDir, `${base}:refs/heads/main`], ROOT);
      G(["clone", "-q", "--branch", "main", originDir, copy], out);
      G(["config", "user.name", "Owner dry run"], copy);
      G(["config", "user.email", "owner-dry-run@example.invalid"], copy);
      writeFileSync(join(copy, "deployments/fee-address-proof.json"), `${JSON.stringify({ note: "stand-in written by the dry run: the owner's proof is his own file and is not read here" }, null, 2)}\n`);
      G(["add", "deployments/fee-address-proof.json"], copy);
      G(["commit", "-q", "-m", "stand-in: fee address proof (owner run)"], copy);
      writeFileSync(join(copy, `deployments/${key}/gate-report.json`), readFileSync(reportFile));
      writeFileSync(join(copy, `deployments/${key}/frontend.record.json`), readFileSync(join(out, "files", key, "frontend.record.json")));
      G(["add", `deployments/${key}`], copy);
      G(["commit", "-q", "-m", `${chain.chain.name}: deployed and pool opened (owner run)`], copy);
      const other = ORDER.find((k) => k !== key);
      writeFileSync(join(copy, `deployments/${other}/gate-report.json`), "{}\n");
      const ownHead = G(["rev-parse", "HEAD"], copy).trim();
      G(["push", "-q", originDir, `${head}:refs/heads/main`], ROOT);
      spawnSync("/bin/cp", ["-R", copy, dirty]);
      const at = (dir, cmd) => cmd.replaceAll(OWNER_CLONE, dir);
      const once = (step, dir = copy, name = `8B0-${step}`) => shell(name, second[`once ${step}`], `${envPrefix}${at(dir, second[`once ${step}`])}`, { cwd: dir });
      // The copy with a tracked tool file changed and not committed (what section 2.1's commit comparison exists for).
      const tool = "scripts/multichain/first-deposit.mjs";
      appendFileSync(join(dirty, tool), "\n// one line added after the reviewed commit\n");
      once("fetch", dirty, "8B0-changed-fetch");
      let r = once("rebase", dirty, "8B0-changed-rebase");
      check("8B.0 with a tracked tool file changed and not committed: the rebase block REFUSES (unstaged changes) and the copy stays at the owner's own commit", r.status !== 0 && /cannot rebase: You have unstaged changes/.test(r.output) && G(["rev-parse", "HEAD"], dirty).trim() === ownHead, r.output.slice(-300));
      // What the guide forbids (drill only): with autostash the rebase goes through; the document's comparison
      // block must then show the changed tool. The earlier form of the block (two commits compared) did not.
      r = shell("8B0-changed-autostash-drill", "(drill, forbidden by the guide) git -c rebase.autoStash=true rebase origin/main", "/usr/bin/git -c rebase.autoStash=true rebase origin/main", { cwd: dirty });
      const listed = (output) => output.split("\n").map((l) => l.match(/^ (\S+)\s+\|/)?.[1]).filter(Boolean);
      const shown = once("own-commits", dirty, "8B0-changed-own-commits");
      const earlier = shell("8B0-changed-earlier-form", "(the block before review R414-2) git diff --stat origin/main HEAD", "/usr/bin/git diff --stat origin/main HEAD", { cwd: dirty });
      check("8B.0 (R414-2) had the rebase gone through with that change, the document's comparison block lists the changed tool file; the block's earlier form (two commits) did not", r.status === 0 && listed(shown.output).includes(tool) && !listed(earlier.output).includes(tool), `${shown.output} / ${earlier.output}`);
      // The clean copy, block by block.
      r = shell("8B0-cd", second["once cd"], `${at(copy, second["once cd"])} && pwd -P`, { cwd: out });
      check("8B.0 the copy is entered", r.status === 0, r.output);
      r = once("fetch");
      check("8B.0 git fetch origin: the published main moved", r.status === 0, r.output.slice(-200));
      r = once("origin-main");
      check("8B.0 git rev-parse origin/main prints the 40 digits of the commit under test", r.status === 0 && r.output.trim() === head, r.output);
      r = once("rebase");
      check("8B.0 git rebase origin/main: Successfully rebased; the owner's two commits are on top of the reviewed commit", r.status === 0 && /Successfully rebased/.test(r.output) && G(["rev-parse", "HEAD~2"], copy).trim() === head, r.output.slice(-300));
      r = once("own-commits");
      const files = listed(r.output);
      check("8B.0 the comparison block lists only the owner's own files under deployments/ (the proof, this chain's report and record); the untracked report of another chain is untouched", r.status === 0 && files.length === 3 && files.every((f) => f.startsWith("deployments/")) && files.includes("deployments/fee-address-proof.json") && existsSync(join(copy, `deployments/${other}/gate-report.json`)), r.output);
      {
        // What replaces section 2.1's check: that script now says FAIL for the id received and PASS for the owner's own id.
        const script = `/bin/bash scripts/multichain/reviewed-commit.sh`;
        const a = shell("8B0-reviewed-commit-received-id", "(not a block of 8B) reviewed-commit.sh with the id received", `${envPrefix}${script} ${head}`, { cwd: copy });
        const b = shell("8B0-reviewed-commit-own-id", "(not a block of 8B) reviewed-commit.sh with the owner's own new id", `${envPrefix}${script} ${G(["rev-parse", "HEAD"], copy).trim()}`, { cwd: copy });
        check("8B.0 as the document says, reviewed-commit.sh no longer applies: FAIL with the id received, an empty PASS with the owner's own id", a.status === 1 && /reviewed commit: FAIL/.test(a.output) && b.status === 0 && /reviewed commit: PASS/.test(b.output), `${a.output.slice(-120)} / ${b.output.slice(-120)}`);
      }
      // The copy's packages are the owner's own from section 2.1 (the lockfile did not change); here the fresh clone's.
      check("8B.0 the lockfile of the packages is the one of ba1455b (no new install is needed)", spawnSync("/usr/bin/git", ["diff", "--quiet", base, head, "--", "frontend/package-lock.json"], { cwd: ROOT }).status === 0);
      spawnSync("/bin/ln", ["-s", join(REPO, "frontend/node_modules"), join(copy, "frontend/node_modules")]);
      r = once("forge-build");
      check("8B.0 forge build in the copy: Compiler run successful", r.status === 0 && /Compiler run successful|No files changed, compilation skipped/.test(r.output), r.output.slice(0, 400));
      r = once("kit-tests");
      check("8B.0 the kit test of this section in the copy (which holds a chain recorded as deployed): fail 0", r.status === 0 && /ℹ fail 0/.test(r.output), r.output.slice(-400));

      // ---- 8B.<chain>: the second pool, on the same fork, after the first.
      const token2 = chain.tokens[1];
      const pairName = `${chain.wrappedNative.symbol}/${token2.symbol}`;
      const run2 = (step, name = `U-${step}`) => sh(name, second[`${key} ${step}`], t(second[`${key} ${step}`]));
      r = run2("verify-chain");
      check(`${key}-U1 verify-chain on the fork: PASS`, r.status === 0 && new RegExp(`multichain verify-chain ${key}: PASS`).test(r.output), r.output.split("\n").filter((l) => l.startsWith("FAIL")).join(" | "));
      r = run2("post-gate-two-pairs");
      let two = JSON.parse(readFileSync(reportFile, "utf8"));
      check(`${key}-U2 post gate with the plan of two pairs: PASS, the first pool open and proven from the report it replaces, ${pairName} absent`, r.status === 0 && /post: PASS/.test(r.output) && two.pairs.length === 2 && two.pairs[0].opening?.proven === true && two.pairs[0].opening.transaction === depositHash && two.pairs[1].state === "absent", r.output.split("\n").filter((l) => /^(FAIL|WAIT|NOT WRITTEN)/.test(l)).join(" | "));
      r = run2("market");
      const at2 = r.output.match(new RegExp(`at that price: ([0-9.]+) ${symbol} \\+ ([0-9.]+) ${token2.symbol}`));
      check(`${key}-U3 market.mjs --pair ${pairName} prints the token amount and who answered`, r.status === 0 && at2 && /^endpoints: every one of the \d+ reads was answered by at least/m.test(r.output), r.output.slice(-400));
      const native2 = parseUnits(at2[1], 18) + parseUnits(funding.allowance, 18);
      const amount2 = (parseUnits(at2[2], token2.decimals) * 101n) / 100n;
      await rpc("anvil_setBalance", [depositor, hex(native2)]);
      {
        // The token comes from a holder of the fork by an ordinary transfer (the pair's own reference pool).
        const holder = chain.initialPairs[1].openingPrice.references[1].pool;
        await rpc("anvil_impersonateAccount", [holder]);
        await rpc("anvil_setBalance", [holder, hex(10n ** 18n)]);
        const had = await read(token2.address, "balanceOf", [depositor]);
        const sent = await rpc("eth_sendTransaction", [{ from: holder, to: token2.address, data: encodeFunctionData({ abi: parseAbi(["function transfer(address,uint256)"]), functionName: "transfer", args: [depositor, amount2 - had] }), gas: hex(300_000n) }]);
        for (let i = 0; i < 100 && !(await rpc("eth_getTransactionReceipt", [sent])); i++) await delay(100);
      }
      r = run2("depositor-native");
      check(`${key}-U3 the depositing account's native balance reads as funded`, r.status === 0 && Number(r.output.trim()) === Number(formatUnits(native2, 18)), r.output);
      r = run2("depositor-token");
      check(`${key}-U3 the depositing account's ${token2.label ?? token2.symbol} balance reads as funded (base units, ${token2.decimals} decimals)`, r.status === 0 && r.output.trim().split(" ")[0] === amount2.toString(), r.output);
      const nonce2 = await nonceOf(depositor);
      const p2 = run2("prepare");
      const lines2 = prepareLines(p2.output);
      const verify2 = p2.output.match(new RegExp(`node scripts/multichain/first-deposit\\.mjs ${key} verify [^\\n]*`))?.[0];
      check(`${key}-U4 prepare --pair ${pairName}: PASS with two cast send lines from the depositing account, the token's state and the endpoints line printed`, p2.status === 0 && lines2.length === 2 && /approve\(address,uint256\)/.test(lines2[0]) && /addLiquidityBLCH/.test(lines2[1]) && lines2.every((l) => l.includes(`--from ${depositor} --chain ${chain.chain.chainId}`)) && new RegExp(`ok   ${token2.symbol} takes no fee on transfer`).test(p2.output) && /endpoints: every one of the/.test(p2.output), p2.output.slice(-600));
      values.TOKEN_AMOUNT = verify2?.match(/--token ([0-9.]+)/)?.[1] ?? "TOKEN_AMOUNT";
      const approve2 = sh("U-send-approve", `${lines2[0]} + ${blocks[`${key} send-suffix`]}`, sendLine(lines2[0]));
      const deposit2 = sh("U-send-deposit", `${lines2[1]} + ${blocks[`${key} send-suffix`]}`, sendLine(lines2[1]));
      const hash2 = hashOf(deposit2.output);
      check(`${key}-U4 the approve and the deposit are mined with status 1; the depositing account sent exactly two transactions`, statusOf(approve2.output) === "1" && statusOf(deposit2.output) === "1" && Boolean(hash2) && (await nonceOf(depositor)) - nonce2 === 2, `${approve2.output.slice(-150)} ${deposit2.output.slice(-150)}`);
      values.DEPOSIT_HASH = hash2;
      r = run2("verify");
      check(`${key}-U5 verify --pair ${pairName}: PASS`, r.status === 0 && /verify .*: PASS/.test(r.output), r.output.slice(-500));
      await mine();
      r = run2("post-gate-open");
      two = JSON.parse(readFileSync(reportFile, "utf8"));
      check(`${key}-U6 post gate with the second opening: PASS, both pools open and proven (the first from the report, the second from the option)`, r.status === 0 && /post: PASS/.test(r.output) && two.pairs.map((x) => x.opening?.proven === true && x.state === "open").join() === "true,true" && two.pairs[0].opening.transaction === depositHash && two.pairs[1].opening.transaction === hash2, r.output.split("\n").filter((l) => /^(FAIL|WAIT|NOT WRITTEN)/.test(l)).join(" | "));
      r = run2("frontend-record");
      const record2 = JSON.parse(readFileSync(join(out, "files", key, "frontend.record.json"), "utf8"));
      check(`${key}-U7 the page's record lists both pools and names none as not open`, r.status === 0 && record2.status === "deployed" && record2.pairs.length === 2 && !("notOpen" in record2), r.output.slice(-300));
      // U8 in the throwaway copy of the owner's state: the report and the record of this run, added and committed.
      writeFileSync(join(copy, `deployments/${key}/gate-report.json`), readFileSync(reportFile));
      writeFileSync(join(copy, `deployments/${key}/frontend.record.json`), readFileSync(join(out, "files", key, "frontend.record.json")));
      const add = shell("U-record-add", second[`${key} record-add`], second[`${key} record-add`], { cwd: copy });
      const commit = shell("U-record-commit", second[`${key} record-commit`], second[`${key} record-commit`], { cwd: copy });
      check(`${key}-U8 the record is added and committed in the owner's copy`, add.status === 0 && commit.status === 0 && G(["status", "--porcelain", "--untracked-files=no"], copy).trim() === "", `${add.output} ${commit.output}`.slice(-300));
      evidence.secondPool = { pair: pairName, token: token2.address, deposit: hash2, tokenAmount: values.TOKEN_AMOUNT };
    }
  } catch (error) {
    check("the dry run completed", false, error.stack ?? error.message);
  } finally {
    anvil.kill("SIGTERM");
  }
  finish(evidence, out, save);
}

function finish(evidence, out, save) {
  const bad = evidence.checks.filter((c) => !c.ok).length;
  evidence.result = bad === 0 ? "PASS" : "FAIL";
  save();
  console.log(`owner dry run ${evidence.scope}: ${evidence.result}; ${evidence.checks.length} checks, ${bad} failed; ${join(out, "evidence.json")}`);
  process.exitCode = bad === 0 ? 0 : 1;
}

async function costToday({ chain, txs }) {
  let request = null;
  for (const u of chain.rpc) {
    try {
      const r = createRpcTransport(u, { timeoutMs: 45_000 });
      await r("eth_chainId", []);
      request = r;
      break;
    } catch {
      /* next */
    }
  }
  if (!request) return { error: "no public endpoint answered" };
  const ORACLE = parseAbi(["function getL1Fee(bytes) view returns (uint256)", "function gasEstimateL1Component(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)"]);
  const gasPrice = BigInt(await request("eth_gasPrice", []));
  const latest = await request("eth_getBlockByNumber", ["latest", false]);
  const stack = chain.chain.stack;
  let price = gasPrice;
  let priceNote = "eth_gasPrice";
  if (stack.includes("Linea")) {
    try {
      const q = await request("linea_estimateGas", [{ from: chain.wrappedNative.address, to: txs[0].to, data: txs[0].input, value: "0x0" }]);
      price = BigInt(q.baseFeePerGas) + BigInt(q.priorityFeePerGas);
      priceNote = "linea_estimateGas (factory deployment)";
    } catch (error) {
      priceNote = `eth_gasPrice (linea_estimateGas failed: ${String(error.message).slice(0, 80)})`;
    }
  }
  const rows = [];
  for (const x of txs) {
    let dataFee = 0n;
    let extraGas = 0n;
    if (stack.startsWith("OP Stack")) {
      const body = serializeTransaction({ type: "eip1559", chainId: chain.chain.chainId, nonce: 1, to: x.to, data: x.input, gas: x.gasUsed, maxFeePerGas: gasPrice * 2n, maxPriorityFeePerGas: gasPrice, value: x.value });
      const o = await request("eth_call", [{ to: "0x420000000000000000000000000000000000000F", data: encodeFunctionData({ abi: ORACLE, functionName: "getL1Fee", args: [concat([body, `0x${"ab".repeat(67)}`])] }) }, "latest"]);
      dataFee = decodeFunctionResult({ abi: ORACLE, functionName: "getL1Fee", data: o });
    } else if (stack.startsWith("Arbitrum")) {
      const o = await request("eth_call", [{ to: "0x00000000000000000000000000000000000000C8", data: encodeFunctionData({ abi: ORACLE, functionName: "gasEstimateL1Component", args: [x.to, false, x.input] }) }, "latest"]);
      extraGas = BigInt(decodeFunctionResult({ abi: ORACLE, functionName: "gasEstimateL1Component", data: o })[0]);
    }
    const wei = (x.gasUsed + extraGas) * price + dataFee;
    rows.push({ step: x.step, gasUsed: x.gasUsed, extraGas, dataFeeWei: dataFee, wei, cost: formatUnits(wei, 18) });
  }
  const sum = (list, f) => list.reduce((n, r) => n + f(r), 0n);
  const dep = rows.slice(0, 3);
  const open = rows.slice(3);
  return {
    endpoint: request === null ? null : "first answering reviewed endpoint",
    block: Number(BigInt(latest.number)),
    time: new Date(Number(BigInt(latest.timestamp)) * 1000).toISOString(),
    gasPriceWei: gasPrice,
    pricePerGasWei: price,
    priceNote,
    rows,
    deploymentGas: sum(dep, (r) => r.gasUsed + r.extraGas),
    deploymentDataFeeWei: sum(dep, (r) => r.dataFeeWei),
    deploymentWei: sum(dep, (r) => r.wei),
    deployment: formatUnits(sum(dep, (r) => r.wei), 18),
    depositGas: sum(open, (r) => r.gasUsed + r.extraGas),
    depositDataFeeWei: sum(open, (r) => r.dataFeeWei),
    depositWei: sum(open, (r) => r.wei),
    deposit: formatUnits(sum(open, (r) => r.wei), 18),
    totalWei: sum(rows, (r) => r.wei),
    total: formatUnits(sum(rows, (r) => r.wei), 18),
  };
}
