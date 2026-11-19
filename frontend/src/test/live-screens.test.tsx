// Round 20 (agent 411): the Trade / Pools / Portfolio screens of a live multichain route and the liquidity dialog,
// over a route rendered with a fake chain: what is offered, what is refused, and exactly what the wallet is asked.
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, type Hex } from 'viem';
import MainnetLive from '../MainnetLive';
import { MultichainApplication } from '../MultichainApp';
import { hrefOfView, routeKeyOfHash, viewOfHash } from '../live/view';
import { LIQUIDITY_ABI } from '../mainnet/liquidity-tx';
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
  mount,
  NOW_MS,
  ONE,
  PAIR,
  ROUTER,
  sends,
  type,
  USDC,
  useLiveHarness,
} from './live-harness';

useLiveHarness();

describe('the screens of a live route', () => {
  it('names a screen by the second segment of the hash and the route by the first', () => {
    expect(routeKeyOfHash('#/ethereum/pools')).toBe('ethereum');
    expect(routeKeyOfHash('#/ethereum')).toBe('ethereum');
    expect(routeKeyOfHash('')).toBe('');
    expect(viewOfHash('#/ethereum/pools', '#/ethereum')).toBe('pools');
    expect(viewOfHash('#/ethereum/portfolio', '#/ethereum')).toBe('portfolio');
    expect(viewOfHash('#/ethereum', '#/ethereum')).toBe('trade');
    expect(viewOfHash('#/ethereum/anything', '#/ethereum')).toBe('trade');
    expect(viewOfHash('#/base/pools', '#/ethereum')).toBe('trade');
    expect(hrefOfView('#/ethereum', 'trade')).toBe('#/ethereum');
    expect(hrefOfView('#/ethereum', 'pools')).toBe('#/ethereum/pools');
  });

  it('Trade is the route itself with the market of each pool; Pools and Portfolio are reached by the tabs', async () => {
    const { rpc } = fakeChain();
    mount(rpc, fakeWallet().wallet);
    const nav = await screen.findByRole('navigation', { name: 'Screens' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['Trade', 'Pools', 'Portfolio']);
    expect(within(nav).getByRole('link', { name: 'Trade' }).getAttribute('aria-current')).toBe(
      'page',
    );
    // The reviewed swap card is on the page, unchanged.
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Bloch DEX on Ethereum');
    expect(screen.getByRole('button', { name: 'Get quote' })).toBeTruthy();
    const market = screen.getByRole('region', { name: 'Market' });
    expect(market.textContent).toContain('1 WETH ≈ 3051.35 USDC');
    expect(market.textContent).toContain('30300 USDC + 9.93 WETH');
    expect(market.textContent).toContain(
      'Price chart and 24-hour volume are not available: this page reads one block from the chain and keeps no history.',
    );
    await goTo('Pools');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Pools');
    // The swap card stays mounted (its form and the tracker's views are not rebuilt), hidden.
    expect(document.querySelector('[data-view="trade"]')!.hasAttribute('hidden')).toBe(true);
    expect(document.querySelector('[data-view="trade"] .swap-card')).not.toBeNull();
    await goTo('Portfolio');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Portfolio');
  });

  it('a route that is not live has no screens and makes no request', async () => {
    const { rpc, state } = fakeChain();
    history.replaceState(null, '', '/#/ethereum/pools');
    mount(rpc, fakeWallet().wallet, [['WETH', 'USDC']], {
      status: 'not-live',
      reasons: ['No record.'],
    });
    await screen.findByLabelText('Not yet live');
    expect(screen.queryByRole('navigation', { name: 'Screens' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Add liquidity/ })).toBeNull();
    expect(state.calls).toEqual([]);
  });

  it('the multichain site follows a screen hash to its network and shows no screens while no pool is recorded', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    history.replaceState(null, '', '/#/base/pools');
    render(<MultichainApplication />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Bloch DEX on Base');
    await screen.findByLabelText('Not yet live');
    expect(screen.queryByRole('navigation', { name: 'Screens' })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Pools', () => {
  it('lists the pools of the record with reserves and the fee, says what it cannot show, and states the risks with the record fee recipient', async () => {
    const { rpc } = fakeChain({ shares: 13_792_951_468_683n });
    mount(rpc, fakeWallet().wallet);
    await goTo('Pools');
    const table = await screen.findByRole('table');
    expect(table.textContent).toContain('USDC/WETH');
    expect(table.textContent).toContain('30300 USDC');
    expect(table.textContent).toContain('9.93 WETH');
    await waitFor(() => expect(table.textContent).toContain('2.5176%'));
    const view = document.querySelector('[data-view="pools"]')!;
    expect(view.textContent).toContain('Volume and fees · 24hNot available');
    const risks = within(view as HTMLElement).getByRole('note', {
      name: 'Risks of providing liquidity',
    });
    for (const line of [
      'Your position follows the pool’s price.',
      'divergence loss, also called impermanent loss',
      'A removal pays both tokens at the pool’s ratio at that time, not the amounts you put in.',
      'Tokens sent straight to a pool’s address are lost to you.',
      'Every swap pays 0.30% to the pool. One sixth of what the fees add goes to the protocol fee recipient',
      deployment.feeTo,
      'A token’s issuer keeps its powers.',
      'USDC: Circle-issued (native); upgradeable proxy, the issuer can pause and blacklist.',
    ])
      expect(risks.textContent!.replace(/'/g, '’')).toContain(line);
    // Nothing of the preview's sample data, and nothing of the Bloch L2 but the site's name.
    expect(document.body.textContent!.replaceAll('Bloch DEX', '')).not.toMatch(
      /Bloch|BLCH|bUSDC|USTAV|Sample|Demo|Preview only/,
    );
  });

  it('never offers a pair that is not open: no button, one line that says why', async () => {
    const { rpc } = fakeChain();
    const { sent, wallet } = fakeWallet();
    mount(rpc, wallet, [
      ['WETH', 'USDC'],
      ['WETH', 'USDT'],
    ]);
    await goTo('Pools');
    const row = await screen.findByTestId('pool-not-open');
    expect(row.textContent).toBe(
      'WETH/USDTNot open yet. Only the first depositor fixed in the factory can open a pool, so this page builds no first deposit for anyone.',
    );
    expect(within(row).queryByRole('button')).toBeNull();
    expect(screen.getAllByRole('button', { name: /Add liquidity to/ })).toHaveLength(1);
    expect(sends(sent)).toBe(0);
  });

  it('a recorded pair found without shares on the chain is not offered either, and the dialog cannot build a deposit for it', async () => {
    const { rpc } = fakeChain({ supply: 0n, kLast: 0n });
    const { sent, wallet } = fakeWallet();
    mount(rpc, wallet);
    await goTo('Pools');
    await waitFor(() =>
      expect(screen.getByRole('table').textContent).toContain(
        'Not open yet. Only the first depositor fixed in the factory can open a pool',
      ),
    );
    expect(screen.queryByRole('button', { name: /Add liquidity/ })).toBeNull();
    expect(sends(sent)).toBe(0);
  });

  it('without a wallet it points to the connect step of the Trade screen', async () => {
    const { rpc } = fakeChain();
    mount(rpc, fakeWallet(false).wallet);
    await goTo('Pools');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Connect a wallet on the Trade screen' }),
    );
    expect(location.hash).toBe('#/ethereum');
    expect(
      within(screen.getByRole('navigation', { name: 'Screens' }))
        .getByRole('link', { name: 'Trade' })
        .getAttribute('aria-current'),
    ).toBe('page');
  });
});

describe('the liquidity dialog: a deposit', () => {
  const open = async () => {
    await goTo('Pools');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add liquidity to USDC/WETH' }));
    await within(await screen.findByRole('dialog')).findByLabelText(/^Amount of ETH/);
    return user;
  };

  it('computes the other amount from the pool ratio and shows amounts, minimums, shares and the share after', async () => {
    const { rpc } = fakeChain();
    mount(rpc, fakeWallet().wallet);
    await open();
    await type(/^Amount of ETH/, '1');
    expect(
      (within(screen.getByRole('dialog')).getByLabelText(/^Amount of USDC/) as HTMLInputElement)
        .value,
    ).toBe('3051.359516');
    expect(figure('You deposit')).toBe(
      '3051.359516 USDC + 0.999999999798019801 ETH (the ratio needs slightly less than was typed; the rest stays in your wallet)',
    );
    expect(figure('Minimum deposited')).toBe('3036.102718 USDC and 0.995 ETH (0.50% slippage)');
    expect(figure('Pool shares you receive')).toBe('0.000055171805874732');
    expect(figure('Your share of the pool after')).toBe('9.1491%');
    expect(figure('Read at')).toBe(
      'Confirmed block 1234; compared with one newer block (the head, read once) before your wallet is asked',
    );
    expect(figure('Deadline')).toBe('20 minutes after you confirm');
    // The risks are in the dialog, next to the action, not behind a click.
    expect(
      within(screen.getByRole('dialog')).getByRole('note', {
        name: 'Risks of providing liquidity',
      }),
    ).toBeTruthy();
    // Typing the token side instead gives the native amount of the ratio.
    await type(/^Amount of USDC/, '3000');
    expect(
      (within(screen.getByRole('dialog')).getByLabelText(/^Amount of ETH/) as HTMLInputElement)
        .value,
    ).toBe('0.983168316831683168');
  });

  it('asks first for an approval of exactly the token amount, and only that', async () => {
    const { rpc } = fakeChain();
    const { sent, wallet } = fakeWallet();
    mount(rpc, wallet);
    const user = await open();
    await type(/^Amount of ETH/, '1');
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('button', { name: 'Add liquidity' })).toBeNull();
    expect(screen.getByTestId('liquidity-next-step').textContent).toBe(
      'Step 1 of 2: Approve 3051.359516 USDC in your wallet. Last step: Add liquidity.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Approve 3051.359516 USDC' }));
    await waitFor(() => expect(sends(sent)).toBe(1));
    expect(sent[0].to).toBe(USDC);
    expect(sent[0].from.toLowerCase()).toBe(ACCOUNT);
    expect(sent[0].value).toBe('0x0');
    expect(sent[0].gas).toBe('0x186a0');
    expect(sent[0].chainId).toBe('0x1');
    expect(sent[0].nonce).toBe('0x7');
    // approve(router, 3051359516): the exact amount.
    expect(sent[0].data).toBe(
      `0x095ea7b3${ROUTER.slice(2).padStart(64, '0')}${3_051_359_516n.toString(16).padStart(64, '0')}`,
    );
    // The request is tracked by the route's tracker: the hold is on, and nothing else can be sent.
    const tracked = await within(dialog).findByRole('status', { name: 'Tracked transaction' });
    expect(tracked.textContent).toContain('Approve 3051.359516 USDC for liquidity: pending');
    expect(tracked.textContent).toContain('Do not resend with a new nonce');
    expect(
      (
        within(dialog).getByRole('button', {
          name: 'Approve 3051.359516 USDC',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('then sends the deposit through the native entry point with the figures on screen: amounts, minimums, recipient, deadline, gas', async () => {
    const { rpc } = fakeChain({ usdcAllowance: 3_051_359_516n });
    const { sent, wallet } = fakeWallet();
    mount(rpc, wallet);
    const user = await open();
    await type(/^Amount of ETH/, '1');
    const dialog = screen.getByRole('dialog');
    expect(screen.getByTestId('liquidity-next-step').textContent).toBe(
      'Next: Add liquidity opens your wallet with these figures.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Add liquidity' }));
    await waitFor(() => expect(sends(sent)).toBe(1));
    expect(sent[0].to).toBe(ROUTER);
    expect(BigInt(sent[0].value)).toBe(ONE);
    expect(BigInt(sent[0].gas)).toBe(400_000n);
    const call = decodeFunctionData({ abi: LIQUIDITY_ABI, data: sent[0].data as Hex });
    expect(call.functionName).toBe('addLiquidityBLCH');
    expect(call.args).toEqual([
      expect.stringMatching(new RegExp(USDC, 'i')),
      3_051_359_516n,
      3_036_102_718n,
      995_000_000_000_000_000n,
      expect.stringMatching(new RegExp(ACCOUNT, 'i')),
      BigInt(NOW_MS / 1000 + 20 * 60),
    ]);
    const tracked = await within(dialog).findByRole('status', { name: 'Tracked transaction' });
    expect(tracked.textContent).toContain(
      'Add liquidity: 3051.359516 USDC + 0.999999999798019801 ETH: pending',
    );
    // The router's own function name is never on screen.
    expect(document.body.textContent).not.toMatch(/BLCH/);
  });

  it('refuses, before anything is sent, an amount the pool cannot use, a balance that is short and a setting out of range', async () => {
    const { rpc } = fakeChain({ usdc: 100_000_000n });
    const { sent, wallet } = fakeWallet();
    mount(rpc, wallet);
    await open();
    const dialog = screen.getByRole('dialog');
    const primary = () => dialog.querySelector('button.primary') as HTMLButtonElement;
    await type(/^Amount of ETH/, '0.000000000000000001');
    expect(within(dialog).getByRole('alert').textContent).toContain('(BDEX: INSUFFICIENT_AMOUNT)');
    expect(primary().disabled).toBe(true);
    await type(/^Amount of ETH/, '1');
    expect(within(dialog).getByRole('alert').textContent).toBe(
      'Your confirmed USDC balance (100) is below the amount; the deposit would revert.',
    );
    expect(primary().disabled).toBe(true);
    await type(/^Amount of ETH/, '0.01');
    await type('Slippage tolerance (%)', '5');
    expect(within(dialog).getByRole('alert').textContent).toBe(
      'Use a slippage tolerance of 0.01% to 3.00%.',
    );
    expect(primary().disabled).toBe(true);
    await type('Slippage tolerance (%)', '0.5');
    await type('Deadline (minutes)', '5');
    expect(within(dialog).getByRole('alert').textContent).toBe(
      'Use a deadline of 10 to 180 minutes.',
    );
    expect(sends(sent)).toBe(0);
  });

  it('compares with the latest block before the wallet is asked: a ratio beyond the tolerance sends nothing', async () => {
    const { rpc } = fakeChain({
      usdcAllowance: 10n ** 12n,
      latestReserves: [27_000_000_000n, 11_111_111_111_111_111_111n],
    });
    const { sent, wallet, request } = fakeWallet();
    mount(rpc, wallet);
    const user = await open();
    await type(/^Amount of ETH/, '1');
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Add liquidity' }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('liquidity-note').textContent).toBe(
        "At the latest block: The pool's ratio has moved by more than your tolerance: the USDC side would be below its minimum and the deposit would revert (BDEX: INSUFFICIENT_A_AMOUNT). Nothing was sent. Refresh the page's figures and review the amounts again.",
      ),
    );
    expect(sends(sent)).toBe(0);
    expect(request.mock.calls.some(([c]) => c.method === 'eth_sendTransaction')).toBe(false);
    expect(screen.queryByRole('status', { name: 'Tracked transaction' })).toBeNull();
  });

  it('a rejection in the wallet sends nothing and leaves no hold', async () => {
    const { rpc } = fakeChain({ usdcAllowance: 10n ** 12n });
    const { wallet, request } = fakeWallet();
    request.mockImplementation(async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return '0x1';
      throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
    });
    mount(rpc, wallet);
    const user = await open();
    await type(/^Amount of ETH/, '1');
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Add liquidity' }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('liquidity-note').textContent).toBe(
        'The wallet request was rejected by you. Nothing was sent.',
      ),
    );
    expect(screen.queryByRole('status', { name: 'Tracked transaction' })).toBeNull();
    expect(
      (
        within(screen.getByRole('dialog')).getByRole('button', {
          name: 'Add liquidity',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
});

describe('the liquidity dialog and the age of the snapshot', () => {
  const realClock = { ...renewalClock };
  afterEach(() => Object.assign(renewalClock, realClock));

  it('never signs figures of a snapshot past the age bound: it reads a newer block first and asks again', async () => {
    let clock = 1_000_000;
    renewalClock.now = () => clock;
    renewalClock.wall = () => clock;
    const { rpc, state } = fakeChain({ usdcAllowance: 10n ** 12n });
    const { sent, wallet } = fakeWallet();
    render(
      <MainnetLive
        network={chain.network}
        load={() => Promise.resolve({ status: 'live', deployment })}
        rpc={rpc}
        wallet={wallet}
        planned={{ caps: [], pairs: [['WETH', 'USDC']] }}
        now={() => NOW_MS}
        snapshotMaxAgeMs={240_000}
        screens={{ base: '#/ethereum' }}
      />,
    );
    await goTo('Pools');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add liquidity to USDC/WETH' }));
    await within(await screen.findByRole('dialog')).findByLabelText(/^Amount of ETH/);
    await type(/^Amount of ETH/, '1');
    const snapshotReads = () =>
      state.calls.filter((c) => c.method === 'eth_getBlockByNumber' && c.params[0] === 'finalized')
        .length;
    const before = snapshotReads();
    clock += 240_001;
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Add liquidity' }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('liquidity-note').textContent).toBe(
        'These figures were older than this page allows before a transaction. They are being read again at a newer confirmed block; check them and press again.',
      ),
    );
    expect(sends(sent)).toBe(0);
    await waitFor(() => expect(snapshotReads()).toBeGreaterThan(before));
    // Fresh again: the same press now goes to the wallet.
    await waitFor(() =>
      expect(
        (
          within(screen.getByRole('dialog')).getByRole('button', {
            name: 'Add liquidity',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Add liquidity' }),
    );
    await waitFor(() => expect(sends(sent)).toBe(1));
  });
});

describe('the liquidity dialog and a block that changes under a request', () => {
  it('sends nothing when the page takes a newer block while the request is being prepared, and says so', async () => {
    const { rpc, state } = fakeChain({ usdcAllowance: 10n ** 12n });
    const { sent, wallet, request } = fakeWallet();
    let moved = false;
    request.mockImplementation(
      async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === 'eth_chainId') {
          if (!moved) {
            // While the wallet is asked which chain it is on, the page reads a newer block (its Refresh).
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
    await goTo('Pools');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add liquidity to USDC/WETH' }));
    await within(await screen.findByRole('dialog')).findByLabelText(/^Amount of ETH/);
    await type(/^Amount of ETH/, '1');
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Add liquidity' }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('liquidity-note').textContent).toBe(
        'The page read a newer confirmed block while the request was being prepared, so nothing was sent. Check the figures and press again.',
      ),
    );
    expect(sends(sent)).toBe(0);
    expect(screen.queryByRole('status', { name: 'Tracked transaction' })).toBeNull();
  });
});

describe('Portfolio and a removal', () => {
  const HELD = 55_171_805_874_732n;

  it('shows the position: shares, share of the pool and the two amounts at the pinned block', async () => {
    const { rpc } = fakeChain({ shares: 13_792_951_468_683n });
    mount(rpc, fakeWallet().wallet);
    await goTo('Portfolio');
    const position = await screen.findByRole('region', { name: 'Your position in USDC/WETH' });
    expect(position.textContent).toContain('Pool share2.5176%');
    expect(position.textContent).toContain('USDC762.839878');
    expect(position.textContent).toContain('WETH0.249999999949503047');
    expect(position.textContent).toContain('Pool shares0.000013792951468683');
    expect(position.textContent).toContain('Protocol fee dilutionIncluded in these amounts');
    expect(position.textContent).toContain(
      'Value in a currency, value historyNot available: this page has no reviewed price source and keeps no history',
    );
  });

  it('says so when the account holds no position, and without a wallet', async () => {
    const { rpc } = fakeChain();
    const first = mount(rpc, fakeWallet().wallet);
    await goTo('Portfolio');
    expect((await screen.findByText('No liquidity position on this network.')).tagName).toBe('H3');
    first.unmount();
    mount(rpc, fakeWallet(false).wallet);
    await goTo('Portfolio');
    expect(await screen.findByText('Connect a wallet to see your positions.')).toBeTruthy();
  });

  it('removes a share of the position: approval of exactly those shares, then the removal with its minimums', async () => {
    const chainState = fakeChain({ shares: HELD });
    const { sent, wallet } = fakeWallet();
    mount(chainState.rpc, wallet);
    await goTo('Portfolio');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Remove liquidity from USDC/WETH' }),
    );
    const dialog = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(figure('You receive')).toBe('762.839878 USDC + 0.249999999949503047 ETH'),
    );
    expect(figure('Minimum received')).toBe(
      '759.025678 USDC and 0.248749999949755531 ETH (0.50% slippage)',
    );
    expect(figure('Pool shares removed')).toBe('0.000013792951468683 of 0.000055171805874732');
    expect(dialog.textContent).toContain(
      'The first 1000 base units of shares of every pool were locked for ever when it opened',
    );
    await user.click(
      within(dialog).getByRole('button', {
        name: 'Approve 0.000013792951468683 USDC/WETH pool shares',
      }),
    );
    await waitFor(() => expect(sends(sent)).toBe(1));
    expect(sent[0].to).toBe(PAIR);
    expect(sent[0].data).toBe(
      `0x095ea7b3${ROUTER.slice(2).padStart(64, '0')}${13_792_951_468_683n.toString(16).padStart(64, '0')}`,
    );
  });

  it('removes everything at 100 percent through the native entry point', async () => {
    const { rpc } = fakeChain({ shares: HELD, sharesAllowance: HELD });
    const { sent, wallet } = fakeWallet();
    mount(rpc, wallet);
    await goTo('Portfolio');
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole('button', { name: 'Remove liquidity from USDC/WETH' }),
    );
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: '100%' }));
    await waitFor(() =>
      expect(figure('Pool shares removed')).toBe('0.000055171805874732 of 0.000055171805874732'),
    );
    expect(figure('Your share of the pool after')).toBe('0%');
    await user.click(within(dialog).getByRole('button', { name: 'Remove liquidity' }));
    await waitFor(() => expect(sends(sent)).toBe(1));
    const call = decodeFunctionData({ abi: LIQUIDITY_ABI, data: sent[0].data as Hex });
    expect(call.functionName).toBe('removeLiquidityBLCH');
    const amount0 = (HELD * 30_300_000_000n) / 547_856_032_446_749n;
    const amount1 = (HELD * 9_930_000_000_000_000_000n) / 547_856_032_446_749n;
    expect(call.args).toEqual([
      expect.stringMatching(new RegExp(USDC, 'i')),
      HELD,
      (amount0 * 9950n) / 10_000n,
      (amount1 * 9950n) / 10_000n,
      expect.stringMatching(new RegExp(ACCOUNT, 'i')),
      BigInt(NOW_MS / 1000 + 20 * 60),
    ]);
    expect(sent[0].value).toBe('0x0');
    expect(BigInt(sent[0].gas)).toBe(400_000n);
  });
});
