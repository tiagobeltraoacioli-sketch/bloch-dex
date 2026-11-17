// Address codecs of the source networks, written out here so the page adds no dependency:
// bech32 (BIP173, segwit version 0), base58 and Base58Check, Stellar strkey (base32 + CRC16-XMODEM).
// Each decoder mirrors the check the bridge's own router or tool makes; the vectors in
// src/test/fixtures/bridge-vectors.json come from those tools (scripts/bridge/make-vectors.py).
import { sha256 } from 'viem';

export type Bytes = Uint8Array;
export const toHex = (bytes: Bytes): `0x${string}` =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
export function fromHex(hex: string): Bytes {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(body)) throw new Error('not hex');
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(body.slice(2 * i, 2 * i + 2), 16);
  return out;
}
export function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
export const sha256Bytes = (bytes: Bytes): Bytes => fromHex(sha256(bytes));
export const utf8 = (text: string): Bytes => new TextEncoder().encode(text);
export const equalBytes = (a: Bytes, b: Bytes) => a.length === b.length && a.every((v, i) => v === b[i]);

// ── bech32 ───────────────────────────────────────────────────────────────────
const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATOR[i];
  }
  return chk >>> 0;
}
const hrpExpand = (hrp: string) => [
  ...Array.from(hrp, (c) => c.charCodeAt(0) >> 5),
  0,
  ...Array.from(hrp, (c) => c.charCodeAt(0) & 31),
];
function convertBits(data: number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const max = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & max);
    }
  }
  if (pad) {
    if (bits) out.push((acc << (to - bits)) & max);
  } else if (bits >= from || (acc << (to - bits)) & max) return null;
  return out;
}

