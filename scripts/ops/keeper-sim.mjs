// A randomized model of the L2 node around the skim keeper (written by the round 15 review, agent 309, review
// branch commit 665fb6b; kept as a test helper of the ops suite).
// The node is HONEST (it never lies about its spool) but lossy: publications are accepted,
// accepted with the reply lost, silently dropped, or refused with the admission quote; the
// spool forgets entries; any spooled attempt of the open nonce can be mined; finality lags.
// It records every transaction it was ever handed, so invariants can be checked afterwards.
import { createRequire } from "node:module";
import { ABI, CallReverted, RpcError, keccak256 } from "./dex-ops-lib.mjs";
import { JsonRpcResponseError } from "../staging/rpc-transport.mjs";

const viem = createRequire(new URL("../../frontend/package.json", import.meta.url))("viem");
const { privateKeyToAccount } = createRequire(new URL("../../frontend/package.json", import.meta.url))("viem/accounts");
const { encodeFunctionResult, decodeFunctionData } = viem;

export const address = (n) => `0x${n.toString(16).padStart(40, "0")}`;
const CODE = { pair: "0x6001", token0: "0x6002", token1: "0x6003", factory: "0x6004", router: "0x6005", lens: "0x6006", safe: "0x6007" };
export const [T0, T1, PAIR, FACTORY, ROUTER, LENS, SAFE] = [1, 2, 3, 4, 5, 6, 7].map((n) => address(0xa00 + n));
const GENESIS = `0x${"ab".repeat(32)}`;
export const CAP0 = 1_000_000_000n;
export const CAP1 = 10n ** 19n;
export const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
export const KEEPER = account.address.toLowerCase();
export const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export const gate = {
  schemaVersion: 2,
  chain: { id: 700770, genesisHash: GENESIS },
  deployment: {
    contracts: {
      wrappedNative: { address: T1, codeHash: keccak256(CODE.token1) },
      factory: { address: FACTORY, codeHash: keccak256(CODE.factory) },
      router: { address: ROUTER, codeHash: keccak256(CODE.router) },
      lens: { address: LENS, codeHash: keccak256(CODE.lens) },
    },
    pairInitCodeHash: `0x${"cd".repeat(32)}`,
    feeTo: SAFE,
    roles: { blochInc: { address: SAFE, codeHash: keccak256(CODE.safe), safe: { threshold: 3, owners: [] } } },
    reserveCaps: [{ token: T0, cap: String(CAP0) }, { token: T1, cap: String(CAP1) }],
    tokens: [{ token: T0, symbol: "bUSDC", codeHash: keccak256(CODE.token0), bridgeBucketCapacity: "10000000000" }],
    pairs: [{ address: PAIR, token0: T0, token1: T1, codeHash: keccak256(CODE.pair) }],
    transactions: [],
  },
};

export const signer = async ({ chainId, nonce, gasLimit, maxFee, tip, to, data }) =>
  account.signTransaction({ chainId, nonce: Number(nonce), gas: gasLimit, maxFeePerGas: maxFee, maxPriorityFeePerGas: tip, to, data, type: "eip1559" });

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (n) => `0x${BigInt(n).toString(16)}`;
const blockHashOf = (n) => `0x${(n + 1n).toString(16).padStart(64, "0")}`;

