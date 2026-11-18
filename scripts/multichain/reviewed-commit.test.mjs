// Review R402-4 (round 19, agent 400): the owner compares the copy he will run with the reviewed commit, on all 40
// digits, with an id he received OUTSIDE the repository; the guide states no id, and its two lines refuse when the
// placeholder is left as printed. Both lines of docs/OWNER-DEPLOY-NOW.md are run here, exactly as written, against
// throwaway repositories.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMIT_PLACEHOLDER, DOC, blocksOf } from "./owner-dry-run.mjs";
import { ROOT } from "./lib.mjs";

const text = readFileSync(join(ROOT, DOC), "utf8");
const blocks = blocksOf(text);
const SCRIPT = join(ROOT, "scripts/multichain/reviewed-commit.sh");
// A plain terminal's environment: nothing of the test runner reaches the lines.
const ENV = { HOME: process.env.HOME ?? "/var/empty", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" };

/** A throwaway repository with two commits and this script at scripts/multichain/, as the owner's clone has it. */
function repository(context) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "reviewed-commit-")));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => {
    const r = spawnSync("/usr/bin/git", ["-C", dir, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env: ENV });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "-q", "-b", "main");
  mkdirSync(join(dir, "scripts/multichain"), { recursive: true });
  copyFileSync(SCRIPT, join(dir, "scripts/multichain/reviewed-commit.sh"));
  writeFileSync(join(dir, "file.txt"), "one\n");
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  const parent = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "file.txt"), "two\n");
  git("commit", "-q", "-am", "second");
  return { dir, git, head: git("rev-parse", "HEAD"), parent };
}
const run = (dir, args, env = ENV) => spawnSync("/bin/bash", [join(dir, "scripts/multichain/reviewed-commit.sh"), ...args], { encoding: "utf8", env, cwd: tmpdir() });
const lastLine = (r) => `${r.stdout}${r.stderr}`.trim().split("\n").at(-1);
const refused = (r) => r.status === 1 && lastLine(r) === "reviewed commit: FAIL; stop here and run nothing else from this copy" && !/reviewed commit: PASS/.test(`${r.stdout}${r.stderr}`);

