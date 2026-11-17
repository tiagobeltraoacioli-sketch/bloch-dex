#!/usr/bin/env node
// Dry run of docs/OWNER-DEPLOY-NOW.md: the owner's own command blocks, executed on a loopback anvil fork of one
// chain, with a throwaway deploying key and the depositing account impersonated (no key of the owner's is used or
// needed). Nothing is sent to a public chain: every transaction goes to the fork; public endpoints are only READ
// (the public pre gate, the market, gas prices and rollup data-fee oracles for the cost).
//
//   node scripts/multichain/owner-dry-run.mjs once  --out DIR [--pt FILE] [--archives DIR] [--stand-in DIR]
//   node scripts/multichain/owner-dry-run.mjs <chain> --port PORT --out DIR [--fork-url URL] [--pid-dir DIR]
//                                                     [--tools DIR | --archives DIR] [--stand-in DIR]
//
// The tools (review R369-16): the run installs the owner's toolchain with the document's own install block into
// DIR/owner-tools (from the pinned official URLs; with --archives DIR from archives already fetched from them, each
// still compared with the pins), or checks an earlier run's directory (--tools DIR), always with the document's own
// PATH line and check block, and then runs every command with those tools.
// --stand-in DIR is for a session that may not start a program it has just downloaded: install and check then run
// with --no-run (hashes, digest, permissions and PATH only), and the commands run with the installed directory's own
// launchers over the programs of DIR (DIR/foundry/{forge,cast,anvil}, DIR/node/…/bin/node, DIR/libusb/lib), after
// this run has checked that those four programs have exactly the pinned SHA-256. The result names the mode.
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
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createRpcTransport } from "../staging/rpc-transport.mjs";
import { ROOT, loadArtifacts, loadChain, loadShared, lower, planChain, refuse } from "./lib.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { keccak256, encodeAbiParameters, encodeFunctionData, decodeFunctionResult, parseAbi, parseUnits, formatUnits, serializeTransaction, concat } = requireFromFrontend("viem");

