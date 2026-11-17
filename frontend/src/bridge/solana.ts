// Solana route (bUSDC.sol): what counts as a wallet, the 20-byte commitment an exit names, the destination proof,
// program-derived addresses, the deposit instruction and the release record. Mirrors contracts/solana/
// SolanaBurnRouter.sol, tools/signatario-solana/solana_lib.py and sol_proof.py, and docs/SOLANA-VAULT.md.
import { keccak256, type Address, type Hex } from 'viem';
import type { LiveRoute, SolanaProofFormat } from './config';
import { base58Decode, base58Encode, concat, equalBytes, fromHex, sha256Bytes, toHex, utf8, type Bytes } from './codec';
import { onCurve, routerKeyPoint, runtimeOnCurve, smallOrder, verify } from './ed25519';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const ACCOUNT_ID_DOMAIN = 'BLOCH-SVM-ACCOUNT-ID-v1';

export const pubkey = (text: string): Bytes => {
  const key = base58Decode(text);
  if (!key || key.length !== 32 || base58Encode(key) !== text) throw new Error(`not a Solana address: ${text.slice(0, 50)}`);
  return key;
};

export type SolanaWallet = { ok: true; key: Bytes; text: string } | { ok: false; reason: string };
/**
 * A Solana WALLET address: 32 bytes in canonical base58 that are a real Ed25519 key. Refuses everything the router
 * refuses (derived addresses, the small-order points, the asset's mint, the token programs) and, more strictly,
 * a non-canonical point encoding. A key address that passes may still be something nobody holds a key for: only the
 * signed proof shows that (see `verifyExitProof`).
 */
export function solanaWallet(text: string, mint: string): SolanaWallet {
  const no = (reason: string): SolanaWallet => ({ ok: false, reason });
  if (typeof text !== 'string' || text.length === 0) return no('Connect or enter a Solana wallet address.');
  if (text !== text.trim()) return no('Remove the spaces around the address.');
  if (/^0x/i.test(text)) return no('This is an Ethereum-style address, not a Solana wallet.');
  if (text.length < 32 || text.length > 44) return no('A Solana address has 32 to 44 characters.');
  const key = base58Decode(text);
  if (!key || key.length !== 32 || base58Encode(key) !== text) return no('This is not a Solana address.');
  if (text === mint) return no('This is the address of the USDC token itself, not a wallet.');
  if ([TOKEN_PROGRAM, TOKEN_2022_PROGRAM, ATA_PROGRAM, SYSTEM_PROGRAM].includes(text)) return no('This is the address of a Solana program, not a wallet.');
  if (!routerKeyPoint(key) || !onCurve(key) || smallOrder(key))
    return no('This address is not a wallet key. A token account, a multisig vault or another program-derived address cannot be paid: enter the wallet that owns it.');
  return { ok: true, key, text };
}

/** The 20 bytes the L2 burn names for a wallet: last 20 bytes of keccak256(domain || wallet). */
export function solanaCommitment(key: Bytes): Address {
  return `0x${keccak256(concat(utf8(ACCOUNT_ID_DOMAIN), key)).slice(-40)}` as Address;
}

/** What the template of a proof may name. `amount`, `nonce`, `route` and `issued` are needed only if it names them. */
export type ProofFields = { wallet: string; burner: Address; router: Address; amount?: bigint; nonce?: bigint; route?: Hex; issued?: number };

/** The one line the destination wallet signs, from the format the route carries. */
export function exitProofMessage(format: SolanaProofFormat, fields: ProofFields): string {
  const values: Record<string, string | undefined> = {
    wallet: fields.wallet,
    burner: fields.burner.toLowerCase(),
    router: fields.router.toLowerCase(),
    chainId: '700770',
    amount: fields.amount?.toString(),
    nonce: fields.nonce?.toString(),
    route: fields.route?.toLowerCase(),
    issued: fields.issued === undefined ? undefined : String(fields.issued),
  };
  const line = format.template.replace(/\{([A-Za-z0-9]+)\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined || value === '') throw new Error(`the proof message needs {${name}}`);
    return value;
  });
  if (!/^[\x20-\x7e]{1,1000}$/.test(line)) throw new Error('the proof message is not one line of printable ASCII');
  return line;
}

const OFFCHAIN_DOMAIN = concat(Uint8Array.of(0xff), utf8('solana offchain'));
/**
 * The byte strings a signature of `message` may cover (sol_proof.envelopes), with the tag the router's proof gives
 * each: 0 the text (a wallet's signMessage), 1 the off-chain message envelope (solana sign-offchain-message),
 * 2 the envelope with an application domain (all zero here) and the signer.
 */
export function proofEnvelopes(message: string, publicKey: Bytes): { name: string; tag: number; bytes: Bytes }[] {
  const body = utf8(message);
  const length = Uint8Array.of(body.length & 0xff, body.length >> 8);
  return [
    { name: 'text', tag: 0, bytes: body },
    { name: 'offchain-v0', tag: 1, bytes: concat(OFFCHAIN_DOMAIN, Uint8Array.of(0, 0), length, body) },
    { name: 'offchain-v0-with-signers', tag: 2, bytes: concat(OFFCHAIN_DOMAIN, Uint8Array.of(0), new Uint8Array(32), Uint8Array.of(0, 1), publicKey, length, body) },
  ];
}

