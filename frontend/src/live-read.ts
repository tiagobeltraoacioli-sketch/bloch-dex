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
export type RegistryToken = ContractIdentity & {
  symbol: string;
  name: string;
  decimals: number;
  wrappedNative: boolean;
  policy: { feeOnTransfer: false; rebasing: false };
};
export type DeploymentRegistry = {
  schemaVersion: 4;
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
    feeAuthority: ContractIdentity;
    treasury: ContractIdentity;
  };
  tokens: readonly RegistryToken[];
  assetPlan: {
    blochL1: {
      nativeSymbol: 'BLCH';
      evmExecution: false;
      authorizationBoundary: 'external-post-quantum';
    };
    bridgeAsset: {
      sourceChain: 'ethereum-mainnet';
      sourceChainId: 1;
      sourceSymbol: 'USDC';
      sourceTokenAddress: Address;
      destinationSymbol: 'bUSDC';
      destinationTokenAddress: Address;
    };
    pilotPool: {
      baseSymbol: 'BLCH';
      onchainBaseSymbol: 'WBLCH';
      quoteSymbol: 'bUSDC';
      liquidityEnabled: false;
      maxBaseBaseUnits: string;
      maxQuoteBaseUnits: string;
      policyCapApproval: { path: string; sha256: Hex };
      requiresSeparateApproval: true;
    };
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

export type LivePoolPage = {
  blockNumber: bigint;
  blockHash: Hex;
  pools: ReadonlyArray<Omit<LivePoolSnapshot, 'exists' | 'blockNumber' | 'blockHash'>>;
  nextCursor: bigint;
  total: bigint;
  filteredUnsupported: number;
};

export type LiveQuote = {
  blockNumber: bigint;
  blockHash: Hex;
  timestamp: bigint;
  amountOut: bigint;
  minimumOut: bigint;
  amounts: readonly bigint[];
  executionLossBps: readonly bigint[];
};

export type LiveBalances = {
  blockNumber: bigint;
  blockHash: Hex;
  owner: Address;
  nativeBalance: bigint;
  tokens: ReadonlyArray<{ token: Address; balance: bigint }>;
};

export type LiveReadUnavailableReason =
  | 'cancelled'
  | 'stale'
  | 'invalid-request'
  | 'missing-pool'
  | 'empty-pool'
  | 'quote-unavailable'
  | 'provider-unavailable';

export type LiveReadState<T> =
  | { available: true; value: T }
  | { available: false; reason: LiveReadUnavailableReason };

export type LiveReadRequest = {
  readonly signal?: AbortSignal;
  readonly current: () => boolean;
};

/** One gate per UI query stream rejects responses superseded by a newer request. */
export class LatestReadGate {
  #generation = 0;

  begin(signal?: AbortSignal): LiveReadRequest {
    const generation = ++this.#generation;
    return { signal, current: () => generation === this.#generation };
  }

  invalidate(): void {
    this.#generation += 1;
  }
}

type BlockIdentity = { number: Hex; hash: Hex };

const HASH = /^0x[0-9a-fA-F]{64}$/;
const CODE = /^0x(?:[0-9a-fA-F]{2})+$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const CONTRACT_NAMES = ['factory', 'router', 'lens', 'collector', 'wrappedNative'] as const;
const ROLE_NAMES = ['feeAuthority', 'treasury'] as const;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}` as Address;
const ETHEREUM_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const MAX_PILOT_BLCH_BASE_UNITS = 10n * 10n ** 18n;
const MAX_PILOT_BUSDC_BASE_UNITS = 10n * 10n ** 6n;

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
const MAX_UINT112 = (1n << 112n) - 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

function fail(message: string): never {
  throw new Error(`Live deployment unavailable: ${message}`);
}

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message);
}

function validHash(value: unknown): value is Hex {
  return typeof value === 'string' && HASH.test(value) && !/^0x0{64}$/i.test(value);
}

function exactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  requireValue(
    actual.length === expected.length && actual.every((field, index) => field === expected[index]),
    `${label} fields are invalid`,
  );
}

function registryContract(value: unknown, field: string, exact = true): ContractIdentity {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${field} is missing`);
  const input = value as Record<string, unknown>;
  if (exact) exactFields(input, ['address', 'runtimeCodeHash'], field);
  requireValue(validAddress(input.address), `${field}.address is invalid`);
  requireValue(validHash(input.runtimeCodeHash), `${field}.runtimeCodeHash is invalid`);
  return {
    address: input.address as Address,
    runtimeCodeHash: input.runtimeCodeHash.toLowerCase() as Hex,
  };
}

