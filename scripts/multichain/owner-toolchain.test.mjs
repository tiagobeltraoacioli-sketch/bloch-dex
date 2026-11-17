// Tests of the owner's toolchain installer and check (scripts/multichain/owner-toolchain.sh and its pins; review
// finding R369-16). Offline: the script is copied next to a pins file made for stand-in archives built here (small
// shell programs that print the pinned version lines and leave a marker file when they run), so every path of the
// real script runs, including the programs' own start, without any downloaded program being executed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

const SCRIPT = join(ROOT, "scripts/multichain/owner-toolchain.sh");
const PINS = join(ROOT, "scripts/multichain/owner-toolchain.pins");
const HOST = process.arch === "arm64" ? "darwin-arm64" : "darwin-x64";
const mac = process.platform === "darwin";
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const sh = (args, env = {}) => {
  const r = spawnSync("/bin/bash", args, { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME, ...env } });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

// ---------------------------------------------------------------- the committed pins

test("the pins name official https release URLs, 64-hex SHA-256 values, and the same set for both macOS platforms", () => {
  const lines = readFileSync(PINS, "utf8").split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(" "));
  for (const platform of ["darwin-x64", "darwin-arm64"]) {
    const of = (kind) => lines.filter((l) => l[0] === platform && l[1] === kind);
    const archives = of("archive");
    assert.ok(archives.some((l) => l[4] === `https://github.com/foundry-rs/foundry/releases/download/v1.7.1/${l[3]}` && /^foundry_v1\.7\.1_darwin_(amd64|arm64)\.tar\.gz$/.test(l[3])), `${platform}: Foundry v1.7.1 from its GitHub release`);
    assert.ok(archives.some((l) => l[4] === `https://nodejs.org/dist/v24.21.0/${l[3]}` && /^node-v24\.21\.0-darwin-(x64|arm64)\.tar\.gz$/.test(l[3])), `${platform}: Node v24.21.0 from nodejs.org`);
    for (const l of [...archives, ...of("file"), ...of("tree")]) assert.match(l[2], /^[0-9a-f]{64}$/, l.join(" "));
    for (const l of archives) assert.match(l[4], /^https:\/\/(github\.com\/foundry-rs\/foundry\/releases\/download\/v1\.7\.1\/|nodejs\.org\/dist\/v24\.21\.0\/|ghcr\.io\/v2\/homebrew\/core\/libusb\/blobs\/sha256:|binaries\.soliditylang\.org\/macosx-amd64\/)/, l[4]);
    assert.deepEqual(of("file").map((l) => l[3]).filter((n) => !n.startsWith("libusb/")).sort(), ["foundry/anvil", "foundry/cast", "foundry/forge", "node/bin/node", "solc/solc-0.8.24"]);
    assert.deepEqual(of("version").map((l) => `${l[3]} ${l[4]}`).sort(), ["bin/anvil anvil_Version:_1.7.1", "bin/cast cast_Version:_1.7.1", "bin/forge forge_Version:_1.7.1", "bin/node v24.21.0", "bin/npm 11.19.0", "solc/solc-0.8.24 Version:_0.8.24+commit.e11b9ed9.Darwin.appleclang"]);
    // The compiler (review R402-2): the Solidity project's own universal macOS build, one pin for both platforms,
    // archive pin equal to the file pin (it is installed as it is).
    const solc = archives.find((l) => l[3] === "solc-macosx-amd64-v0.8.24+commit.e11b9ed9");
    assert.equal(solc?.[4], "https://binaries.soliditylang.org/macosx-amd64/solc-macosx-amd64-v0.8.24+commit.e11b9ed9");
    assert.equal(solc[2], "cc2d44c706905ccc382f484625dff61d741e0c24232d226f139a6835fc644f3f");
    assert.equal(of("file").find((l) => l[3] === "solc/solc-0.8.24")[2], solc[2]);
    assert.equal(of("tree").length, 1);
  }
  // The Homebrew bottle's blob address is its own SHA-256: the URL and the pin cannot disagree.
  for (const l of lines.filter((x) => x[1] === "archive" && x[4].startsWith("https://ghcr.io/"))) assert.ok(l[4].endsWith(`sha256:${l[2]}`), l[4]);
  // Intel: Foundry loads libusb, so its library is pinned by name too. Apple silicon: no libusb at all.
  assert.ok(lines.some((l) => l[0] === "darwin-x64" && l[1] === "file" && l[3] === "libusb/lib/libusb-1.0.0.dylib"));
  assert.ok(!lines.some((l) => l[0] === "darwin-arm64" && /libusb/.test(l.join(" "))));
});

