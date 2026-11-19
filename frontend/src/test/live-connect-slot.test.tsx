// Round 20 integration (agent 411): on the Pools and Portfolio screens the header's "Connect wallet" reaches the
// connect options themselves: the browser wallets the page found and whatever the site put into agent 410's
// connect slot (the mobile wallet), not a button that leads to the Trade screen first.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import MainnetLive from '../MainnetLive';
import type { Devnet4Wallet } from '../Devnet4Live';
import { ConnectSlotContext } from '../shell/connect-slot';
import type { Provider } from '../wallet';
import {
  chain,
  deployment,
  fakeChain,
  fakeWallet,
  goTo,
  NOW_MS,
  useLiveHarness,
} from './live-harness';

useLiveHarness();

const page = (wallet: Devnet4Wallet, slot: React.ReactNode) => {
  const { rpc } = fakeChain();
  return render(
    <ConnectSlotContext.Provider value={slot}>
      <MainnetLive
        network={chain.network}
        load={() => Promise.resolve({ status: 'live', deployment })}
        rpc={rpc}
        wallet={wallet}
        planned={{ caps: [], pairs: [['WETH', 'USDC']] }}
        now={() => NOW_MS}
        screens={{ base: '#/ethereum' }}
      />
    </ConnectSlotContext.Provider>,
  );
};
const option = { id: 'test', name: 'Test wallet', icon: '', provider: {} as Provider };

describe('the connect step of the Pools and Portfolio screens', () => {
  it.each(['Pools', 'Portfolio'])(
    '%s: offers the found wallets and the site’s connect slot; one press connects',
    async (name) => {
      const connect = vi.fn();
      const wallet = { ...fakeWallet(false).wallet, wallets: [option], connect } as Devnet4Wallet;
      const mobile = vi.fn();
      page(
        wallet,
        <button type="button" className="wallet-option" data-mobile-wallet onClick={mobile}>
          Connect a mobile wallet
        </button>,
      );
      await goTo(name);
      const view = document.querySelector(`[data-view="${name.toLowerCase()}"]`) as HTMLElement;
      // The header's wallet button takes the first connect step of the document and its first enabled button.
      const step = document.querySelector<HTMLElement>('[data-wallet-connect]')!;
      expect(view.contains(step)).toBe(true);
      const first = step.querySelector<HTMLElement>('button:not(:disabled)')!;
      expect(first.textContent).toBe(' Connect Test wallet');
      expect(within(step).queryByRole('button', { name: /on the Trade screen/ })).toBeNull();
      const user = userEvent.setup();
      await user.click(first);
      expect(connect).toHaveBeenCalledTimes(1);
      expect(connect).toHaveBeenCalledWith(option);
      await user.click(within(step).getByRole('button', { name: 'Connect a mobile wallet' }));
      expect(mobile).toHaveBeenCalledTimes(1);
      // Still on the same screen: nothing sent the user to Trade.
      expect(
        within(screen.getByRole('navigation', { name: 'Screens' }))
          .getByRole('link', { name })
          .getAttribute('aria-current'),
      ).toBe('page');
    },
  );

  it('with only the slot (no browser wallet), the slot’s button is the first thing the header reaches', async () => {
    page(
      fakeWallet(false).wallet,
      <button type="button" className="wallet-option" data-mobile-wallet>
        Connect a mobile wallet
      </button>,
    );
    await goTo('Pools');
    const step = document.querySelector<HTMLElement>('[data-wallet-connect]')!;
    expect(step.querySelector<HTMLElement>('button:not(:disabled)')!.textContent).toBe(
      'Connect a mobile wallet',
    );
  });

  it('shows the wallet’s own refusal where the user pressed', async () => {
    const wallet = {
      ...fakeWallet(false).wallet,
      wallets: [option],
      error: 'The wallet refused the connection.',
    } as Devnet4Wallet;
    page(wallet, null);
    await goTo('Pools');
    const step = document.querySelector<HTMLElement>('[data-wallet-connect]')!;
    expect(step.textContent).toContain('The wallet refused the connection.');
  });

  it('with no wallet and an empty slot it still leads to the route’s own connect step on Trade', async () => {
    page(fakeWallet(false).wallet, null);
    await goTo('Pools');
    expect(
      await screen.findByRole('button', { name: 'Connect a wallet on the Trade screen' }),
    ).toBeTruthy();
  });
});
