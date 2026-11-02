// Finished transactions of this page, kept across a reload per chain and account.
// localStorage may be blocked or full: every access is in try/catch, and the list is
// then only in memory. Only outcomes are kept, never anything needed to sign.
import type { Address, Hex } from 'viem';

export type FinishedTx = {
  label: string;
  hash: Hex;
  state: 'mined' | 'failed' | 'unknown' | 'expired';
  detail?: string;
};

export const HISTORY_LIMIT = 10;
const STATES = new Set(['mined', 'failed', 'unknown', 'expired']);

export const historyKey = (chainId: number, account: Address) =>
  `postern.mainnet.history.${chainId}.${account.toLowerCase()}`;

function valid(entry: unknown): entry is FinishedTx {
  const e = entry as FinishedTx;
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof e.label === 'string' &&
    typeof e.hash === 'string' &&
    /^0x[0-9a-fA-F]{64}$/.test(e.hash) &&
    STATES.has(e.state) &&
    (e.detail === undefined || typeof e.detail === 'string')
  );
}

export function loadHistory(chainId: number, account: Address): FinishedTx[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(historyKey(chainId, account)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(valid).slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

/** Newest first, one entry per hash. Returns the new list whether or not it was saved. */
export function recordFinished(
  chainId: number,
  account: Address,
  list: FinishedTx[],
  tx: FinishedTx,
): FinishedTx[] {
  const next = [tx, ...list.filter((t) => t.hash !== tx.hash)].slice(0, HISTORY_LIMIT);
  try {
    localStorage.setItem(historyKey(chainId, account), JSON.stringify(next));
  } catch {
    // Kept in memory for this page only.
  }
  return next;
}
