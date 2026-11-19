// One durable wallet-submission hold per chain/account, shared by swaps,
// approvals and skims. The intent exists before the wallet is called; losing
// the reply does not establish that no transaction was sent.
import { wording } from './wording';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Address, Hex } from 'viem';
import type { Rpc } from '../devnet4/chain';
import {
  RECEIPT_TIMEOUT_MS,
  sendTransaction,
  type Receipt,
  type TransactionRequest,
} from '../devnet4/swap';
import { stableJson, type DevnetDeployment } from '../devnet4/record';
import type { Provider } from '../wallet';
import {
  assertSubmissionContext,
  expiredSwap,
  savedCallDeadline,
  finalizedSubmissionReceipt,
  finalizedReplacementReceipt,
  holdsUntilDeadline,
  isSubmissionHash,
  savedCallNonce,
  submissionContext,
  submissionBoundary,
  verifySubmissionHash,
  verifySameNonceReview,
  type SubmissionContext,
  type SubmissionIntent,
  type ReplacementProof,
} from './submission-outcome';
import { withSubmissionLock, withWalletRequestLock } from './submission-lock';
import { sameNonceReviewDetails, transactionForSameNonceReview } from './submission-review';
import { submissionFeeNote } from './submission-fees';
import {
  NEW_SLOT_FEE_OFF,
  priceNewSlots,
  transientSlots,
  type NewSlotFeePolicy,
  type PricedCall,
} from './newslotfee';
import type { RevertCause, SwapRetryInfo } from './retry';

export type PendingSwap = {
  hash?: Hex;
  candidateHashes?: Hex[];
  /** Candidate hashes whose transaction body this page has itself read from the RPC carrying the saved call at
   * the saved nonce. A candidate seen so cannot execute once another transaction used that nonce, even when the
   * RPC no longer shows it (cancelled or dropped): review R309-A2. */
  nonceSeen?: Hex[];
  walletAttempt?: {
    id: string;
    mode: 'initial' | 'review';
    state: 'awaiting-wallet' | 'returned' | 'unknown' | 'rejected';
    startedAtMs: number;
  };
  label: string;
  deadline: bigint;
  sentAtMs: number;
  /** What a revert explanation and the one retry need (DEX-5). Absent in older records. */
  retry?: SwapRetryInfo;
  intent?: SubmissionIntent;
  note?: string;
};
export type TrackedSwap = PendingSwap & {
  state: 'pending' | 'unknown' | 'mined' | 'failed' | 'replaced' | 'expired';
  detail: string;
  /** Set on a failed swap once the page has read why it reverted. */
  cause?: RevertCause;
  /** The block of the verified receipt (mined or reverted), for a caller that explains the outcome (round 20). */
  receiptBlock?: bigint;
};
export type SwapPoll =
  | { kind: 'receipt'; hash: Hex; receipt: Receipt }
  /** The RPC answered and the swap has no receipt yet. */
  | { kind: 'waiting' }
  /** Evidence was unavailable or could not be verified. This says nothing about submission. */
  | { kind: 'unreachable' };

const STORAGE_PREFIX = 'postern.mainnet.pendingSwap.v1';
const POLL_INTERVAL_MS = 10_000;
const MAX_CANDIDATES = 32;

export const submissionHashes = (swap: PendingSwap): Hex[] => [
  ...new Set([...(swap.hash ? [swap.hash] : []), ...(swap.candidateHashes ?? [])]),
];

export const pendingSwapKey = (chainId: number, account: Address) =>
  `${STORAGE_PREFIX}.${chainId}.${account.toLowerCase()}`;

/**
 * A liquidity hold is saved a second time, under a key of its own (review R413-8). A build of this site from
 * before the `liquidity` kind cannot read such a record: it sends nothing while the record is there, cannot end
 * it by its deadline, and offers to discard it. If the site is rolled back, the user discards it there and the
 * site is rolled forward inside the request's deadline, the wallet may still sign the first request while the
 * page has forgotten it. The older build does not know this second key and cannot remove it: when the main record
 * is missing and a readable liquidity hold is here, the hold is put back. It then ends as every hold does (its
 * verified receipt, or its deadline at the strict block). Putting a hold back can only stop the page from sending;
 * the second copy is removed together with the hold it mirrors.
 */
const LIQUIDITY_HOLD_PREFIX = 'postern.mainnet.liquidityHold.v1';
export const liquidityHoldKey = (chainId: number, account: Address) =>
  `${LIQUIDITY_HOLD_PREFIX}.${chainId}.${account.toLowerCase()}`;
const secondKeyOf = (key: string): string | null =>
  key.startsWith(`${STORAGE_PREFIX}.`)
    ? `${LIQUIDITY_HOLD_PREFIX}${key.slice(STORAGE_PREFIX.length)}`
    : null;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const UINT = /^[0-9]{1,78}$/;

function parseIntent(value: unknown): SubmissionIntent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (
    typeof v.id !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(v.id) ||
    !['swap', 'approval', 'skim', 'liquidity'].includes(String(v.kind)) ||
    !Number.isSafeInteger(v.chainId) ||
    Number(v.chainId) <= 0 ||
    !isSubmissionHash(v.genesisHash) ||
    !isSubmissionHash(v.deploymentId) ||
    !isSubmissionHash(v.afterBlockHash) ||
    typeof v.afterBlockNumber !== 'string' ||
    !UINT.test(v.afterBlockNumber) ||
    typeof v.from !== 'string' ||
    !ADDRESS.test(v.from) ||
    typeof v.to !== 'string' ||
    !ADDRESS.test(v.to) ||
    typeof v.data !== 'string' ||
    !/^0x(?:[0-9a-f]{2}){0,65536}$/.test(v.data) ||
    typeof v.value !== 'string' ||
    !UINT.test(v.value) ||
    typeof v.nonce !== 'string' ||
    !UINT.test(v.nonce) ||
    BigInt(v.nonce) >= 2n ** 64n - 1n ||
    typeof v.gas !== 'string' ||
    !UINT.test(v.gas)
  )
    return undefined;
  return v as SubmissionIntent;
}

/** The stored retry fields; anything malformed drops only these fields. */
function parseRetry(v: unknown): SwapRetryInfo | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  if (
    typeof r.tokenIn !== 'string' ||
    !ADDRESS.test(r.tokenIn) ||
    typeof r.tokenOut !== 'string' ||
    !ADDRESS.test(r.tokenOut) ||
    typeof r.amountIn !== 'string' ||
    !UINT.test(r.amountIn) ||
    typeof r.minimumOut !== 'string' ||
    !UINT.test(r.minimumOut) ||
    !Array.isArray(r.path) ||
    r.path.length < 2 ||
    !r.path.every((a) => typeof a === 'string' && ADDRESS.test(a)) ||
    typeof r.slippageBps !== 'number' ||
    !Number.isInteger(r.slippageBps) ||
    (r.attempt !== 1 && r.attempt !== 2)
  )
    return undefined;
  return {
    tokenIn: r.tokenIn as Address,
    tokenOut: r.tokenOut as Address,
    amountIn: BigInt(r.amountIn),
    minimumOut: BigInt(r.minimumOut),
    path: r.path as Address[],
    slippageBps: r.slippageBps,
    attempt: r.attempt,
  };
}

