// What the two WalletConnect (Reown) session modules share: the account-only session of the Bloch L2 preview
// (qr-wallet.ts) and the transaction session of the multichain site (multichain/walletconnect.ts). Only pieces
// whose behaviour is the same in both live here; each module keeps its own namespace rules.

/** The Reown project of this site. The domains it accepts are set in the Reown dashboard, not here. */
export const REOWN_PROJECT_ID = 'e263eead656b6d61ecdee75a71e100bb';

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** A WalletConnect session topic: 32 bytes in hex. */
export const isSessionTopic = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);

/** The list holds exactly the required items: none missing, none added, none repeated. */
export function exactPermissionList(value: unknown, required: readonly string[]) {
  return (
    Array.isArray(value) &&
    value.length === required.length &&
    new Set(value).size === value.length &&
    required.every((item) => value.includes(item))
  );
}
