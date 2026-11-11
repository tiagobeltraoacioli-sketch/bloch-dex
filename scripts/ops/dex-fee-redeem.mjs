#!/usr/bin/env node
// Prepares a protocol-fee redemption by the Bloch Inc Safe. It sends nothing and
// holds no key: the owners sign the EIP-712 files it writes on their own devices.
// Runbook: docs/OPS-FEE-REDEMPTION.md.
//
// The path is router.removeLiquidity, which moves the LP shares and burns them
// in one call. A `transfer` to the pair followed by `burn` as two Safe
// transactions is NOT safe: for the time between them anyone can call
// burn(<their own address>) and take the shares' value.
//
//   plan      read the Safe's LP balance, write one typed-data file per Safe
//             transaction (approve, then removeLiquidity), cross-check each hash
//             against the Safe's own getTransactionHash
//   assemble  check the owners' signatures and print the execTransaction calldata
//
//   node scripts/ops/dex-fee-redeem.mjs plan --config gate.json --rpc URL --out DIR
//        [--liquidity N] [--slippage-bps 100] [--deadline-h 24]
//   node scripts/ops/dex-fee-redeem.mjs assemble --config gate.json --tx DIR/safe-tx-N.json
//        --sig 0x… --sig 0x… --sig 0x…

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CRIT, OK, RpcError, UNKNOWN, ZERO_ADDRESS,
  blockRef, call, checkIdentity, createRequest, deploymentFromGate, encode, encodeFunctionData, ABI, hashTypedData,
  parseArgs, readBlock, readGate, readPair, recoverAddress, stringify,
} from "./dex-ops-lib.mjs";
import { isMain } from "../staging/is-main.mjs";

