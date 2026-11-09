// Durable local keeper state. Wall-clock age never establishes that a lock's owner has
// stopped publishing. A lock is taken over only when its owner is provably gone: the host
// was rebooted since, the process ID no longer exists, or (Linux) that ID now belongs to a
// process with another start time. Anything else requires operator inspection.
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, fstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function syncDirectory(directory) {
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function ensureDirectory(directory) {
  const firstCreated = mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!firstCreated) return;
  // Persist newly created directory entries as well as the eventual state file.
  const parent = dirname(resolve(firstCreated));
  for (let current = resolve(directory); ; current = dirname(current)) {
    syncDirectory(current);
    if (current === parent) break;
  }
}

export function saveState(path, state) {
  const body = `${JSON.stringify(state, null, 2)}\n`;
  const directory = dirname(path);
  ensureDirectory(directory);
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    syncDirectory(directory);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

const readText = (path) => { try { return readFileSync(path, "utf8").trim(); } catch { return null; } };
const bootId = () => readText("/proc/sys/kernel/random/boot_id");
/// Linux: the process start time in clock ticks since boot (field 22 of /proc/<pid>/stat).
function processStart(pid) {
  const stat = readText(`/proc/${pid}/stat`);
  return stat ? stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null : null;
}

/// True only with proof that the process which wrote this lock record no longer runs.
export function lockOwnerIsGone(record, probe = { bootId, processStart, kill: (pid) => process.kill(pid, 0) }) {
  if (!record || !Number.isSafeInteger(record.pid) || record.pid <= 0 || typeof record.ownerToken !== "string" || !("bootId" in record)) return false;
  const boot = probe.bootId();
  if (record.bootId && boot && record.bootId !== boot) return true;
  try { probe.kill(record.pid); } catch (error) { return error.code === "ESRCH"; }
  const started = probe.processStart(record.pid);
  return Boolean(record.processStart && started && started !== record.processStart);
}

export function acquireLock(path) {
  const directory = dirname(path), lock = `${path}.lock`;
  ensureDirectory(directory);
  const exclusive = () => openSync(lock, "wx", 0o600);
  const refuse = (why) => new Error(`keeper lock ${lock} exists${why}; inspect active processes and reconcile the state before manually removing a stale lock`);
  let fd;
  try { fd = exclusive(); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    let record = null;
    try { record = JSON.parse(readFileSync(lock, "utf8")); } catch { /* unreadable: not provably stale */ }
    if (!lockOwnerIsGone(record)) throw refuse("");
    // Its owner is gone. One process at a time may break it, and only the lock it examined.
    const breaker = `${lock}.break`;
    let breakFd;
    try { breakFd = openSync(breaker, "wx", 0o600); }
    catch (inner) { if (inner.code === "EEXIST") throw refuse(" and another process is taking it over"); throw inner; }
    try {
      let current = null;
      try { current = JSON.parse(readFileSync(lock, "utf8")); } catch (inner) { if (inner.code !== "ENOENT") throw refuse(" and changed while it was examined"); }
      if (current) {
        if (current.ownerToken !== record.ownerToken || !lockOwnerIsGone(current)) throw refuse(" and changed while it was examined");
        unlinkSync(lock);
      }
      try { fd = exclusive(); } catch (inner) { if (inner.code === "EEXIST") throw refuse(""); throw inner; }
    } finally { closeSync(breakFd); unlinkSync(breaker); }
  }
  const identity = fstatSync(fd);
  const ownerToken = randomUUID();
  try {
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), ownerToken, bootId: bootId(), processStart: processStart(process.pid) })}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  syncDirectory(directory);
  let releaseAttempted = false;
  return () => {
    if (releaseAttempted) return;
    releaseAttempted = true;
    const current = statSync(lock);
    if (current.dev !== identity.dev || current.ino !== identity.ino || JSON.parse(readFileSync(lock, "utf8")).ownerToken !== ownerToken) {
      throw new Error("keeper lock changed while this process held it; refusing to remove it");
    }
    unlinkSync(lock);
    syncDirectory(directory);
  };
}
