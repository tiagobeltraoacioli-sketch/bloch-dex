// Round 20, after review 413 (agent 411): the liquidity dialog under the reviewer's findings. The first three
// cases are the reviewer's own demonstrations (scratchpad/a413, `r413-dialog.test.tsx`), restated: there they
// asserted the defect and passed at f6468d3; here they assert the rule and fail at f6468d3.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, type Hex } from 'viem';
import MainnetLive from '../MainnetLive';
import type { Rpc } from '../devnet4/chain';
import { ERC20_ABI } from '../devnet4/chain';
import { LiquidityRisks } from '../live/LiquidityRisks';
import { historyKey } from '../mainnet/txhistory';
import { pendingSwapKey } from '../mainnet/pendingswap';
import { renewalClock } from '../ui/snapshot-renewal';
import {
  ACCOUNT,
  chain,
  deployment,
  fakeChain,
  fakeWallet,
  figure,
  goTo,
  h,
  LATEST,
  mount,
  NOW_MS,
  ONE,
  sends,
  type,
  USDC,
  useLiveHarness,
} from './live-harness';

useLiveHarness();

const openDialog = async (button: string, screenName = 'Pools') => {
  await goTo(screenName);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: button }));
  await screen.findByRole('dialog');
  return user;
};
const openAdd = async () => {
  const user = await openDialog('Add liquidity to USDC/WETH');
  await within(screen.getByRole('dialog')).findByLabelText(/^Amount of ETH/);
  return user;
};
const field = (label: RegExp) =>
  within(screen.getByRole('dialog')).getByLabelText(label) as HTMLInputElement;
const pause = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
/** The user does something else a moment after the press (the press's own `act` scope has ended by then). */
const outsideThePress = () => new Promise((r) => setTimeout(r, 40));
const note = () => screen.getByTestId('liquidity-note').textContent;
const NEWER_BLOCK =
  'The page read a newer confirmed block while the request was being prepared, so nothing was sent. Check the figures and press again.';
const FORM_CHANGED =
  'The amounts or settings changed while the request was being prepared, so nothing was sent. Check the figures and press again.';