/** A segwit version-0 address (bech32, never bech32m) of `program` (20 or 32 bytes). */
export function segwitV0Encode(hrp: string, program: Bytes): string {
  if (program.length !== 20 && program.length !== 32) throw new Error('a version 0 program is 20 or 32 bytes');
  const data = [0, ...convertBits(Array.from(program), 8, 5, true)!];
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((v) => BECH32[v]).join('')}`;
}

export type P2wpkh = { ok: true; keyHash: Bytes } | { ok: false; reason: string };
/**
 * The 20-byte key hash of a LOWERCASE P2WPKH address of the network with prefix `hrp`: exactly what
 * BitcoinBurnRouter.keyHashOf accepts. Everything else is refused with the reason a person can act on.
 */
export function p2wpkhKeyHash(hrp: string, address: string): P2wpkh {
  const no = (reason: string): P2wpkh => ({ ok: false, reason });
  if (typeof address !== 'string' || address.length === 0) return no('Enter a Bitcoin address.');
  if (address !== address.trim()) return no('Remove the spaces around the address.');
  if (/^0x/i.test(address)) return no('This is an Ethereum-style address, not a Bitcoin address.');
  if (/^[13]/.test(address) && !address.startsWith(`${hrp}1`))
    return no(`Legacy and script addresses (starting with 1 or 3) cannot be paid. Use a native segwit address that starts with ${hrp}1q.`);
  if (address !== address.toLowerCase())
    return no('Write the address in lower case, as your wallet shows it.');
  if (!address.startsWith(`${hrp}1`)) return no(`The address must start with ${hrp}1q (Bitcoin mainnet, native segwit).`);
  if (address.startsWith(`${hrp}1p`))
    return no(`Taproot addresses (${hrp}1p…) cannot be paid. Use a native segwit address that starts with ${hrp}1q.`);
  if (address.length !== hrp.length + 40)
    return no(
      address.length === hrp.length + 60
        ? `This is a script address (${hrp.length + 60} characters). Only key addresses of ${hrp.length + 40} characters can be paid.`
        : `A payable address has ${hrp.length + 40} characters; this one has ${address.length}.`,
    );
  const values = Array.from(address.slice(hrp.length + 1), (c) => BECH32.indexOf(c));
  if (values.some((v) => v < 0)) return no('The address contains a character that no Bitcoin address has.');
  if (polymod([...hrpExpand(hrp), ...values]) !== 1)
    return no('The checksum does not match: the address was mistyped or cut.');
  if (values[0] !== 0) return no('Only witness version 0 addresses can be paid.');
  const program = convertBits(values.slice(1, -6), 5, 8, false);
  if (!program || program.length !== 20) return no('The address does not hold a 20-byte key hash.');
  if (program.every((b) => b === 0)) return no('The all-zero key hash cannot be paid.');
  return { ok: true, keyHash: Uint8Array.from(program) };
}

// ── base58 ───────────────────────────────────────────────────────────────────
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58Decode(text: string): Bytes | null {
  if (!text || text.length > 128) return null;
  let value = 0n;
  for (const c of text) {
    const digit = BASE58.indexOf(c);
    if (digit < 0) return null;
    value = value * 58n + BigInt(digit);
  }
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  const body: number[] = [];
  for (; value > 0n; value >>= 8n) body.unshift(Number(value & 0xffn));
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...body]);
}
export function base58Encode(bytes: Bytes): string {
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  let out = '';
  for (; value > 0n; value /= 58n) out = BASE58[Number(value % 58n)] + out;
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  return '1'.repeat(zeros) + out;
}

export type TronAddress = { ok: true; address20: `0x${string}` } | { ok: false; reason: string };
/** The 20-byte form of a TRON `T…` address: Base58Check-decode, verify the checksum, drop the leading 0x41. */
export function tronAddress20(address: string): TronAddress {
  const no = (reason: string): TronAddress => ({ ok: false, reason });
  if (typeof address !== 'string' || address.length === 0) return no('Enter a TRON address.');
  if (address !== address.trim()) return no('Remove the spaces around the address.');
  if (/^0x/i.test(address)) return no('This is an Ethereum-style address. Enter the TRON address that starts with T.');
  if (/^41[0-9a-fA-F]{40}$/.test(address)) return no('This is the hex form. Enter the address as your wallet shows it, starting with T.');
  if (!address.startsWith('T') || address.length !== 34) return no('A TRON address starts with T and has 34 characters.');
  const raw = base58Decode(address);
  if (!raw || raw.length !== 25) return no('This is not a TRON address.');
  const body = raw.slice(0, 21);
  const check = sha256Bytes(sha256Bytes(body)).slice(0, 4);
  if (!equalBytes(check, raw.slice(21))) return no('The checksum does not match: the address was mistyped or cut.');
  if (body[0] !== 0x41) return no('This address is not of the TRON main network.');
  if (body.slice(1).every((b) => b === 0)) return no('The all-zero address cannot be paid.');
  return { ok: true, address20: toHex(body.slice(1)) };
}
/** The `T…` form of a 20-byte address (for showing a vault or a recipient back to the user). */
export function tronAddressText(address20: string): string {
  const body = concat(Uint8Array.of(0x41), fromHex(address20));
  return base58Encode(concat(body, sha256Bytes(sha256Bytes(body)).slice(0, 4)));
}

// ── Stellar strkey ───────────────────────────────────────────────────────────
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function crc16(bytes: Bytes): number {
  let crc = 0;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}
export type Strkey =
  | { ok: true; kind: 'account' | 'contract'; key: Bytes }
  | { ok: false; reason: string };
/** A Stellar `G…` account or `C…` contract address, as StellarBurnRouter.commitment accepts it. */
export function stellarAddress(address: string): Strkey {
  const no = (reason: string): Strkey => ({ ok: false, reason });
  if (typeof address !== 'string' || address.length === 0) return no('Enter a Stellar address.');
  if (address !== address.trim()) return no('Remove the spaces around the address.');
  if (address.startsWith('M')) return no('Muxed addresses (M…) are not accepted. Enter the G… account itself; an exchange deposit that needs a memo cannot be paid by this bridge.');
  if (address.startsWith('S')) return no('This is a SECRET key. Never paste it anywhere. Enter the public address that starts with G.');
  if (address.length !== 56) return no(`A Stellar address has 56 characters; this one has ${address.length}.`);
  if (!/^[A-Z2-7]{56}$/.test(address)) return no('A Stellar address uses only capital letters and the digits 2 to 7.');
  const raw = new Uint8Array(35);
  let buffer = 0;
  let bits = 0;
  let n = 0;
  for (const c of address) {
    buffer = ((buffer << 5) | BASE32.indexOf(c)) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      raw[n++] = (buffer >> bits) & 0xff;
    }
  }
  const version = raw[0];
  if (version !== 0x30 && version !== 0x10) return no('Only a G… account or a C… contract address can be paid.');
  const crc = crc16(raw.slice(0, 33));
  if (raw[33] !== (crc & 0xff) || raw[34] !== crc >> 8) return no('The checksum does not match: the address was mistyped or cut.');
  return { ok: true, kind: version === 0x30 ? 'account' : 'contract', key: raw.slice(1, 33) };
}
