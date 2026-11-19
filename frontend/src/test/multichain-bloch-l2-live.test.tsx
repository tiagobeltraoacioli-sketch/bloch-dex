// The Bloch L2 route of the multichain site "Bloch DEX" with a live L2 (agent 415, round 20): a deployed record,
// a live RPC and a pinned genesis, over a fake chain whose pools have reserve caps. What the shell adds and what it
// must not: the L2's one endpoint read at `finalized`, none of the public chains' rules or screens, the wallet
// connections that work on chain 700770, and the L2 kept out of the mobile-wallet session.
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MultichainApplication } from '../MultichainApp';
import type { Devnet4Wallet } from '../Devnet4Live';
import type { Rpc } from '../devnet4/chain';
import { BLOCH_L2_WORDING, setWording } from '../mainnet/wording';
import {
  BlochL2Route,
  L2_MOBILE_SESSION_NOTE,
  L2_SCREENS_NOTE,
  L2_WALLET_NOTE,
} from '../multichain/BlochL2Route';
import { BLOCH_L2_SITE_WORDING, type BlochL2Entry } from '../multichain/bloch-l2';
import { bundledChains } from '../multichain/config';
import { mobileSessionProvider, normalizeApprovedMobileSession } from '../multichain/walletconnect';
import type { Provider } from '../wallet';
import { browserLocksForTest } from './browser-locks';
import { blochL2PolicyUrls } from '../multichain/headers';
import { BUSDC, fetchOver, L2_NOW_MS, L2_RPC_URL, liveL2Entry } from './bloch-l2-fixture';

const ACCOUNT = '0x72dc623d4c03c996a3d20ed2674f24570e8acf44';
const noWallet: Devnet4Wallet = {
  account: null,
  provider: null,
  wallets: [],
  pending: false,
  error: '',
  connect: () => {},
};
// The shell's wallet (useWallet.ts), set by each test.
const walletBox = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../useWallet', () => ({ useWallet: () => walletBox.current }));

let entry: BlochL2Entry;
let rpc: Rpc;
let calls: { method: string; params: unknown[] }[];
let urls: string[];

beforeAll(async () => {
  ({ entry, rpc, calls } = await liveL2Entry());
});
beforeEach(() => {
  Object.defineProperty(navigator, 'locks', { configurable: true, value: browserLocksForTest() });
  localStorage.clear();
  calls.length = 0;
  walletBox.current = noWallet;
  const over = fetchOver(rpc);
  urls = over.urls;
  vi.stubGlobal('fetch', over.fetch);
  vi.spyOn(Date, 'now').mockReturnValue(L2_NOW_MS);
  history.replaceState(null, '', '/#/bloch-l2');
});
afterEach(() => {
  cleanup();
  setWording({ ...BLOCH_L2_WORDING });
  vi.unstubAllGlobals();
});

/** A browser wallet on Ethereum that does not know chain 700770 until it is added. */
function injected() {
  let chainId = '0x1';
  const requests: { method: string; params?: unknown[] }[] = [];
  const provider: Provider = {
    async request({ method, params }) {
      requests.push({ method, params });
      if (method === 'eth_chainId') return chainId;
      if (method === 'wallet_switchEthereumChain')
        throw Object.assign(new Error('Unrecognized chain'), { code: 4902 });
      if (method === 'wallet_addEthereumChain') {
        chainId = (params![0] as { chainId: string }).chainId;
        return null;
      }
      throw new Error(`unexpected wallet call ${method}`);
    },
  };
  const wallet: Devnet4Wallet = {
    ...noWallet,
    account: { address: ACCOUNT, chainId: '0x1', name: 'Test wallet' },
    provider,
  };
  return { wallet, requests };
}

