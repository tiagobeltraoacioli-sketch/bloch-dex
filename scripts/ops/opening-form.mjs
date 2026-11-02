#!/usr/bin/env node
// The owner's opening form for the WBLCH/bUSDC pair: one JSON file with the values only
// the owner can choose, checked and turned into every file and command the opening needs.
// Template: deployments/mainnet/opening-form.json. Owner page: docs/OWNER-OPENING-FORM.md.
// It sends nothing, reads no key and needs no RPC (with --rpc/--eth-rpc it also reads the
// bridge contracts and compares them with the form).
//
//   node scripts/ops/opening-form.mjs check --form F [--bloch-inc blochinc.json] [--rpc L2] [--eth-rpc ETH]
//   node scripts/ops/opening-form.mjs apply --form F --bloch-inc blochinc.json --out DIR
//        [--rpc L2] [--eth-rpc ETH] [--genesis 0x… (rehearsal only: replaces the pinned L2 genesis)]
//
// apply writes, in DIR (which must not exist):
//   dex-mainnet.config.json   for deploy-dex.mjs validate/plan/txs (checked by validateDeployConfig)
//   frontend.network.json     with bridges[0].status, and _headers with the CSP for it
//   dex-ops.env               the monitor and keeper unit values (EnvironmentFile)
//   opening.json              derived values: price in base units, cap, seed, expected shares, floor
//   OPENING-COMMANDS.md       the seed, verify, monitor and keeper commands with these values
//
// Exit status: 0 the form is complete and consistent; 2 refused (every problem is listed).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequest, isqrt, parseArgs, parseUnits } from "./dex-ops-lib.mjs";
import { PENDING, configSha256, validateDeployConfig } from "../staging/dex-deploy-config.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const FORM_DOMAIN = "postern.dex.opening-form.v1";
const WAD = 10n ** 18n;
const MINIMUM_LIQUIDITY = 1000n;
const QUOTE_DECIMALS = 6;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const ZERO = `0x${"0".repeat(40)}`;
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?(\/.*)?$/;
const EXIT_POLICIES = ["keep-floor", "full-exit"];

const pending = (v) => v === undefined || v === null || (typeof v === "string" && v.startsWith(PENDING));

/// https without credentials or fragment; plain http only on loopback (a local check).
/// The same rule as frontend/src/mainnet/config.ts safeUrl.
function urlProblem(value, field, { allowLoopback }) {
  if (typeof value !== "string" || value.length > 200) return `${field} is not a URL`;
  let url;
  try { url = new URL(value); } catch { return `${field} is not a URL`; }
  const ok = (url.protocol === "https:" || (allowLoopback && LOOPBACK.test(value))) && !url.username && !url.password && !url.hash;
  return ok ? null : `${field} must be https, without credentials or a fragment`;
}

/// The opening seed exactly as dex-seed-plan.mjs plans it on an empty pair.
export function seedAmounts({ wrappedCap, quoteCap, price, fractionBps }) {
  let wrapped = (wrappedCap * fractionBps) / 10_000n;
  let quote = (wrapped * price) / WAD;
  const quoteLimit = (quoteCap * fractionBps) / 10_000n;
  if (quote > quoteLimit) {
    quote = quoteLimit;
    wrapped = (quote * WAD) / price;
  }
  const shares = isqrt(wrapped * quote) - MINIMUM_LIQUIDITY;
  return { wrapped, quote, shares };
}

