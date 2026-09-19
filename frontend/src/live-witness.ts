import {
  importLiveReadTrustAnchor,
  LIVE_WITNESS_DOMAIN,
  type LiveReadTrustAnchor,
  verifySignedJson,
} from './live-auth';

const MAX_WITNESS_BYTES = 4_096;
const MAX_WITNESS_SECONDS = 15 * 60;
const MAX_CLOCK_SKEW_SECONDS = 5 * 60;
const WITNESS_TIMEOUT_MS = 5_000;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const WITNESS_KEYS = new Set([
  'schemaVersion',
  'liveReadKeyId',
  'minimumLiveReadKeyGeneration',
  'issuedAt',
  'expiresAt',
]);

async function boundedText(response: Response): Promise<string> {
  const declared = response.headers.get('content-length');
  if (
    declared !== null &&
    (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_WITNESS_BYTES)
  )
    throw new Error('witness response is oversized');
  if (!response.body) throw new Error('witness response has no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_WITNESS_BYTES) {
      await reader.cancel();
      throw new Error('witness response is oversized');
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function witnessUrl(encoded: unknown, pageOrigin: string): string {
  if (typeof encoded !== 'string') throw new Error('witness URL is missing');
  const url = new URL(encoded);
  if (
    url.protocol !== 'https:' ||
    url.origin === pageOrigin ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.href !== encoded
  )
    throw new Error('witness URL is invalid');
  return url.href;
}

/** Requires a fresh statement from a separately hosted, independently pinned generation witness. */
export async function verifyLiveReadWitness(
  liveReadAnchor: LiveReadTrustAnchor,
  pageOrigin: string,
  encodedWitnessUrl: unknown,
  encodedWitnessPublicKey: unknown,
  encodedWitnessKeyGeneration: unknown,
  nowSeconds: number,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const url = witnessUrl(encodedWitnessUrl, pageOrigin);
  const witnessAnchor = await importLiveReadTrustAnchor(
    encodedWitnessPublicKey,
    encodedWitnessKeyGeneration,
  );
  if (witnessAnchor.keyId === liveReadAnchor.keyId)
    throw new Error('witness key must be independent');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WITNESS_TIMEOUT_MS);
  try {
    const response = await fetchFn(url, {
      method: 'GET',
      mode: 'cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      redirect: 'error',
      cache: 'no-store',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok || response.redirected || (response.url && response.url !== url))
      throw new Error('witness response is invalid');
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim();
    if (contentType !== 'application/json') throw new Error('witness content type is invalid');
    const envelope: unknown = JSON.parse(await boundedText(response));
    const verified = await verifySignedJson(envelope, witnessAnchor, LIVE_WITNESS_DOMAIN);
    if (!verified || typeof verified !== 'object' || Array.isArray(verified))
      throw new Error('witness payload is invalid');
    const value = verified as Record<string, unknown>;
    const checkedAt = Math.max(nowSeconds, Math.floor(Date.now() / 1_000));
    if (
      Object.keys(value).length !== WITNESS_KEYS.size ||
      Object.keys(value).some((key) => !WITNESS_KEYS.has(key)) ||
      value.schemaVersion !== 1 ||
      typeof value.liveReadKeyId !== 'string' ||
      !HEX_SHA256.test(value.liveReadKeyId) ||
      value.liveReadKeyId !== liveReadAnchor.keyId ||
      !Number.isSafeInteger(value.minimumLiveReadKeyGeneration) ||
      Number(value.minimumLiveReadKeyGeneration) < 1 ||
      liveReadAnchor.keyGeneration < Number(value.minimumLiveReadKeyGeneration) ||
      !Number.isSafeInteger(value.issuedAt) ||
      !Number.isSafeInteger(value.expiresAt) ||
      Number(value.issuedAt) > checkedAt + MAX_CLOCK_SKEW_SECONDS ||
      Number(value.expiresAt) <= checkedAt ||
      Number(value.expiresAt) <= Number(value.issuedAt) ||
      Number(value.expiresAt) - Number(value.issuedAt) > MAX_WITNESS_SECONDS
    )
      throw new Error('witness policy is invalid');
  } finally {
    clearTimeout(timer);
  }
}
