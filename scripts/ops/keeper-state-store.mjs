// Durable local keeper state. An unresolved lock requires operator inspection;
// wall-clock age cannot establish that its owner has stopped publishing.
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

export function acquireLock(path) {
  const directory = dirname(path), lock = `${path}.lock`;
  ensureDirectory(directory);
  let fd;
  try { fd = openSync(lock, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`keeper lock ${lock} exists; inspect active processes and reconcile the state before manually removing a stale lock`);
    throw error;
  }
  const identity = fstatSync(fd);
  const ownerToken = randomUUID();
  try {
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), ownerToken })}\n`);
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
