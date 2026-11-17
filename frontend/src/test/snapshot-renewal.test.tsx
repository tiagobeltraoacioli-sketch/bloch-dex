// Round 18 (agent 361): the renewal timer's decision (R328-3P-2) and the reverted-swap hold text (R328-3P-3).
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Rpc } from '../devnet4/chain';
import {
  backgroundRenewal,
  cannotRenewText,
  entryQuietMs,
  renewalCheckMs,
  renewalText,
  staleAt,
  ENTRY_QUIET_MS,
  RENEWAL_CHECK_MS,
  type BackgroundFacts,
} from '../ui/snapshot-renewal';
import { revertedProgress } from '../ui/confirmation-progress';
import { ConfirmationProgress } from '../ui/ConfirmationProgress';
import { SNAPSHOT_MAX_AGE_MS } from '../MultichainApp';

const due: BackgroundFacts = {
  ageMs: SNAPSHOT_MAX_AGE_MS,
  maxAgeMs: SNAPSHOT_MAX_AGE_MS,
  sinceEditMs: Infinity,
  quoteOnScreen: false,
  walletRequest: false,
  holdOpen: false,
  failure: false,
  reading: false,
  hidden: false,
};

describe('background renewal of the snapshot block', () => {
  it('runs at the 240 s pace of the multichain site, looked at every 5 s, with a 10 s entry pause', () => {
    expect(SNAPSHOT_MAX_AGE_MS).toBe(240_000);
    expect(renewalCheckMs(SNAPSHOT_MAX_AGE_MS)).toBe(RENEWAL_CHECK_MS);
    expect(RENEWAL_CHECK_MS).toBe(5_000);
    expect(entryQuietMs(SNAPSHOT_MAX_AGE_MS)).toBe(ENTRY_QUIET_MS);
    expect(ENTRY_QUIET_MS).toBe(10_000);
    // The age a snapshot can reach unpaused: the bound plus one look.
    expect(SNAPSHOT_MAX_AGE_MS + renewalCheckMs(SNAPSHOT_MAX_AGE_MS)).toBe(245_000);
  });

  it('renews only past the bound and only when nothing pauses it', () => {
    expect(backgroundRenewal(due)).toBe('renew');
    expect(backgroundRenewal({ ...due, ageMs: SNAPSHOT_MAX_AGE_MS - 1 })).toBe('not-due');
  });

  it.each([
    ['reading', { reading: true }],
    ['failure', { failure: true }],
    ['hold', { holdOpen: true }],
    ['wallet-request', { walletRequest: true }],
    ['hidden', { hidden: true }],
    ['mid-entry', { sinceEditMs: ENTRY_QUIET_MS - 1 }],
    ['reading-quote', { quoteOnScreen: true }],
  ] as const)('waits: %s', (reason, change) => {
    expect(backgroundRenewal({ ...due, ...change })).toBe(reason);
    // Every pause ends: once the cause is gone, it renews at the next look.
    expect(backgroundRenewal(due)).toBe('renew');
  });

  it('an edit 10 s ago or more is not mid-entry', () => {
    expect(backgroundRenewal({ ...due, sinceEditMs: ENTRY_QUIET_MS })).toBe('renew');
  });

  it('a quote or a swap is never built on a snapshot at or past the bound', () => {
    expect(staleAt(SNAPSHOT_MAX_AGE_MS, SNAPSHOT_MAX_AGE_MS)).toBe(true);
    expect(staleAt(SNAPSHOT_MAX_AGE_MS - 1, SNAPSHOT_MAX_AGE_MS)).toBe(false);
    // The Bloch L2 passes no bound: its snapshot is renewed by its own events, as before.
    expect(staleAt(10 ** 9, undefined)).toBe(false);
  });

  it('says why a card was renewed, and why no quote is read under a hold or a wallet request', () => {
    expect(renewalText('quote', SNAPSHOT_MAX_AGE_MS)).toBe(
      'The block this page read was more than 4 minutes old, so it read a newer block before quoting.',
    );
    expect(renewalText('swap', SNAPSHOT_MAX_AGE_MS)).toMatch(/^Nothing was sent: .*press Swap again\.$/);
    expect(renewalText('unconfirmed', SNAPSHOT_MAX_AGE_MS)).toContain('read a newer block once');
    expect(cannotRenewText('hold', SNAPSHOT_MAX_AGE_MS)).toContain('renewed when the hold ends');
    expect(cannotRenewText('wallet-request', SNAPSHOT_MAX_AGE_MS)).toContain(
      'once the wallet request has ended',
    );
  });
});

