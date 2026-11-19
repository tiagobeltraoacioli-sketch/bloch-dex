// Tests of the owner's deployment document and its dry-run parser (docs/OWNER-DEPLOY-NOW.md,
// scripts/multichain/owner-dry-run.mjs). Offline: no RPC, no fork.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHAIN_STEPS, COMMIT_PLACEHOLDER, DOC, ONCE_STEPS, ORDER, OWNER_TOOLS, TOOLCHAIN_SCRIPT, blocksOf, fundingOf, pinnedFiles } from "./owner-dry-run.mjs";
import { ROOT, loadChain, loadShared } from "./lib.mjs";

const text = readFileSync(join(ROOT, DOC), "utf8");
const blocks = blocksOf(text);

test("every step the dry run expects has its block, for the once section and each of the six chains", () => {
  for (const s of ONCE_STEPS) assert.ok(blocks[`once ${s}`], `once ${s}`);
  for (const key of ORDER) for (const s of CHAIN_STEPS) assert.ok(blocks[`${key} ${s}`], `${key} ${s}`);
  assert.equal(Object.keys(blocks).length, ONCE_STEPS.length + ORDER.length * CHAIN_STEPS.length);
  assert.ok(/Send them only with `cast`/.test(text) && /never accept "switch to smart account"/.test(text), "step 7 warns against browser wallets and batched sends (review R369-3)");
});

test("the chains are in the order the document states (cheapest first) and match deployments/multichain.json", () => {
  const shared = loadShared();
  assert.deepEqual([...ORDER].sort(), [...shared.chains].sort());
  // Phase A (section 4: deploy) on all six, then phase B (section 5: open the pools), each in the same order;
  // every deployment comes before the first opening (review R369-4).
  const deploy = ORDER.map((k) => text.indexOf(`(\`${k}\`, chain id ${loadChain(k).chain.chainId}): deploy`));
  const open = ORDER.map((k) => text.indexOf(`(\`${k}\`, chain id ${loadChain(k).chain.chainId}): open the pool`));
  for (const list of [deploy, open]) assert.ok(list.every((p, i) => p > 0 && (i === 0 || p > list[i - 1])), list.join(","));
  assert.ok(Math.max(...deploy) < Math.min(...open));
  for (const k of ORDER) {
    assert.ok(text.indexOf(`<!-- run: ${k} post-gate-deployed -->`) < Math.min(...open), `${k}: step 5 is in phase A`);
    assert.ok(text.indexOf(`<!-- run: ${k} market -->`) > Math.max(...deploy), `${k}: step 6 is in phase B`);
  }
});

test("every documented cast send names its chain (review R369-10)", () => {
  for (const line of text.split("\n").filter((l) => /^cast send /.test(l))) assert.match(line, /--chain /, line);
});

