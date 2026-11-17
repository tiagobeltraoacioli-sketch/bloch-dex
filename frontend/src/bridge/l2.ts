// The Bloch L2 side of the bridge: reads at the finalized block (the site's read rule), the exit transactions
// through the RIGHT entry point (the burn router on Bitcoin, Solana and Stellar; the token's burn elsewhere),
// and the observations of deposits and exits a status is computed from.
//
// Nothing here trusts a backend: every fact is a contract read or a log of the L2 at its finalized block, checked
// against the chain id and genesis the site pins and against the code hash the route pins for its router.
import {
  decodeEventLog,
  encodeEventTopics,
  encodeFunctionData,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { readCall, type Rpc } from '../devnet4/chain';
import type { TransactionRequest } from '../devnet4/swap';
import { L2_CHAIN_ID, type LiveRoute } from './config';
import type { ExitProof } from './solana';

export const TOKEN_ABI = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function totalSupply() view returns (uint256)',
  'function pendingSupply() view returns (uint256)',
  'function supplyCap() view returns (uint256)',
  'function minBurn() view returns (uint256)',
  'function bucketCapacity() view returns (uint256)',
  'function paused() view returns (bool)',
  'function pausedUntil() view returns (uint256)',
  'function sourceChainId() view returns (uint256)',
  'function pendingMints(bytes32) view returns (address recipient, uint64 amount, uint64 readyAt)',
  'function minted(bytes32) view returns (bool)',
  'function isCreditHead(bytes32) view returns (bool)',
  'function executeMint(bytes32 replayKey)',
  'function drain()',
  'function burn(uint64 amount, address sourceRecipient) returns (bytes32 burnId)',
  'event MintQueued(bytes32 indexed replayKey, address indexed recipient, uint64 amount, uint256 readyAt)',
  'event MintExecuted(bytes32 indexed replayKey, address indexed recipient, uint64 amount)',
  'event MintCancelled(bytes32 indexed replayKey, address indexed recipient, uint64 amount, uint64 generation)',
  'event Burned(bytes32 indexed burnId, uint64 indexed burnNonce, address indexed from, uint64 amount, address ethRecipient, uint64 mintCount, uint64 mintedTotal, bytes32 mintHead)',
]);
export const BITCOIN_ROUTER_ABI = parseAbi([
  'function token() view returns (address)',
  'function hrp() view returns (string)',
  'function feeRateCeiling() view returns (uint16)',
  'function chargeVbytes() view returns (uint256)',
  'function dustSats() view returns (uint256)',
  'function unitSats() view returns (uint256)',
  'function releaseFeeBps() view returns (uint256)',
  'function keyHashOf(string bitcoinAddress) view returns (bytes20)',
  'function quote(uint64 amount, uint16 feeRate) view returns (uint256 payoutSats, uint256 bridgeFeeSats, uint256 minerChargeSats)',
  'function maxFeeRateOf(bytes32 burnId) view returns (uint16)',
  'function burnTo(uint64 amount, string bitcoinAddress, uint16 maxFeeRate) returns (bytes32 burnId)',
  'function claimDirectBurn(uint64 burnNonce, string bitcoinAddress, uint16 maxFeeRate)',
  'event BitcoinExit(bytes32 indexed burnId, address indexed from, uint64 amount, bytes20 keyHash, string bitcoinAddress, uint16 maxFeeRate)',
  'error NotAP2wpkhAddress()',
  'error BadFeeRate()',
  'error PayoutBelowDustAtFeeRate()',
  'error TransferFailed()',
]);
/** The router whose exit call carries no proof (the interface file's text at the imported commit). */
export const SOLANA_ROUTER_ABI = parseAbi([
  'function token() view returns (address)',
  'function solanaMint() view returns (bytes32)',
  'function walletOf(string recipient) view returns (bytes32)',
  'function commitment(string recipient) view returns (address)',
  'function burnTo(uint64 amount, string recipient) returns (bytes32 burnId)',
  'event SolanaExit(bytes32 indexed burnId, address indexed from, uint64 amount, address commitment, string recipient)',
  'error NotASolanaWallet()',
  'error TransferFailed()',
]);
/** The router whose exit call carries the destination-key proof (round 17, coordinator's decision). */
export const SOLANA_PROOF_ROUTER_ABI = parseAbi([
  'function token() view returns (address)',
  'function solanaMint() view returns (bytes32)',
  'function route() view returns (bytes32)',
  'function nextNonce(address) view returns (uint64)',
  'function walletOf(string recipient) view returns (bytes32)',
  'function commitment(string recipient) view returns (address)',
  'function exitMessage(address burner, uint64 amount, string recipient, uint64 nonce) view returns (string)',
  'function redirectMessage(address burner, bytes32 burnId, string recipient, uint64 nonce) view returns (string)',
  'function burnTo(uint64 amount, string recipient, uint64 nonce, bytes proof) returns (bytes32 burnId)',
  'function redirectHeldBurn(bytes32 burnId, string recipient, uint64 nonce, bytes proof)',
  'event SolanaExit(bytes32 indexed burnId, address indexed from, uint64 amount, address commitment, string recipient, uint64 nonce, bytes proof, bytes32 exitHash)',
  'event SolanaRedirect(bytes32 indexed burnId, address indexed from, uint64 nonce, address commitment, string recipient, bytes proof)',
  'error NotASolanaWallet()',
  'error TransferFailed()',
  'error BadNonce()',
  'error BadProof()',
]);
export const solanaRouterAbi = (route: LiveRoute) => (route.solana?.proof.carriedBy === 'router' ? SOLANA_PROOF_ROUTER_ABI : SOLANA_ROUTER_ABI);
export const STELLAR_ROUTER_ABI = parseAbi([
  'function token() view returns (address)',
  'function commitment(string recipient) pure returns (address)',
  'function burnTo(uint64 amount, string stellarAddress) returns (bytes32 burnId)',
  'event StellarExit(bytes32 indexed burnId, address indexed from, uint64 amount, bytes20 commitment, string stellarAddress)',
  'error BadStrkey()',
  'error TransferFailed()',
]);

