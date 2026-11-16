import { describe, expect, it } from 'vitest';
import { nextStep, type NextStepFacts } from '../ui/next-step';

const ready: NextStepFacts = {
  connected: true,
  walletPending: false,
  onChain: true,
  chainId: 700770,
  storageBlocked: false,
  busy: false,
  holdOpen: false,
  hasQuote: true,
  staleForm: false,
  shortBalance: false,
  quoteBlocked: false,
  approval: null,
  acknowledgementMissing: false,
};

describe('next-step line of the swap card', () => {
  it('follows the order of the conditions that close the Swap button', () => {
    expect(nextStep(ready)).toEqual({
      tone: 'action',
      text: 'Next: Swap opens your wallet with this quote.',
    });
    expect(nextStep({ ...ready, onChain: false }).text).toContain('switch to chain 700770');
    expect(nextStep({ ...ready, approval: 'Approve 10 bUSDC' }).text).toBe(
      'Step 1 of 2: Approve 10 bUSDC in your wallet. Step 2: Swap.',
    );
    expect(nextStep({ ...ready, acknowledgementMissing: true }).tone).toBe('blocked');
    expect(nextStep({ ...ready, quoteBlocked: true, approval: 'Approve 1 bUSDC' }).tone).toBe(
      'blocked',
    );
    expect(nextStep({ ...ready, shortBalance: true, quoteBlocked: true }).text).toContain(
      'lower the amount',
    );
    expect(nextStep({ ...ready, staleForm: true, shortBalance: true }).text).toContain(
      'get a new quote',
    );
    expect(nextStep({ ...ready, hasQuote: false }).tone).toBe('idle');
    expect(nextStep({ ...ready, holdOpen: true, hasQuote: false }).tone).toBe('wait');
    expect(nextStep({ ...ready, busy: true, holdOpen: true }).text).toContain('In progress');
    expect(nextStep({ ...ready, connected: false }).text).toContain('connect a wallet');
    expect(nextStep({ ...ready, connected: false, walletPending: true }).tone).toBe('wait');
    expect(nextStep({ ...ready, storageBlocked: true, connected: false }).tone).toBe('blocked');
  });

  it('never gives fee advice or names an outcome', () => {
    const texts = [
      ready,
      { ...ready, busy: true },
      { ...ready, holdOpen: true },
      { ...ready, storageBlocked: true },
      { ...ready, quoteBlocked: true },
    ].map((f) => nextStep(f).text);
    for (const text of texts) expect(text).not.toMatch(/fee|tip|mined|confirmed|sent\b/i);
  });
});
