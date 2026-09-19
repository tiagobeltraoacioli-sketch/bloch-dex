const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export const LIVE_GATE_DOMAIN = 'POSTERN_LIVE_GATE_V1\n';
export const LIVE_MANIFEST_DOMAIN = 'POSTERN_LIVE_MANIFEST_V1\n';

export type LiveReadTrustAnchor = {
  readonly keyId: string;
  readonly publicKey: CryptoKey;
};

function authError(message: string): Error {
  return new Error(`Live read authentication failed: ${message}`);
}

function decodeBase64Url(value: unknown, expectedBytes: number): Uint8Array {
  if (typeof value !== 'string' || !BASE64URL.test(value) || value.includes('='))
    throw authError('encoding is invalid');
  let decoded: string;
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    decoded = atob(`${normalized}${'='.repeat((4 - (normalized.length % 4)) % 4)}`);
  } catch {
    throw authError('encoding is invalid');
  }
  if (decoded.length !== expectedBytes) throw authError('encoded length is invalid');
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0))
      throw authError('only safe canonical integers are supported');
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null)
      throw authError('signed value is not plain JSON');
    return `{${Object.keys(input)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(input[key])}`)
      .join(',')}}`;
  }
  throw authError('signed value is not canonical JSON');
}

function signedBytes(domain: string, payload: unknown): Uint8Array {
  return new TextEncoder().encode(`${domain}${canonical(payload)}`);
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', arrayBuffer(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Imports a raw Ed25519 public key pinned into the reviewed frontend build. */
export async function importLiveReadTrustAnchor(
  encodedPublicKey: unknown,
): Promise<LiveReadTrustAnchor> {
  const raw = decodeBase64Url(encodedPublicKey, PUBLIC_KEY_BYTES);
  try {
    return {
      keyId: await sha256(raw),
      publicKey: await crypto.subtle.importKey(
        'raw',
        arrayBuffer(raw),
        { name: 'Ed25519' },
        false,
        ['verify'],
      ),
    };
  } catch {
    throw authError('Ed25519 is unavailable');
  }
}

/** Verifies a domain-separated signed envelope before returning untrusted payload JSON. */
export async function verifySignedJson(
  value: unknown,
  trustAnchor: LiveReadTrustAnchor,
  domain: string,
): Promise<unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw authError('envelope is invalid');
  const envelope = value as Record<string, unknown>;
  if (
    Object.keys(envelope).length !== 3 ||
    !Object.hasOwn(envelope, 'schemaVersion') ||
    !Object.hasOwn(envelope, 'payload') ||
    !Object.hasOwn(envelope, 'signature') ||
    envelope.schemaVersion !== 1 ||
    !envelope.signature ||
    typeof envelope.signature !== 'object' ||
    Array.isArray(envelope.signature)
  ) {
    throw authError('envelope is invalid');
  }
  const signature = envelope.signature as Record<string, unknown>;
  if (
    Object.keys(signature).length !== 3 ||
    signature.algorithm !== 'Ed25519' ||
    typeof signature.keyId !== 'string' ||
    !HEX_SHA256.test(signature.keyId) ||
    signature.keyId !== trustAnchor.keyId
  ) {
    throw authError('signature metadata is invalid');
  }
  const bytes = decodeBase64Url(signature.value, SIGNATURE_BYTES);
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      { name: 'Ed25519' },
      trustAnchor.publicKey,
      arrayBuffer(bytes),
      arrayBuffer(signedBytes(domain, envelope.payload)),
    );
  } catch {
    throw authError('signature verification is unavailable');
  }
  if (!valid) throw authError('signature is invalid');
  return envelope.payload;
}

/** Exported only to keep offline signing and browser verification byte-identical. */
export function canonicalLiveReadPayload(domain: string, payload: unknown): ArrayBuffer {
  return arrayBuffer(signedBytes(domain, payload));
}

export async function liveReadPayloadSha256(domain: string, payload: unknown): Promise<string> {
  return sha256(signedBytes(domain, payload));
}