/** Parse a stored record; callers must block a nonempty malformed record. */
export function parsePendingSwap(raw: string | null): PendingSwap | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const intent = parseIntent(v.intent);
    const candidateHashes = v.candidateHashes;
    const nonceSeen = v.nonceSeen;
    const attempt = v.walletAttempt as PendingSwap['walletAttempt'];
    const known = new Set([
      ...(typeof v.hash === 'string' ? [v.hash] : []),
      ...(Array.isArray(candidateHashes) ? candidateHashes : []),
    ]);
    if (
      (nonceSeen !== undefined &&
        (!Array.isArray(nonceSeen) ||
          !intent ||
          new Set(nonceSeen).size !== nonceSeen.length ||
          !nonceSeen.every((h) => isSubmissionHash(h) && known.has(h)))) ||
      (v.hash === undefined ? !intent : !isSubmissionHash(v.hash)) ||
      (v.intent !== undefined && !intent) ||
      (candidateHashes !== undefined &&
        (!Array.isArray(candidateHashes) ||
          candidateHashes.length > MAX_CANDIDATES ||
          !candidateHashes.every(isSubmissionHash) ||
          new Set(candidateHashes).size !== candidateHashes.length ||
          (candidateHashes.length > 0 && !v.hash) ||
          new Set([...(v.hash ? [v.hash] : []), ...candidateHashes]).size > MAX_CANDIDATES)) ||
      (attempt !== undefined &&
        (!attempt ||
          typeof attempt !== 'object' ||
          typeof attempt.id !== 'string' ||
          !/^[0-9a-f-]{36}$/.test(attempt.id) ||
          !['initial', 'review'].includes(attempt.mode) ||
          !['awaiting-wallet', 'returned', 'unknown', 'rejected'].includes(attempt.state) ||
          !Number.isFinite(attempt.startedAtMs) ||
          attempt.startedAtMs < 0)) ||
      typeof v.label !== 'string' ||
      typeof v.deadline !== 'string' ||
      !/^[0-9]{1,20}$/.test(v.deadline) ||
      typeof v.sentAtMs !== 'number' ||
      !Number.isFinite(v.sentAtMs) ||
      // The field that ends a swap hold is the deadline of the saved call itself; other requests carry none.
      // A record where they differ is corrupt or edited and is unreadable as a whole (review R309-2P-4).
      (intent !== null &&
        intent !== undefined &&
        BigInt(v.deadline) !==
          (holdsUntilDeadline(intent.kind) ? savedCallDeadline(intent.kind, intent.data) : 0n))
    )
      return null;
    const retry = parseRetry(v.retry);
    return {
      ...(v.hash ? { hash: v.hash as Hex } : {}),
      ...(candidateHashes ? { candidateHashes: candidateHashes as Hex[] } : {}),
      ...(nonceSeen ? { nonceSeen: nonceSeen as Hex[] } : {}),
      ...(attempt ? { walletAttempt: attempt } : {}),
      label: v.label,
      deadline: BigInt(v.deadline),
      sentAtMs: v.sentAtMs,
      ...(retry ? { retry } : {}),
      ...(intent ? { intent } : {}),
      ...(typeof v.note === 'string' ? { note: v.note.slice(0, 500) } : {}),
    };
  } catch {
    return null;
  }
}

/** The second copy of a liquidity hold whose main record is gone, put back as the main record; else null. */
function restoredLiquidityHold(key: string): string | null {
  try {
    const second = secondKeyOf(key);
    const raw = second ? localStorage.getItem(second) : null;
    if (raw === null || parsePendingSwap(raw)?.intent?.kind !== 'liquidity') return null;
    localStorage.setItem(key, raw);
    return localStorage.getItem(key) === raw ? raw : null;
  } catch {
    return null;
  }
}

function readStored(key: string): PendingSwap | null {
  const raw = localStorage.getItem(key) ?? restoredLiquidityHold(key);
  const parsed = parsePendingSwap(raw);
  if (raw !== null && !parsed) throw new Error(UNREADABLE_RECORD);
  return parsed;
}

function writeStored(key: string, swap: PendingSwap): boolean {
  try {
    const retry = swap.retry && {
      ...swap.retry,
      amountIn: swap.retry.amountIn.toString(),
      minimumOut: swap.retry.minimumOut.toString(),
    };
    const encoded = JSON.stringify({
      ...swap,
      deadline: swap.deadline.toString(),
      ...(retry ? { retry } : {}),
    });
    localStorage.setItem(key, encoded);
    if (localStorage.getItem(key) !== encoded) return false;
    if (swap.intent?.kind === 'liquidity') {
      // The second copy (see `liquidityHoldKey`). The hold itself is saved; a refusal here loses only the copy.
      try {
        const second = secondKeyOf(key);
        if (second) localStorage.setItem(second, encoded);
      } catch {
        /* the main record stands */
      }
    }
    return true;
  } catch {
    return false;
  }
}

const identityOf = (swap: PendingSwap) => swap.intent?.id ?? swap.hash;
const sameIntent = (one: PendingSwap, two: PendingSwap) =>
  one.intent && two.intent
    ? stableJson(one.intent) === stableJson(two.intent)
    : identityOf(one) === identityOf(two);

function removeStored(key: string, swap: PendingSwap): boolean {
  try {
    // The main record as it is (nothing is put back here: this is the hold being cleared).
    const raw = localStorage.getItem(key);
    const retained = parsePendingSwap(raw);
    if (raw !== null && !retained) throw new Error(UNREADABLE_RECORD);
    if (retained && (identityOf(retained) !== identityOf(swap) || !sameIntent(retained, swap)))
      return false;
    // The second copy of a liquidity hold goes with the hold it mirrors, and only with that one. It goes FIRST
    // (review R413-14): another tab reads outside the cross-tab lock, and a read between the two removals must
    // find either the main record (an ordinary hold, still there) or nothing, never a copy without its record,
    // which it would put back although the hold has just ended. A stop between the two leaves an ordinary hold.
    const second = secondKeyOf(key);
    if (second && swap.intent?.kind === 'liquidity') {
      const copy = parsePendingSwap(localStorage.getItem(second));
      if (copy?.intent?.id === swap.intent.id) {
        localStorage.removeItem(second);
        if (localStorage.getItem(second) !== null) return false;
      }
    }
    localStorage.removeItem(key);
    if (localStorage.getItem(key) !== null) return false;
    return true;
  } catch {
    return false;
  }
}