export class BridgeError extends Error {}
const refuse: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new BridgeError(message);
};
const quantity = (value: unknown, what: string): bigint => {
  refuse(typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value), `The L2 RPC answered ${what} in a form this page cannot read.`);
  return BigInt(value);
};
const HASH = /^0x[0-9a-f]{64}$/;

export type L2Block = { number: bigint; hash: Hex; timestamp: bigint };

/** The finalized L2 block, after checking that the RPC is the pinned chain (id and genesis). */
export async function finalizedL2(rpc: Rpc, genesisHash: Hex | null): Promise<L2Block> {
  refuse(quantity(await rpc('eth_chainId', []), 'the chain id') === BigInt(L2_CHAIN_ID), 'The RPC is not the Bloch L2 (chain 700770). Nothing is read or sent.');
  if (genesisHash) {
    const genesis = (await rpc('eth_getBlockByNumber', ['0x0', false])) as { hash?: unknown } | null;
    refuse(genesis?.hash === genesisHash, 'The RPC serves another genesis block than the one this site pins. Nothing is read or sent.');
  }
  const block = (await rpc('eth_getBlockByNumber', ['finalized', false])) as Record<string, unknown> | null;
  refuse(block && typeof block.hash === 'string' && HASH.test(block.hash), 'The L2 RPC reports no finalized block, so nothing can be read safely.');
  const number = quantity(block.number, 'the finalized block number');
  const again = (await rpc('eth_getBlockByNumber', [`0x${number.toString(16)}`, false])) as { hash?: unknown } | null;
  refuse(again?.hash === block.hash, 'The finalized block is not on the canonical chain the RPC serves. Nothing is read or sent.');
  return { number, hash: block.hash as Hex, timestamp: quantity(block.timestamp, 'the block time') };
}

export type L2Context = {
  finalized: L2Block;
  balance: bigint | null;
  /** Allowance of the router over the account's tokens; null when the route has no router or no account is connected. */
  allowance: bigint | null;
  totalSupply: bigint;
  pendingSupply: bigint;
  supplyCap: bigint;
  /** Units that can still be minted under the supply cap (queued mints count). */
  capHeadroom: bigint;
  minBurn: bigint;
  maxBurn: bigint;
  /** Mints are paused on the L2 token (burns never are). */
  mintsPaused: boolean;
  mintsPausedUntil: bigint;
};

/**
 * Read the route's L2 contracts at the finalized block and check that they are the route's: the token answers
 * with the route's symbol and decimals, and the router (when the route has one) has the pinned code hash and
 * names this token. Any mismatch throws: the page then shows the reason and offers no transaction.
 */
