// One durable wallet-submission hold per chain/account, shared by swaps,
// approvals and skims. The intent exists before the wallet is called; losing
// the reply does not establish that no transaction was sent.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Address, Hex } from 'viem';
import type { Rpc } from '../devnet4/chain';
import { RECEIPT_TIMEOUT_MS, type Receipt, type TransactionRequest } from '../devnet4/swap';
import type { DevnetDeployment } from '../devnet4/record';
import {
  assertSubmissionContext,
  finalizedSubmissionReceipt,
  isSubmissionHash,
  submissionContext,
  verifySubmissionHash,
  type SubmissionContext,
  type SubmissionIntent,
} from './submission-outcome';
import type { RevertCause, SwapRetryInfo } from './retry';

export type PendingSwap = {
  hash?: Hex;
  label: string;
  deadline: bigint;
  sentAtMs: number;
  /** What a revert explanation and the one retry need (DEX-5). Absent in older records. */
  retry?: SwapRetryInfo;
  intent?: SubmissionIntent;
  note?: string;
};
export type TrackedSwap = PendingSwap & {
  state: 'pending' | 'unknown' | 'mined' | 'failed';
  detail: string;
  /** Set on a failed swap once the page has read why it reverted. */
  cause?: RevertCause;
};
export type SwapPoll =
  | { kind: 'receipt'; receipt: Receipt }
  /** The RPC answered and the swap has no receipt yet. */
  | { kind: 'waiting' }
  /** Evidence was unavailable or could not be verified. This says nothing about submission. */
  | { kind: 'unreachable' };

const STORAGE_PREFIX = 'postern.mainnet.pendingSwap.v1';
const POLL_INTERVAL_MS = 10_000;

export const pendingSwapKey = (chainId: number, account: Address) =>
  `${STORAGE_PREFIX}.${chainId}.${account.toLowerCase()}`;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const UINT = /^[0-9]{1,78}$/;

