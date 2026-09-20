import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import type { LiveReadAdapter } from '../live-read';
import type { Provider } from '../wallet';
import {
  LiveReaderFactory,
  ReadOnlyRpcProvider,
  loadDeploymentRegistry,
  type RuntimeFetch,
} from '../live-runtime';
import { liveReadPayloadSha256, LIVE_MANIFEST_DOMAIN } from '../live-auth';
import { createSigningFixture, type SigningFixture } from './live-auth-helpers';

const address = (byte: string) => `0x${byte.repeat(40)}` as Address;
const hash = (byte: string) => `0x${byte.repeat(64)}` as Hex;
const futureExpiry = () => Math.floor(Date.now() / 1_000) + 3_600;
let signing: SigningFixture;

beforeAll(async () => {
  signing = await createSigningFixture();
});

function configuration() {
  return {
    schemaVersion: 4,
    environment: 'staging',
    host: 'bloch-dex',
    frontendMode: 'preview',
    liquidityEnabled: false,
    chain: { id: 1, genesisHash: hash('a'), rpcUrl: 'https://rpc.invalid/' },
    deployment: {
      blockNumber: 1,
      blockHash: hash('b'),
      pairInitCodeHash: hash('c'),
      factory: { address: address('1'), runtimeCodeHash: hash('1') },
      router: { address: address('2'), runtimeCodeHash: hash('2') },
      lens: { address: address('3'), runtimeCodeHash: hash('3') },
      collector: { address: address('4'), runtimeCodeHash: hash('4') },
      wrappedNative: { address: address('5'), runtimeCodeHash: hash('5') },
      feeAuthority: { address: address('7'), runtimeCodeHash: hash('7') },
      treasury: { address: address('8'), runtimeCodeHash: hash('8') },
    },
    tokens: [
      {
        address: address('5'),
        runtimeCodeHash: hash('5'),
        symbol: 'WBLCH',
        name: 'Wrapped BLCH',
        decimals: 18,
        wrappedNative: true,
        policy: { feeOnTransfer: false, rebasing: false },
      },
      {
        address: address('6'),
        runtimeCodeHash: hash('6'),
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
        destinationTokenAddress: address('6'),
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
          sha256: hash('9'),
        },
        requiresSeparateApproval: true,
      },
    },
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function fingerprint(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(value)));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function artifact(overrides: Record<string, unknown> = {}) {
  const deploymentConfiguration = configuration();
  return signing.sign(
    {
      schemaVersion: 1,
      sourceRevision: 'a'.repeat(40),
      target: {
        environment: 'staging',
        host: 'bloch-dex',
        frontendMode: 'preview',
        liquidityEnabled: false,
      },
      configurationSha256: await fingerprint(deploymentConfiguration),
      deploymentConfiguration,
      capApprovalVerified: false,
      ...overrides,
    },
    LIVE_MANIFEST_DOMAIN,
  );
}

async function artifactPin(value: unknown): Promise<string> {
  return liveReadPayloadSha256(LIVE_MANIFEST_DOMAIN, (value as { payload: unknown }).payload);
}

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

afterEach(() => vi.useRealTimers());