export async function readL2Context(rpc: Rpc, route: LiveRoute, genesisHash: Hex | null, account: Address | null): Promise<L2Context> {
  const finalized = await finalizedL2(rpc, genesisHash);
  const at = { blockHash: finalized.hash };
  const token = route.l2.token;
  const read = <T>(fn: string, args: unknown[] = []) => readCall<T>(rpc, TOKEN_ABI, token, fn, args, at);
  const code = await rpc('eth_getCode', [token, at]);
  refuse(typeof code === 'string' && code.length > 2, `No contract is deployed at the ${route.l2.symbol} token address on the L2.`);
  const [symbol, decimals] = await Promise.all([read<string>('symbol'), read<number>('decimals')]);
  refuse(symbol === route.l2.symbol && Number(decimals) === route.l2.decimals, `The token at the ${route.l2.symbol} address calls itself ${String(symbol).slice(0, 20)}: it is not this route's token. Nothing is sent.`);
  if (route.router) {
    const router = route.router.address!;
    const routerCode = await rpc('eth_getCode', [router, at]);
    refuse(typeof routerCode === 'string' && routerCode.length > 2, `No contract is deployed at the ${route.l2.symbol} exit router address on the L2.`);
    refuse(keccak256(routerCode as Hex) === route.router.codeHash, `The code at the ${route.l2.symbol} exit router address is not the reviewed router. Nothing is sent.`);
    const named = await readCall<Address>(rpc, BITCOIN_ROUTER_ABI, router, 'token', [], at);
    refuse(named.toLowerCase() === token.toLowerCase(), `The ${route.l2.symbol} exit router burns another token. Nothing is sent.`);
  }
  const [totalSupply, pendingSupply, supplyCap, minBurn, maxBurn, mintsPaused, mintsPausedUntil] = await Promise.all([
    read<bigint>('totalSupply'),
    read<bigint>('pendingSupply'),
    read<bigint>('supplyCap'),
    read<bigint>('minBurn'),
    read<bigint>('bucketCapacity'),
    read<boolean>('paused'),
    read<bigint>('pausedUntil'),
  ]);
  // The interface file and the deployed token must state the same exit limits; otherwise the page's figures would
  // not be the contract's.
  refuse(minBurn === route.limits.l2MinBurn && supplyCap === route.limits.cap, `The deployed ${route.l2.symbol} token has other limits than the bridge's published file. Nothing is sent until the file and the deployment agree.`);
  const balance = account ? await read<bigint>('balanceOf', [account]) : null;
  const allowance = account && route.router ? await read<bigint>('allowance', [account, route.router.address]) : null;
  const used = totalSupply + pendingSupply;
  return {
    finalized,
    balance,
    allowance,
    totalSupply,
    pendingSupply,
    supplyCap,
    capHeadroom: supplyCap > used ? supplyCap - used : 0n,
    minBurn,
    maxBurn,
    mintsPaused,
    mintsPausedUntil,
  };
}

// ── exits ────────────────────────────────────────────────────────────────────
/** Where an exit is paid, already validated by the page for the route's network. */
export type ExitDestination =
  | { kind: 'evm'; address: Address }
  | { kind: 'tvm'; address: string; address20: Address }
  | { kind: 'utxo'; address: string; maxFeeRate: number }
  | { kind: 'svm'; proof: ExitProof }
  | { kind: 'stellar'; address: string };

export type ExitStep = {
  id: 'approve' | 'burn';
  title: string;
  /** What the wallet is asked to do, in one sentence, shown before the request. */
  detail: string;
  to: Address;
  data: Hex;
};

/**
 * The transactions of an exit, in order. A route with a router NEVER gets a `burn` on the token: the only burn call
 * built for it is the router's `burnTo`, after an exact (never unlimited) approval of the router.
 */
