#!/usr/bin/env node
// Publish one explicitly signed transaction after durably recording its public
// fields. No signing, nonce selection, resubmission or fee adjustment happens here.
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createRpcTransport } from "./rpc-transport.mjs";
import { sequencerFeeRequirement } from "./sequencer-fee-error.mjs";

const { keccak256, parseTransaction, recoverTransactionAddress } = createRequire(new URL("../../frontend/package.json", import.meta.url))("viem");
const DOMAIN = "postern.dex.publication-journal.v1";
const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const MAX_RAW_CHARS = 4 * 1024 * 1024;

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function syncDirectory(path) {
  const fd = openSync(dirname(path), "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

// The initial link refuses an existing destination. Replacements happen while
// holding the exclusive journal lock. fsync precedes every publication request.
function writeJournal(path, journal, initial) {
  const temp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, `${JSON.stringify(journal, null, 2)}\n`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    if (initial) { linkSync(temp, path); unlinkSync(temp); }
    else renameSync(temp, path);
    syncDirectory(path);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export async function publishRecorded({ raw, journalPath, chainId, genesisHash, from, configSha256, label }, request) {
  requireCondition(typeof raw === "string" && raw.length <= MAX_RAW_CHARS && /^0x(?:[0-9a-fA-F]{2})+$/.test(raw), "signed transaction is invalid or too large");
  requireCondition(DECIMAL.test(String(chainId)) && BigInt(chainId) > 0n && HASH.test(genesisHash) && ADDRESS.test(from) && HASH.test(configSha256), "publication identity is invalid");
  requireCondition(typeof label === "string" && label.length > 0 && label.length <= 200, "transaction label is invalid");
  const tx = parseTransaction(raw);
  requireCondition(tx.type === "eip1559" && BigInt(tx.chainId) === BigInt(chainId), "signed transaction chain or type differs from the plan");
  requireCondition(Number.isSafeInteger(tx.nonce) && tx.nonce >= 0 && typeof tx.gas === "bigint" && tx.gas > 0n &&
    typeof tx.maxFeePerGas === "bigint" && typeof tx.maxPriorityFeePerGas === "bigint" && tx.maxPriorityFeePerGas <= tx.maxFeePerGas,
  "signed transaction nonce, gas or fees cannot be recorded exactly");
  requireCondition((await recoverTransactionAddress({ serializedTransaction: raw })).toLowerCase() === from, "signed transaction sender differs from the plan");
  const hash = keccak256(raw);
  const identity = { chainId: String(chainId), genesisHash, from, configSha256 };
  const lock = `${journalPath}.lock`;
  const lockFd = openSync(lock, "wx", 0o600);
  closeSync(lockFd);
  try {
    const initial = !existsSync(journalPath);
    const journal = initial ? { domain: DOMAIN, ...identity, attempts: [] } : JSON.parse(readFileSync(journalPath, "utf8"));
    requireCondition(journal.domain === DOMAIN && Array.isArray(journal.attempts) && Object.entries(identity).every(([key, value]) => journal[key] === value), "journal identity differs from this plan");
    const previous = journal.attempts.at(-1);
    requireCondition(journal.attempts.every((attempt) => attempt.status === "published" && DECIMAL.test(attempt.nonce)), "journal has an unresolved publication; inspect its hash before continuing");
    requireCondition(!journal.attempts.some((attempt) => attempt.hash === hash || BigInt(attempt.nonce) === BigInt(tx.nonce)), "journal already records this transaction or nonce; no resubmission was made");
    requireCondition(!previous || BigInt(tx.nonce) === BigInt(previous.nonce) + 1n, "signed transaction does not follow the journal's explicit nonce sequence");
    requireCondition(BigInt(await request("eth_chainId", [])) === BigInt(chainId), "RPC chain ID differs from the plan");
    const genesis = await request("eth_getBlockByNumber", ["0x0", false]);
    requireCondition(genesis?.hash === genesisHash, "RPC genesis differs from the plan");
    const entry = {
      at: new Date().toISOString(), hash, nonce: String(tx.nonce), label,
      to: tx.to?.toLowerCase() ?? null, data: tx.data ?? "0x", value: String(tx.value ?? 0n),
      gasLimit: String(tx.gas), maxFeePerGas: String(tx.maxFeePerGas),
      maxPriorityFeePerGas: String(tx.maxPriorityFeePerGas), status: "publish-pending",
    };
    journal.attempts.push(entry);
    writeJournal(journalPath, journal, initial);
    let result;
    try {
      const publishedHash = await request("eth_sendRawTransaction", [raw]);
      requireCondition(publishedHash === hash, "eth_sendRawTransaction returned a different transaction hash");
      entry.status = "published";
      result = { decision: "published", hash, journal: journalPath };
    } catch (error) {
      const feeRequirement = sequencerFeeRequirement(error, hash);
      entry.status = feeRequirement ? "publish-refused" : "publish-unconfirmed";
      entry.detail = String(error.message).slice(0, 2000);
      if (feeRequirement) entry.feeRequirement = feeRequirement;
      result = { decision: entry.status, hash, journal: journalPath, detail: entry.detail, ...(feeRequirement ? { feeRequirement } : {}) };
    }
    writeJournal(journalPath, journal, false);
    return result;
  } finally {
    unlinkSync(lock);
    syncDirectory(journalPath);
  }
}

async function main() {
  const args = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const name = process.argv[i];
    requireCondition(["--rpc", "--journal", "--chain-id", "--genesis", "--from", "--confirm", "--label"].includes(name) && process.argv[i + 1] !== undefined && !Object.hasOwn(args, name), "invalid publication arguments");
    args[name] = process.argv[i + 1];
  }
  requireCondition(Object.keys(args).length === 7, "usage: publish-recorded.mjs --rpc URL --journal FILE --chain-id ID --genesis HASH --from ADDRESS --confirm CONFIG_HASH --label LABEL < signed-transaction");
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
    requireCondition(raw.length <= MAX_RAW_CHARS, "signed transaction input is too large");
  }
  const result = await publishRecorded({ raw: raw.trim(), journalPath: args["--journal"], chainId: args["--chain-id"], genesisHash: args["--genesis"], from: args["--from"], configSha256: args["--confirm"], label: args["--label"] }, createRpcTransport(args["--rpc"]));
  if (result.decision === "published") console.log(JSON.stringify(result));
  else { console.error(JSON.stringify(result, null, 2)); process.exitCode = 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`publication stopped: ${error.message}; inspect the journal before any new attempt`); process.exitCode = 1; });
}