function registryToken(value: unknown, index: number): RegistryToken {
  const field = `tokens[${index}]`;
  const identity = registryContract(value, field, false);
  const input = value as Record<string, unknown>;
  exactFields(
    input,
    ['address', 'runtimeCodeHash', 'symbol', 'name', 'decimals', 'wrappedNative', 'policy'],
    field,
  );
  requireValue(
    typeof input.symbol === 'string' &&
      (/^[A-Z0-9]{2,12}$/.test(input.symbol) || input.symbol === 'bUSDC'),
    `${field}.symbol is invalid`,
  );
  requireValue(
    typeof input.name === 'string' && /^[A-Za-z0-9 ._-]{1,48}$/.test(input.name),
    `${field}.name is invalid`,
  );
  requireValue(
    Number.isSafeInteger(input.decimals) &&
      Number(input.decimals) >= 0 &&
      Number(input.decimals) <= 36,
    `${field}.decimals is invalid`,
  );
  requireValue(typeof input.wrappedNative === 'boolean', `${field}.wrappedNative is required`);
  const policy = input.policy as Record<string, unknown> | undefined;
  if (policy) exactFields(policy, ['feeOnTransfer', 'rebasing'], `${field}.policy`);
  requireValue(
    policy && policy.feeOnTransfer === false && policy.rebasing === false,
    `${field} uses an unsupported transfer policy`,
  );
  return {
    ...identity,
    symbol: input.symbol,
    name: input.name,
    decimals: Number(input.decimals),
    wrappedNative: input.wrappedNative,
    policy: { feeOnTransfer: false, rebasing: false },
  };
}