export function exitSteps(route: LiveRoute, units: bigint, destination: ExitDestination, allowance: bigint): ExitStep[] {
  refuse(units > 0n && units < 1n << 64n, 'The amount is out of range.');
  refuse(destination.kind === route.kind, 'The destination is not of this route\'s network.');
  const token = route.l2.token;
  const amount = `${units} units of ${route.l2.symbol}`;
  if (!route.router) {
    refuse(destination.kind === 'evm' || destination.kind === 'tvm', 'This network exits through a router.');
    const recipient = destination.kind === 'evm' ? destination.address : destination.address20;
    refuse(/^0x[0-9a-fA-F]{40}$/.test(recipient) && !/^0x0{40}$/.test(recipient), 'The recipient is not a 20-byte address.');
    return [
      {
        id: 'burn',
        title: `Burn ${route.l2.symbol}`,
        detail: `burn(${units}, ${recipient}) on the ${route.l2.symbol} token: burns ${amount} and names ${destination.address} on ${route.name} as the recipient.`,
        to: token,
        data: encodeFunctionData({ abi: TOKEN_ABI, functionName: 'burn', args: [units, recipient] }),
      },
    ];
  }
  const router = route.router.address;
  refuse(router, 'The exit router is not deployed.');
  const steps: ExitStep[] = [];
  if (allowance < units)
    steps.push({
      id: 'approve',
      title: `Approve the exit router for ${route.l2.symbol}`,
      detail: `approve(${router}, ${units}) on the ${route.l2.symbol} token: lets the exit router take exactly this amount, nothing more.`,
      to: token,
      data: encodeFunctionData({ abi: TOKEN_ABI, functionName: 'approve', args: [router, units] }),
    });
  let data: Hex;
  let call: string;
  if (destination.kind === 'utxo') {
    data = encodeFunctionData({ abi: BITCOIN_ROUTER_ABI, functionName: 'burnTo', args: [units, destination.address, destination.maxFeeRate] });
    call = `burnTo(${units}, ${destination.address}, ${destination.maxFeeRate})`;
  } else if (destination.kind === 'svm') {
    const format = route.solana!.proof;
    const { proof } = destination;
    refuse(proof.router.toLowerCase() === router.toLowerCase(), 'The destination proof names another router.');
    if (format.carriedBy === 'router') {
      // The signed line names the amount and the burner's nonce: a proof made for another amount is not this exit's.
      refuse(proof.amount === units && proof.nonce !== undefined, 'The destination proof was signed for another amount. Sign it again.');
      data = encodeFunctionData({ abi: SOLANA_PROOF_ROUTER_ABI, functionName: 'burnTo', args: [units, proof.wallet, proof.nonce, proof.proofBytes] });
      call = `burnTo(${units}, ${proof.wallet}, ${proof.nonce}, <the wallet's signature>)`;
    } else {
      data = encodeFunctionData({ abi: SOLANA_ROUTER_ABI, functionName: 'burnTo', args: [units, proof.wallet] });
      call = `burnTo(${units}, ${proof.wallet})`;
    }
  } else if (destination.kind === 'stellar') {
    data = encodeFunctionData({ abi: STELLAR_ROUTER_ABI, functionName: 'burnTo', args: [units, destination.address] });
    call = `burnTo(${units}, ${destination.address})`;
  } else throw new BridgeError('This network burns on the token.');
  steps.push({
    id: 'burn',
    title: `Burn ${route.l2.symbol} through the exit router`,
    detail: `${call} on the ${route.l2.symbol} exit router: the router checks the destination again, then burns ${amount}.`,
    to: router,
    data,
  });
  return steps;
}

/** Gas for a step: the node's own estimate at the latest block plus a third, inside fixed bounds. A call that would revert throws. */
export async function estimateStepGas(rpc: Rpc, from: Address, step: ExitStep): Promise<bigint> {
  const estimate = quantity(await rpc('eth_estimateGas', [{ from, to: step.to, data: step.data }, 'latest']), 'the gas estimate');
  refuse(estimate >= 21_000n && estimate <= 3_000_000n, 'The gas estimate is outside what this page sends.');
  return (estimate * 4n) / 3n;
}

export const stepTransaction = (from: Address, step: ExitStep, gas: bigint): TransactionRequest => ({
  from,
  to: step.to,
  data: step.data,
  value: 0n,
  gas,
  chainId: L2_CHAIN_ID,
});

/** A router's or the token's own refusal, in words. The text of an RPC error is untrusted; only known names are matched. */
export function refusalText(error: unknown, route: LiveRoute): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const selectors: [string, string][] = [
    ['NotAP2wpkhAddress', 'The router refuses this Bitcoin address.'],
    ['BadFeeRate', 'The router refuses this fee rate.'],
    ['PayoutBelowDustAtFeeRate', 'The router refuses this burn: its payout would be dust at the fee rate you named.'],
    ['NotASolanaWallet', 'The router refuses this destination: it is not a Solana wallet address.'],
    ['BadStrkey', 'The router refuses this Stellar address.'],
    ['BadNonce', 'The router refuses the proof: its nonce is not the next one of your account. Sign the message again.'],
    ['BadProof', 'The router refuses the shape of the proof.'],
    ['TransferFailed', 'The router could not take the tokens: check the approval.'],
    ['BurnTooSmall', `The token refuses a burn below ${route.limits.l2MinBurn} units.`],
    ['BurnTooLarge', 'The token refuses a burn above its largest single exit.'],
    ['InsufficientBalance', `Your ${route.l2.symbol} balance does not cover this amount.`],
    ['InsufficientAllowance', 'The approval does not cover this amount.'],
    ['BadEthRecipient', 'The token refuses this recipient.'],
  ];
  for (const [name, text] of selectors) {
    const selector = keccak256(`0x${Array.from(new TextEncoder().encode(`${name}()`), (b) => b.toString(16).padStart(2, '0')).join('')}` as Hex).slice(0, 10);
    if (message.includes(name) || message.includes(selector)) return text;
  }
  return null;
}

