// The multichain site (src/multichain, MultichainApp.tsx): the same route on public EVM chains, by configuration.
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MultichainApplication } from '../MultichainApp';
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Hex } from 'viem';
import { ChainError, readSnapshot, type Rpc } from '../devnet4/chain';
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
/** The reviewed token list of each chain, by the contract's own symbol (round 20). */
const LISTED: Record<string, string[]> = {
  ethereum: ['USDC', 'USDT'],
  base: ['USDC'],
  'arbitrum-one': ['USDC', 'USD₮0'],
  'op-mainnet': ['USDC', 'USDT'],
  linea: ['USDC'],
  'bnb-smart-chain': ['USDC', 'USDT'],
};

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
      // Restated in round 20 (agent 409): every chain listed exactly ['USDC']. The property kept: the token list
      // is exactly the reviewed one, by the contracts' own symbols (Arbitrum One's second token names itself
      // "USD₮0"), and USDC is first on every chain.
      expect(c.tokens.map((t) => t.symbol)).toEqual(LISTED[c.key]);
      expect(c.tokens[0].symbol).toBe('USDC');
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
    // Restated in round 20: the chain now lists a second Binance-Peg token; the first note and the first pair
    // are the ones this test always pinned, and the second token is never shown as plain USDT either.
    expect(chain.tokenNotes).toEqual([
      'USDC (Binance-Peg) is issued by Binance on BNB Smart Chain, not by Circle, and has 18 decimals.',
      'USDT (Binance-Peg) is issued by Binance on BNB Smart Chain, not by Tether, and has 18 decimals.',
    ]);
    expect(chain.planned.pairs).toEqual([
      ['WBNB', 'USDC (Binance-Peg)'],
      ['WBNB', 'USDT (Binance-Peg)'],
    ]);
    expect([chain.tokens[1].symbol, chain.tokens[1].label, chain.tokens[1].decimals]).toEqual([
      'USDT',
      'USDT (Binance-Peg)',
      18,
    ]);
    const state = parseRecord(deployedRecord('bnb-smart-chain'), chain);
    if (state.status !== 'live') throw new Error('expected a live state');
    // Review R344-UI-16: the deployment keeps the contract's own symbol (what readSnapshot pins against the
    // chain) and carries the label separately; the label is what the route shows.
    expect(state.deployment.tokens.map((t) => t.symbol)).toEqual(['WBNB', 'USDC']);
    expect(state.deployment.tokens.map((t) => t.label)).toEqual([undefined, 'USDC (Binance-Peg)']);
    // Restated in round 20: "no other chain has a label" was true of USDC and still is; the second token of a
    // chain carries a label wherever its bare symbol would say more than is true, and only there.
    for (const c of bundledChains().filter((x) => x.key !== 'bnb-smart-chain')) {
      expect(c.tokens[0].label).toBeUndefined();
      expect(c.tokens[0].note).toBeUndefined();
      expect(c.planned.pairs[0][1]).toBe('USDC');
    }
    const shown = Object.fromEntries(
      bundledChains().map((c) => [c.key, c.tokens.map((t) => t.label ?? t.symbol)]),
    );
    expect(shown).toEqual({
      ethereum: ['USDC', 'USDT'],
      base: ['USDC'],
      'arbitrum-one': ['USDC', 'USD₮0'],
      'op-mainnet': ['USDC', 'USDT (bridged)'],
      linea: ['USDC'],
      'bnb-smart-chain': ['USDC (Binance-Peg)', 'USDT (Binance-Peg)'],
    });
    // Only Tether's own contract on Ethereum is shown as plain "USDT"; every other USDT carries a note.
    for (const c of bundledChains())
      for (const t of c.tokens.slice(1))
        expect(t.note === undefined).toBe(c.key === 'ethereum');
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

  it('lets the page connect to BNB Smart Chain through its four reviewed origins, the replaced one no longer among them', () => {
    // The policy is generated from the network files, never written by hand. On 2026-11-19 BNB Smart Chain's
    // second endpoint (api.zan.top, which refuses eth_call to anonymous callers) was replaced by a host of BNB
    // Chain's own published list: one origin leaves the published policy, one enters, the total is unchanged.
    const urls = bundledChains().flatMap((c) => c.rpcUrls);
    const csp = multichainHeadersFile(urls, renderHeadersFile)
      .split('\n')
      .find((l) => l.includes('Content-Security-Policy'))!;
    const connect = csp.match(/connect-src ([^;]*)/)![1].split(' ');
    const reviewed = [
      'https://bsc-rpc.publicnode.com',
      'https://bsc-dataseed.defibit.io',
      'https://bsc-mainnet.public.blastapi.io',
      'https://bsc-dataseed.bnbchain.org',
    ];
    for (const origin of reviewed) expect(connect).toContain(origin);
    expect(csp).not.toContain('zan.top');
    expect(new Set(urls.map((u) => new URL(u).origin)).size).toBe(17);
    expect(bundledChains().find((c) => c.key === 'bnb-smart-chain')!.rpcUrls).toEqual(reviewed);
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
    // Restated in round 20: the chain plans a second pool, so the sentence names both and two notes are shown.
    expect((await screen.findByLabelText('Not yet live')).textContent).toContain(
      'Pools: WBNB/USDC (Binance-Peg), WBNB/USDT (Binance-Peg).',
    );
    // The tokens' notes are on screen with the route: this "USDC" is not Circle's, this "USDT" not Tether's.
    expect(screen.getAllByTestId('token-note').map((n) => n.textContent)).toEqual([
      'USDC (Binance-Peg) is issued by Binance on BNB Smart Chain, not by Circle, and has 18 decimals.',
      'USDT (Binance-Peg) is issued by Binance on BNB Smart Chain, not by Tether, and has 18 decimals.',
    ]);
    // A chain that is not live names no pair as "not open yet": the planned pools are in the panel above.
    expect(screen.queryByTestId('pairs-not-open')).toBeNull();
    expect(document.title).toBe('PosternDEX — BNB Smart Chain');
    // An unknown key shows the first network.
    await act(async () => {
      history.replaceState(null, '', '/#/bloch-l2');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('PosternDEX on Ethereum');
  });
});

