import {
  canonicalLiveReadPayload,
  importLiveReadTrustAnchor,
  type LiveReadTrustAnchor,
} from '../live-auth';

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export type SigningFixture = {
  encodedPublicKey: string;
  keyGeneration: number;
  trustAnchor: LiveReadTrustAnchor;
  sign(payload: unknown, domain: string): Promise<unknown>;
};

export async function createSigningFixture(): Promise<SigningFixture> {
  const keyGeneration = 7;
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const encodedPublicKey = base64Url(raw);
  const trustAnchor = await importLiveReadTrustAnchor(encodedPublicKey, String(keyGeneration));
  return {
    encodedPublicKey,
    keyGeneration,
    trustAnchor,
    async sign(payload, domain) {
      const signature = new Uint8Array(
        await crypto.subtle.sign(
          { name: 'Ed25519' },
          pair.privateKey,
          canonicalLiveReadPayload(domain, keyGeneration, payload),
        ),
      );
      return {
        schemaVersion: 2,
        payload,
        signature: {
          algorithm: 'Ed25519',
          keyId: trustAnchor.keyId,
          keyGeneration,
          value: base64Url(signature),
        },
      };
    },
  };
}