/** The site's mobile-wallet session as a wallet approves it on Base: agent 410's provider, unchanged. */
function mobileSession() {
  const request = vi.fn<(value: unknown) => Promise<unknown>>();
  const client = {
    on: vi.fn(),
    off: vi.fn(),
    disconnect: vi.fn().mockResolvedValue(undefined),
    request,
  };
  const approved = normalizeApprovedMobileSession(
    {
      topic: 'ab'.repeat(32),
      expiry: Math.floor(L2_NOW_MS / 1000) + 600,
      namespaces: {
        eip155: {
          accounts: [`eip155:8453:${ACCOUNT}`],
          chains: ['eip155:8453'],
          methods: ['eth_sendTransaction'],
          events: ['accountsChanged', 'chainChanged'],
        },
      },
      peer: { metadata: { name: 'Pocket' } },
    } as never,
    [8453],
    8453,
    Math.floor(L2_NOW_MS / 1000),
  )!;
  const provider = mobileSessionProvider(client as never, approved, [8453], 8453);
  const wallet: Devnet4Wallet = {
    ...noWallet,
    account: { address: ACCOUNT, chainId: '0x2105', name: 'Pocket' },
    provider,
  };
  return { wallet, request };
}

describe('the live Bloch L2 route in the multichain shell', () => {
  it('reads the L2’s one endpoint at its finalized block and shows the L2 page: caps, bridged assets, the L2’s words; none of a public chain’s rules', async () => {
    render(<MultichainApplication l2={entry} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Bloch DEX on Bloch L2');
    const strip = await screen.findByTestId('trust-strip');
    // The L2's reader: every request to the one endpoint of the L2 network file, the snapshot at `finalized`.
    expect(new Set(urls)).toEqual(new Set([L2_RPC_URL]));
    expect(
      calls.some((c) => c.method === 'eth_getBlockByNumber' && c.params[0] === 'finalized'),
    ).toBe(true);
    // Not the public chains' rule: no `safe` tag and no depth counted from the head.
    expect(calls.some((c) => c.method === 'eth_getBlockByNumber' && c.params[0] === 'safe')).toBe(
      false,
    );
    expect(calls.some((c) => c.method === 'eth_blockNumber')).toBe(false);
    // Reserve caps are on the page: the share of each cap in use, from the pair's own `reserveCaps()`.
    expect(strip.textContent).toMatch(/caps in use: \d+\.\d\d% · \d+\.\d\d%/);
    expect(calls.some((c) => c.method === 'eth_call')).toBe(true);
    expect(document.querySelector('.badge')!.textContent).toBe(
      'Bloch DEX on Bloch L2 · Chain 700770',
    );
    expect(document.body.textContent).toContain(
      'Pools, balances and quotes are read at the finalized L2 block',
    );
    expect(document.body.textContent).toContain(
      'Pools have fixed reserve caps; this is a guarded launch.',
    );
    expect(screen.getByLabelText('Bridges').textContent).toContain('bUSDC');
    expect(screen.getByLabelText('Network').textContent).toContain(
      'Bloch L2, chain ID 700770 (0xab162), native currency BLCH',
    );
    // The cap rules reach the quote: the share of the headroom a swap uses, and the cap among its revert reasons.
    const table = await screen.findByRole('table');
    expect(table.textContent).toContain('1000 bUSDC (0.55% used)');
    expect(table.textContent).toContain('994.428785 bUSDC more can flow in');
    const pointer = userEvent.setup();
    await pointer.selectOptions(screen.getByLabelText('You pay'), 'bUSDC');
    await pointer.selectOptions(screen.getByLabelText('You receive'), 'wGSMH');
    await pointer.type(screen.getByLabelText('Amount'), '1');
    await pointer.click(screen.getByRole('button', { name: 'Get quote' }));
    const quote = await screen.findByLabelText('Quote');
    expect(quote.textContent).toContain('Finalized block 440');
    expect(quote.textContent).toMatch(/bUSDC\/WBLCH: 0\.10% of the bUSDC headroom/);
    expect(screen.getByLabelText('Revert conditions').textContent).toContain('RESERVE_CAP');
    // Nothing of a public chain: no confirmation rule and its button, no token note, no Trade/Pools/Portfolio.
    expect(screen.queryByTestId('confirmation-rule')).toBeNull();
    expect(screen.queryByRole('button', { name: /Settlement rule of this network/ })).toBeNull();
    expect(screen.queryByTestId('token-note')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Screens' })).toBeNull();
    expect(document.querySelector('[data-view]')).toBeNull();
    expect(screen.queryByRole('button', { name: /Add liquidity|Remove liquidity/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/two endpoints|confirmed block/);
    // What the shell says about this route, above it.
    expect(screen.getByTestId('l2-screens-note').textContent).toBe(L2_SCREENS_NOTE);
    expect(screen.getByTestId('l2-wallet-note').textContent).toBe(L2_WALLET_NOTE);
    expect(screen.queryByTestId('l2-mobile-session-note')).toBeNull();
    // The site is active: one network is live, and the switcher says which.
    expect(screen.queryByTestId('not-active-banner')).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Bloch L2 · Chain 700770/ }));
    const rows = [...screen.getByRole('dialog', { name: 'Select network' }).querySelectorAll('li')];
    expect(rows.map((r) => r.textContent)).toEqual([
      ...bundledChains().map(
        (c) => `${c.network.chainName}Chain ${c.network.chainId} · Not yet live`,
      ),
      'Bloch L2Chain 700770 · Live',
    ]);
  });

  it('offers a browser wallet and not the mobile-wallet session: chain 700770 is never among the session’s networks', async () => {
    const connect = vi.fn();
    const option = { id: 'test', name: 'Test wallet', provider: {} as Provider };
    walletBox.current = { ...noWallet, wallets: [option], connect };
    render(<MultichainApplication l2={entry} />);
    await screen.findByTestId('trust-strip');
    const step = document.querySelector<HTMLElement>('[data-wallet-connect]')!;
    expect(step).not.toBeNull();
    expect(within(step).getByRole('button', { name: /Connect Test wallet/ })).toBeTruthy();
    // The L2 is live and is the page's network, yet the mobile-wallet button is not offered: the session is
    // asked for live PUBLIC networks only (MultichainApp.tsx `liveChains`), so this route is not among them.
    expect(document.querySelector('[data-mobile-wallet]')).toBeNull();
    expect(screen.queryByRole('button', { name: /Connect a mobile wallet/ })).toBeNull();
    expect(screen.queryByTestId('mobile-connect')).toBeNull();
    const user = userEvent.setup();
    await user.click(within(step).getByRole('button', { name: /Connect Test wallet/ }));
    expect(connect).toHaveBeenCalledExactlyOnceWith(option);
    // The header's "Connect wallet" leads to that step, as on every live route.
    expect(screen.getByTestId('wallet-unavailable').textContent).toBe('');
  });

  it('a browser wallet that does not know the chain is asked to switch, then to add Bloch L2 with the L2’s own parameters', async () => {
    const { wallet, requests } = injected();
    walletBox.current = wallet;
    render(<MultichainApplication l2={entry} />);
    await screen.findByTestId('trust-strip');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add or switch to Bloch L2' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Network').textContent).toContain(
        'Your wallet is on Bloch L2 (chain 700770).',
      ),
    );
    expect(requests.map((r) => r.method)).toEqual([
      'eth_chainId',
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
      'eth_chainId',
    ]);
    expect(requests[1].params).toEqual([{ chainId: '0xab162' }]);
    // One RPC URL (the L2's), BLCH, and the one explorer the L2 network file publishes (since 2026-11-19; none
    // was given while the file had none): never a public chain's endpoint list.
    expect(requests[2].params).toEqual([
      {
        chainId: '0xab162',
        chainName: 'Bloch L2',
        nativeCurrency: { name: 'Bloch', symbol: 'BLCH', decimals: 18 },
        rpcUrls: [L2_RPC_URL],
        blockExplorerUrls: ['https://blochl1.com/l2'],
      },
    ]);
  });
});

