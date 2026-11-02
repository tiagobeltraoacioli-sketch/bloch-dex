import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  decodeFunctionData,
  encodeFunctionResult,
  keccak256,
  parseAbi,
  sha256,
  stringToBytes,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import MainnetLive from '../MainnetLive';
import type { Devnet4Wallet } from '../Devnet4Live';
import { ERC20_ABI, LENS_ABI, PAIR_ABI, type LivePool, type Rpc } from '../devnet4/chain';
import {
  committedRecord,
  stableJson,
  verifyDeploymentRecord,
  type DevnetDeployment,
} from '../devnet4/record';
import { ensureChain, ReceiptUnknownError, ROUTER_ABI, waitForReceipt } from '../devnet4/swap';
import {
  addChainParameters,
  bundledNetwork,
  bundledRecord,
  loadMainnetState,
  MULTICALL3_CODE_HASH,
  parseNetwork,
  plannedCaps,
  plannedPairs,
  type MainnetNetwork,
} from '../mainnet/config';
import { checkRoute, explainBlock, headroom, headroomUse } from '../mainnet/caps';
import { parsePendingSwap, pendingSwapKey, pollPendingSwap } from '../mainnet/pendingswap';
import { blocksSwap, compareQuotes, signedQuote } from '../mainnet/quotecheck';
import { MULTICALL3_ABI, readBalances, skimTransaction } from '../mainnet/reads';
import networkJson from '../../../deployments/mainnet/frontend.network.json';
import type { Provider } from '../wallet';

const BUSDC = '0x1b7c0fb59f34683cd9214566636e63a0f7e092f6' as Address;
const WGSMH = '0xb2b4952b6e57e589109af764859886e236798ad4' as Address;
const WBLCH = '0x7f889d9cb335bbdb197b75c74a6409ac2bbbe6e6' as Address;
const ROUTER = '0xb3a451af23df72f72916064c6d33d1fbe25e7106' as Address;
const LENS = '0xb97473777fcf1f4b5be453ba1661b70b191a75cd' as Address;
const GSMH_PAIR = '0xd71fc81263ba585561ad4d784a4bc096739927b4' as Address;
const USD_PAIR = '0xd98230d9a13cb72f6d75e3bf46c01415027c8033' as Address;
const ACCOUNT = '0x72dc623d4c03c996a3d20ed2674f24570e8acf44' as Address;
const FINALIZED = { number: '0x1b8', hash: `0x${'f'.repeat(64)}`, timestamp: '0x6ad1a000' };
const NOW_MS = 1_792_200_000_000;
const PLANNED = { caps: plannedCaps(), pairs: plannedPairs() };
const norm = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(norm) : typeof value === 'string' ? value.toLowerCase() : value;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

/** The devnet4 two-pair record re-targeted at chain 700770 (a non-rehearsal plan). */
function mainnetRecord(): { plan: Json; config: Json; gateReport: Json; infra: Json } {
  const r = structuredClone(committedRecord) as { plan: Json; config: Json; gateReport: Json };
  r.config.network = {
    ...r.config.network,
    name: 'bloch-l2-mainnet',
    chainId: 700770,
    rehearsal: false,
  };
  r.plan.chain = { ...r.plan.chain, id: 700770, rehearsal: false };
  r.plan.configSha256 = sha256(stringToBytes(stableJson(r.config)));
  r.gateReport.chainId = 700770;
  return { ...r, infra: infraFor(r.plan.chain.genesisHash) };
}

const MULTICALL = '0x00000000000000000000000000000000000c0de3' as Address;
function infraFor(genesisHash: string) {
  return {
    domain: 'postern.dex.mainnet-infra-plan.v1',
    chain: { id: 700770, genesisHash, rehearsal: false },
    contracts: { multicall3: { address: MULTICALL, codeHash: MULTICALL3_CODE_HASH } },
  };
}

let network: MainnetNetwork;
let deployment: DevnetDeployment;
const fakeCode = new Map<Address, Hex>();

beforeAll(async () => {
  const record = mainnetRecord();
  network = {
    ...bundledNetwork(),
    rpcLive: true,
    genesisHash: record.plan.chain.genesisHash,
    explorerUrl: 'https://explorer.example.invalid',
  };
  const state = await loadMainnetState(
    {
      schemaVersion: 1,
      domain: 'postern.dex.frontend-record.v1',
      status: 'liquidity-enabled',
      ...record,
    },
    network,
  );
  if (state.status !== 'live') throw new Error('expected a live state');
  const codeHashes: Record<Address, Hex> = {};
  Object.keys(state.deployment.codeHashes).forEach((address, i) => {
    const code = `0x60${(i + 1).toString(16).padStart(2, '0')}` as Hex;
    fakeCode.set(address as Address, code);
    codeHashes[address as Address] = keccak256(code);
  });
  deployment = { ...state.deployment, codeHashes };
});

type ChainState = {
  allowance: bigint;
  quote: { available: boolean; amountOut: bigint; minimumOut: bigint };
  /** The lens quote at `latest`; defaults to the finalized one. */
  latestQuote?: { available: boolean; amountOut: bigint; minimumOut: bigint };
  /** A failing read at `latest`. */
  latestDown?: boolean;
  /** The settled RPC's answer when its follower status is lost or invalid. */
  finalityDown?: boolean;
  excess?: Record<
    string,
    { excess0: bigint; excess1: bigint; blocksInflow0: boolean; blocksInflow1: boolean }
  >;
  reserves: Record<string, [bigint, bigint, number]>;
  sent: { method: string; params: unknown[] }[];
};

const fakeState: { current: ChainState | null } = { current: null };

