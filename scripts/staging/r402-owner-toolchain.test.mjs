// Review demonstrations of agent 402 (round 19) against the owner toolchain of 401 (`0dd50c5`).
//
// Each test asserts the behaviour AS IT IS at `0dd50c5` and names the finding it demonstrates; when a finding is
// fixed its test must be restated to assert the refusal (do not delete it).
//
//   node --test scripts/staging/r402-owner-toolchain.test.mjs
//   R402_TOOLS=<a directory made by `owner-toolchain.sh install`> node --test scripts/staging/r402-owner-toolchain.test.mjs
//
// The tests marked "needs R402_TOOLS" start the installed programs; without the variable they are skipped.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = join(ROOT, "scripts/multichain/owner-toolchain.sh");
const guide = readFileSync(join(ROOT, "docs/OWNER-DEPLOY-NOW.md"), "utf8");
const script = readFileSync(SCRIPT, "utf8");
const pins = readFileSync(join(ROOT, "scripts/multichain/owner-toolchain.pins"), "utf8");
const TOOLS = process.env.R402_TOOLS ? resolve(process.env.R402_TOOLS) : null;
const SYSTEM = "/usr/bin:/bin:/usr/sbin:/sbin";
const block = (name) => guide.match(new RegExp(`<!-- run: ${name} -->\\n\`\`\`\\n([\\s\\S]*?)\\n\`\`\``))?.[1];

test("R402-1 (static): the PATH line keeps the terminal's PATH, the check looks at five names only, deploy.sh starts through env", () => {
  assert.equal(block("once env-path"), 'export PATH="$HOME/dex-owner-tools/bin:$PATH"');
  assert.match(script, /^TOOLS="forge cast anvil node npm"$/m);
  // No rule on the other PATH entries anywhere in the check: the caller's PATH is saved once and used once, to
  // look the five names up.
  assert.deepEqual(script.split("\n").filter((l) => l.includes("CALLER_PATH")).map((l) => l.trim()), ['CALLER_PATH="${PATH:-}"', 'found=$(PATH="$CALLER_PATH" type -P "$t" || true)']);
  assert.equal(readFileSync(join(ROOT, "scripts/multichain/deploy.sh"), "utf8").split("\n")[0], "#!/usr/bin/env bash");
});