/// Check the form. Returns { problems, notes, values }; values are complete only when
/// problems is empty.
export function checkForm(form, { blochInc = null, committedConfig, wrappedCap = 10n * WAD, rehearsal = false } = {}) {
  const problems = [];
  const notes = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); return Boolean(cond); };
  const addr = (v, field) => {
    if (pending(v)) { problems.push(`${field} is not filled (${PENDING})`); return null; }
    if (!need(typeof v === "string" && ADDRESS.test(v), `${field} is not an address`)) return null;
    const a = v.toLowerCase();
    return need(a !== ZERO, `${field} is the zero address`) ? a : null;
  };
  if (!need(form && form.domain === FORM_DOMAIN && form.schemaVersion === 1, `not an opening form (domain ${FORM_DOMAIN}, schemaVersion 1)`)) return { problems, notes, values: null };

  // 1. Price and cap.
  let price = null;
  if (pending(form.openingPrice)) problems.push(`openingPrice is not filled (${PENDING})`);
  else {
    try { price = parseUnits(String(form.openingPrice), QUOTE_DECIMALS); } catch { problems.push("openingPrice must be a decimal number of bUSDC per BLCH with at most 6 decimals"); }
    if (price !== null) need(price > 0n, "openingPrice must be above 0");
  }
  const bucket = BigInt(form.fromEarlierSteps?.busdcBucketCapacity ?? "10000000000");
  let quoteCap = null;
  if (price !== null && price > 0n) {
    const balanced = (wrappedCap * price) / WAD;
    const bucketLimit = bucket / 10n;
    if (form.busdcCap === "auto" || pending(form.busdcCap)) {
      quoteCap = balanced < bucketLimit ? balanced : bucketLimit;
      notes.push(`bUSDC cap: auto = min(1/10 of the bridge bucket, 10 x price) = ${quoteCap} base units`);
    } else {
      try { quoteCap = parseUnits(String(form.busdcCap), QUOTE_DECIMALS); } catch { problems.push("busdcCap must be \"auto\" or whole bUSDC"); }
    }
  }

  // 2. Keys and addresses.
  const depositor = addr(form.firstDepositor, "firstDepositor");
  const lp = addr(form.lpRecipient, "lpRecipient");
  const keeper = addr(form.keeper?.address, "keeper.address");
  const earlier = form.fromEarlierSteps ?? {};
  const deployer = addr(earlier.dexDeployer, "fromEarlierSteps.dexDeployer");
  const token = addr(earlier.busdcToken, "fromEarlierSteps.busdcToken");
  const tokenCodeHash = pending(earlier.busdcCodeHash) ? (problems.push("fromEarlierSteps.busdcCodeHash is not filled"), null)
    : (need(HASH.test(earlier.busdcCodeHash), "fromEarlierSteps.busdcCodeHash must be a lowercase 32-byte hash") ? earlier.busdcCodeHash : null);
  const owners = Array.isArray(earlier.safeOwners) ? earlier.safeOwners.map((o, i) => addr(o, `fromEarlierSteps.safeOwners[${i}]`)) : (problems.push("fromEarlierSteps.safeOwners must list the 5 Safe owners"), []);
  const safe = blochInc?.address ? blochInc.address.toLowerCase() : null;
  if (!blochInc) notes.push("no --bloch-inc file: the Safe address is not checked against the other keys");
  if (depositor) {
    // L1 (OPS-INITIAL-LIQUIDITY.md): a single-purpose key, nothing else may share it.
    const clash = [["lpRecipient", lp], ["keeper.address", keeper], ["fromEarlierSteps.dexDeployer", deployer], ["the Bloch Inc Safe", safe], ["fromEarlierSteps.busdcToken", token],
      ...owners.map((o, i) => [`Safe owner ${i + 1}`, o])].filter(([, a]) => a === depositor);
    for (const [name] of clash) problems.push(`firstDepositor equals ${name}: the depositor must be a new key that sends only the approve and the seed`);
  }
  if (keeper && (keeper === lp || keeper === safe || owners.includes(keeper))) problems.push("keeper.address must be its own hot key (not the LP recipient, the Safe or a Safe owner)");
  if (lp && safe && lp === safe) notes.push("lpRecipient is the Safe: allowed, but the kit recommends a separate address (principal and protocol fee mix, every exit needs 3 of 5)");
  if (lp && owners.includes(lp)) notes.push("lpRecipient is a Safe owner key: allowed, but that key then holds the seed position alone");

  // 3. Seed, exit policy, floor.
  const fractionBps = BigInt(form.seed?.fractionBps ?? 5000);
  need(fractionBps > 0n && fractionBps <= 8000n, "seed.fractionBps must be 1 to 8000 (the planner refuses more, A98-OPS-2)");
  const deadlineMin = Number(form.seed?.deadlineMin ?? 120);
  need(Number.isInteger(deadlineMin) && deadlineMin >= 10 && deadlineMin <= 1440, "seed.deadlineMin must be 10 to 1440 minutes");
  const policy = form.seederExit?.policy;
  need(EXIT_POLICIES.includes(policy), `seederExit.policy must be one of ${EXIT_POLICIES.join(", ")}`);
  const floorBps = BigInt(form.seederExit?.floorBps ?? 0);
  if (policy === "keep-floor") need(floorBps >= 100n && floorBps <= 10_000n, "seederExit.floorBps must be 100 to 10000 (share of the seed position kept) with keep-floor");
  if (policy === "full-exit") need(floorBps === 0n, "seederExit.floorBps must be 0 with full-exit");

  // 4. Keeper.
  const keystore = form.keeper?.keystore; const passwordFile = form.keeper?.passwordFile;
  need(!pending(keystore) && typeof keystore === "string" && keystore.startsWith("/"), "keeper.keystore must be an absolute path on the keeper host");
  need(!pending(passwordFile) && typeof passwordFile === "string" && passwordFile.startsWith("/"), "keeper.passwordFile must be an absolute path on the keeper host");
  const budgetWei = BigInt(form.keeper?.budgetWei ?? "50000000000000000");
  const maxTx = Number(form.keeper?.maxTx ?? 48);
  need(budgetWei > 0n && Number.isInteger(maxTx) && maxTx > 0, "keeper.budgetWei and keeper.maxTx must be positive");

  // 5. Page: bridges[0].status (agent 144) and the site.
  const st = form.bridgeStatus ?? {};
  let status = null;
  if (pending(st.ethRpcUrl) || pending(st.vault)) problems.push("bridgeStatus.ethRpcUrl and bridgeStatus.vault are not filled: without them the page and the monitor do not check bUSDC exits");
  else {
    const u = urlProblem(st.ethRpcUrl, "bridgeStatus.ethRpcUrl", { allowLoopback: rehearsal });
    if (u) problems.push(u);
    const vault = addr(st.vault, "bridgeStatus.vault");
    const vaultCodeHash = st.vaultCodeHash === undefined ? PENDING : st.vaultCodeHash;
    const hashPending = vaultCodeHash !== null && pending(vaultCodeHash);
    if (hashPending) problems.push("bridgeStatus.vaultCodeHash: give the hash, or null to skip the code pin");
    else if (vaultCodeHash !== null) need(HASH.test(vaultCodeHash), "bridgeStatus.vaultCodeHash must be null or a lowercase 32-byte hash");
    if (!u && vault && token && !hashPending) status = { ethRpcUrl: st.ethRpcUrl, vault, token, vaultCodeHash };
  }
  const site = form.site ?? {};
  for (const f of ["rpcUrl", "explorerUrl", "depositUrl", "withdrawUrl", "docsUrl"]) {
    if (site[f] === undefined || site[f] === null) continue;
    if (pending(site[f])) { problems.push(`site.${f} is not filled (use null to leave it out)`); continue; }
    const u = urlProblem(site[f], `site.${f}`, { allowLoopback: rehearsal });
    if (u) problems.push(u);
  }
  need(site.rpcStatus === undefined || site.rpcStatus === "placeholder" || site.rpcStatus === "live", "site.rpcStatus must be placeholder or live");

  if (problems.length) return { problems, notes, values: null };

  const seed = seedAmounts({ wrappedCap, quoteCap, price, fractionBps });
  const floorShares = policy === "keep-floor" ? (seed.shares * floorBps) / 10_000n : 0n;
  const values = {
    price, priceText: String(form.openingPrice), quoteCap, bucket, fractionBps, deadlineMin, depositor, lp, keeper, deployer, token, tokenCodeHash,
    owners, safe, policy, floorBps, floorShares, seed, keystore, passwordFile, budgetWei, maxTx, status, site,
  };
  // The DEX configuration: the committed file with the owner's values. validateDeployConfig is the
  // same check deploy-dex.mjs validate runs, including the 75-125% band and the 1/10 bucket rule.
  if (committedConfig) {
    const c = structuredClone(committedConfig);
    c.deployer.address = deployer;
    c.firstDepositor = depositor;
    c.blochInc = blochInc ?? c.blochInc;
    Object.assign(c.reserveCaps[1], { token, codeHash: tokenCodeHash, bridgeBucketCapacity: bucket.toString(), cap: quoteCap.toString() });
    c.openingPrice.quotePerWrapped = price.toString();
    values.dexConfig = c;
    if (blochInc) {
      try { validateDeployConfig(c); values.dexConfigSha256 = configSha256(c); } catch (e) { return { problems: [`deploy-dex validate would refuse: ${e.message}`], notes, values: null }; }
    }
  }
  return { problems, notes, values };
}