test("the script runs only macOS's own programs by absolute path, and nothing from the tools directory before the hashes pass", () => {
  const text = readFileSync(SCRIPT, "utf8");
  assert.match(text, /^PATH=\/usr\/bin:\/bin:\/usr\/sbin:\/sbin$/m);
  // In `check`, run_tools is reached only when check_tree reported no failure.
  assert.match(text, /check_tree 0 \|\| bad=1\n {2}if \[ "\$bad" = 0 \] && \[ "\$RUN" = 1 \]; then run_tools \|\| bad=1; fi/);
  assert.match(text, /check_tree 1 \|\| bad=1\nif \[ "\$bad" = 0 \] && \[ "\$RUN" = 1 \]; then run_tools \|\| bad=1; fi/);
  // The only place a program of the directory is started is run_tools.
  assert.equal(text.split("\n").filter((l) => /"\$ROOT\/\$name" --version/.test(l)).length, 1);
  assert.equal(text.split("\n").filter((l) => /"\$ROOT\/bin\/forge" config --json/.test(l)).length, 1);
  assert.equal(text.split("\n").filter((l) => /"\$ROOT\/[^"]*" /.test(l) && !/^\s*(#|\/bin\/|\/usr\/bin\/|\[|launcher|printf|echo|out=\$\(\/usr|actual=|owner=|mode=|if \[|fail)/.test(l) && !/--version|config --json/.test(l)).length, 0, "no other line starts a program of the directory");
  // The owner rule (R402-8: it cannot be exercised without root when hard links to root's files are refused): the
  // comparisons are pinned here, and the user id comes from macOS's id with no override.
  assert.match(text, /^ME=\$\(\/usr\/bin\/id -u\) \|\| exit 1$/m);
  assert.match(text, /\[ "\$owner" = "\$ME" \] \|\| fail "\$ROOT is owned by user id \$owner, not by you/);
  assert.match(text, /out=\$\(\/usr\/bin\/find "\$ROOT" ! -user "\$ME" -print 2>&1 \| \/usr\/bin\/head -5\)\n {2}\[ -z "\$out" \] \|\| fail "not owned by you: \$out"/);
  assert.match(text, /\[ "\$owner" = "\$ME" \] \|\| \[ "\$owner" = 0 \] \|\| fail "the directory \$dir above the tools is owned by user id \$owner/);
  assert.ok(!/\beval\b/.test(text) && !/curl[^\n]*(-k|--insecure)\b/.test(text));
  assert.ok(text.split("\n").filter((l) => /\/usr\/bin\/curl /.test(l)).every((l) => l.includes("-q --proto '=https' --proto-redir '=https' --tlsv1.2 --fail")));
});

// ---------------------------------------------------------------- a stand-in toolchain, through the real script

/** A directory with the script, stand-in archives and a pins file for them. */
function rig() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "owner-toolchain-")));
  const kit = join(base, "kit");
  const src = join(base, "src");
  const archives = join(base, "archives");
  for (const d of [kit, join(kit, "repo/scripts/multichain"), src, archives, join(src, "foundry"), join(src, "node-v0/bin"), join(src, "node-v0/lib/node_modules/npm/bin"), join(src, "libusb/9.9/lib")]) mkdirSync(d, { recursive: true });
  // The script sits where it does in the repository (it asks forge for its configuration two directories up).
  const scriptDir = join(kit, "repo/scripts/multichain");
  copyFileSync(SCRIPT, join(scriptDir, "owner-toolchain.sh"));
  const marker = join(base, "ran");
  // The stand-in forge answers `config --json` with the compiler and offline setting its launcher gave it (or, when
  // the file other-solc exists, with that file's text: a forge that would run another compiler).
  writeFileSync(join(src, "foundry", "forge"), `#!/bin/sh\necho forge >> ${marker}\nif [ "$1" = config ]; then s="$FOUNDRY_SOLC"; [ -f ${base}/other-solc ] && s=$(/bin/cat ${base}/other-solc); printf '{\\n  "solc": "%s",\\n  "offline": %s,\\n}\\n' "$s" "$FOUNDRY_OFFLINE"; exit 0; fi\necho "forge Version: 1.7.1"\necho "SEEN profile=$FOUNDRY_PROFILE rpc=$ETH_RPC_URL proxy=$HTTPS_PROXY solc=$FOUNDRY_SOLC offline=$FOUNDRY_OFFLINE"\n`, { mode: 0o755 });
  for (const t of ["cast", "anvil"]) writeFileSync(join(src, "foundry", t), `#!/bin/sh\necho ${t} >> ${marker}\necho "${t} Version: 1.7.1"\necho "SEEN rpc=$ETH_RPC_URL from=$ETH_FROM"\n`, { mode: 0o755 });
  writeFileSync(join(archives, "solc-standin"), `#!/bin/sh\necho solc >> ${marker}\necho "solc, a stand-in"\necho "Version: 0.8.24+commit.e11b9ed9.Darwin.appleclang"\n`);
  writeFileSync(join(src, "foundry", "chisel"), "#!/bin/sh\necho not-installed\n", { mode: 0o755 });
  writeFileSync(join(src, "node-v0/bin/node"), `#!/bin/sh\necho node >> ${marker}\ncase "$1" in *npm-cli.js) echo 11.19.0 ;; *) echo v24.21.0 ;; esac\necho "SEEN options=$NODE_OPTIONS tls=$NODE_TLS_REJECT_UNAUTHORIZED ca=$NODE_EXTRA_CA_CERTS cache=$NODE_COMPILE_CACHE registry=$npm_config_registry"\n`, { mode: 0o755 });
  writeFileSync(join(src, "node-v0/lib/node_modules/npm/bin/npm-cli.js"), "// stand-in\n");
  symlinkSync("../lib/node_modules/npm/bin/npm-cli.js", join(src, "node-v0/bin/npm"));
  writeFileSync(join(src, "libusb/9.9/lib/libusb-1.0.0.dylib"), "stand-in library\n");
  const tar = (name, cwd, members) => assert.equal(spawnSync("/usr/bin/tar", ["-czf", join(archives, name), "-C", cwd, ...members]).status, 0);
  tar("foundry_standin.tar.gz", join(src, "foundry"), ["forge", "cast", "anvil", "chisel"]);
  tar("node-standin.tar.gz", src, ["node-v0"]);
  tar("libusb-standin.tar.gz", src, ["libusb"]);
  const pins = (tree, edit = (l) => l) =>
    writeFileSync(
      join(scriptDir, "owner-toolchain.pins"),
      [
        `${HOST} archive ${sha(join(archives, "foundry_standin.tar.gz"))} foundry_standin.tar.gz https://example.invalid/foundry_standin.tar.gz`,
        `${HOST} archive ${sha(join(archives, "node-standin.tar.gz"))} node-standin.tar.gz https://example.invalid/node-standin.tar.gz`,
        `${HOST} archive ${sha(join(archives, "libusb-standin.tar.gz"))} libusb-standin.tar.gz https://example.invalid/libusb-standin.tar.gz`,
        `${HOST} archive ${sha(join(archives, "solc-standin"))} solc-standin https://example.invalid/solc-standin`,
        `${HOST} file ${sha(join(archives, "solc-standin"))} solc/solc-0.8.24`,
        `${HOST} member - libusb/9.9/lib/libusb-1.0.0.dylib`,
        ...["forge", "cast", "anvil"].map((t) => `${HOST} file ${sha(join(src, "foundry", t))} foundry/${t}`),
        `${HOST} file ${sha(join(src, "node-v0/bin/node"))} node/bin/node`,
        `${HOST} file ${sha(join(src, "libusb/9.9/lib/libusb-1.0.0.dylib"))} libusb/lib/libusb-1.0.0.dylib`,
        `${HOST} tree ${tree} .`,
        ...["forge", "cast", "anvil"].map((t) => `${HOST} version - bin/${t} ${t}_Version:_1.7.1`),
        `${HOST} version - bin/node v24.21.0`,
        `${HOST} version - bin/npm 11.19.0`,
        `${HOST} version - solc/solc-0.8.24 Version:_0.8.24+commit.e11b9ed9.Darwin.appleclang`,
      ]
        .map(edit)
        .join("\n") + "\n",
    );
  const script = join(scriptDir, "owner-toolchain.sh");
  const tools = join(base, "tools");
  // The directory digest is learned from a first install that must refuse (an unknown digest is never accepted).
  pins("0".repeat(64));
  const first = sh([script, "install", tools, "--from", archives]);
  assert.equal(first.status, 1, first.out);
  assert.ok(!existsSync(tools), "a refused install leaves no directory");
  assert.ok(!existsSync(marker), "nothing of the directory was run before its digest matched");
  const tree = first.out.match(/the directory as a whole has digest ([0-9a-f]{64}); pinned 0{64}/)?.[1];
  assert.ok(tree, first.out);
  pins(tree);
  const withPath = { PATH: `${tools}/bin:/usr/bin:/bin:/usr/sbin:/sbin` };
  return { base, kit, src, archives, script, tools, marker, tree, pins, withPath, install: (extra = []) => sh([script, "install", tools, "--from", archives, ...extra]), check: (env = withPath, extra = []) => sh([script, "check", tools, ...extra], env) };
}