describe('the bridge hold of the Bloch L2 in the multichain shell', () => {
  it('is read as on the Bloch L2 site, from the Ethereum RPC of the network file’s status block, and the policy names exactly the endpoints contacted', async () => {
    const ethRpcUrl = 'https://ethereum-rpc.example.invalid';
    const held = await liveL2Entry((files) => {
      files.network.bridges[0].status = {
        ethRpcUrl,
        vault: `0x${'11'.repeat(20)}`,
        token: BUSDC,
        vaultCodeHash: `0x${'33'.repeat(32)}`,
      };
    });
    // An "Ethereum" endpoint that serves another chain: the hold cannot be checked, and the page says so.
    const eth = vi.fn(async (method: string) => {
      if (method === 'eth_chainId') return '0x2';
      throw new Error(`unexpected ${method}`);
    });
    const over = fetchOver(held.rpc, { [ethRpcUrl]: eth });
    vi.stubGlobal('fetch', over.fetch);
    render(<MultichainApplication l2={held.entry} />);
    await screen.findByTestId('trust-strip');
    const status = await screen.findByLabelText('Bridge exit status');
    expect(status.textContent).toBe(
      'Whether bUSDC can leave to Ethereum could not be checked (the Ethereum RPC serves another chain). Check the bridge page before you buy bUSDC or remove liquidity from a bUSDC pool.',
    );
    expect(eth).toHaveBeenCalledWith('eth_chainId', []);
    // What the route contacted is what `connect-src` gains for a live L2, origin for origin: no more, no less.
    const contacted = new Set(over.urls.map((u) => new URL(u).origin));
    const named = new Set(
      blochL2PolicyUrls(held.files.network, held.files.record).map((u) => new URL(u).origin),
    );
    expect(contacted).toEqual(new Set([L2_RPC_URL, ethRpcUrl]));
    expect(named).toEqual(contacted);
  });
});

