// The multichain site's mobile-wallet connect step (src/multichain/MobileWalletConnect.tsx) and the header's
// "Connect wallet" (src/shell/WalletStatus.tsx): what the user sees, and that nothing is loaded before the press.
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MOBILE_CONNECT_FAILED,
  MOBILE_CONNECT_UNSUPPORTED,
  useMobileWalletConnect,
  type MobileConnectChain,
} from '../multichain/MobileWalletConnect';
import { ConnectSlot, ConnectSlotContext } from '../shell/connect-slot';
import { CONNECT_STEP_MISSING, WalletStatus } from '../shell/WalletStatus';
import type { MobileWalletRequest } from '../multichain/walletconnect';
import type { WalletOption } from '../wallet';

const connectMobileWallet = vi.hoisted(() => vi.fn());
vi.mock('../multichain/walletconnect', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../multichain/walletconnect')>()),
  connectMobileWallet,
}));

const URI = `wc:${'cd'.repeat(32)}@2?relay-protocol=irn&symKey=${'ef'.repeat(32)}`;
const BASE = { chainId: 8453, name: 'Base' };
const LIVE = [{ chainId: 1, name: 'Ethereum' }, BASE];
const OPTION: WalletOption = {
  id: 'postern-walletconnect',
  name: 'Pocket',
  provider: { request: async () => null, disconnect: vi.fn() },
};

function Harness({
  connect,
  chains = LIVE,
  route = BASE,
  pending = false,
}: {
  connect: (option: WalletOption) => Promise<void> | void;
  chains?: MobileConnectChain[];
  route?: MobileConnectChain;
  pending?: boolean;
}) {
  const mobile = useMobileWalletConnect({ wallet: { pending, connect }, chains, route });
  return (
    <>
      <ConnectSlotContext.Provider value={mobile.button}>
        <div data-wallet-connect>
          <ConnectSlot />
        </div>
      </ConnectSlotContext.Provider>
      {mobile.dialog}
    </>
  );
}
/** A pairing that shows its code and then waits for `finish`. */
function pairing() {
  let finish!: (option: WalletOption) => void;
  let fail!: (error: Error) => void;
  const requests: MobileWalletRequest[] = [];
  connectMobileWallet.mockImplementation((request: MobileWalletRequest) => {
    requests.push(request);
    request.onUri(URI);
    return new Promise<WalletOption>((resolve, reject) => {
      finish = resolve;
      fail = reject;
    });
  });
  return { requests, finish: (o = OPTION) => finish(o), fail: (e: Error) => fail(e) };
}
const agent = (value: string) => vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(value);
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