describe('read-only RPC provider', () => {
  it('does not invoke a browser fetch function with the provider as its receiver', async () => {
    const fetchFn = vi.fn(function (this: unknown, _url: RequestInfo | URL, init?: RequestInit) {
      if (this !== undefined) throw new TypeError('Illegal invocation');
      const request = JSON.parse(String(init?.body)) as { id: number };
      return Promise.resolve(json({ jsonrpc: '2.0', id: request.id, result: '0x1' }));
    });
    const provider = new ReadOnlyRpcProvider(
      'https://rpc.invalid/',
      ['https://rpc.invalid'],
      futureExpiry(),
      1_000,
      fetchFn,
    );
    await expect(provider.request({ method: 'eth_chainId' })).resolves.toBe('0x1');
  });

  it('allows only exact read methods and safe RPC call parameters', async () => {
    const fetchFn = vi.fn<RuntimeFetch>(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { id: number };
      return json({ jsonrpc: '2.0', id: request.id, result: '0x1' });
    });
    const provider = new ReadOnlyRpcProvider(
      'https://rpc.invalid/',
      ['https://rpc.invalid'],
      futureExpiry(),
      1_000,
      fetchFn,
    );

    await expect(provider.request({ method: 'eth_chainId' })).resolves.toBe('0x1');
    await expect(
      provider.request({ method: 'eth_sendTransaction', params: [{ to: address('1') }] }),
    ).rejects.toThrow(/not read-only allowlisted/);
    await expect(
      provider.request({
        method: 'eth_call',
        params: [{ to: address('1'), data: '0x1234', value: '0x1' }, 'latest'],
      }),
    ).rejects.toThrow(/parameters are invalid/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
  });

  it('rejects unallowlisted origins and invalid response envelopes', async () => {
    expect(
      () =>
        new ReadOnlyRpcProvider('https://other.invalid/', ['https://rpc.invalid'], futureExpiry()),
    ).toThrow(/not allowlisted/);
    const provider = new ReadOnlyRpcProvider(
      'https://rpc.invalid/',
      ['https://rpc.invalid'],
      futureExpiry(),
      1_000,
      vi.fn(async () => json({ jsonrpc: '2.0', id: 99, result: '0x1' })),
    );
    await expect(provider.request({ method: 'eth_chainId' })).rejects.toThrow(
      /envelope is invalid/,
    );

    const oversized = new ReadOnlyRpcProvider(
      'https://rpc.invalid/',
      ['https://rpc.invalid'],
      futureExpiry(),
      1_000,
      vi.fn(async () =>
        json(
          { jsonrpc: '2.0', id: 1, result: '0x1' },
          { headers: { 'content-type': 'application/json', 'content-length': '1048577' } },
        ),
      ),
    );
    await expect(oversized.request({ method: 'eth_chainId' })).rejects.toThrow(/too large/);
    expect(
      () =>
        new ReadOnlyRpcProvider(
          'https://rpc.invalid/',
          ['https://rpc.invalid'],
          Math.floor(Date.now() / 1_000),
        ),
    ).toThrow(/signed gate has expired/);
  });

  it('aborts bounded requests on timeout and when closed', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn<RuntimeFetch>(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const provider = new ReadOnlyRpcProvider(
      'https://rpc.invalid/',
      ['https://rpc.invalid'],
      futureExpiry(),
      250,
      fetchFn,
    );
    const timedOut = expect(provider.request({ method: 'eth_chainId' })).rejects.toThrow(
      /timed out or was aborted/,
    );
    await vi.advanceTimersByTimeAsync(250);
    await timedOut;

    const closed = expect(provider.request({ method: 'eth_chainId' })).rejects.toThrow(
      /timed out or was aborted/,
    );
    provider.close();
    await closed;
    await expect(provider.request({ method: 'eth_chainId' })).rejects.toThrow(/provider is closed/);
  });

  it('aborts in-flight reads at signed gate expiry and refuses later reads', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T12:00:00.000Z'));
    const expiresAt = Math.floor(Date.now() / 1_000) + 1;
    const fetchFn = vi.fn<RuntimeFetch>(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const provider = new ReadOnlyRpcProvider(
      'https://rpc.invalid/',
      ['https://rpc.invalid'],
      expiresAt,
      30_000,
      fetchFn,
    );

    const expired = expect(provider.request({ method: 'eth_chainId' })).rejects.toThrow(
      /signed gate has expired/,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expired;
    await expect(provider.request({ method: 'eth_chainId' })).rejects.toThrow(
      /signed gate has expired/,
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('deployment registry composition', () => {
  it('loads a signed fingerprinted same-origin manifest and rejects cross-origin URLs', async () => {
    const manifest = await artifact();
    const fetchFn = vi.fn<RuntimeFetch>(async () => json(manifest));
    const options = {
      registryUrl: '/deployment/artifact.json',
      pageOrigin: 'https://dex.invalid',
      allowedRpcOrigins: ['https://rpc.invalid'],
      trustAnchor: signing.trustAnchor,
      manifestSha256: await artifactPin(manifest),
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
      fetchFn,
    };
    await expect(loadDeploymentRegistry(options)).resolves.toMatchObject({ schemaVersion: 4 });
    await expect(
      loadDeploymentRegistry({
        ...options,
        fetchFn: vi.fn(async () => json((manifest as { payload: unknown }).payload)),
      }),
    ).rejects.toThrow(/authentication failed: envelope is invalid/);
    expect(fetchFn.mock.calls[0][0].toString()).toBe(
      'https://dex.invalid/deployment/artifact.json',
    );
    expect(fetchFn.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
    });
    await expect(
      loadDeploymentRegistry({ ...options, registryUrl: 'https://attacker.invalid/a.json' }),
    ).rejects.toThrow(/same-origin/);
    await expect(
      loadDeploymentRegistry({ ...options, pageOrigin: 'http://dex.invalid' }),
    ).rejects.toThrow(/same-origin/);
    await expect(loadDeploymentRegistry({ ...options, expiresAt: 1 })).rejects.toThrow(/expired/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('rejects target, fingerprint and RPC-origin substitutions', async () => {
    const good = await artifact();
    const options = {
      registryUrl: '/deployment/artifact.json',
      pageOrigin: 'https://dex.invalid',
      allowedRpcOrigins: ['https://rpc.invalid'],
      trustAnchor: signing.trustAnchor,
      manifestSha256: await artifactPin(good),
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    };
    const tampered = structuredClone(good) as { payload: Record<string, unknown> };
    tampered.payload.sourceRevision = 'b'.repeat(40);
    await expect(
      loadDeploymentRegistry({
        ...options,
        fetchFn: vi.fn(async () => json(tampered)),
      }),
    ).rejects.toThrow(/signature is invalid/);
    const alternate = await artifact({ sourceRevision: 'b'.repeat(40) });
    await expect(
      loadDeploymentRegistry({
        ...options,
        fetchFn: vi.fn(async () => json(alternate)),
      }),
    ).rejects.toThrow(/does not match the gate pin/);
    const badFingerprint = await artifact({ configurationSha256: '0'.repeat(64) });
    await expect(
      loadDeploymentRegistry({
        ...options,
        manifestSha256: await artifactPin(badFingerprint),
        fetchFn: vi.fn(async () => json(badFingerprint)),
      }),
    ).rejects.toThrow(/fingerprint does not match/);
    const badTarget = await artifact({
      target: {
        environment: 'staging',
        host: 'bloch-dex',
        frontendMode: 'preview',
        liquidityEnabled: true,
      },
    });
    await expect(
      loadDeploymentRegistry({
        ...options,
        manifestSha256: await artifactPin(badTarget),
        fetchFn: vi.fn(async () => json(badTarget)),
      }),
    ).rejects.toThrow(/target does not match/);
    await expect(
      loadDeploymentRegistry({
        ...options,
        allowedRpcOrigins: ['https://elsewhere.invalid'],
        fetchFn: vi.fn(async () => json(good)),
      }),
    ).rejects.toThrow(/RPC origin is not allowlisted/);
  });

  it('does not return a registry whose signed gate expires during verification', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-18T12:00:00.000Z'));
    const manifest = await artifact();
    const expiresAt = Math.floor(Date.now() / 1_000) + 1;
    const fetchFn = vi.fn<RuntimeFetch>(async () => {
      vi.setSystemTime(expiresAt * 1_000);
      return json(manifest);
    });

    await expect(
      loadDeploymentRegistry({
        registryUrl: '/deployment/artifact.json',
        pageOrigin: 'https://dex.invalid',
        allowedRpcOrigins: ['https://rpc.invalid'],
        trustAnchor: signing.trustAnchor,
        manifestSha256: await artifactPin(manifest),
        expiresAt,
        fetchFn,
      }),
    ).rejects.toThrow(/signed gate has expired/);
  });

  it('reloads the registry and creates a fresh provider and adapter for every open', async () => {
    const manifest = await artifact();
    const fetchFn = vi.fn<RuntimeFetch>(async () => json(manifest));
    const readers = [{ id: 1 }, { id: 2 }] as unknown as LiveReadAdapter[];
    const connect = vi
      .fn<(provider: Provider) => Promise<LiveReadAdapter>>()
      .mockResolvedValueOnce(readers[0])
      .mockResolvedValueOnce(readers[1]);
    const factory = new LiveReaderFactory(
      {
        registryUrl: '/deployment/artifact.json',
        pageOrigin: 'https://dex.invalid',
        allowedRpcOrigins: ['https://rpc.invalid'],
        trustAnchor: signing.trustAnchor,
        manifestSha256: await artifactPin(manifest),
        expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
        fetchFn,
      },
      connect,
    );
    const first = await factory.open();
    const second = await factory.open();
    expect(first.reader).toBe(readers[0]);
    expect(second.reader).toBe(readers[1]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(connect.mock.calls[0][0]).not.toBe(connect.mock.calls[1][0]);
    first.close();
    await expect(connect.mock.calls[0][0].request({ method: 'eth_chainId' })).rejects.toThrow(
      /provider is closed/,
    );
    second.close();
  });
});
