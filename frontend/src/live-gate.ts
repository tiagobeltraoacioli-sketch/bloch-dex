import { LiveReaderFactory, type LiveRuntimeOptions } from './live-runtime';
import { importLiveReadTrustAnchor, LIVE_GATE_DOMAIN, verifySignedJson } from './live-auth';

const CONFIG_ID = 'postern-live-read-config';
const MAX_CONFIG_BYTES = 4_096;
const MAX_RPC_ORIGINS = 8;
const MAX_VALIDITY_SECONDS = 7 * 24 * 60 * 60;
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;
const ALLOWED_KEYS = new Set([
  'schemaVersion',
  'enabled',
  'mode',
  'registryUrl',
  'manifestSha256',
  'issuedAt',
  'expiresAt',
  'allowedRpcOrigins',
  'timeoutMs',
]);

export type LiveReadGate =
  | { available: false; reason: 'loading' | 'missing' | 'invalid' | 'untrusted' }
  | { available: true; factory: LiveReaderFactory };

function exactHttpsOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  } catch {
    return false;
  }
}

/** Reads one host-injected, non-executable gate. No deployment value is bundled. */
export async function readLiveReadGate(
  documentValue: Document = document,
  pageOrigin: string = location.origin,
  encodedPublicKey: unknown = import.meta.env.VITE_POSTERN_LIVE_READ_PUBLIC_KEY,
  encodedKeyGeneration: unknown = import.meta.env.VITE_POSTERN_LIVE_READ_KEY_GENERATION,
  nowSeconds: number = Math.floor(Date.now() / 1_000),
): Promise<LiveReadGate> {
  const element = documentValue.getElementById(CONFIG_ID);
  if (!element) return { available: false, reason: 'missing' };
  if (
    element.tagName !== 'SCRIPT' ||
    element.getAttribute('type') !== 'application/json' ||
    element.children.length !== 0 ||
    element.textContent === null ||
    new TextEncoder().encode(element.textContent).byteLength > MAX_CONFIG_BYTES
  ) {
    return { available: false, reason: 'invalid' };
  }

  try {
    const envelope: unknown = JSON.parse(element.textContent);
    let value: unknown;
    let trustAnchor;
    try {
      trustAnchor = await importLiveReadTrustAnchor(encodedPublicKey, encodedKeyGeneration);
      value = await verifySignedJson(envelope, trustAnchor, LIVE_GATE_DOMAIN);
    } catch {
      return { available: false, reason: 'untrusted' };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return { available: false, reason: 'invalid' };
    const config = value as Record<string, unknown>;
    if (
      Object.keys(config).length !== ALLOWED_KEYS.size ||
      Object.keys(config).some((key) => !ALLOWED_KEYS.has(key)) ||
      config.schemaVersion !== 1 ||
      config.enabled !== true ||
      config.mode !== 'read-only' ||
      typeof config.registryUrl !== 'string' ||
      typeof config.manifestSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(config.manifestSha256) ||
      !Number.isSafeInteger(config.issuedAt) ||
      !Number.isSafeInteger(config.expiresAt) ||
      Number(config.issuedAt) > nowSeconds + MAX_CLOCK_SKEW_SECONDS ||
      Number(config.expiresAt) <= nowSeconds ||
      Number(config.expiresAt) <= Number(config.issuedAt) ||
      Number(config.expiresAt) - Number(config.issuedAt) > MAX_VALIDITY_SECONDS ||
      !Array.isArray(config.allowedRpcOrigins) ||
      config.allowedRpcOrigins.length === 0 ||
      config.allowedRpcOrigins.length > MAX_RPC_ORIGINS ||
      !config.allowedRpcOrigins.every(exactHttpsOrigin) ||
      new Set(config.allowedRpcOrigins).size !== config.allowedRpcOrigins.length ||
      !Number.isSafeInteger(config.timeoutMs) ||
      Number(config.timeoutMs) < 250 ||
      Number(config.timeoutMs) > 30_000
    ) {
      return { available: false, reason: 'invalid' };
    }
    const page = new URL(pageOrigin);
    const registry = new URL(config.registryUrl, page);
    if (
      page.protocol !== 'https:' ||
      page.origin !== pageOrigin ||
      registry.origin !== page.origin ||
      registry.username ||
      registry.password ||
      registry.search ||
      registry.hash
    ) {
      return { available: false, reason: 'invalid' };
    }
    const options: LiveRuntimeOptions = {
      registryUrl: registry.pathname,
      pageOrigin,
      allowedRpcOrigins: [...config.allowedRpcOrigins],
      trustAnchor,
      manifestSha256: config.manifestSha256,
      expiresAt: Number(config.expiresAt),
      timeoutMs: Number(config.timeoutMs),
    };
    return { available: true, factory: new LiveReaderFactory(options) };
  } catch {
    return { available: false, reason: 'invalid' };
  }
}
