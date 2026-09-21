import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import LivePools, { type LivePoolsReader } from '../LivePools';
import LivePoolsRuntime from '../LivePoolsRuntime';
import type {
  DeploymentRegistry,
  LivePoolPage,
  LiveReadAdapter,
  LiveReadState,
} from '../live-read';
import type { LiveReaderSession } from '../live-runtime';

const address = (byte: string) => `0x${byte.repeat(40)}` as Address;
const hash = (byte: string) => `0x${byte.repeat(64)}` as Hex;
const token0 = address('1');
const token1 = address('2');
const pair = address('3');

const registry = {
  schemaVersion: 5,
  environment: 'staging',
  host: 'bloch-dex',
  frontendMode: 'preview',
  liquidityEnabled: false,
  activation: {
    chainIdentityQualified: false,
    finalityQualified: false,
    deploymentQualified: false,
    executionEnabled: false,
    liquidityEnabled: false,
  },
  chain: { id: 700771, genesisHash: hash('a'), rpcUrl: 'https://rpc.invalid/' },
  deployment: {
    blockNumber: 1,
    blockHash: hash('b'),
    pairInitCodeHash: hash('c'),
    factory: { address: address('4'), runtimeCodeHash: hash('4') },
    router: { address: address('5'), runtimeCodeHash: hash('5') },
    lens: { address: address('6'), runtimeCodeHash: hash('6') },
    collector: { address: address('7'), runtimeCodeHash: hash('7') },
    wrappedNative: { address: address('8'), runtimeCodeHash: hash('8') },
    feeAuthority: { address: address('9'), runtimeCodeHash: hash('9') },
    treasury: { address: address('a'), runtimeCodeHash: hash('a') },
  },
  tokens: [
    {
      address: address('8'),
      runtimeCodeHash: hash('8'),
      symbol: 'WBLCH',
      name: 'Wrapped BLCH',
      decimals: 18,
      wrappedNative: true,
      policy: { feeOnTransfer: false, rebasing: false },
    },
    {
      address: token0,
      runtimeCodeHash: hash('1'),
      symbol: 'ALPHA',
      name: 'Alpha',
      decimals: 18,
      wrappedNative: false,
      policy: { feeOnTransfer: false, rebasing: false },
    },
    {
      address: token1,
      runtimeCodeHash: hash('2'),
      symbol: 'bUSDC',
      name: 'Bridged USDC',
      decimals: 6,
      wrappedNative: false,
      policy: { feeOnTransfer: false, rebasing: false },
    },
  ],
  assetPlan: {
    blochL1: {
      nativeSymbol: 'BLCH',
      evmExecution: false,
      authorizationBoundary: 'external-post-quantum',
    },
    bridgeAsset: {
      sourceChain: 'ethereum-mainnet',
      sourceChainId: 1,
      sourceSymbol: 'USDC',
      sourceTokenAddress: address('b'),
      destinationSymbol: 'bUSDC',
      destinationTokenAddress: token1,
    },
    pilotPool: {
      baseSymbol: 'BLCH',
      onchainBaseSymbol: 'WBLCH',
      quoteSymbol: 'bUSDC',
      liquidityEnabled: false,
      maxBaseBaseUnits: '10000000000000000000',
      maxQuoteBaseUnits: '10000000',
      policyCapApproval: {
        path: 'approvals/pilot-cap.json',
        sha256: hash('c'),
      },
      requiresSeparateApproval: true,
    },
  },
} satisfies DeploymentRegistry;

function page(reserve0 = 123n * 10n ** 18n): LivePoolPage {
  return {
    blockNumber: 32n,
    blockHash: hash('d'),
    pools: [
      {
        pair,
        token0,
        token1,
        reserve0,
        reserve1: 456n * 10n ** 6n,
        reserveTimestamp: 1,
        totalSupply: 99n,
      },
    ],
    nextCursor: 1n,
    total: 1n,
    filteredUnsupported: 0,
  };
}

function reader(
  result: LiveReadState<LivePoolPage> | Promise<LiveReadState<LivePoolPage>>,
): LivePoolsReader {
  return { registry, pools: vi.fn(async () => result) };
}

function session(result: LiveReadState<LivePoolPage> | Promise<LiveReadState<LivePoolPage>>) {
  return {
    reader: reader(result) as LiveReadAdapter,
    close: vi.fn<LiveReaderSession['close']>(),
  } satisfies LiveReaderSession;
}

