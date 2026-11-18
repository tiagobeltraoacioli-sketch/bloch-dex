// A wallet hash is an observation, not proof that it identifies the requested
// transaction. Keep the durable hold until its exact call is canonically finalized.
import { wording } from './wording';
import { decodeFunctionData, sha256, stringToBytes, type Address, type Hex } from 'viem';
import type { Rpc } from '../devnet4/chain';
import { stableJson, type DevnetDeployment } from '../devnet4/record';
import { ROUTER_ABI, type Receipt } from '../devnet4/swap';
import { savedLiquidityDeadline } from './liquidity-tx';

export type SubmissionContext = { chainId: number; genesisHash: Hex; deploymentId: Hex };
export type SubmissionIntent = SubmissionContext & {
  id: string;
  /** `liquidity` (round 20): a deposit or a removal through the router; held like a swap (`holdsUntilDeadline`). */
  kind: 'swap' | 'approval' | 'skim' | 'liquidity';
  from: Address;
  to: Address;
  data: Hex;
  value: string;
  gas: string;
  nonce: string;
  afterBlockNumber: string;
  afterBlockHash: Hex;
};
/**
 * The requests a second copy of which would spend twice: a swap, and a deposit or removal of liquidity. Each
 * carries a deadline in its call. Such a request is never asked of the wallet a second time, its hold ends by
 * that deadline at a canonical finalized block, and its REVERTED receipt frees the account only by the chain's
 * rule for reverted requests. An approval or a skim is harmless twice and carries no deadline.
 */
export const holdsUntilDeadline = (kind: SubmissionIntent['kind']): boolean =>
  kind === 'swap' || kind === 'liquidity';
const HASH = /^0x[0-9a-f]{64}$/;
const QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/;
export const isSubmissionHash = (value: unknown): value is Hex =>
  typeof value === 'string' && HASH.test(value) && value !== `0x${'0'.repeat(64)}`;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('The RPC returned an invalid submission observation.');
  return value as Record<string, unknown>;
};
const quantity = (value: unknown) => {
  if (typeof value !== 'string' || !QUANTITY.test(value))
    throw new Error('The RPC returned an invalid transaction quantity.');
  return BigInt(value);
};
const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message);
};

/** Exclude the moving finality checkpoint, but bind every deployed address/code. */
export function submissionContext(d: DevnetDeployment): SubmissionContext {
  const { chainId, genesisHash, factory, router, lens, wrapped, feeTo, codeHashes, tokens, pairs } =
    d;
  return {
    chainId,
    genesisHash,
    deploymentId: sha256(
      stringToBytes(
        stableJson({
          chainId,
          genesisHash,
          factory,
          router,
          lens,
          wrapped,
          feeTo,
          codeHashes,
          tokens: tokens.map(({ address }) => address),
          pairs,
        }),
      ),
    ),
  };
}

export function assertSubmissionContext(
  intent: SubmissionIntent,
  context: SubmissionContext,
  account?: Address,
): void {
  assert(
    intent.chainId === context.chainId &&
      intent.genesisHash === context.genesisHash &&
      intent.deploymentId === context.deploymentId &&
      (!account || intent.from === account.toLowerCase()),
    'The saved submission belongs to a different chain, genesis, deployment or account. It remains blocked; restore the original verified context to check its outcome.',
  );
}

async function checkChain(rpc: Rpc, context: SubmissionContext) {
  assert(
    quantity(await rpc('eth_chainId', [])) === BigInt(context.chainId),
    'The submission RPC serves another chain.',
  );
  const genesis = object(await rpc('eth_getBlockByNumber', ['0x0', false]));
  assert(
    genesis.number === '0x0' &&
      genesis.hash === context.genesisHash &&
      isSubmissionHash(genesis.hash),
    'The submission RPC serves another genesis.',
  );
}

