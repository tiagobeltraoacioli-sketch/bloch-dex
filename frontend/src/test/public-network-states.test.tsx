// The states of a public network on the redesigned page (agent 327): the confirmation note and the word
// "confirmed", a sent swap counted against the confirmation rule, the two-endpoint refusals and a rate-limited
// endpoint, and the countdown of a hold's saved deadline. jsdom lays nothing out: what is on screen without a
// click is checked here by structure (not inside an inert region) and in a real browser by the page rehearsal.
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MainnetLive from '../MainnetLive';
import { MultichainApplication } from '../MultichainApp';
import type { Devnet4Wallet } from '../Devnet4Live';
import { ChainError, type Rpc } from '../devnet4/chain';
import { REPLACEMENT_NOT_FOR_UNSEEN_SWAPS, REVIEW_NOT_FOR_SWAPS } from '../mainnet/pendingswap';
import { BLOCH_L2_WORDING, setWording, worded, wording } from '../mainnet/wording';
import { bundledChains } from '../multichain/config';
import { BEHIND, DISAGREEMENT, UNCONFIRMED } from '../multichain/rpc';
import { ConfirmationProgress } from '../ui/ConfirmationProgress';
import { DeadlineClock } from '../ui/DeadlineClock';
import { confirmationProgress } from '../ui/confirmation-progress';
import { classifyReadFailure, clockText, readRetrySeconds } from '../ui/read-failure';

afterEach(() => setWording({ ...BLOCH_L2_WORDING }));
const chainOf = (key: string) => bundledChains().find((c) => c.key === key)!;
const noWallet: Devnet4Wallet = {
  account: null,
  provider: null,
  wallets: [],
  pending: false,
  error: '',
  connect: () => {},
};
const visibleByDefault = (el: Element) => el.closest('[inert]') === null;

describe('the word for the settlement block', () => {
  it('is "finalized" on the Bloch L2 and where the rule is the chain\'s own finalized block, "confirmed" on a depth rule', () => {
    expect(BLOCH_L2_WORDING.settled).toBe('finalized');
    const words = Object.fromEntries(bundledChains().map((c) => [c.key, c.wording.settled]));
    expect(words).toEqual({
      ethereum: 'confirmed',
      base: 'confirmed',
      'arbitrum-one': 'confirmed',
      'op-mainnet': 'confirmed',
      linea: 'confirmed',
      'bnb-smart-chain': 'finalized',
    });
    expect(chainOf('base').wording.finality).toBe('Confirmation');
    expect(chainOf('bnb-smart-chain').wording.finality).toBe('Finality');
    expect(chainOf('base').blockSeconds).toBeGreaterThan(0);
  });

  it("returns the logic modules' sentences unchanged with the Bloch L2's words", () => {
    for (const text of [REVIEW_NOT_FOR_SWAPS, REPLACEMENT_NOT_FOR_UNSEEN_SWAPS])
      expect(worded(text)).toBe(text);
    setWording(chainOf('bnb-smart-chain').wording);
    expect(worded(REVIEW_NOT_FOR_SWAPS)).toBe(REVIEW_NOT_FOR_SWAPS);
  });

  it('says "confirmed" in those sentences on a depth network and changes no other word', () => {
    setWording(chainOf('base').wording);
    const samples = [
      REVIEW_NOT_FOR_SWAPS,
      REPLACEMENT_NOT_FOR_UNSEEN_SWAPS,
      'Waiting for the next block and canonical finality. Do not resend with a new nonce; Swap stays disabled until the outcome is known.',
      'Mined in block 12; verified canonical and finalized.',
      'Finality is unavailable, so nothing was sent. Refresh when it is back.',
      'The receipt or finality checkpoint is no longer canonical. The submission hold remains.',
    ];
    for (const text of samples) {
      const said = worded(text);
      expect(said).not.toMatch(/finali/i);
      expect(said.replace(/confirmed/g, 'finalized').replace(/confirmation/g, 'finality')).toBe(
        text.replace(/Finality/g, 'Confirmation').replace(/finality/g, 'finality'),
      );
    }
    expect(worded(samples[2])).toBe(
      'Waiting for the next block and canonical confirmation. Do not resend with a new nonce; Swap stays disabled until the outcome is known.',
    );
    expect(worded(samples[3])).toBe('Mined in block 12; verified canonical and confirmed.');
  });
});