export const DOC = "docs/OWNER-DEPLOY-NOW.md";
export const CHAIN_STEPS = ["pre-gate", "deployer-balance", "gas-price", "deploy-dry-run", "deploy-broadcast", "post-gate-deployed", "market", "depositor-native", "depositor-token", "prepare", "send-suffix", "verify", "post-gate-open", "frontend-record", "record-add", "record-commit"];
export const ONCE_STEPS = ["clone", "clone-commit", "no-agents", "tools-install", "env-path", "tools-check", "tools-type", "kit-tests", "check-depositor", "fee-proof-message", "fee-proof-page", "fee-proof-record", "fee-proof-verify", "deployer-dir", "deployer-new", "deployer-address", "plan"];
export const ORDER = ["op-mainnet", "base", "arbitrum-one", "linea", "bnb-smart-chain", "ethereum"];
const DEPOSITOR_KEYSTORE = '--keystore "$DEX_DEPOSITOR_KEYSTORE_DIR/depositante"';
// The document names the deploying key's directory only as DEX_DEPLOYER_KEYSTORE_DIR (H398-3); the dry run sets it
// to its own throwaway directory in every command's environment and keeps the command text as written.
const DEPLOYER_DIR = '"$DEX_DEPLOYER_KEYSTORE_DIR"';
// The owner's tools directory and the path of the toolchain script, as the document writes them.
export const OWNER_TOOLS = ["~/dex-owner-tools", "$HOME/dex-owner-tools"];
export const TOOLCHAIN_SCRIPT = "~/postern-dex/scripts/multichain/owner-toolchain.sh";
export const TOOL_NAMES = ["forge", "cast", "anvil", "node", "npm"];

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
  refuse(scope && opt.out && (scope === "once" || (ORDER.includes(scope) && opt.port)), "usage: owner-dry-run.mjs once --out DIR [--pt FILE] | <chain> --port PORT --out DIR [--fork-url URL] [--pid-dir DIR] [--tools DIR]; both: [--archives DIR] [--stand-in DIR]");
  refuse(!(opt.tools && scope === "once"), "once installs the tools itself (--tools is for a chain run)");
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
  /** Run one shell command line and log it next to the document's block it came from. */
  const shell = (step, original, command, { timeoutMs = 900_000, cwd = ROOT, env = {} } = {}) => {
    appendFileSync(log, `\n## ${step}\n# document: ${original}\n$ ${command}\n`);
    const started = Date.now();
    const r = spawnSync("bash", ["-c", command], { cwd, encoding: "utf8", timeout: timeoutMs, env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1", ...env } });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    appendFileSync(log, `${output}\n# exit ${r.status} after ${Math.round((Date.now() - started) / 1000)} s\n`);
    writeFileSync(join(out, `${step}.log`), output);
    evidence.steps.push({ step, status: r.status, seconds: Math.round((Date.now() - started) / 1000) });
    save();
    return { status: r.status, output };
  };

  // ---------------------------------------------------------------- the owner's tools (review R369-16)
  // The document's install block, PATH line and check block, as written, with the tools directory moved into this
  // run's own directory (the owner's ~/dex-owner-tools is never written by a dry run) and the toolchain script taken
  // from the commit under test.
  const toolsDir = opt.tools ? resolve(opt.tools) : join(out, "owner-tools");
  const swap = (cmd) => OWNER_TOOLS.reduce((c, d) => c.replaceAll(d, toolsDir), cmd).replaceAll(TOOLCHAIN_SCRIPT, join(ROOT, "scripts/multichain/owner-toolchain.sh"));
  const noRun = opt.standIn ? " --no-run" : "";
  const passLine = opt.standIn ? /^owner tools: HASHES PASS, programs not run/ : /^owner tools: PASS$/;
  const lastLine = (output) => output.trim().split("\n").at(-1) ?? "";
  const docPath = swap(blocks["once env-path"]);
  const toolsCheck = (step, prefix = `${docPath}; `) => shell(step, blocks["once tools-check"], `${prefix}${swap(blocks["once tools-check"])}${noRun}`);
  evidence.tools = { directory: toolsDir, mode: opt.standIn ? "stand-in" : "installed", installedBy: opt.tools ? "an earlier run (--tools)" : opt.archives ? "this run, from --archives" : "this run, from the pinned URLs" };
  if (!opt.tools) {
    rmSync(toolsDir, { recursive: true, force: true });
    const r = shell("tools-install", blocks["once tools-install"], `${swap(blocks["once tools-install"])}${opt.archives ? ` --from ${resolve(opt.archives)}` : ""}${noRun}`);
    check(`tools: the document's install block builds the tools directory from the pinned archives (${evidence.tools.installedBy.replace("this run, ", "")}), every archive's SHA-256 checked first`, r.status === 0 && (r.output.match(/^ok {4}\S+ sha256 [0-9a-f]{64}$/gm) ?? []).length >= 2 && (opt.standIn ? passLine.test(lastLine(r.output)) : /^owner tools: installed and verified in /.test(lastLine(r.output))), r.output.slice(-500));
  }
  {
    const r = toolsCheck("tools-check");
    check(`tools: the document's PATH line then its check block: ${opt.standIn ? "hashes, digest, permissions and PATH pass (programs not run: --stand-in)" : "the last line is exactly \"owner tools: PASS\""}`, r.status === 0 && passLine.test(lastLine(r.output)) && !/^FAIL/m.test(r.output), r.output.slice(-600));
  }
  if (scope === "once") {
    // Refusals on the real directory, each undone: a byte added to cast; access for the group; no PATH line.
    const cast = join(toolsDir, "foundry/cast");
    const size = statSync(cast).size;
    appendFileSync(cast, "\n");
    let r = toolsCheck("T1-cast-changed");
    truncateSync(cast, size);
    check("T1 one byte added to cast: the check refuses, names cast and prints no PASS", r.status === 1 && /^FAIL foundry\/cast has SHA-256 [0-9a-f]{64}; pinned [0-9a-f]{64}$/m.test(r.output) && !/owner tools: (PASS|HASHES PASS)/.test(r.output), r.output.slice(-400));
    chmodSync(toolsDir, 0o750);
    r = toolsCheck("T2-group-access");
    chmodSync(toolsDir, 0o700);
    check("T2 the directory opened to the group: the check refuses", r.status === 1 && /has access mode 750; it must be 700/.test(r.output) && !/owner tools: (PASS|HASHES PASS)/.test(r.output), r.output.slice(-400));
    r = toolsCheck("T3-no-path-line", "export PATH=/usr/bin:/bin; ");
    check("T3 without the document's PATH line: the check refuses", r.status === 1 && /FAIL this terminal's PATH finds forge at 'nowhere'/.test(r.output) && !/owner tools: (PASS|HASHES PASS)/.test(r.output), r.output.slice(-400));
    r = toolsCheck("tools-check-again");
    check("tools: with the three changes undone the check passes again", r.status === 0 && passLine.test(lastLine(r.output)), r.output.slice(-400));
  }
  // The directory whose bin/ the commands use: the installed one, or (--stand-in) its launchers over DIR's programs.
  let binDir = join(toolsDir, "bin");
  let envPrefix = `${docPath}; `;
  if (opt.standIn) {
    const from = resolve(opt.standIn);
    const nodeRoot = existsSync(join(from, "node/bin/node")) ? join(from, "node") : join(from, "node", readdirSync(join(from, "node")).find((d) => existsSync(join(from, "node", d, "bin/node"))) ?? "missing");
    const platform = process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
    const pins = pinnedFiles(platform);
    const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
    const actual = { "foundry/forge": sha(join(from, "foundry/forge")), "foundry/cast": sha(join(from, "foundry/cast")), "foundry/anvil": sha(join(from, "foundry/anvil")), "node/bin/node": sha(join(nodeRoot, "bin/node")) };
    const equal = Object.entries(actual).every(([k, v]) => pins[k] === v);
    const libusb = existsSync(join(from, "libusb/lib/libusb-1.0.0.dylib")) ? sha(join(from, "libusb/lib/libusb-1.0.0.dylib")) : null;
    evidence.tools.standIn = { directory: from, programs: actual, pinned: pins, libusb, libusbIsThePinnedOne: libusb !== null && libusb === pins["libusb/lib/libusb-1.0.0.dylib"] };
    refuse(equal, `--stand-in ${from}: forge, cast, anvil or node there does not have the pinned SHA-256; not used`);
    check("tools (--stand-in): forge, cast, anvil and node of the stand-in directory have exactly the pinned SHA-256 (the same bytes as the installed ones)", equal);
    const stand = join(out, "stand-in-tools");
    rmSync(stand, { recursive: true, force: true });
    mkdirSync(join(stand, "bin"), { recursive: true });
    for (const t of TOOL_NAMES) copyFileSync(join(toolsDir, "bin", t), join(stand, "bin", t));
    for (const t of TOOL_NAMES) chmodSync(join(stand, "bin", t), 0o700);
    symlinkSync(join(from, "foundry"), join(stand, "foundry"));
    symlinkSync(nodeRoot, join(stand, "node"));
    if (existsSync(join(from, "libusb"))) symlinkSync(join(from, "libusb"), join(stand, "libusb"));
    binDir = join(stand, "bin");
    envPrefix = `export PATH="${binDir}:$PATH"; `;
  }
  {
    const r = shell("tools-type", blocks["once tools-type"], `${envPrefix}${blocks["once tools-type"]}`);
    check("tools: `type` finds forge, cast, anvil, node and npm in the tools directory's bin and nowhere else", r.status === 0 && TOOL_NAMES.every((t) => r.output.split("\n").includes(`${t} is ${binDir}/${t}`)), r.output);
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
    // The repository, cloned as the document says (read-only from the public GitHub), into the dry run's directory.
    let r = sh("clone", blocks["once clone"], blocks["once clone"].replace("~/postern-dex", join(out, "postern-dex")));
    const reviewed = spawnSync("git", ["-C", join(out, "postern-dex"), "merge-base", "--is-ancestor", "a99f761", "origin/main"], { encoding: "utf8" });
    check("0 the clone succeeds and its main contains the reviewed a99f761", r.status === 0 && reviewed.status === 0, `${r.output.slice(-200)} ${reviewed.stderr}`);
    const commit = shell("clone-commit", blocks["once clone-commit"], blocks["once clone-commit"].replace("~/postern-dex", join(out, "postern-dex")));
    check("0 the clone's commit is printed for comparison with the integrator's", commit.status === 0 && /^[0-9a-f]{7,40} \S/.test(commit.output), commit.output);
    rmSync(join(out, "postern-dex"), { recursive: true, force: true });
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
    const proofFile = join(ROOT, "deployments/fee-address-proof.json");
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
      const diff = [...new Set([...Object.keys(pt), ...Object.keys(blocks)])].filter((k) => pt[k] !== blocks[k]);
      evidence.ptCopy = { blocks: Object.keys(pt).length, differing: diff };
      check(`the Portuguese copy has the same ${Object.keys(blocks).length} marked command blocks, byte for byte`, diff.length === 0, diff.join(", "));
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
  const plan = planChain(shared, chain, loadArtifacts());
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
    if (/^node scripts\/multichain\/(gate|market|first-deposit|frontend-files)\.mjs /.test(c)) c += ` --rpc ${url} --rehearsal`;
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
    if (evidence.feeProofRecorded === true || existsSync(join(ROOT, "deployments/fee-address-proof.json")))
      check(`step 1 on the public chain (read-only): PASS with the recorded fee-address proof`, r.status === 0 && /pre: PASS/.test(r.output), fails.join(" | "));
    else
      check(`step 1 on the public chain (read-only): every check passes except the missing fee-address proof (the owner's signature, section 2.3)`, r.status !== 0 && fails.length === 1 && /proof of control of the fee address/.test(fails[0]), `${r.status}: ${fails.join(" | ") || r.output.slice(-300)}`);
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
    const broadcast = JSON.parse(readFileSync(join(ROOT, "broadcast/DeployMultichain.s.sol", String(chain.chain.chainId), "run-latest.json"), "utf8"));
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
    check(`M4 ${key}-5 before finality: a WAIT line, no PASS`, /WAIT/.test(r.output) && !/post: PASS/.test(r.output), r.output.slice(-400));
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
    check(`${key}-9 post gate with the opening: PASS, the pair open and proven`, r.status === 0 && /post: PASS/.test(r.output) && openReport?.pairs?.every((x) => x.state === "open" && x.opening?.proven === true), r.output.split("\n").filter((l) => /^(FAIL|WAIT)/.test(l)).join(" | "));
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
    const c = spawnSync("node", ["scripts/multichain/cost.mjs", key, "--evidence", join(out, "cost-evidence"), "--out", join(out, "cost-mjs.json")], { cwd: ROOT, encoding: "utf8" });
    writeFileSync(join(out, "cost-mjs.log"), `${c.stdout}${c.stderr}`);
    evidence.costMjs = c.status === 0 ? JSON.parse(readFileSync(join(out, "cost-mjs.json"), "utf8")).total : `failed: ${c.stderr.slice(-200)}`;
    check(`cost: today's price read from the public chain for all five transactions`, evidence.cost && !evidence.cost.error, evidence.cost?.error);
    check(`the deploying account's stated ${funding.deployer} ${symbol} covers today's deployment cost`, evidence.cost && BigInt(evidence.cost.deploymentWei) < deployerFund, evidence.cost?.deployment);
    evidence.deployerCoversGwei = evidence.cost ? Number(formatUnits((deployerFund - BigInt(evidence.cost.deploymentDataFeeWei)) / BigInt(evidence.cost.deploymentGas), 9)) : null;
    evidence.allowanceCoversGwei = evidence.cost ? Number(formatUnits((parseUnits(funding.allowance, 18) - BigInt(evidence.cost.depositDataFeeWei)) / BigInt(evidence.cost.depositGas), 9)) : null;
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