const at = (h: number, m: number) => new Date(2026, 10, 17, h, m, 0).getTime();

describe('reverted-swap hold text', () => {
  it('depth rule (Linea, 30 blocks): the time the account can send again, with the reason', () => {
    const p = revertedProgress({ depth: 30 }, 12, { included: 100n, reference: 110n }, at(9, 0));
    // 20 blocks left at 12 s: 4 minutes.
    expect(p.headline).toBe('Reverted in block 100; this account can send again at about 09:04');
    expect(p.detail).toContain('Until 30 blocks are on top of block 100, that block could still be replaced');
    expect(p.detail).toContain('a second swap sent now could execute next to this one');
    expect(p.detail).toContain('20 blocks to go');
    expect(p.percent).toBe(33);
    expect(p.phase).toBe('reverted');
  });

  it('tag rule (safe): estimated from the blocks between the safe block and the receipt', () => {
    const p = revertedProgress({ tag: 'safe' }, 2, { included: 500n, reference: 380n }, at(21, 10));
    expect(p.headline).toBe('Reverted in block 500; this account can send again at about 21:14');
    expect(p.detail).toContain("the chain's own safe block has reached block 500");
    expect(p.detail).toContain('the safe block moves when the chain decides');
  });

  it('reached: the hold ends once the page has verified the receipt', () => {
    const p = revertedProgress({ tag: 'safe' }, 2, { included: 500n, reference: 501n }, at(9, 0));
    expect(p.headline).toBe(
      'Reverted in block 500; this account can send again once the page has verified the reverted receipt',
    );
    expect(p.percent).toBe(100);
  });

  it('without a block time or a reference: the rule in words, no invented time', () => {
    const p = revertedProgress({ tag: 'finalized' }, null, { included: 7n, reference: 3n }, at(9, 0));
    expect(p.headline).toBe(
      "Reverted in block 7; this account can send again once the chain's own finalized block has reached block 7",
    );
    expect(p.headline).not.toMatch(/\d\d:\d\d/);
  });

  const rpcWith = (status: string, seen: string[]): Rpc =>
    (async (method: string, params: unknown[]) => {
      seen.push(`${method}:${JSON.stringify(params)}`);
      if (method === 'eth_getTransactionReceipt') return { blockNumber: '0x64', status };
      if (method === 'eth_blockNumber') return '0x6e';
      if (method === 'eth_getBlockByNumber') return { number: '0x50' };
      throw new Error(method);
    }) as Rpc;

  it('is on screen by default under a held reverted swap, counted against the reverted rule', async () => {
    const seen: string[] = [];
    render(
      <ConfirmationProgress
        rpc={rpcWith('0x0', seen)}
        hash={`0x${'1'.repeat(64)}`}
        rule={{ depth: 50 }}
        reverted={{ tag: 'safe' }}
        blockSeconds={2}
        now={() => at(10, 0)}
      />,
    );
    const head = await screen.findByText(/^Reverted in block 100; this account can send again at about/);
    // 100 - 80 = 20 blocks at 2 s: 40 s, so 10:00.
    expect(head.textContent).toBe('Reverted in block 100; this account can send again at about 10:00');
    expect(screen.getByTestId('confirmation-progress').getAttribute('data-phase')).toBe('reverted');
    expect(screen.getByTestId('confirmation-progress').textContent).toContain(
      'only then lets you swap again',
    );
    // The safe block was asked, not the finalized one.
    expect(seen.some((s) => s.startsWith('eth_getBlockByNumber:["safe"'))).toBe(true);
  });

  it('a successful receipt, or an approval (no reverted rule), keeps the ordinary count', async () => {
    const seen: string[] = [];
    render(
      <ConfirmationProgress
        rpc={rpcWith('0x1', seen)}
        hash={`0x${'2'.repeat(64)}`}
        rule={{ depth: 50 }}
        reverted={{ tag: 'safe' }}
        blockSeconds={2}
      />,
    );
    await screen.findByText('In block 100: 10 of 50 confirmations');
    render(
      <ConfirmationProgress
        rpc={rpcWith('0x0', [])}
        hash={`0x${'3'.repeat(64)}`}
        rule={{ depth: 50 }}
        blockSeconds={2}
      />,
    );
    await waitFor(() => expect(screen.getAllByText('In block 100: 10 of 50 confirmations')).toHaveLength(2));
    expect(screen.queryByText(/^Reverted/)).toBeNull();
  });
});