// ── observations ─────────────────────────────────────────────────────────────
const LOG_SPAN = 50_000n;
type RawLog = { address: string; topics: Hex[]; data: Hex; blockNumber: string; transactionHash: Hex; blockHash: Hex };
async function logs(rpc: Rpc, address: Address, topics: (Hex | null)[], finalized: L2Block, fromBlock: bigint): Promise<RawLog[]> {
  const out: RawLog[] = [];
  for (let from = fromBlock; from <= finalized.number; from += LOG_SPAN) {
    const to = from + LOG_SPAN - 1n < finalized.number ? from + LOG_SPAN - 1n : finalized.number;
    const part = await rpc('eth_getLogs', [{ address, topics, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }]);
    refuse(Array.isArray(part), 'The L2 RPC did not return logs.');
    for (const log of part as RawLog[]) {
      refuse(log && typeof log.address === 'string' && log.address.toLowerCase() === address.toLowerCase() && Array.isArray(log.topics), 'The L2 RPC returned a log of another contract.');
      out.push(log);
    }
  }
  return out;
}
const topicAddress = (account: Address): Hex => `0x${account.slice(2).toLowerCase().padStart(64, '0')}`;

export type MintObservation = {
  replayKey: Hex;
  amount: bigint;
  queuedAt: { block: bigint; tx: Hex };
  /** Pending on the token now (at the finalized block), with the time its delay ends. */
  pending: { readyAt: bigint } | null;
  executed: { block: bigint; tx: Hex } | null;
  cancelled: { block: bigint; tx: Hex } | null;
  /** Its turn in the token's credit order has come (only meaningful while pending). */
  creditHead: boolean;
};

/** Every credit the token has queued for `account`, from the token's own logs and state at the finalized block. */
export async function readMints(rpc: Rpc, route: LiveRoute, finalized: L2Block, account: Address, fromBlock = 0n): Promise<MintObservation[]> {
  const token = route.l2.token;
  const who = topicAddress(account);
  const topic = (eventName: 'MintQueued' | 'MintExecuted' | 'MintCancelled') => encodeEventTopics({ abi: TOKEN_ABI, eventName })[0];
  const [queued, executed, cancelled] = await Promise.all([
    logs(rpc, token, [topic('MintQueued'), null, who], finalized, fromBlock),
    logs(rpc, token, [topic('MintExecuted'), null, who], finalized, fromBlock),
    logs(rpc, token, [topic('MintCancelled'), null, who], finalized, fromBlock),
  ]);
  const at = { blockHash: finalized.hash };
  const where = (log: RawLog) => ({ block: BigInt(log.blockNumber), tx: log.transactionHash });
  const last = (list: RawLog[], key: Hex) => list.filter((l) => l.topics[1] === key).at(-1);
  const seen = new Set<Hex>();
  const out: MintObservation[] = [];
  for (const log of queued) {
    const key = log.topics[1];
    if (seen.has(key)) continue;
    seen.add(key);
    const first = decodeEventLog({ abi: TOKEN_ABI, eventName: 'MintQueued', topics: log.topics as [Hex, ...Hex[]], data: log.data });
    const [, amount, readyAt] = await readCall<[Address, bigint, bigint]>(rpc, TOKEN_ABI, token, 'pendingMints', [key], at);
    const pending = amount > 0n ? { readyAt: BigInt(readyAt) } : null;
    const done = last(executed, key);
    const cancel = last(cancelled, key);
    out.push({
      replayKey: key,
      amount: pending ? BigInt(amount) : BigInt(first.args.amount),
      queuedAt: where(log),
      pending,
      executed: !pending && done ? where(done) : null,
      // A cancel followed by a new queue entry (a remint) shows as pending again.
      cancelled: !pending && cancel && (!done || BigInt(cancel.blockNumber) > BigInt(done.blockNumber)) ? where(cancel) : null,
      creditHead: pending ? await readCall<boolean>(rpc, TOKEN_ABI, token, 'isCreditHead', [key], at) : false,
    });
  }
  return out.reverse();
}

