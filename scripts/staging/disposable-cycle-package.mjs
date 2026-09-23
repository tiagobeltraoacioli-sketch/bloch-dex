import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { stableJson } from "./manifest.mjs";

const HASH = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const REVISION = /^[0-9a-f]{40}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9._/-]+$/;
const MAX_BYTES = 1024 * 1024;
const SOURCE_USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const ETHEREUM_GENESIS = "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3";
const MAX_DEPOSIT = 1_000_000n;
const MAX_PILOT_BASE = 10_000_000_000_000_000n;
const MAX_PILOT_QUOTE = 1_000_000n;
const STAGES = ["deposit", "l2Finality", "mintMapping", "pilotRoundTrip", "burnReleaseRefund"];

function fail(message) {
  throw new Error(`disposable cycle: ${message}`);
}

function required(condition, message) {
  if (!condition) fail(message);
}

function exact(value, keys, field) {
  required(
    value && typeof value === "object" && !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
    `${field} is not an object`,
  );
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  required(
    actual.length === expected.length && actual.every((key, index) => key === expected[index]),
    `${field} fields are invalid`,
  );
}

function hash(value, field) {
  required(HASH.test(value) && !/^0x0{64}$/.test(value), `${field} is invalid`);
  return value;
}

function address(value, field) {
  required(ADDRESS.test(value) && !/^0x0{40}$/.test(value), `${field} is invalid`);
  return value;
}

function decimal(value, field, ceiling = null) {
  required(typeof value === "string" && DECIMAL.test(value) && value.length <= 78, `${field} is invalid`);
  const parsed = BigInt(value);
  required(parsed > 0n, `${field} must be positive`);
  if (ceiling !== null) required(parsed <= ceiling, `${field} exceeds its disposable cap`);
  return parsed;
}

function digest(value) {
  return `0x${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

async function readCanonical(repository, relativePath) {
  required(
    typeof relativePath === "string" && SAFE_PATH.test(relativePath) && !isAbsolute(relativePath),
    "package path is invalid",
  );
  const root = resolve(repository);
  const path = resolve(root, relativePath);
  const fromRoot = relative(root, path);
  required(fromRoot !== "" && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`), "package escapes repository");
  let before;
  try {
    before = await lstat(path, { bigint: true });
    required((await realpath(path)) === path, "package contains a symbolic link");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("disposable cycle:")) throw error;
    fail("cannot inspect package");
  }
  required(
    before.isFile() && !before.isSymbolicLink() && before.nlink === 1n &&
      before.size > 0n && before.size <= BigInt(MAX_BYTES) && Number(before.mode & 0o022n) === 0,
    "package is unsafe",
  );
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    const fields = ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"];
    required(fields.every((field) => opened[field] === before[field]), "package changed before reading");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    required(offset > 0 && offset <= MAX_BYTES, "package is unsafe");
    const after = await handle.stat({ bigint: true });
    required(fields.every((field) => after[field] === opened[field]), "package changed while reading");
    const raw = bytes.subarray(0, offset);
    let value;
    try {
      value = JSON.parse(raw.toString("utf8"));
    } catch {
      fail("package is invalid JSON");
    }
    required(raw.toString("utf8") === `${stableJson(value)}\n`, "package is not canonical JSON");
    return { value, sha256: `0x${createHash("sha256").update(raw).digest("hex")}` };
  } finally {
    await handle.close();
  }
}

function receipt(value, field) {
  exact(
    value,
    ["transactionHash", "blockNumber", "blockHash", "finalizedBlockNumber", "finalizedBlockHash"],
    field,
  );
  hash(value.transactionHash, `${field}.transactionHash`);
  hash(value.blockHash, `${field}.blockHash`);
  hash(value.finalizedBlockHash, `${field}.finalizedBlockHash`);
  required(
    Number.isSafeInteger(value.blockNumber) && value.blockNumber > 0 &&
      Number.isSafeInteger(value.finalizedBlockNumber) && value.finalizedBlockNumber >= value.blockNumber,
    `${field} is not finalized`,
  );
}

