// The multichain SHELL with both kinds of network live in one build (review R416-1, round 20): the mobile-wallet
// session opened on a public route, then the Bloch L2 route, then back; and the Bloch-words guard of the public
// routes while only the Bloch L2 is live. Written by reviewer 416 as an untracked test that showed the defect
// (two statements on the L2 route that contradicted each other); taken into the suite by agent 440 with the
// assertions of the fix: on the L2 route the page holds ONE statement about what the mobile wallet does there,
// and the control that ends the session stays.
// MainnetLive is replaced by a stub that shows the shell's connect slot, so what is asserted is
// MultichainApp.tsx's own composition.
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MultichainApplication } from '../MultichainApp';
import { BLOCH_L2_WORDING, setWording, wording } from '../mainnet/wording';
import { MOBILE_SESSION_CONNECTED, MOBILE_SESSION_NOTE } from '../multichain/MobileWalletConnect';
import { L2_MOBILE_SESSION_NOTE } from '../multichain/BlochL2Route';
import { blochL2Entry } from '../multichain/bloch-l2';
import { bundledChains } from '../multichain/config';
import type { MobileWalletRequest } from '../multichain/walletconnect';

const connectMobileWallet = vi.hoisted(() => vi.fn());
vi.mock('../multichain/walletconnect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../multichain/walletconnect')>()),
  connectMobileWallet,
}));
vi.mock('../MainnetLive', async () => {
  const { ConnectSlot } = await import('../shell/connect-slot');
  return {
    default: (props: { network: { chainId: number } }) => (
      <div data-testid="route" data-chain={props.network.chainId}>
        <ConnectSlot />
      </div>
    ),
  };
});
vi.mock('../useWallet', async () => {
  const { useState } = await import('react');
  return {
    useWallet: () => {
      const [provider, setProvider] = useState<unknown>(null);
      return {
        wallets: [],
        account: provider
          ? {
              address: '0x72dc623d4c03c996a3d20ed2674f24570e8acf44',
              chainId: '0x2105',
              name: 'Pocket',
            }
          : null,
        provider,
        pending: false,
        error: '',
        connect: async (option: { provider: unknown }) => setProvider(() => option.provider),
        disconnect: () => setProvider(null),
      };
    },
  };
});