test("no block carries a private key, a key on the command line, a comment, or a public URL where a cast send goes", () => {
  for (const [k, cmd] of Object.entries(blocks)) {
    assert.ok(!/--private-key|--mnemonic|0x[0-9a-fA-F]{64}(?![0-9a-fA-F])/.test(cmd), k);
    assert.ok(!/(^|\s)#/.test(cmd), k);
  }
  for (const key of ORDER) {
    assert.match(blocks[`${key} deploy-broadcast`], /^scripts\/multichain\/deploy\.sh \S+ broadcast -- --keystore "\$DEX_DEPLOYER_KEYSTORE_DIR\/deployer"$/);
    assert.ok(!text.includes(`<!-- run: ${key} send-suffix -->`), `${key}: the suffix is inline text, not a block to paste (review R369-11)`);
    assert.match(blocks[`${key} send-suffix`], /^--keystore "\$DEX_DEPOSITOR_KEYSTORE_DIR\/depositante" --rpc-url https:\/\/\S+$/);
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

test("no keystore folder of the owner's machine is named (H398-3)", () => {
  assert.ok(!new RegExp(["CH", "AVE"].join("") + "|~/Desktop/DEX-").test(text));
});

test("blocksOf refuses a block that appears twice or spans two lines", () => {
  assert.throws(() => blocksOf("<!-- run: once a -->\n```\nx\n```\n<!-- run: once a -->\n```\ny\n```\n"), /appears twice/);
  assert.throws(() => blocksOf("<!-- run: once a -->\n```\nx\ny\n```\n"), /one line/);
  assert.throws(() => blocksOf("<!-- run: once a -->\n```\nx # note\n```\n"), /one line without a comment/);
});

test("the owner installs his own tools and checks their SHA-256 before the first step that touches a key (review R369-16)", () => {
  // The three blocks, exactly: macOS's own bash, the script of the owner's clone, the owner-only directory.
  assert.equal(blocks["once tools-install"], `/bin/bash ${TOOLCHAIN_SCRIPT} install ${OWNER_TOOLS[0]}`);
  assert.equal(blocks["once tools-check"], `/bin/bash ${TOOLCHAIN_SCRIPT} check ${OWNER_TOOLS[0]}`);
  // R402-1: the tools and macOS's own four directories, nothing of the terminal's earlier PATH.
  assert.equal(blocks["once env-path"], `export PATH="${OWNER_TOOLS[1]}/bin:/usr/bin:/bin:/usr/sbin:/sbin"`);
  for (const [k, cmd] of Object.entries(blocks)) assert.ok(!/\$PATH|\$\{PATH/.test(cmd), `${k} keeps the terminal's PATH`);
  assert.equal(blocks["once tools-type"], "type forge cast anvil node npm");
  // R402-4, restated in round 19 by agent 400 (401's assertion accepted `TBD-integrator` or an id written in the
  // page): the commit is compared in full in both places, and the reviewed id is NOT in the page (a commit cannot
  // contain its own id; an altered copy could state any id). The owner pastes the id he received outside the
  // repository over a placeholder that the lines refuse when left as printed (reviewed-commit.test.mjs runs them).
  assert.equal(blocks["once clone-commit"], `[ "$(/usr/bin/git -C ~/postern-dex rev-parse HEAD)" = "${COMMIT_PLACEHOLDER}" ] && echo "reviewed commit: MATCH" || echo "reviewed commit: MISMATCH; stop and run nothing from this copy"`);
  assert.equal(blocks["once reviewed-commit"], `/bin/bash scripts/multichain/reviewed-commit.sh ${COMMIT_PLACEHOLDER}`);
  assert.ok(!/git[^\n]*log -1 --oneline/.test(text) && !/when this was written/.test(text));
  assert.ok(!text.includes("TBD-integrator"));
  assert.ok(!/reviewed commit[^\n]{0,80}`[0-9a-f]{7,40}`/.test(text), "no commit id is stated as the reviewed one");
  assert.match(text, /\*\*The reviewed commit id is not written in this page, on purpose\.\*\*/);
  assert.match(text, /\*\*On `MISMATCH`, stop\*\*/);
  assert.match(text, /\*\*On `FAIL`, stop here\*\*/);
  // The first comparison runs nothing from the clone: git by absolute path and shell builtins only.
  assert.ok(!/postern-dex\/scripts|node |bash /.test(blocks["once clone-commit"]));
  // R402-3: the packages and the build come before the first block that reads the built code.
  assert.equal(blocks["once npm-ci"], "npm --prefix frontend ci --ignore-scripts");
  assert.equal(blocks["once forge-build"], "forge build");
  // R402-1: every tool of the kit is started as `node <file>` or by /bin/bash or its own #!/bin/bash, never through
  // a `#!/usr/bin/env` line resolved on the PATH.
  for (const [k, cmd] of Object.entries(blocks)) assert.ok(!/^scripts\/\S+\.mjs/.test(cmd), k);
  assert.ok(readFileSync(join(ROOT, "scripts/multichain/deploy.sh"), "utf8").startsWith("#!/bin/bash\n"));
  assert.ok(readFileSync(join(ROOT, "scripts/multichain/owner-toolchain.sh"), "utf8").startsWith("#!/bin/bash\n"));
  // R402-5: the text says the scripts check again by themselves.
  assert.match(text, /`deploy\.sh` \(steps 3 and 4\) and `first-deposit\.mjs prepare` \(step 7\) run the same check again by themselves/);
  // Neither rehearsal flag of the script is in the owner's blocks.
  for (const [k, cmd] of Object.entries(blocks)) assert.ok(!/--no-run|--platform|--from /.test(cmd), k);
  // Order: clone, its commit, install, PATH, check, type; all before anything that signs, unlocks or creates a key.
  const at = (step) => text.indexOf(`<!-- run: once ${step} -->`);
  const order = ["clone", "clone-commit", "no-agents", "tools-install", "env-path", "tools-check", "tools-type", "reviewed-commit", "npm-ci", "forge-build", "kit-tests", "check-depositor", "plan"].map(at);
  assert.ok(order.every((p, i) => p > 0 && (i === 0 || p > order[i - 1])), order.join(","));
  // The first command block (marked or not) that names a keystore, a wallet, a signature or a send.
  const firstKeyUse = [...text.matchAll(/```\n([\s\S]*?)\n```/g)].find((m) => /cast wallet|--keystore|--ledger|KEYSTORE_DIR|fee-proof\.mjs (record|page)|deploy\.sh|cast send/.test(m[1]));
  assert.ok(firstKeyUse && firstKeyUse[1].startsWith("export DEX_DEPOSITOR_KEYSTORE_DIR="), firstKeyUse?.[1]);
  assert.ok(at("tools-type") < firstKeyUse.index, "the check comes before the first key use");
  // No block uses the agent-installed directory; the text names it only to say it is not used.
  for (const [k, cmd] of Object.entries(blocks)) assert.ok(!cmd.includes(".local/share"), k);
  assert.equal(text.split(".local/share/dex-tools").length - 1, 1);
  assert.match(text, /in particular not the one in `~\/\.local\/share\/dex-tools\/`/);
  // The rules the owner must read: every new terminal, exact PASS line, stop on FAIL, no agent while signing.
  assert.match(text, /In \*\*every new terminal\*\* you use for this guide, first these three lines/);
  assert.match(text, /The last line must be exactly `owner tools: PASS`\. \*\*On any `FAIL`, type no password and confirm nothing in a\nwallet\*\*/);
  assert.match(text, /\*\*No agent while you sign\.\*\*/);
  assert.equal(blocks["once no-agents"], 'pgrep -lf -i "claude|codex"');
});

test("the pins the dry run compares a stand-in with are the committed ones, for both platforms", () => {
  for (const platform of ["darwin-x64", "darwin-arm64"]) {
    const pins = pinnedFiles(platform);
    for (const f of ["foundry/forge", "foundry/cast", "foundry/anvil", "node/bin/node"]) assert.match(pins[f] ?? "", /^[0-9a-f]{64}$/, `${platform} ${f}`);
  }
  assert.deepEqual(pinnedFiles("darwin-x64", "darwin-x64 file aa foundry/forge\ndarwin-arm64 file bb foundry/forge\ndarwin-x64 tree cc .\n"), { "foundry/forge": "aa" });
});

// Round 20 (follow-up): section 8B, the second pool. Its blocks are marked `second-pool:` and the dry run of a
// chain with a second planned pair executes them after the first pool's.
test("section 8B: the dry run's expected blocks exist for the once part and for each chain with a second planned pair, and for no other chain", async () => {
  const { SECOND_CHAIN_STEPS, SECOND_ONCE_STEPS, secondBlocksOf } = await import("./owner-dry-run.mjs");
  const second = secondBlocksOf(text);
  const withSecond = ORDER.filter((k) => loadChain(k).initialPairs.length > 1);
  assert.deepEqual(withSecond, ["op-mainnet", "arbitrum-one", "bnb-smart-chain", "ethereum"]);
  assert.deepEqual(Object.keys(second), [...SECOND_ONCE_STEPS.map((s) => `once ${s}`), ...withSecond.flatMap((k) => SECOND_CHAIN_STEPS.map((s) => `${k} ${s}`))]);
  // The blocks of sections 2, 4 and 5 are not touched by section 8B: the same 116 as before.
  assert.equal(Object.keys(blocks).length, 116);
  assert.throws(() => secondBlocksOf("<!-- second-pool: once fetch -->\n```\ngit fetch origin > out.txt\n```"), /one line without a comment or an angle bracket/);
});