/** Exactly 64 bytes from base58, hex or base64 text (as wallets and the Solana CLI print a signature). */
export function parseSignature(text: string): Bytes | null {
  const t = text.trim();
  if (/^(0x)?[0-9a-fA-F]{128}$/.test(t)) return fromHex(t.replace(/^0x/, ''));
  if (/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(t)) {
    const raw = base58Decode(t);
    if (raw?.length === 64 && base58Encode(raw) === t) return raw;
  }
  if (/^[A-Za-z0-9+/]{86}==$/.test(t)) {
    try {
      const raw = Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
      if (raw.length === 64) return raw;
    } catch {
      return null;
    }
  }
  return null;
}

export type ExitProof = {
  wallet: string;
  burner: Address;
  router: Address;
  message: string;
  signature: Hex;
  envelope: string;
  /** What the router call carries: tag | signature [| 32-byte domain]. */
  proofBytes: Hex;
  /** The values the message is bound to, when the format names them. */
  amount?: bigint;
  nonce?: bigint;
  issued?: number;
};
export type ProofVerdict = { ok: true; proof: ExitProof } | { ok: false; reason: string };

/**
 * Check a destination proof completely: the wallet is a wallet, the message is the page's own line for these
 * values, the signature is by the wallet's key over that line (or its off-chain envelope), and, for a format with
 * a time, it is not older than allowed. Nothing is sent to the router before this passes.
 */
export async function verifyExitProof(input: {
  format: SolanaProofFormat;
  mint: string;
  fields: ProofFields;
  signature: Bytes;
  now: number;
  maxAgeSeconds: number;
}): Promise<ProofVerdict> {
  const no = (reason: string): ProofVerdict => ({ ok: false, reason });
  const { fields } = input;
  const wallet = solanaWallet(fields.wallet, input.mint);
  if (!wallet.ok) return no(wallet.reason);
  if (input.signature.length !== 64) return no('A signature is 64 bytes.');
  if (fields.issued !== undefined) {
    if (fields.issued > input.now + 60) return no("The proof is dated in the future. Check this device's clock and sign again.");
    if (input.now - fields.issued > input.maxAgeSeconds) return no(`The proof is older than ${Math.round(input.maxAgeSeconds / 60)} minutes. Sign a new one.`);
  }
  const message = exitProofMessage(input.format, fields);
  for (const envelope of proofEnvelopes(message, wallet.key)) {
    if (await verify(wallet.key, envelope.bytes, input.signature))
      return {
        ok: true,
        proof: {
          wallet: wallet.text,
          burner: fields.burner,
          router: fields.router,
          message,
          signature: toHex(input.signature),
          envelope: envelope.name,
          proofBytes: toHex(concat(Uint8Array.of(envelope.tag), input.signature, envelope.tag === 2 ? new Uint8Array(32) : new Uint8Array(0))),
          amount: fields.amount,
          nonce: fields.nonce,
          issued: fields.issued,
        },
      };
  }
  return no('The signature is not by this wallet over this exact message. The wallet that signs must be the destination wallet itself; an exchange deposit address cannot sign and must not be used.');
}

// ── program-derived addresses ────────────────────────────────────────────────
export function findProgramAddress(seeds: Bytes[], programId: Bytes): { address: Bytes; bump: number } {
  for (let bump = 255; bump >= 0; bump--) {
    const hash = sha256Bytes(concat(...seeds, Uint8Array.of(bump), programId, utf8('ProgramDerivedAddress')));
    if (!runtimeOnCurve(hash)) return { address: hash, bump };
  }
  throw new Error('no program-derived address for these seeds');
}
export const u64le = (value: bigint): Bytes => {
  if (value < 0n || value >= 1n << 64n) throw new Error('value out of uint64 range');
  const out = new Uint8Array(8);
  for (let i = 0, v = value; i < 8; i++, v >>= 8n) out[i] = Number(v & 0xffn);
  return out;
};
const readU64 = (data: Bytes, at: number): bigint => data.slice(at, at + 8).reduceRight((acc, b) => (acc << 8n) | BigInt(b), 0n);

export const associatedTokenAddress = (owner: Bytes, mint: Bytes): Bytes =>
  findProgramAddress([owner, pubkey(TOKEN_PROGRAM), mint], pubkey(ATA_PROGRAM)).address;

export const PAGE_NONCES = 8192n;
export function vaultAddresses(route: LiveRoute) {
  const program = pubkey(route.solana!.programId!);
  const vault = pubkey(route.solana!.vault!);
  const derive = (tag: string, n?: bigint) =>
    findProgramAddress([utf8(tag), vault, ...(n === undefined ? [] : [u64le(n)])], program).address;
  return {
    program,
    vault,
    tokenAccount: derive('tokens'),
    depositRecord: (count: bigint) => derive('deposit', count),
    releaseRecord: (burnNonce: bigint) => derive('release', burnNonce),
    paidPage: (burnNonce: bigint) => derive('paid', burnNonce / PAGE_NONCES),
  };
}