function fakeChain(change: Partial<ChainState> = {}): { rpc: Rpc; state: ChainState } {
  const state: ChainState = {
    allowance: 0n,
    quote: { available: true, amountOut: 31_000_000n, minimumOut: 30_845_000n },
    reserves: {
      [GSMH_PAIR]: [130_852_828_000_503_020n, 38_295_768n, 1],
      [USD_PAIR]: [5_571_215n, 272_177_475_029_800_010n, 1],
    },
    sent: [],
    ...change,
  };
  fakeState.current = state;
  const tokens: Record<string, [number, string, bigint]> = {
    [WBLCH]: [18, 'WBLCH', 0n],
    [BUSDC]: [6, 'bUSDC', 25_000_000n],
    [WGSMH]: [8, 'wGSMH', 0n],
  };
  const caps: Record<string, [bigint, bigint]> = {
    [GSMH_PAIR]: [10n ** 19n, 100_000_000n],
    [USD_PAIR]: [1_000_000_000n, 10n ** 19n],
  };
  const reply = (abi: Abi, functionName: string, result: unknown) =>
    encodeFunctionResult({ abi, functionName, result } as never);
  const rpc: Rpc = async (method, params) => {
    state.sent.push({ method, params });
    switch (method) {
      case 'eth_chainId':
        return '0xab162';
      case 'eth_getBlockByNumber':
        if (params[0] === 'finalized' && state.finalityDown)
          throw Object.assign(new Error('finality unavailable'), { code: -32001 });
        return params[0] === '0x0'
          ? { number: '0x0', hash: deployment.genesisHash }
          : params[0] === 'finalized'
            ? FINALIZED
            : null;
      case 'eth_getCode':
        return fakeCode.get(params[0] as Address) ?? '0x';
      case 'eth_getBalance':
        return '0xde0b6b3a7640000';
      case 'eth_getTransactionReceipt':
        return { status: '0x1', blockNumber: '0x1ba', gasUsed: '0x2a50a' };
      case 'eth_call': {
        const { to, data } = params[0] as { to: Address; data: Hex };
        if (params[1] === 'latest' && state.latestDown) throw new Error('RPC down');
        for (const abi of [ERC20_ABI, PAIR_ABI, LENS_ABI] as Abi[]) {
          let call;
          try {
            call = decodeFunctionData({ abi, data });
          } catch {
            continue;
          }
          const name = call.functionName;
          if (name === 'decimals') return reply(abi, name, tokens[to][0]);
          if (name === 'symbol') return reply(abi, name, tokens[to][1]);
          if (name === 'balanceOf') return reply(abi, name, tokens[to][2]);
          if (name === 'allowance') return reply(abi, name, state.allowance);
          if (name === 'getReserves') return reply(abi, name, state.reserves[to]);
          if (name === 'reserveCaps') return reply(abi, name, caps[to]);
          if (name === 'pendingExcess')
            return reply(
              abi,
              name,
              state.excess?.[(call.args as [Address])[0].toLowerCase()] ?? {
                excess0: 0n,
                excess1: 0n,
                blocksInflow0: false,
                blocksInflow1: false,
              },
            );
          if (name === 'bestExactInput') {
            const [amountIn, routes] = call.args as [bigint, Address[][]];
            const latest = params[1] === 'latest';
            const active = (latest && state.latestQuote) || state.quote;
            const q = (route: Address[]) => ({
              available: active.available,
              blockNumber: latest ? 500n : 440n,
              timestamp: 0n,
              amountOut: active.amountOut,
              minimumOut: active.minimumOut,
              amounts: route.map((_, i) => (i === 0 ? amountIn : active.amountOut)),
              executionLossBps: route.slice(1).map(() => 30n),
            });
            const best = active.available ? 0n : 2n ** 256n - 1n;
            return reply(abi, name, [best, routes.map(q)]);
          }
        }
        throw new Error(`unexpected call ${to} ${data.slice(0, 10)}`);
      }
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  return { rpc, state };
}

function fakeWallet(chain?: ChainState, connected = true) {
  let chainId = '0x1';
  const requests: { method: string; params?: unknown[] }[] = [];
  const provider: Provider = {
    async request({ method, params }) {
      requests.push({ method, params });
      if (method === 'eth_chainId') return chainId;
      if (method === 'wallet_switchEthereumChain') {
        if (!requests.some((r) => r.method === 'wallet_addEthereumChain'))
          throw Object.assign(new Error('Unrecognized chain'), { code: 4902 });
        chainId = (params![0] as { chainId: string }).chainId;
        return null;
      }
      if (method === 'wallet_addEthereumChain') {
        chainId = (params![0] as { chainId: string }).chainId;
        return null;
      }
      if (method === 'eth_sendTransaction') {
        const tx = params![0] as { to: Address };
        if (chain && tx.to === BUSDC) chain.allowance = 0n; // the finalized block lags
        return `0x${String(requests.length).padStart(64, '0')}`;
      }
      throw new Error(`unexpected wallet call ${method}`);
    },
  };
  const wallet: Devnet4Wallet = {
    account: connected ? { address: ACCOUNT, chainId: '0x1', name: 'Test wallet' } : null,
    provider: connected ? provider : null,
    wallets: [],
    pending: false,
    error: '',
    connect: () => {},
  };
  return { wallet, requests };
}

describe('mainnet network file', () => {
  it('parses the committed placeholder: chain 700770 (0xab162), RPC not live, nothing pinned', () => {
    const n = parseNetwork(networkJson);
    expect(n).toMatchObject({
      chainId: 700770,
      chainHex: '0xab162',
      rpcUrl: 'https://l2rpc.blochl1.com',
      rpcLive: false,
      genesisHash: null,
      explorerUrl: null,
    });
    expect(n.bridges.map((b) => [b.symbol, b.depositUrl])).toEqual([['bUSDC', null]]);
  });

  it('refuses another chain, plain http off loopback, credentials and a non-BLCH currency', () => {
    const edit = (change: Json) => () =>
      parseNetwork({ ...structuredClone(networkJson), ...change });
    expect(edit({ chainId: 700771 })).toThrow(/not chain 700770/);
    expect(edit({ rpc: { url: 'http://l2rpc.blochl1.com', status: 'live' } })).toThrow(/https/);
    expect(edit({ rpc: { url: 'https://u:p@l2rpc.blochl1.com', status: 'live' } })).toThrow(
      /https/,
    );
    expect(edit({ explorer: { url: 'javascript:alert(1)' } })).toThrow(/https/);
    expect(edit({ nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } })).toThrow(
      /BLCH/,
    );
    expect(edit({ genesisHash: '0x1234' })).toThrow(/genesisHash/);
    expect(edit({ rpc: { url: 'http://127.0.0.1:18571', status: 'live' } })).not.toThrow();
  });

  it('builds EIP-3085 parameters with the explorer only when one is published', () => {
    const n = parseNetwork(networkJson);
    expect(addChainParameters(n)).toEqual({
      chainId: 700770,
      chainName: 'Bloch L2',
      nativeCurrency: { name: 'Bloch', symbol: 'BLCH', decimals: 18 },
      rpcUrls: ['https://l2rpc.blochl1.com'],
      blockExplorerUrls: undefined,
    });
  });

  it('adds then switches the wallet to chain 0xab162', async () => {
    const { wallet, requests } = fakeWallet();
    await ensureChain(
      wallet.provider!,
      addChainParameters({ ...network, explorerUrl: 'https://x.invalid' }),
    );
    expect(requests.map((r) => r.method)).toEqual([
      'eth_chainId',
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
      'eth_chainId',
    ]);
    expect(requests[2].params![0]).toMatchObject({
      chainId: '0xab162',
      chainName: 'Bloch L2',
      rpcUrls: ['https://l2rpc.blochl1.com'],
      blockExplorerUrls: ['https://x.invalid'],
    });
  });
});

describe('mainnet deployment record', () => {
  it('keeps the committed placeholder "not yet live" without verifying anything', async () => {
    const state = await loadMainnetState(bundledRecord, bundledNetwork());
    expect(state).toEqual({
      status: 'not-live',
      reasons: [
        'No verified mainnet deployment record has been published.',
        'The public L2 RPC is not published yet.',
        'The reviewed L2 genesis hash is not pinned yet.',
      ],
    });
  });

  it('stays not live with a real record while the RPC is a placeholder or the genesis is unpinned', async () => {
    const record = {
      schemaVersion: 1,
      domain: 'postern.dex.frontend-record.v1',
      status: 'liquidity-enabled',
      ...mainnetRecord(),
    };
    expect((await loadMainnetState(record, { ...network, rpcLive: false })).status).toBe(
      'not-live',
    );
    expect((await loadMainnetState(record, { ...network, genesisHash: null })).status).toBe(
      'not-live',
    );
  });

  it('verifies a chain-700770 record and refuses a rehearsal record or another genesis', async () => {
    const wrap = (r: object) => ({
      schemaVersion: 1,
      domain: 'postern.dex.frontend-record.v1',
      status: 'liquidity-enabled',
      ...r,
    });
    const live = await loadMainnetState(wrap(mainnetRecord()), network);
    expect(live.status).toBe('live');
    if (live.status === 'live') {
      expect(live.deployment).toMatchObject({ chainId: 700770, router: ROUTER, lens: LENS });
      expect(live.deployment.path).toBe('deployments/mainnet/dex-mainnet.record.json');
      // The recorded Multicall3 joins the code hashes checked at the finalized block.
      expect(live.multicall3).toBe(MULTICALL);
      expect(live.deployment.codeHashes[MULTICALL]).toBe(MULTICALL3_CODE_HASH);
    }
    await expect(loadMainnetState(wrap(committedRecord), network)).rejects.toThrow(
      /not a chain 700770 deployment/,
    );
    await expect(
      loadMainnetState(wrap(mainnetRecord()), { ...network, genesisHash: `0x${'1'.repeat(64)}` }),
    ).rejects.toThrow(/reviewed network genesis/);
    await expect(
      loadMainnetState({ ...wrap(mainnetRecord()), status: 'maybe' }, network),
    ).rejects.toThrow(/record status/);
    await expect(
      loadMainnetState(wrap({ ...mainnetRecord(), infra: undefined }), network),
    ).rejects.toThrow(/no infra plan/);
    const badHash = mainnetRecord();
    badHash.infra.contracts.multicall3.codeHash = `0x${'1'.repeat(64)}`;
    await expect(loadMainnetState(wrap(badHash), network)).rejects.toThrow(/not canonical/);
    const refused = mainnetRecord();
    refused.gateReport.decision = 'refused';
    await expect(loadMainnetState(wrap(refused), network)).rejects.toThrow(/did not enable/);
    // The devnet4 route still accepts only its rehearsal record.
    await expect(verifyDeploymentRecord(mainnetRecord())).rejects.toThrow(/devnet4 rehearsal/);
  });
});

describe('finality age', () => {
  const at = (nowMs: number) => {
    const { rpc, state } = fakeChain();
    const { wallet } = fakeWallet(state);
    return render(
      <MainnetLive
        network={network}
        load={async () => ({ status: 'live', deployment })}
        rpc={rpc}
        wallet={wallet}
        planned={PLANNED}
        now={() => nowMs}
      />,
    );
  };
  const finalizedMs = Number(FINALIZED.timestamp) * 1000;

  it('states the age of the finalized block in normal operation, with no alert', async () => {
    const view = at(finalizedMs + 20 * 60_000);
    await screen.findByRole('table');
    expect(screen.getByLabelText('Finality age').textContent).toContain('is 20 min old');
    expect(screen.getByLabelText('Finality age').getAttribute('role')).toBeNull();
    view.unmount();
  });

  it('warns past the monitor age during a stall and keeps the pools readable', async () => {
    const view = at(finalizedMs + (150 * 60 + 1) * 1000);
    await screen.findByRole('table');
    const notice = screen.getByLabelText('Finality age');
    expect(notice.getAttribute('role')).toBe('alert');
    expect(notice.textContent).toContain('looks stalled');
    expect(notice.textContent).toContain('2 h 30 min old');
    view.unmount();
  });
});

describe('reserve cap checks', () => {
  const token = (address: Address, symbol: string, decimals: number) => ({
    address,
    symbol,
    decimals,
    cap: 0n,
    wrapped: symbol === 'WBLCH',
  });
  const pool: LivePool = {
    address: USD_PAIR,
    token0: token(BUSDC, 'bUSDC', 6),
    token1: token(WBLCH, 'WBLCH', 18),
    reserve0: 900_000_000n,
    reserve1: 5n * 10n ** 18n,
    cap0: 1_000_000_000n,
    cap1: 10n ** 19n,
  };

  it('explains a swap that would lift a reserve above its cap, with the input that still fits', () => {
    const check = checkRoute([pool], [BUSDC, WBLCH], 150_000_000n);
    expect(check.block).toMatchObject({ kind: 'reserve-cap', maxInput: 100_000_000n });
    expect(explainBlock(check.block!)).toBe(
      'The bUSDC/WBLCH pool would revert with BDEX: RESERVE_CAP: its bUSDC reserve would reach ' +
        '1050 bUSDC, above the fixed cap of 1000 bUSDC. At most 100 bUSDC more fits into this pool.',
    );
    expect(checkRoute([pool], [BUSDC, WBLCH], 100_000_000n).block).toBeNull();
  });

  it('reports paused inflow at the cap, missing pools, empty pools and headroom use', () => {
    const full = { ...pool, reserve0: pool.cap0 };
    expect(headroom(full.reserve0, full.cap0)).toBe(0n);
    expect(headroom(1n, 0n)).toBeNull();
    expect(explainBlock(checkRoute([full], [BUSDC, WBLCH], 1n).block!)).toMatch(
      /inflow into this pool is paused/,
    );
    expect(checkRoute([pool], [BUSDC, WGSMH], 1n).block?.kind).toBe('no-pool');
    expect(checkRoute([{ ...pool, reserve1: 0n }], [BUSDC, WBLCH], 1n).block?.kind).toBe(
      'no-liquidity',
    );
    const uses = headroomUse([pool], [BUSDC, WBLCH], [50_000_000n, 1n]);
    expect(uses.map((u) => [u.token.symbol, u.bps])).toEqual([['bUSDC', 5_000n]]);
  });
});

describe('mainnet route', () => {
  it('shows "Not yet live" with the planned caps and sends no RPC request', async () => {
    const { rpc, state } = fakeChain();
    const { wallet, requests } = fakeWallet();
    render(
      <MainnetLive
        network={bundledNetwork()}
        load={() => loadMainnetState(bundledRecord, bundledNetwork())}
        rpc={rpc}
        wallet={wallet}
        planned={PLANNED}
      />,
    );
    const panel = await screen.findByLabelText('Not yet live');
    expect(panel.textContent).toContain('10 WBLCH');
    expect(panel.textContent).not.toContain('wGSMH');
    expect(panel.textContent).toContain('1000 bUSDC');
    expect(panel.textContent).toContain('Pools: WBLCH/bUSDC.');
    expect(screen.getByLabelText('Network').textContent).toContain('0xab162');
    expect(screen.getByLabelText('Network').textContent).toContain('placeholder');
    expect(screen.getByLabelText('Bridges').textContent).toMatch(/bUSDC.*not live yet/);
    expect(screen.queryByRole('button', { name: 'Swap' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Add or switch/ })).toBeNull();
    expect(state.sent).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it('says a pool closed by excess is closed, not that more can flow in', async () => {
    const { rpc, state } = fakeChain();
    state.reserves[USD_PAIR] = [800_000_000n, 8n * 10n ** 18n, 1];
    state.excess = {
      [USD_PAIR]: {
        excess0: 200_000_000n,
        excess1: 2n * 10n ** 18n,
        blocksInflow0: false,
        blocksInflow1: false,
      },
    };
    const { wallet } = fakeWallet(state);
    render(
      <MainnetLive
        network={network}
        load={async () => ({ status: 'live', deployment })}
        rpc={rpc}
        wallet={wallet}
        planned={PLANNED}
        now={() => NOW_MS}
      />,
    );
    const table = await screen.findByRole('table');
    expect(table.textContent).toContain('bUSDC inflow closed until someone calls skim');
    expect(table.textContent).toContain('BLCH inflow closed until someone calls skim');
    expect(table.textContent).not.toContain('bUSDC more can flow in');
    expect(table.textContent).toContain('This pool is closed');
    expect(screen.queryByLabelText('K ceiling')).toBeNull();
  });

  it('reads pools, caps and balances at the finalized block, quotes there, approves the exact amount and swaps with a 60-minute deadline', async () => {
    const user = userEvent.setup();
    const { rpc, state } = fakeChain();
    const { wallet, requests } = fakeWallet(state);
    render(
      <MainnetLive
        network={network}
        load={async () => ({ status: 'live', deployment })}
        rpc={rpc}
        wallet={wallet}
        planned={PLANNED}
        now={() => NOW_MS}
      />,
    );
    const table = await screen.findByRole('table');
    expect(within(table).getByText('bUSDC/WBLCH')).toBeTruthy();
    expect(table.textContent).toContain('1000 bUSDC (0.55% used)');
    expect(table.textContent).toContain('994.428785 bUSDC more can flow in');
    expect((await screen.findByLabelText('Finalized balances')).textContent).toContain(
      '1 BLCH · 0 wGSMH · 25 bUSDC',
    );
    expect((screen.getByLabelText('Deadline (minutes)') as HTMLInputElement).value).toBe('60');
    expect((screen.getByLabelText('Slippage tolerance (%)') as HTMLInputElement).value).toBe(
      '0.50',
    );

    await user.selectOptions(screen.getByLabelText('You pay'), 'bUSDC');
    await user.selectOptions(screen.getByLabelText('You receive'), 'wGSMH');
    await user.type(screen.getByLabelText('Amount'), '1');
    await user.click(screen.getByRole('button', { name: 'Get quote' }));
    const quote = await screen.findByLabelText('Quote');
    expect(quote.textContent).toContain('bUSDC → BLCH → wGSMH');
    expect(quote.textContent).toContain('Finalized block 440');
    expect(quote.textContent).toMatch(/bUSDC\/WBLCH: 0\.10% of the bUSDC headroom/);
    expect(screen.getByLabelText('Revert conditions').textContent).toContain('RESERVE_CAP');

    // Every read went to the finalized block hash, except the one lens quote
    // used only as the stale-price cross-check.
    const at = JSON.stringify({ blockHash: FINALIZED.hash });
    const reads = state.sent.filter((s) =>
      ['eth_call', 'eth_getBalance', 'eth_getCode'].includes(s.method),
    );
    expect(reads.length).toBeGreaterThan(10);
    const atLatest = reads.filter((s) => s.params[1] === 'latest');
    expect(atLatest).toHaveLength(1);
    const latestData = (atLatest[0].params[0] as { data: Hex }).data;
    expect(decodeFunctionData({ abi: LENS_ABI, data: latestData }).functionName).toBe(
      'bestExactInput',
    );
    expect(
      reads
        .filter((s) => s.params[1] !== 'latest')
        .every((s) => JSON.stringify(s.params[1]) === at),
    ).toBe(true);

    await user.click(await screen.findByRole('button', { name: /Approve 1 bUSDC/ }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull());
    expect(requests.slice(0, 5).map((r) => r.method)).toEqual([
      'eth_chainId',
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
      'eth_chainId',
      'eth_sendTransaction',
    ]);
    expect(requests[2].params![0]).toMatchObject({
      chainId: '0xab162',
      rpcUrls: ['https://l2rpc.blochl1.com'],
      blockExplorerUrls: ['https://explorer.example.invalid'],
    });
    const approve = requests[4].params![0] as { to: Address; data: Hex };
    expect(approve.to).toBe(BUSDC);
    expect(norm(decodeFunctionData({ abi: ERC20_ABI, data: approve.data }).args)).toEqual([
      ROUTER,
      1_000_000n,
    ]);

    await user.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() =>
      expect(requests.filter((r) => r.method === 'eth_sendTransaction')).toHaveLength(2),
    );
    const swap = requests.filter((r) => r.method === 'eth_sendTransaction')[1].params![0] as {
      to: Address;
      data: Hex;
    };
    expect(swap.to).toBe(ROUTER);
    const decoded = decodeFunctionData({ abi: ROUTER_ABI, data: swap.data });
    expect(decoded.functionName).toBe('swapExactTokensForTokens');
    expect(norm(decoded.args)).toEqual([
      1_000_000n,
      30_845_000n,
      [BUSDC, WBLCH, WGSMH],
      ACCOUNT,
      BigInt(NOW_MS / 1000 + 60 * 60),
    ]);
    const link = await screen.findAllByRole('link', { name: /^0x0+5$/ });
    expect(link[0].getAttribute('href')).toBe(
      `https://explorer.example.invalid/tx/0x${'5'.padStart(64, '0')}`,
    );
  });

  it('explains why no route can fill an amount that would exceed a reserve cap', async () => {
    const user = userEvent.setup();
    const { rpc, state } = fakeChain({
      quote: { available: false, amountOut: 0n, minimumOut: 0n },
    });
    const { wallet, requests } = fakeWallet(state);
    render(
      <MainnetLive
        network={network}
        load={async () => ({ status: 'live', deployment })}
        rpc={rpc}
        wallet={wallet}
        planned={PLANNED}
      />,
    );
    await screen.findByRole('table');
    await user.selectOptions(screen.getByLabelText('You pay'), 'bUSDC');
    await user.selectOptions(screen.getByLabelText('You receive'), 'BLCH');
    await user.type(screen.getByLabelText('Amount'), '1000');
    await user.click(screen.getByRole('button', { name: 'Get quote' }));
    const why = await screen.findByLabelText('Why this swap would revert');
    expect(why.textContent).toContain('BDEX: RESERVE_CAP');
    expect(why.textContent).toContain('At most 994.428785 bUSDC more fits into this pool');
    expect((screen.getByRole('button', { name: 'Swap' }) as HTMLButtonElement).disabled).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it('blocks a swap above the finalized balance and refuses out-of-range settings', async () => {
    const user = userEvent.setup();
    const { rpc, state } = fakeChain();
    const { wallet } = fakeWallet(state);
    render(
      <MainnetLive
        network={network}
        load={async () => ({ status: 'live', deployment })}
        rpc={rpc}
        wallet={wallet}
        planned={PLANNED}
      />,
    );
    await screen.findByLabelText('Finalized balances');
    await user.selectOptions(screen.getByLabelText('You pay'), 'bUSDC');
    await user.selectOptions(screen.getByLabelText('You receive'), 'BLCH');
    await user.type(screen.getByLabelText('Amount'), '30');
    await user.clear(screen.getByLabelText('Deadline (minutes)'));
    await user.type(screen.getByLabelText('Deadline (minutes)'), '500');
    await user.click(screen.getByRole('button', { name: 'Get quote' }));
    expect(await screen.findByText(/deadline of 10 to 180 minutes/)).toBeTruthy();
    await user.clear(screen.getByLabelText('Deadline (minutes)'));
    await user.type(screen.getByLabelText('Deadline (minutes)'), '60');
    await user.clear(screen.getByLabelText('Slippage tolerance (%)'));
    await user.type(screen.getByLabelText('Slippage tolerance (%)'), '3.01');
    await user.click(screen.getByRole('button', { name: 'Get quote' }));
    expect(await screen.findByText(/0.01% to 3.00%/)).toBeTruthy();
    await user.clear(screen.getByLabelText('Slippage tolerance (%)'));
    await user.type(screen.getByLabelText('Slippage tolerance (%)'), '4');
    await user.click(screen.getByRole('button', { name: 'Get quote' }));
    expect(await screen.findByText(/0.01% to 3.00%/)).toBeTruthy();
    await user.clear(screen.getByLabelText('Slippage tolerance (%)'));
    await user.type(screen.getByLabelText('Slippage tolerance (%)'), '0.5');
    await user.click(screen.getByRole('button', { name: 'Get quote' }));
    expect(await screen.findByText(/balance \(25\) is below the amount/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Swap' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('refuses to show pools when the RPC serves another genesis', async () => {
    const { rpc } = fakeChain();
    const other: Rpc = async (method, params) =>
      method === 'eth_getBlockByNumber' && params[0] === '0x0'
        ? { hash: `0x${'2'.repeat(64)}` }
        : rpc(method, params);
    const { wallet } = fakeWallet();
    render(
      <MainnetLive
        network={network}
        load={async () => ({ status: 'live', deployment })}
        rpc={other}
        wallet={wallet}
        planned={PLANNED}
      />,
    );
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /mainnet: the RPC genesis differs.*No transaction can be sent/,
    );
    expect(screen.queryByRole('table')).toBeNull();
  });

  describe('stale quote cross-check', () => {
    const open = async (change: Partial<ChainState>) => {
      const user = userEvent.setup();
      const { rpc, state } = fakeChain({ allowance: 10n ** 12n, ...change });
      const { wallet, requests } = fakeWallet(state);
      render(
        <MainnetLive
          network={network}
          load={async () => ({ status: 'live', deployment })}
          rpc={rpc}
          wallet={wallet}
          planned={PLANNED}
          now={() => NOW_MS}
        />,
      );
      await screen.findByRole('table');
      await screen.findByLabelText('Finalized balances');
      await user.selectOptions(screen.getByLabelText('You pay'), 'bUSDC');
      await user.selectOptions(screen.getByLabelText('You receive'), 'BLCH');
      await user.type(screen.getByLabelText('Amount'), '1');
      await user.click(screen.getByRole('button', { name: 'Get quote' }));
      await screen.findByLabelText('Quote');
      const sends = () => requests.filter((r) => r.method === 'eth_sendTransaction');
      return { user, sends, chain: state };
    };
    const worse = { available: true, amountOut: 30_000_000n, minimumOut: 29_850_000n };

    it('blocks the swap when the latest quote is below the minimum, until the user reconfirms at that price', async () => {
      const { user, sends } = await open({ latestQuote: worse });
      const warning = await screen.findByLabelText('Stale quote');
      expect(warning.textContent).toContain('3.22% worse');
      const swap = screen.getByRole('button', { name: 'Swap' }) as HTMLButtonElement;
      expect(swap.disabled).toBe(true);
      await user.click(screen.getByRole('button', { name: /Reconfirm at the latest price/ }));
      expect(screen.getByLabelText('Quote').textContent).toContain(
        'Latest block 500, not finalized',
      );
      expect(screen.queryByLabelText('Stale quote')).toBeNull();
      expect(swap.disabled).toBe(false);
      await user.click(swap);
      await waitFor(() => expect(sends()).toHaveLength(1));
      const data = (sends()[0].params![0] as { data: Hex }).data;
      // The reconfirmed minimum, not the finalized one, goes on chain.
      expect(decodeFunctionData({ abi: ROUTER_ABI, data }).args![1]).toBe(29_850_000n);
    });

    it('does not warn or ask again while the latest quote stays within the slippage', async () => {
      const within = { available: true, amountOut: 30_900_000n, minimumOut: 30_745_000n };
      await open({ latestQuote: within });
      expect(screen.queryByLabelText('Stale quote')).toBeNull();
      expect((screen.getByRole('button', { name: 'Swap' }) as HTMLButtonElement).disabled).toBe(
        false,
      );
      expect(screen.getByLabelText('Quote').textContent).toContain('Finalized block 440');
    });

    it('blocks when no route fills the amount at the latest block', async () => {
      await open({ latestQuote: { available: false, amountOut: 0n, minimumOut: 0n } });
      expect((await screen.findByLabelText('Stale quote')).textContent).toContain(
        'no route can fill',
      );
      expect((screen.getByRole('button', { name: 'Swap' }) as HTMLButtonElement).disabled).toBe(
        true,
      );
      expect(screen.queryByRole('button', { name: /Reconfirm/ })).toBeNull();
    });

    it('re-checks when Swap is pressed and stops if the price has moved since the quote', async () => {
      const { user, sends } = await open({});
      const state = fakeState.current!;
      state.latestQuote = worse;
      await user.click(screen.getByRole('button', { name: 'Swap' }));
      expect((await screen.findByLabelText('Stale quote')).textContent).toContain('worse');
      expect(sends()).toHaveLength(0);
    });

    it('shows no trading while the RPC answers finalized with -32001', async () => {
      const { state, rpc } = fakeChain({ finalityDown: true });
      const { wallet } = fakeWallet(state);
      render(
        <MainnetLive
          network={network}
          load={async () => ({ status: 'live', deployment })}
          rpc={rpc}
          wallet={wallet}
          planned={PLANNED}
          now={() => NOW_MS}
        />,
      );
      expect((await screen.findByRole('alert')).textContent).toContain(
        'Mainnet reads are unavailable',
      );
      expect(screen.queryByRole('button', { name: 'Get quote' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Swap' })).toBeNull();
    });

    it('sends nothing when finality goes away after the page was read', async () => {
      const { user, sends, chain } = await open({});
      chain.finalityDown = true;
      await user.click(await screen.findByRole('button', { name: 'Swap' }));
      await screen.findByText(/L2 finality is unavailable, so nothing was sent/);
      expect(sends()).toHaveLength(0);
    });

    it('keeps the finalized quote and says so when the latest block cannot be read', async () => {
      await open({ latestDown: true });
      expect((await screen.findByLabelText('Stale quote')).textContent).toContain(
        'not cross-checked',
      );
      expect((screen.getByRole('button', { name: 'Swap' }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    });

    it('compares against the minimum output of the active quote', () => {
      const base = {
        path: [],
        amountIn: 1n,
        amounts: [],
        executionLossBps: [],
        blockNumber: 1n,
      };
      const active = { ...base, amountOut: 1000n, minimumOut: 995n };
      expect(compareQuotes(active, { ...active, amountOut: 995n }).status).toBe('ok');
      expect(compareQuotes(active, { ...active, amountOut: 2000n }).status).toBe('ok');
      const check = compareQuotes(active, { ...active, amountOut: 994n });
      expect(check).toMatchObject({ status: 'worse', worseBps: 60n });
      expect(blocksSwap(check)).toBe(true);
      expect(blocksSwap(compareQuotes(active, null))).toBe(true);
      expect(blocksSwap({ status: 'unknown' })).toBe(false);
      expect(blocksSwap(null)).toBe(false);
    });
  });

  describe('pending excess', () => {
    const excess = {
      [USD_PAIR]: {
        excess0: 1_500_000_000n,
        excess1: 0n,
        blocksInflow0: true,
        blocksInflow1: false,
      },
    };

    it('shows the donation, says it blocks inflows, and skims to the connected wallet', async () => {
      const user = userEvent.setup();
      const { rpc, state } = fakeChain({ excess });
      const { wallet, requests } = fakeWallet(state);
      render(
        <MainnetLive
          network={network}
          load={async () => ({ status: 'live', deployment })}
          rpc={rpc}
          wallet={wallet}
          planned={PLANNED}
        />,
      );
      const hint = await screen.findByLabelText('Pending excess');
      expect(hint.textContent).toContain('1500 bUSDC above the reserves');
      expect(hint.textContent).toContain('revert until someone calls skim');
      await user.click(within(hint).getByRole('button', { name: 'Skim to my wallet' }));
      await waitFor(() =>
        expect(requests.filter((r) => r.method === 'eth_sendTransaction')).toHaveLength(1),
      );
      const tx = requests.find((r) => r.method === 'eth_sendTransaction')!.params![0] as {
        to: Address;
        data: Hex;
      };
      expect(tx.to).toBe(USD_PAIR);
      expect(tx.data).toBe(skimTransaction(USD_PAIR, ACCOUNT).data);
      expect(tx.data.slice(0, 10)).toBe('0xbc25cf77');
    });

    it('shows no hint without a donation', async () => {
      const { rpc, state } = fakeChain();
      const { wallet } = fakeWallet(state);
      render(
        <MainnetLive
          network={network}
          load={async () => ({ status: 'live', deployment })}
          rpc={rpc}
          wallet={wallet}
          planned={PLANNED}
        />,
      );
      await screen.findByRole('table');
      expect(screen.queryByLabelText('Pending excess')).toBeNull();
    });

    it('explains a route blocked by a donation on either side', () => {
      const t = (address: Address, symbol: string, decimals: number) => ({
        address,
        symbol,
        decimals,
        cap: 0n,
        wrapped: false,
      });
      const pool: LivePool = {
        address: USD_PAIR,
        token0: t(BUSDC, 'bUSDC', 6),
        token1: t(WBLCH, 'WBLCH', 18),
        reserve0: 500_000_000n,
        reserve1: 5n * 10n ** 18n,
        cap0: 1_000_000_000n,
        cap1: 10n ** 19n,
        excess: excess[USD_PAIR],
      };
      const into = checkRoute([pool], [BUSDC, WBLCH], 1_000_000n);
      expect(into.block).toMatchObject({ kind: 'pending-excess', excess: 1_500_000_000n });
      expect(explainBlock(into.block!)).toMatch(/holds 1500 bUSDC above its reserves.*skim/);
      const outOf = checkRoute([pool], [WBLCH, BUSDC], 10n ** 16n);
      expect(outOf.block?.kind).toBe('pending-excess');
      const small = {
        ...pool,
        excess: { excess0: 1n, excess1: 0n, blocksInflow0: false, blocksInflow1: false },
      };
      expect(checkRoute([small], [BUSDC, WBLCH], 1_000_000n).block).toBeNull();
    });
  });

  it('reads balances in one finalized aggregate3 call through the recorded Multicall3', async () => {
    const sent: { method: string; params: unknown[] }[] = [];
    const tokens = [
      { address: WBLCH, symbol: 'WBLCH', decimals: 18, cap: 0n, wrapped: true },
      { address: BUSDC, symbol: 'bUSDC', decimals: 6, cap: 0n, wrapped: false },
    ];
    const word = (v: bigint) => `0x${v.toString(16).padStart(64, '0')}` as Hex;
    const rpc: Rpc = async (method, params) => {
      sent.push({ method, params });
      return encodeFunctionResult({
        abi: MULTICALL3_ABI,
        functionName: 'aggregate3',
        result: [
          { success: true, returnData: word(7n) },
          { success: true, returnData: word(8n) },
          { success: true, returnData: word(9n) },
        ],
      });
    };
    const b = await readBalances(rpc, FINALIZED.hash as Hex, ACCOUNT, tokens, MULTICALL);
    expect(b.native).toBe(7n);
    expect(b.tokens.get(WBLCH)).toBe(8n);
    expect(b.tokens.get(BUSDC)).toBe(9n);
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe('eth_call');
    expect(sent[0].params[1]).toEqual({ blockHash: FINALIZED.hash });
    expect((sent[0].params[0] as { to: Address }).to).toBe(MULTICALL);
  });
});

// Agent 51 review. These three tests fail on the RC.
describe('review51 transaction safety', () => {
  const mount = async (rpc: Rpc, chain: ChainState) => {
    const user = userEvent.setup();
    const { wallet, requests } = fakeWallet(chain);
    render(
      <MainnetLive
        network={network}
        load={async () => ({ status: 'live', deployment })}
        rpc={rpc}
        wallet={wallet}
        planned={PLANNED}
        now={() => NOW_MS}
      />,
    );
    await screen.findByRole('table');
    await screen.findByLabelText('Finalized balances');
    await user.selectOptions(screen.getByLabelText('You pay'), 'bUSDC');
    await user.selectOptions(screen.getByLabelText('You receive'), 'BLCH');
    const sends = () => requests.filter((r) => r.method === 'eth_sendTransaction');
    return { user, sends };
  };

  it('F3: a much better latest price must tighten the signed minimum', async () => {
    const { rpc, state } = fakeChain({
      allowance: 10n ** 12n,
      latestQuote: { available: true, amountOut: 60_000_000n, minimumOut: 59_700_000n },
    });
    const { user, sends } = await mount(rpc, state);
    await user.type(screen.getByLabelText('Amount'), '1');
    await user.click(screen.getByRole('button', { name: 'Get quote' }));
    await screen.findByLabelText('Quote');
    await user.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    const data = (sends()[0].params![0] as { data: Hex }).data;
    expect(decodeFunctionData({ abi: ROUTER_ABI, data }).args![1]).toBeGreaterThanOrEqual(
      59_700_000n,
    );
  });

  it('F4: one failed receipt poll must not report a pending swap as failed', async () => {
    const { rpc, state } = fakeChain({ allowance: 10n ** 12n });
    let polls = 0;
    let settle: (value: unknown) => void = () => {};
    const flaky: Rpc = (method, params) => {
      if (method === 'eth_getTransactionReceipt' && ++polls === 1)
        return Promise.reject(new Error('eth_getTransactionReceipt returned HTTP 502'));
      if (method === 'eth_getTransactionReceipt') return new Promise((r) => (settle = r));
      return rpc(method, params);
    };
    const { user } = await mount(flaky, state);
    await user.type(screen.getByLabelText('Amount'), '1');
    await user.click(screen.getByRole('button', { name: 'Get quote' }));
    await screen.findByLabelText('Quote');
    await user.click(screen.getByRole('button', { name: 'Swap' }));
    const list = await screen.findByLabelText('Transactions');
    await waitFor(() => expect(polls).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    settle(null);
    expect(list.textContent).not.toContain('failed');
  });

  it('F5: a quote that resolves after the amount was edited must not be sendable', async () => {
    const { rpc, state } = fakeChain({ allowance: 10n ** 12n });
    let release: () => void = () => {};
    let hold = true;
    const slow: Rpc = async (method, params) => {
      const data = (params[0] as { data?: Hex } | undefined)?.data ?? '';
      if (method === 'eth_call' && hold && data.startsWith('0x') && params[1] !== 'latest') {
        const name = (() => {
          try {
            return decodeFunctionData({ abi: LENS_ABI, data: data as Hex }).functionName;
          } catch {
            return '';
          }
        })();
        if (name === 'bestExactInput') await new Promise<void>((r) => (release = r));
      }
      return rpc(method, params);
    };
    const { user, sends } = await mount(slow, state);
    const amount = screen.getByLabelText('Amount');
    await user.type(amount, '20');
    await user.click(screen.getByRole('button', { name: 'Get quote' }));
    await user.clear(amount);
    await user.type(amount, '1');
    hold = false;
    release();
    await screen.findByLabelText('Quote');
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Swap' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(sends()).toHaveLength(1));
    const data = (sends()[0].params![0] as { data: Hex }).data;
    // The form says 1 bUSDC; the wallet must not be handed 20.
    expect(decodeFunctionData({ abi: ROUTER_ABI, data }).args![0]).toBe(1_000_000n);
  });
});

describe('swap panel safety fixes', () => {
  const HASH = `0x${'a'.repeat(64)}` as Hex;
  const swapButton = () => screen.getByRole('button', { name: 'Swap' }) as HTMLButtonElement;
  const router = (data: Hex) => decodeFunctionData({ abi: ROUTER_ABI, data }).args!;
  const app = (rpc: Rpc, wallet: Devnet4Wallet) => (
    <MainnetLive
      network={network}
      load={async () => ({ status: 'live', deployment })}
      rpc={rpc}
      wallet={wallet}
      planned={PLANNED}
      now={() => NOW_MS}
      receiptPollMs={5}
    />
  );
  const mount = async (
    rpc: Rpc,
    chain: ChainState,
    change?: (w: Devnet4Wallet) => Devnet4Wallet,
  ) => {
    const user = userEvent.setup();
    const { wallet, requests } = fakeWallet(chain);
    const view = render(app(rpc, change ? change(wallet) : wallet));
    await screen.findByRole('table');
    await screen.findByLabelText('Finalized balances');
    await user.selectOptions(screen.getByLabelText('You pay'), 'bUSDC');
    await user.selectOptions(screen.getByLabelText('You receive'), 'BLCH');
    const sends = () => requests.filter((r) => r.method === 'eth_sendTransaction');
    return { user, sends, wallet, view };
  };
  const quoted = async (user: ReturnType<typeof userEvent.setup>, amount = '1') => {
    await user.type(screen.getByLabelText('Amount'), amount);
    await user.click(screen.getByRole('button', { name: 'Get quote' }));
    await screen.findByLabelText('Quote');
    await waitFor(() => expect(swapButton().disabled).toBe(false));
  };
  /** Receipt replies under test control; everything else goes to the fake chain. */
  const withReceipts =
    (rpc: Rpc, reply: () => unknown, head?: () => unknown): Rpc =>
    (m, p) => {
      if (m === 'eth_getTransactionReceipt') return Promise.resolve().then(reply);
      if (m === 'eth_getBlockByNumber' && p[0] === 'latest')
        return Promise.resolve().then(head ?? (() => null));
      return rpc(m, p);
    };
  const MINED = { status: '0x1', blockNumber: '0x1ba', gasUsed: '0x2a50a' };
  const REVERTED = { status: '0x0', blockNumber: '0x1ba', gasUsed: '0x2a50a' };
  const pause = (ms = 40) => new Promise((r) => setTimeout(r, ms));

  describe('F3: the signed minimum follows a better latest price', () => {
    const base = { amountIn: 1n, amounts: [], executionLossBps: [], blockNumber: 1n };
    const active = {
      ...base,
      path: ['0xa', '0xb'] as Address[],
      amountOut: 1000n,
      minimumOut: 995n,
    };

    it('never lowers the minimum, and ignores a quote for another amount', () => {
      const lower = { ...active, amountOut: 999n, minimumOut: 994n };
      const higher = { ...active, amountOut: 2000n, minimumOut: 1990n };
      expect(signedQuote(active, null).minimumOut).toBe(995n);
      expect(signedQuote(active, { status: 'unknown' }).minimumOut).toBe(995n);
      expect(signedQuote(active, { status: 'ok', latest: lower }).minimumOut).toBe(995n);
      expect(signedQuote(active, { status: 'ok', latest: higher })).toMatchObject({
        amountOut: 2000n,
        minimumOut: 1990n,
      });
      expect(signedQuote(active, { status: 'unknown', last: higher }).minimumOut).toBe(1990n);
      expect(
        signedQuote(active, { status: 'ok', latest: { ...higher, amountIn: 2n } }).minimumOut,
      ).toBe(995n);
    });

    it('takes the route together with a minimum from another route', () => {
      const other = {
        ...active,
        path: ['0xa', '0xc', '0xb'] as Address[],
        amounts: [1n, 2n, 2000n],
        amountOut: 2000n,
        minimumOut: 1990n,
        blockNumber: 9n,
      };
      expect(signedQuote(active, { status: 'ok', latest: other })).toMatchObject({
        path: other.path,
        amounts: other.amounts,
        minimumOut: 1990n,
        amountOut: 2000n,
        blockNumber: 1n,
      });
    });

    it('shows the minimum it signs, while the quote stays a finalized one', async () => {
      const { rpc, state } = fakeChain({
        allowance: 10n ** 12n,
        latestQuote: { available: true, amountOut: 60_000_000n, minimumOut: 59_700_000n },
      });
      const { user } = await mount(rpc, state);
      await quoted(user);
      const panel = screen.getByLabelText('Quote').textContent!;
      expect(panel).toContain('better price at the latest block');
      expect(panel).toContain('Finalized block 440');
      expect(panel).toContain('Amount in1 bUSDC');
    });

    it('keeps a tightened minimum when the latest read then fails, and only notes it', async () => {
      const { rpc, state } = fakeChain({
        allowance: 10n ** 12n,
        latestQuote: { available: true, amountOut: 60_000_000n, minimumOut: 59_700_000n },
      });
      const { user, sends } = await mount(rpc, state);
      await quoted(user);
      state.latestDown = true;
      await user.click(swapButton());
      await waitFor(() => expect(sends()).toHaveLength(1));
      expect(router((sends()[0].params![0] as { data: Hex }).data)[1]).toBe(59_700_000n);
      expect(screen.getByLabelText('Stale quote').textContent).toContain('not cross-checked');
    });

    it('signs the finalized minimum when the latest block was never readable', async () => {
      const { rpc, state } = fakeChain({ allowance: 10n ** 12n, latestDown: true });
      const { user, sends } = await mount(rpc, state);
      await quoted(user);
      await user.click(swapButton());
      await waitFor(() => expect(sends()).toHaveLength(1));
      expect(router((sends()[0].params![0] as { data: Hex }).data)[1]).toBe(30_845_000n);
    });
  });

  describe('F4: Swap stays disabled until the outcome is known', () => {
    const sendOne = async (rpc: Rpc, state: ChainState) => {
      const mounted = await mount(rpc, state);
      await quoted(mounted.user);
      await mounted.user.click(swapButton());
      await waitFor(() => expect(mounted.sends()).toHaveLength(1));
      await screen.findByLabelText('Transactions');
      return mounted;
    };
    const steps = () => screen.getByLabelText('Transactions').textContent!;

    it('holds through failing polls, then releases on the receipt', async () => {
      const { rpc, state } = fakeChain({ allowance: 10n ** 12n });
      let reply: () => unknown = () => {
        throw new Error('HTTP 502');
      };
      await sendOne(
        withReceipts(rpc, () => reply()),
        state,
      );
      await waitFor(() => expect(steps()).toContain('did not answer'));
      await pause();
      expect(steps()).not.toContain('failed');
      expect(swapButton().disabled).toBe(true);
      reply = () => null;
      await waitFor(() => expect(steps()).toContain('Waiting for the next L2 block'));
      expect(swapButton().disabled).toBe(true);
      reply = () => MINED;
      await waitFor(() => expect(steps()).toContain('Mined in block 442'));
      await waitFor(() => expect(swapButton().disabled).toBe(false));
    });

    it('holds across a page reload, and a reverted receipt then releases it', async () => {
      const { rpc, state } = fakeChain({ allowance: 10n ** 12n });
      let reply: () => unknown = () => null;
      const flaky = withReceipts(rpc, () => reply());
      const { view } = await sendOne(flaky, state);
      const stored = localStorage.getItem(pendingSwapKey(network.chainId, ACCOUNT));
      expect(parsePendingSwap(stored)?.label).toBe('Swap 1 bUSDC for BLCH');
      view.unmount();

      const again = await mount(flaky, state);
      await again.user.type(screen.getByLabelText('Amount'), '1');
      await again.user.click(screen.getByRole('button', { name: 'Get quote' }));
      await screen.findByLabelText('Quote');
      expect(steps()).toContain('Swap 1 bUSDC for BLCH: pending');
      await pause();
      expect(swapButton().disabled).toBe(true);
      reply = () => REVERTED;
      await waitFor(() => expect(steps()).toContain('Reverted in block 442'));
      await waitFor(() => expect(swapButton().disabled).toBe(false));
      expect(localStorage.getItem(pendingSwapKey(network.chainId, ACCOUNT))).toBeNull();
    });

    it('after a mined swap, finality moving and a reload, the swap is listed as an earlier transaction', async () => {
      // Kit walk (agent 97) found the list was lost on reload. Finished transactions are
      // now kept per chain and account in localStorage.
      const { rpc, state } = fakeChain({ allowance: 10n ** 12n });
      let finalized = FINALIZED;
      const moving: Rpc = (m, p) =>
        m === 'eth_getBlockByNumber' && p[0] === 'finalized'
          ? Promise.resolve(finalized)
          : rpc(m, p);
      let reply: () => unknown = () => null;
      const chain = withReceipts(moving, () => reply());
      const { view } = await sendOne(chain, state);
      reply = () => MINED;
      await waitFor(() => expect(steps()).toContain('Mined in block 442'));
      expect(localStorage.getItem(pendingSwapKey(network.chainId, ACCOUNT))).toBeNull();
      finalized = { ...FINALIZED, number: '0x1bb', hash: `0x${'e'.repeat(64)}` };
      view.unmount();
      await mount(chain, state);
      await screen.findByText(/Pools at finalized block 443/);
      expect(screen.queryByRole('list', { name: 'Transactions' })).toBeNull();
      const earlier = await screen.findByRole('list', { name: 'Earlier transactions' });
      expect(earlier.textContent).toContain('mined');
    });

    it('holds when the panel remounts on a new finalized block', async () => {
      const { rpc, state } = fakeChain({ allowance: 10n ** 12n });
      let finalized = FINALIZED;
      const moving: Rpc = (m, p) =>
        m === 'eth_getBlockByNumber' && p[0] === 'finalized'
          ? Promise.resolve(finalized)
          : rpc(m, p);
      const { user } = await sendOne(
        withReceipts(moving, () => null),
        state,
      );
      finalized = { ...FINALIZED, number: '0x1b9', hash: `0x${'e'.repeat(64)}` };
      await user.click(screen.getByRole('button', { name: 'Refresh' }));
      await screen.findByText(/Pools at finalized block 441/);
      await user.type(screen.getByLabelText('Amount'), '1');
      await user.click(screen.getByRole('button', { name: 'Get quote' }));
      await screen.findByLabelText('Quote');
      await pause();
      expect(swapButton().disabled).toBe(true);
    });

    it('holds in memory when the browser refuses to store it', async () => {
      const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      try {
        const { rpc, state } = fakeChain({ allowance: 10n ** 12n });
        await sendOne(
          withReceipts(rpc, () => null),
          state,
        );
        await waitFor(() => expect(steps()).toContain('a reload loses this hold'));
        expect(swapButton().disabled).toBe(true);
      } finally {
        setItem.mockRestore();
      }
    });

    it('holds a record stored by another tab when Swap is pressed', async () => {
      const { rpc, state } = fakeChain({ allowance: 10n ** 12n });
      const { user, sends } = await mount(
        withReceipts(rpc, () => null),
        state,
      );
      await quoted(user);
      localStorage.setItem(
        pendingSwapKey(network.chainId, ACCOUNT),
        JSON.stringify({ hash: HASH, label: 'Other tab', deadline: '9', sentAtMs: NOW_MS }),
      );
      await user.click(swapButton());
      await waitFor(() => expect(steps()).toContain('Other tab: pending'));
      expect(sends()).toHaveLength(0);
      expect(swapButton().disabled).toBe(true);
    });

    it('sends once when Swap is pressed again during the check at Swap', async () => {
      const { rpc, state } = fakeChain({ allowance: 10n ** 12n });
      const held: (() => void)[] = [];
      let hold = false;
      const slow: Rpc = async (m, p) => {
        if (m === 'eth_call' && hold && p[1] === 'latest')
          await new Promise<void>((r) => held.push(r));
        return rpc(m, p);
      };
      const { user, sends } = await mount(
        withReceipts(slow, () => null),
        state,
      );
      await quoted(user);
      hold = true;
      await user.click(swapButton());
      await user.click(swapButton());
      hold = false;
      held.splice(0).forEach((release) => release());
      await waitFor(() => expect(sends()).toHaveLength(1));
      await pause();
      expect(sends()).toHaveLength(1);
    });

    it('releases only when the latest block is past the deadline and no receipt exists', async () => {
      const swap = { hash: HASH, label: 'x', deadline: 1_000n, sentAtMs: 0 };
      const after = 1_001_000;
      const fake =
        (receipt: () => unknown, head: () => unknown): Rpc =>
        async (m) =>
          m === 'eth_getTransactionReceipt' ? receipt() : head();
      const past = () => ({ timestamp: '0x3e9' });
      const atDeadline = () => ({ timestamp: '0x3e8' });
      const fail = () => {
        throw new Error('HTTP 502');
      };
      const none = () => null;
      const poll = (r: Rpc, at = after) => pollPendingSwap(r, swap, at);
      expect((await poll(fake(none, past), 1_000_000)).kind).toBe('waiting');
      expect((await poll(fake(none, past))).kind).toBe('expired');
      // The router accepts deadline >= block.timestamp.
      expect((await poll(fake(none, atDeadline))).kind).toBe('waiting');
      expect((await poll(fake(none, none))).kind).toBe('waiting');
      expect((await poll(fake(fail, past))).kind).toBe('unreachable');
      expect((await poll(fake(none, fail))).kind).toBe('unreachable');
      expect((await poll(fake(() => MINED, past))).kind).toBe('receipt');
    });

    it('marks a swap with no receipt after an hour as unknown and keeps holding', async () => {
      const { rpc, state } = fakeChain({ allowance: 10n ** 12n });
      const { wallet } = fakeWallet(state);
      localStorage.setItem(
        pendingSwapKey(network.chainId, ACCOUNT),
        JSON.stringify({
          hash: HASH,
          label: 'Old swap',
          deadline: String(NOW_MS),
          sentAtMs: NOW_MS - 3_600_000,
        }),
      );
      render(
        app(
          withReceipts(rpc, () => null),
          wallet,
        ),
      );
      await waitFor(() =>
        expect(screen.getByLabelText('Transactions').textContent).toContain('unknown'),
      );
      expect(steps()).toContain('Do not resend');
    });

    it('ignores a malformed stored record', () => {
      for (const raw of [null, '{', '{}', JSON.stringify({ hash: 'x', deadline: '1' })])
        expect(parsePendingSwap(raw)).toBeNull();
    });

    it('waitForReceipt retries a failed poll and ends a timeout as unknown', async () => {
      let polls = 0;
      const flaky: Rpc = async () => {
        if (++polls < 3) throw new Error('HTTP 502');
        return MINED;
      };
      const receipt = await waitForReceipt(flaky, HASH, { sleep: async () => {} });
      expect(receipt.status).toBe('success');
      expect(polls).toBe(3);
      const down: Rpc = async () => {
        throw new Error('HTTP 502');
      };
      await expect(waitForReceipt(down, HASH, { timeoutMs: 0 })).rejects.toBeInstanceOf(
        ReceiptUnknownError,
      );
    });
  });

  describe('F5: a stale quote never reaches the transaction', () => {
    const lensName = (params: unknown[]) => {
      try {
        const data = (params[0] as { data: Hex }).data;
        return decodeFunctionData({ abi: LENS_ABI, data }).functionName;
      } catch {
        return '';
      }
    };

    it('drops the old reply, quotes the current amount and labels the step from the quote', async () => {
      const { rpc, state } = fakeChain({ allowance: 10n ** 12n });
      const held: (() => void)[] = [];
      let hold = true;
      const slow: Rpc = async (m, p) => {
        if (m === 'eth_call' && hold && lensName(p) === 'bestExactInput')
          await new Promise<void>((r) => held.push(r));
        return rpc(m, p);
      };
      const { user, sends } = await mount(slow, state);
      const amount = screen.getByLabelText('Amount');
      await user.type(amount, '20');
      await user.click(screen.getByRole('button', { name: 'Get quote' }));
      await waitFor(() => expect(held).toHaveLength(1));
      await user.clear(amount);
      await user.type(amount, '1');
      // The re-quote is held too, so the old reply alone must show nothing.
      held.shift()!();
      await waitFor(() => expect(held).toHaveLength(1));
      expect(screen.queryByLabelText('Quote')).toBeNull();
      hold = false;
      held.shift()!();
      expect((await screen.findByLabelText('Quote')).textContent).toContain('Amount in1 bUSDC');
      await waitFor(() => expect(swapButton().disabled).toBe(false));
      await user.click(swapButton());
      await waitFor(() => expect(sends()).toHaveLength(1));
      expect(router((sends()[0].params![0] as { data: Hex }).data)[0]).toBe(1_000_000n);
      expect((await screen.findByLabelText('Transactions')).textContent).toContain(
        'Swap 1 bUSDC for BLCH',
      );
    });

    it('settles after two presses of Get quote with replies held', async () => {
      const { rpc, state } = fakeChain({ allowance: 10n ** 12n });
      const held: (() => void)[] = [];
      let finalizedQuotes = 0;
      const slow: Rpc = async (m, p) => {
        if (m === 'eth_call' && lensName(p) === 'bestExactInput' && p[1] !== 'latest') {
          finalizedQuotes++;
          await new Promise<void>((r) => held.push(r));
        }
        return rpc(m, p);
      };
      const { user } = await mount(slow, state);
      await user.type(screen.getByLabelText('Amount'), '1');
      const get = screen.getByRole('button', { name: 'Get quote' });
      await user.click(get);
      await user.click(get);
      await waitFor(() => expect(held).toHaveLength(2));
      held.splice(0).forEach((release) => release());
      await screen.findByLabelText('Quote');
      await pause();
      expect(finalizedQuotes).toBe(2);
    });

    it('sends nothing when the amount changes during the check at Swap', async () => {
      const { rpc, state } = fakeChain({ allowance: 10n ** 12n });
      let release: () => void = () => {};
      let hold = false;
      const slow: Rpc = async (m, p) => {
        if (m === 'eth_call' && hold && p[1] === 'latest')
          await new Promise<void>((r) => (release = r));
        return rpc(m, p);
      };
      const { user, sends } = await mount(slow, state);
      await quoted(user, '20');
      hold = true;
      await user.click(swapButton());
      await user.type(screen.getByLabelText('Amount'), '1');
      hold = false;
      release();
      await screen.findByText(/nothing was sent/);
      await pause();
      expect(sends()).toHaveLength(0);
    });

    it('sends nothing when the amount changes during the wallet network switch', async () => {
      const { rpc, state } = fakeChain({ allowance: 10n ** 12n });
      let release: () => void = () => {};
      let hold = true;
      const { user, sends } = await mount(rpc, state, (wallet) => ({
        ...wallet,
        provider: {
          request: async (args) => {
            if (args.method === 'wallet_switchEthereumChain' && hold) {
              hold = false;
              await new Promise<void>((r) => (release = r));
            }
            return wallet.provider!.request(args);
          },
        },
      }));
      await quoted(user, '20');
      await user.click(swapButton());
      await waitFor(() => expect(hold).toBe(false));
      await user.type(screen.getByLabelText('Amount'), '1');
      release();
      await waitFor(() =>
        expect(screen.getByLabelText('Transactions').textContent).toContain('nothing was sent'),
      );
      expect(sends()).toHaveLength(0);
    });
  });

  describe('DEX-5: one retry at 1% after a revert on the minimum', () => {
    const ROUTER_READ = parseAbi([
      'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
    ]);
    const BLOCK = {
      hash: `0x${'b'.repeat(64)}`,
      parentHash: `0x${'c'.repeat(64)}`,
      timestamp: `0x${(NOW_MS / 1000 + 600).toString(16)}`,
    };
    /** Reverted receipts, block 0x1ba, and the router's getAmountsOut under test control. */
    const chainWith = (
      rpc: Rpc,
      receipt: () => unknown,
      out: { atParent: bigint; atBlock: bigint },
      block = BLOCK,
    ): Rpc => {
      const base = withReceipts(rpc, receipt);
      return (m, p) => {
        if (m === 'eth_getBlockByNumber' && p[0] === '0x1ba') return Promise.resolve(block);
        if (m === 'eth_call') {
          const { to, data } = p[0] as { to: Address; data: Hex };
          if (to === deployment.router) {
            const call = decodeFunctionData({ abi: ROUTER_READ, data });
            const [amountIn] = call.args as readonly [bigint, readonly Address[]];
            const at = (p[1] as { blockHash: string }).blockHash;
            const amountOut = at === block.parentHash ? out.atParent : out.atBlock;
            return Promise.resolve(
              encodeFunctionResult({
                abi: ROUTER_READ,
                functionName: 'getAmountsOut',
                result: [amountIn, amountOut],
              } as never),
            );
          }
        }
        return base(m, p);
      };
    };
    const lensSlippage = (state: ChainState) =>
      state.sent
        .filter((c) => c.method === 'eth_call')
        .flatMap((c) => {
          try {
            const call = decodeFunctionData({
              abi: LENS_ABI as Abi,
              data: (c.params[0] as { data: Hex }).data,
            });
            return call.functionName === 'bestExactInput' ? [(call.args as bigint[])[2]] : [];
          } catch {
            return [];
          }
        });
    const why = () => screen.findByLabelText('Why the swap reverted');
    const retryButton = () => screen.queryByRole('button', { name: /Retry once at/ });

    it('offers one retry at 1.00% with clear words, refills the form, and offers none after the retry reverts', async () => {
      const { rpc, state } = fakeChain({ allowance: 10n ** 12n });
      let receipt: () => unknown = () => null;
      // Below the signed minimum (30,845,000) at the end of the block: the minimum failed.
      const chain = chainWith(rpc, () => receipt(), {
        atParent: 31_000_000n,
        atBlock: 30_000_000n,
      });
      const { user, sends } = await mount(chain, state);
      await quoted(user);
      await user.click(swapButton());
      await waitFor(() => expect(sends()).toHaveLength(1));
      const stored = parsePendingSwap(
        localStorage.getItem(pendingSwapKey(network.chainId, ACCOUNT)),
      );
      expect(stored?.retry).toMatchObject({ slippageBps: 50, attempt: 1, minimumOut: 30_845_000n });
      receipt = () => REVERTED;
      const note = (await why()).textContent!;
      expect(note).toContain('reverted on its minimum received (BDEX: INSUFFICIENT_OUTPUT_AMOUNT)');
      expect(note).toContain('more than your 0.50% tolerance');
      expect(note).toContain('someone traded the same way in the same block');
      expect(note).toContain('Only the gas was spent; your tokens did not move.');
      expect(note).toContain('You can retry once at 1.00%');
      const button = await screen.findByRole('button', { name: 'Retry once at 1.00%' });

      await user.click(button);
      expect((screen.getByLabelText('Slippage tolerance (%)') as HTMLInputElement).value).toBe(
        '1.00',
      );
      expect((screen.getByLabelText('Amount') as HTMLInputElement).value).toBe('1');
      await screen.findByLabelText('Quote');
      await waitFor(() => expect(lensSlippage(state).at(-1)).toBe(100n));
      expect(lensSlippage(state).every((bps) => bps <= 300n)).toBe(true);
      expect(
        (screen.getByRole('button', { name: 'Retry once at 1.00%' }) as HTMLButtonElement).disabled,
      ).toBe(true);

      receipt = () => null;
      await waitFor(() => expect(swapButton().disabled).toBe(false));
      await user.click(swapButton());
      await waitFor(() => expect(sends()).toHaveLength(2));
      expect(
        parsePendingSwap(localStorage.getItem(pendingSwapKey(network.chainId, ACCOUNT)))?.retry,
      ).toMatchObject({ slippageBps: 100, attempt: 2 });
      receipt = () => REVERTED;
      await waitFor(async () =>
        expect((await why()).textContent).toContain('This was the one retry the page offers'),
      );
      expect(retryButton()).toBeNull();
    });

    it('offers no retry when the tolerance was already 1% or more', async () => {
      const { rpc, state } = fakeChain({ allowance: 10n ** 12n });
      let receipt: () => unknown = () => null;
      const chain = chainWith(rpc, () => receipt(), {
        atParent: 30_000_000n,
        atBlock: 31_000_000n,
      });
      const { user, sends } = await mount(chain, state);
      await user.clear(screen.getByLabelText('Slippage tolerance (%)'));
      await user.type(screen.getByLabelText('Slippage tolerance (%)'), '2');
      await quoted(user);
      await user.click(swapButton());
      await waitFor(() => expect(sends()).toHaveLength(1));
      receipt = () => REVERTED;
      const note = (await why()).textContent!;
      expect(note).toContain('more than your 2.00% tolerance');
      expect(note).toContain('offers a retry only below 1.00%');
      expect(retryButton()).toBeNull();
    });

    it('says EXPIRED and offers no retry when the block was past the deadline', async () => {
      const { rpc, state } = fakeChain({ allowance: 10n ** 12n });
      let receipt: () => unknown = () => null;
      const late = { ...BLOCK, timestamp: `0x${(NOW_MS / 1000 + 7200).toString(16)}` };
      const chain = chainWith(rpc, () => receipt(), { atParent: 1n, atBlock: 1n }, late);
      const { user, sends } = await mount(chain, state);
      await quoted(user);
      await user.click(swapButton());
      await waitFor(() => expect(sends()).toHaveLength(1));
      receipt = () => REVERTED;
      expect((await why()).textContent).toContain('BDEX: EXPIRED');
      expect(retryButton()).toBeNull();
    });

    it('offers no retry when the chain does not show the minimum failing', async () => {
      const { rpc, state } = fakeChain({ allowance: 10n ** 12n });
      let receipt: () => unknown = () => null;
      const chain = chainWith(rpc, () => receipt(), {
        atParent: 31_000_000n,
        atBlock: 31_000_000n,
      });
      const { user, sends } = await mount(chain, state);
      await quoted(user);
      await user.click(swapButton());
      await waitFor(() => expect(sends()).toHaveLength(1));
      receipt = () => REVERTED;
      expect((await why()).textContent).toContain('could not tell why from the chain');
      expect(retryButton()).toBeNull();
    });
  });
});