test("R402-1 (needs R402_TOOLS): with a user-writable directory before /usr/bin, the check prints PASS and a planted bash, git, mkdir and pgrep run", { skip: !TOOLS }, () => {
  const dir = mkdtempSync(join(tmpdir(), "r402-"));
  try {
    const planted = join(dir, "localbin");
    mkdirSync(planted);
    const log = join(dir, "planted.log");
    for (const h of ["bash", "git", "mkdir", "pgrep"]) {
      writeFileSync(join(planted, h), `#!/bin/sh\necho "${h}" >> "${log}"\nexec /usr/bin/env -i PATH=${SYSTEM} ${h} "$@"\n`);
      chmodSync(join(planted, h), 0o755);
    }
    const like = join(dir, "like-deploy.sh");
    writeFileSync(like, "#!/usr/bin/env bash\ntrue\n");
    chmodSync(like, 0o755);
    const env = { ...process.env, PATH: `${TOOLS}/bin:${planted}:${SYSTEM}` };
    const check = spawnSync("/bin/bash", [SCRIPT, "check", TOOLS], { encoding: "utf8", env });
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.equal(check.stdout.trim().split("\n").at(-1), "owner tools: PASS");
    assert.ok(!existsSync(log), "the check itself runs nothing planted");
    // The guide's own blocks and a script with deploy.sh's first line, in the terminal that just passed.
    spawnSync("/bin/zsh", ["-fc", `${like}; git --version; mkdir -p ${join(dir, "ks")}; ${block("once no-agents")}`], { encoding: "utf8", env });
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").sort(), ["bash", "git", "mkdir", "pgrep"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R402-2 (static): the compiler forge runs is neither pinned nor inside the checked directory", () => {
  assert.ok(!/solc/i.test(pins.split("\n").filter((l) => !l.startsWith("#")).join("\n")));
  assert.ok(!/FOUNDRY_SOLC|solc/.test(script));
  assert.match(readFileSync(join(ROOT, "foundry.toml"), "utf8"), /^solc_version = "0\.8\.24"$/m);
});

test("R402-2 (needs R402_TOOLS and the compiler already fetched): forge runs whatever file sits at the compiler's path, unverified", { skip: !TOOLS || !existsSync(join(process.env.HOME ?? "", "Library/Application Support/svm/0.8.24/solc-0.8.24")) }, () => {
  const dir = mkdtempSync(join(tmpdir(), "r402-"));
  try {
    const real = join(process.env.HOME, "Library/Application Support/svm/0.8.24/solc-0.8.24");
    const home = join(dir, "home");
    const svm = join(home, "Library/Application Support/svm/0.8.24");
    mkdirSync(svm, { recursive: true });
    const log = join(dir, "planted.log");
    writeFileSync(join(svm, "solc-0.8.24"), `#!/bin/sh\necho solc >> "${log}"\nexec "${real}" "$@"\n`);
    chmodSync(join(svm, "solc-0.8.24"), 0o755);
    const proj = join(dir, "proj");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "foundry.toml"), '[profile.default]\nsrc = "src"\nsolc_version = "0.8.24"\n');
    writeFileSync(join(proj, "src/A.sol"), "// SPDX-License-Identifier: MIT\npragma solidity 0.8.24;\ncontract A { uint256 public x = 1; }\n");
    const r = spawnSync(join(TOOLS, "bin/forge"), ["build", "--offline"], { cwd: proj, encoding: "utf8", env: { HOME: home, PATH: `${TOOLS}/bin:${SYSTEM}` } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(readFileSync(log, "utf8"), /^solc\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("R402-3: the guide's kit-tests and plan blocks come before any block that builds the contracts", () => {
  const firstBuild = guide.search(/```\n[^`]*(forge build|deploy\.sh)[^`]*\n```/);
  assert.ok(guide.indexOf("<!-- run: once kit-tests -->") < firstBuild);
  assert.ok(guide.indexOf("<!-- run: once plan -->") < firstBuild);
  assert.ok(!/```\nforge build\n```/.test(guide));
});

test("R402-4: the commit the owner compares is seven hexadecimal digits", () => {
  assert.equal(block("once clone-commit"), "git -C ~/postern-dex log -1 --oneline");
  assert.ok(!/rev-parse HEAD/.test(guide));
});

test("R402-5: deploy.sh does not run the tools check itself", () => {
  assert.ok(!/owner-toolchain/.test(readFileSync(join(ROOT, "scripts/multichain/deploy.sh"), "utf8")));
});

test("R402-6 (static): the node launcher drops two variables only; (needs R402_TOOLS) the others reach node", () => {
  assert.match(script, /unset NODE_OPTIONS NODE_PATH\\nexec "\$d\/node\/bin\/node" "\$@"/);
  if (!TOOLS) return;
  const r = spawnSync(join(TOOLS, "bin/node"), ["-e", 'console.log([process.env.NODE_OPTIONS, process.env.NODE_TLS_REJECT_UNAUTHORIZED, process.env.NODE_EXTRA_CA_CERTS, require("module").getCompileCacheDir() !== undefined].join(","))'], {
    encoding: "utf8",
    env: { PATH: SYSTEM, NODE_OPTIONS: "--no-warnings", NODE_TLS_REJECT_UNAUTHORIZED: "0", NODE_EXTRA_CA_CERTS: "/nonexistent.pem", NODE_COMPILE_CACHE: join(tmpdir(), "r402-cc") },
  });
  assert.equal(r.stdout.trim(), ",0,/nonexistent.pem,true", r.stderr);
  rmSync(join(tmpdir(), "r402-cc"), { recursive: true, force: true });
});

test("R402-7 (needs R402_TOOLS): an access-control list that lets everyone write is not seen by the check", { skip: !TOOLS }, () => {
  const acl = "everyone allow write,delete,append";
  assert.equal(spawnSync("/bin/chmod", ["+a", acl, join(TOOLS, "foundry/cast")]).status, 0);
  try {
    const check = spawnSync("/bin/bash", [SCRIPT, "check", TOOLS], { encoding: "utf8", env: { ...process.env, PATH: `${TOOLS}/bin:${SYSTEM}` } });
    assert.equal(check.stdout.trim().split("\n").at(-1), "owner tools: PASS");
  } finally {
    spawnSync("/bin/chmod", ["-N", join(TOOLS, "foundry/cast")]);
  }
});