function provenance(value, repository, revision, field) {
  exact(value, ["repository", "revision"], `${field}.provenance`);
  required(value.repository === repository && value.revision === revision, `${field} provenance is inconsistent`);
}

function stageHeader(value, schema, cycleId, synthetic, field) {
  required(value.schema === schema && value.cycleId === cycleId, `${field} schema or cycle is invalid`);
  required(value.synthetic === synthetic, `${field} synthetic marker is inconsistent`);
}

export async function verifyDisposableCyclePackage(repository, packagePath) {
  const opened = await readCanonical(repository, packagePath);
  const value = opened.value;
  exact(
    value,
    ["schemaVersion", "domain", "evidenceMode", "cycleId", "revisions", "chains", "assets", "caps", "stages", "controls"],
    "package",
  );
  required(
    value.schemaVersion === 1 && value.domain === "postern.dex.disposable-cycle-package.v1",
    "package schema is unsupported",
  );
  required(["retained-real", "synthetic-fixture"].includes(value.evidenceMode), "evidence mode is invalid");
  exact(value.controls, ["activationAuthorized", "aggregatorExecutionEnabled", "broadcastPerformed", "liquidityAdded", "liquidityEnabled"], "controls");
  for (const [field, control] of Object.entries(value.controls))
    required(control === false, `${field} must remain false`);
  exact(value.stages, STAGES, "stages");
  const present = STAGES.filter((name) => value.stages[name] !== null);
  required(present.length === 0 || present.length === STAGES.length, "cycle stages are partial");
  const base = {
    schemaVersion: 1,
    domain: "postern.dex.disposable-cycle-verification.v1",
    packageSha256: opened.sha256,
    evidenceMode: value.evidenceMode,
    syntheticEvidence: value.evidenceMode === "synthetic-fixture",
    artifactContentsOpened: false,
    declaredCycleConsistent: false,
    disposableCapsBounded: false,
    receiptsFinalizedDeclared: false,
    checkpointChainConsistent: false,
    reconciliationDeclared: false,
    externalTrustRootsConfigured: false,
    disposableCycleAuthenticated: false,
    readyForRealExecution: false,
    liquidityEnabled: false,
    liquidityAdded: false,
    aggregatorExecutionEnabled: false,
    activationAuthorized: false,
    broadcastPerformed: false,
  };
  if (present.length === 0) return Object.freeze(base);

  hash(value.cycleId, "cycleId");
  exact(value.revisions, ["bridge", "dex", "l2", "wallet"], "revisions");
  for (const [name, revision] of Object.entries(value.revisions))
    required(REVISION.test(revision), `${name} revision is invalid`);
  exact(value.chains, ["sourceChainId", "sourceGenesisHash", "destinationChainId", "destinationGenesisHash"], "chains");
  required(
    value.chains.sourceChainId === 1 && value.chains.sourceGenesisHash === ETHEREUM_GENESIS &&
      value.chains.destinationChainId === 700771,
    "chain identities are not selected",
  );
  hash(value.chains.destinationGenesisHash, "destination genesis");
  exact(value.assets, ["sourceTokenAddress", "bridgeAssetAddress", "wrappedNativeAddress", "pilotPoolAddress"], "assets");
  required(value.assets.sourceTokenAddress === SOURCE_USDC, "source token is not Ethereum USDC");
  for (const field of ["bridgeAssetAddress", "wrappedNativeAddress", "pilotPoolAddress"])
    address(value.assets[field], `assets.${field}`);
  required(new Set(Object.values(value.assets)).size === 4, "asset and pool identities must be distinct");
  exact(value.caps, ["depositBaseUnits", "pilotBaseBaseUnits", "pilotQuoteBaseUnits"], "caps");
  const depositCap = decimal(value.caps.depositBaseUnits, "deposit cap", MAX_DEPOSIT);
  const pilotBaseCap = decimal(value.caps.pilotBaseBaseUnits, "pilot base cap", MAX_PILOT_BASE);
  const pilotQuoteCap = decimal(value.caps.pilotQuoteBaseUnits, "pilot quote cap", MAX_PILOT_QUOTE);
  const synthetic = value.evidenceMode === "synthetic-fixture";

  const deposit = value.stages.deposit;
  exact(deposit, ["schema", "synthetic", "cycleId", "provenance", "sourceChainId", "sourceGenesisHash", "sourceTokenAddress", "amountBaseUnits", "depositReceipt"], "deposit");
  stageHeader(deposit, "postern.dex.disposable-deposit.v1", value.cycleId, synthetic, "deposit");
  provenance(deposit.provenance, "bloch-l2-bridge", value.revisions.bridge, "deposit");
  required(deposit.sourceChainId === 1 && deposit.sourceGenesisHash === ETHEREUM_GENESIS && deposit.sourceTokenAddress === SOURCE_USDC, "deposit source binding is invalid");
  const deposited = decimal(deposit.amountBaseUnits, "deposit amount", depositCap);
  receipt(deposit.depositReceipt, "deposit receipt");
  const depositDigest = digest(deposit);

  const finality = value.stages.l2Finality;
  exact(finality, ["schema", "synthetic", "cycleId", "provenance", "chainId", "genesisHash", "depositDigest", "finalizedBlockNumber", "finalizedBlockHash", "checkpointSha256", "finalityVerified"], "l2 finality");
  stageHeader(finality, "postern.dex.disposable-l2-finality.v1", value.cycleId, synthetic, "l2 finality");
  provenance(finality.provenance, "bloch-l2-evm", value.revisions.l2, "l2 finality");
  required(finality.chainId === 700771 && finality.genesisHash === value.chains.destinationGenesisHash && finality.depositDigest === depositDigest, "L2 finality binding is invalid");
  required(Number.isSafeInteger(finality.finalizedBlockNumber) && finality.finalizedBlockNumber > 0 && finality.finalityVerified === true, "L2 finality is not declared");
  hash(finality.finalizedBlockHash, "L2 finalized hash");
  hash(finality.checkpointSha256, "L2 checkpoint");
  const finalityDigest = digest(finality);

  const mint = value.stages.mintMapping;
  exact(mint, ["schema", "synthetic", "cycleId", "provenance", "chainId", "genesisHash", "depositDigest", "finalityDigest", "sourceTokenAddress", "destinationTokenAddress", "mintedBaseUnits", "mappingVerified", "mintReceipt"], "mint mapping");
  stageHeader(mint, "postern.dex.disposable-mint-mapping.v1", value.cycleId, synthetic, "mint mapping");
  provenance(mint.provenance, "bloch-l2-bridge", value.revisions.bridge, "mint mapping");
  required(mint.chainId === 700771 && mint.genesisHash === value.chains.destinationGenesisHash && mint.depositDigest === depositDigest && mint.finalityDigest === finalityDigest, "mint cross-binding is invalid");
  required(mint.sourceTokenAddress === SOURCE_USDC && mint.destinationTokenAddress === value.assets.bridgeAssetAddress && mint.mappingVerified === true, "asset mapping is invalid");
  required(decimal(mint.mintedBaseUnits, "minted amount") === deposited, "mint amount does not reconcile with deposit");
  receipt(mint.mintReceipt, "mint receipt");
  const mintDigest = digest(mint);

  const pilot = value.stages.pilotRoundTrip;
  exact(pilot, ["schema", "synthetic", "cycleId", "provenance", "walletRevision", "chainId", "genesisHash", "mintDigest", "poolAddress", "baseTokenAddress", "quoteTokenAddress", "quoteInputBaseUnits", "baseOutputBaseUnits", "baseReturnInputBaseUnits", "quoteReturnOutputBaseUnits", "beforeCheckpointSha256", "afterCheckpointSha256", "outboundSwapReceipt", "returnSwapReceipt", "invariantVerified", "executionWasDisposable", "liquidityAdded"], "pilot round trip");
  stageHeader(pilot, "postern.dex.disposable-pilot-round-trip.v1", value.cycleId, synthetic, "pilot round trip");
  provenance(pilot.provenance, "postern-dex", value.revisions.dex, "pilot round trip");
  required(pilot.walletRevision === value.revisions.wallet, "pilot wallet revision is inconsistent");
  required(pilot.chainId === 700771 && pilot.genesisHash === value.chains.destinationGenesisHash && pilot.mintDigest === mintDigest, "pilot cross-binding is invalid");
  required(pilot.poolAddress === value.assets.pilotPoolAddress && pilot.baseTokenAddress === value.assets.wrappedNativeAddress && pilot.quoteTokenAddress === value.assets.bridgeAssetAddress, "pilot identities are invalid");
  const quoteInput = decimal(pilot.quoteInputBaseUnits, "pilot quote input", pilotQuoteCap);
  const baseOutput = decimal(pilot.baseOutputBaseUnits, "pilot base output", pilotBaseCap);
  required(decimal(pilot.baseReturnInputBaseUnits, "pilot base return", pilotBaseCap) === baseOutput, "pilot base round trip does not reconcile");
  required(decimal(pilot.quoteReturnOutputBaseUnits, "pilot quote return", pilotQuoteCap) <= quoteInput, "pilot quote return exceeds its input");
  hash(pilot.beforeCheckpointSha256, "pilot before checkpoint");
  hash(pilot.afterCheckpointSha256, "pilot after checkpoint");
  required(pilot.beforeCheckpointSha256 !== pilot.afterCheckpointSha256, "pilot checkpoints did not advance");
  receipt(pilot.outboundSwapReceipt, "outbound swap receipt");
  receipt(pilot.returnSwapReceipt, "return swap receipt");
  required(pilot.invariantVerified === true && pilot.executionWasDisposable === true && pilot.liquidityAdded === false, "pilot controls are invalid");
  const pilotDigest = digest(pilot);

  const exit = value.stages.burnReleaseRefund;
  exact(exit, ["schema", "synthetic", "cycleId", "provenance", "pilotDigest", "burnedBaseUnits", "releasedBaseUnits", "refundedBaseUnits", "feesBaseUnits", "burnReceipt", "releaseReceipt", "refundReceipt", "finalCheckpointSha256", "reconciliationVerified"], "burn release refund");
  stageHeader(exit, "postern.dex.disposable-burn-release-refund.v1", value.cycleId, synthetic, "burn release refund");
  provenance(exit.provenance, "bloch-l2-bridge", value.revisions.bridge, "burn release refund");
  required(exit.pilotDigest === pilotDigest, "exit does not bind the pilot cycle");
  required(decimal(exit.burnedBaseUnits, "burned amount") === deposited, "burn does not reconcile with mint");
  const released = decimal(exit.releasedBaseUnits, "released amount");
  const refunded = decimal(exit.refundedBaseUnits, "refunded amount");
  const fees = decimal(exit.feesBaseUnits, "fee amount");
  required(released + refunded + fees === deposited, "release, refund and fees do not reconcile with deposit");
  receipt(exit.burnReceipt, "burn receipt");
  receipt(exit.releaseReceipt, "release receipt");
  receipt(exit.refundReceipt, "refund receipt");
  hash(exit.finalCheckpointSha256, "final checkpoint");
  required(exit.reconciliationVerified === true, "final reconciliation is not declared");

  return Object.freeze({
    ...base,
    artifactContentsOpened: true,
    declaredCycleConsistent: true,
    disposableCapsBounded: true,
    receiptsFinalizedDeclared: true,
    checkpointChainConsistent: true,
    reconciliationDeclared: true,
  });
}
