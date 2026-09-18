import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { validAddress, type Provider } from './wallet';

type ContractIdentity = { address: Address; runtimeCodeHash: Hex };
export type DeploymentRegistry = {
  schemaVersion: 1;
  environment: 'staging';
  host: 'bloch-dex';
  frontendMode: 'preview';
  liquidityEnabled: false;
  chain: { id: number; genesisHash: Hex; rpcUrl: string };
  deployment: {
    blockNumber: number;
    blockHash: Hex;
    pairInitCodeHash: Hex;
    factory: ContractIdentity;
    router: ContractIdentity;
    lens: ContractIdentity;
    collector: ContractIdentity;
    wrappedNative: ContractIdentity;
  };
};

export type LivePoolSnapshot = {
  exists: boolean;
  blockNumber: bigint;
  blockHash: Hex;
  pair: Address;
  token0: Address;
  token1: Address;
  reserve0: bigint;
  reserve1: bigint;
  reserveTimestamp: number;
  totalSupply: bigint;
};

type BlockIdentity = { number: Hex; hash: Hex };

const HASH = /^0x[0-9a-fA-F]{64}$/;
const CODE = /^0x(?:[0-9a-fA-F]{2})+$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const CONTRACT_NAMES = ['factory', 'router', 'lens', 'collector', 'wrappedNative'] as const;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}` as Address;

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

function fail(message: string): never {
  throw new Error(`Live deployment unavailable: ${message}`);
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function validHash(value: unknown): value is Hex {
  return typeof value === 'string' && HASH.test(value) && !/^0x0{64}$/i.test(value);
}

function registryContract(value: unknown, field: string): ContractIdentity {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${field} is missing`);
  const input = value as Record<string, unknown>;
  requireValue(validAddress(input.address), `${field}.address is invalid`);
  requireValue(validHash(input.runtimeCodeHash), `${field}.runtimeCodeHash is invalid`);
  return {
    address: input.address as Address,
    runtimeCodeHash: input.runtimeCodeHash.toLowerCase() as Hex,
  };
}

/** Copies and validates untrusted runtime registry JSON before any provider call. */
export function parseDeploymentRegistry(value: unknown): DeploymentRegistry {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'registry is missing');
  const input = value as Record<string, unknown>;
  requireValue(input.schemaVersion === 1, 'registry schema is unsupported');
  requireValue(
    input.environment === 'staging' && input.host === 'bloch-dex',
    'target does not match staging',
  );
  requireValue(input.frontendMode === 'preview', 'frontend must remain in preview mode');
  requireValue(input.liquidityEnabled === false, 'liquidity must remain disabled');

  const chain = input.chain as Record<string, unknown> | undefined;
  requireValue(
    chain && typeof chain === 'object' && !Array.isArray(chain),
    'chain identity is missing',
  );
  requireValue(Number.isSafeInteger(chain.id) && Number(chain.id) > 0, 'chain ID is invalid');
  requireValue(validHash(chain.genesisHash), 'genesis hash is invalid');
  requireValue(typeof chain.rpcUrl === 'string' && chain.rpcUrl.length > 0, 'RPC URL is missing');
  let rpc: URL;
  try {
    rpc = new URL(chain.rpcUrl);
  } catch {
    fail('RPC URL is invalid');
  }
  requireValue(
    rpc.protocol === 'https:' &&
      !rpc.username &&
      !rpc.password &&
      !rpc.search &&
      !rpc.hash &&
      (rpc.pathname === '/' || rpc.pathname === ''),
    'RPC must be a credential-free public HTTPS origin',
  );

  const deployment = input.deployment as Record<string, unknown> | undefined;
  requireValue(
    deployment && typeof deployment === 'object' && !Array.isArray(deployment),
    'deployment is missing',
  );
  requireValue(
    Number.isSafeInteger(deployment.blockNumber) && Number(deployment.blockNumber) >= 0,
    'deployment block number is invalid',
  );
  requireValue(validHash(deployment.blockHash), 'deployment block hash is invalid');
  requireValue(validHash(deployment.pairInitCodeHash), 'pair init-code hash is invalid');
  const contracts = Object.fromEntries(
    CONTRACT_NAMES.map((name) => [name, registryContract(deployment[name], `deployment.${name}`)]),
  ) as Record<(typeof CONTRACT_NAMES)[number], ContractIdentity>;
  requireValue(
    new Set(CONTRACT_NAMES.map((name) => contracts[name].address.toLowerCase())).size ===
      CONTRACT_NAMES.length,
    'contract addresses are not unique',
  );

  return {
    schemaVersion: 1,
    environment: 'staging',
    host: 'bloch-dex',
    frontendMode: 'preview',
    liquidityEnabled: false,
    chain: {
      id: Number(chain.id),
      genesisHash: chain.genesisHash.toLowerCase() as Hex,
      rpcUrl: rpc.toString(),
    },
    deployment: {
      blockNumber: Number(deployment.blockNumber),
      blockHash: deployment.blockHash.toLowerCase() as Hex,
      pairInitCodeHash: deployment.pairInitCodeHash.toLowerCase() as Hex,
      ...contracts,
    },
  };
}

