// Tests of the owner's deployment document and its dry-run parser (docs/OWNER-DEPLOY-NOW.md,
// scripts/multichain/owner-dry-run.mjs). Offline: no RPC, no fork.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHAIN_STEPS, DOC, ONCE_STEPS, ORDER, blocksOf, fundingOf } from "./owner-dry-run.mjs";
import { ROOT, loadChain, loadShared } from "./lib.mjs";

const text = readFileSync(join(ROOT, DOC), "utf8");
const blocks = blocksOf(text);

test("every step the dry run expects has its block, for the once section and each of the six chains", () => {
  for (const s of ONCE_STEPS) assert.ok(blocks[`once ${s}`], `once ${s}`);
  for (const key of ORDER) for (const s of CHAIN_STEPS) assert.ok(blocks[`${key} ${s}`], `${key} ${s}`);
  assert.equal(Object.keys(blocks).length, ONCE_STEPS.length + ORDER.length * CHAIN_STEPS.length);
});

test("the chains are in the order the document states (cheapest first) and match deployments/multichain.json", () => {
  const shared = loadShared();
  assert.deepEqual([...ORDER].sort(), [...shared.chains].sort());
  const positions = ORDER.map((k) => text.indexOf(`(\`${k}\`, chain id`));
  assert.ok(positions.every((p, i) => p > 0 && (i === 0 || p > positions[i - 1])), positions.join(","));
});

test("no block carries a private key, a key on the command line, a comment, or a public URL where a cast send goes", () => {
  for (const [k, cmd] of Object.entries(blocks)) {
    assert.ok(!/--private-key|--mnemonic|0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/.test(cmd), k);
    assert.ok(!/(^|\s)#/.test(cmd), k);
  }
  for (const key of ORDER) {
    assert.match(blocks[`${key} deploy-broadcast`], /^scripts\/multichain\/deploy\.sh \S+ broadcast -- --keystore ~\/Desktop\/DEX-CHAVE-DEPLOY\/deployer$/);
    assert.match(blocks[`${key} send-suffix`], /^--keystore ~\/Desktop\/DEX-CHAVE-DEPOSITANTE\/depositante --rpc-url https:\/\/\S+$/);
    assert.ok(blocks[`${key} send-suffix`].endsWith(loadChain(key).rpc[0]), `${key}: the send endpoint is the chain's first reviewed endpoint`);
  }
});

test("each chain's blocks name that chain, its pair and its depositing account, never another chain's", () => {
  const shared = loadShared();
  for (const key of ORDER) {
    const chain = loadChain(key);
    const pair = `${chain.wrappedNative.symbol}/${chain.tokens[0].symbol}`;
    for (const s of ["pre-gate", "deploy-dry-run", "deploy-broadcast", "post-gate-deployed", "market", "prepare", "verify", "post-gate-open", "frontend-record"]) assert.ok(blocks[`${key} ${s}`].includes(` ${key} `) || blocks[`${key} ${s}`].endsWith(` ${key}`) || blocks[`${key} ${s}`].includes(`/${key}/`), `${key} ${s}`);
    for (const other of ORDER.filter((o) => o !== key)) for (const s of CHAIN_STEPS) assert.ok(!blocks[`${key} ${s}`].includes(` ${other} `) && !blocks[`${key} ${s}`].includes(`deployments/${other}/`), `${key} ${s} names ${other}`);
    for (const s of ["prepare", "verify"]) assert.ok(blocks[`${key} ${s}`].includes(`--pair ${pair}`), `${key} ${s}`);
    assert.ok(blocks[`${key} depositor-native`].includes(shared.firstDepositor), key);
    assert.ok(blocks[`${key} prepare`].includes(`--native ${chain.openingPrice.minimumNative} `), `${key}: the example amount is the chain's minimum`);
  }
});

test("the funding amounts are stated for every chain in the form the dry run reads", () => {
  for (const key of ORDER) {
    const f = fundingOf(text, key, loadChain(key).nativeCurrency.symbol);
    assert.ok(Number(f.deployer) > 0 && Number(f.allowance) > 0, key);
  }
});

test("blocksOf refuses a block that appears twice or spans two lines", () => {
  assert.throws(() => blocksOf("<!-- run: once a -->\n```\nx\n```\n<!-- run: once a -->\n```\ny\n```\n"), /appears twice/);
  assert.throws(() => blocksOf("<!-- run: once a -->\n```\nx\ny\n```\n"), /one line/);
  assert.throws(() => blocksOf("<!-- run: once a -->\n```\nx # note\n```\n"), /one line without a comment/);
});