describe('R413-1: what is sent is what is on screen at the press', () => {
  it('(a) a newer block taken during the comparison with the head: nothing is sent, and the page says why', async () => {
    const { rpc, state } = fakeChain({ usdcAllowance: 10n ** 12n });
    const { sent, wallet } = fakeWallet();
    let armed = false;
    let hit = false;
    const comparison = (params: unknown[]) =>
      params[1] === 'latest' || (params[1] as { blockHash?: Hex })?.blockHash === LATEST.hash;
    const hooked: Rpc = async (method, params) => {
      if (armed && !hit && method === 'eth_call' && comparison(params)) {
        hit = true;
        // The page takes a newer pinned block (here its Refresh), whose pool holds 0.2% more USDC. The head still
        // passes the old minimums.
        state.blockHash = h(0xb10d);
        state.reserves = [30_360_600_000n, 9_930_000_000_000_000_000n];
        (document.querySelector('.live-status .page-refresh') as HTMLButtonElement).click();
        await new Promise((r) => setTimeout(r, 400));
      }
      return rpc(method, params);
    };
    mount(hooked, wallet);
    const user = await openAdd();
    await type(/^Amount of ETH/, '1');
    expect(field(/^Amount of USDC/).value).toBe('3051.359516');
    armed = true;
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Add liquidity' }),
    );
    await waitFor(() => expect(note()).toBe(NEWER_BLOCK), { timeout: 4000 });
    expect(hit).toBe(true);
    // The dialog now shows the newer block's figures; nothing was asked of the wallet for the older ones.
    await waitFor(() => expect(field(/^Amount of USDC/).value).toBe('3057.462235'));
    expect(sends(sent)).toBe(0);
    expect(localStorage.getItem(pendingSwapKey(1, ACCOUNT))).toBeNull();
  });

  it('(b) an amount edited while the head is read: nothing is sent, and the page says why', async () => {
    const { rpc } = fakeChain({ usdcAllowance: 10n ** 12n });
    const { sent, wallet } = fakeWallet();
    let armed = false;
    let hit = false;
    const hooked: Rpc = async (method, params) => {
      if (armed && !hit && method === 'eth_getBlockByNumber' && params[0] === 'latest') {
        hit = true;
        await outsideThePress();
        await act(async () => {
          fireEvent.change(field(/^Amount of ETH/), { target: { value: '2' } });
        });
      }
      return rpc(method, params);
    };
    mount(hooked, wallet);
    const user = await openAdd();
    await type(/^Amount of ETH/, '1');
    armed = true;
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Add liquidity' }),
    );
    await waitFor(() => expect(hit).toBe(true));
    await pause(600);
    expect(sends(sent)).toBe(0);
    expect(field(/^Amount of ETH/).value).toBe('2');
    expect(field(/^Amount of USDC/).value).toBe('6102.719033');
    expect(localStorage.getItem(pendingSwapKey(1, ACCOUNT))).toBeNull();
  });

  it('(b) a removal pressed at 100% and moved to 25% during the comparison: nothing is sent, and the page says why', async () => {
    const HELD = 55_171_805_874_732n;
    const { rpc } = fakeChain({ shares: HELD, sharesAllowance: HELD });
    const { sent, wallet } = fakeWallet();
    let armed = false;
    let hit = false;
    const hooked: Rpc = async (method, params) => {
      if (armed && !hit && method === 'eth_call' && params[1] !== undefined) {
        const at = params[1] as { blockHash?: Hex } | string;
        if (at === 'latest' || (at as { blockHash?: Hex }).blockHash === LATEST.hash) {
          hit = true;
          await outsideThePress();
          await act(async () => {
            within(screen.getByRole('dialog')).getByRole('button', { name: '25%' }).click();
          });
        }
      }
      return rpc(method, params);
    };
    mount(hooked, wallet);
    const user = await openDialog('Remove liquidity from USDC/WETH', 'Portfolio');
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '100%' }));
    await waitFor(() => expect(figure('Pool shares removed')).toMatch(/^0\.000055171805874732 of/));
    armed = true;
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove liquidity' }),
    );
    await waitFor(() => expect(note()).toBe(FORM_CHANGED), { timeout: 4000 });
    expect(sends(sent)).toBe(0);
    expect(figure('Pool shares removed')).toMatch(/^0\.000013792951468683 of/);
  });

  it('(c) the dialog closed during the comparison: the wallet is not asked and no hold is saved', async () => {
    const { rpc } = fakeChain({ usdcAllowance: 10n ** 12n });
    const { sent, wallet, request } = fakeWallet();
    let armed = false;
    let hit = false;
    const hooked: Rpc = async (method, params) => {
      const at = params[1] as { blockHash?: Hex } | string | undefined;
      if (
        armed &&
        !hit &&
        method === 'eth_call' &&
        (at === 'latest' || (at as { blockHash?: Hex } | undefined)?.blockHash === LATEST.hash)
      ) {
        hit = true;
        await outsideThePress();
        await act(async () => {
          within(screen.getByRole('dialog')).getByRole('button', { name: 'Close dialog' }).click();
        });
        expect(screen.queryByRole('dialog')).toBeNull();
      }
      return rpc(method, params);
    };
    mount(hooked, wallet);
    const user = await openAdd();
    await type(/^Amount of ETH/, '1');
    armed = true;
    const asked = request.mock.calls.length;
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Add liquidity' }),
    );
    await waitFor(() => expect(hit).toBe(true));
    await pause(800);
    expect(sends(sent)).toBe(0);
    // Not even the chain question: the request ended where the dialog did.
    expect(request.mock.calls.length).toBe(asked);
    expect(localStorage.getItem(pendingSwapKey(1, ACCOUNT))).toBeNull();
  });

  it('the block of the press counts for an approval too', async () => {
    const { rpc, state } = fakeChain();
    const { sent, wallet, request } = fakeWallet();
    let moved = false;
    request.mockImplementation(
      async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === 'eth_chainId') {
          if (!moved) {
            moved = true;
            state.blockHash = h(0xb10d);
            (document.querySelector('.live-status .page-refresh') as HTMLButtonElement).click();
            await new Promise((r) => setTimeout(r, 300));
          }
          return '0x1';
        }
        if (method === 'eth_sendTransaction') {
          sent.push((params as Record<string, string>[])[0]);
          return h(0xabc1);
        }
        throw new Error(`the wallet was asked for ${method}`);
      },
    );
    mount(rpc, wallet);
    const user = await openAdd();
    await type(/^Amount of USDC/, '3000');
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve 3000 USDC' }),
    );
    await waitFor(() => expect(note()).toBe(NEWER_BLOCK));
    expect(sends(sent)).toBe(0);
  });
});

