// Tracks a sent swap until its outcome is known. A failed receipt poll says
// nothing about the swap, so the Swap button stays disabled through RPC errors,
// a remount of the panel and, through localStorage, a page reload.
//
// A swap with no receipt is released in one case only: the latest block is past
// the swap's deadline and the receipt read after it is still empty. Any later
// inclusion then reverts with BDEX: EXPIRED, so a new swap cannot be a double.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Address, Hex } from 'viem';
import type { Rpc } from '../devnet4/chain';
import { RECEIPT_TIMEOUT_MS, parseReceipt, type Receipt } from '../devnet4/swap';

export type PendingSwap = { hash: Hex; label: string; deadline: bigint; sentAtMs: number };
export type TrackedSwap = PendingSwap & {
  state: 'pending' | 'unknown' | 'mined' | 'failed' | 'expired';
  detail: string;
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

/** Parse a stored record; anything malformed counts as absent. */
export function parsePendingSwap(raw: string | null): PendingSwap | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (
      typeof v.hash !== 'string' ||
      !/^0x[0-9a-f]{64}$/.test(v.hash) ||
      typeof v.label !== 'string' ||
      typeof v.deadline !== 'string' ||
      !/^[0-9]{1,20}$/.test(v.deadline) ||
      typeof v.sentAtMs !== 'number' ||
      !Number.isFinite(v.sentAtMs)
    )
      return null;
    return {
      hash: v.hash as Hex,
      label: v.label,
      deadline: BigInt(v.deadline),
      sentAtMs: v.sentAtMs,
    };
  } catch {
    return null;
  }
}

function readStored(key: string): PendingSwap | null {
  try {
    return parsePendingSwap(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function writeStored(key: string, swap: PendingSwap): boolean {
  try {
    localStorage.setItem(key, JSON.stringify({ ...swap, deadline: swap.deadline.toString() }));
    return true;
  } catch {
    return false;
  }
}

function removeStored(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing was stored, or storage is blocked.
  }
}

/** One check of a sent swap. Never throws. */
export async function pollPendingSwap(
  rpc: Rpc,
  swap: PendingSwap,
  nowMs: number,
): Promise<SwapPoll> {
  try {
    // The head is read before the receipt, so an empty receipt covers that head.
    let pastDeadline = false;
    if (BigInt(Math.floor(nowMs / 1000)) > swap.deadline) {
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
  const what =
    poll === 'unreachable'
      ? 'The RPC did not answer the last receipt check, so the swap may still be pending.'
      : late
        ? 'No receipt after an hour, so the outcome is unknown.'
        : 'Waiting for the next L2 block.';
  const lost = saved ? '' : ' This browser could not save it, so a reload loses this hold.';
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
  intervalMs = POLL_INTERVAL_MS,
}: {
  rpc: Rpc;
  chainId: number;
  account?: Address;
  enabled: boolean;
  now: () => number;
  onMined: () => void;
  intervalMs?: number;
}) {
  const key = account ? pendingSwapKey(chainId, account) : null;
  const [tracked, setTracked] = useState<TrackedSwap | null>(null);
  // Holds what localStorage may refuse, so a blocked browser keeps the hold until reload.
  const memory = useRef(new Map<string, { swap: PendingSwap; saved: boolean }>());
  const latest = useRef({ now, onMined });
  latest.current = { now, onMined };

  const recall = useCallback((k: string) => {
    const held = memory.current.get(k);
    if (held) return held;
    const stored = readStored(k);
    return stored ? { swap: stored, saved: true } : null;
  }, []);

  useEffect(() => {
    const held = enabled && key ? recall(key) : null;
    setTracked(held ? describeOpen(held.swap, 'waiting', latest.current.now(), held.saved) : null);
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
      memory.current.delete(key);
      removeStored(key);
    };
    const tick = async () => {
      const poll = await pollPendingSwap(rpc, swap, latest.current.now());
      if (!live) return;
      if (poll.kind === 'receipt') {
        const { status, blockNumber, gasUsed } = poll.receipt;
        const ok = status === 'success';
        forget();
        setTracked({
          ...swap,
          state: ok ? 'mined' : 'failed',
          detail: ok
            ? `Mined in block ${blockNumber}. Balances update once that block is finalized.`
            : `Reverted in block ${blockNumber} (gas ${gasUsed}).`,
        });
        if (ok) latest.current.onMined();
        return;
      }
      if (poll.kind === 'expired') {
        forget();
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

  /** Start holding a swap the wallet has just sent. */
  const begin = useCallback(
    (swap: PendingSwap) => {
      if (!key) return;
      const saved = writeStored(key, swap);
      memory.current.set(key, { swap, saved });
      setTracked(describeOpen(swap, 'waiting', swap.sentAtMs, saved));
    },
    [key],
  );

  /** True when a swap is open, including one sent from another tab since this one loaded. */
  const holds = useCallback(() => {
    if (!key) return false;
    const held = recall(key);
    if (!held) return false;
    setTracked((t) =>
      t?.hash === held.swap.hash && isOpen(t)
        ? t
        : describeOpen(held.swap, 'waiting', latest.current.now(), held.saved),
    );
    return true;
  }, [key, recall]);

  return { tracked, open: isOpen(tracked), begin, holds };
}