export function safeTxTypedData({ chainId, safe, to, data, nonce }) {
  return {
    types: {
      EIP712Domain: [
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      SafeTx: [
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
        { name: "operation", type: "uint8" },
        { name: "safeTxGas", type: "uint256" },
        { name: "baseGas", type: "uint256" },
        { name: "gasPrice", type: "uint256" },
        { name: "gasToken", type: "address" },
        { name: "refundReceiver", type: "address" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "SafeTx",
    domain: { chainId, verifyingContract: safe },
    message: {
      to,
      value: "0",
      data,
      operation: 0,
      safeTxGas: "0",
      baseGas: "0",
      gasPrice: "0",
      gasToken: ZERO_ADDRESS,
      refundReceiver: ZERO_ADDRESS,
      nonce: nonce.toString(),
    },
  };
}

export const safeTxHash = (typed) => hashTypedData(typed);

/// What the burn pays for `liquidity` shares, from the reserves. `pending` is the
/// fee the same burn mints first; it dilutes the supply and stays in the Safe.
export function redemptionMinimums({ liquidity, totalSupply, pending, reserve0, reserve1, slippageBps }) {
  const supply = totalSupply + pending;
  const amount0 = (liquidity * reserve0) / supply;
  const amount1 = (liquidity * reserve1) / supply;
  const keep = 10_000n - slippageBps;
  return { amount0, amount1, min0: (amount0 * keep) / 10_000n, min1: (amount1 * keep) / 10_000n };
}

async function plan(args, deployment) {
  const request = createRequest(args.rpc);
  await checkIdentity(request, deployment);
  const latest = await readBlock(request, "latest");
  const at = blockRef(latest);
  const safe = deployment.feeTo;
  const pair = deployment.pairs.find((p) => !args.pair || p.address === args.pair.toLowerCase());
  if (!pair) throw new Error("the pair is not in the gate file");
  const state = await readPair(request, pair, at);
  const position = await call(request, deployment.lens.address, "position", [pair.address, safe], at);
  const held = position.liquidity;
  const liquidity = args.liquidity ? BigInt(args.liquidity) : held;
  if (held === 0n) {
    console.log(stringify({
      decision: "nothing-minted",
      detail: "The Safe holds no LP shares yet. The fee is minted lazily, at the next mint or burn by any LP. There is nothing to sign.",
      pendingLiquidity: position.pendingProtocolLiquidity,
    }));
    return OK;
  }
  if (liquidity === 0n || liquidity > held) throw new Error(`--liquidity must be between 1 and the Safe's ${held}`);
  const minimums = redemptionMinimums({
    liquidity,
    totalSupply: state.totalSupply,
    pending: position.pendingProtocolLiquidity,
    reserve0: state.sides[0].reserve,
    reserve1: state.sides[1].reserve,
    slippageBps: BigInt(args["slippage-bps"] ?? 100),
  });
  if (minimums.amount0 === 0n || minimums.amount1 === 0n) throw new Error("the burn would pay nothing on one side (BDEX: INSUFFICIENT_LIQUIDITY_BURNED)");
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600 * Number(args["deadline-h"] ?? 24));
  const router = deployment.router.address;
  const allowance = await call(request, pair.address, "allowance", [safe, router], at);
  const nonce = await call(request, safe, "nonce", [], at);

  const steps = [];
  if (allowance < liquidity) {
    steps.push({ description: `approve the router for exactly ${liquidity} LP shares`, to: pair.address, data: encode("approve", [router, liquidity]) });
  }
  steps.push({
    description: `removeLiquidity: burn ${liquidity} LP shares, pay the Safe at least ${minimums.min0} + ${minimums.min1} base units, by ${deadline}`,
    to: router,
    data: encode("removeLiquidity", [pair.token0, pair.token1, liquidity, minimums.min0, minimums.min1, safe, deadline]),
  });

  mkdirSync(args.out, { recursive: true });
  const files = [];
  for (const [index, step] of steps.entries()) {
    const txNonce = nonce + BigInt(index);
    const typed = safeTxTypedData({ chainId: deployment.chainId, safe, to: step.to, data: step.data, nonce: txNonce });
    const hash = safeTxHash(typed);
    const onChain = await call(request, safe, "getTransactionHash", [step.to, 0n, step.data, 0, 0n, 0n, 0n, ZERO_ADDRESS, ZERO_ADDRESS, txNonce], at);
    if (onChain !== hash) throw new Error(`the Safe computes ${onChain} for nonce ${txNonce}, this tool ${hash}; do not sign`);
    const typedPath = join(args.out, `safe-tx-${txNonce}.typed.json`);
    const txPath = join(args.out, `safe-tx-${txNonce}.json`);
    writeFileSync(typedPath, `${JSON.stringify(typed, null, 2)}\n`);
    writeFileSync(txPath, `${stringify({ safe, nonce: txNonce, to: step.to, data: step.data, safeTxHash: hash, description: step.description })}\n`);
    files.push({ nonce: txNonce, description: step.description, safeTxHash: hash, typedData: typedPath, tx: txPath });
  }
  console.log(stringify({
    decision: "sign",
    block: latest.number,
    pair: pair.address,
    liquidity,
    heldByTheSafe: held,
    pendingLiquidityLeftInTheSafe: position.pendingProtocolLiquidity,
    expected: { token0: pair.token0, amount0: minimums.amount0, token1: pair.token1, amount1: minimums.amount1 },
    minimum: { amount0: minimums.min0, amount1: minimums.min1 },
    deadline,
    files,
  }));
  return OK;
}

/// Check signatures and return `execTransaction` calldata, or throw.
export async function assembleSignatures({ tx, signatures, owners, threshold }) {
  const recovered = new Map();
  for (const signature of signatures) {
    if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error(`malformed signature ${signature}`);
    const v = Number.parseInt(signature.slice(-2), 16);
    if (v !== 27 && v !== 28) throw new Error(`signature v ${v} is not 27/28: sign the typed data, not the hash as a personal message`);
    const owner = (await recoverAddress({ hash: tx.safeTxHash, signature })).toLowerCase();
    if (!owners.includes(owner)) throw new Error(`the signature recovers to ${owner}, not a Safe owner; it may be for another transaction`);
    if (recovered.has(owner)) throw new Error(`two signatures from ${owner}`);
    recovered.set(owner, signature);
  }
  if (recovered.size < threshold) throw new Error(`${recovered.size} signatures, the threshold is ${threshold}`);
  // The Safe requires strictly ascending signers.
  const sorted = [...recovered.keys()].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)).slice(0, threshold);
  const packed = `0x${sorted.map((owner) => recovered.get(owner).slice(2)).join("")}`;
  const calldata = encodeFunctionData({
    abi: ABI,
    functionName: "execTransaction",
    args: [tx.to, 0n, tx.data, 0, 0n, 0n, 0n, ZERO_ADDRESS, ZERO_ADDRESS, packed],
  });
  return { to: tx.safe, nonce: tx.nonce, signers: sorted, calldata };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { repeat: ["sig"], options: ["config", "rpc", "pair", "liquidity", "slippage-bps", "deadline-h", "out", "tx"] });
  const [command] = args._;
  if (!args.config || !["plan", "assemble"].includes(command)) {
    console.error("usage: dex-fee-redeem.mjs plan --config <gate.json> --rpc <url> --out <dir> | assemble --config <gate.json> --tx <safe-tx-N.json> --sig 0x… [--sig …]");
    return UNKNOWN;
  }
  const deployment = deploymentFromGate(readGate(args.config));
  if (command === "plan") {
    if (!args.rpc || !args.out) throw new Error("plan needs --rpc and --out");
    return plan(args, deployment);
  }
  const tx = JSON.parse(readFileSync(args.tx, "utf8"));
  if (tx.safe !== deployment.feeTo) throw new Error("this transaction is for another Safe");
  const assembled = await assembleSignatures({
    tx,
    signatures: args.sig ?? [],
    owners: deployment.safe.safe.owners,
    threshold: deployment.safe.safe.threshold,
  });
  console.log(stringify(assembled));
  return OK;
}

if (isMain(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`dex-fee-redeem: ${error.message}`);
      process.exit(error instanceof RpcError ? UNKNOWN : CRIT);
    },
  );
}