/// Compare the form with the chain: the bUSDC code hash and bucket on the L2, the vault and
/// its code on Ethereum, and the token bound to that vault. Returns a list of problems.
export async function checkChain(values, { l2, eth }) {
  const problems = [];
  if (l2) {
    const code = await l2("eth_getCode", [values.token, "latest"]);
    const { keccak256 } = await import("./dex-ops-lib.mjs");
    if (code === "0x") problems.push(`no code at bUSDC ${values.token} on the L2`);
    else if (keccak256(code) !== values.tokenCodeHash) problems.push(`bUSDC code hash on the L2 is ${keccak256(code)}, the form says ${values.tokenCodeHash}`);
    const bucket = BigInt(await l2("eth_call", [{ to: values.token, data: "0xc7eba00f" }, "latest"]).catch(() => "0x0"));
    if (bucket !== 0n && bucket !== values.bucket) problems.push(`bUSDC bucketCapacity() is ${bucket}, the form says ${values.bucket}`);
  }
  if (eth && values.status) {
    const code = await eth("eth_getCode", [values.status.vault, "latest"]);
    const { keccak256 } = await import("./dex-ops-lib.mjs");
    if (code === "0x") problems.push(`no code at vault ${values.status.vault} on Ethereum`);
    else if (values.status.vaultCodeHash && keccak256(code) !== values.status.vaultCodeHash) problems.push(`vault code hash is ${keccak256(code)}, the form says ${values.status.vaultCodeHash}`);
    const finalized = await eth("eth_getBlockByNumber", ["finalized", false]).catch(() => null);
    if (!finalized) problems.push("the Ethereum RPC does not serve the finalized tag (the page and the monitor need it)");
  }
  return problems;
}

