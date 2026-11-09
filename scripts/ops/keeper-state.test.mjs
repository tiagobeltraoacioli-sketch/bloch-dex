import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireLock, saveState } from "./dex-skim-keeper.mjs";

function fixture(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), "keeper-durable-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return join(directory, "state.json");
}

function restoreBuiltins(t) {
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
}

test("keeper state flushes file before atomic rename and directory before returning", (t) => {
  const path = fixture(t);
  const operations = [];
  const fsync = fs.fsyncSync, rename = fs.renameSync;
  restoreBuiltins(t);
  t.mock.method(fs, "fsyncSync", (fd) => { operations.push(fs.fstatSync(fd).isDirectory() ? "sync-directory" : "sync-file"); return fsync(fd); });
  t.mock.method(fs, "renameSync", (...args) => { operations.push("rename"); return rename(...args); });
  syncBuiltinESMExports();
  saveState(path, { txs: [{ hash: "recorded-before-publication", reservedWei: "42" }] });
  assert.deepEqual(operations, ["sync-file", "rename", "sync-directory"]);
  assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(path)).txs[0].reservedWei, "42");
});

test("keeper preserves the old state and fails if reservation flush fails", (t) => {
  const path = fixture(t);
  const previous = JSON.stringify({ txs: [{ reservedWei: "17" }] });
  fs.writeFileSync(path, previous, { mode: 0o600 });
  restoreBuiltins(t);
  t.mock.method(fs, "fsyncSync", () => { throw new Error("simulated disk flush failure"); });
  syncBuiltinESMExports();
  assert.throws(() => saveState(path, { txs: [{ reservedWei: "42" }] }), /disk flush failure/);
  assert.equal(fs.readFileSync(path, "utf8"), previous);
  assert.deepEqual(fs.readdirSync(join(path, "..")), ["state.json"]);
});

test("keeper state does not follow an old predictable temporary-file symlink", (t) => {
  const path = fixture(t);
  const victim = join(path, "..", "unrelated.json");
  fs.writeFileSync(victim, "untouched");
  fs.symlinkSync(victim, `${path}.tmp`);
  saveState(path, { txs: [] });
  assert.equal(fs.readFileSync(victim, "utf8"), "untouched");
  assert.equal(fs.lstatSync(path).isSymbolicLink(), false);
  assert.equal(fs.statSync(path).mode & 0o777, 0o600);
});

test("keeper persists newly created private state directories", (t) => {
  const base = fixture(t);
  const path = join(base, "..", "private", "nested", "state.json");
  saveState(path, { txs: [] });
  assert.equal(fs.statSync(join(path, "..")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(join(path, "..", "..")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(path)), { txs: [] });
});

test("keeper never steals an old lock and releases only after its owner finishes", (t) => {
  const path = fixture(t);
  const release = acquireLock(path, 1_000_000);
  const content = fs.readFileSync(`${path}.lock`, "utf8");
  fs.utimesSync(`${path}.lock`, new Date(0), new Date(0));
  assert.throws(() => acquireLock(path, 1_000_000), /lock.*exists|another keeper run/);
  assert.equal(fs.readFileSync(`${path}.lock`, "utf8"), content);
  release();
  assert.equal(fs.existsSync(`${path}.lock`), false);
  const next = acquireLock(path, 1_000_001);
  next();
});

test("keeper cannot release a lock that changed ownership", (t) => {
  const path = fixture(t);
  const release = acquireLock(path, 1_000_000);
  fs.writeFileSync(`${path}.lock`, JSON.stringify({ ownerToken: "different-owner" }));
  assert.throws(release, /lock changed/);
  assert.equal(fs.existsSync(`${path}.lock`), true);
});

// ---- round 14 (agent 307): a lock is taken over only with proof that its owner is gone.
import { lockOwnerIsGone } from "./keeper-state-store.mjs";
import { spawnSync } from "node:child_process";

const alive = { bootId: () => "boot-1", processStart: () => "100", kill: () => {}, identity: () => ({ host: "h1", pidNamespace: "pid:[1]" }) };
const record = (extra = {}) => ({ pid: 4242, ownerToken: "t", bootId: "boot-1", processStart: "100", host: "h1", pidNamespace: "pid:[1]", ...extra });

test("a lock owner is gone only on a reboot, a missing process, or a reused process ID", () => {
  assert.equal(lockOwnerIsGone(record(), alive), false);
  assert.equal(lockOwnerIsGone(record(), { ...alive, bootId: () => "boot-2" }), true);
  assert.equal(lockOwnerIsGone(record(), { ...alive, kill: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); } }), true);
  assert.equal(lockOwnerIsGone(record(), { ...alive, kill: () => { throw Object.assign(new Error("other user"), { code: "EPERM" }); } }), false);
  assert.equal(lockOwnerIsGone(record(), { ...alive, processStart: () => "999" }), true);
  // No start time on this platform, or in the record: a live process ID is never called gone.
  assert.equal(lockOwnerIsGone(record({ processStart: null }), { ...alive, processStart: () => "999" }), false);
  assert.equal(lockOwnerIsGone(record(), { ...alive, processStart: () => null }), false);
  // Another host or PID namespace sharing the state directory: never judged gone, whatever the probes say.
  const dead = { ...alive, bootId: () => "boot-2", kill: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); } };
  assert.equal(lockOwnerIsGone(record({ host: "h2" }), dead), false);
  assert.equal(lockOwnerIsGone(record({ pidNamespace: "pid:[2]" }), dead), false);
  assert.equal(lockOwnerIsGone(record({ pidNamespace: undefined }), dead), false);
  // Records that cannot be judged: older format, damaged, foreign.
  for (const bad of [null, {}, { pid: 4242, ownerToken: "t" }, record({ pid: 0 }), record({ pid: "4242" }), record({ ownerToken: undefined })]) {
    assert.equal(lockOwnerIsGone(bad, { ...alive, kill: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); } }), false);
  }
});