/** Copies and validates untrusted runtime registry JSON before any provider call. */
export function parseDeploymentRegistry(value: unknown): DeploymentRegistry {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'registry is missing');
  const input = value as Record<string, unknown>;
  exactFields(
    input,
    [
      'schemaVersion',
      'environment',
      'host',
      'frontendMode',
      'liquidityEnabled',
      'chain',
      'deployment',
      'tokens',
      'assetPlan',
    ],
    'registry',
  );
  requireValue(input.schemaVersion === 4, 'registry schema is unsupported');
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
  exactFields(chain, ['id', 'genesisHash', 'rpcUrl'], 'chain');
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
  exactFields(
    deployment,
    ['blockNumber', 'blockHash', 'pairInitCodeHash', ...CONTRACT_NAMES, ...ROLE_NAMES],
    'deployment',
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
  const roles = Object.fromEntries(
    ROLE_NAMES.map((name) => [name, registryContract(deployment[name], `deployment.${name}`)]),
  ) as Record<(typeof ROLE_NAMES)[number], ContractIdentity>;
  requireValue(
    new Set([
      ...CONTRACT_NAMES.map((name) => contracts[name].address.toLowerCase()),
      ...ROLE_NAMES.map((name) => roles[name].address.toLowerCase()),
    ]).size ===
      CONTRACT_NAMES.length + ROLE_NAMES.length,
    'deployment and custody addresses are not unique',
  );
  requireValue(
    Array.isArray(input.tokens) && input.tokens.length >= 2 && input.tokens.length <= 64,
    'token registry must contain between 2 and 64 assets',
  );
  const tokens = input.tokens.map(registryToken);
  const tokenAddresses = tokens.map((token) => token.address.toLowerCase());
  requireValue(new Set(tokenAddresses).size === tokens.length, 'token addresses are not unique');
  const wrappedTokens = tokens.filter((token) => token.wrappedNative);
  requireValue(
    wrappedTokens.length === 1 &&
      wrappedTokens[0].address.toLowerCase() === contracts.wrappedNative.address.toLowerCase() &&
      wrappedTokens[0].runtimeCodeHash === contracts.wrappedNative.runtimeCodeHash,
    'wrapped-native token identity does not match deployment',
  );
  const infrastructure = new Set([
    ...(['factory', 'router', 'lens', 'collector'] as const).map((name) =>
      contracts[name].address.toLowerCase(),
    ),
    ...ROLE_NAMES.map((name) => roles[name].address.toLowerCase()),
  ]);
  requireValue(
    tokenAddresses.every((address) => !infrastructure.has(address)),
    'token collides with deployment infrastructure',
  );

  const plan = input.assetPlan as Record<string, unknown> | undefined;
  requireValue(plan && typeof plan === 'object' && !Array.isArray(plan), 'asset plan is missing');
  exactFields(plan, ['blochL1', 'bridgeAsset', 'pilotPool'], 'asset plan');
  const blochL1 = plan.blochL1 as Record<string, unknown> | undefined;
  requireValue(
    blochL1 && typeof blochL1 === 'object' && !Array.isArray(blochL1),
    'Bloch L1 plan is missing',
  );
  exactFields(blochL1, ['nativeSymbol', 'evmExecution', 'authorizationBoundary'], 'Bloch L1 plan');
  requireValue(
    blochL1.nativeSymbol === 'BLCH' &&
      blochL1.evmExecution === false &&
      blochL1.authorizationBoundary === 'external-post-quantum',
    'Bloch L1 boundary is invalid',
  );
  const bridgeAsset = plan.bridgeAsset as Record<string, unknown> | undefined;
  requireValue(
    bridgeAsset && typeof bridgeAsset === 'object' && !Array.isArray(bridgeAsset),
    'bridge asset plan is missing',
  );
  exactFields(
    bridgeAsset,
    [
      'sourceChain',
      'sourceChainId',
      'sourceSymbol',
      'sourceTokenAddress',
      'destinationSymbol',
      'destinationTokenAddress',
    ],
    'bridge asset plan',
  );
  requireValue(
    bridgeAsset.sourceChain === 'ethereum-mainnet' &&
      bridgeAsset.sourceChainId === 1 &&
      bridgeAsset.sourceSymbol === 'USDC' &&
      bridgeAsset.sourceTokenAddress === ETHEREUM_USDC &&
      bridgeAsset.destinationSymbol === 'bUSDC' &&
      validAddress(bridgeAsset.destinationTokenAddress),
    'bridge asset plan is invalid',
  );
  const pilotPool = plan.pilotPool as Record<string, unknown> | undefined;
  requireValue(
    pilotPool && typeof pilotPool === 'object' && !Array.isArray(pilotPool),
    'pilot pool plan is missing',
  );
  exactFields(
    pilotPool,
    [
      'baseSymbol',
      'onchainBaseSymbol',
      'quoteSymbol',
      'liquidityEnabled',
      'maxBaseBaseUnits',
      'maxQuoteBaseUnits',
      'policyCapApproval',
      'requiresSeparateApproval',
    ],
    'pilot pool plan',
  );
  const baseCap = pilotPool.maxBaseBaseUnits;
  const quoteCap = pilotPool.maxQuoteBaseUnits;
  requireValue(
    pilotPool.baseSymbol === 'BLCH' &&
      pilotPool.onchainBaseSymbol === 'WBLCH' &&
      pilotPool.quoteSymbol === 'bUSDC' &&
      pilotPool.liquidityEnabled === false &&
      pilotPool.requiresSeparateApproval === true &&
      typeof baseCap === 'string' &&
      /^[1-9][0-9]*$/.test(baseCap) &&
      BigInt(baseCap) <= MAX_PILOT_BLCH_BASE_UNITS &&
      typeof quoteCap === 'string' &&
      /^[1-9][0-9]*$/.test(quoteCap) &&
      BigInt(quoteCap) <= MAX_PILOT_BUSDC_BASE_UNITS,
    'pilot pool policy is invalid',
  );
  const approval = pilotPool.policyCapApproval as Record<string, unknown> | undefined;
  requireValue(
    approval && typeof approval === 'object' && !Array.isArray(approval),
    'pilot cap approval is missing',
  );
  exactFields(approval, ['path', 'sha256'], 'pilot cap approval');
  requireValue(
    typeof approval.path === 'string' &&
      /^approvals\/[a-z0-9][a-z0-9._-]{0,95}\.json$/.test(approval.path) &&
      validHash(approval.sha256),
    'pilot cap approval is invalid',
  );
  const wrapped = tokens.find((token) => token.symbol === 'WBLCH');
  const busdc = tokens.find((token) => token.symbol === 'bUSDC');
  requireValue(
    wrapped === wrappedTokens[0] &&
      wrapped?.decimals === 18 &&
      busdc?.decimals === 6 &&
      !busdc.wrappedNative &&
      busdc.address === bridgeAsset.destinationTokenAddress,
    'pilot token identities do not match the asset plan',
  );

  return {
    schemaVersion: 4,
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
      ...roles,
    },
    tokens,
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
        sourceTokenAddress: ETHEREUM_USDC as Address,
        destinationSymbol: 'bUSDC',
        destinationTokenAddress: bridgeAsset.destinationTokenAddress as Address,
      },
      pilotPool: {
        baseSymbol: 'BLCH',
        onchainBaseSymbol: 'WBLCH',
        quoteSymbol: 'bUSDC',
        liquidityEnabled: false,
        maxBaseBaseUnits: baseCap,
        maxQuoteBaseUnits: quoteCap,
        policyCapApproval: { path: approval.path, sha256: approval.sha256.toLowerCase() as Hex },
        requiresSeparateApproval: true,
      },
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
  requireValue(result.length <= 65_538, 'eth_call returned excessive data');
  return result as Hex;
}