export type BurnObservation = {
  burnId: Hex;
  burnNonce: bigint;
  amount: bigint;
  block: bigint;
  tx: Hex;
  /** The recipient as the user gave it (router exits), else the 20 bytes the burn names. */
  recipient: string;
  recipient20: Address;
  /** Bitcoin: the fee-rate ceiling the burner named. */
  maxFeeRate?: number;
  /** The burn went through the route's router (always true for burns made by this page on router routes). */
  viaRouter: boolean;
};

/** Every exit `account` has made on this route, from the L2's logs at the finalized block. */
export async function readBurns(rpc: Rpc, route: LiveRoute, finalized: L2Block, account: Address, fromBlock = 0n): Promise<BurnObservation[]> {
  const token = route.l2.token;
  const who = topicAddress(account);
  const burnedTopic = encodeEventTopics({ abi: TOKEN_ABI, eventName: 'Burned' })[0];
  const decodeBurned = (log: RawLog) => decodeEventLog({ abi: TOKEN_ABI, eventName: 'Burned', topics: log.topics as [Hex, ...Hex[]], data: log.data }).args;
  const out: BurnObservation[] = [];
  // Burns the account made directly on the token: the regular exit of EVM and TRON routes; on a router route they
  // are the direct burns the bridge does not pay without a claim, and the status says so.
  for (const log of await logs(rpc, token, [burnedTopic, null, null, who], finalized, fromBlock)) {
    const b = decodeBurned(log);
    out.push({ burnId: b.burnId, burnNonce: b.burnNonce, amount: b.amount, block: BigInt(log.blockNumber), tx: log.transactionHash, recipient: b.ethRecipient, recipient20: b.ethRecipient, viaRouter: false });
  }
  if (route.router) {
    const router = route.router.address!;
    const abi = route.kind === 'utxo' ? BITCOIN_ROUTER_ABI : route.kind === 'svm' ? solanaRouterAbi(route) : STELLAR_ROUTER_ABI;
    const eventName = route.kind === 'utxo' ? 'BitcoinExit' : route.kind === 'svm' ? 'SolanaExit' : 'StellarExit';
    const exitTopic = encodeEventTopics({ abi, eventName } as never)[0];
    const routerBurns = await logs(rpc, token, [burnedTopic, null, null, topicAddress(router)], finalized, fromBlock);
    for (const log of await logs(rpc, router, [exitTopic, null, who], finalized, fromBlock)) {
      const args = decodeEventLog({ abi, eventName, topics: log.topics as [Hex, ...Hex[]], data: log.data } as never).args as unknown as Record<string, unknown>;
      // The token's own Burned log of the same transaction gives the nonce; a router log without it is not an exit.
      const burned = routerBurns.find((l) => l.topics[1] === log.topics[1] && l.transactionHash === log.transactionHash);
      if (!burned) continue;
      const b = decodeBurned(burned);
      refuse(b.amount === args.amount, 'The router and the token disagree about a burned amount.');
      out.push({
        burnId: b.burnId,
        burnNonce: b.burnNonce,
        amount: b.amount,
        block: BigInt(log.blockNumber),
        tx: log.transactionHash,
        recipient: String(args.bitcoinAddress ?? args.recipient ?? args.stellarAddress),
        recipient20: b.ethRecipient,
        maxFeeRate: args.maxFeeRate === undefined ? undefined : Number(args.maxFeeRate),
        viaRouter: true,
      });
    }
  }
  return out.sort((a, b) => (a.burnNonce > b.burnNonce ? -1 : 1));
}

/** Calls anyone may send to move a credit along: execute the mint at the credit head, or drain those behind it. */
export const creditCalls = {
  execute: (token: Address, replayKey: Hex): { to: Address; data: Hex } => ({ to: token, data: encodeFunctionData({ abi: TOKEN_ABI, functionName: 'executeMint', args: [replayKey] }) }),
  drain: (token: Address): { to: Address; data: Hex } => ({ to: token, data: encodeFunctionData({ abi: TOKEN_ABI, functionName: 'drain' }) }),
};