describe('R413-2: the approved side stays the approved amount', () => {
  it('pressing the approval fixes the token amount; the native amount then follows the ratio, and a small move asks for no new approval', async () => {
    const { rpc, state } = fakeChain();
    const { wallet, request } = fakeWallet();
    request.mockImplementation(async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return '0x1';
      // The outcome of the request does not matter for the rule; a rejection leaves no hold to wait for.
      throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
    });
    mount(rpc, wallet);
    const user = await openAdd();
    await type(/^Amount of ETH/, '1');
    const dialog = screen.getByRole('dialog');
    // The rule is on screen before the press.
    expect(screen.getByTestId('approval-rule').textContent).toBe(
      "Approving fixes the USDC amount at 3051.359516. From then on the ETH amount follows the pool's ratio, so a small move of the pool asks for no new approval.",
    );
    await user.click(within(dialog).getByRole('button', { name: 'Approve 3051.359516 USDC' }));
    await waitFor(() =>
      expect(note()).toBe('The wallet request was rejected by you. Nothing was sent.'),
    );
    expect(field(/^Amount of USDC/).value).toBe('3051.359516');
    expect(field(/^Amount of ETH/).value).toBe('0.999999999798019801');
    // The approval settled a block ago; the pinned pool now holds 0.01% more USDC.
    state.usdcAllowance = 3_051_359_516n;
    state.reserves = [30_303_030_000n, 9_930_000_000_000_000_000n];
    state.blockHash = h(0xb10d);
    await user.click(document.querySelector('.live-status .page-refresh') as HTMLButtonElement);
    await waitFor(() =>
      expect(within(dialog).getByRole('button', { name: 'Add liquidity' })).toBeTruthy(),
    );
    expect(within(dialog).queryByRole('button', { name: /^Approve/ })).toBeNull();
    expect(field(/^Amount of USDC/).value).toBe('3051.359516');
    // floor(3051359516 x 9.93e18 / 30303030000)
    expect(field(/^Amount of ETH/).value).toBe('0.999900009797040097');
  });

  it('an approval of the typed side changes nothing in the form', async () => {
    const { rpc } = fakeChain();
    const { sent, wallet } = fakeWallet();
    mount(rpc, wallet);
    const user = await openAdd();
    await type(/^Amount of USDC/, '3000');
    expect(screen.queryByTestId('approval-rule')).toBeNull();
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve 3000 USDC' }),
    );
    await waitFor(() => expect(sends(sent)).toBe(1));
    expect(field(/^Amount of USDC/).value).toBe('3000');
    expect(field(/^Amount of ETH/).value).toBe('0.983168316831683168');
    const call = decodeFunctionData({ abi: ERC20_ABI, data: sent[0].data as Hex });
    expect(call.args).toEqual([expect.any(String), 3_000_000_000n]);
  });
});

describe('R413-4: the comparison with the head reads one block', () => {
  it('resolves the head once and reads every figure of the comparison at its hash; the deadline counts from the same header', async () => {
    const { rpc, state } = fakeChain({ usdcAllowance: 10n ** 12n });
    const { sent, wallet } = fakeWallet();
    mount(rpc, wallet);
    const user = await openAdd();
    await type(/^Amount of ETH/, '1');
    const from = state.calls.length;
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Add liquidity' }),
    );
    await waitFor(() => expect(sends(sent)).toBe(1));
    const made = state.calls.slice(from);
    // The dialog's own reads end where the tracked request begins (its first read is the settled block).
    const firstSave = made.findIndex(
      (c) => c.method === 'eth_getBlockByNumber' && c.params[0] === 'finalized',
    );
    const before = made.slice(0, firstSave);
    // No state read by tag, anywhere.
    expect(made.filter((c) => c.method === 'eth_call' && c.params[1] === 'latest')).toEqual([]);
    // One head read, then reserves, the two token balances of the pair, supply, kLast and the fee recipient at it.
    expect(
      before.filter((c) => c.method === 'eth_getBlockByNumber' && c.params[0] === 'latest'),
    ).toHaveLength(1);
    const atHead = before.filter(
      (c) =>
        c.method === 'eth_call' && (c.params[1] as { blockHash?: Hex }).blockHash === LATEST.hash,
    );
    expect(atHead).toHaveLength(6);
    expect(before.filter((c) => c.method === 'eth_call')).toHaveLength(6);
    expect(figure('Read at')).toBe(
      'Confirmed block 1234; compared with one newer block (the head, read once) before your wallet is asked',
    );
  });

  it('a head that cannot be read sends nothing', async () => {
    const { rpc } = fakeChain({ usdcAllowance: 10n ** 12n });
    const { sent, wallet } = fakeWallet();
    let armed = false;
    const hooked: Rpc = async (method, params) => {
      if (armed && method === 'eth_getBlockByNumber' && params[0] === 'latest')
        throw new Error('down');
      return rpc(method, params);
    };
    mount(hooked, wallet);
    const user = await openAdd();
    await type(/^Amount of ETH/, '1');
    armed = true;
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Add liquidity' }),
    );
    await waitFor(() =>
      expect(note()).toBe('The latest block could not be read, so nothing was sent.'),
    );
    expect(sends(sent)).toBe(0);
  });
});

