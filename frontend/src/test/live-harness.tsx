// The harness of the live-screen tests (round 20, agent 411): a live multichain route rendered over a fake chain and
// a fake wallet. `useLiveHarness()` installs the per-file setup; the rest are the fixtures the test files share.
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, vi } from 'vitest';
import {
  decodeFunctionData,
  encodeFunctionResult,
  keccak256,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import MainnetLive from '../MainnetLive';
import type { Devnet4Wallet } from '../Devnet4Live';
import type { Rpc } from '../devnet4/chain';
import type { DevnetDeployment } from '../devnet4/record';
import { BLOCH_L2_WORDING, setWording } from '../mainnet/wording';
import bundle from '../multichain/bundle';
import { parseChain, type Chain } from '../multichain/config';
import { tokenFacts } from '../multichain/token-facts';
import type { Provider } from '../wallet';
import { browserLocksForTest } from './browser-locks';

export const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
export const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const ethereum = clone(
  (bundle as { network: Record<string, unknown>; record: unknown }[]).find(
    (e) => e.network.key === 'ethereum',
  )!,
) as { network: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
export const USDC = ethereum.network.tokens[0].address as Address;
export const WETH = ethereum.network.wrappedNative.address as Address;
export const FACTORY = a(0xf1),
  ROUTER = a(0xf2),
  LENS = a(0xf3),
  PAIR = a(0xf4);
export const ACCOUNT = '0x72dc623d4c03c996a3d20ed2674f24570e8acf44' as Address;
export const NOW_MS = 1_795_000_000_000;
export const BLOCK = {
  number: '0x4d2',
  hash: h(0xb10c),
  timestamp: `0x${(NOW_MS / 1000 - 30).toString(16)}`,
};
export const LATEST = { ...BLOCK, number: '0x4d3', hash: h(0x1a7e57) };
export const ONE = 10n ** 18n;

export let chain: Chain;
export let deployment: DevnetDeployment;
const fakeCode = new Map<string, Hex>();

export function useLiveHarness() {
  beforeAll(async () => {
    Object.defineProperty(navigator, 'locks', { configurable: true, value: browserLocksForTest() });
    chain = parseChain(ethereum.network, {
      schemaVersion: 1,
      domain: 'postern.dex.multichain-frontend-record.v1',
      key: 'ethereum',
      chainId: 1,
      status: 'deployed',
      rehearsal: false,
      genesisHash: ethereum.network.genesisHash,
      finalized: { number: 1000, hash: h(77) },
      feeTo: ethereum.network.feeTo,
      firstDepositor: a(9),
      factory: { address: FACTORY, codeHash: h(1) },
      router: { address: ROUTER, codeHash: h(2) },
      lens: { address: LENS, codeHash: h(3) },
      wrappedNative: WETH,
      reserveCaps: [],
      pairCodeHash: h(4),
      pairs: [{ address: PAIR, token0: USDC, token1: WETH }],
    });
    const state = await chain.load();
    if (state.status !== 'live') throw new Error('expected a live state');
    const codeHashes: Record<Address, Hex> = {};
    Object.keys(state.deployment.codeHashes).forEach((address, i) => {
      const code = `0x60${(i + 1).toString(16).padStart(2, '0')}` as Hex;
      fakeCode.set(address, code);
      codeHashes[address as Address] = keccak256(code);
    });
    deployment = { ...state.deployment, codeHashes };
  });
  beforeEach(() => {
    // A fresh lock model for every test: a request one test leaves in flight must not hold the next one's.
    Object.defineProperty(navigator, 'locks', { configurable: true, value: browserLocksForTest() });
    localStorage.clear();
    history.replaceState(null, '', '/#/ethereum');
    setWording(chain.wording);
  });
  afterEach(() => {
    cleanup();
    setWording({ ...BLOCH_L2_WORDING });
  });
}

const ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
  'function getReserves() view returns (uint112, uint112, uint32)',
  'function reserveCaps() view returns (uint112, uint112)',
  'function totalSupply() view returns (uint256)',
  'function kLast() view returns (uint256)',
  'function feeTo() view returns (address)',
  'struct PendingExcess { uint256 excess0; uint256 excess1; bool blocksInflow0; bool blocksInflow1; }',
  'function pendingExcess(address pair) view returns (PendingExcess value)',
]);
export type Fake = {
  reserves: [bigint, bigint];
  /** The reserves a read at `latest` answers; the pinned ones when absent. */
  latestReserves?: [bigint, bigint];
  supply: bigint;
  kLast: bigint;
  usdc: bigint;
  usdcAllowance: bigint;
  shares: bigint;
  sharesAllowance: bigint;
  /** The hash of the block the chain answers for `finalized` and `latest`; BLOCK's when absent. */
  blockHash?: Hex;
  calls: { method: string; params: unknown[] }[];
};
export function fakeChain(over: Partial<Fake> = {}): { rpc: Rpc; state: Fake } {
  const state: Fake = {
    reserves: [30_300_000_000n, 9_930_000_000_000_000_000n],
    supply: 547_722_557_505_166n,
    kLast: 30_000_000_000n * 10n * ONE,
    usdc: 10_000_000_000n,
    usdcAllowance: 0n,
    shares: 0n,
    sharesAllowance: 0n,
    calls: [],
    ...over,
  };
  const rpc: Rpc = async (method, params) => {
    state.calls.push({ method, params });
    switch (method) {
      case 'eth_chainId':
        return '0x1';
      case 'eth_getBlockByNumber':
        if (params[0] === '0x0') return { number: '0x0', hash: deployment.genesisHash };
        // The head is one block after the pinned (settled) block and has a hash of its own.
        return params[0] === 'latest' || params[0] === LATEST.number
          ? LATEST
          : { ...BLOCK, hash: state.blockHash ?? BLOCK.hash };
      case 'eth_getCode':
        return fakeCode.get(String(params[0])) ?? '0x';
      case 'eth_getBalance':
        return `0x${(5n * ONE).toString(16)}`;
      case 'eth_getTransactionCount':
        return '0x7';
      case 'eth_getTransactionByHash':
      case 'eth_getTransactionReceipt':
        return null;
      case 'eth_call': {
        const [{ to, data }, at] = params as [{ to: Address; data: Hex }, unknown];
        const call = decodeFunctionData({ abi: ABI, data });
        const reply = (result: unknown) =>
          encodeFunctionResult({
            abi: ABI as Abi,
            functionName: call.functionName,
            result,
          } as never);
        // A read at the head: by its tag, or pinned to its hash.
        const atHead =
          at === 'latest' || (at as { blockHash?: Hex } | null)?.blockHash === LATEST.hash;
        const reserves = atHead ? (state.latestReserves ?? state.reserves) : state.reserves;
        switch (call.functionName) {
          case 'decimals':
            return reply(to === USDC ? 6 : 18);
          case 'symbol':
            return reply(to === USDC ? 'USDC' : 'WETH');
          case 'getReserves':
            return reply([...reserves, 1]);
          case 'reserveCaps':
            return reply([0n, 0n]);
          case 'totalSupply':
            return reply(state.supply);
          case 'kLast':
            return reply(state.kLast);
          case 'feeTo':
            return reply(deployment.feeTo);
          case 'pendingExcess':
            return reply({ excess0: 0n, excess1: 0n, blocksInflow0: false, blocksInflow1: false });
          case 'balanceOf': {
            const who = (call.args as [Address])[0].toLowerCase();
            if (to === PAIR) return reply(who === ACCOUNT ? state.shares : 0n);
            if (who === PAIR) return reply(to === USDC ? reserves[0] : reserves[1]);
            return reply(to === USDC ? state.usdc : 0n);
          }
          case 'allowance':
            return reply(to === PAIR ? state.sharesAllowance : state.usdcAllowance);
        }
      }
    }
    throw new Error(`unexpected ${method}`);
  };
  return { rpc, state };
}
export function fakeWallet(connected = true) {
  const sent: Record<string, string>[] = [];
  const request = vi.fn(async ({ method, params }: { method: string; params?: unknown[] }) => {
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_sendTransaction') {
      sent.push((params as Record<string, string>[])[0]);
      return h(0xabc0 + sent.length);
    }
    throw new Error(`the wallet was asked for ${method}`);
  });
  const wallet: Devnet4Wallet = {
    account: connected ? { address: ACCOUNT, chainId: '0x1', name: 'Test wallet' } : null,
    provider: connected ? ({ request } as unknown as Provider) : null,
    wallets: [],
    pending: false,
    error: '',
    connect: () => {},
  } as Devnet4Wallet;
  return { wallet, sent, request };
}
export const mount = (
  rpc: Rpc,
  wallet: Devnet4Wallet,
  pairs: [string, string][] = [['WETH', 'USDC']],
  state: Awaited<ReturnType<Chain['load']>> = { status: 'live', deployment },
) =>
  render(
    <MainnetLive
      network={chain.network}
      load={() => Promise.resolve(state)}
      rpc={rpc}
      wallet={wallet}
      planned={{ caps: [], pairs }}
      now={() => NOW_MS}
      receiptPollMs={50}
      confirmation={{ note: chain.confirmationNote, rule: { depth: 2 }, blockSeconds: 12 }}
      screens={{ base: '#/ethereum', tokenFacts: tokenFacts()['ethereum'] }}
    />,
  );
export const goTo = async (name: string) => {
  const nav = await screen.findByRole('navigation', { name: 'Screens' });
  await act(async () => {
    location.hash = within(nav).getByRole('link', { name }).getAttribute('href')!;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
};
export const type = async (label: string | RegExp, value: string) => {
  const user = userEvent.setup();
  const field = within(screen.getByRole('dialog')).getByLabelText(label);
  await user.clear(field);
  await user.type(field, value);
};
export const figure = (name: string) => {
  const dl = screen.getByRole('dialog').querySelector('dl.live-figures')!;
  const dt = [...dl.querySelectorAll('dt')].find((x) => x.textContent === name);
  return dt?.nextElementSibling?.textContent?.replace(/\s+/g, ' ').trim();
};
export const sends = (sent: Record<string, string>[]) => sent.length;
