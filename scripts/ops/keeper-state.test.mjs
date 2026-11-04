import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
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