/** One check of a sent swap. Never throws. */
export async function pollPendingSwap(
  rpc: Rpc,
  swap: PendingSwap,
  _nowMs: number,
  context?: SubmissionContext,
): Promise<SwapPoll> {
  const candidates = submissionHashes(swap);
  if (candidates.length === 0) return { kind: 'waiting' };
  let unavailable = false;
  for (const hash of candidates)
    try {
      // A missing receipt after a deadline is not proof of non-execution. Legacy
      // records without a saved call also cannot authenticate a wallet's hash.
      if (!swap.intent) return { kind: 'unreachable' };
      const receipt = await finalizedSubmissionReceipt(rpc, hash, swap.intent, context);
      if (receipt) return { kind: 'receipt', hash, receipt };
    } catch {
      unavailable = true;
    }
  return { kind: unavailable ? 'unreachable' : 'waiting' };
}

/** After a same-nonce review: which known candidates the wallet signed at another nonce than the saved one.
 * Read on every poll, not once: the RPC may show a transaction body only some time after the wallet returned
 * its hash. Never throws; an RPC that cannot answer adds nothing. */
export async function otherNonceWarning(rpc: Rpc, swap: PendingSwap): Promise<string> {
  if (!swap.intent || swap.walletAttempt?.mode !== 'review') return '';
  const found: string[] = [];
  for (const hash of submissionHashes(swap)) {
    const nonce = savedCallNonce(
      await rpc('eth_getTransactionByHash', [hash]).catch(() => null),
      swap.intent,
    );
    if (nonce !== null && nonce !== BigInt(swap.intent.nonce))
      found.push(`${hash} at nonce ${nonce}`);
  }
  return found.length
    ? ` Your wallet signed this request at another nonce than the reviewed nonce ${swap.intent.nonce} (${found.join(', ')}): that is a second, separate transaction, not a replacement. Cancel it in your wallet if it has not been included.`
    : '';
}

/** The wallet's own chain, read right before a wallet request (review R309-A4): the user may have switched
 * network during the page's reads, and not every wallet enforces the chain ID of a request. Never throws; a wallet
 * that cannot say which chain it is on is treated as being on another one. */
export async function walletOnChain(provider: Provider, chainId: number): Promise<boolean> {
  try {
    const answer = await provider.request({ method: 'eth_chainId' });
    return (
      typeof answer === 'string' &&
      /^0x[0-9a-f]+$/i.test(answer) &&
      BigInt(answer) === BigInt(chainId)
    );
  } catch {
    return false;
  }
}

export const REVIEW_NOT_FOR_SWAPS =
  'A swap is never requested from the wallet a second time: an earlier request may still be open or signed there, and two copies inside the deadline would both execute. This hold ends by itself once the swap deadline has passed in a finalized block. No wallet request was made.';

export const REPLACEMENT_NOT_FOR_UNSEEN_SWAPS =
  'This swap has no transaction hash from your wallet, so nothing shows which nonce the wallet would sign it with: another transaction at the saved nonce does not prove that the swap cannot execute. The hold ends by itself once the swap deadline has passed in a finalized block; if you find the swap in your wallet activity, check its hash instead. The hold remains.';

/** A stored record this page cannot read (corrupt, edited, or a deadline that is not the saved call's). */
export const UNREADABLE_RECORD =
  'The saved submission record is unreadable. Check wallet activity before using this page again.';

export const REVIEW_WITH_HASH =
  'Your wallet already returned a transaction hash for this request and may still publish it. A second wallet request could execute the same call twice. Speed it up or cancel it in the wallet itself, then check the resulting hash here. No wallet request was made.';

/**
 * The hold texts were written for a swap. A deposit or removal of liquidity is held by the same rules (round 20);
 * for it the same sentences name "the request". `DO_NOT_RESEND` is left as it is: Swap stays disabled too. A
 * swap's text is returned unchanged.
 */
