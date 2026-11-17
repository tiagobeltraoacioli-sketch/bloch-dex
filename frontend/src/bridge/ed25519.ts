// Ed25519 on BigInt: point decoding and signature VERIFICATION only (public data; no secret is ever handled here,
// so constant time is not needed). The page uses it to check that a Solana address is a key (as SolanaBurnRouter
// does on the L2), to derive program addresses, and to verify the destination proof of a Solana exit before any
// transaction is built. SHA-512 comes from the browser (WebCrypto), which is why `verify` is asynchronous.
// Strict in the same way as the bridge's tools/signatario-solana/solana_lib.py: canonical S, canonical encodings,
// small-order keys refused, the cofactorless equation.
import type { Bytes } from './codec';

const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const D = 0x52036cee2b6ffe738cc740797779e89800700a4d4141d8ab75eb4dca135978a3n;
const SQRT_M1 = 0x2b8324804fc1df0b2b4d00993dfbd7a72f431806ad2fe478c4ee1b274a0ea0b0n;
const mod = (a: bigint, m = P) => ((a % m) + m) % m;
function pow(base: bigint, exp: bigint, m = P): bigint {
  let result = 1n;
  let b = mod(base, m);
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
  }
  return result;
}
const inv = (a: bigint) => pow(a, P - 2n);

/** Extended coordinates (X, Y, Z, T). */
type Point = [bigint, bigint, bigint, bigint];
const ZERO: Point = [0n, 1n, 1n, 0n];
const BASE_Y = mod(4n * inv(5n));
function add(a: Point, b: Point): Point {
  const A = mod((a[1] - a[0]) * (b[1] - b[0]));
  const B = mod((a[1] + a[0]) * (b[1] + b[0]));
  const C = mod(2n * a[3] * b[3] * D);
  const Dd = mod(2n * a[2] * b[2]);
  const E = B - A;
  const F = Dd - C;
  const G = Dd + C;
  const H = B + A;
  return [mod(E * F), mod(G * H), mod(F * G), mod(E * H)];
}
function mul(k: bigint, point: Point): Point {
  let result = ZERO;
  let p = point;
  for (let e = k; e > 0n; e >>= 1n) {
    if (e & 1n) result = add(result, p);
    p = add(p, p);
  }
  return result;
}
const same = (a: Point, b: Point) =>
  mod(a[0] * b[2] - b[0] * a[2]) === 0n && mod(a[1] * b[2] - b[1] * a[2]) === 0n;

const le = (bytes: Bytes) => bytes.reduceRight((acc, b) => (acc << 8n) | BigInt(b), 0n);

/** Decode a 32-byte point; null when it is not the canonical encoding of a curve point. */
export function decodePoint(bytes: Bytes): Point | null {
  if (bytes.length !== 32) return null;
  const encoded = le(bytes);
  const sign = encoded >> 255n;
  const y = encoded & ((1n << 255n) - 1n);
  if (y >= P) return null;
  const u = mod(y * y - 1n);
  const v = mod(D * y * y + 1n);
  // x = sqrt(u / v), RFC 8032 section 5.1.3
  let x = mod(u * pow(v, 3n) * pow(mod(u * pow(v, 7n)), (P - 5n) / 8n));
  const check = mod(v * x * x);
  if (check === mod(-u)) x = mod(x * SQRT_M1);
  else if (check !== u) return null;
  if (x === 0n && sign === 1n) return null;
  if ((x & 1n) !== sign) x = P - x;
  return [x, y, 1n, mod(x * y)];
}
const BASE = (() => {
  const bytes = new Uint8Array(32);
  let y = BASE_Y;
  for (let i = 0; i < 32; i++, y >>= 8n) bytes[i] = Number(y & 0xffn);
  return decodePoint(bytes)!;
})();

/** True when the 32 bytes decode to a curve point (what Solana calls "on the curve": a key, not a derived address). */
export const onCurve = (bytes: Bytes): boolean => decodePoint(bytes) !== null;

/** True when the point has order 1, 2, 4 or 8: no key signs for it, and a signature check passes for many messages. */
export function smallOrder(bytes: Bytes): boolean {
  const point = decodePoint(bytes);
  return point === null || same(mul(8n, point), ZERO);
}

/**
 * The rule of SolanaBurnRouter._keyPoint, bit for bit: it reads only the y coordinate (the sign bit is ignored and
 * y is reduced modulo P), refuses the small-order y values and requires x^2 to be a square. A key the router
 * accepts and `onCurve` refuses (a non-canonical encoding) is still refused by the page: see solana.ts.
 */
export function routerKeyPoint(bytes: Bytes): boolean {
  if (bytes.length !== 32) return false;
  const y = mod(le(bytes) & ((1n << 255n) - 1n));
  const ORDER8 = [
    0x05fc536d880238b13933c6d305acdfd5f098eff289f4c345b027b2c28f95e826n,
    0x7a03ac9277fdc74ec6cc392cfa53202a0f67100d760b3cba4fd84d3d706a17c7n,
  ];
  if (y === 0n || ORDER8.includes(y)) return false;
  const yy = mod(y * y);
  const w = mod((yy - 1n) * mod(D * yy + 1n));
  if (w === 0n) return false;
  return pow(w, (P - 1n) / 2n) === 1n;
}

async function sha512(...parts: Bytes[]): Promise<bigint> {
  const total = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    total.set(p, at);
    at += p.length;
  }
  return le(new Uint8Array(await crypto.subtle.digest('SHA-512', total)));
}

/** Verify a 64-byte Ed25519 signature of `message` by the 32-byte `publicKey`. Never throws. */
export async function verify(publicKey: Bytes, message: Bytes, signature: Bytes): Promise<boolean> {
  try {
    if (publicKey.length !== 32 || signature.length !== 64) return false;
    const A = decodePoint(publicKey);
    const R = decodePoint(signature.slice(0, 32));
    const S = le(signature.slice(32));
    if (!A || !R || S >= L || smallOrder(publicKey)) return false;
    const k = mod(await sha512(signature.slice(0, 32), publicKey, message), L);
    return same(mul(S, BASE), add(R, mul(k, A)));
  } catch {
    return false;
  }
}

/**
 * "On the curve" as the Solana runtime decides it for a derived address (the bridge's solana_lib.on_curve): only
 * the y coordinate is read, reduced modulo P, and x^2 must be a square. Used for program-derived addresses, where
 * the page must agree with the runtime; `onCurve` above is the stricter canonical decoding.
 */
export function runtimeOnCurve(bytes: Bytes): boolean {
  if (bytes.length !== 32) return false;
  const y = mod(le(bytes) & ((1n << 255n) - 1n));
  const w = mod((y * y - 1n) * inv(mod(D * y * y + 1n)));
  return w === 0n || pow(w, (P - 1n) / 2n) === 1n;
}