function blockIdentity(value: unknown, label: string): BlockIdentity {
  requireValue(
    value && typeof value === 'object' && !Array.isArray(value),
    `${label} block is missing`,
  );
  const block = value as Record<string, unknown>;
  requireValue(
    typeof block.number === 'string' && QUANTITY.test(block.number),
    `${label} block number is invalid`,
  );
  requireValue(validHash(block.hash), `${label} block hash is invalid`);
  return { number: block.number.toLowerCase() as Hex, hash: block.hash.toLowerCase() as Hex };
}

async function request(provider: Provider, method: string, params: unknown[]): Promise<unknown> {
  try {
    return await provider.request({ method, params });
  } catch {
    fail(`${method} failed`);
  }
}

async function call(provider: Provider, to: Address, data: Hex, blockNumber: Hex): Promise<Hex> {
  const result = await request(provider, 'eth_call', [{ to, data }, blockNumber]);
  requireValue(
    typeof result === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(result),
    'eth_call returned malformed data',
  );
  requireValue(result.length <= 16_386, 'eth_call returned excessive data');
  return result as Hex;
}

async function readFunction<T>(
  provider: Provider,
  address: Address,
  abi: Parameters<typeof encodeFunctionData>[0]['abi'],
  functionName: string,
  blockNumber: Hex,
  args?: readonly unknown[],
): Promise<T> {
  const data = encodeFunctionData({ abi, functionName, args } as Parameters<
    typeof encodeFunctionData
  >[0]);
  const result = await call(provider, address, data, blockNumber);
  try {
    return decodeFunctionResult({ abi, functionName, data: result } as Parameters<
      typeof decodeFunctionResult
    >[0]) as T;
  } catch {
    fail(`${functionName} returned malformed data`);
  }
}

async function confirmBlock(provider: Provider, expected: BlockIdentity): Promise<void> {
  const confirmed = blockIdentity(
    await request(provider, 'eth_getBlockByNumber', [expected.number, false]),
    'confirmed snapshot',
  );
  requireValue(
    confirmed.number === expected.number && confirmed.hash === expected.hash,
    'snapshot block changed during read',
  );
}

export class LiveReadAdapter {
  readonly registry: DeploymentRegistry;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly #provider: Provider;
  readonly #blockTag: Hex;

  private constructor(provider: Provider, registry: DeploymentRegistry, block: BlockIdentity) {
    this.#provider = provider;
    this.registry = registry;
    this.#blockTag = block.number;
    this.blockNumber = BigInt(block.number);
    this.blockHash = block.hash;
  }