function requestUnavailable(request?: LiveReadRequest): LiveReadUnavailableReason | undefined {
  if (request?.signal?.aborted) return 'cancelled';
  if (request && !request.current()) return 'stale';
  return undefined;
}

function unavailable<T>(reason: LiveReadUnavailableReason): LiveReadState<T> {
  return { available: false, reason };
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
  readonly #tokens: ReadonlySet<string>;

  private constructor(provider: Provider, registry: DeploymentRegistry, block: BlockIdentity) {
    this.#provider = provider;
    this.registry = registry;
    this.#blockTag = block.number;
    this.blockNumber = BigInt(block.number);
    this.blockHash = block.hash;
    this.#tokens = new Set(registry.tokens.map((token) => token.address.toLowerCase()));
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
    for (const name of ROLE_NAMES) {
      const identity = registry.deployment[name];
      const code = await request(provider, 'eth_getCode', [identity.address, snapshot.number]);
      requireValue(
        typeof code === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(code) && code.length <= 49_154,
        `${name} code is invalid`,
      );
      requireValue(
        keccak256(code as Hex).toLowerCase() === identity.runtimeCodeHash,
        `${name} code hash does not match registry`,
      );
    }
    for (const token of registry.tokens) {
      if (token.address.toLowerCase() === registry.deployment.wrappedNative.address.toLowerCase())
        continue;
      const code = await request(provider, 'eth_getCode', [token.address, snapshot.number]);
      requireValue(
        typeof code === 'string' && CODE.test(code) && code.length <= 49_154,
        `${token.symbol} token code is invalid`,
      );
      requireValue(
        keccak256(code as Hex).toLowerCase() === token.runtimeCodeHash,
        `${token.symbol} token code hash does not match registry`,
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
    const collectorTreasury = await readFunction<Address>(
      provider,
      registry.deployment.collector.address,
      collectorAbi,
      'treasury',
      snapshot.number,
    );
    const feeTo = await readFunction<Address>(
      provider,
      factory,
      factoryAbi,
      'feeTo',
      snapshot.number,
    );
    const feeToSetter = await readFunction<Address>(
      provider,
      factory,
      factoryAbi,
      'feeToSetter',
      snapshot.number,
    );
    const pendingFeeToSetter = await readFunction<Address>(
      provider,
      factory,
      factoryAbi,
      'pendingFeeToSetter',
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
      collectorTreasury.toLowerCase() === registry.deployment.treasury.address.toLowerCase(),
      'collector treasury binding is invalid',
    );
    requireValue(
      feeTo === ZERO_ADDRESS &&
        pendingFeeToSetter === ZERO_ADDRESS &&
        feeToSetter.toLowerCase() === registry.deployment.feeAuthority.address.toLowerCase(),
      'factory fee controls are not in the reviewed disabled state',
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
      validAddress(tokenA) &&
        validAddress(tokenB) &&
        tokenA.toLowerCase() !== tokenB.toLowerCase() &&
        this.#tokens.has(tokenA.toLowerCase()) &&
        this.#tokens.has(tokenB.toLowerCase()),
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

  async readPool(
    tokenA: string,
    tokenB: string,
    readRequest?: LiveReadRequest,
  ): Promise<LiveReadState<LivePoolSnapshot>> {
    const blocked = requestUnavailable(readRequest);
    if (blocked) return unavailable(blocked);
    if (
      !validAddress(tokenA) ||
      !validAddress(tokenB) ||
      tokenA.toLowerCase() === tokenB.toLowerCase() ||
      !this.#tokens.has(tokenA.toLowerCase()) ||
      !this.#tokens.has(tokenB.toLowerCase())
    )
      return unavailable('invalid-request');
    try {
      const pool = await this.poolFor(tokenA, tokenB);
      const after = requestUnavailable(readRequest);
      if (after) return unavailable(after);
      if (!pool.exists) return unavailable('missing-pool');
      if (pool.totalSupply === 0n || pool.reserve0 === 0n || pool.reserve1 === 0n)
        return unavailable('empty-pool');
      return { available: true, value: pool };
    } catch {
      return unavailable(requestUnavailable(readRequest) ?? 'provider-unavailable');
    }
  }

  async pools(
    cursor: bigint,
    limit: number,
    readRequest?: LiveReadRequest,
  ): Promise<LiveReadState<LivePoolPage>> {
    const blocked = requestUnavailable(readRequest);
    if (blocked) return unavailable(blocked);
    if (
      cursor < 0n ||
      cursor > MAX_UINT256 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 64
    )
      return unavailable('invalid-request');
    try {
      const result = await readFunction<
        readonly [
          ReadonlyArray<{
            pair: Address;
            token0: Address;
            token1: Address;
            reserve0: bigint;
            reserve1: bigint;
            reserveTimestamp: number;
            totalSupply: bigint;
          }>,
          bigint,
          bigint,
        ]
      >(this.#provider, this.registry.deployment.lens.address, lensAbi, 'pools', this.#blockTag, [
        cursor,
        BigInt(limit),
      ]);
      const afterCall = requestUnavailable(readRequest);
      if (afterCall) return unavailable(afterCall);
      await confirmBlock(this.#provider, { number: this.#blockTag, hash: this.blockHash });
      const afterConfirm = requestUnavailable(readRequest);
      if (afterConfirm) return unavailable(afterConfirm);
      const [page, nextCursor, total] = result;
      requireValue(page.length <= limit && nextCursor <= total, 'lens returned invalid pagination');
      requireValue(
        cursor >= total
          ? page.length === 0 && nextCursor === total
          : nextCursor === cursor + BigInt(page.length),
        'lens returned inconsistent pagination',
      );
      const seen = new Set<string>();
      for (const pool of page) {
        requireValue(
          validAddress(pool.pair) &&
            validAddress(pool.token0) &&
            validAddress(pool.token1) &&
            pool.token0.toLowerCase() < pool.token1.toLowerCase() &&
            !seen.has(pool.pair.toLowerCase()),
          'lens returned an inconsistent pool page',
        );
        seen.add(pool.pair.toLowerCase());
      }
      const supported = page.filter(
        (pool) =>
          this.#tokens.has(pool.token0.toLowerCase()) &&
          this.#tokens.has(pool.token1.toLowerCase()),
      );
      return {
        available: true,
        value: {
          blockNumber: this.blockNumber,
          blockHash: this.blockHash,
          pools: supported,
          nextCursor,
          total,
          filteredUnsupported: page.length - supported.length,
        },
      };
    } catch {
      return unavailable(requestUnavailable(readRequest) ?? 'provider-unavailable');
    }
  }

  async quoteExactInput(
    amountIn: bigint,
    path: readonly string[],
    slippageBps: number,
    readRequest?: LiveReadRequest,
  ): Promise<LiveReadState<LiveQuote>> {
    const blocked = requestUnavailable(readRequest);
    if (blocked) return unavailable(blocked);
    if (
      amountIn < 1n ||
      amountIn > MAX_UINT112 ||
      path.length < 2 ||
      path.length > 5 ||
      !Number.isSafeInteger(slippageBps) ||
      slippageBps < 0 ||
      slippageBps > 10_000 ||
      path.some((token) => !validAddress(token) || !this.#tokens.has(token.toLowerCase()))
    )
      return unavailable('invalid-request');
    const edges = new Set<string>();
    for (let index = 0; index < path.length - 1; index += 1) {
      const left = path[index].toLowerCase();
      const right = path[index + 1].toLowerCase();
      if (left === right) return unavailable('invalid-request');
      const edge = left < right ? `${left}:${right}` : `${right}:${left}`;
      if (edges.has(edge)) return unavailable('invalid-request');
      edges.add(edge);
    }
    try {
      const quote = await readFunction<{
        available: boolean;
        blockNumber: bigint;
        timestamp: bigint;
        amountOut: bigint;
        minimumOut: bigint;
        amounts: readonly bigint[];
        executionLossBps: readonly bigint[];
      }>(
        this.#provider,
        this.registry.deployment.lens.address,
        lensAbi,
        'quoteExactInput',
        this.#blockTag,
        [amountIn, path, BigInt(slippageBps)],
      );
      const afterCall = requestUnavailable(readRequest);
      if (afterCall) return unavailable(afterCall);
      await confirmBlock(this.#provider, { number: this.#blockTag, hash: this.blockHash });
      const afterConfirm = requestUnavailable(readRequest);
      if (afterConfirm) return unavailable(afterConfirm);
      requireValue(
        quote.blockNumber === this.blockNumber &&
          quote.amounts.length === path.length &&
          quote.executionLossBps.length === path.length - 1 &&
          quote.amounts[0] === amountIn,
        'lens returned an inconsistent quote',
      );
      if (!quote.available) return unavailable('quote-unavailable');
      requireValue(
        quote.amountOut > 0n &&
          quote.minimumOut > 0n &&
          quote.minimumOut <= quote.amountOut &&
          quote.amounts[path.length - 1] === quote.amountOut,
        'lens returned an invalid available quote',
      );
      return {
        available: true,
        value: {
          blockNumber: quote.blockNumber,
          blockHash: this.blockHash,
          timestamp: quote.timestamp,
          amountOut: quote.amountOut,
          minimumOut: quote.minimumOut,
          amounts: quote.amounts,
          executionLossBps: quote.executionLossBps,
        },
      };
    } catch {
      return unavailable(requestUnavailable(readRequest) ?? 'provider-unavailable');
    }
  }

  async balances(
    owner: string,
    tokens: readonly string[],
    readRequest?: LiveReadRequest,
  ): Promise<LiveReadState<LiveBalances>> {
    const blocked = requestUnavailable(readRequest);
    if (blocked) return unavailable(blocked);
    if (
      !validAddress(owner) ||
      tokens.length > 32 ||
      tokens.some((token) => !validAddress(token) || !this.#tokens.has(token.toLowerCase())) ||
      new Set(tokens.map((token) => token.toLowerCase())).size !== tokens.length
    )
      return unavailable('invalid-request');
    try {
      const native = await request(this.#provider, 'eth_getBalance', [owner, this.#blockTag]);
      requireValue(
        typeof native === 'string' && QUANTITY.test(native),
        'native balance is invalid',
      );
      const tokenBalances: Array<{ token: Address; balance: bigint }> = [];
      for (const token of tokens) {
        const interrupted = requestUnavailable(readRequest);
        if (interrupted) return unavailable(interrupted);
        const balance = await readFunction<bigint>(
          this.#provider,
          token as Address,
          tokenAbi,
          'balanceOf',
          this.#blockTag,
          [owner],
        );
        tokenBalances.push({ token: token as Address, balance });
      }
      const afterCall = requestUnavailable(readRequest);
      if (afterCall) return unavailable(afterCall);
      await confirmBlock(this.#provider, { number: this.#blockTag, hash: this.blockHash });
      const afterConfirm = requestUnavailable(readRequest);
      if (afterConfirm) return unavailable(afterConfirm);
      return {
        available: true,
        value: {
          blockNumber: this.blockNumber,
          blockHash: this.blockHash,
          owner: owner as Address,
          nativeBalance: BigInt(native),
          tokens: tokenBalances,
        },
      };
    } catch {
      return unavailable(requestUnavailable(readRequest) ?? 'provider-unavailable');
    }
  }
}
