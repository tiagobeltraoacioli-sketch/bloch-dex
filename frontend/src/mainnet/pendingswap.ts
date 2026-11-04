// One durable wallet-submission hold per chain/account, shared by swaps,
// approvals and skims. The intent exists before the wallet is called; losing
// the reply does not establish that no transaction was sent.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address, Hex } from 'viem';
import type { Rpc } from '../devnet4/chain';
import { RECEIPT_TIMEOUT_MS, parseReceipt, type Receipt, type TransactionRequest } from '../devnet4/swap';
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
export type SubmissionIntent = {
  id: string;
  kind: 'swap' | 'approval' | 'skim';
  chainId: number;
  from: Address;
  to: Address;
  data: Hex;
  value: string;
  gas: string;
};
export type TrackedSwap = PendingSwap & {
  state: 'pending' | 'unknown' | 'mined' | 'failed' | 'expired';
  detail: string;
  /** Set on a failed swap once the page has read why it reverted. */
  cause?: RevertCause;
};
export type SwapPoll =
  | { kind: 'receipt'; receipt: Receipt }
  /** The latest block is past the deadline and there is no receipt. */
  | { kind: 'expired' }
  /** The RPC answered and the swap has no receipt yet. */
  | { kind: 'waiting' }
  /** The RPC did not answer. This says nothing about the swap. */
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
  if (typeof v.id !== 'string' || !/^[0-9a-f-]{36}$/.test(v.id) ||
      !['swap', 'approval', 'skim'].includes(String(v.kind)) || !Number.isSafeInteger(v.chainId) || Number(v.chainId) <= 0 ||
      typeof v.from !== 'string' || !ADDRESS.test(v.from) || typeof v.to !== 'string' || !ADDRESS.test(v.to) ||
      typeof v.data !== 'string' || !/^0x(?:[0-9a-f]{2}){0,65536}$/.test(v.data) ||
      typeof v.value !== 'string' || !UINT.test(v.value) || typeof v.gas !== 'string' || !UINT.test(v.gas)) return undefined;
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

/** Parse a stored record; anything malformed counts as absent. */
export function parsePendingSwap(raw: string | null): PendingSwap | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const intent = parseIntent(v.intent);
    if (
      (v.hash === undefined ? !intent : typeof v.hash !== 'string' || !/^0x[0-9a-f]{64}$/.test(v.hash)) ||
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
  if (raw !== null && !parsed) throw new Error('The saved submission record is unreadable. Check wallet activity before using this page again.');
  return parsed;
}

