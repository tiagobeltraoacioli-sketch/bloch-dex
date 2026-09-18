import { describe, expect, it, vi } from 'vitest';
import {
  encodeFunctionData,
  encodeFunctionResult,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { LiveReadAdapter, parseDeploymentRegistry } from '../live-read';
import type { Provider } from '../wallet';

const addresses = {
  factory: `0x${'11'.repeat(20)}` as Address,
  router: `0x${'22'.repeat(20)}` as Address,
  lens: `0x${'33'.repeat(20)}` as Address,
  collector: `0x${'44'.repeat(20)}` as Address,
  wrappedNative: `0x${'55'.repeat(20)}` as Address,
  tokenA: `0x${'66'.repeat(20)}` as Address,
  tokenB: `0x${'77'.repeat(20)}` as Address,
  pair: `0x${'88'.repeat(20)}` as Address,
};
const codes: Record<
  keyof Pick<typeof addresses, 'factory' | 'router' | 'lens' | 'collector' | 'wrappedNative'>,
  Hex
> = {
  factory: '0x6001',
  router: '0x6002',
  lens: '0x6003',
  collector: '0x6004',
  wrappedNative: '0x6005',
};
const genesisHash = `0x${'aa'.repeat(32)}` as Hex;
const deploymentHash = `0x${'bb'.repeat(32)}` as Hex;
const snapshotHash = `0x${'cc'.repeat(32)}` as Hex;
const pairInitCodeHash = `0x${'dd'.repeat(32)}` as Hex;

const factoryAbi = parseAbi(['function INIT_CODE_PAIR_HASH() view returns (bytes32)']);
const routerAbi = parseAbi([
  'function factory() view returns (address)',
  'function WBLCH() view returns (address)',
]);
const lensAbi = parseAbi([
  'function factory() view returns (address)',
  'function poolFor(address tokenA, address tokenB) view returns (bool exists, (address pair, address token0, address token1, uint112 reserve0, uint112 reserve1, uint32 reserveTimestamp, uint256 totalSupply) snapshot)',
]);
const collectorAbi = parseAbi([
  'function factory() view returns (address)',
  'function wblch() view returns (address)',
]);
const poolSelector = encodeFunctionData({
  abi: lensAbi,
  functionName: 'poolFor',
  args: [addresses.tokenA, addresses.tokenB],
}).slice(0, 10);

function registry() {
  return {
    schemaVersion: 1,
    environment: 'staging',
    host: 'bloch-dex',
    frontendMode: 'preview',
    liquidityEnabled: false,
    chain: { id: 31337, genesisHash, rpcUrl: 'https://rpc.invalid/' },
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
    routerFactory?: Address;
    reorg?: boolean;
  } = {},
) {
  const requests: Array<{ method: string; params?: unknown[] }> = [];
  let snapshotConfirmations = 0;
  const request = vi.fn(async (args: { method: string; params?: unknown[] }): Promise<unknown> => {
    requests.push(args);
    const params = args.params ?? [];
    if (args.method === 'eth_chainId') return overrides.chainId ?? '0x7a69';
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
      if (name) return overrides.code && name === 'router' ? overrides.code : codes[name];
    }
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
      if (call.to === addresses.factory)
        return encodeFunctionResult({
          abi: factoryAbi,
          functionName: 'INIT_CODE_PAIR_HASH',
          result: pairInitCodeHash,
        });
      if (call.to === addresses.lens && signature === poolSelector)
        return encodeFunctionResult({
          abi: lensAbi,
          functionName: 'poolFor',
          result: [
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
          ],
        });
    }
    throw new Error(`unexpected ${args.method}`);
  });
  return { provider: { request } satisfies Provider, request, requests };
}

describe('fail-closed live deployment reads', () => {
  it('rejects an incomplete or transaction-enabled registry before provider access', async () => {
    expect(() => parseDeploymentRegistry({})).toThrow('schema');
    const enabled = registry();
    enabled.liquidityEnabled = true;
    const f = fixture();
    await expect(LiveReadAdapter.connect(f.provider, enabled)).rejects.toThrow('liquidity');
    expect(f.request).not.toHaveBeenCalled();
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
    ['router binding', { routerFactory: addresses.tokenA }, 'router factory'],
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
    expect(f.request).toHaveBeenCalledTimes(count);
  });
});
