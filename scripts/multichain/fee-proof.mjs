#!/usr/bin/env node
// Proof that the owner controls the fee address (docs/MULTICHAIN-DEPLOY.md, section 2, "The fee address").
// OFFLINE: no RPC, no network, no subprocess. It never sees a key: the owner signs one message in their own wallet.
//
//   node scripts/multichain/fee-proof.mjs message                    print the exact text to sign (one line)
//   node scripts/multichain/fee-proof.mjs record --signature 0x…     verify the signature and write deployments/fee-address-proof.json
//   node scripts/multichain/fee-proof.mjs verify                     verify the recorded proof again
//   node scripts/multichain/fee-proof.mjs page --out DIR             write DIR/index.html: a page that asks a browser
//                                                                    wallet to sign the text (for a wallet that has no
//                                                                    "sign message" of its own); serve it on loopback
//
// The factory's `feeTo` can never be changed, and it is the same address on all six chains. An externally owned
// address is controlled by the same key on every EVM chain, so ONE signature proves it everywhere: no transaction
// on any chain is needed. The message is EIP-191 `personal_sign` text (what every wallet's "sign message" does):
// fixed, domain-separated, one line of printable ASCII naming the address, the six chain ids and the purpose. It is
// not a transaction, has no nonce and cannot be replayed as anything but itself.
//
// Verification is done here, in this process (secp256k1 public-key recovery by the library the page already
// bundles), and is strict: the signature is exactly 65 bytes r || s || v; r and s are in range; s is in the lower
// half of the curve order (EIP-2: one signature per message and key, no malleable twin); v is 27 or 28; the recovered
// address equals the fee address. A wallet that answers with anything else (an ERC-1271 or ERC-6492 contract
// signature, a 64-byte compact form, v of 0 or 1) is refused: sign with the key itself. No decision is ever taken
// from another program's exit code.
// Exit status: 0 valid, 1 not valid or not recorded, 2 usage or configuration.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMain } from "../staging/is-main.mjs";
import { FEE_PROOF_DOMAIN, FEE_PROOF_FILE, MultichainError, ROOT, loadChain, loadShared, lower, refuse } from "./lib.mjs";

const requireFromFrontend = createRequire(new URL("../../frontend/package.json", import.meta.url));
const { hashMessage, recoverAddress } = requireFromFrontend("viem");

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** The exact text the fee address signs. Pure: the address as EIP-55 writes it, the chain ids in the file's order. */
export function feeProofMessage(address, chainIds) {
  refuse(/^0x[0-9a-fA-F]{40}$/.test(address) && chainIds.length > 0 && chainIds.every((id) => Number.isSafeInteger(id) && id > 0), "the proof message needs the fee address and the chain ids");
  return `PosternDEX fee address proof (${FEE_PROOF_DOMAIN}). I control the address ${address} and name it as the protocol fee recipient (feeTo) of the PosternDEX factory on the chains with ids ${chainIds.join(", ")}. This message is not a transaction and authorizes no transfer and no approval.`;
}

/**
 * Verify a signature of `message` strictly. Returns { valid, problems, signer }. Never throws for a bad signature.
 */
