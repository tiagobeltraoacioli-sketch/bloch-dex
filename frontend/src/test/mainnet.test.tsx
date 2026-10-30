import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  decodeFunctionData,
  encodeFunctionResult,
  keccak256,
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
import { ensureChain, ROUTER_ABI } from '../devnet4/swap';
import {
  addChainParameters,
  bundledNetwork,
  bundledRecord,
  loadMainnetState,
  parseNetwork,
  plannedCaps,
  plannedPairs,
  type MainnetNetwork,
} from '../mainnet/config';
import { checkRoute, explainBlock, headroom, headroomUse } from '../mainnet/caps';
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
function mainnetRecord(): { plan: Json; config: Json; gateReport: Json } {
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
  return r;
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
  reserves: Record<string, [bigint, bigint, number]>;
  sent: { method: string; params: unknown[] }[];
};

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
          if (name === 'bestExactInput') {
            const [amountIn, routes] = call.args as [bigint, Address[][]];
            const q = (route: Address[]) => ({
              available: state.quote.available,
              blockNumber: 440n,
              timestamp: 0n,
              amountOut: state.quote.amountOut,
              minimumOut: state.quote.minimumOut,
              amounts: route.map((_, i) => (i === 0 ? amountIn : state.quote.amountOut)),
              executionLossBps: route.slice(1).map(() => 30n),
            });
            const best = state.quote.available ? 0n : 2n ** 256n - 1n;
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
    const refused = mainnetRecord();
    refused.gateReport.decision = 'refused';
    await expect(loadMainnetState(wrap(refused), network)).rejects.toThrow(/did not enable/);
    // The devnet4 route still accepts only its rehearsal record.
    await expect(verifyDeploymentRecord(mainnetRecord())).rejects.toThrow(/devnet4 rehearsal/);
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
    expect(panel.textContent).toContain('1 wGSMH');
    expect(panel.textContent).toContain('1000 bUSDC');
    expect(panel.textContent).toContain('WBLCH/wGSMH, WBLCH/bUSDC');
    expect(screen.getByLabelText('Network').textContent).toContain('0xab162');
    expect(screen.getByLabelText('Network').textContent).toContain('placeholder');
    expect(screen.getByLabelText('Bridges').textContent).toMatch(/bUSDC.*not live yet/);
    expect(screen.queryByRole('button', { name: 'Swap' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Add or switch/ })).toBeNull();
    expect(state.sent).toHaveLength(0);
    expect(requests).toHaveLength(0);
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

    // Every read went to the finalized block hash; nothing read `latest`.
    const at = JSON.stringify({ blockHash: FINALIZED.hash });
    const reads = state.sent.filter((s) =>
      ['eth_call', 'eth_getBalance', 'eth_getCode'].includes(s.method),
    );
    expect(reads.length).toBeGreaterThan(10);
    expect(reads.every((s) => JSON.stringify(s.params[1]) === at)).toBe(true);

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
    await user.type(screen.getByLabelText('Slippage tolerance (%)'), '7');
    await user.click(screen.getByRole('button', { name: 'Get quote' }));
    expect(await screen.findByText(/0.01% to 5.00%/)).toBeTruthy();
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
});
