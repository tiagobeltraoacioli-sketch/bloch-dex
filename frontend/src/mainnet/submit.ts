// One tracked wallet request, outside the swap card (round 20, agent 411).
//
// This is the sequence of `run` in MainnetLive.tsx's SwapPanel and of the skim in PendingExcess, step for step,
// as a function, so that a caller outside the swap card (the liquidity dialog) uses the SAME tracker and the same
// order of checks instead of a variation of them:
//
//   1. nothing while another request of this account is unresolved (`pendingSwap.holds()`);
//   2. inside the tracker's wallet-request lock: the wallet is asked to be on the route's chain; the route's
//      settled block must be readable (`requireFinality`); the caller's `unchanged()` must still hold;
//   3. the call is built and priced (the Bloch L2's new-slot fee; nothing on a public chain) BEFORE anything is
//      saved, so a failure here leaves nothing behind;
//   4. the intent is saved durably with its nonce (`reserve`); a storage failure prevents the send;
//   5. last awaited read: the wallet's chain again (review R309-A4); then, synchronously, the caller's
//      `unchanged()`, the wallet object and account, and the tracker's `ready`;
//   6. eth_sendTransaction with the saved nonce; the hash is recorded. A missing hash after the save is an
//      UNKNOWN outcome and keeps the hold, unless the wallet answered 4001 (the user rejected it).
//
// The swap card's own `run` is not rewired to this function in this change: it is the reviewed path and stays
// byte for byte where it is. A later change may point it here, with a reviewer.
import type { Hex } from 'viem';
import type { Rpc } from '../devnet4/chain';
import { ensureChain, sendTransaction, type TransactionRequest } from '../devnet4/swap';
import type { Provider } from '../wallet';
import { addChainParameters, type MainnetNetwork } from './config';
import { newSlotFeeNote } from './newslotfee';
import { walletOnChain, type usePendingSwap } from './pendingswap';
import { submissionFeeNote } from './submission-fees';
import { requireFinality, type SubmissionIntent } from './submission-outcome';
import { worded, wording } from './wording';

export type TrackedRequest = {
  label: string;
  kind: SubmissionIntent['kind'];
  /** Unix seconds; 0 for a request without a deadline (an approval). */
  deadline: bigint;
  build: () => TransactionRequest;
};

export type SubmitResult =
  /** The wallet returned a hash, or the outcome is unknown: the tracker holds the account and shows the state. */
  | { state: 'tracked'; hash?: Hex }
  /** The user rejected the request in the wallet. Nothing was sent. */
  | { state: 'rejected'; note: string }
  /** Refused before any wallet request. Nothing was sent. */
  | { state: 'not-sent'; note: string };

const text = (error: unknown, fallback: string) =>
  worded(error instanceof Error ? error.message : fallback);

export async function submitTracked({
  provider,
  account,
  network,
  rpc,
  pendingSwap,
  request,
  now,
  unchanged,
  currentWallet,
  onStatus,
}: {
  provider: Provider;
  /** The connected account the request is built for, as the wallet reported it. */
  account: string;
  network: MainnetNetwork;
  rpc: Rpc;
  pendingSwap: ReturnType<typeof usePendingSwap>;
  request: TrackedRequest;
  now: () => number;
  /** True while the form and the page context are the ones the user confirmed (checked before and after reads). */
  unchanged: () => boolean;
  /** The wallet as the page holds it NOW (a ref's value), compared with the one the request started with. */
  currentWallet: () => { provider: Provider | null; account: string | null };
  onStatus?: (note: string) => void;
}): Promise<SubmitResult> {
  if (pendingSwap.holds())
    return {
      state: 'not-sent',
      note: 'Another request of this account is unresolved. Nothing was sent.',
    };
  const changed = 'The form changed, so nothing was sent. Review the amounts again.';
  let hash: Hex | undefined;
  let intentId: string | undefined;
  try {
    return await pendingSwap.withWalletRequest(async (): Promise<SubmitResult> => {
      try {
        await ensureChain(provider, addChainParameters(network));
        await requireFinality(rpc);
        if (!unchanged()) throw new Error(changed);
        const tx = { ...request.build(), chainId: network.chainId };
        // Priced before the intent is saved: a failure here leaves nothing behind.
        const fee = await pendingSwap.price(tx);
        if (!unchanged()) throw new Error(changed);
        onStatus?.(`Confirm in your wallet. ${fee ? newSlotFeeNote(fee) : ''}`.trim());
        const reservation = await pendingSwap.reserve(
          { label: request.label, deadline: request.deadline, sentAtMs: now() },
          request.kind,
          tx,
        );
        intentId = reservation.id;
        // The wallet's chain again, last of the awaited reads (review R309-A4): the user may have switched
        // network meanwhile, and not every wallet enforces a request's chain ID. The checks below are synchronous.
        if (!(await walletOnChain(provider, network.chainId))) {
          await pendingSwap.rejected(intentId);
          intentId = undefined;
          throw new Error(
            `Your wallet is no longer on the ${wording.network} network. Nothing was sent. Select the network in your wallet and try again.`,
          );
        }
        const wallet = currentWallet();
        if (
          !unchanged() ||
          wallet.provider !== provider ||
          wallet.account !== account ||
          !pendingSwap.ready(intentId)
        ) {
          await pendingSwap.rejected(intentId);
          intentId = undefined;
          throw new Error(
            'The form or wallet context changed before the wallet request. Nothing was sent. Review the amounts again.',
          );
        }
        hash = await sendTransaction(provider, {
          ...tx,
          nonce: reservation.nonce,
          ...(fee
            ? { maxPriorityFeePerGas: fee.maxPriorityFeePerGas, maxFeePerGas: fee.maxFeePerGas }
            : {}),
        });
        await pendingSwap.updateSubmission(intentId, hash);
        return { state: 'tracked', hash };
      } catch (error) {
        if (intentId && !hash && (error as { code?: unknown })?.code === 4001) {
          await pendingSwap.rejected(intentId);
          return {
            state: 'rejected',
            note: 'The wallet request was rejected by you. Nothing was sent.',
          };
        }
        if (intentId) {
          await pendingSwap.updateSubmission(intentId, hash, submissionFeeNote(error));
          return { state: 'tracked', hash };
        }
        return { state: 'not-sent', note: text(error, 'No wallet request was sent.') };
      }
    });
  } catch (error) {
    return { state: 'not-sent', note: text(error, 'No wallet request was sent.') };
  }
}
