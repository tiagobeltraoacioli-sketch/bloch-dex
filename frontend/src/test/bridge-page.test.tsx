// The bridge route as it is published today: every address is TBD-deploy, so every network renders as not live,
// nothing is read from any chain and the wallet is asked nothing. What protects a user is on the page without a click.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import bundle from '@postern/bridge-bundle';
import BridgePage from '../bridge/BridgePage';
import { WrappedTokenList } from '../bridge/BridgeParts';
import { parseBridgeBundle } from '../bridge/config';
import { bundledNetwork } from '../mainnet/config';

const config = parseBridgeBundle(bundle, false);
const network = bundledNetwork();
const liveL2 = { ...network, rpcLive: true, genesisHash: `0x${'11'.repeat(32)}` as const };

function setup(net = network) {
  const rpc = vi.fn(async () => {
    throw new Error('the page must not read the chain for a route that is not live');
  });
  const request = vi.fn();
  const fetchImpl = vi.fn(async () => {
    throw new Error('the page must not read a source network for a route that is not live');
  });
  const wallet = {
    wallets: [],
    account: { address: '0x99ee0a068b17de102c3ef986247615e07996823f', chainId: '0xab162', name: 'Test wallet' },
    provider: { request },
    pending: false,
    error: '',
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  history.replaceState(null, '', '/#/bridge');
  const view = render(<BridgePage config={config} network={net} rpc={rpc} wallet={wallet as never} fetchImpl={fetchImpl as never} />);
  return { rpc, request, fetchImpl, view };
}
const choose = (name: RegExp) => fireEvent.click(screen.getByRole('radio', { name }));

describe('the bridge route with nothing deployed', () => {
  it('lists the nine networks with their state, and not BNB Smart Chain', () => {
    setup();
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/Ethereum.*USDC.*Not live/),
      expect.stringMatching(/Arbitrum One.*Not live/),
      expect.stringMatching(/OP Mainnet.*Not live/),
      expect.stringMatching(/Linea.*Not live/),
      expect.stringMatching(/Base.*Not available yet/),
      expect.stringMatching(/Bitcoin.*BTC.*Not live/),
      expect.stringMatching(/Solana.*Not live/),
      expect.stringMatching(/TRON.*USDT.*Not live/),
      expect.stringMatching(/Stellar.*Not live/),
    ]);
    expect(document.body.textContent).not.toMatch(/BNB/);
  });
  it('for every network and both directions: says not live with the reasons, offers no action, reads nothing, asks the wallet nothing', () => {
    const { rpc, request, fetchImpl } = setup(liveL2);
    for (const entry of config.entries) {
      choose(new RegExp(`^${entry.name}`));
      for (const direction of ['Deposit', 'Exit']) {
        fireEvent.click(screen.getByRole('button', { name: direction }));
        fireEvent.change(screen.getByRole('textbox', { name: /Amount of/ }), { target: { value: '100' } });
        const state = screen.getByTestId('route-state');
        if (entry.id === 'base') expect(state.textContent).toMatch(/not available yet.*51 seconds.*no address is shown/s);
        else expect(state.textContent).toMatch(/not live.*builds no transaction, shows no deposit address and asks your wallet nothing.*not deployed/s);
        expect(screen.queryByTestId('bridge-action')).toBeNull();
        expect(screen.queryByTestId('exit-send')).toBeNull();
        expect(screen.queryByTestId('deposit-send')).toBeNull();
        expect(screen.queryByTestId('bridge-activity')).toBeNull();
      }
    }
    expect(rpc).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    // 20 full renders of the route (10 networks x 2 directions) in one synchronous test: about 2 s unloaded, 17 s on
    // the shared Mac at load 380 (agent 363, 2026-11-17). The timeout is raised; no assertion changed.
  }, 60_000);
  it('says the L2 itself is not published while it is not', () => {
    setup();
    expect(screen.getByTestId('route-state').textContent).toMatch(/public RPC of the Bloch L2 is not published yet/);
  });
  it('shows fees, limits, waits and risks without a click, before any amount', () => {
    setup();
    choose(/^TRON/);
    fireEvent.click(screen.getByRole('button', { name: 'Exit' }));
    const quote = screen.getByTestId('bridge-quote').textContent!;
    expect(quote).toMatch(/Bridge fee0\.05% of the amount/);
    expect(quote).toMatch(/Fixed release fee13 USDT on every exit/);
    expect(screen.getByTestId('bridge-limits').textContent).toMatch(/Smallest exit65 bUSDT\.trx/);
    expect(screen.getByTestId('bridge-waits').textContent).toMatch(/Finalized L2 block.*Signatures and payment on TRON/s);
    const risks = screen.getByTestId('bridge-risks');
    expect(risks.textContent).toMatch(/Tether can freeze USDT/);
    expect(risks.textContent).toMatch(/bUSDT\.trx is not USDT/);
    expect(risks.textContent).toMatch(/not audited/);
    // Nothing of it sits in a closed disclosure.
    expect(risks.querySelector('details')).toBeNull();
    expect(within(risks).queryAllByRole('button')).toHaveLength(0);
  });
  it('computes what is received as the amount is typed, with every fee on its own line', () => {
    setup();
    choose(/^TRON/);
    fireEvent.click(screen.getByRole('button', { name: 'Exit' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Amount of bUSDT.trx/ }), { target: { value: '100' } });
    expect(screen.getByTestId('bridge-receive').textContent).toBe('86.95');
    const quote = screen.getByTestId('bridge-quote').textContent!;
    expect(quote).toMatch(/You burn on the Bloch L2100 bUSDT\.trx/);
    expect(quote).toMatch(/Bridge fee \(0\.05%\)− 0\.05 USDT/);
    expect(quote).toMatch(/Fixed release fee− 13 USDT/);
    expect(quote).toMatch(/You receive on TRON86\.95 USDT/);
    fireEvent.change(screen.getByRole('textbox', { name: /Amount of bUSDT.trx/ }), { target: { value: '10' } });
    expect(screen.getByTestId('bridge-receive').textContent).toBe('—');
    expect(screen.getByTestId('bridge-quote').textContent).toMatch(/The smallest exit is 65 bUSDT\.trx/);
    fireEvent.change(screen.getByRole('textbox', { name: /Amount of bUSDT.trx/ }), { target: { value: '1e3' } });
    expect(document.body.textContent).toMatch(/Enter the amount as a number with at most 6 decimals/);
  });
  it('Bitcoin: the miner charge follows the fee rate the user names, and the received amount is a floor', () => {
    setup();
    choose(/^Bitcoin/);
    fireEvent.click(screen.getByRole('button', { name: 'Exit' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Amount of bBTC/ }), { target: { value: '0.05' } });
    expect(screen.getByTestId('bridge-quote').textContent).toMatch(/Name the highest Bitcoin fee rate you accept/);
    fireEvent.change(screen.getByRole('textbox', { name: /Highest Bitcoin fee rate you accept/ }), { target: { value: '60' } });
    const quote = screen.getByTestId('bridge-quote').textContent!;
    expect(quote).toMatch(/Miner charge, at most \(60 sat\/vB\)− 0\.0002412 BTC/);
    expect(quote).toMatch(/No signer pays your exit in a transaction above 60 sat\/vB: while the market is above it, the exit waits/);
    expect(quote).toMatch(/You receive on Bitcoin, at least/);
    expect(document.body.textContent).toMatch(/To Bitcoin, at least/);
  });
  it('lists each wrapped token as its own asset, with its true name and "Not deployed"', () => {
    setup();
    const list = screen.getByTestId('wrapped-tokens');
    const rows = within(list).getAllByRole('listitem').map((li) => li.textContent);
    expect(rows).toHaveLength(9);
    expect(rows[0]).toMatch(/^.*bUSDCBloch Bridged USDCUSDC from EthereumNot deployed$/);
    expect(rows[1]).toMatch(/bUSDC\.arbBloch Bridged USDC \(Arbitrum\)USDC from Arbitrum OneNot deployed/);
    expect(rows[4]).toMatch(/bUSDC\.base.*Not available yet.*Not deployed/);
    expect(rows[5]).toMatch(/bBTCBloch Bridged BitcoinBTC from Bitcoin/);
    expect(rows[7]).toMatch(/bUSDT\.trxBloch Bridged USDT \(Tron\)USDT from TRON/);
    expect(list.textContent).toMatch(/They are different tokens: none of them is the asset itself/);
    // No two rows share a name: the per-network tokens are never merged.
    expect(new Set(within(list).getAllByRole('listitem').map((li) => li.querySelector('strong')!.textContent)).size).toBe(9);
  });
  it('renders the token list on its own (the DEX reference panel uses it)', () => {
    render(<WrappedTokenList tokens={config.tokens} compact />);
    expect(screen.getAllByRole('listitem')).toHaveLength(9);
  });
});