function matchTransaction(value: unknown, hash: Hex, intent: SubmissionIntent) {
  const tx = object(value);
  assert(
    tx.hash === hash &&
      typeof tx.from === 'string' &&
      tx.from.toLowerCase() === intent.from &&
      typeof tx.to === 'string' &&
      tx.to.toLowerCase() === intent.to &&
      typeof tx.input === 'string' &&
      tx.input.toLowerCase() === intent.data &&
      quantity(tx.value) === BigInt(intent.value) &&
      quantity(tx.chainId) === BigInt(intent.chainId) &&
      // A wallet may ignore the nonce this page asks for and sign the saved call at its own next nonce. The account
      // nonce was intent.nonce at the saved boundary, so the same sender, call and value at that nonce or a later one
      // is this request, signed after it was made; an earlier nonce is history and never matches.
      quantity(tx.nonce) >= BigInt(intent.nonce),
    'This hash does not match the saved sender, destination, call, value and chain at the saved nonce or a later one. The submission hold remains.',
  );
  return tx;
}

/** The nonce of an RPC transaction body that carries the saved call from the saved sender, or null. Read-only. */
export function savedCallNonce(value: unknown, intent: SubmissionIntent): bigint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const tx = value as Record<string, unknown>;
  try {
    return typeof tx.from === 'string' &&
      tx.from.toLowerCase() === intent.from &&
      typeof tx.to === 'string' &&
      tx.to.toLowerCase() === intent.to &&
      typeof tx.input === 'string' &&
      tx.input.toLowerCase() === intent.data &&
      quantity(tx.value) === BigInt(intent.value)
      ? quantity(tx.nonce)
      : null;
  } catch {
    return null;
  }
}

/** Observe a canonical head before the wallet request, excluding historical hashes. */
export async function submissionBoundary(rpc: Rpc, context: SubmissionContext, account: Address) {
  await checkChain(rpc, context);
  const finalized = await requireFinality(rpc);
  const head = block(await rpc('eth_getBlockByNumber', ['latest', false]));
  let pinnedNonce: unknown;
  try {
    pinnedNonce = await rpc('eth_getTransactionCount', [
      account,
      { blockHash: head.hash, requireCanonical: true },
    ]);
  } catch {
    throw new Error(
      'The RPC could not read the account nonce at the canonical block hash. Nothing was sent. A canonical hash-pinned nonce read is required.',
    );
  }
  const nonce = quantity(pinnedNonce);
  const pendingNonce = quantity(await rpc('eth_getTransactionCount', [account, 'pending']));
  assert(
    nonce === pendingNonce,
    'This account has pending activity or its nonce changed. Resolve it in your wallet before submitting here. Nothing was sent.',
  );
  assert(
    nonce < 2n ** 64n - 1n,
    'The account nonce is outside the supported range. Nothing was sent.',
  );
  await canonical(rpc, head);
  await checkChain(rpc, context);
  const again = block(await rpc('eth_getBlockByNumber', ['latest', false]));
  assert(
    again.number === head.number && again.hash === head.hash,
    'The canonical head changed while preparing the wallet request. Nothing was sent. Refresh and review again.',
  );
  await recheckFinality(rpc, finalized, head);
  // The boundary only has to lie before the transaction's inclusion, and every later decision requires it to be
  // canonical still. On a public chain the head can be replaced by a one-block reorganisation, and the hold
  // could then never end (review R328-3P-1): there the boundary is the block already settled by the chain's
  // confirmation rule. The Bloch L2 (an RPC without a strict reader) keeps the head.
  const boundary = (rpc as Rpc & { strict?: Rpc }).strict ? finalized : head;
  return {
    afterBlockNumber: boundary.number.toString(),
    afterBlockHash: boundary.hash,
    nonce: nonce.toString(),
  };
}

/** A user-requested review keeps the original nonce, body and boundary. It is
 * refused while anything from this account is still queued (round 14 review, H1). */