beforeEach(() => {
  connectMobileWallet.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('mobile-wallet connect step', () => {
  it('loads nothing until pressed; then shows a QR code drawn by the page, a copyable link and what is asked', async () => {
    const user = userEvent.setup();
    const { requests, finish } = pairing();
    const connect = vi.fn();
    render(<Harness connect={connect} />);
    const button = screen.getByRole('button', { name: /Connect a mobile wallet/ });
    expect(button.textContent).toContain('QR code or wallet app · WalletConnect');
    expect(connectMobileWallet).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();

    await user.click(button);
    const dialog = await screen.findByRole('dialog', { name: 'Connect a mobile wallet' });
    const code = await within(dialog).findByRole('img', {
      name: 'QR code that connects a mobile wallet to this page',
    });
    // An image built in the page (a data: URL of an SVG): no request to a QR service.
    const src = code.getAttribute('src')!;
    expect(src.startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(atob(src.split(',')[1])).toMatch(
      /^<svg viewBox="0 0 \d+ \d+" xmlns="http:\/\/www.w3.org\/2000\/svg"><path d="M/,
    );
    expect(within(dialog).getByRole('button', { name: 'Copy connection link' })).toBeTruthy();
    expect(within(dialog).getByRole('status').textContent).toBe(
      'Waiting for the wallet to approve…',
    );
    expect(dialog.textContent).toContain(
      'The wallet is asked for one thing: to show you this page’s transactions for confirmation, on Ethereum, Base. It is not asked to sign messages, and nothing is sent without your confirmation in the wallet. This page keeps reading the network from its own endpoints, not from the wallet.',
    );
    // A desktop browser: the code, no app links.
    expect(within(dialog).queryByRole('link')).toBeNull();
    expect(dialog.textContent).not.toMatch(/Bloch|BLCH|bUSDC|Postern/);
    expect(requests).toHaveLength(1);
    expect(requests[0].chainIds).toEqual([1, 8453]);
    expect(requests[0].routeChainId).toBe(8453);
    expect(requests[0].signal.aborted).toBe(false);
    // While a pairing is open the button cannot start a second one.
    expect((button as HTMLButtonElement).disabled).toBe(true);

    await act(async () => finish());
    await waitFor(() => expect(connect).toHaveBeenCalledExactlyOnceWith(OPTION));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(OPTION.provider.disconnect).not.toHaveBeenCalled();
  });

  it('on a phone the wallet app links come first: the wc: link, then three fixed wallet hosts in a new tab', async () => {
    agent(IPHONE);
    const user = userEvent.setup();
    pairing();
    render(<Harness connect={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /Connect a mobile wallet/ }));
    const dialog = await screen.findByRole('dialog');
    const links = await within(dialog).findAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual([
      'Open in a wallet app',
      'MetaMask',
      'Trust Wallet',
      'Rainbow',
    ]);
    expect(links[0].getAttribute('href')).toBe(URI);
    expect(links[0].hasAttribute('target')).toBe(false);
    const encoded = encodeURIComponent(URI);
    expect(links.slice(1).map((l) => l.getAttribute('href'))).toEqual([
      `https://metamask.app.link/wc?uri=${encoded}`,
      `https://link.trustwallet.com/wc?uri=${encoded}`,
      `https://rnbwapp.com/wc?uri=${encoded}`,
    ]);
    for (const link of links) {
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link.getAttribute('referrerpolicy')).toBe('no-referrer');
    }
    for (const link of links.slice(1)) expect(link.getAttribute('target')).toBe('_blank');
    // The code is still there, for a wallet on another device, after the links.
    const code = within(dialog).getByRole('img');
    expect(links[3].compareDocumentPosition(code) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(dialog.textContent).toContain('Or scan this code with a wallet on another device:');
  });

  it('Cancel, the close button and leaving the page cancel the pairing', async () => {
    const user = userEvent.setup();
    const { requests } = pairing();
    const view = render(<Harness connect={vi.fn()} />);
    const open = async () => {
      await user.click(screen.getByRole('button', { name: /Connect a mobile wallet/ }));
      return screen.findByRole('dialog');
    };
    await user.click(within(await open()).getByRole('button', { name: 'Cancel' }));
    expect(requests[0].signal.aborted).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(within(await open()).getByRole('button', { name: 'Close dialog' }));
    expect(requests[1].signal.aborted).toBe(true);
    await open();
    expect(requests[2].signal.aborted).toBe(false);
    // Another network's page: the pairing was for the page it was started on.
    view.rerender(<Harness connect={vi.fn()} route={{ chainId: 1, name: 'Ethereum' }} />);
    expect(requests[2].signal.aborted).toBe(true);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await open();
    view.unmount();
    expect(requests[3].signal.aborted).toBe(true);
  });

  it('a session that arrives after Cancel is closed, not connected', async () => {
    const user = userEvent.setup();
    const { finish } = pairing();
    const connect = vi.fn();
    const disconnect = vi.fn();
    render(<Harness connect={connect} />);
    await user.click(screen.getByRole('button', { name: /Connect a mobile wallet/ }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );
    await act(async () =>
      finish({ ...OPTION, provider: { request: async () => null, disconnect } }),
    );
    await waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
    expect(connect).not.toHaveBeenCalled();
  });

  it('says why a refused session was not connected, and lets the user try again', async () => {
    const user = userEvent.setup();
    const { fail, requests } = pairing();
    const connect = vi.fn();
    render(<Harness connect={connect} />);
    await user.click(screen.getByRole('button', { name: /Connect a mobile wallet/ }));
    const dialog = await screen.findByRole('dialog');
    await act(async () => fail(new Error('Wallet returned an unsupported session')));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(MOBILE_CONNECT_UNSUPPORTED);
    expect(within(dialog).queryByRole('img')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Try again' }));
    await within(dialog).findByRole('img');
    expect(requests).toHaveLength(2);
    await act(async () => fail(new Error('Proposal expired')));
    expect((await within(dialog).findByRole('alert')).textContent).toBe(MOBILE_CONNECT_FAILED);
    expect(connect).not.toHaveBeenCalled();
  });

  it('offers nothing on a page whose network is not among the live ones, or while another connection is pending', () => {
    const view = render(<Harness connect={vi.fn()} chains={[{ chainId: 1, name: 'Ethereum' }]} />);
    expect(screen.queryByRole('button', { name: /Connect a mobile wallet/ })).toBeNull();
    view.rerender(<Harness connect={vi.fn()} chains={[]} />);
    expect(screen.queryByRole('button', { name: /Connect a mobile wallet/ })).toBeNull();
    view.rerender(<Harness connect={vi.fn()} pending />);
    expect(
      (screen.getByRole('button', { name: /Connect a mobile wallet/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(connectMobileWallet).not.toHaveBeenCalled();
  });
});

describe('header "Connect wallet"', () => {
  const status = (unavailable?: string) =>
    render(
      <WalletStatus
        wallet={{ account: null, pending: false }}
        chainId={8453}
        chainName="Base"
        unavailable={unavailable}
      />,
    );
  it('on a page without a connect step it says so in a status region, and Escape or a press elsewhere puts it away', async () => {
    const user = userEvent.setup();
    status(
      'Connecting a wallet becomes available when Base is live on Bloch DEX. Nothing was asked of any wallet.',
    );
    const region = screen.getByRole('status');
    // The live region is in the document before it speaks, and is empty.
    expect(region.textContent).toBe('');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.className).toBe('wallet-unavailable-idle');
    const button = screen.getByRole('button', { name: 'Connect wallet' });
    await user.click(button);
    expect(region.textContent).toBe(
      'Connecting a wallet becomes available when Base is live on Bloch DEX. Nothing was asked of any wallet.',
    );
    expect(region.className).toBe('popover-panel popover-end wallet-unavailable');
    expect(button.getAttribute('aria-describedby')).toBe(region.id);
    await user.keyboard('{Escape}');
    expect(region.textContent).toBe('');
    await user.click(button);
    expect(region.textContent).not.toBe('');
    await user.click(document.body);
    expect(region.textContent).toBe('');
  });
  it('without the site’s reason it still answers', async () => {
    const user = userEvent.setup();
    status();
    await user.click(screen.getByRole('button', { name: 'Connect wallet' }));
    expect(screen.getByRole('status').textContent).toBe(CONNECT_STEP_MISSING);
  });
  it('with a connect step on the page it goes there, to its first usable button, and says nothing', async () => {
    const user = userEvent.setup();
    const step = document.createElement('div');
    step.setAttribute('data-wallet-connect', '');
    step.innerHTML = '<button disabled>Connect A</button><button>Connect a mobile wallet</button>';
    step.scrollIntoView = vi.fn();
    document.body.append(step);
    status('unused');
    await user.click(screen.getByRole('button', { name: 'Connect wallet' }));
    expect(step.scrollIntoView).toHaveBeenCalledOnce();
    expect(document.activeElement?.textContent).toBe('Connect a mobile wallet');
    expect(screen.getByRole('status').textContent).toBe('');
    step.remove();
  });
});
