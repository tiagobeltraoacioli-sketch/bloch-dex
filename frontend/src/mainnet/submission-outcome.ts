// A wallet hash is an observation, not proof that it identifies the requested
// transaction. Keep the durable hold until its exact call is canonically finalized.
import { sha256, stringToBytes, type Address, type Hex } from 'viem';
import type { Rpc } from '../devnet4/chain';
import { stableJson, type DevnetDeployment } from '../devnet4/record';
import type { Receipt } from '../devnet4/swap';

export type SubmissionContext = { chainId: number; genesisHash: Hex; deploymentId: Hex };
export type SubmissionIntent = SubmissionContext & {
  id: string;
  kind: 'swap' | 'approval' | 'skim';
  from: Address;
  to: Address;
  data: Hex;
  value: string;
  gas: string;
};
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
      quantity(tx.chainId) === BigInt(intent.chainId),
    'This hash does not match the saved sender, destination, call, value and chain. The submission hold remains.',
  );
  return tx;
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
  matchTransaction(tx, hash, intent);
  await checkChain(rpc, context);
}

function block(value: unknown) {
  const b = object(value);
  assert(isSubmissionHash(b.hash), 'The RPC returned an invalid block hash.');
  return { number: quantity(b.number), hash: b.hash as Hex };
}

function receipt(value: unknown, hash: Hex) {
  const r = object(value);
  assert(
    r.transactionHash === hash &&
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

/** Null means still unresolved. Missing/malformed/moving evidence never frees a hold. */
export async function finalizedSubmissionReceipt(
  rpc: Rpc,
  hash: Hex,
  intent: SubmissionIntent,
  context: SubmissionContext = intent,
): Promise<Receipt | null> {
  assertSubmissionContext(intent, context);
  assert(isSubmissionHash(hash), 'Invalid saved transaction hash.');
  await checkChain(rpc, context);
  const body = await rpc('eth_getTransactionByHash', [hash]);
  if (body === null) return null;
  const tx = matchTransaction(body, hash, intent);
  const raw = await rpc('eth_getTransactionReceipt', [hash]);
  if (raw === null) return null;
  const r = receipt(raw, hash);
  assert(
    tx.blockHash === r.blockHash && quantity(tx.blockNumber) === r.blockNumber,
    'The transaction body and receipt disagree about inclusion.',
  );
  const finalized = block(await rpc('eth_getBlockByNumber', ['finalized', false]));
  if (finalized.number < r.blockNumber) return null;
  const included = { number: r.blockNumber, hash: r.blockHash };
  await canonical(rpc, included);
  await canonical(rpc, finalized);
  const again = receipt(await rpc('eth_getTransactionReceipt', [hash]), hash);
  assert(
    again.blockHash === r.blockHash &&
      again.blockNumber === r.blockNumber &&
      again.status === r.status &&
      again.gasUsed === r.gasUsed,
    'The receipt changed during verification. The submission hold remains.',
  );
  const txAgain = matchTransaction(await rpc('eth_getTransactionByHash', [hash]), hash, intent);
  assert(
    txAgain.blockHash === r.blockHash && quantity(txAgain.blockNumber) === r.blockNumber,
    'Transaction inclusion changed during verification.',
  );
  const finalAgain = block(await rpc('eth_getBlockByNumber', ['finalized', false]));
  assert(
    finalAgain.number >= finalized.number &&
      (finalAgain.number !== finalized.number || finalAgain.hash === finalized.hash),
    'Finality moved backwards or changed during verification.',
  );
  await canonical(rpc, finalAgain);
  await canonical(rpc, finalized);
  await canonical(rpc, included);
  await checkChain(rpc, context);
  return { status: r.status, blockNumber: r.blockNumber, gasUsed: r.gasUsed };
}
