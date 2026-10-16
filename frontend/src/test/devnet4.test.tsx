import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  decodeFunctionData,
  encodeFunctionResult,
  keccak256,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import Devnet4Live, { type Devnet4Wallet } from '../Devnet4Live';
import { ERC20_ABI, LENS_ABI, PAIR_ABI, readSnapshot, type Rpc } from '../devnet4/chain';
import { committedRecord, verifyDeploymentRecord, type DevnetDeployment } from '../devnet4/record';
import { ROUTER_ABI } from '../devnet4/swap';
import type { Provider } from '../wallet';

const BUSDC = '0x1b7c0fb59f34683cd9214566636e63a0f7e092f6' as Address;
const WGSMH = '0xb2b4952b6e57e589109af764859886e236798ad4' as Address;
const WBLCH = '0x7f889d9cb335bbdb197b75c74a6409ac2bbbe6e6' as Address;
const ROUTER = '0xb3a451af23df72f72916064c6d33d1fbe25e7106' as Address;
const GSMH_PAIR = '0xd71fc81263ba585561ad4d784a4bc096739927b4' as Address;
const USD_PAIR = '0xd98230d9a13cb72f6d75e3bf46c01415027c8033' as Address;
const ACCOUNT = '0x72dc623d4c03c996a3d20ed2674f24570e8acf44' as Address;
const FINALIZED = { number: '0x1b8', hash: `0x${'f'.repeat(64)}`, timestamp: '0x6ad1a000' };
const NOW_MS = 1_792_200_000_000;
/** Decoded ABI addresses are checksummed; compare them in lowercase. */
const norm = (value: unknown): unknown =>
  Array.isArray(value) ? value.map(norm) : typeof value === 'string' ? value.toLowerCase() : value;

let committed: DevnetDeployment;
let deployment: DevnetDeployment;
const fakeCode = new Map<Address, Hex>();

beforeAll(async () => {
  committed = await verifyDeploymentRecord();
  // Synthetic runtime code per contract; the record's hashes are re-pinned to it.
  const codeHashes: Record<Address, Hex> = {};
  Object.keys(committed.codeHashes).forEach((address, i) => {
    const code = `0x60${(i + 1).toString(16).padStart(2, '0')}` as Hex;
    fakeCode.set(address as Address, code);
    codeHashes[address as Address] = keccak256(code);
  });
  deployment = { ...committed, codeHashes };
});

type ChainState = {
  genesis: string;
  finalized: typeof FINALIZED;
  allowance: bigint;
  quote: { available: boolean; amountOut: bigint; minimumOut: bigint };
  code: Map<Address, Hex>;
  sent: { method: string; params: unknown[] }[];
};