afterEach(() => {
  setWording({ ...BLOCH_L2_WORDING });
  connectMobileWallet.mockReset();
});
const go = (hash: string) =>
  act(async () => {
    history.replaceState(null, '', `/${hash}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
const LIVE = { status: 'live', deployment: {} } as never;
const liveBase = () => ({
  ...bundledChains().find((c) => c.key === 'base')!,
  load: async () => LIVE,
});
const liveL2 = () => ({ ...blochL2Entry(), load: async () => LIVE });

describe('a mobile-wallet session opened on a public route, then the Bloch L2 route (R416-1)', () => {
  it('the session is asked for the public network only; on the L2 route the page says once what the mobile wallet does there (nothing), keeps the Disconnect control, and the public route gets its full line back', async () => {
    const user = userEvent.setup();
    const request = vi.fn();
    const disconnect = vi.fn();
    const requests: MobileWalletRequest[] = [];
    connectMobileWallet.mockImplementation(async (r: MobileWalletRequest) => {
      requests.push(r);
      return { id: 'postern-walletconnect', name: 'Pocket', provider: { request, disconnect } };
    });
    history.replaceState(null, '', '/#/base');
    render(<MultichainApplication chains={[liveBase()]} l2={liveL2()} />);
    await user.click(await screen.findByRole('button', { name: /Connect a mobile wallet/ }));
    await screen.findByTestId('mobile-session');
    // The Bloch L2 is live in this build and still is not among the session's networks.
    expect(requests).toHaveLength(1);
    expect(requests[0].chainIds).toEqual([8453]);
    expect(requests[0].routeChainId).toBe(8453);
    // On the public route: the whole line, as before (agent 410's words).
    const FULL =
      'Connected to a mobile wallet through WalletConnect. After you press Approve or Swap here, open the wallet app to confirm there. Disconnect the mobile wallet';
    expect(MOBILE_SESSION_NOTE.startsWith(`${MOBILE_SESSION_CONNECTED} `)).toBe(true);
    expect(screen.getByTestId('mobile-session').textContent).toBe(FULL);

    await go('#/bloch-l2');
    expect(screen.getByTestId('route').getAttribute('data-chain')).toBe('700770');
    expect(wording.quiet).toBe('idle-l2');
    // No mobile-wallet button on the L2 route.
    expect(document.querySelector('[data-mobile-wallet]')).toBeNull();
    // The shell's line: that a mobile wallet is connected, and the control that ends the session; NOT the
    // instruction to confirm an Approve or a Swap in the wallet app, which is false on this route.
    const shell = screen.getByTestId('mobile-session');
    expect(shell.textContent).toBe(
      'Connected to a mobile wallet through WalletConnect. Disconnect the mobile wallet',
    );
    // The route's notice: the one statement of what the mobile wallet does on this page.
    const routeLine = screen.getByTestId('l2-mobile-session-note').textContent!;
    expect(routeLine).toBe(L2_MOBILE_SESSION_NOTE);
    expect(routeLine).toContain('Nothing is sent to the mobile wallet from this page.');
    // One statement on the whole page: nowhere does it tell the user to confirm something in the wallet app.
    const page = document.body.textContent!;
    expect(page).not.toContain('After you press Approve or Swap here');
    expect(page).not.toContain('open the wallet app to confirm');
    expect(page.split('cannot be used on Bloch L2')).toHaveLength(2);
    expect(page.split('Connected to a mobile wallet through WalletConnect.')).toHaveLength(2);
    // Order on the page: the shell's line first, then the route's.
    expect(
      shell.compareDocumentPosition(screen.getByTestId('l2-mobile-session-note')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Nothing reached the wallet and the session was not closed by the route change.
    expect(request).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();

    await go('#/base');
    expect(screen.getByTestId('route').getAttribute('data-chain')).toBe('8453');
    expect(wording.quiet).toBe('stale-rpc');
    expect(screen.getByTestId('mobile-session').textContent).toBe(FULL);
    expect(screen.queryByTestId('l2-mobile-session-note')).toBeNull();
    expect(disconnect).not.toHaveBeenCalled();
    expect(connectMobileWallet).toHaveBeenCalledTimes(1);

    // The control the route's notice tells the user to use ("Disconnect it …") is on the L2 route and works there.
    await go('#/bloch-l2');
    await user.click(screen.getByRole('button', { name: 'Disconnect the mobile wallet' }));
    expect(screen.queryByTestId('mobile-session')).toBeNull();
    expect(screen.queryByTestId('l2-mobile-session-note')).toBeNull();
    // With no session the route says which connection works here instead.
    expect(screen.getByTestId('l2-wallet-note')).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
  });

  it('with only the Bloch L2 live, a public route keeps the Bloch-words guard and loses the "not active" line; the switcher row says Live', async () => {
    const user = userEvent.setup();
    history.replaceState(null, '', '/#/ethereum');
    render(<MultichainApplication l2={liveL2()} />);
    await waitFor(() => expect(screen.queryByTestId('not-active-banner')).toBeNull());
    await screen.findByTestId('route');
    for (const chain of bundledChains()) {
      await go(`#/${chain.key}`);
      await user.click(
        screen.getByRole('button', {
          name: new RegExp(`${chain.network.chainName} · Chain ${chain.network.chainId}`),
        }),
      );
      const copy = document.body.cloneNode(true) as HTMLElement;
      const named = [...copy.querySelectorAll('a[href="#/bloch-l2"]')];
      expect(named.map((a) => a.textContent)).toEqual(['Bloch L2', 'Bloch L2Chain 700770 · Live']);
      for (const a of named) a.remove();
      expect(copy.textContent!.replaceAll('Bloch DEX', ''), chain.key).not.toMatch(
        /Bloch|BLCH|bUSDC|L2|700770/,
      );
      expect(document.title).toBe(`Bloch DEX — ${chain.network.chainName}`);
      await user.keyboard('{Escape}');
      // The header's "Connect wallet" on a public route that is not live, while the L2 is: names this network only.
      await user.click(screen.getByRole('button', { name: 'Connect wallet' }));
      expect(screen.getByTestId('wallet-unavailable').textContent).toBe(
        `Connecting a wallet becomes available when ${chain.network.chainName} is live on Bloch DEX. Nothing was asked of any wallet.`,
      );
    }
  });
});