describe('a mobile-wallet session on the Bloch L2 route', () => {
  const page = (wallet: Devnet4Wallet, session: boolean) => {
    setWording(BLOCH_L2_SITE_WORDING);
    return render(<BlochL2Route entry={entry} wallet={wallet} live mobileSession={session} />);
  };

  it('is told plainly that it cannot be used here; the switch is refused in the page and nothing reaches the wallet', async () => {
    const { wallet, request } = mobileSession();
    page(wallet, true);
    await screen.findByTestId('trust-strip');
    expect(screen.getByTestId('l2-mobile-session-note').textContent).toBe(L2_MOBILE_SESSION_NOTE);
    expect(screen.getByTestId('l2-mobile-session-note').getAttribute('role')).toBe('status');
    expect(screen.queryByTestId('l2-wallet-note')).toBeNull();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add or switch to Bloch L2' }));
    // Agent 410's rule, unchanged: 4902 for the switch, then the add is refused with 4901 inside the page.
    await waitFor(() =>
      expect(screen.getByLabelText('Network').textContent).toContain(
        'This wallet session does not include chain 700770, and a network cannot be added to an open session.',
      ),
    );
    expect(request).not.toHaveBeenCalled();
    // The same when the user goes on to a transaction: the route asks for the chain first, the session refuses in
    // the page, and neither an approval nor a swap is sent to the wallet.
    await user.selectOptions(screen.getByLabelText('You pay'), 'bUSDC');
    await user.selectOptions(screen.getByLabelText('You receive'), 'wGSMH');
    await user.type(screen.getByLabelText('Amount'), '1');
    await user.click(screen.getByRole('button', { name: 'Get quote' }));
    await screen.findByLabelText('Quote');
    await user.click(await screen.findByRole('button', { name: /Approve 1 bUSDC/ }));
    await waitFor(() =>
      expect(document.querySelector('.live-hero')!.textContent).toContain(
        'This wallet session does not include chain 700770',
      ),
    );
    expect(request).not.toHaveBeenCalled();
    expect(calls.some((c) => c.method === 'eth_sendRawTransaction')).toBe(false);
    // The session stays on its own network: the page's wallet is still on Base.
    expect(await wallet.provider!.request({ method: 'eth_chainId' })).toBe('0x2105');
  });

  it('without a session the route names the connection that works, and without a live record it says neither', async () => {
    const live = page(noWallet, false);
    await screen.findByTestId('trust-strip');
    expect(screen.getByTestId('l2-wallet-note').textContent).toBe(L2_WALLET_NOTE);
    expect(L2_WALLET_NOTE).toContain('Connect a browser wallet here');
    expect(L2_WALLET_NOTE).toContain('(WalletConnect) is not offered on this network');
    live.unmount();
    await act(async () => {
      render(<BlochL2Route entry={entry} wallet={noWallet} live={false} mobileSession={false} />);
    });
    expect(screen.queryByTestId('l2-route-notes')).toBeNull();
  });
});