export async function verifySameNonceReview(
  rpc: Rpc,
  intent: SubmissionIntent,
  context: SubmissionContext,
  deadline: bigint,
): Promise<void> {
  assertSubmissionContext(intent, context);
  await checkChain(rpc, context);
  const finalized = await requireFinality(rpc);
  const boundary = { number: BigInt(intent.afterBlockNumber), hash: intent.afterBlockHash };
  await canonical(rpc, boundary);
  const rawHead = object(await rpc('eth_getBlockByNumber', ['latest', false]));
  const head = block(rawHead);
  assert(head.number >= boundary.number, 'The RPC head is behind the saved submission boundary.');
  const nonce = quantity(
    await rpc('eth_getTransactionCount', [
      intent.from,
      { blockHash: head.hash, requireCanonical: true },
    ]),
  );
  assert(
    nonce === BigInt(intent.nonce),
    'The canonical account nonce no longer matches this request. Recover its transaction hash from wallet activity; no new nonce or wallet request was created.',
  );
  // A wallet may ignore the nonce this page asks for and sign the same call at the next one. While the original is
  // still queued (pending nonce above the canonical nonce) that would execute the call twice, so no second wallet
  // request is made until the queue holds nothing from this account.
  const pendingNonce = quantity(await rpc('eth_getTransactionCount', [intent.from, 'pending']));
  assert(
    pendingNonce === nonce,
    'A transaction from this account is still queued at the sequencer. A second wallet request could execute the same call twice. Wait for it to be included, then recover its hash from wallet activity; no wallet request was made.',
  );
  assert(
    deadline === 0n || quantity(rawHead.timestamp) < deadline,
    'The saved swap deadline has passed at the canonical head. Repeating its unchanged call would revert. Recover the original outcome; its deadline was not extended.',
  );
  await canonical(rpc, head);
  await checkChain(rpc, context);
  const again = block(await rpc('eth_getBlockByNumber', ['latest', false]));
  assert(
    again.number === head.number && again.hash === head.hash,
    'The head changed during review. Nothing was sent; review the same request again.',
  );
  await canonical(rpc, boundary);
  await recheckFinality(rpc, finalized, head);
}

/** The deadline inside a saved router swap call, or null when the data is not one of the router's swaps.
 * The record's own `deadline` field must equal it: the field ends the hold, the calldata is what a wallet
 * signs (review R309-2P-4). */
export function savedSwapDeadline(data: Hex): bigint | null {
  try {
    const call = decodeFunctionData({ abi: ROUTER_ABI, data });
    const deadline = call.args[call.args.length - 1];
    return typeof deadline === 'bigint' ? deadline : null;
  } catch {
    // Round 20: the router's deposit and removal calls carry their deadline the same way (last argument).
    return savedLiquidityDeadline(data);
  }
}

/**
 * Two decisions end a hold WITHOUT the saved call's own receipt: its deadline passed (`expiredSwap`), or another
 * transaction used its nonce (`finalizedReplacementReceipt`). If either were wrong, a second request could execute
 * next to the first. A third is a receipt that says REVERTED (`finalizedTransactionReceipt`): after it the user
 * may send the swap again. An RPC of a public chain whose page settles on a confirmation depth carries a stricter
 * reader for exactly these two (multichain/rpc.ts `chainRpc`, review R309-MC-2). The Bloch L2's RPC carries
 * none, so nothing changes there: `finalized` for everything.
 */
const strictOf = (rpc: Rpc): Rpc => (rpc as Rpc & { strict?: Rpc }).strict ?? rpc;
/** The reader that settles a REVERTED swap: the chain's own rule for it, else the strict rule (R328-3P-3). A
 * reverted approval or skim is settled like a success: sending it again cannot hurt. */
const revertedOf = (rpc: Rpc): Rpc => (rpc as Rpc & { reverted?: Rpc }).reverted ?? strictOf(rpc);

export type ExpiredSwap = {
  /** The canonical finalized block whose timestamp is past the deadline. */
  blockNumber: string;
  blockHash: Hex;
  timestamp: string;
  /** False: the account nonce of the request is still unused there, so the swap did not execute.
   * True: a transaction of the account used that nonce; it may have been this swap. */
  nonceUsed: boolean;
};

/** A swap whose deadline lies before the timestamp of a canonical FINALIZED block can no longer
 * execute: the router refuses it in that block and in every later one (block timestamps never
 * decrease). This is what ends a swap hold without any wallet request (review R309-A1); it says
 * nothing about approvals or skims, which carry no deadline. Null: not established yet. A known
 * hash that is already included keeps the hold for the receipt path. Read-only; never throws for
 * "not yet", throws for evidence that contradicts itself. */