  static async connect(provider: Provider, registryValue: unknown): Promise<LiveReadAdapter> {
    const registry = parseDeploymentRegistry(registryValue);
    const chainId = await request(provider, 'eth_chainId', []);
    requireValue(
      typeof chainId === 'string' &&
        QUANTITY.test(chainId) &&
        BigInt(chainId) === BigInt(registry.chain.id),
      'provider chain does not match registry',
    );
    const genesis = blockIdentity(
      await request(provider, 'eth_getBlockByNumber', ['0x0', false]),
      'genesis',
    );
    requireValue(genesis.number === '0x0', 'genesis block number is invalid');
    requireValue(genesis.hash === registry.chain.genesisHash, 'genesis does not match registry');
    const deploymentTag = `0x${registry.deployment.blockNumber.toString(16)}`;
    const deployedAt = blockIdentity(
      await request(provider, 'eth_getBlockByNumber', [deploymentTag, false]),
      'deployment',
    );
    requireValue(
      deployedAt.number === deploymentTag,
      'deployment block number does not match registry',
    );
    requireValue(
      deployedAt.hash === registry.deployment.blockHash,
      'deployment block does not match registry',
    );
    const snapshot = blockIdentity(
      await request(provider, 'eth_getBlockByNumber', ['latest', false]),
      'snapshot',
    );
    requireValue(BigInt(snapshot.number) >= BigInt(deploymentTag), 'snapshot predates deployment');

    for (const name of CONTRACT_NAMES) {
      const identity = registry.deployment[name];
      const code = await request(provider, 'eth_getCode', [identity.address, snapshot.number]);
      requireValue(
        typeof code === 'string' && CODE.test(code) && code.length <= 49_154,
        `${name} code is invalid`,
      );
      requireValue(
        keccak256(code as Hex).toLowerCase() === identity.runtimeCodeHash,
        `${name} code hash does not match registry`,
      );
    }

    const factory = registry.deployment.factory.address;
    const wrapped = registry.deployment.wrappedNative.address;
    const routerFactory = await readFunction<Address>(
      provider,
      registry.deployment.router.address,
      routerAbi,
      'factory',
      snapshot.number,
    );
    const routerWrapped = await readFunction<Address>(
      provider,
      registry.deployment.router.address,
      routerAbi,
      'WBLCH',
      snapshot.number,
    );
    const lensFactory = await readFunction<Address>(
      provider,
      registry.deployment.lens.address,
      lensAbi,
      'factory',
      snapshot.number,
    );
    const collectorFactory = await readFunction<Address>(
      provider,
      registry.deployment.collector.address,
      collectorAbi,
      'factory',
      snapshot.number,
    );
    const collectorWrapped = await readFunction<Address>(
      provider,
      registry.deployment.collector.address,
      collectorAbi,
      'wblch',
      snapshot.number,
    );
    const initCodeHash = await readFunction<Hex>(
      provider,
      factory,
      factoryAbi,
      'INIT_CODE_PAIR_HASH',
      snapshot.number,
    );
    requireValue(
      routerFactory.toLowerCase() === factory.toLowerCase(),
      'router factory binding is invalid',
    );
    requireValue(
      routerWrapped.toLowerCase() === wrapped.toLowerCase(),
      'router wrapper binding is invalid',
    );
    requireValue(
      lensFactory.toLowerCase() === factory.toLowerCase(),
      'lens factory binding is invalid',
    );
    requireValue(
      collectorFactory.toLowerCase() === factory.toLowerCase(),
      'collector factory binding is invalid',
    );
    requireValue(
      collectorWrapped.toLowerCase() === wrapped.toLowerCase(),
      'collector wrapper binding is invalid',
    );
    requireValue(
      initCodeHash.toLowerCase() === registry.deployment.pairInitCodeHash,
      'pair init-code hash is invalid',
    );
    await confirmBlock(provider, snapshot);
    return new LiveReadAdapter(provider, registry, snapshot);
  }

  async poolFor(tokenA: string, tokenB: string): Promise<LivePoolSnapshot> {
    requireValue(
      validAddress(tokenA) && validAddress(tokenB) && tokenA.toLowerCase() !== tokenB.toLowerCase(),
      'pool tokens are invalid',
    );
    const result = await readFunction<
      readonly [
        boolean,
        {
          pair: Address;
          token0: Address;
          token1: Address;
          reserve0: bigint;
          reserve1: bigint;
          reserveTimestamp: number;
          totalSupply: bigint;
        },
      ]
    >(this.#provider, this.registry.deployment.lens.address, lensAbi, 'poolFor', this.#blockTag, [
      tokenA,
      tokenB,
    ]);
    await confirmBlock(this.#provider, { number: this.#blockTag, hash: this.blockHash });
    const [exists, snapshot] = result;
    const { pair, token0, token1, reserve0, reserve1, reserveTimestamp, totalSupply } = snapshot;
    const expectedTokens = [tokenA.toLowerCase(), tokenB.toLowerCase()].sort();
    requireValue(
      exists
        ? validAddress(pair) &&
            validAddress(token0) &&
            validAddress(token1) &&
            token0.toLowerCase() === expectedTokens[0] &&
            token1.toLowerCase() === expectedTokens[1]
        : pair.toLowerCase() === ZERO_ADDRESS &&
            token0.toLowerCase() === ZERO_ADDRESS &&
            token1.toLowerCase() === ZERO_ADDRESS &&
            reserve0 === 0n &&
            reserve1 === 0n &&
            reserveTimestamp === 0 &&
            totalSupply === 0n,
      'lens returned an inconsistent pool',
    );
    return {
      exists,
      blockNumber: this.blockNumber,
      blockHash: this.blockHash,
      pair,
      token0,
      token1,
      reserve0,
      reserve1,
      reserveTimestamp,
      totalSupply,
    };
  }
}