describe('read-only live pool UI', () => {
  it('shows loading then a registry-formatted snapshot without fund controls or fixtures', async () => {
    let resolve!: (value: LiveReadState<LivePoolPage>) => void;
    const pending = new Promise<LiveReadState<LivePoolPage>>((done) => {
      resolve = done;
    });
    render(<LivePools reader={reader(pending)} />);
    expect(screen.getByRole('status').textContent).toContain('Loading one authenticated block');
    resolve({ available: true, value: page() });
    expect(await screen.findByText('ALPHA / bUSDC')).toBeTruthy();
    expect(screen.getByText('123 ALPHA')).toBeTruthy();
    expect(screen.getByText('456 bUSDC')).toBeTruthy();
    expect(screen.getByText(/Snapshot block 32/)).toBeTruthy();
    expect(screen.getByText(/no fixture fallback/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /swap|liquidity|approve|deposit/i })).toBeNull();
  });

  it.each([
    ['provider-unavailable', 'could not be read'],
    ['stale', 'became stale'],
  ] as const)('renders the %s state and retries without fixture fallback', async (reason, copy) => {
    const pools = vi
      .fn<LivePoolsReader['pools']>()
      .mockResolvedValueOnce({ available: false, reason })
      .mockResolvedValueOnce({ available: true, value: page() });
    render(<LivePools reader={{ registry, pools }} />);
    expect(await screen.findByText(new RegExp(copy))).toBeTruthy();
    expect(screen.getByText(/was not substituted|was not displayed/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /retry read/i }));
    expect(await screen.findByText('ALPHA / bUSDC')).toBeTruthy();
    expect(pools).toHaveBeenCalledTimes(2);
  });

  it('shows unsupported filtering explicitly and never fills the page with demo pools', async () => {
    const empty = page();
    empty.pools = [];
    empty.filteredUnsupported = 2;
    empty.total = 2n;
    render(<LivePools reader={reader({ available: true, value: empty })} />);
    expect(await screen.findByText(/2 permissionless pools were hidden/)).toBeTruthy();
    expect(screen.getByText(/No reviewed pools are available/)).toBeTruthy();
    expect(screen.queryByText(/BLCH \/ USDC/)).toBeNull();
  });

  it('prevents a late reader from overwriting a newer authenticated snapshot', async () => {
    let resolveOld!: (value: LiveReadState<LivePoolPage>) => void;
    const oldResult = new Promise<LiveReadState<LivePoolPage>>((done) => {
      resolveOld = done;
    });
    const oldReader = reader(oldResult);
    const newReader = reader({ available: true, value: page(222n * 10n ** 18n) });
    const view = render(<LivePools reader={oldReader} />);
    view.rerender(<LivePools reader={newReader} />);
    expect(await screen.findByText('222 ALPHA')).toBeTruthy();
    resolveOld({ available: true, value: page(111n * 10n ** 18n) });
    await waitFor(() => expect(screen.queryByText('111 ALPHA')).toBeNull());
    expect(screen.getByText('222 ALPHA')).toBeTruthy();
  });

  it('fails closed when a reader rejects unexpectedly', async () => {
    const rejecting: LivePoolsReader = {
      registry,
      pools: vi.fn(async () => {
        throw new Error('provider leaked an unexpected rejection');
      }),
    };
    render(<LivePools reader={rejecting} />);
    expect((await screen.findByRole('alert')).textContent).toContain('could not be read');
    expect(screen.getByText(/Preview data was not substituted/)).toBeTruthy();
  });
});

describe('read-only live pool runtime', () => {
  it('fails closed and opens a new session when the user retries', async () => {
    const next = session({ available: true, value: page() });
    const open = vi
      .fn()
      .mockRejectedValueOnce(new Error('registry unavailable'))
      .mockResolvedValueOnce(next);
    render(<LivePoolsRuntime factory={{ open }} />);
    expect((await screen.findByRole('alert')).textContent).toContain('registry or RPC provider');
    expect(screen.getByText(/Preview data was not substituted/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /retry deployment read/i }));
    expect(await screen.findByText('ALPHA / bUSDC')).toBeTruthy();
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('closes the current session before refreshing the manifest and adapter', async () => {
    const first = session({ available: true, value: page(111n * 10n ** 18n) });
    const second = session({ available: true, value: page(222n * 10n ** 18n) });
    const open = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    render(<LivePoolsRuntime factory={{ open }} />);
    expect(await screen.findByText('111 ALPHA')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /refresh snapshot/i }));
    expect(await screen.findByText('222 ALPHA')).toBeTruthy();
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('closes a session that resolves after its runtime was superseded', async () => {
    let resolveOld!: (value: LiveReaderSession) => void;
    const late = new Promise<LiveReaderSession>((resolve) => {
      resolveOld = resolve;
    });
    const oldSession = session({ available: true, value: page(111n * 10n ** 18n) });
    const newSession = session({ available: true, value: page(222n * 10n ** 18n) });
    const view = render(<LivePoolsRuntime factory={{ open: vi.fn(async () => late) }} />);
    view.rerender(<LivePoolsRuntime factory={{ open: vi.fn(async () => newSession) }} />);
    expect(await screen.findByText('222 ALPHA')).toBeTruthy();
    resolveOld(oldSession);
    await waitFor(() => expect(oldSession.close).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('111 ALPHA')).toBeNull();
  });
});
