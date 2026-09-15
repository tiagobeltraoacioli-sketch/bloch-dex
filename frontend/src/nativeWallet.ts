// Postern's native provider uses request(method, params), not EIP-1193.
// Discovery metadata is a compatibility hint, not an authenticated chain proof.
export type NativeProvider = {
  isBloch: true;
  chain: 'bloch-genesis4';
  signatureSuite: 'ml-dsa-65+falcon-1024';
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
};
declare global {
  interface Window {
    bloch?: NativeProvider;
  }
}
export function nativeProvider(): NativeProvider | null {
  const provider = window.bloch;
  return provider?.isBloch === true &&
    provider.chain === 'bloch-genesis4' &&
    provider.signatureSuite === 'ml-dsa-65+falcon-1024' &&
    typeof provider.request === 'function'
    ? provider
    : null;
}
// Presentation only: this is not checksum validation or permission to deposit.
export function reportedNativeAccount(value: unknown): string {
  const address = value && typeof value === 'object' && 'address' in value ? value.address : null;
  if (typeof address !== 'string' || !/^bloch1[qt][0-9a-f]{48}$/.test(address)) {
    throw new Error('Native account unavailable');
  }
  return address;
}