function parseIntent(value: unknown): SubmissionIntent | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  if (
    typeof v.id !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(v.id) ||
    !['swap', 'approval', 'skim'].includes(String(v.kind)) ||
    !Number.isSafeInteger(v.chainId) ||
    Number(v.chainId) <= 0 ||
    !isSubmissionHash(v.genesisHash) ||
    !isSubmissionHash(v.deploymentId) ||
    typeof v.from !== 'string' ||
    !ADDRESS.test(v.from) ||
    typeof v.to !== 'string' ||
    !ADDRESS.test(v.to) ||
    typeof v.data !== 'string' ||
    !/^0x(?:[0-9a-f]{2}){0,65536}$/.test(v.data) ||
    typeof v.value !== 'string' ||
    !UINT.test(v.value) ||
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
    if (
      (v.hash === undefined
        ? !intent
        : typeof v.hash !== 'string' || !/^0x[0-9a-f]{64}$/.test(v.hash)) ||
      (v.intent !== undefined && !intent) ||
      typeof v.label !== 'string' ||
      typeof v.deadline !== 'string' ||
      !/^[0-9]{1,20}$/.test(v.deadline) ||
      typeof v.sentAtMs !== 'number' ||
      !Number.isFinite(v.sentAtMs)
    )
      return null;
    const retry = parseRetry(v.retry);
    return {
      ...(v.hash ? { hash: v.hash as Hex } : {}),
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

function readStored(key: string): PendingSwap | null {
  const raw = localStorage.getItem(key);
  const parsed = parsePendingSwap(raw);
  if (raw !== null && !parsed)
    throw new Error(
      'The saved submission record is unreadable. Check wallet activity before using this page again.',
    );
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
    return localStorage.getItem(key) === encoded;
  } catch {
    return false;
  }
}

const identityOf = (swap: PendingSwap) => swap.intent?.id ?? swap.hash;

function removeStored(key: string, swap: PendingSwap): boolean {
  try {
    const retained = readStored(key);
    if (
      retained &&
      (identityOf(retained) !== identityOf(swap) ||
        (retained.hash !== undefined && retained.hash !== swap.hash))
    )
      return false;
    localStorage.removeItem(key);
    return localStorage.getItem(key) === null;
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
  if (!swap.hash) return { kind: 'waiting' };
  try {
    // A missing receipt after a deadline is not proof of non-execution. Legacy
    // records without a saved call also cannot authenticate a wallet's hash.
    if (!swap.intent) return { kind: 'unreachable' };
    const receipt = await finalizedSubmissionReceipt(rpc, swap.hash, swap.intent, context);
    if (receipt) return { kind: 'receipt', receipt };
    return { kind: 'waiting' };
  } catch {
    return { kind: 'unreachable' };
  }
}

const DO_NOT_RESEND = 'Do not resend; Swap stays disabled until the outcome is known.';

function describeOpen(
  swap: PendingSwap,
  poll: 'waiting' | 'unreachable',
  nowMs: number,
  saved: boolean,
): TrackedSwap {
  const late = nowMs - swap.sentAtMs >= RECEIPT_TIMEOUT_MS;
  if (!swap.hash)
    return {
      ...swap,
      state: 'unknown',
      detail: `Wallet submission outcome unknown: no transaction hash was returned. ${DO_NOT_RESEND} Check your wallet activity and explorer; a timeout or fee error does not prove that nothing was sent.${swap.note ? ` ${swap.note}` : ''}`,
    };
  const what =
    poll === 'unreachable'
      ? 'The RPC did not answer with verifiable transaction and finalized receipt evidence; the outcome is unknown.'
      : late
        ? 'No verified finalized receipt after an hour, so the outcome is unknown.'
        : 'Waiting for the next L2 block and canonical finality.';
  const lost = saved
    ? ''
    : ' The hash update could not be saved; the earlier submission hold remains after reload.';
  return {
    ...swap,
    state: late || poll === 'unreachable' ? 'unknown' : 'pending',
    detail: `${what} ${DO_NOT_RESEND}${lost}`,
  };
}

export const isOpen = (swap: TrackedSwap | null) =>
  swap?.state === 'pending' || swap?.state === 'unknown';

export function usePendingSwap({
  rpc,
  chainId,
  deployment,
  account,
  enabled,
  now,
  onMined,
  explain,
  intervalMs = POLL_INTERVAL_MS,
}: {
  rpc: Rpc;
  chainId: number;
  deployment?: DevnetDeployment;
  account?: Address;
  enabled: boolean;
  now: () => number;
  onMined: () => void;
  /** Reads why a reverted swap failed; only called for a swap that carries retry fields. */
  explain?: (swap: PendingSwap, receipt: Receipt) => Promise<RevertCause>;
  intervalMs?: number;
}) {
  const key = account ? pendingSwapKey(chainId, account) : null;
  const context = useMemo(
    () => (deployment ? submissionContext(deployment) : undefined),
    [deployment],
  );
  const contextKey = `${key}:${context?.genesisHash}:${context?.deploymentId}`;
  const [tracked, setTracked] = useState<TrackedSwap | null>(null);
  const [storageProblem, setStorageProblem] = useState<string | null>(null);
  const activeKey = useRef(contextKey);
  activeKey.current = contextKey;
  // Holds what localStorage may refuse, so a blocked browser keeps the hold until reload.
  const memory = useRef(new Map<string, { swap: PendingSwap; saved: boolean }>());
  const latest = useRef({ now, onMined, explain });
  latest.current = { now, onMined, explain };

  const recall = useCallback((k: string) => {
    const held = memory.current.get(k);
    if (held) return held;
    const stored = readStored(k);
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
    try {
      const held = enabled && key ? recall(key) : null;
      setTracked(
        held
          ? describeOpen(
              held.swap,
              held.swap.intent ? 'waiting' : 'unreachable',
              latest.current.now(),
              held.saved,
            )
          : null,
      );
      if (held) checkContext(held.swap);
      setStorageProblem(null);
    } catch (error) {
      setStorageProblem(
        error instanceof Error ? error.message : 'Saved submissions are unavailable.',
      );
    }
  }, [enabled, key, recall, checkContext]);

  const openHash = isOpen(tracked) ? tracked!.hash : null;
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
    if (!held || held.swap.hash !== openHash) {
      // Another tab saw the outcome and removed the record.
      setTracked(null);
      return;
    }
    const { swap, saved } = held;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const forget = () => {
      const inMemory = memory.current.get(key);
      if (
        inMemory &&
        (identityOf(inMemory.swap) !== identityOf(swap) || inMemory.swap.hash !== swap.hash)
      )
        return false;
      if (!removeStored(key, swap)) return false;
      memory.current.delete(key);
      return true;
    };
    const tick = async () => {
      const poll = await pollPendingSwap(rpc, swap, latest.current.now(), context);
      if (!live) return;
      if (poll.kind === 'receipt') {
        const { status, blockNumber, gasUsed } = poll.receipt;
        const ok = status === 'success';
        if (!forget()) {
          setStorageProblem(
            'The finalized receipt was found, but the saved submission hold could not be cleared. Keep storage available; verification will retry.',
          );
          timer = setTimeout(() => void tick(), intervalMs);
          return;
        }
        setStorageProblem(null);
        setTracked({
          ...swap,
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
            t && t.hash === swap.hash && t.state === 'failed' ? { ...t, cause } : t,
          );
        }
        return;
      }
      setTracked(describeOpen(swap, poll.kind, latest.current.now(), saved));
      timer = setTimeout(() => void tick(), intervalMs);
    };
    void tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, key, openHash, rpc, intervalMs, recall, checkContext, context]);

  /** Persist before invoking eth_sendTransaction. A storage failure prevents sending. */
  const reserve = useCallback(
    (
      swap: Omit<PendingSwap, 'hash' | 'intent'>,
      kind: SubmissionIntent['kind'],
      tx: TransactionRequest,
    ) => {
      if (!key || !account || !context)
        throw new Error('Connect the wallet and verify the deployment before submitting.');
      if (recall(key)) throw new Error('Another submission is unresolved. Do not resend.');
      const intent: SubmissionIntent = {
        ...context,
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
      const held = { ...swap, intent };
      if (!writeStored(key, held))
        throw new Error(
          'This browser could not save the submission intent. Nothing was sent. Enable storage before trying again.',
        );
      memory.current.set(key, { swap: held, saved: true });
      setTracked(describeOpen(held, 'waiting', swap.sentAtMs, true));
      return intent.id;
    },
    [key, account, chainId, recall, context],
  );

  const updateSubmission = useCallback(
    (id: string, hash?: Hex, note?: string) => {
      if (!key) return false;
      let held;
      try {
        held = recall(key);
      } catch {
        /* Keep the existing durable hold. */
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
      const swap = { ...held.swap, ...(hash ? { hash } : {}), ...(note ? { note } : {}) };
      let saved = false;
      try {
        const durable = readStored(key);
        if (durable?.intent?.id === id) saved = writeStored(key, swap);
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
    },
    [key, contextKey, recall],
  );

  const rejected = useCallback(
    (id: string) => {
      if (!key) return;
      const held = recall(key);
      if (!held || held.swap.intent?.id !== id || held.swap.hash || !removeStored(key, held.swap))
        return;
      memory.current.delete(key);
      if (activeKey.current === contextKey) setTracked(null);
    },
    [key, contextKey, recall],
  );

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
      if (!updateSubmission(held.swap.intent.id, hash))
        throw new Error(
          'The hash could not be saved. The original submission hold remains; keep the wallet hash and restore storage before checking again.',
        );
    },
    [key, context, contextKey, recall, checkContext, rpc, updateSubmission],
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

  return {
    tracked,
    storageProblem,
    open: isOpen(tracked) || storageProblem !== null,
    reserve,
    updateSubmission,
    rejected,
    holds,
    recover,
  };
}
