import { LiveReaderFactory, type LiveRuntimeOptions } from './live-runtime';

const CONFIG_ID = 'postern-live-read-config';
const MAX_CONFIG_BYTES = 4_096;
const MAX_RPC_ORIGINS = 8;
const ALLOWED_KEYS = new Set([
  'schemaVersion',
  'enabled',
  'mode',
  'registryUrl',
  'allowedRpcOrigins',
  'timeoutMs',
]);

export type LiveReadGate =
  | { available: false; reason: 'missing' | 'invalid' }
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
export function readLiveReadGate(
  documentValue: Document = document,
  pageOrigin: string = location.origin,
): LiveReadGate {
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
    const value: unknown = JSON.parse(element.textContent);
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return { available: false, reason: 'invalid' };
    const config = value as Record<string, unknown>;
    if (
      Object.keys(config).some((key) => !ALLOWED_KEYS.has(key)) ||
      config.schemaVersion !== 1 ||
      config.enabled !== true ||
      config.mode !== 'read-only' ||
      typeof config.registryUrl !== 'string' ||
      !Array.isArray(config.allowedRpcOrigins) ||
      config.allowedRpcOrigins.length === 0 ||
      config.allowedRpcOrigins.length > MAX_RPC_ORIGINS ||
      !config.allowedRpcOrigins.every(exactHttpsOrigin) ||
      new Set(config.allowedRpcOrigins).size !== config.allowedRpcOrigins.length ||
      (config.timeoutMs !== undefined &&
        (!Number.isSafeInteger(config.timeoutMs) ||
          Number(config.timeoutMs) < 250 ||
          Number(config.timeoutMs) > 30_000))
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
      ...(config.timeoutMs === undefined ? {} : { timeoutMs: Number(config.timeoutMs) }),
    };
    return { available: true, factory: new LiveReaderFactory(options) };
  } catch {
    return { available: false, reason: 'invalid' };
  }
}
