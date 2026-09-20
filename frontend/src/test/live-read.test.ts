import { describe, expect, it, vi } from 'vitest';
import {
  encodeFunctionData,
  encodeFunctionResult,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { LatestReadGate, LiveReadAdapter, parseDeploymentRegistry } from '../live-read';
import type { Provider } from '../wallet';

const addresses = {
  factory: `0x${'11'.repeat(20)}` as Address,
  router: `0x${'22'.repeat(20)}` as Address,
  lens: `0x${'33'.repeat(20)}` as Address,
  collector: `0x${'44'.repeat(20)}` as Address,
  wrappedNative: `0x${'55'.repeat(20)}` as Address,
  feeAuthority: `0x${'aa'.repeat(20)}` as Address,
  treasury: `0x${'bb'.repeat(20)}` as Address,
  tokenA: `0x${'66'.repeat(20)}` as Address,
  tokenB: `0x${'77'.repeat(20)}` as Address,
  pair: `0x${'88'.repeat(20)}` as Address,
  unregistered: `0x${'99'.repeat(20)}` as Address,
};
const codes = {
  factory: '0x6001',
  router: '0x6002',
  lens: '0x6003',
  collector: '0x6004',
  wrappedNative: '0x6005',
  feeAuthority: '0x',
  treasury: '0x',
  tokenA: '0x6006',
  tokenB: '0x6007',
} satisfies Partial<Record<keyof typeof addresses, Hex>>;
const genesisHash = `0x${'aa'.repeat(32)}` as Hex;
const deploymentHash = `0x${'bb'.repeat(32)}` as Hex;
const snapshotHash = `0x${'cc'.repeat(32)}` as Hex;
const pairInitCodeHash = `0x${'dd'.repeat(32)}` as Hex;
const ZERO_ADDRESS = `0x${'00'.repeat(20)}` as Address;

const factoryAbi = parseAbi([
  'function INIT_CODE_PAIR_HASH() view returns (bytes32)',
  'function feeTo() view returns (address)',
  'function feeToSetter() view returns (address)',
  'function pendingFeeToSetter() view returns (address)',
]);
const routerAbi = parseAbi([
  'function factory() view returns (address)',
  'function WBLCH() view returns (address)',
]);
const lensAbi = parseAbi([
  'function factory() view returns (address)',
  'function poolFor(address tokenA, address tokenB) view returns (bool exists, (address pair, address token0, address token1, uint112 reserve0, uint112 reserve1, uint32 reserveTimestamp, uint256 totalSupply) snapshot)',
  'function pools(uint256 cursor, uint256 limit) view returns ((address pair, address token0, address token1, uint112 reserve0, uint112 reserve1, uint32 reserveTimestamp, uint256 totalSupply)[] page, uint256 nextCursor, uint256 total)',
  'function quoteExactInput(uint256 amountIn, address[] path, uint256 slippageBps) view returns ((bool available, uint256 blockNumber, uint256 timestamp, uint256 amountOut, uint256 minimumOut, uint256[] amounts, uint256[] executionLossBps))',
]);
const collectorAbi = parseAbi([
  'function factory() view returns (address)',
  'function treasury() view returns (address)',
  'function wblch() view returns (address)',
]);
const tokenAbi = parseAbi(['function balanceOf(address owner) view returns (uint256)']);
const poolSelector = encodeFunctionData({
  abi: lensAbi,
  functionName: 'poolFor',
  args: [addresses.tokenA, addresses.tokenB],
}).slice(0, 10);
const poolsSelector = encodeFunctionData({
  abi: lensAbi,
  functionName: 'pools',
  args: [0n, 10n],
}).slice(0, 10);
const quoteSelector = encodeFunctionData({
  abi: lensAbi,
  functionName: 'quoteExactInput',
  args: [10n, [addresses.tokenA, addresses.tokenB], 50n],
}).slice(0, 10);
const balanceSelector = encodeFunctionData({
  abi: tokenAbi,
  functionName: 'balanceOf',
  args: [addresses.tokenA],
}).slice(0, 10);

function registry() {
  return {
    schemaVersion: 4,
    environment: 'staging',
    host: 'bloch-dex',
    frontendMode: 'preview',
    liquidityEnabled: false,
    chain: { id: 700771, genesisHash, rpcUrl: 'https://rpc.invalid/' },
    deployment: {
      blockNumber: 10,
      blockHash: deploymentHash,
      pairInitCodeHash,
      ...Object.fromEntries(
        (['factory', 'router', 'lens', 'collector', 'wrappedNative'] as const).map((name) => [
          name,
          { address: addresses[name], runtimeCodeHash: keccak256(codes[name]) },
        ]),
      ),
      feeAuthority: {
        address: addresses.feeAuthority,
        runtimeCodeHash: keccak256(codes.feeAuthority),
      },
      treasury: { address: addresses.treasury, runtimeCodeHash: keccak256(codes.treasury) },
    },
    tokens: [
      {
        address: addresses.wrappedNative,
        runtimeCodeHash: keccak256(codes.wrappedNative),
        symbol: 'WBLCH',
        name: 'Wrapped BLCH',
        decimals: 18,
        wrappedNative: true,
        policy: { feeOnTransfer: false, rebasing: false },
      },
      {
        address: addresses.tokenA,
        runtimeCodeHash: keccak256(codes.tokenA),
        symbol: 'TOKENA',
        name: 'Token A',
        decimals: 18,
        wrappedNative: false,
        policy: { feeOnTransfer: false, rebasing: false },
      },
      {
        address: addresses.tokenB,
        runtimeCodeHash: keccak256(codes.tokenB),
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
        sourceTokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        destinationSymbol: 'bUSDC',
        destinationTokenAddress: addresses.tokenB,
      },
      pilotPool: {
        baseSymbol: 'BLCH',
        onchainBaseSymbol: 'WBLCH',
        quoteSymbol: 'bUSDC',
        liquidityEnabled: false,
        maxBaseBaseUnits: '10000000000000000000',
        maxQuoteBaseUnits: '10000000',
        policyCapApproval: { path: 'approvals/pilot-cap.json', sha256: genesisHash },
        requiresSeparateApproval: true,
      },
    },
  };
}

function selector(abi: Parameters<typeof encodeFunctionData>[0]['abi'], functionName: string): Hex {
  return encodeFunctionData({ abi, functionName } as Parameters<
    typeof encodeFunctionData
  >[0]).slice(0, 10) as Hex;
}

function fixture(
  overrides: {
    chainId?: unknown;
    genesisHash?: Hex;
    code?: Hex;
    tokenCode?: Hex;
    roleCode?: Hex;
    routerFactory?: Address;
    feeTo?: Address;
    feeToSetter?: Address;
    pendingFeeToSetter?: Address;
    collectorTreasury?: Address;
    reorg?: boolean;
    quoteAvailable?: boolean;
    poolExists?: boolean;
    pausePools?: Promise<void>;
    unsupportedPage?: boolean;
  } = {},
) {
  const requests: Array<{ method: string; params?: unknown[] }> = [];
  let snapshotConfirmations = 0;
  const request = vi.fn(async (args: { method: string; params?: unknown[] }): Promise<unknown> => {
    requests.push(args);
    const params = args.params ?? [];
    if (args.method === 'eth_chainId') return overrides.chainId ?? '0xab163';
    if (args.method === 'eth_getBlockByNumber') {
      if (params[0] === '0x0') return { number: '0x0', hash: overrides.genesisHash ?? genesisHash };
      if (params[0] === '0xa') return { number: '0xa', hash: deploymentHash };
      if (params[0] === 'latest') return { number: '0x20', hash: snapshotHash };
      if (params[0] === '0x20') {
        snapshotConfirmations += 1;
        return {
          number: '0x20',
          hash: overrides.reorg && snapshotConfirmations === 1 ? deploymentHash : snapshotHash,
        };
      }
    }
    if (args.method === 'eth_getCode') {
      const address = String(params[0]).toLowerCase();
      const name = (Object.keys(codes) as Array<keyof typeof codes>).find(
        (candidate) => addresses[candidate].toLowerCase() === address,
      );
      if (name) {
        if (overrides.code && name === 'router') return overrides.code;
        if (overrides.tokenCode && name === 'tokenA') return overrides.tokenCode;
        if (overrides.roleCode && name === 'treasury') return overrides.roleCode;
        return codes[name];
      }
    }
    if (args.method === 'eth_getBalance') return '0x2a';
    if (args.method === 'eth_call') {
      const call = params[0] as { to: Address; data: Hex };
      const signature = call.data.slice(0, 10);
      if (call.to === addresses.router && signature === selector(routerAbi, 'factory'))
        return encodeFunctionResult({
          abi: routerAbi,
          functionName: 'factory',
          result: overrides.routerFactory ?? addresses.factory,
        });
      if (call.to === addresses.router && signature === selector(routerAbi, 'WBLCH'))
        return encodeFunctionResult({
          abi: routerAbi,
          functionName: 'WBLCH',
          result: addresses.wrappedNative,
        });
      if (call.to === addresses.lens && signature === selector(lensAbi, 'factory'))
        return encodeFunctionResult({
          abi: lensAbi,
          functionName: 'factory',
          result: addresses.factory,
        });
      if (call.to === addresses.collector && signature === selector(collectorAbi, 'factory'))
        return encodeFunctionResult({
          abi: collectorAbi,
          functionName: 'factory',
          result: addresses.factory,
        });
      if (call.to === addresses.collector && signature === selector(collectorAbi, 'wblch'))
        return encodeFunctionResult({
          abi: collectorAbi,
          functionName: 'wblch',
          result: addresses.wrappedNative,
        });
      if (call.to === addresses.collector && signature === selector(collectorAbi, 'treasury'))
        return encodeFunctionResult({
          abi: collectorAbi,
          functionName: 'treasury',
          result: overrides.collectorTreasury ?? addresses.treasury,
        });
      if (call.to === addresses.factory && signature === selector(factoryAbi, 'feeTo'))
        return encodeFunctionResult({
          abi: factoryAbi,
          functionName: 'feeTo',
          result: overrides.feeTo ?? ZERO_ADDRESS,
        });
      if (call.to === addresses.factory && signature === selector(factoryAbi, 'feeToSetter'))
        return encodeFunctionResult({
          abi: factoryAbi,
          functionName: 'feeToSetter',
          result: overrides.feeToSetter ?? addresses.feeAuthority,
        });
      if (call.to === addresses.factory && signature === selector(factoryAbi, 'pendingFeeToSetter'))
        return encodeFunctionResult({
          abi: factoryAbi,
          functionName: 'pendingFeeToSetter',
          result: overrides.pendingFeeToSetter ?? ZERO_ADDRESS,
        });
      if (
        call.to === addresses.factory &&
        signature === selector(factoryAbi, 'INIT_CODE_PAIR_HASH')
      )
        return encodeFunctionResult({
          abi: factoryAbi,
          functionName: 'INIT_CODE_PAIR_HASH',
          result: pairInitCodeHash,
        });
      if (call.to === addresses.lens && signature === poolSelector) {
        const exists = overrides.poolExists ?? true;
        return encodeFunctionResult({
          abi: lensAbi,
          functionName: 'poolFor',
          result: exists
            ? [
                true,
                {
                  pair: addresses.pair,
                  token0: addresses.tokenA,
                  token1: addresses.tokenB,
                  reserve0: 100n,
                  reserve1: 200n,
                  reserveTimestamp: 123,
                  totalSupply: 50n,
                },
              ]
            : [
                false,
                {
                  pair: '0x0000000000000000000000000000000000000000',
                  token0: '0x0000000000000000000000000000000000000000',
                  token1: '0x0000000000000000000000000000000000000000',
                  reserve0: 0n,
                  reserve1: 0n,
                  reserveTimestamp: 0,
                  totalSupply: 0n,
                },
              ],
        });
      }
      if (call.to === addresses.lens && signature === poolsSelector) {
        await overrides.pausePools;
        return encodeFunctionResult({
          abi: lensAbi,
          functionName: 'pools',
          result: [
            [
              {
                pair: addresses.pair,
                token0: addresses.tokenA,
                token1: overrides.unsupportedPage ? addresses.unregistered : addresses.tokenB,
                reserve0: 100n,
                reserve1: 200n,
                reserveTimestamp: 123,
                totalSupply: 50n,
              },
            ],
            1n,
            1n,
          ],
        });
      }
      if (call.to === addresses.lens && signature === quoteSelector) {
        const available = overrides.quoteAvailable ?? true;
        return encodeFunctionResult({
          abi: lensAbi,
          functionName: 'quoteExactInput',
          result: {
            available,
            blockNumber: 32n,
            timestamp: 1_000n,
            amountOut: available ? 9n : 0n,
            minimumOut: available ? 8n : 0n,
            amounts: [10n, available ? 9n : 0n],
            executionLossBps: [1_000n],
          },
        });
      }
      if (
        (call.to === addresses.tokenA || call.to === addresses.tokenB) &&
        signature === balanceSelector
      )
        return encodeFunctionResult({ abi: tokenAbi, functionName: 'balanceOf', result: 99n });
    }
    throw new Error(`unexpected ${args.method}`);
  });
  return { provider: { request } satisfies Provider, request, requests };
}

describe('fail-closed live deployment reads', () => {
  it('rejects an incomplete or transaction-enabled registry before provider access', async () => {
    expect(() => parseDeploymentRegistry({})).toThrow('fields');
    const wrongChain = registry();
    wrongChain.chain.id = 84001;
    expect(() => parseDeploymentRegistry(wrongChain)).toThrow('supported staging network 700771');
    const enabled = registry();
    enabled.liquidityEnabled = true;
    const f = fixture();
    await expect(LiveReadAdapter.connect(f.provider, enabled)).rejects.toThrow('liquidity');
    expect(f.request).not.toHaveBeenCalled();

    const unsafeToken = registry();
    unsafeToken.tokens[1].policy.feeOnTransfer = true;
    const unsafeFixture = fixture();
    await expect(LiveReadAdapter.connect(unsafeFixture.provider, unsafeToken)).rejects.toThrow(
      'unsupported transfer policy',
    );
    expect(unsafeFixture.request).not.toHaveBeenCalled();
  });

  it('binds chain, genesis, deployment, code and contract identities at one block', async () => {
    const f = fixture();
    const adapter = await LiveReadAdapter.connect(f.provider, registry());
    expect(adapter.blockNumber).toBe(32n);
    expect(adapter.blockHash).toBe(snapshotHash);
    const pool = await adapter.poolFor(addresses.tokenA, addresses.tokenB);
    expect(pool).toMatchObject({
      exists: true,
      pair: addresses.pair,
      reserve0: 100n,
      reserve1: 200n,
      totalSupply: 50n,
    });
    expect(
      f.requests
        .map(({ method }) => method)
        .every((method) =>
          ['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call'].includes(method),
        ),
    ).toBe(true);
    expect(
      f.requests
        .filter(({ method }) => method === 'eth_getCode')
        .every(({ params }) => params?.[1] === '0x20'),
    ).toBe(true);
    expect(
      f.requests
        .filter(({ method }) => method === 'eth_call')
        .every(({ params }) => params?.[1] === '0x20'),
    ).toBe(true);
  });

  it.each([
    ['chain', { chainId: '0x1' }, 'provider chain'],
    ['genesis', { genesisHash: `0x${'ee'.repeat(32)}` as Hex }, 'genesis'],
    ['runtime code', { code: '0x6009' as Hex }, 'router code hash'],
    ['token runtime code', { tokenCode: '0x6009' as Hex }, 'TOKENA token code hash'],
    ['custody runtime code', { roleCode: '0x6009' as Hex }, 'treasury code hash'],
    ['router binding', { routerFactory: addresses.tokenA }, 'router factory'],
    ['collector treasury', { collectorTreasury: addresses.tokenA }, 'collector treasury'],
    ['fee recipient', { feeTo: addresses.treasury }, 'factory fee controls'],
    ['fee authority', { feeToSetter: addresses.tokenA }, 'factory fee controls'],
    ['pending fee authority', { pendingFeeToSetter: addresses.tokenA }, 'factory fee controls'],
    ['snapshot reorganization', { reorg: true }, 'snapshot block changed'],
  ])('rejects a mismatched %s', async (_label, override, message) => {
    const f = fixture(override);
    await expect(LiveReadAdapter.connect(f.provider, registry())).rejects.toThrow(message);
  });

  it('rejects malformed tokens without another provider request', async () => {
    const f = fixture();
    const adapter = await LiveReadAdapter.connect(f.provider, registry());
    const count = f.request.mock.calls.length;
    await expect(adapter.poolFor(addresses.tokenA, addresses.tokenA)).rejects.toThrow(
      'pool tokens',
    );
    await expect(
      adapter.quoteExactInput(10n, [addresses.tokenA, addresses.unregistered], 50),
    ).resolves.toEqual({ available: false, reason: 'invalid-request' });
    await expect(adapter.balances(addresses.tokenA, [addresses.unregistered])).resolves.toEqual({
      available: false,
      reason: 'invalid-request',
    });
    expect(f.request).toHaveBeenCalledTimes(count);
  });

  it('reads paginated reserves, quotes and explicit balances at the bound snapshot', async () => {
    const f = fixture();
    const adapter = await LiveReadAdapter.connect(f.provider, registry());
    const page = await adapter.pools(0n, 10);
    expect(page).toMatchObject({
      available: true,
      value: { blockNumber: 32n, blockHash: snapshotHash, nextCursor: 1n, total: 1n },
    });
    if (page.available)
      expect(page.value.pools[0]).toMatchObject({ reserve0: 100n, reserve1: 200n });

    const quote = await adapter.quoteExactInput(10n, [addresses.tokenA, addresses.tokenB], 50);
    expect(quote).toMatchObject({
      available: true,
      value: { amountOut: 9n, minimumOut: 8n, blockNumber: 32n, blockHash: snapshotHash },
    });
    const balances = await adapter.balances(addresses.tokenA, [addresses.tokenA, addresses.tokenB]);
    expect(balances).toMatchObject({
      available: true,
      value: {
        owner: addresses.tokenA,
        nativeBalance: 42n,
        tokens: [
          { token: addresses.tokenA, balance: 99n },
          { token: addresses.tokenB, balance: 99n },
        ],
      },
    });
    expect(
      f.requests
        .filter(({ method }) => method === 'eth_call' || method === 'eth_getBalance')
        .every(({ params }) => params?.[1] === '0x20'),
    ).toBe(true);
  });

  it('reports missing pools and unavailable quotes without falling back', async () => {
    const missingFixture = fixture({ poolExists: false });
    const missingAdapter = await LiveReadAdapter.connect(missingFixture.provider, registry());
    await expect(missingAdapter.readPool(addresses.tokenA, addresses.tokenB)).resolves.toEqual({
      available: false,
      reason: 'missing-pool',
    });

    const quoteFixture = fixture({ quoteAvailable: false });
    const quoteAdapter = await LiveReadAdapter.connect(quoteFixture.provider, registry());
    await expect(
      quoteAdapter.quoteExactInput(10n, [addresses.tokenA, addresses.tokenB], 50),
    ).resolves.toEqual({ available: false, reason: 'quote-unavailable' });
  });

  it('advances permissionless pagination while filtering unreviewed token pools', async () => {
    const f = fixture({ unsupportedPage: true });
    const adapter = await LiveReadAdapter.connect(f.provider, registry());
    await expect(adapter.pools(0n, 10)).resolves.toMatchObject({
      available: true,
      value: { pools: [], filteredUnsupported: 1, nextCursor: 1n, total: 1n },
    });
  });

  it('marks aborted and superseded reads unavailable even when an old RPC resolves later', async () => {
    let release = () => {};
    const pausePools = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = fixture({ pausePools });
    const adapter = await LiveReadAdapter.connect(f.provider, registry());
    const gate = new LatestReadGate();
    const pending = adapter.pools(0n, 10, gate.begin());
    await vi.waitFor(() =>
      expect(f.requests.some(({ method }) => method === 'eth_call')).toBe(true),
    );
    gate.begin();
    release();
    await expect(pending).resolves.toEqual({ available: false, reason: 'stale' });

    const controller = new AbortController();
    controller.abort();
    const before = f.request.mock.calls.length;
    await expect(adapter.pools(0n, 10, gate.begin(controller.signal))).resolves.toEqual({
      available: false,
      reason: 'cancelled',
    });
    expect(f.request).toHaveBeenCalledTimes(before);
  });
});