export async function expiredSwap(
  rpc: Rpc,
  intent: SubmissionIntent,
  context: SubmissionContext,
  deadline: bigint,
  hashes: readonly Hex[] = [],
): Promise<ExpiredSwap | null> {
  rpc = strictOf(rpc);
  assertSubmissionContext(intent, context);
  if (!holdsUntilDeadline(intent.kind) || deadline <= 0n) return null;
  // Never on a deadline other than the one in the call a wallet may have signed.
  if (savedSwapDeadline(intent.data) !== deadline) return null;
  const read = async () => {
    const raw = object(await rpc('eth_getBlockByNumber', ['finalized', false]));
    return { ...block(raw), timestamp: quantity(raw.timestamp) };
  };
  // One read per pass until the deadline is behind a finalized block; everything else after that.
  const finalized = await read();
  const boundary = { number: BigInt(intent.afterBlockNumber), hash: intent.afterBlockHash };
  if (finalized.timestamp <= deadline || finalized.number < boundary.number) return null;
  await checkChain(rpc, context);
  await canonical(rpc, boundary);
  await canonical(rpc, finalized);
  for (const hash of hashes) {
    const body = await rpc('eth_getTransactionByHash', [hash]);
    if (body === null) continue;
    // A hash whose body is not the saved call (a wrapper transaction, appended calldata) says nothing about
    // the saved call: no copy of that call can execute after the deadline, whatever this hash is (R309-2P-3).
    let tx: Record<string, unknown>;
    try {
      tx = matchTransaction(body, hash, intent);
    } catch {
      continue;
    }
    // Included somewhere: its finalized receipt decides, not the deadline.
    if (tx.blockNumber !== null || tx.blockHash !== null) return null;
  }
  const nonce = quantity(
    await rpc('eth_getTransactionCount', [
      intent.from,
      { blockHash: finalized.hash, requireCanonical: true },
    ]),
  );
  const again = await read();
  assert(
    again.number >= finalized.number &&
      (again.number !== finalized.number ||
        (again.hash === finalized.hash && again.timestamp === finalized.timestamp)),
    'Finality moved backwards or changed while checking the swap deadline. The submission hold remains.',
  );
  await canonical(rpc, finalized);
  await checkChain(rpc, context);
  return {
    blockNumber: finalized.number.toString(),
    blockHash: finalized.hash,
    timestamp: finalized.timestamp.toString(),
    nonceUsed: nonce > BigInt(intent.nonce),
  };
}

function afterSubmission(tx: Record<string, unknown>, intent: SubmissionIntent) {
  if (tx.blockNumber === null && tx.blockHash === null) return;
  assert(
    quantity(tx.blockNumber) > BigInt(intent.afterBlockNumber),
    'This transaction was included before the saved wallet request. A historical hash cannot clear the submission hold.',
  );
}

/** Used for a manually supplied hash; never sends or replaces a transaction. */
export async function verifySubmissionHash(
  rpc: Rpc,
  hash: Hex,
  intent: SubmissionIntent,
  context: SubmissionContext,
): Promise<void> {
  assert(
    isSubmissionHash(hash),
    'Enter a nonzero 32-byte transaction hash from your wallet activity.',
  );
  assertSubmissionContext(intent, context);
  await checkChain(rpc, context);
  const tx = await rpc('eth_getTransactionByHash', [hash]);
  assert(
    tx !== null,
    'The RPC has no transaction body for that hash yet. The submission hold remains.',
  );
  afterSubmission(matchTransaction(tx, hash, intent), intent);
  await canonical(rpc, { number: BigInt(intent.afterBlockNumber), hash: intent.afterBlockHash });
  await checkChain(rpc, context);
}

function block(value: unknown) {
  const b = object(value);
  assert(isSubmissionHash(b.hash), 'The RPC returned an invalid block hash.');
  return { number: quantity(b.number), hash: b.hash as Hex };
}

type ReceiptTarget = { from: Address; to: Address | null };
function receipt(value: unknown, hash: Hex, intent: ReceiptTarget) {
  const r = object(value);
  assert(
    r.transactionHash === hash &&
      typeof r.from === 'string' &&
      r.from.toLowerCase() === intent.from &&
      (intent.to === null
        ? r.to === null
        : typeof r.to === 'string' && r.to.toLowerCase() === intent.to) &&
      isSubmissionHash(r.blockHash) &&
      (r.status === '0x0' || r.status === '0x1'),
    'The RPC returned an invalid receipt identity or status.',
  );
  return {
    status: r.status === '0x1' ? ('success' as const) : ('reverted' as const),
    blockNumber: quantity(r.blockNumber),
    blockHash: r.blockHash as Hex,
    gasUsed: quantity(r.gasUsed),
  };
}