describe('the confirmation note on the page', () => {
  it('is on the page without a click, in full, and the page says "confirmed" and never "finalized" on a depth network', async () => {
    history.replaceState(null, '', '/#/base');
    render(<MultichainApplication />);
    await screen.findByLabelText('Not yet live');
    const note = screen.getByTestId('confirmation-rule');
    expect(note.textContent).toBe(chainOf('base').confirmationNote);
    expect(note.textContent).toMatch(
      /^On Base this page treats a block as settled once 50 blocks are on top of it \(about \d+ (seconds|minutes)\), not at the chain's own finality\. Where this page says "confirmed" on this network, it means that\./,
    );
    expect(visibleByDefault(note)).toBe(true);
    expect(note.closest('details')).toBeNull();
    // The rule itself is the emphasised first sentence.
    expect(note.querySelector('strong')!.textContent).toMatch(/^On Base .* own finality\.$/);
    expect(document.body.textContent).toContain('read at the confirmed block');
    // Outside the note (which names the chain's own finalized block for the strict rule) the word is not used.
    const rest = document.body.textContent!.replace(note.textContent!, '');
    expect(rest).not.toMatch(/finalized/i);
    expect(wording.settled).toBe('confirmed');
  });

  it('on a network that settles at its own finalized block the note says so and the page keeps "finalized"', async () => {
    history.replaceState(null, '', '/#/bnb-smart-chain');
    render(<MultichainApplication />);
    await screen.findByLabelText('Not yet live');
    const note = screen.getByTestId('confirmation-rule');
    expect(note.textContent).toBe(
      "On BNB Smart Chain this page reads and settles at the chain's own finalized block.",
    );
    expect(visibleByDefault(note)).toBe(true);
    expect(document.body.textContent).toContain('read at the finalized block');
  });
});