test("reviewed-commit.sh passes only for the full id of the commit the copy is at, with no tracked file changed", (context) => {
  const { dir, git, head, parent } = repository(context);
  assert.match(head, /^[0-9a-f]{40}$/);
  const ok = run(dir, [head]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout, `reviewed commit: PASS ${head}\n`);
  // An untracked file (the generated output of a later step) does not change the commit's files.
  writeFileSync(join(dir, "untracked.txt"), "x\n");
  assert.equal(run(dir, [head]).stdout, `reviewed commit: PASS ${head}\n`);

  for (const [args, pattern] of [
    // The guide's line left as printed: the placeholder cannot be skipped.
    [[COMMIT_PLACEHOLDER], /is not a commit id: replace it with the 40-digit id you received outside the repository/],
    [[], /give exactly one argument/],
    [[head, head], /give exactly one argument/],
    [[""], /is not a commit id/],
    // Short forms and other spellings of the right commit.
    [[head.slice(0, 7)], /has 7 digits; the full commit id has 40/],
    [[head.slice(0, 39)], /has 39 digits/],
    [[`${head}0`], /has 41 digits/],
    [[head.toUpperCase()], /is not a commit id/],
    [[`0x${head.slice(2)}`], /is not a commit id/],
    [[` ${head}`], /is not a commit id/],
    [["HEAD"], /is not a commit id/],
    [["main"], /is not a commit id/],
    [[`${head.slice(0, 20)}\n${head.slice(20)}`], /is not a commit id/],
    // Another commit: the parent, and the right id with its last digit changed.
    [[parent], /this copy is not the reviewed commit/],
    [[`${head.slice(0, 39)}${head[39] === "0" ? "1" : "0"}`], /this copy is not the reviewed commit/],
  ]) {
    const r = run(dir, args);
    assert.ok(refused(r), `${JSON.stringify(args)}: ${r.status} ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, pattern, JSON.stringify(args));
    assert.equal(r.stdout, "");
  }
  // On a mismatch both ids are shown in full, one under the other.
  const other = run(dir, [parent]);
  assert.ok(other.stderr.includes(`this copy is at ${head}\n`) && other.stderr.includes(`you gave        ${parent}\n`));

  // A tracked file edited, staged, or deleted since the commit: refused and named.
  appendFileSync(join(dir, "file.txt"), "edited\n");
  let r = run(dir, [head]);
  assert.ok(refused(r) && /file\.txt/.test(r.stderr) && /files of this copy differ from the commit/.test(r.stderr), r.stderr);
  git("add", "file.txt");
  assert.ok(refused(run(dir, [head])));
  git("reset", "-q", "--hard", head);
  assert.equal(run(dir, [head]).status, 0);
  appendFileSync(join(dir, "scripts/multichain/reviewed-commit.sh"), "\n");
  r = run(dir, [head]);
  assert.ok(refused(r) && /reviewed-commit\.sh/.test(r.stderr));
  git("reset", "-q", "--hard", head);
  rmSync(join(dir, "file.txt"));
  assert.ok(refused(run(dir, [head])));
  git("reset", "-q", "--hard", head);

  // The copy moved to another commit: the id that passed before is refused.
  git("checkout", "-q", "--detach", parent);
  assert.ok(refused(run(dir, [head])));
  assert.equal(run(dir, [parent]).stdout, `reviewed commit: PASS ${parent}\n`);
});

test("reviewed-commit.sh reads the copy it is in, whatever the caller's directory and git variables say", (context) => {
  const one = repository(context);
  const two = repository(context);
  writeFileSync(join(two.dir, "file.txt"), "another history\n");
  two.git("commit", "-q", "-am", "third");
  const twoHead = two.git("rev-parse", "HEAD");
  assert.notEqual(one.head, twoHead);
  // GIT_DIR / GIT_WORK_TREE pointing at another repository must not make this copy answer with that one's commit.
  const env = { ...ENV, GIT_DIR: join(two.dir, ".git"), GIT_WORK_TREE: two.dir, GIT_INDEX_FILE: join(two.dir, ".git/index"), GIT_CEILING_DIRECTORIES: "/" };
  assert.ok(refused(run(one.dir, [twoHead], env)));
  assert.equal(run(one.dir, [one.head], env).stdout, `reviewed commit: PASS ${one.head}\n`);
  // The script is /bin/bash with macOS's own git by absolute path, and names no other program.
  const source = readFileSync(SCRIPT, "utf8");
  assert.ok(source.startsWith("#!/bin/bash\n"));
  assert.match(source, /^PATH=\/usr\/bin:\/bin:\/usr\/sbin:\/sbin$/m);
  assert.match(source, /\/usr\/bin\/env -i [^\n]*\/usr\/bin\/git -C "\$ROOT"/);
});

test("the guide states no reviewed commit id; both of its lines, run as written, refuse until the id is pasted", (context) => {
  // No id in the page, no open placeholder a reader could pass over, and the two blocks carry the same placeholder.
  assert.ok(!text.includes("TBD-integrator"));
  assert.ok(!/reviewed commit[^\n]{0,80}`[0-9a-f]{7,40}`/.test(text));
  assert.equal(text.split(COMMIT_PLACEHOLDER).length - 1, 5, "the placeholder: once in each block, once in each instruction to replace it, once in section 10 (what the dry run pastes)");
  for (const step of ["clone-commit", "reviewed-commit"]) assert.equal(blocks[`once ${step}`].split(COMMIT_PLACEHOLDER).length - 1, 1, step);
  assert.match(text, /You received the 40-digit id outside\nthe repository: in the coordinator's message and in your own Portuguese copy of this guide, which is not in the\nrepository\./);
  assert.match(text, /The line printed as it stands here \(the placeholder not replaced\) prints `MISMATCH` too/);

  const { dir, head, parent } = repository(context);
  // First line (before anything from the clone is run): macOS's programs only. `~/postern-dex` is the owner's
  // clone; here it is the throwaway repository.
  const first = (id) => {
    const line = blocks["once clone-commit"].replace("~/postern-dex", dir).replaceAll(COMMIT_PLACEHOLDER, id);
    return spawnSync("/bin/bash", ["-c", line], { encoding: "utf8", env: ENV, cwd: tmpdir() });
  };
  assert.equal(first(head).stdout, "reviewed commit: MATCH\n");
  for (const id of [COMMIT_PLACEHOLDER, parent, head.slice(0, 7), head.slice(0, 39), `${head}0`, head.toUpperCase(), "", "HEAD"]) {
    const r = first(id);
    assert.equal(r.stdout, "reviewed commit: MISMATCH; stop and run nothing from this copy\n", id);
  }
  // Second line (section 2.1), run in the clone as the guide has the owner do.
  const second = (id) => spawnSync("/bin/bash", ["-c", blocks["once reviewed-commit"].replaceAll(COMMIT_PLACEHOLDER, id)], { encoding: "utf8", env: ENV, cwd: dir });
  assert.equal(second(head).stdout, `reviewed commit: PASS ${head}\n`);
  for (const id of [COMMIT_PLACEHOLDER, parent, head.slice(0, 7)]) assert.ok(refused(second(id)), id);
});