/// `p`: probabilities of the node's behaviours. `t0`: the chain's first timestamp.
export function simNode(rand, p = {}, t0 = 2_000_000_000) {
  const prob = { accept: 0.55, acceptLostReply: 0.15, silentDrop: 0.15, evict: 0.1, mine: 0.5, redonate: 0.6, finalityLag: 2n, baseFee: 100_000_000n, quoteMin: 1_500_000_000n, quoteMax: 9_500_000_000n, ...p };
  const chain = {
    time: t0,
    blocks: [{ number: 0n, timestamp: BigInt(t0), txs: [], nonceAfter: 0n }],
    finalized: 0n,
    spool: new Map(), // nonce -> { raw, hash, tx }
    handed: [], // every raw ever passed to eth_sendRawTransaction, with the time
    mined: [], // { hash, nonce, block, timestamp, spentWei, effective, foreign }
    receipts: {},
    excess: true,
    keeperBalance: 10n ** 18n,
  };
  const head = () => chain.blocks.at(-1);
  const nonce = () => head().nonceAfter;
  const blockAt = (n) => chain.blocks[Number(n)];

  function mineBlock(time) {
    chain.time = time;
    const number = head().number + 1n;
    const block = { number, timestamp: BigInt(time), txs: [], nonceAfter: nonce() };
    const candidate = chain.spool.get(nonce());
    if (candidate && rand() < prob.mine && candidate.tx.maxFeePerGas >= prob.baseFee) {
      const tip = candidate.tx.maxPriorityFeePerGas < candidate.tx.maxFeePerGas - prob.baseFee ? candidate.tx.maxPriorityFeePerGas : candidate.tx.maxFeePerGas - prob.baseFee;
      const gasUsed = 80_000n;
      const price = prob.baseFee + tip;
      const effective = chain.excess;
      chain.excess = false;
      chain.spool.delete(nonce());
      block.txs.push({ hash: candidate.hash, from: KEEPER, nonce: hex(candidate.tx.nonce ?? 0) });
      block.nonceAfter += 1n;
      chain.receipts[candidate.hash] = {
        transactionHash: candidate.hash, from: KEEPER, to: PAIR, status: "0x1", blockNumber: hex(number), blockHash: blockHashOf(number),
        gasUsed: hex(gasUsed), effectiveGasPrice: hex(price), logs: effective ? [{ topics: [TRANSFER], data: "0x01" }] : [],
      };
      chain.mined.push({ hash: candidate.hash, nonce: BigInt(candidate.tx.nonce ?? 0), block: number, timestamp: time, spentWei: gasUsed * price, effective });
      chain.keeperBalance -= gasUsed * price;
    }
    chain.blocks.push(block);
    if (number > prob.finalityLag && rand() < 0.7) chain.finalized = number - prob.finalityLag;
    if (!chain.excess && rand() < prob.redonate) chain.excess = true;
    if (chain.spool.size && rand() < prob.evict) chain.spool.clear();
  }

  const refusal = (raw, tx) => {
    const span = Number(prob.quoteMax - prob.quoteMin);
    let required = prob.quoteMin + BigInt(Math.floor(rand() * span));
    if (required <= tx.maxPriorityFeePerGas) required = tx.maxPriorityFeePerGas + 1n;
    return new RpcError("underpriced", { cause: new JsonRpcResponseError("eth_sendRawTransaction", {
      code: -32000, message: "transaction underpriced for sequencer policy",
      data: {
        kind: "sequencer-fee-underpriced", scope: "latest-state-next-block", transactionHash: keccak256(raw),
        headHash: blockHashOf(head().number), headNumber: hex(head().number), baseFeePerGas: hex(prob.baseFee),
        requiredPriorityFeePerGas: hex(required), requiredMaxFeePerGas: hex(required + prob.baseFee),
        effectivePriorityFeePerGas: hex(tx.maxPriorityFeePerGas), gasUsed: "0x13880", freshSlots: "0x1", chargedFreshSlots: "0x1", freshSlotPriceWei: hex(required * 80_000n),
      },
    }) });
  };

  function publish(raw) {
    const tx = viem.parseTransaction(raw);
    const hash = keccak256(raw);
    const n = BigInt(tx.nonce ?? 0);
    chain.handed.push({ raw, hash, nonce: n, time: chain.time, finalizedNonce: blockAt(chain.finalized).nonceAfter, tx });
    if (chain.receipts[hash]) throw new RpcError("already known");
    if (n < nonce()) throw new RpcError("nonce too low");
    const held = chain.spool.get(n);
    if (held?.hash === hash) return hash;
    if (held) {
      const enough = tx.maxPriorityFeePerGas * 10n >= held.tx.maxPriorityFeePerGas * 11n && tx.maxFeePerGas * 10n >= held.tx.maxFeePerGas * 11n;
      if (!enough) throw new RpcError("replacement transaction underpriced");
      chain.spool.set(n, { raw, hash, tx });
      return hash;
    }
    const r = rand();
    if (r < prob.accept) { chain.spool.set(n, { raw, hash, tx }); return hash; }
    if (r < prob.accept + prob.acceptLostReply) { chain.spool.set(n, { raw, hash, tx }); throw new RpcError("ECONNRESET"); }
    if (r < prob.accept + prob.acceptLostReply + prob.silentDrop) return hash;
    throw refusal(raw, tx);
  }

  const request = async (method, params) => {
    switch (method) {
      case "eth_chainId": return "0xab162";
      case "eth_getBlockByNumber": {
        const [tag, full] = params;
        if (tag === "0x0" && !full) return { hash: GENESIS, number: "0x0", timestamp: hex(blockAt(0n).timestamp), baseFeePerGas: hex(prob.baseFee) };
        const number = tag === "finalized" ? chain.finalized : tag === "latest" ? head().number : BigInt(tag);
        if (tag === "finalized" && number === 0n) return null;
        const block = blockAt(number);
        if (!block) return null;
        return { number: hex(number), hash: blockHashOf(number), timestamp: hex(block.timestamp), baseFeePerGas: hex(prob.baseFee), ...(full ? { transactions: block.txs } : {}) };
      }
      case "eth_getCode": return { [PAIR]: CODE.pair, [T0]: CODE.token0, [T1]: CODE.token1, [FACTORY]: CODE.factory, [ROUTER]: CODE.router, [LENS]: CODE.lens, [SAFE]: CODE.safe }[params[0]];
      case "eth_call": {
        const [{ to, data }] = params;
        const { functionName } = decodeFunctionData({ abi: ABI, data });
        const reserves = prob.reserves ?? [500_000_000n, 5n * 10n ** 18n];
        const balances = chain.excess ? (prob.excessBalances ?? [CAP0 + 1n, 5n * 10n ** 18n]) : reserves;
        let value;
        switch (functionName) {
          case "skim": return "0x";
          case "getReserves": value = [reserves[0], reserves[1], 1]; break;
          case "reserveCaps": value = [CAP0, CAP1]; break;
          case "feeTo": value = SAFE; break;
          case "factory": value = FACTORY; break;
          case "totalSupply": value = 10n ** 13n; break;
          case "kLast": value = 25n * 10n ** 26n; break;
          case "balanceOf": value = to === PAIR ? 0n : balances[to === T0 ? 0 : 1]; break;
          default: throw new CallReverted(`sim: ${functionName}`);
        }
        return encodeFunctionResult({ abi: ABI, functionName, result: value });
      }
      case "eth_estimateGas": return hex(80_000n);
      case "eth_getBalance": return hex(chain.keeperBalance);
      case "eth_getTransactionCount": {
        const tag = params[1];
        if (tag === "latest") return hex(nonce());
        if (tag === "pending") return hex(nonce() + (chain.spool.has(nonce()) ? 1n : 0n));
        return hex(blockAt(BigInt(tag)).nonceAfter);
      }
      case "eth_getTransactionReceipt": return chain.receipts[params[0]] ?? null;
      case "eth_sendRawTransaction": return publish(params[0]);
      default: throw new Error(`sim: ${method}`);
    }
  };
  return { chain, request, mineBlock, prob };
}