function writeStored(key: string, swap: PendingSwap): boolean {
  try {
    const retry = swap.retry && {
      ...swap.retry,
      amountIn: swap.retry.amountIn.toString(),
      minimumOut: swap.retry.minimumOut.toString(),
    };
    const encoded = JSON.stringify({ ...swap, deadline: swap.deadline.toString(), ...(retry ? { retry } : {}) });
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
    if (retained && identityOf(retained) !== identityOf(swap)) return false;
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
  nowMs: number,
): Promise<SwapPoll> {
  if (!swap.hash) return { kind: 'waiting' };
  try {
    // The head is read before the receipt, so an empty receipt covers that head.
    let pastDeadline = false;
    if ((!swap.intent || swap.intent.kind === 'swap') && BigInt(Math.floor(nowMs / 1000)) > swap.deadline) {
      const head = (await rpc('eth_getBlockByNumber', ['latest', false])) as {
        timestamp?: string;
      } | null;
      pastDeadline = !!head?.timestamp && BigInt(head.timestamp) > swap.deadline;
    }
    const receipt = parseReceipt(await rpc('eth_getTransactionReceipt', [swap.hash]));
    if (receipt) return { kind: 'receipt', receipt };
    return { kind: pastDeadline ? 'expired' : 'waiting' };
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
  if (!swap.hash) return {
    ...swap,
    state: 'unknown',
    detail: `Wallet submission outcome unknown: no transaction hash was returned. ${DO_NOT_RESEND} Check your wallet activity and explorer; a timeout or fee error does not prove that nothing was sent.${swap.note ? ` ${swap.note}` : ''}`,
  };
  const what =
    poll === 'unreachable'
      ? 'The RPC did not answer the last receipt check, so the swap may still be pending.'
      : late
        ? 'No receipt after an hour, so the outcome is unknown.'
        : 'Waiting for the next L2 block.';
  const lost = saved ? '' : ' The hash update could not be saved; the earlier submission hold remains after reload.';
  return {
    ...swap,
    state: late ? 'unknown' : 'pending',
    detail: `${what} ${DO_NOT_RESEND}${lost}`,
  };
}

export const isOpen = (swap: TrackedSwap | null) =>
  swap?.state === 'pending' || swap?.state === 'unknown';

export function usePendingSwap({
  rpc,
  chainId,
  account,
  enabled,
  now,
  onMined,
  explain,
  intervalMs = POLL_INTERVAL_MS,
}: {
  rpc: Rpc;
  chainId: number;
  account?: Address;
  enabled: boolean;
  now: () => number;
  onMined: () => void;
  /** Reads why a reverted swap failed; only called for a swap that carries retry fields. */
  explain?: (swap: PendingSwap, receipt: Receipt) => Promise<RevertCause>;
  intervalMs?: number;
}) {
  const key = account ? pendingSwapKey(chainId, account) : null;
  const [tracked, setTracked] = useState<TrackedSwap | null>(null);
  const [storageProblem, setStorageProblem] = useState<string | null>(null);
  const activeKey = useRef(key);
  activeKey.current = key;
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

  useEffect(() => {
    try {
      const held = enabled && key ? recall(key) : null;
      setStorageProblem(null);
      setTracked(held ? describeOpen(held.swap, 'waiting', latest.current.now(), held.saved) : null);
    } catch (error) {
      setStorageProblem(error instanceof Error ? error.message : 'Saved submissions are unavailable.');
    }
  }, [enabled, key, recall]);

  const openHash = isOpen(tracked) ? tracked!.hash : null;
  useEffect(() => {
    if (!enabled || !key || !openHash) return;
    const held = recall(key);
    if (!held || held.swap.hash !== openHash) {
      // Another tab saw the outcome and removed the record.
      setTracked(null);
      return;
    }
    const { swap, saved } = held;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const forget = () => {
      if (!removeStored(key, swap)) return false;
      memory.current.delete(key);
      return true;
    };
    const tick = async () => {
      const poll = await pollPendingSwap(rpc, swap, latest.current.now());
      if (!live) return;
      if (poll.kind === 'receipt') {
        const { status, blockNumber, gasUsed } = poll.receipt;
        const ok = status === 'success';
        if (!forget()) {
          setStorageProblem('The receipt was found, but the saved submission hold could not be cleared.');
          return;
        }
        setTracked({
          ...swap,
          state: ok ? 'mined' : 'failed',
          detail: ok
            ? `Mined in block ${blockNumber}. Balances update once that block is finalized.`
            : `Reverted in block ${blockNumber} (gas ${gasUsed}).`,
        });
        if (ok) latest.current.onMined();
        const why = latest.current.explain;
        if (!ok && swap.retry && why) {
          const cause = await why(swap, poll.receipt).catch((): RevertCause => 'unknown');
          // Not gated on `live`: this effect ends as soon as the swap is no longer open.
          setTracked((t) => (t && t.hash === swap.hash && t.state === 'failed' ? { ...t, cause } : t));
        }
        return;
      }
      if (poll.kind === 'expired') {
        if (!forget()) return;
        setTracked({
          ...swap,
          state: 'expired',
          detail:
            'No receipt, and the latest block is past its deadline, so it can only revert now. Check the explorer before you swap again.',
        });
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
  }, [enabled, key, openHash, rpc, intervalMs, recall]);

  /** Persist before invoking eth_sendTransaction. A storage failure prevents sending. */
  const reserve = useCallback(
    (swap: Omit<PendingSwap, 'hash' | 'intent'>, kind: SubmissionIntent['kind'], tx: TransactionRequest) => {
      if (!key || !account) throw new Error('Connect the wallet before submitting.');
      if (recall(key)) throw new Error('Another submission is unresolved. Do not resend.');
      const intent: SubmissionIntent = {
        id: crypto.randomUUID(), kind, chainId, from: tx.from.toLowerCase() as Address,
        to: tx.to.toLowerCase() as Address, data: tx.data.toLowerCase() as Hex,
        value: tx.value.toString(), gas: tx.gas.toString(),
      };
      if (intent.from !== account.toLowerCase() || tx.chainId !== chainId || !parseIntent(intent)) throw new Error('The transaction does not match the connected account and chain.');
      const held = { ...swap, intent };
      if (!writeStored(key, held)) throw new Error('This browser could not save the submission intent. Nothing was sent. Enable storage before trying again.');
      memory.current.set(key, { swap: held, saved: true });
      setTracked(describeOpen(held, 'waiting', swap.sentAtMs, true));
      return intent.id;
    },
    [key, account, chainId, recall],
  );

  const updateSubmission = useCallback((id: string, hash?: Hex, note?: string) => {
    if (!key) return;
    const held = recall(key);
    if (!held || held.swap.intent?.id !== id) throw new Error('The submission hold changed. Do not resend.');
    const swap = { ...held.swap, ...(hash ? { hash } : {}), ...(note ? { note } : {}) };
    const saved = writeStored(key, swap);
    memory.current.set(key, { swap, saved });
    if (activeKey.current === key) setTracked(describeOpen(swap, 'waiting', latest.current.now(), saved));
  }, [key, recall]);

  const rejected = useCallback((id: string) => {
    if (!key) return;
    const held = recall(key);
    if (!held || held.swap.intent?.id !== id || held.swap.hash || !removeStored(key, held.swap)) return;
    memory.current.delete(key);
    if (activeKey.current === key) setTracked(null);
  }, [key, recall]);

  /** True when a swap is open, including one sent from another tab since this one loaded. */
  const holds = useCallback(() => {
    if (!key) return false;
    let held;
    try { held = recall(key); } catch (error) {
      setStorageProblem(error instanceof Error ? error.message : 'Saved submissions are unavailable.');
      return true;
    }
    if (!held) return false;
    setTracked((t) =>
      t && identityOf(t) === identityOf(held.swap) && isOpen(t)
        ? t
        : describeOpen(held.swap, 'waiting', latest.current.now(), held.saved),
    );
    return true;
  }, [key, recall]);

  return { tracked, storageProblem, open: isOpen(tracked) || storageProblem !== null, reserve, updateSubmission, rejected, holds };
}