export async function verifySignature({ address, message, signature }) {
  const problems = [];
  if (typeof signature !== "string" || !/^0x[0-9a-f]*$/.test(signature)) return { valid: false, problems: ["the signature is not lowercase hex beginning with 0x"], signer: null };
  if (signature.length !== 2 + 130) return { valid: false, problems: [`the signature is ${(signature.length - 2) / 2} bytes, not 65 (r, s, v). A smart-account signature (ERC-1271, ERC-6492) or a compact one is not accepted: sign with the key itself`], signer: null };
  const r = BigInt(`0x${signature.slice(2, 66)}`);
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = Number.parseInt(signature.slice(130, 132), 16);
  if (r === 0n || r >= SECP256K1_N) problems.push("r is out of range");
  if (s === 0n || s >= SECP256K1_N) problems.push("s is out of range");
  else if (s > SECP256K1_N / 2n) problems.push("s is in the upper half of the curve order (a malleable form; wallets produce the lower one)");
  if (v !== 27 && v !== 28) problems.push(`v is ${v}, not 27 or 28`);
  if (problems.length) return { valid: false, problems, signer: null };
  let signer = null;
  try {
    signer = await recoverAddress({ hash: hashMessage(message), signature: { r: `0x${signature.slice(2, 66)}`, s: `0x${signature.slice(66, 130)}`, yParity: v - 27 } });
  } catch (error) {
    return { valid: false, problems: [`no public key can be recovered from the signature (${String(error?.shortMessage ?? error?.message ?? error).slice(0, 80)})`], signer: null };
  }
  if (lower(signer) !== lower(address)) problems.push(`the signature is by ${signer}, not by the fee address ${address}. Sign the exact text that \`fee-proof.mjs message\` prints, as a message (not typed data), with the fee address's own key`);
  return { valid: problems.length === 0, problems, signer };
}

/**
 * A self-contained page that asks the browser's wallet for a personal_sign of the message by the fee address and
 * shows the signature. It loads nothing from anywhere, sends nothing anywhere and asks for no transaction; what it
 * shows is checked afterwards by `record`, so the page itself need not be trusted. Pure.
 */
export function signingPage(address, message) {
  const hex = `0x${Buffer.from(message, "utf8").toString("hex")}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Sign the fee address proof</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem}pre{white-space:pre-wrap;word-break:break-all;background:#f3f3f3;padding:1rem}button{font:inherit;padding:.5rem 1rem}</style></head>
<body><h1>Sign the fee address proof</h1>
<p>This page asks your wallet to sign one message with the account <code>${address}</code>. It is not a transaction, costs nothing and sends nothing. Compare the text your wallet shows with this text before you confirm:</p>
<pre id="message"></pre>
<p><button id="sign">Connect the wallet and sign</button></p>
<p id="status"></p><pre id="signature"></pre>
<script>
const ADDRESS = ${JSON.stringify(address)};
const MESSAGE = ${JSON.stringify(message)};
const HEX = ${JSON.stringify(hex)};
document.getElementById("message").textContent = MESSAGE;
const say = (text) => { document.getElementById("status").textContent = text; };
document.getElementById("sign").addEventListener("click", async () => {
  try {
    if (!window.ethereum) return say("No browser wallet was found on this page. Open it as http://127.0.0.1:PORT/ in the browser that has the wallet.");
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    const account = accounts.find((a) => a.toLowerCase() === ADDRESS.toLowerCase());
    if (!account) return say("The wallet did not offer the account " + ADDRESS + ". Select that account in the wallet and try again.");
    const signature = await window.ethereum.request({ method: "personal_sign", params: [HEX, account] });
    document.getElementById("signature").textContent = signature;
    say("Signed. Copy the signature below and run: node scripts/multichain/fee-proof.mjs record --signature <the signature>");
  } catch (error) {
    say("Not signed: " + (error && error.message ? error.message : error));
  }
});
</script></body></html>
`;
}

/** The six chain ids, in the order of deployments/multichain.json. */
export const chainIdsOf = (shared, root = ROOT) => shared.chains.map((key) => loadChain(key, root).chain.chainId);

/**
 * Verify a proof file's content against the configuration. Returns { valid, problems, signer }.
 * The message is rebuilt from the configuration: a proof for another address, another chain list or another text
 * is not this deployment's proof.
 */