const numberTag = (n: bigint) => `0x${n.toString(16)}`;
async function canonical(rpc: Rpc, expected: { number: bigint; hash: Hex }) {
  const current = block(await rpc('eth_getBlockByNumber', [numberTag(expected.number), false]));
  assert(
    current.number === expected.number && current.hash === expected.hash,
    'The receipt or finality checkpoint is no longer canonical. The submission hold remains.',
  );
}

/** A truthy response is insufficient: follower status can be lost or malformed
 * after the page snapshot. Every wallet preparation needs current canonical finality. */
export async function requireFinality(rpc: Rpc) {
  try {
    const finalized = block(await rpc('eth_getBlockByNumber', ['finalized', false]));
    await canonical(rpc, finalized);
    return finalized;
  } catch {
    throw new Error(
      `${wording.finality} is unavailable, so nothing was sent. Refresh when it is back.`,
    );
  }
}

async function recheckFinality(
  rpc: Rpc,
  earlier: { number: bigint; hash: Hex },
  head: { number: bigint; hash: Hex },
) {
  const final = await requireFinality(rpc);
  assert(
    final.number >= earlier.number &&
      final.number <= head.number &&
      (final.number !== earlier.number || final.hash === earlier.hash),
    `${wording.finality} moved backwards, changed or exceeded the canonical head. No wallet request was made.`,
  );
  await canonical(rpc, earlier);
}

/** Null means still unresolved. Missing/malformed/moving evidence never frees a hold. */
export async function finalizedSubmissionReceipt(
  rpc: Rpc,
  hash: Hex,
  intent: SubmissionIntent,
  context: SubmissionContext = intent,
): Promise<Receipt | null> {
  const result = await finalizedTransactionReceipt(rpc, hash, intent, context, (value) => ({
    tx: matchTransaction(value, hash, intent),
    target: intent,
  }));
  return result?.receipt ?? null;
}

/** Both original and replacement outcomes require the same immutable inclusion
 * and finality checks; only transaction authentication differs. */
async function finalizedTransactionReceipt(
  rpc: Rpc,
  hash: Hex,
  intent: SubmissionIntent,
  context: SubmissionContext,
  authenticate: (value: unknown) => { tx: Record<string, unknown>; target: ReceiptTarget },
): Promise<{ receipt: Receipt; blockHash: Hex } | null> {
  assertSubmissionContext(intent, context);
  assert(isSubmissionHash(hash), 'Invalid saved transaction hash.');
  await checkChain(rpc, context);
  const body = await rpc('eth_getTransactionByHash', [hash]);
  if (body === null) return null;
  const { tx, target } = authenticate(body);
  afterSubmission(tx, intent);
  const raw = await rpc('eth_getTransactionReceipt', [hash]);
  if (raw === null) return null;
  const r = receipt(raw, hash, target);
  assert(
    tx.blockHash === r.blockHash && quantity(tx.blockNumber) === r.blockNumber,
    'The transaction body and receipt disagree about inclusion.',
  );
  // A REVERTED outcome frees the account for another request (the page offers a retry after a revert on the
  // minimum): if its block were replaced, the first transaction and the retry could both execute. Like the two
  // decisions that end a hold without a receipt, it therefore waits for the strict rule where the RPC carries
  // one (review R328-7). A success is released by the settle rule: nothing is sent again after it.
  const settling =
    r.status === 'reverted' && holdsUntilDeadline(intent.kind) ? revertedOf(rpc) : rpc;
  const finalized = block(await settling('eth_getBlockByNumber', ['finalized', false]));
  if (finalized.number < r.blockNumber) return null;
  const included = { number: r.blockNumber, hash: r.blockHash };
  const boundary = { number: BigInt(intent.afterBlockNumber), hash: intent.afterBlockHash };
  await canonical(rpc, boundary);
  await canonical(rpc, included);
  await canonical(rpc, finalized);
  const again = receipt(await rpc('eth_getTransactionReceipt', [hash]), hash, target);
  assert(
    again.blockHash === r.blockHash &&
      again.blockNumber === r.blockNumber &&
      again.status === r.status &&
      again.gasUsed === r.gasUsed,
    'The receipt changed during verification. The submission hold remains.',
  );
  const { tx: txAgain } = authenticate(await rpc('eth_getTransactionByHash', [hash]));
  assert(
    txAgain.blockHash === r.blockHash && quantity(txAgain.blockNumber) === r.blockNumber,
    'Transaction inclusion changed during verification.',
  );
  const finalAgain = block(await settling('eth_getBlockByNumber', ['finalized', false]));
  assert(
    finalAgain.number >= finalized.number &&
      (finalAgain.number !== finalized.number || finalAgain.hash === finalized.hash),
    'Finality moved backwards or changed during verification.',
  );
  await canonical(rpc, finalAgain);
  await canonical(rpc, finalized);
  await canonical(rpc, included);
  await checkChain(rpc, context);
  await canonical(rpc, boundary);
  return {
    receipt: { status: r.status, blockNumber: r.blockNumber, gasUsed: r.gasUsed },
    blockHash: r.blockHash,
  };
}