// Round 20 (agent 409): a second listed token per chain. Pairs open one at a time; a token whose pool is not
// proven open is not handed to the route; Tether's approve on Ethereum needs a reset to zero.
describe('multichain: a second token, pairs opening one at a time', () => {
  const second = (key: string) => entry(key).network.tokens[1].address as `0x${string}`;
  const pairOf = (key: string, index: number, address: string) => {
    const { network } = entry(key);
    const [token0, token1] = [network.wrappedNative.address, network.tokens[index].address].sort();
    return { address, token0, token1 };
  };

  it('a chain live with its first pool stays live while the second is not open: the second token is not in the route, and the pair is named as not open', () => {
    for (const key of ['ethereum', 'op-mainnet', 'arbitrum-one', 'bnb-smart-chain']) {
      const e = entry(key);
      // The record as it stands after the first pool only, with and without the `notOpen` entry.
      for (const over of [{}, { notOpen: [{ ...pairOf(key, 1, a(0xf5)), state: 'absent' }] }]) {
        const chain = parseChain(e.network, deployedRecord(key, over));
        const state = parseRecord(deployedRecord(key, over), chain);
        if (state.status !== 'live') throw new Error('expected a live state');
        const d = state.deployment;
        expect(d.tokens.map((t) => t.address)).toEqual([e.network.wrappedNative.address, e.network.tokens[0].address]);
        expect(d.pairs).toHaveLength(1);
        // No pin of the unopened token is read, and no saved call naming it can pass review.
        expect(d.codeHashes[second(key)]).toBeUndefined();
        expect(Object.keys(d.codeHashes)).toHaveLength(7);
        expect(chain.pendingPairs).toEqual([[chain.wrapped.symbol, chain.tokens[1].label ?? chain.tokens[1].symbol]]);
      }
    }
    expect(parseChain(entry('ethereum').network, deployedRecord('ethereum')).pendingPairs).toEqual([['WETH', 'USDT']]);
    expect(parseChain(entry('arbitrum-one').network, deployedRecord('arbitrum-one')).pendingPairs).toEqual([['WETH', 'USD₮0']]);
    expect(parseChain(entry('op-mainnet').network, deployedRecord('op-mainnet')).pendingPairs).toEqual([['WETH', 'USDT (bridged)']]);
    expect(parseChain(entry('bnb-smart-chain').network, deployedRecord('bnb-smart-chain')).pendingPairs).toEqual([['WBNB', 'USDT (Binance-Peg)']]);
    // A chain with one listed token, or one that is not deployed, names nothing as pending.
    expect(parseChain(entry('base').network, deployedRecord('base')).pendingPairs).toEqual([]);
    expect(parseChain(entry('ethereum').network, entry('ethereum').record).pendingPairs).toEqual([]);
  });

  it('once the record lists the second pair, its token joins the route with its own code hash and nothing is pending', () => {
    const e = entry('ethereum');
    const record = deployedRecord('ethereum', { pairs: [pairOf('ethereum', 0, a(0xf4)), pairOf('ethereum', 1, a(0xf5))] });
    const chain = parseChain(e.network, record);
    const state = parseRecord(record, chain);
    if (state.status !== 'live') throw new Error('expected a live state');
    expect(state.deployment.tokens.map((t) => t.symbol)).toEqual(['WETH', 'USDC', 'USDT']);
    expect(state.deployment.codeHashes[second('ethereum')]).toBe(e.network.tokens[1].codeHash);
    expect(Object.keys(state.deployment.codeHashes)).toHaveLength(9);
    expect(chain.pendingPairs).toEqual([]);
    // Only Tether's contract on Ethereum needs its allowance reset; the network file says so and nothing else does.
    expect(state.deployment.tokens.map((t) => t.approveZeroFirst)).toEqual([undefined, undefined, true]);
    for (const c of bundledChains())
      for (const t of c.tokens)
        expect(t.approveZeroFirst === true).toBe(c.key === 'ethereum' && t.symbol === 'USDT');
  });

  it('refuses a record whose notOpen entry is malformed, names an open pair, or collides with a contract; and an unknown approve mode', () => {
    const e = entry('ethereum');
    const chain = parseChain(e.network, e.record);
    const bad = (over: Record<string, unknown>, message: RegExp) =>
      expect(() => parseRecord(deployedRecord('ethereum', over), chain)).toThrow(message);
    const pending = { ...pairOf('ethereum', 1, a(0xf5)), state: 'absent' };
    expect(parseRecord(deployedRecord('ethereum', { notOpen: [pending] }), chain).status).toBe('live');
    bad({ notOpen: 'none' }, /notOpen/);
    bad({ notOpen: [{ ...pending, state: 'open' }] }, /unknown state/);
    bad({ notOpen: [{ ...pending, token1: a(0xbad) }] }, /not listed/);
    bad({ notOpen: [{ ...pending, token0: pending.token1, token1: pending.token0 }] }, /not sorted/);
    bad({ notOpen: [{ ...pending, address: a(0xf4) }] }, /both as open and as not open/);
    bad({ notOpen: [pending, pending] }, /recorded twice/);
    bad({ notOpen: [{ ...pending, address: a(0xf2) }] }, /share an address/);
    const odd = clone(e);
    odd.network.tokens[1].approve = 'unlimited';
    expect(() => parseChain(odd.network, odd.record)).toThrow(/approve/);
    // A symbol with anything but letters, digits, a dot or the tugrik sign of "USD₮0" is refused.
    for (const symbol of ['USD T', 'USD<0', 'USDТ']) {
      const other = clone(entry('arbitrum-one'));
      other.network.tokens[1].symbol = symbol;
      other.network.tokens[1].label = symbol;
      expect(() => parseChain(other.network, other.record)).toThrow(/symbol/);
    }
  });

  it('the page names the unopened pair, shows no price for it and offers nothing to send', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'));
    const e = entry('op-mainnet');
    const chains = [parseChain(e.network, deployedRecord('op-mainnet'))];
    history.replaceState(null, '', '/#/op-mainnet');
    render(<MultichainApplication chains={chains} />);
    const notice = await screen.findByTestId('pairs-not-open');
    expect(notice.textContent).toBe(
      'Not open yet on OP Mainnet: WETH/USDT (bridged). This page lists a pool only after its opening has been verified, and sends no transaction for a pair that is not listed.',
    );
    expect(screen.queryByRole('button', { name: /Approve|Swap|Reset/ })).toBeNull();
    fetchSpy.mockRestore();
  });
});