export function requestWords(kind: SubmissionIntent['kind'] | undefined, text: string): string {
  if (kind !== 'liquidity') return text;
  return text
    .split(DO_NOT_RESEND)
    .map((part) =>
      part
        .replace(/\bA swap is never\b/g, 'A liquidity request is never')
        .replace(/\bThe swap deadline\b/g, "The request's deadline")
        .replace(/\bthe swap deadline\b/g, "the request's deadline")
        .replace(/\bthe swap's\b/g, "the request's")
        .replace(/\bbefore swapping again\b/g, 'before sending it again')
        .replace(
          /\bif you then swap again, both swaps execute\b/g,
          'if you then send it again, both execute',
        )
        .replace(/\ba second swap\b/g, 'a second request')
        .replace(/\b(this|This|the|The) swap\b/g, '$1 request'),
    )
    .join(DO_NOT_RESEND);
}

const DO_NOT_RESEND =
  'Do not resend with a new nonce; Swap stays disabled until the outcome is known.';

/** What ends the wait of a swap hold on a quiet chain, said to the user who is waiting (review R309-3P-3). */
export function idleWaitNote(swap: PendingSwap, heartbeatSeconds: number): string {
  // No heartbeat: a chain that makes blocks whether or not it has work (the public chains of src/multichain).
  if (!swap.intent || !holdsUntilDeadline(swap.intent.kind) || swap.deadline <= 0n) return '';
  if (!(heartbeatSeconds > 0)) return '';
  const hours = Math.max(1, Math.round(heartbeatSeconds / 3_600));
  return ` The L2 makes a block only when it has work: on a quiet chain the finalized block that ends this wait can be up to ${hours} hours away (the L2's heartbeat, then its proof), and comes sooner when anyone transacts.`;
}

function describeHold(
  swap: PendingSwap,
  poll: 'waiting' | 'unreachable',
  nowMs: number,
  saved: boolean,
  heartbeatSeconds: number,
): TrackedSwap {
  const late = nowMs - swap.sentAtMs >= RECEIPT_TIMEOUT_MS;
  const wait = idleWaitNote(swap, heartbeatSeconds);
  if (!swap.hash)
    return {
      ...swap,
      state: 'unknown',
      detail: requestWords(
        swap.intent?.kind,
        `Wallet submission outcome unknown: no transaction hash was returned. ${DO_NOT_RESEND} Check your wallet activity and explorer; a timeout or fee error does not prove that nothing was sent.${swap.intent && holdsUntilDeadline(swap.intent.kind) && swap.deadline > 0n ? ' If your wallet still shows this request and you do not want it, reject it there. The hold ends by itself once the swap deadline has passed in a finalized block.' : ''}${wait}${swap.note ? ` ${swap.note}` : ''}`,
      ),
    };
  const what =
    poll === 'unreachable'
      ? 'The RPC did not answer with verifiable transaction and finalized receipt evidence; the outcome is unknown.'
      : late
        ? 'No verified finalized receipt after an hour, so the outcome is unknown.'
        : `Waiting for the next ${wording.block} and canonical finality.`;
  const lost = saved
    ? ''
    : ' The hash update could not be saved; the earlier submission hold remains after reload.';
  return {
    ...swap,
    state: late || poll === 'unreachable' ? 'unknown' : 'pending',
    detail: requestWords(
      swap.intent?.kind,
      `${what} ${DO_NOT_RESEND}${lost}${swap.hash && wait ? ` This hold ends with the swap's finalized receipt, or once its deadline has passed in a finalized block.${wait}` : ''}`,
    ),
  };
}

export const isOpen = (swap: TrackedSwap | null) =>
  swap?.state === 'pending' || swap?.state === 'unknown';

export function usePendingSwap({
  rpc,
  chainId,
  deployment,
  provider,
  account,
  enabled,
  now,
  onMined,
  explain,
  newSlotFee = NEW_SLOT_FEE_OFF,
  idleHeartbeatSeconds = 86_400,
  intervalMs = POLL_INTERVAL_MS,
}: {
  rpc: Rpc;
  chainId: number;
  deployment?: DevnetDeployment;
  provider?: Provider;
  account?: Address;
  enabled: boolean;
  now: () => number;
  onMined: () => void;
  /** Reads why a reverted swap failed; only called for a swap that carries retry fields. */
  explain?: (swap: PendingSwap, receipt: Receipt) => Promise<RevertCause>;
  /** The network file's new-slot fee policy: a same-nonce review is priced like a first request. */
  newSlotFee?: NewSlotFeePolicy;
  /** The L2's idle heartbeat (network file): how long a quiet chain can go without a block. */
  idleHeartbeatSeconds?: number;
  intervalMs?: number;
}) {
  const key = account ? pendingSwapKey(chainId, account) : null;
  const heartbeat = useRef(idleHeartbeatSeconds);
  heartbeat.current = idleHeartbeatSeconds;
  const describeOpen = useCallback(
    (swap: PendingSwap, poll: 'waiting' | 'unreachable', nowMs: number, saved: boolean) =>
      describeHold(swap, poll, nowMs, saved, heartbeat.current),
    [],
  );
  const context = useMemo(
    () => (deployment ? submissionContext(deployment) : undefined),
    [deployment],
  );
  const contextKey = `${key}:${context?.genesisHash}:${context?.deploymentId}`;
  const [tracked, setTracked] = useState<TrackedSwap | null>(null);
  const [trackedContextKey, setTrackedContextKey] = useState(contextKey);
  const visibleTracked = trackedContextKey === contextKey ? tracked : null;
  const [storageProblem, setStorageProblem] = useState<string | null>(null);
  const activeKey = useRef(contextKey);
  activeKey.current = contextKey;
  const activeProvider = useRef(provider);
  activeProvider.current = provider;
  const active = useRef({ enabled, rpc });
  active.current = { enabled, rpc };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [busyContext, setBusyContext] = useState<string | null>(null);
  const walletBusy = busyContext === contextKey;
  // Holds what localStorage may refuse, so a blocked browser keeps the hold until reload.
  const memory = useRef(new Map<string, { swap: PendingSwap; saved: boolean }>());
  // A wallet reply can arrive after an older same-nonce candidate finalized.
  // Ignore it without recreating a hold already settled by this observer.
  const settled = useRef(new Map<string, string>());
  const latest = useRef({ now, onMined, explain });
  latest.current = { now, onMined, explain };

  const recall = useCallback((k: string) => {
    const held = memory.current.get(k);
    const stored = readStored(k);
    if (held && stored) {
      if (!sameIntent(held.swap, stored))
        throw new Error(
          'The saved submission hold changed in another tab. Reload to inspect the retained record. Do not send a new nonce.',
        );
      const candidateHashes = [
        ...new Set([...submissionHashes(stored), ...submissionHashes(held.swap)]),
      ];
      const nonceSeen = [
        ...new Set([...(stored.nonceSeen ?? []), ...(held.swap.nonceSeen ?? [])]),
      ].filter((hash) => candidateHashes.includes(hash));
      return {
        swap: {
          ...held.swap,
          ...stored,
          candidateHashes,
          ...(nonceSeen.length ? { nonceSeen } : {}),
          hash: stored.hash ?? held.swap.hash,
        },
        saved:
          held.saved && candidateHashes.every((hash) => submissionHashes(stored).includes(hash)),
      };
    }
    if (held) return held;
    return stored ? { swap: stored, saved: true } : null;
  }, []);

  const checkContext = useCallback(
    (swap: PendingSwap) => {
      if (!context)
        throw new Error(
          'The verified deployment context is unavailable. The submission hold remains.',
        );
      if (!swap.intent)
        throw new Error(
          'This older submission has no saved transaction intent. Its hold remains; check its wallet activity and explorer and obtain independent confirmation before using this account again.',
        );
      assertSubmissionContext(swap.intent, context, account);
    },
    [context, account],
  );

  useEffect(() => {
    setTrackedContextKey(contextKey);
    try {
      const held = enabled && key ? recall(key) : null;
      // An expired swap has no hash, so the page's history cannot keep it: its notice stays until the next
      // request of the same account and deployment, across the refresh that follows the release.
      const keepExpired = (t: TrackedSwap | null) => {
        if (!t || t.state !== 'expired' || !t.intent || !context) return null;
        try {
          assertSubmissionContext(t.intent, context, account);
          return t;
        } catch {
          return null;
        }
      };
      setTracked((t) =>
        held
          ? describeOpen(
              held.swap,
              held.swap.intent ? 'waiting' : 'unreachable',
              latest.current.now(),
              held.saved,
            )
          : keepExpired(t),
      );
      if (held) checkContext(held.swap);
      setStorageProblem(null);
    } catch (error) {
      setStorageProblem(
        error instanceof Error ? error.message : 'Saved submissions are unavailable.',
      );
    }
  }, [enabled, key, recall, checkContext, contextKey, context, account]);

  useEffect(() => {
    const changed = (event: StorageEvent) => {
      if (event.key !== key || !enabled || !key) return;
      try {
        const held = recall(key);
        if (held) checkContext(held.swap);
        setTracked(
          held ? describeOpen(held.swap, 'waiting', latest.current.now(), held.saved) : null,
        );
      } catch (error) {
        setStorageProblem(error instanceof Error ? error.message : 'Submission storage changed.');
      }
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [key, enabled, recall, checkContext]);

  const openHash = isOpen(visibleTracked) ? submissionHashes(visibleTracked!).join(',') : null;
  useEffect(() => {
    if (!enabled || !key || !openHash) return;
    let held;
    try {
      held = recall(key);
      if (held) checkContext(held.swap);
    } catch (error) {
      setStorageProblem(
        error instanceof Error ? error.message : 'Saved submissions are unavailable.',
      );
      return;
    }
    if (!held || submissionHashes(held.swap).join(',') !== openHash) {
      // Another tab may have added a candidate or settled this intent.
      setTracked(
        held ? describeOpen(held.swap, 'waiting', latest.current.now(), held.saved) : null,
      );
      return;
    }
    const { swap, saved } = held;
    const seen = new Set<Hex>(swap.nonceSeen ?? []);
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const forget = async () =>
      withSubmissionLock(key, () => {
        if (!live || activeKey.current !== contextKey) return false;
        const inMemory = memory.current.get(key);
        if (
          inMemory &&
          (identityOf(inMemory.swap) !== identityOf(swap) || !sameIntent(inMemory.swap, swap))
        )
          return false;
        if (!removeStored(key, swap)) return false;
        if (swap.intent) settled.current.set(key, swap.intent.id);
        memory.current.delete(key);
        return true;
      }).catch(() => false);
    const tick = async () => {
      const poll = await pollPendingSwap(rpc, swap, latest.current.now(), context);
      if (!live || (swap.intent && settled.current.get(key) === swap.intent.id)) return;
      if (poll.kind === 'receipt') {
        const { status, blockNumber, gasUsed } = poll.receipt;
        const ok = status === 'success';
        const forgotten = await forget();
        if (!live) return;
        if (!forgotten) {
          setStorageProblem(
            'The finalized receipt was found, but the saved submission hold could not be cleared. Keep storage available; verification will retry.',
          );
          timer = setTimeout(() => void tick(), intervalMs);
          return;
        }
        setStorageProblem(null);
        setTracked({
          ...swap,
          hash: poll.hash,
          receiptBlock: blockNumber,
          state: ok ? 'mined' : 'failed',
          detail: ok
            ? `Mined in block ${blockNumber}; verified canonical and finalized.`
            : `Reverted in block ${blockNumber} (gas ${gasUsed}); verified canonical and finalized.`,
        });
        if (ok) latest.current.onMined();
        const why = latest.current.explain;
        if (!ok && swap.retry && why) {
          const cause = await why(swap, poll.receipt).catch((): RevertCause => 'unknown');
          // Not gated on `live`: this effect ends as soon as the swap is no longer open.
          setTracked((t) =>
            activeKey.current === contextKey &&
            t &&
            t.intent?.id === swap.intent?.id &&
            t.hash === poll.hash &&
            t.state === 'failed'
              ? { ...t, cause }
              : t,
          );
        }
        return;
      }
      const warning = await otherNonceWarning(rpc, swap);
      if (!live) return;
      // Remember each candidate the RPC shows at the saved nonce (see PendingSwap.nonceSeen).
      if (swap.intent)
        for (const hash of submissionHashes(swap)) {
          if (seen.has(hash)) continue;
          const nonce = savedCallNonce(
            await rpc('eth_getTransactionByHash', [hash]).catch(() => null),
            swap.intent,
          );
          if (!live) return;
          if (nonce === null || nonce !== BigInt(swap.intent.nonce)) continue;
          const recorded = await withSubmissionLock(key, () => {
            const current = recall(key);
            if (!current || !sameIntent(current.swap, swap)) return false;
            if (!submissionHashes(current.swap).includes(hash)) return false;
            const next: PendingSwap = {
              ...current.swap,
              nonceSeen: [...new Set([...(current.swap.nonceSeen ?? []), hash])],
            };
            const durable = readStored(key);
            const savedNow =
              !!durable && sameIntent(durable, next) && writeStored(key, next) && current.saved;
            memory.current.set(key, { swap: next, saved: savedNow });
            return true;
          }).catch(() => false);
          if (recorded) seen.add(hash);
          if (!live) return;
        }
      const open = describeOpen(swap, poll.kind, latest.current.now(), saved);
      setTracked({ ...open, detail: `${open.detail}${warning}` });
      timer = setTimeout(() => void tick(), intervalMs);
    };
    void tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, key, openHash, rpc, intervalMs, recall, checkContext, context, contextKey]);

  // A swap hold also ends, with no wallet request, once its deadline has passed at a canonical
  // finalized block: no copy of it can execute after that (review R309-A1).
  const expiring =
    isOpen(visibleTracked) &&
    !!visibleTracked!.intent &&
    holdsUntilDeadline(visibleTracked!.intent.kind) &&
    visibleTracked!.deadline > 0n
      ? visibleTracked!.intent.id
      : null;
  useEffect(() => {
    if (!enabled || !key || !expiring || !context) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!live) return;
      try {
        const held = recall(key);
        if (!held?.swap.intent || held.swap.intent.id !== expiring) return;
        checkContext(held.swap);
        const { swap } = held;
        // Decided by a finalized block's timestamp only, never by this device's clock.
        const expired = await expiredSwap(
          rpc,
          swap.intent!,
          context,
          swap.deadline,
          submissionHashes(swap),
        );
        if (!live) return;
        if (expired) {
          const cleared = await withSubmissionLock(key, () => {
            if (!live || activeKey.current !== contextKey) return false;
            const current = recall(key);
            if (!current || !sameIntent(current.swap, swap)) return false;
            // A hash that arrived meanwhile is checked on the next pass.
            if (submissionHashes(current.swap).join(',') !== submissionHashes(swap).join(','))
              return false;
            if (!removeStored(key, swap)) return false;
            settled.current.set(key, swap.intent!.id);
            memory.current.delete(key);
            return true;
          }).catch(() => false);
          if (!live) return;
          if (cleared) {
            setStorageProblem(null);
            setTracked({
              ...swap,
              state: 'expired',
              detail: requestWords(
                swap.intent!.kind,
                expired.nonceUsed
                  ? `The swap deadline passed in canonical finalized block ${expired.blockNumber}, so this request can no longer execute. A transaction of this account used nonce ${swap.intent!.nonce} before that: it may have been this swap. Check your wallet activity and the finalized balances below before swapping again. Nothing was sent.`
                  : `The swap deadline passed in canonical finalized block ${expired.blockNumber}, and no transaction of this account used nonce ${swap.intent!.nonce} before it: sent from an ordinary wallet account this swap did not execute, and it can no longer execute. If your wallet still shows the request, reject it there; signed now it would only revert. Nothing was sent.`,
              ),
            });
            latest.current.onMined();
            return;
          }
        }
      } catch {
        /* Unverifiable evidence never ends a hold; try again. */
      }
      if (live) timer = setTimeout(() => void tick(), intervalMs);
    };
    void tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, key, expiring, rpc, intervalMs, recall, checkContext, context, contextKey]);

  /** Persist before invoking eth_sendTransaction. A storage failure prevents sending. */
  const reserve = useCallback(
    async (
      swap: Omit<PendingSwap, 'hash' | 'intent'>,
      kind: SubmissionIntent['kind'],
      tx: TransactionRequest,
    ) => {
      if (!key || !account || !context)
        throw new Error('Connect the wallet and verify the deployment before submitting.');
      return withSubmissionLock(key, async () => {
        if (activeKey.current !== contextKey)
          throw new Error('The selected context changed before submission. Nothing was sent.');
        if (recall(key)) throw new Error('Another submission is unresolved. Do not resend.');
        const boundary = await submissionBoundary(rpc, context, account);
        if (activeKey.current !== contextKey)
          throw new Error('The selected context changed before submission. Nothing was sent.');
        const intent: SubmissionIntent = {
          ...context,
          ...boundary,
          id: crypto.randomUUID(),
          kind,
          chainId,
          from: tx.from.toLowerCase() as Address,
          to: tx.to.toLowerCase() as Address,
          data: tx.data.toLowerCase() as Hex,
          value: tx.value.toString(),
          gas: tx.gas.toString(),
        };
        if (intent.from !== account.toLowerCase() || tx.chainId !== chainId || !parseIntent(intent))
          throw new Error('The transaction does not match the connected account and chain.');
        const held: PendingSwap = {
          ...swap,
          intent,
          walletAttempt: {
            id: crypto.randomUUID(),
            mode: 'initial',
            state: 'awaiting-wallet',
            startedAtMs: latest.current.now(),
          },
        };
        if (!writeStored(key, held))
          throw new Error(
            'This browser could not save the submission intent. Nothing was sent. Enable storage before trying again.',
          );
        memory.current.set(key, { swap: held, saved: true });
        setTracked(describeOpen(held, 'waiting', swap.sentAtMs, true));
        return { id: intent.id, nonce: BigInt(intent.nonce) };
      });
    },
    [key, account, chainId, recall, context, contextKey, rpc],
  );

  const updateSubmission = useCallback(
    async (
      id: string,
      hash?: Hex,
      note?: string,
      attempt?: { id: string; state: NonNullable<PendingSwap['walletAttempt']>['state'] },
    ) => {
      if (!key) return false;
      return withSubmissionLock(key, () => {
        if (settled.current.get(key) === id) return true;
        let held;
        try {
          held = recall(key);
        } catch {
          held = memory.current.get(key);
        }
        if (!held || held.swap.intent?.id !== id) {
          if (activeKey.current === contextKey)
            setStorageProblem(
              'The submission hold could not be updated. Check wallet activity and reload when storage is available. Do not resend.',
            );
          return false;
        }
        // A delayed wallet/recovery response must not overwrite a newer hold
        // created by another tab after settling this one.
        const candidateHashes = [
          ...new Set([...submissionHashes(held.swap), ...(hash ? [hash] : [])]),
        ];
        if (
          candidateHashes.length > MAX_CANDIDATES ||
          candidateHashes.some((h) => !isSubmissionHash(h))
        )
          return false;
        const walletAttempt = held.swap.walletAttempt;
        const swap: PendingSwap = {
          ...held.swap,
          candidateHashes,
          ...(hash ? { hash } : {}),
          ...(note ? { note } : {}),
          ...(walletAttempt && (!attempt || walletAttempt.id === attempt.id)
            ? {
                walletAttempt: {
                  ...walletAttempt,
                  state: attempt?.state ?? (hash ? 'returned' : 'unknown'),
                },
              }
            : {}),
        };
        let saved = false;
        try {
          const durable = readStored(key);
          if (durable?.intent?.id === id && sameIntent(durable, swap))
            saved = writeStored(key, swap);
          else if (activeKey.current === contextKey)
            setStorageProblem(
              'The saved submission hold changed. Reload to track the retained record. Do not resend.',
            );
        } catch {
          /* Preserve the already-durable intent and the hash in memory. */
        }
        memory.current.set(key, { swap, saved });
        if (activeKey.current === contextKey)
          setTracked(describeOpen(swap, 'waiting', latest.current.now(), saved));
        return saved;
      }).catch(() => {
        if (activeKey.current === contextKey)
          setStorageProblem(
            'The submission hold could not be updated. Restore browser storage and coordination before checking its outcome. Do not resend.',
          );
        return false;
      });
    },
    [key, contextKey, recall],
  );

  const rejected = useCallback(
    async (id: string) => {
      if (!key) return;
      await withSubmissionLock(key, () => {
        const held = recall(key);
        if (
          !held ||
          held.swap.intent?.id !== id ||
          submissionHashes(held.swap).length ||
          held.swap.walletAttempt?.mode === 'review' ||
          !removeStored(key, held.swap)
        )
          return;
        memory.current.delete(key);
        if (activeKey.current === contextKey) setTracked(null);
      }).catch(() => {
        if (activeKey.current === contextKey)
          setStorageProblem(
            'The rejected request could not be removed from storage. Restore browser coordination and reload; the hold remains.',
          );
      });
    },
    [key, contextKey, recall],
  );

  const assertActive = useCallback(() => {
    if (
      !mounted.current ||
      !enabled ||
      !active.current.enabled ||
      active.current.rpc !== rpc ||
      activeKey.current !== contextKey ||
      activeProvider.current !== provider
    )
      throw new Error(
        'The wallet or verified page context changed. No further wallet request was made; any existing hold remains.',
      );
  }, [enabled, rpc, contextKey, provider]);

  /** A second click, including one in another tab, is never queued for later. */
  const withWalletRequest = useCallback(
    async <T>(action: () => Promise<T>): Promise<T> => {
      if (!key) throw new Error('Connect the original wallet account first.');
      assertActive();
      return withWalletRequestLock(key, async () => {
        assertActive();
        setBusyContext(contextKey);
        try {
          return await action();
        } finally {
          setBusyContext((current) => (current === contextKey ? null : current));
        }
      });
    },
    [key, contextKey, assertActive],
  );

  /** The L2 new-slot fee of one call of this deployment, or null when the wallet picks the fee. */
  const price = useCallback(
    (tx: PricedCall) =>
      priceNewSlots(rpc, tx, newSlotFee, deployment ? transientSlots(deployment) : undefined),
    [rpc, newSlotFee, deployment],
  );

  const reviewInWallet = useCallback(
    async () =>
      withWalletRequest(async () => {
        if (!key || !context || !deployment || !provider)
          throw new Error('Connect the original wallet and verified deployment first.');
        const held = recall(key);
        if (!held?.swap.intent)
          throw new Error('This hold has no saved nonce and transaction body to review.');
        checkContext(held.swap);
        const { intent } = held.swap;
        // Nothing the page can read shows whether an earlier request is still open, or signed, in the wallet,
        // and the nonce it asks for is only a request. A duplicate approval or skim is harmless; a duplicate
        // swap spends twice. So a swap is never requested again (review R309-A1).
        if (holdsUntilDeadline(intent.kind))
          throw new Error(requestWords(intent.kind, REVIEW_NOT_FOR_SWAPS));
        const tx = transactionForSameNonceReview(intent, held.swap.deadline, deployment);
        // A wallet that returned a hash holds that transaction and may publish it later, whatever the sequencer
        // shows now. Many wallets ignore the nonce a site asks for and would sign this review at their next nonce:
        // the same call twice. With a hash known, the only safe controls are the wallet's own speed up and cancel.
        if (submissionHashes(held.swap).length) throw new Error(REVIEW_WITH_HASH);
        // Priced first (several RPC reads), so that the canonical and pending nonce checks are the
        // last reads before the wallet. A pricing failure changes nothing.
        const fee = await price(tx);
        await verifySameNonceReview(rpc, intent, context, held.swap.deadline);
        const walletChain = await provider.request({ method: 'eth_chainId' });
        if (
          typeof walletChain !== 'string' ||
          !/^0x[0-9a-f]+$/i.test(walletChain) ||
          BigInt(walletChain) !== BigInt(intent.chainId)
        )
          throw new Error(
            'Select the original chain in your wallet before reviewing this request. Its hold remains.',
          );
        assertActive();
        const attempt = {
          id: crypto.randomUUID(),
          mode: 'review' as const,
          state: 'awaiting-wallet' as const,
          startedAtMs: latest.current.now(),
        };
        await withSubmissionLock(key, () => {
          assertActive();
          const durable = readStored(key);
          const current = recall(key);
          if (
            !durable ||
            !current ||
            !sameIntent(durable, held.swap) ||
            !sameIntent(current.swap, held.swap)
          )
            throw new Error(
              'The saved submission changed while reviewing. Reload to inspect its outcome.',
            );
          const swap = { ...current.swap, walletAttempt: attempt };
          if (!writeStored(key, swap))
            throw new Error(
              'The review attempt could not be saved. No wallet request was made; the original hold remains.',
            );
          memory.current.set(key, { swap, saved: true });
          setTracked(describeOpen(swap, 'waiting', latest.current.now(), true));
        });
        let hash: Hex | undefined;
        try {
          assertActive();
          const durable = readStored(key);
          if (
            !durable ||
            !sameIntent(durable, held.swap) ||
            durable.walletAttempt?.id !== attempt.id
          )
            throw new Error(
              'The saved review changed before the wallet request. Nothing further was sent.',
            );
          // No await between the last context/journal checks and the wallet call.
          hash = await sendTransaction(
            provider,
            fee
              ? {
                  ...tx,
                  maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
                  maxFeePerGas: fee.maxFeePerGas,
                }
              : tx,
          );
          if (
            !(await updateSubmission(intent.id, hash, undefined, {
              id: attempt.id,
              state: 'returned',
            }))
          )
            throw new Error(
              `The wallet returned ${hash}, but its hash update could not be saved. Keep this hash; the original hold remains.`,
            );
        } catch (error) {
          const cancelled = !hash && (error as { code?: unknown })?.code === 4001;
          await updateSubmission(
            intent.id,
            hash,
            cancelled
              ? 'The additional wallet review was cancelled; the original outcome is still unresolved.'
              : submissionFeeNote(error),
            { id: attempt.id, state: cancelled ? 'rejected' : 'unknown' },
          );
          if (cancelled)
            throw new Error(
              'The additional wallet review was cancelled. The original request may still execute, so its hold remains.',
            );
          throw error;
        }
        // The wallet was asked for the original nonce. If the RPC already shows what it signed and the nonce is
        // another one, the user holds two separate transactions with this call and must cancel one in the wallet.
        const signedNonce = savedCallNonce(
          await rpc('eth_getTransactionByHash', [hash]).catch(() => null),
          intent,
        );
        if (signedNonce !== null && signedNonce !== BigInt(intent.nonce))
          throw new Error(
            `Your wallet signed nonce ${signedNonce} instead of the reviewed nonce ${intent.nonce} (${hash}). That is a second, separate transaction, not a replacement: cancel it in your wallet now, or the same call can execute twice. The hold remains.`,
          );
        return hash;
      }),
    [
      withWalletRequest,
      key,
      context,
      deployment,
      provider,
      recall,
      checkContext,
      rpc,
      assertActive,
      updateSubmission,
      price,
    ],
  );

  const review = useMemo(() => {
    if (!visibleTracked?.intent || !deployment || !isOpen(visibleTracked)) return undefined;
    // Not offered once the wallet returned a hash, and never for a swap: see reviewInWallet.
    if (submissionHashes(visibleTracked).length || holdsUntilDeadline(visibleTracked.intent.kind))
      return undefined;
    try {
      return {
        details: sameNonceReviewDetails(visibleTracked.intent, visibleTracked.deadline, deployment),
      };
    } catch {
      return {
        problem:
          'The saved call cannot be rebuilt as an allowed transaction of this deployment. Use hash recovery; no wallet request is available.',
      };
    }
  }, [visibleTracked, deployment]);

  const recover = useCallback(
    async (value: string) => {
      if (!key || !context) throw new Error('The original verified context must be available.');
      const hash = value.trim().toLowerCase();
      if (!isSubmissionHash(hash))
        throw new Error('Enter a nonzero 32-byte transaction hash from your wallet activity.');
      const held = recall(key);
      if (!held?.swap.intent)
        throw new Error('No saved transaction intent is available to verify this hash.');
      checkContext(held.swap);
      await verifySubmissionHash(rpc, hash, held.swap.intent, context);
      if (activeKey.current !== contextKey)
        throw new Error('The selected context changed. The submission hold remains.');
      if (!(await updateSubmission(held.swap.intent.id, hash)))
        throw new Error(
          'The hash could not be saved. The original submission hold remains; keep the wallet hash and restore storage before checking again.',
        );
    },
    [key, context, contextKey, recall, checkContext, rpc, updateSubmission],
  );

  const checkReplacement = useCallback(
    async (value: string) => {
      assertActive();
      if (!key || !context)
        throw new Error('Restore the original verified account and deployment.');
      const hash = value.trim().toLowerCase();
      if (!isSubmissionHash(hash))
        throw new Error('Enter the replacement transaction hash from wallet activity.');
      const held = recall(key);
      if (!held?.swap.intent)
        throw new Error(
          'This older hold has no saved nonce and body for replacement verification.',
        );
      checkContext(held.swap);
      // A swap hold without any wallet hash ends ONLY at its deadline in a finalized block, or when the chain
      // shows the saved call itself (hash recovery). Another transaction at the nonce proves nothing: the first
      // prompt may still be open, and a wallet that assigns its own nonce would sign it at the next one inside
      // the deadline, after a second swap was sent (review R309-2P-1, coordinator decision).
      if (holdsUntilDeadline(held.swap.intent.kind) && submissionHashes(held.swap).length === 0)
        throw new Error(requestWords(held.swap.intent.kind, REPLACEMENT_NOT_FOR_UNSEEN_SWAPS));
      // A wallet that ignored the requested nonce signed the saved call at another one. A different transaction at
      // the original nonce then proves nothing about the request: it can still execute, or already has.
      for (const candidate of submissionHashes(held.swap)) {
        if (candidate === hash) continue;
        const body = await rpc('eth_getTransactionByHash', [candidate]);
        const signedNonce = savedCallNonce(body, held.swap.intent);
        // A candidate the RPC cannot show, and never showed this page at the saved nonce, proves nothing:
        // the wallet may hold it, signed at its own next nonce, and publish it later. For a swap that would
        // be a second execution, so the hold closes as replaced only once the deadline has passed in a
        // finalized block (review R309-A2). A candidate the page did read at the saved nonce (cancelled or
        // dropped since) is dead with that nonce. A second approval or skim is harmless: earlier rule.
        if (
          body === null &&
          holdsUntilDeadline(held.swap.intent.kind) &&
          !(held.swap.nonceSeen ?? []).includes(candidate) &&
          !(await expiredSwap(rpc, held.swap.intent, context, held.swap.deadline, []))
        )
          throw new Error(
            requestWords(
              held.swap.intent.kind,
              `The RPC cannot show the transaction ${candidate} your wallet returned for this swap, so the nonce it was signed with is unknown: it may still be published and execute. This hold cannot be closed as replaced before the swap deadline has passed in a finalized block; it then ends by itself.`,
            ),
          );
        if (signedNonce !== null && signedNonce !== BigInt(held.swap.intent.nonce))
          throw new Error(
            `Your wallet signed this request at nonce ${signedNonce}, not nonce ${held.swap.intent.nonce} (${candidate}). It can still execute or already has, so this hold cannot be closed as replaced; it settles when that transaction is finalized.`,
          );
      }
      const proof = await finalizedReplacementReceipt(rpc, hash, held.swap.intent, context);
      assertActive();
      if (!proof)
        throw new Error(
          'No canonical finalized replacement is available for that hash yet. The original hold remains.',
        );
      return proof;
    },
    [assertActive, key, context, recall, checkContext, rpc],
  );

  /** Explicit local acknowledgement only. Recheck the displayed proof before
   * clearing the hold; never call a wallet or begin another transaction. */
  const closeReplacement = useCallback(
    async (proof: ReplacementProof) => {
      assertActive();
      if (!key || !context)
        throw new Error('Restore the original verified account and deployment.');
      const held = recall(key);
      if (!held?.swap.intent || held.swap.intent.id !== proof.intentId)
        throw new Error('The saved submission changed. Its current hold remains.');
      checkContext(held.swap);
      const verified = await checkReplacement(proof.transactionHash);
      if (stableJson(verified) !== stableJson(proof))
        throw new Error(
          'The replacement evidence changed. Check the hash again before closing the hold.',
        );
      await withSubmissionLock(key, () => {
        assertActive();
        const current = recall(key);
        if (!current || !sameIntent(current.swap, held.swap) || !removeStored(key, held.swap))
          throw new Error(
            'The verified replacement could not clear this saved hold. Restore storage and check again.',
          );
        settled.current.set(key, proof.intentId);
        memory.current.delete(key);
        setStorageProblem(null);
        setTracked({
          ...held.swap,
          label: `Original ${held.swap.intent!.kind} request`,
          hash: proof.transactionHash,
          state: 'replaced',
          detail: `A different transaction consumed nonce ${proof.nonce} in canonical finalized block ${proof.blockNumber}. The original request did not execute. Its local hold was explicitly closed; nothing new was sent.`,
        });
        // Refresh finalized balances after the different transaction, without
        // treating it as a successful execution of the original call.
        latest.current.onMined();
      });
    },
    [assertActive, key, context, recall, checkContext, checkReplacement],
  );

  /** Last synchronous check before entering eth_sendTransaction, with no intervening await. */
  const ready = useCallback(
    (id: string) => {
      if (
        !enabled ||
        !key ||
        !mounted.current ||
        !active.current.enabled ||
        active.current.rpc !== rpc ||
        activeKey.current !== contextKey ||
        activeProvider.current !== provider
      )
        return false;
      try {
        const held = recall(key);
        const durable = readStored(key);
        if (
          !held ||
          held.swap.intent?.id !== id ||
          held.swap.hash ||
          durable?.intent?.id !== id ||
          durable.hash
        )
          return false;
        checkContext(held.swap);
        return true;
      } catch {
        return false;
      }
    },
    [enabled, key, contextKey, recall, checkContext, rpc, provider],
  );

  /** True when a swap is open, including one sent from another tab since this one loaded. */
  const holds = useCallback(() => {
    if (!key) return false;
    let held;
    try {
      held = recall(key);
      if (held) checkContext(held.swap);
    } catch (error) {
      setStorageProblem(
        error instanceof Error ? error.message : 'Saved submissions are unavailable.',
      );
      return true;
    }
    if (!held) return false;
    setTracked((t) =>
      t && identityOf(t) === identityOf(held.swap) && isOpen(t)
        ? t
        : describeOpen(held.swap, 'waiting', latest.current.now(), held.saved),
    );
    return true;
  }, [key, recall, checkContext]);

  /** The stored record of this account is unreadable: no hold can be shown, nothing can be sent, and nothing
   * on the chain can end it. The user may discard it, knowingly. Only an unreadable record is ever removed. */
  const unreadable = storageProblem === UNREADABLE_RECORD;
  const discardUnreadable = useCallback(async () => {
    if (!key) return false;
    return withSubmissionLock(key, () => {
      const raw = localStorage.getItem(key);
      if (raw === null || parsePendingSwap(raw)) return false;
      localStorage.removeItem(key);
      if (localStorage.getItem(key) !== null) return false;
      memory.current.delete(key);
      setStorageProblem(null);
      setTracked(null);
      return true;
    }).catch(() => false);
  }, [key]);

  return {
    tracked: visibleTracked,
    contextKey,
    storageProblem,
    unreadable,
    discardUnreadable,
    open: isOpen(visibleTracked) || storageProblem !== null,
    reserve,
    updateSubmission,
    rejected,
    holds,
    recover,
    ready,
    withWalletRequest,
    walletBusy,
    review,
    reviewInWallet,
    price,
    checkReplacement,
    closeReplacement,
  };
}