function fakeChain(change: Partial<ChainState> = {}): { rpc: Rpc; state: ChainState } {
  const state: ChainState = {
    genesis: committed.genesisHash,
    finalized: FINALIZED,
    allowance: 0n,
    quote: { available: true, amountOut: 31_000_000n, minimumOut: 30_845_000n },
    code: fakeCode,
    sent: [],
    ...change,
  };
  const tokens: Record<string, [number, string]> = { [WBLCH]: [18, 'WBLCH'], [BUSDC]: [6, 'bUSDC'], [WGSMH]: [8, 'wGSMH'] };
  const reserves: Record<string, [bigint, bigint, number]> = {
    [GSMH_PAIR]: [130_852_828_000_503_020n, 38_295_768n, 1],
    [USD_PAIR]: [5_571_215n, 272_177_475_029_800_010n, 1],
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
        return '0xab163';
      case 'eth_getBlockByNumber':
        return params[0] === '0x0' ? { number: '0x0', hash: state.genesis } : state.finalized;
      case 'eth_getCode':
        return state.code.get(params[0] as Address) ?? '0x';
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
          if (name === 'allowance') return reply(abi, name, state.allowance);
          if (name === 'getReserves') return reply(abi, name, reserves[to]);
          if (name === 'reserveCaps') return reply(abi, name, caps[to]);
          if (name === 'bestExactInput') {
            const [amountIn, routes] = call.args as [bigint, Address[][]];
            const q = (route: Address[]) => ({
              available: state.quote.available,
              blockNumber: 442n,
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

function fakeWallet(chain: ChainState) {
  let chainId = '0x1';
  const requests: { method: string; params?: unknown[] }[] = [];
  const provider: Provider = {
    async request({ method, params }) {
      requests.push({ method, params });
      if (method === 'eth_chainId') return chainId;
      if (method === 'wallet_switchEthereumChain') {
        if (chainId === '0x1' && !requests.some((r) => r.method === 'wallet_addEthereumChain')) {
          throw Object.assign(new Error('Unrecognized chain'), { code: 4902 });
        }
        chainId = (params![0] as { chainId: string }).chainId;
        return null;
      }
      if (method === 'wallet_addEthereumChain') {
        chainId = (params![0] as { chainId: string }).chainId;
        return null;
      }
      if (method === 'eth_sendTransaction') {
        const tx = params![0] as { to: Address; data: Hex };
        if (tx.to === BUSDC) chain.allowance = 1_000_000n;
        return `0x${String(requests.length).padStart(64, '0')}`;
      }
      throw new Error(`unexpected wallet call ${method}`);
    },
  };
  const wallet: Devnet4Wallet = {
    account: { address: ACCOUNT, chainId: '0x1', name: 'Test wallet' },
    provider,
    wallets: [],
    pending: false,
    error: '',
    connect: () => {},
  };
  return { wallet, requests };
}

describe('devnet4 deployment record', () => {
  it('accepts the committed, gate-enabled two-pair record', () => {
    expect(committed.chainId).toBe(700771);
    expect(committed.router).toBe(ROUTER);
    expect(committed.pairs.map((p) => p.address)).toEqual([GSMH_PAIR, USD_PAIR]);
    expect(committed.tokens.map((t) => [t.symbol, t.cap])).toEqual([
      ['WBLCH', 10n ** 19n],
      ['wGSMH', 100_000_000n],
      ['bUSDC', 1_000_000_000n],
    ]);
    expect(committed.gate.finalizedNumber).toBe(434n);
  });

  it('refuses a record that is not internally consistent', async () => {
    const tamper = async (edit: (r: { plan: any; config: any; gateReport: any }) => void) => {
      const copy = structuredClone(committedRecord) as { plan: any; config: any; gateReport: any };
      edit(copy);
      return verifyDeploymentRecord(copy);
    };
    await expect(tamper((r) => (r.gateReport.decision = 'refused'))).rejects.toThrow(/did not enable liquidity/);
    await expect(tamper((r) => (r.gateReport.feeTo = ACCOUNT))).rejects.toThrow(/fee recipient/);
    await expect(tamper((r) => (r.config.reserveCaps[0].cap = '1'))).rejects.toThrow(/not derived from this configuration/);
    await expect(tamper((r) => (r.plan.chain.id = 700770))).rejects.toThrow(/not a devnet4 rehearsal/);
    await expect(tamper((r) => r.gateReport.pairs.pop())).rejects.toThrow(/pairs differ/);
  });
});

describe('devnet4 finalized reads', () => {
  it('reads reserves and caps at the finalized block after re-checking identity and code', async () => {
    const { rpc, state } = fakeChain();
    const snapshot = await readSnapshot(rpc, deployment);
    expect(snapshot.finalized.number).toBe(440n);
    expect(snapshot.pools[1]).toMatchObject({ reserve0: 5_571_215n, cap0: 1_000_000_000n });
    const at = { blockHash: FINALIZED.hash };
    expect(state.sent.filter((s) => s.method === 'eth_call').every((s) => JSON.stringify(s.params[1]) === JSON.stringify(at))).toBe(true);
  });

  it('refuses another genesis, drifted code or a finalized block older than the gate', async () => {
    await expect(readSnapshot(fakeChain({ genesis: `0x${'1'.repeat(64)}` }).rpc, deployment)).rejects.toThrow(/genesis/);
    const drifted = new Map(fakeCode);
    drifted.set(ROUTER, '0x6099');
    await expect(readSnapshot(fakeChain({ code: drifted }).rpc, deployment)).rejects.toThrow(/runtime code/);
    await expect(readSnapshot(fakeChain({ finalized: { ...FINALIZED, number: '0x1a0' } }).rpc, deployment)).rejects.toThrow(/older than the gate/);
  });
});

describe('devnet4 swap flow', () => {
  it('shows live pools, quotes through the lens, approves the exact amount and swaps with slippage and a wall-clock deadline', async () => {
    const user = userEvent.setup();
    const { rpc, state } = fakeChain();
    const { wallet, requests } = fakeWallet(state);
    render(<Devnet4Live load={async () => deployment} rpc={rpc} walletRpcUrl="http://127.0.0.1:18945" wallet={wallet} now={() => NOW_MS} />);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('bUSDC/WBLCH')).toBeTruthy();
    expect(table.textContent).toContain('5.571215 bUSDC');
    expect(table.textContent).toContain('1000 bUSDC (0.55%)');
    expect(screen.getByText(/Zero value/)).toBeTruthy();

    await user.selectOptions(screen.getByLabelText('You pay'), 'bUSDC');
    await user.selectOptions(screen.getByLabelText('You receive'), 'wGSMH');
    await user.type(screen.getByLabelText('Amount'), '1');
    await user.click(screen.getByRole('button', { name: 'Get quote' }));
    const quote = await screen.findByLabelText('Quote');
    expect(quote.textContent).toContain('bUSDC → WBLCH → wGSMH');
    expect(quote.textContent).toContain('0.30845');
    const lensCall = state.sent.filter((s) => s.method === 'eth_call').at(-2)!;
    expect(lensCall.params[1]).toBe('latest');

    await user.click(await screen.findByRole('button', { name: /Approve 1 bUSDC/ }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull());
    expect(requests.map((r) => r.method)).toEqual([
      'eth_chainId',
      'wallet_switchEthereumChain',
      'wallet_addEthereumChain',
      'eth_chainId',
      'eth_sendTransaction',
    ]);
    const added = requests[2].params![0] as { chainId: string; rpcUrls: string[] };
    expect(added).toMatchObject({ chainId: '0xab163', rpcUrls: ['http://127.0.0.1:18945'] });
    const approve = requests[4].params![0] as { to: Address; data: Hex; gas: string; value: string };
    expect(approve).toMatchObject({ to: BUSDC, gas: '0x186a0', value: '0x0' });
    expect(norm(decodeFunctionData({ abi: ERC20_ABI, data: approve.data }).args)).toEqual([ROUTER, 1_000_000n]);

    await user.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(requests.filter((r) => r.method === 'eth_sendTransaction')).toHaveLength(2));
    const swap = requests.filter((r) => r.method === 'eth_sendTransaction')[1].params![0] as { to: Address; data: Hex; gas: string; value: string };
    expect(swap).toMatchObject({ to: ROUTER, value: '0x0', gas: '0x7a120' });
    const decoded = decodeFunctionData({ abi: ROUTER_ABI, data: swap.data });
    expect(decoded.functionName).toBe('swapExactTokensForTokens');
    expect(norm(decoded.args)).toEqual([1_000_000n, 30_845_000n, [BUSDC, WBLCH, WGSMH], ACCOUNT, BigInt(NOW_MS / 1000 + 30 * 60)]);
    await waitFor(() => expect(screen.getAllByText(/Mined in block 442/).length).toBe(2));
  });

  it('sends native BLCH as value through swapExactBLCHForTokens without an approval', async () => {
    const user = userEvent.setup();
    const { rpc, state } = fakeChain({ quote: { available: true, amountOut: 1_600_000n, minimumOut: 1_592_000n } });
    const { wallet, requests } = fakeWallet(state);
    render(<Devnet4Live load={async () => deployment} rpc={rpc} walletRpcUrl="http://127.0.0.1:18945" wallet={wallet} now={() => NOW_MS} />);
    await screen.findByRole('table');
    await user.selectOptions(screen.getByLabelText('You pay'), 'BLCH');
    await user.selectOptions(screen.getByLabelText('You receive'), 'bUSDC');
    await user.type(screen.getByLabelText('Amount'), '0.1');
    await user.click(screen.getByRole('button', { name: 'Get quote' }));
    await screen.findByLabelText('Quote');
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Swap' }));
    await waitFor(() => expect(requests.some((r) => r.method === 'eth_sendTransaction')).toBe(true));
    const swap = requests.find((r) => r.method === 'eth_sendTransaction')!.params![0] as { data: Hex; value: string; gas: string };
    expect(swap.value).toBe(`0x${(10n ** 17n).toString(16)}`);
    expect(swap.gas).toBe('0x3d090');
    const decoded = decodeFunctionData({ abi: ROUTER_ABI, data: swap.data });
    expect(decoded.functionName).toBe('swapExactBLCHForTokens');
    expect(norm(decoded.args)).toEqual([1_592_000n, [WBLCH, BUSDC], ACCOUNT, BigInt(NOW_MS / 1000 + 30 * 60)]);
  });

  it('never offers a swap the lens reports as unavailable (no liquidity or a reserve cap)', async () => {
    const user = userEvent.setup();
    const { rpc, state } = fakeChain({ quote: { available: false, amountOut: 0n, minimumOut: 0n } });
    const { wallet, requests } = fakeWallet(state);
    render(<Devnet4Live load={async () => deployment} rpc={rpc} walletRpcUrl="http://127.0.0.1:18945" wallet={wallet} now={() => NOW_MS} />);
    await screen.findByRole('table');
    await user.selectOptions(screen.getByLabelText('You pay'), 'wGSMH');
    await user.selectOptions(screen.getByLabelText('You receive'), 'BLCH');
    await user.type(screen.getByLabelText('Amount'), '5');
    await user.click(screen.getByRole('button', { name: 'Get quote' }));
    expect(await screen.findByText(/reserve cap would be exceeded/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Swap' }) as HTMLButtonElement).disabled).toBe(true);
    expect(requests).toHaveLength(0);
  });

  it('shows a refusal instead of pools when the RPC is another chain', async () => {
    const { rpc } = fakeChain({ genesis: `0x${'2'.repeat(64)}` });
    const { wallet } = fakeWallet(fakeChain().state);
    render(<Devnet4Live load={async () => deployment} rpc={rpc} walletRpcUrl="x" wallet={wallet} />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringMatching(/genesis differs/));
    expect(screen.queryByRole('table')).toBeNull();
  });
});