describe('a failed read is named, shown in full, and read again the right way', () => {
  it('classifies the two-endpoint refusals of multichain/rpc.ts and a rate limit', () => {
    expect(classifyReadFailure(DISAGREEMENT)).toMatchObject({
      kind: 'disagreement',
      retry: 'manual',
    });
    expect(classifyReadFailure(UNCONFIRMED)).toMatchObject({ kind: 'unconfirmed', retry: 'auto' });
    expect(classifyReadFailure(BEHIND)).toMatchObject({ kind: 'behind', retry: 'auto' });
    for (const text of [
      'chain: eth_getBlockByNumber returned HTTP 429',
      'chain: eth_call failed: rate limit exceeded',
      'chain: eth_call failed: Too Many Requests',
    ])
      expect(classifyReadFailure(text)).toMatchObject({ kind: 'rate-limited', retry: 'auto' });
    for (const text of ['Failed to fetch', 'The operation timed out.', 'Load failed'])
      expect(classifyReadFailure(text)).toMatchObject({ kind: 'unreachable', retry: 'auto' });
    for (const text of [
      'chain: eth_call returned HTTP 500',
      'chain: the deployment record does not match the chain',
      'Unavailable.',
    ])
      expect(classifyReadFailure(text)).toMatchObject({ kind: 'other', retry: 'manual' });
    // Inside the card (a refused quote) nothing reads again by itself: the advice says what to do, and Refresh is
    // offered where a newer block can help (review R328-5: a block too old for one endpoint).
    expect(classifyReadFailure(UNCONFIRMED)).toMatchObject({ refresh: true });
    expect(classifyReadFailure(UNCONFIRMED).quoteAdvice).toMatch(
      /Nothing was sent\. Refresh reads a newer block; then get the quote again\.$/,
    );
    expect(classifyReadFailure(DISAGREEMENT)).toMatchObject({ refresh: true });
    expect(classifyReadFailure('chain: eth_call returned HTTP 429')).toMatchObject({
      refresh: false,
    });
    for (const text of [UNCONFIRMED, DISAGREEMENT, 'chain: x returned HTTP 429', 'Failed to fetch'])
      expect(classifyReadFailure(text).quoteAdvice).not.toMatch(/by itself/);
    expect([0, 1, 2, 3, 4, 9].map(readRetrySeconds)).toEqual([15, 30, 60, 120, 120, 120]);
    expect([0, 0.2, 59, 60, 3599, 3600, 3725].map(clockText)).toEqual([
      '0:00',
      '0:01',
      '0:59',
      '1:00',
      '59:59',
      '1:00:00',
      '1:02:05',
    ]);
  });

  const page = (load: () => Promise<never>, now: () => number) => {
    const chain = chainOf('base');
    setWording(chain.wording);
    const rpc = vi.fn<Rpc>();
    render(
      <MainnetLive
        network={chain.network}
        load={load}
        rpc={rpc}
        wallet={noWallet}
        planned={chain.planned}
        now={now}
        confirmation={{
          note: chain.confirmationNote,
          rule: chain.confirmation.settle,
          blockSeconds: chain.blockSeconds,
        }}
      />,
    );
    return rpc;
  };

  it("endpoints that disagree: a refusal in the route's own words, nothing sent, read again only on request", async () => {
    vi.useFakeTimers();
    try {
      const load = vi.fn(() => Promise.reject(new ChainError(DISAGREEMENT)));
      const rpc = page(load, () => Date.now());
      await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
      const block = screen.getByRole('alert', { name: 'Reads unavailable' });
      expect(block.getAttribute('data-kind')).toBe('disagreement');
      expect(block.textContent).toContain('The endpoints disagree');
      expect(block.textContent).toContain(
        `Base reads are unavailable: ${DISAGREEMENT.replace(/\.$/, '')}. No transaction can be sent from this page.`,
      );
      expect(screen.queryByTestId('read-retry')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Swap' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Get quote' })).toBeNull();
      // The confirmation note stays on the page in this state too.
      expect(visibleByDefault(screen.getByTestId('confirmation-rule'))).toBe(true);
      await act(async () => void (await vi.advanceTimersByTimeAsync(10 * 60_000)));
      expect(load).toHaveBeenCalledTimes(1);
      await act(async () => {
        screen.getByRole('button', { name: 'Read again' }).click();
        await vi.advanceTimersByTimeAsync(10);
      });
      expect(load).toHaveBeenCalledTimes(2);
      expect(rpc).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['unconfirmed', UNCONFIRMED, 'A second endpoint has not confirmed'],
    [
      'rate-limited',
      'chain: eth_getBlockByNumber returned HTTP 429',
      'The endpoint is limiting requests',
    ],
  ])(
    '%s: the page reads again by itself, later each time, and counts the wait down',
    async (kind, text, title) => {
      vi.useFakeTimers();
      try {
        const load = vi.fn(() => Promise.reject(new ChainError(text)));
        page(load, () => Date.now());
        await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
        const block = () => screen.getByRole('alert', { name: 'Reads unavailable' });
        expect(block().getAttribute('data-kind')).toBe(kind);
        expect(block().textContent).toContain(title);
        expect(block().textContent).toContain(
          `Base reads are unavailable: ${text.replace(/\.$/, '')}. No transaction can be sent from this page.`,
        );
        expect(screen.getByTestId('read-retry').textContent).toBe('Reading again in 0:15');
        await act(async () => void (await vi.advanceTimersByTimeAsync(5_000)));
        expect(screen.getByTestId('read-retry').textContent).toBe('Reading again in 0:10');
        expect(load).toHaveBeenCalledTimes(1);
        await act(async () => void (await vi.advanceTimersByTimeAsync(10_100)));
        expect(load).toHaveBeenCalledTimes(2);
        // The second wait is longer.
        expect(screen.getByTestId('read-retry').textContent).toMatch(
          /^Reading again in 0:(30|29)$/,
        );
        await act(async () => void (await vi.advanceTimersByTimeAsync(20_000)));
        expect(load).toHaveBeenCalledTimes(2);
        await act(async () => void (await vi.advanceTimersByTimeAsync(10_100)));
        expect(load).toHaveBeenCalledTimes(3);
        // "Read now" does not wait.
        await act(async () => {
          screen.getByRole('button', { name: 'Read now' }).click();
          await vi.advanceTimersByTimeAsync(10);
        });
        expect(load).toHaveBeenCalledTimes(4);
        expect(screen.queryByRole('button', { name: 'Swap' })).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

describe('a sent transaction against the confirmation rule', () => {
  it('counts confirmations on a depth rule and says what is left', () => {
    const rule = { depth: 50 };
    expect(confirmationProgress(rule, 2, { included: null, reference: 100n })).toMatchObject({
      phase: 'unseen',
      percent: 0,
      headline: 'Not in a block yet',
      detail: 'Once it is in a block, this page waits for 50 blocks on top of its block.',
    });
    expect(confirmationProgress(rule, 2, { included: 100n, reference: 100n })).toMatchObject({
      phase: 'counting',
      percent: 0,
      headline: 'In block 100: 0 of 50 confirmations',
      detail: "50 blocks to go, about 2 min at this network's block time.",
    });
    expect(confirmationProgress(rule, 2, { included: 100n, reference: 120n })).toMatchObject({
      percent: 40,
      headline: 'In block 100: 20 of 50 confirmations',
      detail: "30 blocks to go, about 60 s at this network's block time.",
    });
    expect(confirmationProgress(rule, 2, { included: 100n, reference: 149n }).detail).toBe(
      "1 block to go, about 2 s at this network's block time.",
    );
    expect(confirmationProgress(rule, 2, { included: 100n, reference: 190n })).toMatchObject({
      phase: 'reached',
      percent: 100,
      headline: 'In block 100: 50 of 50 confirmations',
    });
    // A head behind the receipt's block (another endpoint answered) never counts below zero.
    expect(confirmationProgress(rule, 2, { included: 100n, reference: 98n }).headline).toBe(
      'In block 100: 0 of 50 confirmations',
    );
  });

  it("on a tag rule says how far the chain's own block is behind", () => {
    const rule = { tag: 'finalized' as const };
    expect(confirmationProgress(rule, 0.75, { included: 500n, reference: 498n })).toMatchObject({
      phase: 'counting',
      headline: "In block 500: waiting for the chain's finalized block",
    });
    expect(confirmationProgress(rule, 0.75, { included: 500n, reference: 500n }).phase).toBe(
      'reached',
    );
  });

  it('reads the receipt and the head, shows the count, and backs off when the endpoint limits requests', async () => {
    vi.useFakeTimers();
    try {
      let head = 1010;
      let limited = false;
      const rpc = vi.fn<Rpc>(async (method) => {
        if (limited) throw new ChainError(`chain: ${method} returned HTTP 429`);
        if (method === 'eth_getTransactionReceipt') return { blockNumber: '0x3e8' };
        if (method === 'eth_blockNumber') return `0x${head.toString(16)}`;
        throw new Error(`unexpected ${method}`);
      });
      render(
        <ConfirmationProgress
          rpc={rpc}
          hash={`0x${'ab'.repeat(32)}`}
          rule={{ depth: 32 }}
          blockSeconds={0.25}
          pollMs={4000}
        />,
      );
      await act(async () => void (await vi.advanceTimersByTimeAsync(10)));
      const box = screen.getByTestId('confirmation-progress');
      expect(box.textContent).toContain('In block 1000: 10 of 32 confirmations');
      expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('31');
      expect(box.textContent).toContain(
        'The hold ends only when the page has verified the receipt itself.',
      );
      // Only reads: the receipt and the block number, nothing that sends.
      expect(new Set(rpc.mock.calls.map((c) => c[0]))).toEqual(
        new Set(['eth_getTransactionReceipt', 'eth_blockNumber']),
      );
      head = 1040;
      await act(async () => void (await vi.advanceTimersByTimeAsync(4_000)));
      expect(box.textContent).toContain('In block 1000: 32 of 32 confirmations');
      expect(box.getAttribute('data-phase')).toBe('reached');
      limited = true;
      await act(async () => void (await vi.advanceTimersByTimeAsync(4_000)));
      expect(box.textContent).toContain(
        'The endpoint is limiting requests, so this count is behind',
      );
      const calls = rpc.mock.calls.length;
      // The next look is 8 s away, not 4.
      await act(async () => void (await vi.advanceTimersByTimeAsync(4_500)));
      expect(rpc.mock.calls.length).toBe(calls);
      await act(async () => void (await vi.advanceTimersByTimeAsync(4_000)));
      expect(rpc.mock.calls.length).toBe(calls + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the saved deadline of a hold', () => {
  it('counts down second by second by the given clock, and counts up once it has passed', () => {
    vi.useFakeTimers();
    try {
      let now = 1_700_000_000_000;
      const deadline = BigInt(now / 1000 + 20 * 60);
      const { container } = render(
        <DeadlineClock deadline={deadline} sentAtMs={now} now={() => now} settled="confirmed" />,
      );
      const left = () => screen.getByTestId('deadline-left').textContent;
      expect(left()).toBe('20:00');
      expect(container.textContent).toMatch(
        /^Saved deadline in 20:00 \(at \d\d:\d\d\), by this device's clock\.$/,
      );
      for (const expected of ['19:59', '19:58', '19:57']) {
        now += 1000;
        act(() => void vi.advanceTimersByTime(1000));
        expect(left()).toBe(expected);
      }
      now += 15 * 60_000;
      act(() => void vi.advanceTimersByTime(1000));
      expect(left()).toBe('4:57');
      expect(container.querySelector('.deadline-clock')!.hasAttribute('data-soon')).toBe(true);
      now += 5 * 60_000;
      act(() => void vi.advanceTimersByTime(1000));
      expect(container.querySelector('.deadline-clock')!.hasAttribute('data-passed')).toBe(true);
      expect(left()).toBe('0:03');
      expect(container.textContent).toMatch(
        /^Saved deadline passed 0:03 ago \(at \d\d:\d\d\), by this device's clock\. Unless the swap's receipt arrives first, the page releases the hold by itself once a confirmed block is later than the deadline\.$/,
      );
      expect((container.querySelector('.deadline-bar > span') as HTMLElement).style.width).toBe(
        '100%',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