export async function verifyFeeProof(shared, chainIds, proof) {
  if (!proof || typeof proof !== "object") return { valid: false, problems: ["no proof is recorded"], signer: null };
  const message = feeProofMessage(shared.feeTo.address, chainIds);
  const problems = [];
  if (proof.schemaVersion !== 1 || proof.domain !== FEE_PROOF_DOMAIN) problems.push("the proof file is not a fee address proof of this version");
  if (proof.address !== shared.feeTo.address) problems.push(`the proof is for ${proof.address}, not for the fee address ${shared.feeTo.address}`);
  if (JSON.stringify(proof.chainIds) !== JSON.stringify(chainIds)) problems.push("the proof names other chain ids than deployments/multichain.json");
  if (proof.message !== message) problems.push("the proof's message is not the text this configuration asks for");
  if (problems.length) return { valid: false, problems, signer: null };
  return verifySignature({ address: shared.feeTo.address, message, signature: proof.signature });
}

/** Read and verify deployments/fee-address-proof.json. Offline. */
export async function loadFeeProof(shared, root = ROOT) {
  const path = join(root, FEE_PROOF_FILE);
  if (!existsSync(path)) return { valid: false, problems: [`${FEE_PROOF_FILE} does not exist: the owner signs the text of \`node scripts/multichain/fee-proof.mjs message\` with the fee address and records it with \`fee-proof.mjs record --signature 0x…\``], signer: null };
  let proof;
  try {
    proof = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { valid: false, problems: [`${FEE_PROOF_FILE} is not JSON`], signer: null };
  }
  return verifyFeeProof(shared, chainIdsOf(shared, root), proof);
}

export async function main(argv, print = console.log) {
  const usage = "usage: fee-proof.mjs message | record --signature 0xSIGNATURE | verify | page --out DIR";
  const [mode, ...rest] = argv;
  refuse(["message", "record", "verify", "page"].includes(mode), usage);
  const shared = loadShared();
  const chainIds = chainIdsOf(shared);
  const message = feeProofMessage(shared.feeTo.address, chainIds);
  if (mode === "message") {
    refuse(rest.length === 0, usage);
    print(message);
    return 0;
  }
  if (mode === "page") {
    refuse(rest.length === 2 && rest[0] === "--out", usage);
    mkdirSync(rest[1], { recursive: true });
    writeFileSync(join(rest[1], "index.html"), signingPage(shared.feeTo.address, message));
    print(`wrote ${join(rest[1], "index.html")}. Serve it on this machine only and open it in the browser that has the wallet:`);
    print(`python3 -m http.server 8765 --bind 127.0.0.1 --directory ${rest[1]}`);
    print("then open http://127.0.0.1:8765/ , sign, and stop the server with Ctrl-C");
    return 0;
  }
  if (mode === "verify") {
    refuse(rest.length === 0, usage);
    const result = await loadFeeProof(shared);
    for (const p of result.problems) print(`FAIL ${p}`);
    print(`fee address proof: ${result.valid ? `VALID (signed by ${result.signer}, the fee address, for chain ids ${chainIds.join(", ")})` : "NOT VALID"}`);
    return result.valid ? 0 : 1;
  }
  refuse(rest.length === 2 && rest[0] === "--signature", usage);
  const signature = rest[1].trim().toLowerCase();
  const result = await verifySignature({ address: shared.feeTo.address, message, signature });
  if (!result.valid) {
    for (const p of result.problems) print(`FAIL ${p}`);
    print("fee address proof: NOT VALID; nothing was written");
    return 1;
  }
  const proof = { schemaVersion: 1, domain: FEE_PROOF_DOMAIN, address: shared.feeTo.address, chainIds, scheme: "EIP-191 personal_sign, secp256k1, 65 bytes r || s || v", message, signature, recorded: new Date().toISOString().slice(0, 10) };
  writeFileSync(join(ROOT, FEE_PROOF_FILE), `${JSON.stringify(proof, null, 2)}\n`);
  print(`fee address proof: VALID (signed by ${result.signer}); written to ${FEE_PROOF_FILE}. Commit that file.`);
  return 0;
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof MultichainError ? error.message : error);
      process.exit(2);
    },
  );
}
