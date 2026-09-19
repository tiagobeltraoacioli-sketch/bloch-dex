import type { Provider } from './wallet';
import { LiveReadAdapter, parseDeploymentRegistry, type DeploymentRegistry } from './live-read';
import {
  liveReadPayloadSha256,
  LIVE_MANIFEST_DOMAIN,
  verifySignedJson,
  type LiveReadTrustAnchor,
} from './live-auth';

const READ_METHODS = new Set([
  'eth_chainId',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_getBalance',
  'eth_call',
]);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DATA = /^0x(?:[0-9a-fA-F]{2})*$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const REVISION = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_MANIFEST_BYTES = 512 * 1024;
const MAX_RPC_BYTES = 1024 * 1024;

export type RuntimeFetch = typeof fetch;
export type LiveRuntimeOptions = {
  registryUrl: string;
  pageOrigin: string;
  allowedRpcOrigins: readonly string[];
  trustAnchor: LiveReadTrustAnchor;
  manifestSha256: string;
  expiresAt: number;
  timeoutMs?: number;
  fetchFn?: RuntimeFetch;
};

export type LiveReaderSession = {
  reader: LiveReadAdapter;
  close(): void;
};

type ConnectLiveReader = (
  provider: Provider,
  registry: DeploymentRegistry,
) => Promise<LiveReadAdapter>;

function runtimeError(message: string): Error {
  return new Error(`Live read runtime unavailable: ${message}`);
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw runtimeError(message);
}

function blockTag(value: unknown): boolean {
  return value === 'latest' || (typeof value === 'string' && QUANTITY.test(value));
}

function validateRequest(method: string, params: unknown[]): void {
  ensure(READ_METHODS.has(method), `RPC method ${method} is not read-only allowlisted`);
  if (method === 'eth_chainId') {
    ensure(params.length === 0, 'eth_chainId parameters are invalid');
    return;
  }
  if (method === 'eth_getBlockByNumber') {
    ensure(
      params.length === 2 && blockTag(params[0]) && params[1] === false,
      'block parameters are invalid',
    );
    return;
  }
  if (method === 'eth_getCode' || method === 'eth_getBalance') {
    ensure(
      params.length === 2 &&
        typeof params[0] === 'string' &&
        ADDRESS.test(params[0]) &&
        blockTag(params[1]),
      `${method} parameters are invalid`,
    );
    return;
  }
  const call = params[0];
  ensure(
    params.length === 2 &&
      call &&
      typeof call === 'object' &&
      !Array.isArray(call) &&
      Object.keys(call).length === 2 &&
      Object.keys(call).every((key) => key === 'to' || key === 'data') &&
      typeof (call as Record<string, unknown>).to === 'string' &&
      ADDRESS.test((call as Record<string, string>).to) &&
      typeof (call as Record<string, unknown>).data === 'string' &&
      DATA.test((call as Record<string, string>).data) &&
      blockTag(params[1]),
    'eth_call parameters are invalid',
  );
}

async function readBounded(response: Response, limit: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared !== null)
    ensure(/^\d+$/.test(declared) && Number(declared) <= limit, 'response is too large');
  ensure(response.body, 'response body is missing');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw runtimeError('response is too large');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(body);
}

function withAbort(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  dispose(): void;
  controller: AbortController;
} {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener('abort', abort, { once: true });
  const timer = window.setTimeout(abort, timeoutMs);
  return {
    signal: controller.signal,
    controller,
    dispose: () => {
      window.clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    },
  };
}

function normalizedOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw runtimeError('RPC origin allowlist contains an invalid URL');
  }
  ensure(
    url.protocol === 'https:' && url.origin === value,
    'RPC allowlist entries must be HTTPS origins',
  );
  return url.origin;
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

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class ReadOnlyRpcProvider implements Provider {
  readonly #url: string;
  readonly #fetch: RuntimeFetch;
  readonly #timeoutMs: number;
  readonly #controllers = new Set<AbortController>();
  #nextId = 1;
  #closed = false;

  constructor(url: string, allowedOrigins: readonly string[], timeoutMs = 8_000, fetchFn = fetch) {
    ensure(
      Number.isSafeInteger(timeoutMs) && timeoutMs >= 250 && timeoutMs <= 30_000,
      'RPC timeout is invalid',
    );
    const parsed = new URL(url);
    const allowlist = new Set(allowedOrigins.map(normalizedOrigin));
    ensure(allowlist.size > 0 && allowlist.has(parsed.origin), 'RPC origin is not allowlisted');
    ensure(
      parsed.protocol === 'https:' &&
        !parsed.username &&
        !parsed.password &&
        !parsed.search &&
        !parsed.hash,
      'RPC URL is unsafe',
    );
    this.#url = parsed.toString();
    this.#timeoutMs = timeoutMs;
    this.#fetch = fetchFn;
  }

  async request(args: { method: string; params?: unknown[] }): Promise<unknown> {
    ensure(!this.#closed, 'RPC provider is closed');
    const params = args.params ?? [];
    validateRequest(args.method, params);
    const id = this.#nextId++;
    ensure(Number.isSafeInteger(this.#nextId), 'RPC request ID exhausted');
    const pending = withAbort(undefined, this.#timeoutMs);
    this.#controllers.add(pending.controller);
    try {
      const response = await this.#fetch(this.#url, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: args.method, params }),
        signal: pending.signal,
      });
      ensure(response.ok, 'RPC HTTP request failed');
      const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
      ensure(type === 'application/json', 'RPC response type is invalid');
      const parsed: unknown = JSON.parse(await readBounded(response, MAX_RPC_BYTES));
      ensure(
        parsed && typeof parsed === 'object' && !Array.isArray(parsed),
        'RPC response is invalid',
      );
      const envelope = parsed as Record<string, unknown>;
      ensure(
        envelope.jsonrpc === '2.0' &&
          envelope.id === id &&
          !('error' in envelope) &&
          'result' in envelope,
        'RPC response envelope is invalid',
      );
      return envelope.result;
    } catch (error) {
      if (pending.signal.aborted) throw runtimeError('RPC request timed out or was aborted');
      if (error instanceof Error && error.message.startsWith('Live read runtime unavailable:'))
        throw error;
      throw runtimeError('RPC request failed');
    } finally {
      pending.dispose();
      this.#controllers.delete(pending.controller);
    }
  }

  close(): void {
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort();
    this.#controllers.clear();
  }
}

export async function loadDeploymentRegistry(
  options: LiveRuntimeOptions,
  signal?: AbortSignal,
): Promise<DeploymentRegistry> {
  ensure(
    Number.isSafeInteger(options.expiresAt) && options.expiresAt > Math.floor(Date.now() / 1_000),
    'signed gate has expired',
  );
  let page: URL;
  let registryUrl: URL;
  try {
    page = new URL(options.pageOrigin);
    registryUrl = new URL(options.registryUrl, page);
  } catch {
    throw runtimeError('registry URL is invalid');
  }
  ensure(
    page.protocol === 'https:' &&
      page.origin === options.pageOrigin &&
      registryUrl.origin === page.origin &&
      !registryUrl.username &&
      !registryUrl.password &&
      !registryUrl.search &&
      !registryUrl.hash,
    'registry must be a credential-free same-origin URL',
  );
  const timeoutMs = options.timeoutMs ?? 8_000;
  ensure(
    Number.isSafeInteger(timeoutMs) && timeoutMs >= 250 && timeoutMs <= 30_000,
    'registry timeout is invalid',
  );
  const pending = withAbort(signal, timeoutMs);
  try {
    const response = await (options.fetchFn ?? fetch)(registryUrl, {
      method: 'GET',
      credentials: 'same-origin',
      redirect: 'error',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: pending.signal,
    });
    ensure(response.ok, 'registry request failed');
    const type = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    ensure(type === 'application/json', 'registry response type is invalid');
    const envelope: unknown = JSON.parse(await readBounded(response, MAX_MANIFEST_BYTES));
    const parsed = await verifySignedJson(envelope, options.trustAnchor, LIVE_MANIFEST_DOMAIN);
    ensure(
      SHA256.test(options.manifestSha256) &&
        (await liveReadPayloadSha256(LIVE_MANIFEST_DOMAIN, parsed)) === options.manifestSha256,
      'signed manifest does not match the gate pin',
    );
    ensure(
      parsed && typeof parsed === 'object' && !Array.isArray(parsed),
      'artifact manifest is invalid',
    );
    const manifest = parsed as Record<string, unknown>;
    ensure(manifest.schemaVersion === 1, 'artifact schema is unsupported');
    const target = manifest.target as Record<string, unknown> | undefined;
    ensure(
      target?.environment === 'staging' &&
        target.host === 'bloch-dex' &&
        target.frontendMode === 'preview' &&
        target.liquidityEnabled === false,
      'artifact target does not match read-only staging',
    );
    ensure(REVISION.test(String(manifest.sourceRevision)), 'artifact source revision is invalid');
    ensure(
      SHA256.test(String(manifest.configurationSha256)),
      'configuration fingerprint is invalid',
    );
    ensure(manifest.deploymentConfiguration, 'deployment configuration is missing');
    ensure(
      (await sha256(stableJson(manifest.deploymentConfiguration))) === manifest.configurationSha256,
      'deployment configuration fingerprint does not match',
    );
    const registry = parseDeploymentRegistry(manifest.deploymentConfiguration);
    const allowed = new Set(options.allowedRpcOrigins.map(normalizedOrigin));
    ensure(
      allowed.size > 0 && allowed.has(new URL(registry.chain.rpcUrl).origin),
      'registry RPC origin is not allowlisted',
    );
    return registry;
  } catch (error) {
    if (pending.signal.aborted) throw runtimeError('registry request timed out or was aborted');
    if (error instanceof Error && error.message.startsWith('Live read')) throw error;
    throw runtimeError('registry request failed');
  } finally {
    pending.dispose();
  }
}

export class LiveReaderFactory {
  readonly #options: LiveRuntimeOptions;
  readonly #connect: ConnectLiveReader;

  constructor(options: LiveRuntimeOptions, connect: ConnectLiveReader = LiveReadAdapter.connect) {
    this.#options = { ...options, allowedRpcOrigins: [...options.allowedRpcOrigins] };
    this.#connect = connect;
  }

  async open(signal?: AbortSignal): Promise<LiveReaderSession> {
    const owner = new AbortController();
    const abort = () => owner.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) owner.abort();
    let provider: ReadOnlyRpcProvider | undefined;
    try {
      const registry = await loadDeploymentRegistry(this.#options, owner.signal);
      provider = new ReadOnlyRpcProvider(
        registry.chain.rpcUrl,
        this.#options.allowedRpcOrigins,
        this.#options.timeoutMs,
        this.#options.fetchFn,
      );
      owner.signal.addEventListener('abort', () => provider?.close(), { once: true });
      const reader = await this.#connect(provider, registry);
      return { reader, close: () => provider?.close() };
    } catch (error) {
      provider?.close();
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
}