/** The fields of the vault state the page reads (docs/SOLANA-VAULT.md 4.2). */
export function parseVaultState(data: Bytes) {
  if (data.length !== 1146 || data[0] !== 1) throw new Error('not a vault state account');
  return {
    depositCount: readU64(data, 984),
    totalLocked: readU64(data, 992),
    depositsEnabled: data[1016] === 1,
    releasesEnabled: data[1017] === 1,
    releaseBucket: readU64(data, 1018),
    bucketUpdatedAt: readU64(data, 1026),
    pausedUntil: readU64(data, 1034),
    pauseCount: readU64(data, 1042),
    approvalSeq: readU64(data, 1122),
    voidThroughSeq: readU64(data, 1130),
  };
}

export type ReleaseRecord = {
  state: 'approved' | 'paid';
  burnNonce: bigint;
  commitment: Hex;
  amount: bigint;
  nativeBurnId: Hex;
  readyAt: bigint;
  seq: bigint;
  paidAt: bigint;
  paidAmount: bigint;
};
/** A release record (4.4); null when the account is absent or its first two bytes are zero (closed). */
export function parseReleaseRecord(data: Bytes | null, vault: Bytes): ReleaseRecord | null {
  if (!data || data.length < 2 || (data[0] === 0 && data[1] === 0)) return null;
  if (data.length !== 208 || data[0] !== 3 || !equalBytes(data.slice(4, 36), vault) || (data[3] !== 1 && data[3] !== 2))
    throw new Error('not a release record of this vault');
  return {
    state: data[3] === 2 ? 'paid' : 'approved',
    burnNonce: readU64(data, 36),
    commitment: toHex(data.slice(76, 96)),
    amount: readU64(data, 96),
    nativeBurnId: toHex(data.slice(104, 136)),
    readyAt: readU64(data, 136),
    seq: readU64(data, 144),
    paidAt: readU64(data, 160),
    paidAmount: readU64(data, 168),
  };
}
/** The nonce's bit in its paid page (4.5): set = paid and the record was closed. */
export function paidBit(page: Bytes | null, vault: Bytes, burnNonce: bigint): boolean {
  if (!page) return false;
  if (page.length !== 1067 || page[0] !== 4 || !equalBytes(page.slice(3, 35), vault) || readU64(page, 35) !== burnNonce / PAGE_NONCES)
    throw new Error('not the paid page of this vault and nonce');
  const index = Number(burnNonce % PAGE_NONCES);
  return ((page[43 + (index >> 3)] >> (index & 7)) & 1) === 1;
}

export type SolanaInstruction = {
  programId: string;
  /** hex of the instruction data */
  data: Hex;
  accounts: { address: string; role: string; signer: boolean; writable: boolean }[];
};
/**
 * The deposit instruction (instruction 1), unsigned, for the user's own wallet or CLI: data = 0x01 | amount u64 LE |
 * 20-byte L2 address; the record addresses of the next four deposit counts are named so that deposits sent at the
 * same time do not fail each other. `depositCount` is the vault's count as read at `finalized`.
 */
export function depositInstruction(route: LiveRoute, depositor: string, amount: bigint, l2Recipient: Address, depositCount: bigint): SolanaInstruction {
  const recipient = fromHex(l2Recipient);
  if (recipient.length !== 20 || recipient.every((b) => b === 0)) throw new Error('The L2 recipient must be a non-zero 20-byte address.');
  if (amount < route.limits.minDeposit || amount > route.limits.maxDeposit) throw new Error('The amount is outside the deposit limits.');
  const a = vaultAddresses(route);
  const owner = pubkey(depositor);
  const mint = pubkey(route.asset.id);
  const text = base58Encode;
  const records = [0n, 1n, 2n, 3n].map((i) => text(a.depositRecord(depositCount + i)));
  return {
    programId: text(a.program),
    data: toHex(concat(Uint8Array.of(1), u64le(amount), recipient)),
    accounts: [
      { address: depositor, role: 'depositor', signer: true, writable: true },
      { address: text(associatedTokenAddress(owner, mint)), role: 'depositor USDC token account', signer: false, writable: true },
      { address: text(a.vault), role: 'vault', signer: false, writable: true },
      { address: text(a.tokenAccount), role: 'vault token account', signer: false, writable: true },
      { address: route.asset.id, role: 'USDC mint', signer: false, writable: false },
      { address: records[0], role: `deposit record of count ${depositCount}`, signer: false, writable: true },
      { address: TOKEN_PROGRAM, role: 'token program', signer: false, writable: false },
      { address: SYSTEM_PROGRAM, role: 'system program', signer: false, writable: false },
      ...records.slice(1).map((address, i) => ({ address, role: `deposit record of count ${depositCount + BigInt(i) + 1n}`, signer: false, writable: true })),
    ],
  };
}
