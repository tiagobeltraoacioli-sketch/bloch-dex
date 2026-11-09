// Shared by the keeper and its monitor. Time alone never resolves a signed
// transaction; confirmed spend belongs to the canonical inclusion timestamp.
// "superseded": the nonce was used by a finalized transaction this keeper did not record; charged at that
// transaction's real cost.
const SETTLED = new Set(["effective", "wasted", "reverted", "superseded"]);
const HASH = /^0x[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
export const KEEPER_PENDING_TIMEOUT_SECONDS = 7200;

export function keeperNeedsReconciliation(tx) {
  if (tx.status === "refused" && tx.refusalKind === "sequencer-fee-underpriced") return false;
  return !(SETTLED.has(tx.status) && Number.isSafeInteger(tx.includedAt) && tx.includedAt >= 0 &&
    typeof tx.includedBlockNumber === "string" && DECIMAL.test(tx.includedBlockNumber) &&
    typeof tx.includedBlockHash === "string" && HASH.test(tx.includedBlockHash) && !/^0x0+$/.test(tx.includedBlockHash));
}

// A settled entry leaves the window 24 h after the LATER of its local signing time and its
// block's timestamp: a node that reports an old block timestamp cannot empty the window.
const windowTime = (tx) => (tx.status === "refused" ? tx.at : Math.max(Number.isSafeInteger(tx.at) ? tx.at : 0, tx.includedAt));
export const keeperWindow = (state, now) => state.txs.filter((tx) =>
  keeperNeedsReconciliation(tx) || Number(now) - windowTime(tx) < 86400);

export const keeperCharge = (tx) => BigInt(keeperNeedsReconciliation(tx)
  ? tx.reservedWei ?? tx.spentWei ?? 0
  : tx.spentWei ?? tx.reservedWei ?? 0);

export const keeperWindowSpend = (state, now) => keeperWindow(state, now).reduce((sum, tx) => sum + keeperCharge(tx), 0n);