test("install builds an owner-only directory from verified archives; the check passes only with the PATH set, and runs every program through its launcher", { skip: !mac }, () => {
  const r = rig();
  try {
    const i = r.install();
    assert.equal(i.status, 0, i.out);
    assert.match(i.out, /owner tools: installed and verified in /);
    assert.ok(!/^owner tools: PASS$/m.test(i.out), "install alone never prints the check's PASS line");
    assert.equal(statSync(r.tools).mode & 0o777, 0o700);
    assert.equal(statSync(join(r.tools, "foundry/forge")).mode & 0o077, 0);
    assert.ok(!existsSync(join(r.tools, "foundry/chisel")) && !existsSync(join(r.tools, ".incoming")), "only the three named Foundry programs; no leftovers");
    assert.equal(readFileSync(r.marker, "utf8").trim().split("\n").sort().join(","), "anvil,cast,forge,forge,node,node,solc");

    // Without the guide's PATH line: refused, and nothing is run.
    rmSync(r.marker);
    const noPath = r.check({});
    assert.equal(noPath.status, 1, noPath.out);
    assert.match(noPath.out, /FAIL this terminal's PATH finds forge at 'nowhere'/);
    assert.match(noPath.out, /FAIL this terminal's PATH starts with '\/usr\/bin', not with /);
    assert.ok(!existsSync(r.marker));

    const ok = r.check();
    assert.equal(ok.status, 0, ok.out);
    assert.equal(ok.out.trim().split("\n").at(-1), "owner tools: PASS");
    assert.equal(readFileSync(r.marker, "utf8").trim().split("\n").sort().join(","), "anvil,cast,forge,forge,node,node,solc");

    // The launchers. forge is told the compiler inside the directory and offline (R402-2); every launcher drops the
    // variables that redirect or reconfigure a program (R402-6) and keeps the others (MC_* is what deploy.sh passes).
    // (The stand-ins are /bin/sh scripts, so macOS drops DYLD_* before they could print it: the library path is
    // asserted on the launcher's text; the real forge under these launchers is the dry run's.)
    const scrub = `for v in $(/usr/bin/env | /usr/bin/sed -nE 's/^((NODE|NPM|npm|FOUNDRY|DAPP|ETH|SSL_CERT|GIT_CONFIG)_[A-Za-z0-9_]*|[A-Za-z_]*_(PROXY|proxy)|OPENSSL_CONF|SSLKEYLOGFILE|GIT_EXEC_PATH|GIT_SSH|GIT_SSH_COMMAND|GIT_DIR|GIT_WORK_TREE|BASH_ENV|ENV|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|PERL5LIB|PERL5OPT)=.*/\\1/p'); do unset "$v"; done`;
    const head = `#!/bin/sh\nd=$(cd "\${0%/*}/.." && pwd -P) || exit 1\n${scrub}\n`;
    assert.equal(readFileSync(join(r.tools, "bin/forge"), "utf8"), `${head}FOUNDRY_SOLC="$d/solc/solc-0.8.24" FOUNDRY_OFFLINE=true DYLD_LIBRARY_PATH="$d/libusb/lib" exec "$d/foundry/forge" "$@"\n`);
    for (const t of ["cast", "anvil"]) assert.equal(readFileSync(join(r.tools, "bin", t), "utf8"), `${head}DYLD_LIBRARY_PATH="$d/libusb/lib" exec "$d/foundry/${t}" "$@"\n`);
    assert.equal(readFileSync(join(r.tools, "bin/node"), "utf8"), `${head}exec "$d/node/bin/node" "$@"\n`);
    const hostile = { FOUNDRY_PROFILE: "evil", FOUNDRY_SOLC: "/elsewhere/solc", FOUNDRY_OFFLINE: "false", ETH_RPC_URL: "https://elsewhere.invalid", ETH_FROM: "0x01", HTTPS_PROXY: "http://elsewhere.invalid:1", NODE_OPTIONS: "--require /elsewhere/x.js", NODE_TLS_REJECT_UNAUTHORIZED: "0", NODE_EXTRA_CA_CERTS: "/elsewhere/ca.pem", NODE_COMPILE_CACHE: "/elsewhere/cache", npm_config_registry: "https://elsewhere.invalid" };
    const started = (t) => spawnSync(t, ["--version"], { encoding: "utf8", env: { ...r.withPath, ...hostile } }).stdout;
    assert.equal(started("forge"), `forge Version: 1.7.1\nSEEN profile= rpc= proxy= solc=${r.tools}/solc/solc-0.8.24 offline=true\n`, "started by name through PATH, the launcher finds its directory and names the compiler");
    assert.equal(started("cast"), "cast Version: 1.7.1\nSEEN rpc= from=\n");
    assert.equal(started("node"), "v24.21.0\nSEEN options= tls= ca= cache= registry=\n");
    assert.equal(started("npm"), "11.19.0\nSEEN options= tls= ca= cache= registry=\n");

    // R402-1: any other PATH entry is refused, before or after the tools, and so is the terminal's own PATH kept
    // behind them (the form of the guide before this fix); a helper found outside macOS's directories is named.
    mkdirSync(join(r.base, "other"));
    writeFileSync(join(r.base, "other/forge"), "#!/bin/sh\necho other\n", { mode: 0o755 });
    writeFileSync(join(r.base, "other/git"), "#!/bin/sh\necho other-git >> " + r.marker + "\n", { mode: 0o755 });
    rmSync(r.marker);
    const shadow = r.check({ PATH: `${r.base}/other:${r.tools}/bin:/usr/bin:/bin:/usr/sbin:/sbin` });
    assert.equal(shadow.status, 1);
    assert.match(shadow.out, new RegExp(`PATH starts with '${r.base}/other'`));
    assert.match(shadow.out, new RegExp(`PATH finds forge at '${r.base}/other/forge'`));
    assert.match(shadow.out, new RegExp(`PATH finds the helper git at '${r.base}/other/git', not in macOS's own`));
    const behind = r.check({ PATH: `${r.tools}/bin:${r.base}/other:/usr/bin:/bin:/usr/sbin:/sbin` });
    assert.equal(behind.status, 1);
    assert.match(behind.out, new RegExp(`PATH has the entry '${r.base}/other': only ${r.tools}/bin and /usr/bin /bin /usr/sbin /sbin may be in it`));
    const tail = r.check({ PATH: `${r.tools}/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin` });
    assert.equal(tail.status, 1);
    assert.match(tail.out, /PATH has the entry '\/usr\/local\/bin'/);
    const empty = r.check({ PATH: `${r.tools}/bin::/usr/bin:/bin:/usr/sbin:/sbin` });
    assert.equal(empty.status, 1);
    assert.match(empty.out, /PATH has the entry ''/);
    for (const c of [shadow, behind, tail, empty]) assert.ok(!/owner tools: (PASS|HASHES PASS)/.test(c.out));
    assert.ok(!existsSync(r.marker), "nothing was run, neither of the directory nor of the other one");

    // R402-6: each refused variable, by name, and nothing run.
    for (const [name, value] of Object.entries({ ...hostile, DAPP_SOLC: "x", SSL_CERT_FILE: "/x", OPENSSL_CONF: "/x", SSLKEYLOGFILE: "/x", all_proxy: "x", GIT_SSH_COMMAND: "x", GIT_EXEC_PATH: "/x", GIT_CONFIG_GLOBAL: "/x", PYTHONPATH: "/x", PERL5OPT: "-Mx", NPM_CONFIG_REGISTRY: "x" })) {
      const c = r.check({ ...r.withPath, [name]: value });
      assert.equal(c.status, 1, name);
      assert.match(c.out, new RegExp(`FAIL these variables are set in this terminal and must not be \\(open a new terminal, or unset them\\): ${name} $`, "m"), name);
      assert.ok(!/owner tools: (PASS|HASHES PASS)/.test(c.out) && !existsSync(r.marker), name);
    }
    // Variables the kit itself uses are not refused.
    assert.equal(r.check({ ...r.withPath, MC_RPC_URL: "https://example.invalid", DEX_DEPLOYER_KEYSTORE_DIR: "/x", GIT_EDITOR: "true", TERM: "xterm" }).status, 0);
    rmSync(r.marker);

    // R402-2: a forge that would run another compiler, or is not offline, is refused (after the hashes: it runs).
    writeFileSync(join(r.base, "other-solc"), "0.8.24");
    const other = r.check();
    assert.equal(other.status, 1);
    assert.match(other.out, new RegExp(`FAIL forge would not compile with ${r.tools}/solc/solc-0\\.8\\.24: forge config says:   "solc": "0\\.8\\.24",`));
    assert.ok(!/owner tools: PASS/.test(other.out));
    rmSync(join(r.base, "other-solc"));

    // --no-run (rehearsals): never the owner's PASS line.
    const noRun = r.check(r.withPath, ["--no-run"]);
    assert.equal(noRun.status, 0);
    assert.ok(!/owner tools: PASS/.test(noRun.out) && /HASHES PASS, programs not run/.test(noRun.out), noRun.out);
  } finally {
    rmSync(r.base, { recursive: true, force: true });
  }
});

test("the check refuses a changed program, an added or removed file, group or other access, a link, and a wrong version, and runs nothing when a hash or permission fails", { skip: !mac }, () => {
  const r = rig();
  try {
    assert.equal(r.install().status, 0);
    rmSync(r.marker);
    const refused = (what, pattern) => {
      const c = r.check();
      assert.equal(c.status, 1, `${what}: ${c.out}`);
      assert.match(c.out, pattern, what);
      assert.ok(!/owner tools: (PASS|HASHES PASS)/.test(c.out), what);
      assert.equal(c.out.trim().split("\n").at(-1), "owner tools: FAIL; do not use these tools with any key", what);
      assert.ok(!existsSync(r.marker), `${what}: a program of the directory was run`);
    };
    const restore = (file, body, mode) => (writeFileSync(file, body), chmodSync(file, mode));

    // One byte added to cast (the program that signs): named, and the directory digest differs too.
    const cast = join(r.tools, "foundry/cast");
    const castBody = readFileSync(cast);
    appendFileSync(cast, "\n");
    refused("cast changed", /FAIL foundry\/cast has SHA-256 [0-9a-f]{64}; pinned [0-9a-f]{64}/);
    restore(cast, castBody, 0o700);
    // node changed.
    const node = join(r.tools, "node/bin/node");
    const nodeBody = readFileSync(node);
    appendFileSync(node, "\n");
    refused("node changed", /FAIL node\/bin\/node has SHA-256/);
    restore(node, nodeBody, 0o700);
    // The library loaded into forge and cast changed.
    const lib = join(r.tools, "libusb/lib/libusb-1.0.0.dylib");
    const libBody = readFileSync(lib);
    appendFileSync(lib, "x");
    refused("libusb changed", /FAIL libusb\/lib\/libusb-1\.0\.0\.dylib has SHA-256/);
    restore(lib, libBody, 0o600);
    // The compiler changed (R402-2).
    const solc = join(r.tools, "solc/solc-0.8.24");
    const solcBody = readFileSync(solc);
    appendFileSync(solc, "\n");
    refused("solc changed", /FAIL solc\/solc-0\.8\.24 has SHA-256/);
    restore(solc, solcBody, 0o700);
    // A launcher changed (not pinned by name: caught by the directory digest).
    const launcher = join(r.tools, "bin/cast");
    const launcherBody = readFileSync(launcher);
    writeFileSync(launcher, "#!/bin/sh\nexec /elsewhere/cast \"$@\"\n");
    refused("launcher changed", /FAIL the directory as a whole has digest/);
    restore(launcher, launcherBody, 0o700);
    // A file of npm changed; a file added; a file made executable; a link added.
    const npm = join(r.tools, "node/lib/node_modules/npm/bin/npm-cli.js");
    appendFileSync(npm, "// more\n");
    refused("npm changed", /FAIL the directory as a whole has digest/);
    restore(npm, "// stand-in\n", 0o600);
    writeFileSync(join(r.tools, "node/extra.js"), "x");
    refused("file added", /FAIL the directory as a whole has digest/);
    rmSync(join(r.tools, "node/extra.js"));
    chmodSync(npm, 0o700);
    refused("executable bit added", /FAIL the directory as a whole has digest/);
    chmodSync(npm, 0o600);
    symlinkSync("/usr/bin/true", join(r.tools, "bin/git"));
    refused("link added", /FAIL the directory as a whole has digest/);
    rmSync(join(r.tools, "bin/git"));
    // A program replaced by a link to an identical file elsewhere: refused by name.
    copyFileSync(cast, join(r.base, "cast-copy"));
    rmSync(cast);
    symlinkSync(join(r.base, "cast-copy"), cast);
    refused("program is a link", /FAIL foundry\/cast is missing \(or is a link\)/);
    rmSync(cast);
    restore(cast, castBody, 0o700);

    // Access: the directory open to the group; a file writable by others; a directory above writable by others.
    chmodSync(r.tools, 0o750);
    refused("directory readable by group", /has access mode 750; it must be 700/);
    chmodSync(r.tools, 0o700);
    chmodSync(cast, 0o702);
    refused("file writable by others", /FAIL writable by group or others: .*foundry\/cast/);
    chmodSync(cast, 0o700);
    chmodSync(join(r.tools, "foundry"), 0o770);
    refused("inner directory writable by group", /FAIL writable by group or others: .*foundry/);
    chmodSync(join(r.tools, "foundry"), 0o700);
    chmodSync(r.base, 0o777);
    refused("directory above writable by others", /above the tools is writable by group or others \(mode 777\)/);
    chmodSync(r.base, 0o700);
    // An access-control list that allows others what the mode bits deny (R402-7): on a program, on the directory,
    // on a directory above. (Only the owner can set one; the mode stays 700.)
    const acl = (args) => assert.equal(spawnSync("/bin/chmod", args).status, 0, args.join(" "));
    acl(["+a", "everyone allow write,append,delete", cast]);
    assert.equal(statSync(cast).mode & 0o777, 0o700);
    refused("ACL on cast", /FAIL carries an access-control list \(remove it with chmod -N, or install again\): .*foundry\/cast/);
    acl(["-N", cast]);
    acl(["+a", "everyone allow add_file,delete_child", r.tools]);
    refused("ACL on the directory", /FAIL carries an access-control list/);
    acl(["-N", r.tools]);
    acl(["+a", "everyone allow add_file,delete_child", r.base]);
    refused("ACL on a directory above", /above the tools has an access-control list that allows: .*everyone allow/);
    acl(["-N", r.base]);
    // A file owned by another user inside the directory (R402-8). Without root the only way to have one is a hard
    // link to a file of root's; where macOS refuses that link, the rule stays pinned by the text test above.
    const foreign = spawnSync("/bin/ln", ["/private/etc/hosts", join(r.tools, "node/hosts")]);
    if (foreign.status === 0) {
      refused("a file owned by root inside", /FAIL not owned by you: .*node\/hosts/);
      rmSync(join(r.tools, "node/hosts"));
    }
    // Reached through a link.
    symlinkSync(r.tools, join(r.base, "tools-link"));
    const viaLink = sh([r.script, "check", join(r.base, "tools-link")], { PATH: `${r.base}/tools-link/bin:/usr/bin:/bin:/usr/sbin:/sbin` });
    assert.equal(viaLink.status, 1);
    assert.match(viaLink.out, /is not a directory \(or is a link\)/);
    assert.ok(!existsSync(r.marker));

    // Everything restored: PASS again (the refusals above were caused by the changes, nothing else).
    const ok = r.check();
    assert.equal(ok.status, 0, ok.out);
    assert.equal(ok.out.trim().split("\n").at(-1), "owner tools: PASS");

    // Hashes right but a program reports another version: refused (after the hashes, so this one does run).
    r.pins(r.tree, (l) => l.replace("cast_Version:_1.7.1", "cast_Version:_1.7.2"));
    const version = r.check();
    assert.equal(version.status, 1);
    assert.match(version.out, /bin\/cast --version does not print the line 'cast Version: 1\.7\.2' \(it starts: cast Version: 1\.7\.1\)/);
    assert.ok(!/owner tools: PASS/.test(version.out));
  } finally {
    chmodSync(r.base, 0o700);
    rmSync(r.base, { recursive: true, force: true });
  }
});

test("install refuses an existing directory, an archive whose SHA-256 differs (before unpacking), a non-https pin, and a missing platform", { skip: !mac }, () => {
  const r = rig();
  try {
    // An existing directory is never reused or touched.
    mkdirSync(r.tools);
    writeFileSync(join(r.tools, "keep"), "x");
    const exists = r.install();
    assert.equal(exists.status, 1);
    assert.match(exists.out, /already exists: the tools go into a NEW directory/);
    assert.equal(readFileSync(join(r.tools, "keep"), "utf8"), "x");
    rmSync(r.tools, { recursive: true });

    // A changed archive: refused by hash, nothing unpacked, nothing run, directory removed.
    const archive = join(r.archives, "foundry_standin.tar.gz");
    const body = readFileSync(archive);
    appendFileSync(archive, "x");
    const changed = r.install();
    assert.equal(changed.status, 1);
    assert.match(changed.out, /FAIL foundry_standin\.tar\.gz has SHA-256 [0-9a-f]{64}; pinned [0-9a-f]{64} \(not unpacked\)/);
    assert.ok(!existsSync(r.tools) && !existsSync(r.marker));
    writeFileSync(archive, body);

    // The download path refuses anything but https before fetching (the stand-in host does not exist: with https it
    // fails at the fetch, also leaving nothing).
    r.pins(r.tree, (l) => l.replace("https://example.invalid/node-standin.tar.gz", "http://example.invalid/node-standin.tar.gz"));
    const http = sh([r.script, "install", r.tools]);
    assert.equal(http.status, 1);
    assert.match(http.out, /the pinned URL of node-standin\.tar\.gz is not https/);
    assert.ok(!existsSync(r.tools));

    // Pins for another platform only: refused.
    r.pins(r.tree, (l) => l.replace(HOST, "darwin-other"));
    const none = r.install();
    assert.equal(none.status, 1);
    assert.match(none.out, new RegExp(`no pins for the platform ${HOST}`));

    // A relative directory, a missing pins file.
    r.pins(r.tree);
    assert.match(sh([r.script, "check", "tools"]).out, /give the tools directory as an absolute path/);
    rmSync(join(r.kit, "repo/scripts/multichain/owner-toolchain.pins"));
    const noPins = r.check();
    assert.equal(noPins.status, 1);
    assert.match(noPins.out, /the pins file .* is missing/);
  } finally {
    rmSync(r.base, { recursive: true, force: true });
  }
});
