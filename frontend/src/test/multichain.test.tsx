// The multichain site (src/multichain, MultichainApp.tsx): the same route on public EVM chains, by configuration.
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MultichainApplication, connectUnavailableNote } from '../MultichainApp';
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Hex } from 'viem';
import { ChainError, readSnapshot, type Rpc } from '../devnet4/chain';
import { addChainParameters, swapClock } from '../mainnet/config';
import { renderHeadersFile } from '../mainnet/headers';
import { BLOCH_L2_WORDING, setWording, wording } from '../mainnet/wording';
import bundle from '../multichain/bundle';
import { bundledChains, parseChain, parseRecord } from '../multichain/config';
import { blochL2PolicyUrls, multichainHeadersFile } from '../multichain/headers';
import l2Network from '../../../deployments/mainnet/frontend.network.json';
import l2Record from '../../../deployments/mainnet/dex-mainnet.record.json';
import { fallbackRpc } from '../multichain/rpc';

// Agent 410: the mobile-wallet session module and the WalletConnect client are loaded only when the user presses
// the connect button of a live route. A mock factory runs when its module is first imported: these counters stay
// at zero on a route that is not live.
const loaded = vi.hoisted(() => ({ session: 0, client: 0, init: 0 }));
vi.mock('../multichain/walletconnect', () => {
  loaded.session++;
  return {};
});
vi.mock('@walletconnect/sign-client', () => {
  loaded.client++;
  return { default: { init: () => (loaded.init++, Promise.reject(new Error('not in this test'))) } };
});
/** Counts relay (or any other) sockets the page opens. */
function socketSpy() {
  const opened: string[] = [];
  vi.stubGlobal(
    'WebSocket',
    class {
      constructor(url: string) {
        opened.push(String(url));
      }
    },
  );
  return opened;
}

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const entry = (key: string) => {
  const found = (bundle as { network: { key: string }; record: unknown }[]).find(
    (e) => e.network.key === key,
  )!;
  return clone(found) as { network: Record<string, any>; record: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
/** A record as scripts/multichain/frontend-files.mjs writes it from a passed post gate. */
function deployedRecord(key: string, over: Record<string, unknown> = {}) {
  const { network } = entry(key);
  const [token0, token1] = [network.wrappedNative.address, network.tokens[0].address].sort();
  return {
    schemaVersion: 1,
    domain: 'postern.dex.multichain-frontend-record.v1',
    key,
    chainId: network.chainId,
    status: 'deployed',
    rehearsal: false,
    genesisHash: network.genesisHash,
    finalized: { number: 1234, hash: h(77) },
    feeTo: network.feeTo,
    firstDepositor: a(0),
    factory: { address: a(0xf1), codeHash: h(1) },
    router: { address: a(0xf2), codeHash: h(2) },
    lens: { address: a(0xf3), codeHash: h(3) },
    wrappedNative: network.wrappedNative.address,
    reserveCaps: [],
    pairCodeHash: h(4),
    pairs: [{ address: a(0xf4), token0, token1 }],
    ...over,
  };
}
afterEach(() => {
  setWording({ ...BLOCH_L2_WORDING });
  vi.unstubAllGlobals();
});

/**
 * The Bloch-words guard of a PUBLIC-chain route, restated for the site with seven networks (agent 415, round 20).
 * It exists so that nobody mistakes an asset on a public chain for a Bloch L2 asset. Since the Bloch L2 is a
 * network of this site, two controls name it so that it can be chosen: its link in the header's list and its row
 * in the network switcher. Each is checked to be exactly that (a link to the L2 route whose text is the network's
 * name) and only those elements are set aside; with the site's name taken out as before, no other text of the
 * page, and nothing at all inside the route (the `main` region), may say Bloch, BLCH or bUSDC.
 */
function publicRouteWords(): string {
  const route = document.querySelector('main')!.textContent!.replaceAll('Bloch DEX', '');
  expect(route).not.toMatch(/Bloch|BLCH|bUSDC/);
  const copy = document.body.cloneNode(true) as HTMLElement;
  const named = [...copy.querySelectorAll('a[href="#/bloch-l2"]')];
  // One link in the header list; one more row while the switcher is open.
  expect(named.length === 1 || named.length === 2).toBe(true);
  expect(named[0].closest('nav')!.getAttribute('aria-label')).toBe('Networks');
  expect(named[0].textContent).toBe('Bloch L2');
  if (named[1]) {
    expect(named[1].className).toBe('network-row');
    expect(named[1].textContent).toMatch(/^Bloch L2Chain 700770 · (Not yet live|Live)$/);
  }
  for (const link of named) link.remove();
  return copy.textContent!.replaceAll('Bloch DEX', '');
}

describe('multichain configuration', () => {
  it('bundles the six chains, none of them the Bloch L2, each with two https endpoints and the fee address', () => {
    const chains = bundledChains();
    expect(chains.map((c) => c.key)).toEqual([
      'ethereum',
      'base',
      'arbitrum-one',
      'op-mainnet',
      'linea',
      'bnb-smart-chain',
    ]);
    expect(chains.map((c) => c.network.chainId)).toEqual([1, 8453, 42161, 10, 59144, 56]);
    for (const c of chains) {
      expect(c.rpcUrls.length).toBeGreaterThanOrEqual(2);
      expect(c.rpcUrls.every((u) => u.startsWith('https://'))).toBe(true);
      expect(c.feeTo).toBe('0x775a993f09bd80aecf8f8c2ade0c84158e3a0544');
      expect(c.network.bridges).toEqual([]);
      expect(c.network.newSlotFee.enabled).toBe(false);
      expect(c.network.noIdleHeartbeat).toBe(true);
      expect(c.wording.quiet).toBe('stale-rpc');
      expect(c.tokens.map((t) => t.symbol)).toEqual(['USDC']);
    }
    expect(chains.find((c) => c.key === 'bnb-smart-chain')!.wording.native).toBe('BNB');
    expect(chains.find((c) => c.key === 'bnb-smart-chain')!.tokens[0].decimals).toBe(18);
  });

  it('every committed record is "not-deployed": no chain is live and none makes a request', async () => {
    for (const c of bundledChains()) {
      const state = await c.load();
      expect(state.status).toBe('not-live');
    }
  });

  it('refuses the Bloch L2, an L2-only rule switched on, a single endpoint, plain http, and a twice-listed token', () => {
    const base = () => entry('base');
    for (const chainId of [700770, 700771]) {
      const e = base();
      e.network.chainId = chainId;
      expect(() => parseChain(e.network, e.record)).toThrow(/Bloch L2 is not a chain of this site/);
    }
    for (const rule of ['bridgeTokenPin', 'safePin', 'newSlotFee', 'creditRule', 'idleChainRule']) {
      const e = base();
      e.network.l2Only[rule] = true;
      expect(() => parseChain(e.network, e.record)).toThrow(/l2Only/);
    }
    const one = base();
    one.network.rpc.urls = [one.network.rpc.urls[0]];
    expect(() => parseChain(one.network, one.record)).toThrow(/at least two endpoints/);
    const http = base();
    http.network.rpc.urls[1] = 'http://example.org';
    expect(() => parseChain(http.network, http.record)).toThrow(/https/);
    const query = base();
    query.network.rpc.urls[1] = 'https://example.org/?key=1';
    expect(() => parseChain(query.network, query.record)).toThrow(
      /https without credentials, query/,
    );
    const twice = base();
    twice.network.tokens.push(clone(twice.network.tokens[0]));
    expect(() => parseChain(twice.network, twice.record)).toThrow(/listed twice/);
  });

  it('turns a deployed record into the deployment the route verifies: every contract and token with its code hash', () => {
    const e = entry('base');
    const chain = parseChain(e.network, deployedRecord('base'));
    const state = parseRecord(deployedRecord('base'), chain);
    if (state.status !== 'live') throw new Error('expected a live state');
    const d = state.deployment;
    expect(d.chainId).toBe(8453);
    expect(d.feeTo).toBe('0x775a993f09bd80aecf8f8c2ade0c84158e3a0544');
    expect(d.wrapped).toBe('0x4200000000000000000000000000000000000006');
    expect(d.tokens.map((t) => [t.symbol, t.wrapped, t.cap])).toEqual([
      ['WETH', true, 0n],
      ['USDC', false, 0n],
    ]);
    // factory, router, lens, Multicall3, both tokens and the pair.
    expect(Object.keys(d.codeHashes)).toHaveLength(7);
    expect(d.codeHashes[e.network.tokens[0].address as `0x${string}`]).toBe(
      e.network.tokens[0].codeHash,
    );
    expect(state.multicall3).toBe('0xca11bde05977b3631167028862be2a173976ca11');
    expect(d.gate).toEqual({
      decision: 'liquidity-enabled',
      finalizedNumber: 1234n,
      finalizedHash: h(77),
    });
  });

  it("shows BNB Smart Chain's Binance-Peg token under its label, never as plain USDC; no other chain has a label", () => {
    const e = entry('bnb-smart-chain');
    const chain = parseChain(e.network, deployedRecord('bnb-smart-chain'));
    expect([chain.tokens[0].symbol, chain.tokens[0].label, chain.tokens[0].decimals]).toEqual([
      'USDC',
      'USDC (Binance-Peg)',
      18,
    ]);
    expect(chain.tokenNotes).toEqual([
      'USDC (Binance-Peg) is issued by Binance on BNB Smart Chain, not by Circle, and has 18 decimals.',
    ]);
    expect(chain.planned.pairs).toEqual([['WBNB', 'USDC (Binance-Peg)']]);
    const state = parseRecord(deployedRecord('bnb-smart-chain'), chain);
    if (state.status !== 'live') throw new Error('expected a live state');
    // Review R344-UI-16: the deployment keeps the contract's own symbol (what readSnapshot pins against the
    // chain) and carries the label separately; the label is what the route shows.
    expect(state.deployment.tokens.map((t) => t.symbol)).toEqual(['WBNB', 'USDC']);
    expect(state.deployment.tokens.map((t) => t.label)).toEqual([undefined, 'USDC (Binance-Peg)']);
    for (const c of bundledChains().filter((x) => x.key !== 'bnb-smart-chain')) {
      expect(c.tokens[0].label).toBeUndefined();
      expect(c.tokenNotes).toEqual([]);
      expect(c.planned.pairs[0][1]).toBe('USDC');
    }
    // A label goes with a note and begins with the contract's own symbol.
    const bad = clone(e) as unknown as { network: { tokens: { label?: string; note?: string }[] }; record: unknown };
    bad.network.tokens[0].label = 'Dollar';
    expect(() => parseChain(bad.network, bad.record)).toThrow(/label/);
    bad.network.tokens[0].label = 'USDC (Binance-Peg)';
    delete bad.network.tokens[0].note;
    expect(() => parseChain(bad.network, bad.record)).toThrow(/note/);
  });

  it("R344-UI-16: BNB Smart Chain's snapshot read passes against the contract's own symbol and the live token shows the label", async () => {
    const e = entry('bnb-smart-chain');
    const chain = parseChain(e.network, deployedRecord('bnb-smart-chain'));
    const state = parseRecord(deployedRecord('bnb-smart-chain'), chain);
    if (state.status !== 'live') throw new Error('expected a live state');
    // Only the token pin is under test: no code hashes and no pairs to read.
    const d = { ...state.deployment, codeHashes: {}, pairs: [] };
    const erc20 = parseAbi(['function decimals() view returns (uint8)', 'function symbol() view returns (string)']);
    const onChain = new Map(d.tokens.map((t) => [t.address.toLowerCase(), t.address.toLowerCase() === chain.wrapped.address ? 'WBNB' : 'USDC']));
    const rpc: Rpc = async (method, params) => {
      if (method === 'eth_chainId') return `0x${d.chainId.toString(16)}`;
      if (method === 'eth_getBlockByNumber')
        return (params as unknown[])[0] === '0x0'
          ? { hash: d.genesisHash }
          : { number: `0x${d.gate.finalizedNumber.toString(16)}`, hash: d.gate.finalizedHash, timestamp: '0x1' };
      if (method === 'eth_call') {
        const call = (params as [{ to: string; data: Hex }])[0];
        const fn = decodeFunctionData({ abi: erc20, data: call.data }).functionName;
        return encodeFunctionResult({ abi: erc20, functionName: fn, result: fn === 'decimals' ? 18 : onChain.get(call.to.toLowerCase())! } as never);
      }
      throw new Error(`unexpected ${method}`);
    };
    const snapshot = await readSnapshot(rpc, d, 'bnb-smart-chain');
    const usdc = snapshot.tokens.find((t) => t.address !== chain.wrapped.address)!;
    expect(usdc.chainSymbol).toBe('USDC');
    expect(usdc.symbol).toBe('USDC (Binance-Peg)');
    expect(usdc.decimals).toBe(18);
  });

  it('refuses a record for another chain, genesis, fee address or wrapped token, a rehearsal record, and an unlisted pair token', () => {
    const e = entry('base');
    const chain = parseChain(e.network, e.record);
    const bad = (over: Record<string, unknown>, message: RegExp) =>
      expect(() => parseRecord(deployedRecord('base', over), chain)).toThrow(message);
    bad({ chainId: 10 }, /another chain/);
    bad({ genesisHash: h(9) }, /another genesis/);
    bad({ feeTo: a(0xbad) }, /another fee address/);
    bad({ wrappedNative: a(0xbad) }, /another wrapped native token/);
    bad({ rehearsal: true }, /rehearsal record/);
    bad({ pairs: [{ address: a(0xf4), token0: a(1), token1: a(2) }] }, /not listed/);
    bad({ factory: { address: a(0xf2), codeHash: h(1) } }, /share an address/);
  });

  it("the wallet's network entry names every reviewed endpoint and the chain's own coin", () => {
    const chain = bundledChains().find((c) => c.key === 'arbitrum-one')!;
    expect(addChainParameters(chain.network)).toEqual({
      chainId: 42161,
      chainName: 'Arbitrum One',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: [
        'https://arb1.arbitrum.io/rpc',
        'https://arbitrum.gateway.tenderly.co',
        'https://arbitrum-one.public.blastapi.io',
        'https://arbitrum-one-rpc.publicnode.com',
      ],
      blockExplorerUrls: ['https://arbiscan.io'],
    });
  });
});

describe('multichain RPC', () => {
  const failing: Rpc = async () => {
    throw new Error('network');
  };
  it('moves to the next endpoint when one fails, and fails only when all do', async () => {
    const second = vi.fn<Rpc>(async () => '0x2105');
    expect(await fallbackRpc([failing, second])('eth_chainId', [])).toBe('0x2105');
    expect(second).toHaveBeenCalledTimes(1);
    await expect(fallbackRpc([failing, failing])('eth_chainId', [])).rejects.toThrow('network');
  });
  it('asks the next endpoint for block 0 when one does not serve it', async () => {
    const pruned = vi.fn<Rpc>(async () => null);
    const full = vi.fn<Rpc>(async () => ({ hash: h(5) }));
    expect(await fallbackRpc([pruned, full])('eth_getBlockByNumber', ['0x0', false])).toEqual({
      hash: h(5),
    });
    // Any other null is an answer (no receipt yet): the second endpoint is not asked.
    expect(await fallbackRpc([pruned, full])('eth_getTransactionReceipt', [h(1)])).toBeNull();
    expect(full).toHaveBeenCalledTimes(1);
  });
  it("returns a revert as the chain's answer, without asking another endpoint", async () => {
    const reverting: Rpc = async () => {
      const error = new ChainError('chain: eth_call failed: execution reverted: BDEX: K');
      error.code = 3;
      throw error;
    };
    const second = vi.fn<Rpc>(async () => '0x');
    await expect(fallbackRpc([reverting, second])('eth_call', [])).rejects.toThrow(/BDEX: K/);
    expect(second).not.toHaveBeenCalled();
  });
});

describe('multichain wording and clock', () => {
  it("leaves the Bloch L2's words as they are unless the multichain site sets its own", () => {
    expect(wording).toEqual(BLOCH_L2_WORDING);
    expect(wording.title).toBe('Bloch L2 mainnet');
    expect(wording.native).toBe('BLCH');
  });
  it('on a public chain an old latest block is a lagging RPC: the user is told and the deadline is not raised', () => {
    const chain = bundledChains()[0];
    const now = 1_800_000_000;
    // The Bloch L2 wording raises the deadline on an idle chain (75 minutes at launch).
    expect(swapClock(now * 1000, BigInt(now - 3_600), undefined, 60)).toMatchObject({
      ok: true,
      deadlineMinutes: 75,
    });
    setWording(chain.wording);
    const clock = swapClock(now * 1000, BigInt(now - 1_200), chain.network.idle, 20);
    if (!clock.ok) throw new Error(clock.problem);
    expect(clock.deadlineMinutes).toBe(20);
    expect(clock.notice).toMatch(
      /^The latest block this RPC shows is 20 minutes old, so the RPC may be behind the chain\./,
    );
    expect(clock.notice).not.toMatch(/L2|idle/);
    expect(swapClock(now * 1000, BigInt(now - 5), chain.network.idle, 20)).toMatchObject({
      ok: true,
      notice: null,
    });
    const far = swapClock(now * 1000, BigInt(now - 4 * 3_600), chain.network.idle, 20);
    expect(far.ok).toBe(false);
    if (!far.ok)
      expect(far.problem).toMatch(
        /4 hours ahead of the latest block\. Ethereum makes a block at least every 10 minutes, so/,
      );
  });
});

describe('multichain headers', () => {
  // Restated (agent 415, round 20): the Bloch L2 is a network of this site now, so the pin is no longer "never the
  // Bloch L2 RPC" but "the Bloch L2 RPC only when the built site can contact it". With the committed L2 files (the
  // record `not-deployed`, the RPC a placeholder, no genesis pinned) the route sends no request, so the policy
  // must not name the L2 endpoint: the published text is what it was. The live case and every state in between are
  // in multichain-bloch-l2.test.tsx.
  it('names every bundled endpoint in connect-src, and the Bloch L2 RPC not while the L2 route cannot be live', () => {
    const urls = bundledChains().flatMap((c) => c.rpcUrls);
    expect(blochL2PolicyUrls(l2Network, l2Record)).toEqual([]);
    const file = multichainHeadersFile(
      [...urls, ...blochL2PolicyUrls(l2Network, l2Record)],
      renderHeadersFile,
    );
    const csp = file.split('\n').find((l) => l.includes('Content-Security-Policy'))!;
    for (const url of urls) expect(csp).toContain(` ${new URL(url).origin} `);
    expect(csp).not.toContain('blochl1.com');
    // Nothing broader: the policy is exactly the one of the six public chains' endpoints.
    expect(file).toBe(multichainHeadersFile(urls, renderHeadersFile));
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('upgrade-insecure-requests');
    expect(file.split('\n')[0]).toMatch(/multichain/);
  });
});

describe('multichain application', () => {
  it('offers the seven networks (the six public chains, then the Bloch L2), shows the selected one as not yet live, and makes no request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const sockets = socketSpy();
    history.replaceState(null, '', '/#/base');
    render(<MultichainApplication />);
    const nav = screen.getByRole('navigation', { name: 'Networks' });
    expect([...nav.querySelectorAll('a')].map((l) => l.textContent)).toEqual([
      'Ethereum',
      'Base',
      'Arbitrum One',
      'OP Mainnet',
      'Linea',
      'BNB Smart Chain',
      'Bloch L2',
    ]);
    expect(nav.querySelector('[aria-current="page"]')!.textContent).toBe('Base');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Bloch DEX on Base');
    const panel = await screen.findByLabelText('Not yet live');
    expect(panel.textContent).toContain('The DEX is not deployed on Base yet.');
    // Published before activation: one line on every route while no bundled record is of an open pool.
    expect((await screen.findByTestId('not-active-banner')).textContent).toBe(
      'Bloch DEX is not active yet. No pool is open on any network: nothing can be traded here, and this site sends no transaction.',
    );
    expect(document.querySelector('.brand .wordmark')!.textContent).toBe('Bloch DEX');
    // The shell is marked as the multichain site's: its header rule for many links applies here only (R412-4).
    expect(document.querySelector('.app-shell')!.getAttribute('data-site')).toBe('multichain');
    expect(panel.textContent).toContain(
      'No verified deployment record for Base has been published with this site.',
    );
    expect(panel.textContent).toContain('Pools: WETH/USDC.');
    expect(screen.queryByRole('button', { name: 'Swap' })).toBeNull();
    // The site is named "Bloch DEX" (owner, 2026-11-18). Apart from that name and the two controls that lead to
    // the seventh network, nothing of the Bloch L2 (the chain, BLCH, bUSDC) may appear on a public-chain route
    // (`publicRouteWords` above; every public route is walked in multichain-bloch-l2.test.tsx).
    expect(document.body.textContent).toContain('Bloch DEX');
    expect(publicRouteWords()).not.toMatch(/Bloch|BLCH|bUSDC/);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Agent 410: nor is the mobile-wallet path there: no connect step, no session module, no client, no socket.
    expect(document.querySelector('[data-wallet-connect]')).toBeNull();
    expect(document.querySelector('[data-mobile-wallet]')).toBeNull();
    expect(loaded).toEqual({ session: 0, client: 0, init: 0 });
    expect(sockets).toEqual([]);
  });

  it('the header "Connect wallet" on a route that is not live says when connecting becomes available, and still asks and loads nothing', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const sockets = socketSpy();
    const request = vi.fn();
    window.ethereum = { request };
    history.replaceState(null, '', '/#/base');
    render(<MultichainApplication />);
    await screen.findByTestId('not-active-banner');
    const region = screen.getByTestId('wallet-unavailable');
    expect(region.getAttribute('role')).toBe('status');
    expect(region.textContent).toBe('');
    await user.click(screen.getByRole('button', { name: 'Connect wallet' }));
    expect(region.textContent).toBe(
      'Connecting a wallet becomes available when Base is live on Bloch DEX. Nothing was asked of any wallet.',
    );
    expect(region.textContent).toBe(connectUnavailableNote('Base'));
    // The note is this page's: another network's page starts without it and names its own network.
    await act(async () => {
      history.replaceState(null, '', '/#/linea');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(region.textContent).toBe('');
    await user.click(screen.getByRole('button', { name: 'Connect wallet' }));
    expect(region.textContent).toBe(connectUnavailableNote('Linea'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[data-mobile-wallet]')).toBeNull();
    expect(publicRouteWords()).not.toMatch(/Bloch|BLCH|bUSDC/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(loaded).toEqual({ session: 0, client: 0, init: 0 });
    expect(sockets).toEqual([]);
  });

  it('follows the selector: another network is another page with its own words', async () => {
    history.replaceState(null, '', '/#/base');
    render(<MultichainApplication />);
    await screen.findByLabelText('Not yet live');
    await act(async () => {
      history.replaceState(null, '', '/#/bnb-smart-chain');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Bloch DEX on BNB Smart Chain',
    );
    expect((await screen.findByLabelText('Not yet live')).textContent).toContain(
      'Pools: WBNB/USDC (Binance-Peg).',
    );
    // The token's note is on screen with the route: this "USDC" is not Circle's.
    expect(screen.getByTestId('token-note').textContent).toBe(
      'USDC (Binance-Peg) is issued by Binance on BNB Smart Chain, not by Circle, and has 18 decimals.',
    );
    expect(document.title).toBe('Bloch DEX — BNB Smart Chain');
    // An unknown key shows the first network. (Before round 20 the unknown key of this test was `bloch-l2`, which
    // is the seventh network's route now: multichain-bloch-l2.test.tsx.)
    for (const unknown of ['mainnet', 'bloch', 'devnet4', 'bloch-l2x']) {
      await act(async () => {
        history.replaceState(null, '', `/#/${unknown}`);
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      });
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Bloch DEX on Ethereum');
    }
  });
});