function networkFile(committed, values) {
  const n = structuredClone(committed);
  const s = values.site;
  if (s.rpcUrl) n.rpc.url = s.rpcUrl;
  if (s.rpcStatus) n.rpc.status = s.rpcStatus;
  if (s.explorerUrl !== undefined) n.explorer = { url: s.explorerUrl };
  const b = n.bridges[0];
  for (const f of ["depositUrl", "withdrawUrl", "docsUrl"]) if (s[f] !== undefined) b[f] = s[f];
  b.status = values.status;
  return n;
}

async function headersFile(network) {
  // frontend/src/mainnet/headers.ts is the generator the hosting test checks; Node 22.18+/24
  // strips its types. It needs only rpcUrl and bridges[].status.ethRpcUrl.
  const { renderHeadersFile } = await import(pathToFileURL(join(ROOT, "frontend/src/mainnet/headers.ts")).href);
  return renderHeadersFile({ rpcUrl: network.rpc.url, bridges: network.bridges });
}

function envFile(v) {
  return [
    "# Generated by scripts/ops/opening-form.mjs apply from the owner's opening form.",
    "# Goes to /etc/bloch-dex-ops/env on the monitor and keeper host (see dex-monitor.env.example).",
    "DEX_OPS_ROOT=/opt/bloch/postern-dex",
    "DEX_GATE=/etc/bloch-dex-ops/finality-gate.mainnet.json",
    "DEX_SAFE_PLAN=/etc/bloch-dex-ops/safe.plan.json",
    "DEX_RPC=http://127.0.0.1:18955",
    `DEX_ETH_RPC=${v.status.ethRpcUrl}`,
    `DEX_BUSDC_VAULT=${v.status.vault}`,
    `DEX_LP_RECIPIENT=${v.lp}`,
    `DEX_LP_MIN_SHARES=${v.floorShares}`,
    `DEX_KEEPER=${v.keeper}`,
    `DEX_KEEPER_KEYSTORE=${v.keystore}`,
    `DEX_KEEPER_PASSWORD_FILE=${v.passwordFile}`,
    "",
  ].join("\n");
}