test("a lock left by a dead keeper process is taken over; one left by a live process, or unreadable, is not", (t) => {
  const path = fixture(t);
  // A real process that has exited: its ID is free (reuse within this test is not plausible).
  const dead = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" });
  const deadPid = Number(dead.stdout.trim());
  const here = { host: os.hostname(), pidNamespace: (() => { try { return fs.readlinkSync("/proc/self/ns/pid"); } catch { return null; } })() };
  fs.writeFileSync(`${path}.lock`, JSON.stringify({ pid: deadPid, startedAt: "2026-11-09T00:00:00Z", ownerToken: "dead-owner", bootId: null, processStart: null, ...here }));
  const release = acquireLock(path);
  const mine = JSON.parse(fs.readFileSync(`${path}.lock`, "utf8"));
  assert.equal(mine.pid, process.pid);
  assert.notEqual(mine.ownerToken, "dead-owner");
  assert.equal(fs.existsSync(`${path}.lock.break`), false);
  // This process is alive: a second acquisition is refused and the lock is untouched.
  assert.throws(() => acquireLock(path), /lock.*exists/);
  assert.equal(JSON.parse(fs.readFileSync(`${path}.lock`, "utf8")).ownerToken, mine.ownerToken);
  release();
  for (const content of ["", "not json", JSON.stringify({ pid: deadPid, ownerToken: "old-format" })]) {
    fs.writeFileSync(`${path}.lock`, content);
    assert.throws(() => acquireLock(path), /lock.*exists/);
    assert.equal(fs.readFileSync(`${path}.lock`, "utf8"), content);
  }
  // Another process is already taking a dead lock over.
  fs.writeFileSync(`${path}.lock`, JSON.stringify({ pid: deadPid, ownerToken: "dead-owner", bootId: null, processStart: null, ...here }));
  fs.writeFileSync(`${path}.lock.break`, "");
  assert.throws(() => acquireLock(path), /another process is taking it over/);
  assert.equal(JSON.parse(fs.readFileSync(`${path}.lock`, "utf8")).ownerToken, "dead-owner");
});

test("a keeper pass stopped by SIGTERM releases its lock", async (t) => {
  const path = fixture(t);
  const script = `
    import { acquireLock } from ${JSON.stringify(new URL("./keeper-state-store.mjs", import.meta.url).href)};
    const release = acquireLock(${JSON.stringify(path)});
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(signal, () => { try { release(); } finally { process.exit(2); } });
    console.log("locked");
    setInterval(() => {}, 1000);`;
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve) => child.stdout.once("data", resolve));
  assert.equal(fs.existsSync(`${path}.lock`), true);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  assert.equal(await exited, 2);
  assert.equal(fs.existsSync(`${path}.lock`), false);
});