describe('R413-5: a timed renewal never comes during a wallet request of the dialog', () => {
  const realClock = { ...renewalClock };
  afterEach(() => Object.assign(renewalClock, realClock));

  it('the swap card, rebuilt for a newer block, does not clear the dialog’s wallet-request flag', async () => {
    let clock = 1_000_000;
    renewalClock.now = () => clock;
    renewalClock.wall = () => clock;
    const { rpc, state } = fakeChain({ usdcAllowance: 10n ** 12n });
    const { wallet, request } = fakeWallet();
    let asked = 0;
    // The wallet never answers which chain it is on: the dialog's request stays in flight.
    request.mockImplementation(({ method }: { method: string }) => {
      if (method === 'eth_chainId') {
        asked++;
        return new Promise(() => {});
      }
      throw new Error(`the wallet was asked for ${method}`);
    });
    render(
      <MainnetLive
        network={chain.network}
        load={() => Promise.resolve({ status: 'live', deployment })}
        rpc={rpc}
        wallet={wallet}
        planned={{ caps: [], pairs: [['WETH', 'USDC']] }}
        now={() => NOW_MS}
        snapshotMaxAgeMs={400}
        screens={{ base: '#/ethereum' }}
      />,
    );
    const user = await openAdd();
    await type(/^Amount of ETH/, '1');
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Add liquidity' }),
    );
    await waitFor(() => expect(asked).toBe(1));
    const snapshotReads = () =>
      state.calls.filter((c) => c.method === 'eth_getBlockByNumber' && c.params[0] === 'finalized')
        .length;
    // The user's own Refresh takes a newer block: the swap card is rebuilt for it.
    state.blockHash = h(0xb10d);
    const before = snapshotReads();
    await act(async () => {
      (document.querySelector('.live-status .page-refresh') as HTMLButtonElement).click();
    });
    await waitFor(() => expect(snapshotReads()).toBeGreaterThan(before));
    await pause(100);
    const settled = snapshotReads();
    // The snapshot is now past its age bound and nobody is typing: only the wallet request holds the renewal.
    clock += 5_000;
    await pause(400);
    expect(snapshotReads()).toBe(settled);
  });
});

describe('R413-6, R413-10, R413-11: what the screens say', () => {
  it('tokens sent to a pool are not called a gift to its providers: anyone can take them', async () => {
    const { rpc } = fakeChain();
    mount(rpc, fakeWallet().wallet);
    await goTo('Pools');
    const risks = await screen.findByRole('note', { name: 'Risks of providing liquidity' });
    expect(risks.textContent!.replace(/'/g, '’')).toContain(
      'Tokens sent straight to a pool’s address are lost to you. They are not a deposit and give you no shares; anyone can take them from the pool (skim), and until someone does they count for whoever adds or removes liquidity next. Deposit only with the steps of this page.',
    );
    expect(risks.textContent).not.toMatch(/gift/);
  });

  it('Portfolio lists the dialog’s own transactions, and not a swap’s approval', async () => {
    const tx = (label: string, n: number) => ({ label, hash: h(n), state: 'mined' });
    localStorage.setItem(
      historyKey(1, ACCOUNT),
      JSON.stringify([
        tx('Approve 100 USDC', 1),
        tx('Swap 100 USDC for ETH', 2),
        tx('Approve 3051.359516 USDC for liquidity', 3),
        tx('Add liquidity: 3051.359516 USDC + 0.999999999798019801 ETH', 4),
        tx('Approve 0.000013792951468683 USDC/WETH pool shares', 5),
        tx('Remove liquidity: 25% of USDC/WETH shares', 6),
      ]),
    );
    const { rpc } = fakeChain();
    mount(rpc, fakeWallet().wallet);
    await goTo('Portfolio');
    const list = await screen.findByRole('list', { name: 'Liquidity transactions' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.querySelector('strong')!.textContent),
    ).toEqual([
      'Approve 3051.359516 USDC for liquidity',
      'Add liquidity: 3051.359516 USDC + 0.999999999798019801 ETH',
      'Approve 0.000013792951468683 USDC/WETH pool shares',
      'Remove liquidity: 25% of USDC/WETH shares',
    ]);
  });

  it('an approval sent from the dialog is tracked under a name of its own', async () => {
    const { rpc } = fakeChain();
    const { sent, wallet } = fakeWallet();
    mount(rpc, wallet);
    const user = await openAdd();
    await type(/^Amount of USDC/, '3000');
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Approve 3000 USDC' }),
    );
    await waitFor(() => expect(sends(sent)).toBe(1));
    const tracked = await within(screen.getByRole('dialog')).findByRole('status', {
      name: 'Tracked transaction',
    });
    expect(tracked.textContent).toContain('Approve 3000 USDC for liquidity: pending');
  });

  it('shows what the router may already pull, and says that an unused remainder of an approval stays', async () => {
    const { rpc } = fakeChain({ usdcAllowance: 4_000_000_000n });
    mount(rpc, fakeWallet().wallet);
    await openAdd();
    await type(/^Amount of ETH/, '1');
    expect(figure('Approved to the router now')).toBe('4000 USDC');
    expect(screen.getByRole('dialog').textContent).toContain(
      'The router takes only what the pool’s ratio needs when your deposit runs. What an approval allows beyond that stays approved to the router, which can use it only in a later transaction of your own; “Approved to the router now” shows it.'.replace(
        /’/g,
        "'",
      ),
    );
  });
});

