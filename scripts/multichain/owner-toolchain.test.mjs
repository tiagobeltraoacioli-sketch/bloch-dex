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
    for (const l of archives) assert.match(l[4], /^https:\/\/(github\.com\/foundry-rs\/foundry\/releases\/download\/v1\.7\.1\/|nodejs\.org\/dist\/v24\.21\.0\/|ghcr\.io\/v2\/homebrew\/core\/libusb\/blobs\/sha256:)/, l[4]);
    assert.deepEqual(of("file").map((l) => l[3]).filter((n) => !n.startsWith("libusb/")).sort(), ["foundry/anvil", "foundry/cast", "foundry/forge", "node/bin/node"]);
    assert.deepEqual(of("version").map((l) => `${l[3]} ${l[4]}`).sort(), ["anvil anvil_Version:_1.7.1", "cast cast_Version:_1.7.1", "forge forge_Version:_1.7.1", "node v24.21.0", "npm 11.19.0"]);
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
  assert.equal(text.split("\n").filter((l) => /"\$ROOT\/bin\/\$name" --version/.test(l)).length, 1);
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
  for (const d of [kit, src, archives, join(src, "foundry"), join(src, "node-v0/bin"), join(src, "node-v0/lib/node_modules/npm/bin"), join(src, "libusb/9.9/lib")]) mkdirSync(d, { recursive: true });
  copyFileSync(SCRIPT, join(kit, "owner-toolchain.sh"));
  const marker = join(base, "ran");
  for (const t of ["forge", "cast", "anvil"]) writeFileSync(join(src, "foundry", t), `#!/bin/sh\necho ${t} >> ${marker}\necho "${t} Version: 1.7.1"\necho "DYLD=$DYLD_LIBRARY_PATH"\n`, { mode: 0o755 });
  writeFileSync(join(src, "foundry", "chisel"), "#!/bin/sh\necho not-installed\n", { mode: 0o755 });
  writeFileSync(join(src, "node-v0/bin/node"), `#!/bin/sh\necho node >> ${marker}\ncase "$1" in *npm-cli.js) echo 11.19.0 ;; *) echo v24.21.0 ;; esac\necho "NODE_OPTIONS=$NODE_OPTIONS"\n`, { mode: 0o755 });
  writeFileSync(join(src, "node-v0/lib/node_modules/npm/bin/npm-cli.js"), "// stand-in\n");
  symlinkSync("../lib/node_modules/npm/bin/npm-cli.js", join(src, "node-v0/bin/npm"));
  writeFileSync(join(src, "libusb/9.9/lib/libusb-1.0.0.dylib"), "stand-in library\n");
  const tar = (name, cwd, members) => assert.equal(spawnSync("/usr/bin/tar", ["-czf", join(archives, name), "-C", cwd, ...members]).status, 0);
  tar("foundry_standin.tar.gz", join(src, "foundry"), ["forge", "cast", "anvil", "chisel"]);
  tar("node-standin.tar.gz", src, ["node-v0"]);
  tar("libusb-standin.tar.gz", src, ["libusb"]);
  const pins = (tree, edit = (l) => l) =>
    writeFileSync(
      join(kit, "owner-toolchain.pins"),
      [
        `${HOST} archive ${sha(join(archives, "foundry_standin.tar.gz"))} foundry_standin.tar.gz https://example.invalid/foundry_standin.tar.gz`,
        `${HOST} archive ${sha(join(archives, "node-standin.tar.gz"))} node-standin.tar.gz https://example.invalid/node-standin.tar.gz`,
        `${HOST} archive ${sha(join(archives, "libusb-standin.tar.gz"))} libusb-standin.tar.gz https://example.invalid/libusb-standin.tar.gz`,
        `${HOST} member - libusb/9.9/lib/libusb-1.0.0.dylib`,
        ...["forge", "cast", "anvil"].map((t) => `${HOST} file ${sha(join(src, "foundry", t))} foundry/${t}`),
        `${HOST} file ${sha(join(src, "node-v0/bin/node"))} node/bin/node`,
        `${HOST} file ${sha(join(src, "libusb/9.9/lib/libusb-1.0.0.dylib"))} libusb/lib/libusb-1.0.0.dylib`,
        `${HOST} tree ${tree} .`,
        ...["forge", "cast", "anvil"].map((t) => `${HOST} version - ${t} ${t}_Version:_1.7.1`),
        `${HOST} version - node v24.21.0`,
        `${HOST} version - npm 11.19.0`,
      ]
        .map(edit)
        .join("\n") + "\n",
    );
  const script = join(kit, "owner-toolchain.sh");
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
  const withPath = { PATH: `${tools}/bin:/usr/bin:/bin` };
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
    assert.equal(readFileSync(r.marker, "utf8").trim().split("\n").sort().join(","), "anvil,cast,forge,node,node");

    // Without the guide's PATH line: refused, and nothing is run.
    rmSync(r.marker);
    const noPath = r.check({});
    assert.equal(noPath.status, 1, noPath.out);
    assert.match(noPath.out, /FAIL this terminal's PATH finds forge at 'nowhere'/);
    assert.ok(!existsSync(r.marker));

    const ok = r.check();
    assert.equal(ok.status, 0, ok.out);
    assert.equal(ok.out.trim().split("\n").at(-1), "owner tools: PASS");
    assert.equal(readFileSync(r.marker, "utf8").trim().split("\n").sort().join(","), "anvil,cast,forge,node,node");

    // The launchers: a script's own start (here /bin/sh) carries exactly the directory's library path, and node's
    // launcher drops NODE_OPTIONS / NODE_PATH of the terminal.
    // (The stand-in forge is itself a /bin/sh script, so macOS drops the variable again before it could print it:
    // the library path is asserted on the launcher's text; the real forge under these launchers is the dry run's.)
    for (const t of ["forge", "cast", "anvil"]) assert.equal(readFileSync(join(r.tools, "bin", t), "utf8"), `#!/bin/sh\nd=$(cd "\${0%/*}/.." && pwd -P) || exit 1\nDYLD_LIBRARY_PATH="$d/libusb/lib" exec "$d/foundry/${t}" "$@"\n`);
    const forge = spawnSync("forge", ["--version"], { encoding: "utf8", env: { PATH: `${r.tools}/bin:/usr/bin:/bin` } });
    assert.match(forge.stdout, /^forge Version: 1\.7\.1\n/, "the launcher finds its program from its own location, started by name through PATH");
    const node = spawnSync(join(r.tools, "bin/node"), ["--version"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", NODE_OPTIONS: "--require /elsewhere/x.js" } });
    assert.match(node.stdout, /NODE_OPTIONS=\n/);

    // Another forge earlier in PATH: refused.
    mkdirSync(join(r.base, "other"));
    writeFileSync(join(r.base, "other/forge"), "#!/bin/sh\necho other\n", { mode: 0o755 });
    const shadow = r.check({ PATH: `${r.base}/other:${r.tools}/bin:/usr/bin:/bin` });
    assert.equal(shadow.status, 1);
    assert.match(shadow.out, new RegExp(`PATH finds forge at '${r.base}/other/forge'`));

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
    // Reached through a link.
    symlinkSync(r.tools, join(r.base, "tools-link"));
    const viaLink = sh([r.script, "check", join(r.base, "tools-link")], { PATH: `${r.base}/tools-link/bin:/usr/bin:/bin` });
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
    assert.match(version.out, /bin\/cast --version starts with 'cast Version: 1\.7\.1', not 'cast Version: 1\.7\.2'/);
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
    rmSync(join(r.kit, "owner-toolchain.pins"));
    const noPins = r.check();
    assert.equal(noPins.status, 1);
    assert.match(noPins.out, /the pins file .* is missing/);
  } finally {
    rmSync(r.base, { recursive: true, force: true });
  }
});
