// The multichain site (src/multichain, MultichainApp.tsx): the same route on public EVM chains, by configuration.
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MultichainApplication } from '../MultichainApp';
import { ChainError, type Rpc } from '../devnet4/chain';
import { addChainParameters, swapClock } from '../mainnet/config';
import { renderHeadersFile } from '../mainnet/headers';
import { BLOCH_L2_WORDING, setWording, wording } from '../mainnet/wording';
import bundle from '../multichain/bundle';
import { bundledChains, parseChain, parseRecord } from '../multichain/config';
import { multichainHeadersFile } from '../multichain/headers';
import { fallbackRpc } from '../multichain/rpc';

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
afterEach(() => setWording({ ...BLOCH_L2_WORDING }));

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
  it('names every bundled endpoint in connect-src and not the Bloch L2 RPC', () => {
    const urls = bundledChains().flatMap((c) => c.rpcUrls);
    const file = multichainHeadersFile(urls, renderHeadersFile);
    const csp = file.split('\n').find((l) => l.includes('Content-Security-Policy'))!;
    for (const url of urls) expect(csp).toContain(` ${new URL(url).origin} `);
    expect(csp).not.toContain('blochl1.com');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('upgrade-insecure-requests');
    expect(file.split('\n')[0]).toMatch(/multichain/);
  });
});

describe('multichain application', () => {
  it('offers the six networks, shows the selected one as not yet live, and makes no request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
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
    ]);
    expect(nav.querySelector('[aria-current="page"]')!.textContent).toBe('Base');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('PosternDEX on Base');
    const panel = await screen.findByLabelText('Not yet live');
    expect(panel.textContent).toContain('The DEX is not deployed on Base yet.');
    expect(panel.textContent).toContain(
      'No verified deployment record for Base has been published with this site.',
    );
    expect(panel.textContent).toContain('Pools: WETH/USDC.');
    expect(screen.queryByRole('button', { name: 'Swap' })).toBeNull();
    expect(document.body.textContent).not.toMatch(/Bloch|BLCH|bUSDC/);
    expect(fetchSpy).not.toHaveBeenCalled();
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
      'PosternDEX on BNB Smart Chain',
    );
    expect((await screen.findByLabelText('Not yet live')).textContent).toContain(
      'Pools: WBNB/USDC.',
    );
    expect(document.title).toBe('PosternDEX — BNB Smart Chain');
    // An unknown key shows the first network.
    await act(async () => {
      history.replaceState(null, '', '/#/bloch-l2');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('PosternDEX on Ethereum');
  });
});