describe('R413-3: no frame is left to run after the route is gone', () => {
  it('cancels the focus frame on unmount, and the frame itself tolerates a browser without scrollIntoView', async () => {
    const frames: { id: number; run: FrameRequestCallback }[] = [];
    const request = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(
        (run) => (frames.push({ id: frames.length + 101, run }), frames.length + 100),
      );
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    try {
      const { rpc } = fakeChain();
      const view = mount(rpc, fakeWallet(false).wallet);
      await goTo('Pools');
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole('button', { name: 'Connect a wallet on the Trade screen' }),
      );
      const ours = frames.at(-1)!;
      // jsdom has no scrollIntoView: the frame must not throw there.
      expect(() => ours.run(0)).not.toThrow();
      view.unmount();
      expect(cancel).toHaveBeenCalledWith(ours.id);
    } finally {
      request.mockRestore();
      cancel.mockRestore();
    }
  });
});

describe('the fee sentence follows the record', () => {
  it('names no recipient and no "cannot be changed" when the factory has none', () => {
    const zero = `0x${'0'.repeat(40)}` as const;
    const view = render(<LiquidityRisks feeTo={zero} facts={[]} />);
    const text = view.container.textContent!;
    expect(text).toContain(
      'Every swap pays 0.30% to the pool. This factory has no protocol fee recipient: all of it stays with the liquidity providers.',
    );
    expect(text).not.toContain('cannot be changed');
    expect(text).not.toContain(zero);
  });
});

describe('a wallet that changes network while the dialog is open', () => {
  it('is asked to switch back before anything else, and the dialog says so', async () => {
    const { rpc } = fakeChain({ usdcAllowance: 10n ** 12n });
    const first = fakeWallet();
    const view = mount(rpc, first.wallet);
    const user = await openAdd();
    await type(/^Amount of ETH/, '1');
    // The wallet moves to another chain (chainChanged): the same account, chain 56.
    const methods: string[] = [];
    let current = '0x38';
    const request = vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
      methods.push(method);
      if (method === 'eth_chainId') return current;
      if (method === 'wallet_switchEthereumChain') {
        current = (params as { chainId: string }[])[0].chainId;
        return null;
      }
      if (method === 'eth_sendTransaction') return h(0xabc9);
      throw new Error(`the wallet was asked for ${method}`);
    });
    const moved = {
      ...first.wallet,
      account: { ...first.wallet.account!, chainId: '0x38' },
      provider: { request } as never,
    };
    view.rerender(
      <MainnetLive
        network={chain.network}
        load={() => Promise.resolve({ status: 'live', deployment })}
        rpc={rpc}
        wallet={moved}
        planned={{ caps: [], pairs: [['WETH', 'USDC']] }}
        now={() => NOW_MS}
        receiptPollMs={50}
        screens={{ base: '#/ethereum' }}
      />,
    );
    expect(field(/^Amount of ETH/).value).toBe('1');
    await waitFor(() =>
      expect(screen.getByTestId('liquidity-next-step').textContent).toBe(
        'Next: Add liquidity opens your wallet with these figures. Your wallet is first asked to switch to chain 1.',
      ),
    );
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Add liquidity' }),
    );
    await waitFor(() => expect(methods).toContain('eth_sendTransaction'));
    expect(methods.indexOf('wallet_switchEthereumChain')).toBeGreaterThan(-1);
    expect(methods.indexOf('wallet_switchEthereumChain')).toBeLessThan(
      methods.indexOf('eth_sendTransaction'),
    );
    expect(ONE).toBe(10n ** 18n);
    expect(USDC).toMatch(/^0x/);
  });
});