const fmt = (x, d) => {
  const s = x.toString().padStart(d + 1, "0");
  const frac = s.slice(-d).replace(/0+$/, "");
  return frac ? `${s.slice(0, -d)}.${frac}` : s.slice(0, -d);
};

function commandsFile(v) {
  const G = "deployments/mainnet/finality-gate.mainnet.json";
  const R = "http://127.0.0.1:18955";
  const block = (cmd) => `\`\`\`\n${cmd}\n\`\`\`\n`;
  return [
    "# Opening commands with the owner's values",
    "",
    "Generated by `scripts/ops/opening-form.mjs apply`. Run them in this order, after the finality gate passes (`OPS-INITIAL-LIQUIDITY.md`). `TBD` fees are chosen at signing time (kit item 21).",
    "",
    `- Price: ${v.priceText} bUSDC per BLCH (\`openingPrice.quotePerWrapped\` ${v.price}).`,
    `- bUSDC cap: ${fmt(v.quoteCap, 6)} bUSDC (${v.quoteCap} base units). WBLCH cap: 10.`,
    `- Seed at ${Number(v.fractionBps) / 100}% of the tighter cap: ${fmt(v.seed.wrapped, 18)} WBLCH + ${fmt(v.seed.quote, 6)} bUSDC, about ${v.seed.shares} LP shares to ${v.lp}.`,
    `- Seeder exit: ${v.policy === "keep-floor" ? `keep a floor of ${Number(v.floorBps) / 100}% of the seed position, ${v.floorShares} shares (monitor \`--lp-min-shares\`)` : "a full exit is allowed (no floor; after it anyone can reprice and fill the pair, A98-5)"}.`,
    `- First depositor ${v.depositor} needs ${fmt(v.seed.wrapped, 18)} BLCH plus gas, and ${fmt(v.seed.quote, 6)} bUSDC credited before the plan (bridged a day ahead, executed by the relayer, never by this key).`,
    "",
    "1. Check the depositor is fresh (nonce 0) and funded:",
    "",
    block(`cast nonce ${v.depositor} --rpc-url ${R}`),
    block(`cast call ${v.token} "balanceOf(address)(uint256)" ${v.depositor} --rpc-url ${R}`),
    "2. Plan and write the two transactions (read-only):",
    "",
    block(`node scripts/ops/dex-seed-plan.mjs plan --config ${G} --rpc ${R} --price ${v.priceText} --to ${v.lp} --fraction-bps ${v.fractionBps} --deadline-min ${v.deadlineMin} --write-txs seed.txs.json`),
    "3. Sign and publish with the depositor's hardware wallet; `--confirm` is `txsFile.configSha256` from step 2:",
    "",
    block(`scripts/staging/sign-and-publish.sh --txs seed.txs.json --rpc ${R} --confirm TBD --max-fee-wei TBD --priority-fee-wei TBD --hashes-out seed.hashes.txt -- --ledger`),
    "4. Verify right after inclusion, and again once finalized, before any announcement:",
    "",
    block(`node scripts/ops/dex-seed-plan.mjs verify --config ${G} --rpc ${R} --price ${v.priceText} --to ${v.lp}`),
    "5. Monitor (the unit runs the same with `dex-ops.env`):",
    "",
    block(`node scripts/ops/dex-monitor.mjs --config ${G} --safe-plan deployments/mainnet/700770/safe.plan.json --rpc ${R} --expect-seeded --lp-recipient ${v.lp} --lp-min-shares ${v.floorShares} --eth-rpc ${v.status.ethRpcUrl} --bridge-vault ${v.status.vault}${v.status.vaultCodeHash ? ` --bridge-vault-code-hash ${v.status.vaultCodeHash}` : ""} --bridge-token ${v.token} --ref-price ${v.priceText}`),
    "6. Keeper, dry run first:",
    "",
    block(`node scripts/ops/dex-skim-keeper.mjs --config ${G} --rpc ${R} --keeper ${v.keeper} --state /var/lib/bloch-dex-keeper/state.json --budget-wei ${v.budgetWei} --max-tx ${v.maxTx} --eth-rpc ${v.status.ethRpcUrl} --bridge-vault ${v.status.vault}`),
    "",
  ].join("\n");
}

const json = (v) => `${JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2)}\n`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [command] = args._;
  if (!["check", "apply"].includes(command) || !args.form || (command === "apply" && (!args.out || !args["bloch-inc"]))) {
    console.error("usage: opening-form.mjs check --form F [--bloch-inc blochinc.json] [--rpc L2] [--eth-rpc ETH]\n       opening-form.mjs apply --form F --bloch-inc blochinc.json --out DIR [--rpc L2] [--eth-rpc ETH] [--genesis 0x… (rehearsal)]");
    return 2;
  }
  const form = JSON.parse(readFileSync(args.form, "utf8"));
  const blochInc = args["bloch-inc"] ? JSON.parse(readFileSync(args["bloch-inc"], "utf8")) : null;
  const committedConfig = JSON.parse(readFileSync(join(ROOT, "deployments/mainnet/dex-mainnet.config.json"), "utf8"));
  const rehearsal = Boolean(args.genesis);
  if (rehearsal) {
    if (!HASH.test(args.genesis)) { console.error("--genesis must be a lowercase 32-byte hash"); return 2; }
    committedConfig.network.genesisHash = args.genesis;
  }
  const { problems, notes, values } = checkForm(form, { blochInc, committedConfig, rehearsal });
  if (values && (args.rpc || args["eth-rpc"])) {
    problems.push(...await checkChain(values, { l2: args.rpc ? createRequest(args.rpc) : null, eth: args["eth-rpc"] ? createRequest(args["eth-rpc"]) : null }));
  }
  if (problems.length) {
    console.log(json({ decision: "refuse", problems, notes }));
    return 2;
  }
  const opening = {
    decision: command === "apply" ? "written" : "complete",
    rehearsalGenesis: rehearsal ? args.genesis : undefined,
    price: { text: values.priceText, quotePerWrapped: values.price },
    busdcCap: values.quoteCap,
    seed: { fractionBps: values.fractionBps, wrapped: values.seed.wrapped, quote: values.seed.quote, expectedShares: values.seed.shares, human: `${fmt(values.seed.wrapped, 18)} WBLCH + ${fmt(values.seed.quote, 6)} bUSDC` },
    seederExit: { policy: values.policy, floorBps: values.floorBps, floorShares: values.floorShares },
    firstDepositor: values.depositor, lpRecipient: values.lp, keeper: values.keeper,
    bridgeStatus: values.status, dexConfigSha256: values.dexConfigSha256, notes,
  };
  if (command === "apply") {
    if (existsSync(args.out)) { console.error(`${args.out} exists; write a new directory`); return 2; }
    mkdirSync(args.out, { recursive: true });
    const network = networkFile(JSON.parse(readFileSync(join(ROOT, "deployments/mainnet/frontend.network.json"), "utf8")), values);
    writeFileSync(join(args.out, "dex-mainnet.config.json"), json(values.dexConfig));
    writeFileSync(join(args.out, "frontend.network.json"), json(network));
    writeFileSync(join(args.out, "_headers"), await headersFile(network));
    writeFileSync(join(args.out, "dex-ops.env"), envFile(values));
    writeFileSync(join(args.out, "OPENING-COMMANDS.md"), commandsFile(values));
    writeFileSync(join(args.out, "opening.json"), json(opening));
  }
  console.log(json(opening));
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (error) => { console.error(`opening-form: ${error.message}`); process.exit(2); });
}
