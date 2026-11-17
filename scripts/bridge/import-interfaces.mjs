#!/usr/bin/env node
// Import the bridges' interface files into this repository, and generate the wrapped-token list from them.
//
//   node scripts/bridge/import-interfaces.mjs [--repo <a checkout of bloch-l2-bridge>] [--check]
//
// Reads deployments/bridges/import.config.json (one git ref per source network), resolves each ref to a commit
// in the bridge repository (read only: `git rev-parse`, `git show`), and writes, byte for byte:
//   deployments/bridges/<network>/bridge.network.json   the bridge's own file at that commit
//   deployments/bridges/schema/bridge.network.schema.json
// then
//   deployments/bridges/sources.json          where every file came from (ref, commit, path, sha256)
//   deployments/bridges/wrapped-tokens.json   the one generated list of wrapped tokens (see wrapped-tokens.mjs)
//
// Ethereum has no bridge.network.json in the bridge repository (interface gap, written in the cross-area log):
// its file is DERIVED here from the two committed launch configurations at the frozen commit and is marked
// `derived` in sources.json. Nothing else is invented: every number in it is read from those two files.
//
// --check writes nothing and exits 1 when a rerun would change any file (a ref moved, or a file was edited by hand).
// No dependency, no network access.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrappedTokens } from './wrapped-tokens.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, 'deployments', 'bridges');
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const check = args.includes('--check');
const config = JSON.parse(readFileSync(join(out, 'import.config.json'), 'utf8'));
const repo = (option('--repo') ?? process.env.BRIDGE_REPO ?? config.repo).replace(/^~/, homedir());

const git = (...a) => execFileSync('git', ['-C', repo, ...a], { maxBuffer: 64 << 20 });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const show = (commit, path) => git('show', `${commit}:${path}`);
const commitOf = (ref) => git('rev-parse', '--verify', `${ref}^{commit}`).toString().trim();
const refExists = (ref) => {
  try {
    commitOf(ref);
    return true;
  } catch {
    return false;
  }
};

let changed = 0;
function put(relative, bytes) {
  const path = join(out, relative);
  const before = existsSync(path) ? readFileSync(path) : null;
  if (before && Buffer.compare(before, bytes) === 0) return;
  changed++;
  console.log(`${check ? 'would change' : 'wrote'} deployments/bridges/${relative}`);
  if (check) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}
const json = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

/** The Ethereum route's interface file, from the two launch configurations of the frozen bridge. */
function deriveEthereum(commit, entry) {
  const vault = JSON.parse(show(commit, entry.derive.vaultConfig)).vault;
  const token = JSON.parse(show(commit, entry.derive.tokenConfig));
  const template = JSON.parse(readFileSync(join(out, entry.derive.template), 'utf8'));
  const same = (a, b, what) => {
    if (String(a) !== String(b)) throw new Error(`ethereum: the two configurations disagree on ${what}`);
  };
  same(vault.cap, token.limits.supplyCap, 'the cap');
  same(vault.policy.windowLimit, token.limits.bucketCapacity, 'the window');
  same(vault.policy.l2MinBurn, token.limits.minBurn, 'the minimum burn');
  same(token.network.chainId, 700770, 'the L2 chain id');
  return {
    ...template,
    asset: { ...template.asset, id: vault.token },
    custody: { ...template.custody, contract: vault.contract },
    committee: {
      ...template.committee,
      threshold: vault.signers.threshold,
      switchThreshold: vault.policy.switchThreshold,
      pauseSeconds: vault.guard.pauseDuration,
    },
    l2: { ...template.l2, name: token.token.name, symbol: token.token.symbol },
    limits: {
      cap: String(vault.cap),
      window: String(vault.policy.windowLimit),
      windowSeconds: vault.policy.windowSeconds,
      minDeposit: String(vault.policy.minDeposit),
      maxDeposit: String(vault.policy.windowLimit),
      l2MinBurn: String(token.limits.minBurn),
      l2MaxBurn: String(token.limits.bucketCapacity),
      mintDelaySeconds: token.limits.largeMintDelay,
      largeItemThreshold: String(token.limits.largeMintThreshold),
      ...(vault.provenance.releaseDelay ? { releaseDelaySeconds: vault.provenance.releaseDelay } : {}),
    },
    fee: {
      ...template.fee,
      depositBps: vault.provenance.fees.depositBps,
      releaseBps: vault.provenance.fees.releaseBps,
      recipient: vault.provenance.fees.recipient,
    },
  };
}

const sources = [];
for (const entry of config.networks) {
  const ref = [entry.ref, ...(entry.fallbackRefs ?? [])].find(refExists);
  if (!ref) throw new Error(`${entry.id}: none of the refs exists in ${repo}: ${entry.ref}`);
  const commit = commitOf(ref);
  const target = `${entry.id}/bridge.network.json`;
  if (entry.derive) {
    const bytes = json(deriveEthereum(commit, entry));
    put(target, bytes);
    sources.push({
      network: entry.id,
      file: target,
      derived: true,
      ref,
      commit,
      from: [entry.derive.vaultConfig, entry.derive.tokenConfig].map((path) => ({
        path,
        sha256: sha256(show(commit, path)),
      })),
      template: entry.derive.template,
      sha256: sha256(bytes),
    });
  } else {
    const bytes = show(commit, entry.path);
    JSON.parse(bytes);
    put(target, bytes);
    sources.push({ network: entry.id, file: target, derived: false, ref, commit, path: entry.path, sha256: sha256(bytes) });
  }
}
{
  const ref = [config.schema.ref, ...(config.schema.fallbackRefs ?? [])].find(refExists);
  const commit = commitOf(ref);
  const bytes = show(commit, config.schema.path);
  put('schema/bridge.network.schema.json', bytes);
  sources.push({ network: null, file: 'schema/bridge.network.schema.json', derived: false, ref, commit, path: config.schema.path, sha256: sha256(bytes) });
}
put('sources.json', json({ domain: 'postern.dex.bridge-sources.v1', repository: 'bloch-l2-bridge', sources }));

// The generated token list, from the files as they now stand on disk (in --check mode: as they would stand).
const read = (relative) => JSON.parse(readFileSync(join(out, relative), 'utf8'));
if (!check || changed === 0) {
  const launch = read('launch.json');
  const page = read('page.json');
  const files = config.networks.map((entry) => read(`${entry.id}/bridge.network.json`));
  put('wrapped-tokens.json', json(wrappedTokens(files, launch, page)));
}
console.log(changed ? `${changed} file(s) ${check ? 'differ' : 'written'}` : 'up to date');
process.exit(check && changed ? 1 : 0);