export type ReplacementProof = {
  intentId: string;
  transactionHash: Hex;
  from: Address;
  to: Address | null;
  data: Hex;
  value: string;
  nonce: string;
  blockNumber: string;
  blockHash: Hex;
  receiptStatus: Receipt['status'];
  gasUsed: string;
};

/** Read-only evidence of another body consuming the exact original nonce. This
 * does not classify the saved intent as executed and never clears local storage. */
export async function finalizedReplacementReceipt(
  rpc: Rpc,
  hash: Hex,
  intent: SubmissionIntent,
  context: SubmissionContext,
): Promise<ReplacementProof | null> {
  rpc = strictOf(rpc);
  let first:
    | { from: Address; to: Address | null; data: Hex; value: string; nonce: string }
    | undefined;
  const result = await finalizedTransactionReceipt(rpc, hash, intent, context, (value) => {
    const tx = object(value);
    assert(
      tx.hash === hash &&
        typeof tx.from === 'string' &&
        tx.from.toLowerCase() === intent.from &&
        quantity(tx.chainId) === BigInt(intent.chainId) &&
        quantity(tx.nonce) === BigInt(intent.nonce),
      'This replacement hash does not match the original sender, chain and nonce. Its hold remains.',
    );
    assert(
      (tx.to === null || (typeof tx.to === 'string' && /^0x[0-9a-f]{40}$/i.test(tx.to))) &&
        typeof tx.input === 'string' &&
        /^0x(?:[0-9a-f]{2}){0,65536}$/i.test(tx.input),
      'The replacement transaction body is malformed. Its hold remains.',
    );
    const body = {
      from: intent.from,
      to: tx.to === null ? null : ((tx.to as string).toLowerCase() as Address),
      data: (tx.input as string).toLowerCase() as Hex,
      value: quantity(tx.value).toString(),
      nonce: intent.nonce,
    };
    assert(
      body.to !== intent.to ||
        body.data !== intent.data ||
        BigInt(body.value) !== BigInt(intent.value),
      'This is the original call, not a different replacement. Use Check transaction hash to restore its tracking.',
    );
    assert(
      !first || stableJson(first) === stableJson(body),
      'The replacement body changed during verification. Its hold remains.',
    );
    first = body;
    return { tx, target: body };
  });
  if (!result || !first) return null;
  const finalized = await requireFinality(rpc);
  assert(
    finalized.number >= result.receipt.blockNumber,
    'Replacement inclusion is no longer finalized. Its hold remains.',
  );
  const nonce = quantity(
    await rpc('eth_getTransactionCount', [
      intent.from,
      { blockHash: finalized.hash, requireCanonical: true },
    ]),
  );
  assert(
    nonce > BigInt(intent.nonce),
    'Canonical finalized state does not show the original nonce consumed. Its hold remains.',
  );
  const again = await requireFinality(rpc);
  assert(
    again.number >= finalized.number &&
      (again.number !== finalized.number || again.hash === finalized.hash),
    'Replacement finality changed during the nonce check. Its hold remains.',
  );
  await canonical(rpc, finalized);
  await canonical(rpc, { number: result.receipt.blockNumber, hash: result.blockHash });
  await canonical(rpc, { number: BigInt(intent.afterBlockNumber), hash: intent.afterBlockHash });
  await checkChain(rpc, context);
  return {
    ...first,
    intentId: intent.id,
    transactionHash: hash,
    blockHash: result.blockHash,
    blockNumber: result.receipt.blockNumber.toString(),
    receiptStatus: result.receipt.status,
    gasUsed: result.receipt.gasUsed.toString(),
  };
}
