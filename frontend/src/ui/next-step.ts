/**
 * The line under the swap actions that says what happens next. Presentation
 * only: it reads the same facts that enable or disable the buttons and decides
 * nothing. The order follows the Swap button's own conditions.
 */
export type NextStepFacts = {
  connected: boolean;
  walletPending: boolean;
  onChain: boolean;
  chainId: number;
  /** A stored hold problem or an unreadable saved record blocks every send. */
  storageBlocked: boolean;
  /** A wallet request of this page is in progress. */
  busy: boolean;
  /** A transaction of this account is still tracked (the submission hold). */
  holdOpen: boolean;
  hasQuote: boolean;
  staleForm: boolean;
  shortBalance: boolean;
  quoteBlocked: boolean;
  /** Text of the approval button when an approval comes first. */
  approval: string | null;
  acknowledgementMissing: boolean;
};

export type NextStep = { tone: 'idle' | 'action' | 'wait' | 'blocked'; text: string };

export function nextStep(f: NextStepFacts): NextStep {
  if (f.storageBlocked)
    return { tone: 'blocked', text: 'Sending is closed until the saved record below is resolved.' };
  if (!f.connected)
    return f.walletPending
      ? { tone: 'wait', text: 'Next: allow the connection in your wallet.' }
      : { tone: 'idle', text: 'Next: connect a wallet. A quote needs none.' };
  if (f.busy)
    return {
      tone: 'wait',
      text: 'In progress: the request is being prepared and shown in your wallet.',
    };
  if (f.holdOpen)
    return {
      tone: 'wait',
      text: 'Sending is paused while the transaction below is tracked. It reopens when that one is settled.',
    };
  if (!f.hasQuote) return { tone: 'idle', text: 'Next: enter an amount and get a quote.' };
  if (f.staleForm)
    return { tone: 'blocked', text: 'The form changed after this quote. Next: get a new quote.' };
  if (f.shortBalance)
    return { tone: 'blocked', text: 'Next: lower the amount to what the wallet holds.' };
  if (f.quoteBlocked)
    return { tone: 'blocked', text: 'Next: settle the price notice above, then swap.' };
  const switchFirst = f.onChain
    ? ''
    : ` Your wallet is first asked to switch to chain ${f.chainId}.`;
  if (f.approval)
    return {
      tone: 'action',
      text: `Step 1 of 2: ${f.approval} in your wallet. Step 2: Swap.${switchFirst}`,
    };
  if (f.acknowledgementMissing)
    return { tone: 'blocked', text: 'Next: tick the acknowledgement above to open Swap.' };
  return { tone: 'action', text: `Next: Swap opens your wallet with this quote.${switchFirst}` };
}
