// The page's validators and derivations against the bridges' own reference tools
// (fixtures/bridge-vectors.json, written by scripts/bridge/make-vectors.mjs).
import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import vectors from './fixtures/bridge-vectors.json';
import { base58Decode, base58Encode, fromHex, p2wpkhKeyHash, segwitV0Encode, sha256Bytes, stellarAddress, toHex, tronAddress20, tronAddressText, utf8 } from '../bridge/codec';
import { decodePoint, onCurve, routerKeyPoint, runtimeOnCurve, smallOrder, verify } from '../bridge/ed25519';
import { depositScript } from '../bridge/bitcoin';
import { associatedTokenAddress, exitProofMessage, findProgramAddress, parseSignature, proofEnvelopes, pubkey, solanaCommitment, solanaWallet, verifyExitProof } from '../bridge/solana';
import { stellarCommitment } from '../bridge/stellar';

beforeAll(() => {
  // jsdom exposes no SubtleCrypto; browsers and Node do.
  if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
});

const FORMAT = {
  template: 'Bloch bridge exit: pay bUSDC.sol exits to my Solana wallet {wallet}. L2 account {l2Account}. Router {router}. Chain {chainId}. Issued {issued}.',
  carriedBy: 'page' as const,
  routerFunction: null,
};
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('Bitcoin addresses (btc_core.py)', () => {
  const b = vectors.bitcoin;
  it('decodes every P2WPKH address to the reference key hash and encodes it back', () => {
    for (const v of b.p2wpkh) {
      const got = p2wpkhKeyHash('bc', v.address);
      expect(got.ok && toHex(got.keyHash)).toBe(`0x${v.keyHash}`);
      expect(segwitV0Encode('bc', fromHex(v.keyHash))).toBe(v.address);
    }
  });
  it('refuses everything the reference refuses, and upper case as the router does', () => {
    for (const v of b.refused) {
      const got = p2wpkhKeyHash('bc', v.address);
      expect(got.ok, v.address).toBe(false);
      if (!got.ok) expect(got.reason.length).toBeGreaterThan(10);
    }
    // The Python reference accepts an all-upper-case address; BitcoinBurnRouter.keyHashOf does not.
    expect(b.refused[0].refused).toBe(false);
  });
  it('says what is wrong in words a person can act on', () => {
    const reason = (a: string) => {
      const r = p2wpkhKeyHash('bc', a);
      return r.ok ? '' : r.reason;
    };
    expect(reason('0x' + 'ab'.repeat(20))).toMatch(/Ethereum-style/);
    expect(reason('bc1p' + 'q'.repeat(58))).toMatch(/Taproot/);
    expect(reason('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toMatch(/Legacy/);
    expect(reason(b.p2wpkh[0].address.slice(0, -1) + (b.p2wpkh[0].address.endsWith('q') ? 'p' : 'q'))).toMatch(/checksum/);
  });
  it('derives the reference deposit script and address for each L2 recipient', () => {
    const script = { threshold: b.threshold, publicKeys: b.publicKeys.map((k) => `0x${k}` as const), vaultId: `0x${b.vaultId}` as const, hrp: 'bc' };
    for (const d of b.deposits) {
      const witness = depositScript(script, d.recipient as `0x${string}`);
      expect(toHex(witness)).toBe(`0x${d.script}`);
      expect(segwitV0Encode('bc', sha256Bytes(witness))).toBe(d.address);
    }
    expect(() => depositScript(script, `0x${'00'.repeat(20)}`)).toThrow();
  });
});

describe('TRON addresses (tronlib.py)', () => {
  it('converts every accepted address to the reference 20 bytes and back', () => {
    for (const v of vectors.tron.accepted) {
      const got = tronAddress20(v.address);
      expect(got.ok && got.address20).toBe(v.address20);
      expect(tronAddressText(v.address20)).toBe(v.address);
    }
  });
  it('refuses what the reference refuses', () => {
    for (const v of vectors.tron.refused) {
      expect(v.refused).toBe(true);
      expect(tronAddress20(v.address).ok, v.address).toBe(false);
    }
    expect(tronAddress20('41' + 'ab'.repeat(20)).ok).toBe(false);
  });
});

describe('Stellar addresses (stellar_net.py, StellarBurnRouter)', () => {
  it('decodes accepted addresses and computes the reference commitment', () => {
    for (const v of vectors.stellar.accepted) {
      const got = stellarAddress(v.address);
      expect(got.ok && got.kind).toBe(v.kind);
      expect(got.ok && toHex(got.key)).toBe(`0x${v.key}`);
      expect(stellarCommitment(v.address).toLowerCase()).toBe(v.commitment);
    }
  });
  it('refuses what the reference refuses, a muxed address and a secret key', () => {
    for (const v of vectors.stellar.refused) {
      expect(v.refused).toBe(true);
      expect(stellarAddress(v.address).ok, v.address).toBe(false);
    }
    const muxed = stellarAddress('M' + vectors.stellar.accepted[0].address.slice(1));
    expect(!muxed.ok && muxed.reason).toMatch(/Muxed/);
    const secret = stellarAddress('S' + 'A'.repeat(55));
    expect(!secret.ok && secret.reason).toMatch(/SECRET/);
  });
});

describe('Ed25519 (RFC 8032 and solana_lib.py)', () => {
  it('verifies the RFC 8032 test vectors 1 to 3 and refuses a changed message', async () => {
    const cases = [
      ['d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', '', 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'],
      ['3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c', '72', '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00'],
      ['fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025', 'af82', '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a'],
    ];
    for (const [key, message, signature] of cases) {
      expect(await verify(fromHex(key), fromHex(message), fromHex(signature))).toBe(true);
      expect(await verify(fromHex(key), fromHex(message + '00'), fromHex(signature))).toBe(false);
    }
  });
  it('refuses a non-canonical S, a small-order key and wrong lengths', async () => {
    const key = fromHex('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
    const sig = fromHex('e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b');
    const L = 2n ** 252n + 27742317777372353535851937790883648493n;
    let s = sig.slice(32).reduceRight((a, b) => (a << 8n) | BigInt(b), 0n) + L;
    const high = sig.slice();
    for (let i = 32; i < 64; i++, s >>= 8n) high[i] = Number(s & 0xffn);
    expect(await verify(key, new Uint8Array(), high)).toBe(false);
    expect(await verify(new Uint8Array(32), new Uint8Array(), sig)).toBe(false);
    expect(await verify(key, new Uint8Array(), sig.slice(1))).toBe(false);
  });
  it('agrees with the reference on which keys are on the curve and of small order', () => {
    for (const k of vectors.solana.keys) {
      const bytes = fromHex(k.key);
      expect(runtimeOnCurve(bytes), k.text).toBe(k.onCurve);
      // The canonical decoding is never looser than the runtime's rule.
      if (onCurve(bytes)) expect(k.onCurve).toBe(true);
      if (k.onCurve && decodePoint(bytes)) expect(smallOrder(bytes), k.text).toBe(k.smallOrder);
      if (routerKeyPoint(bytes)) expect(k.onCurve && !k.smallOrder, k.text).toBe(true);
    }
  });
});

describe('Solana wallet, commitment and derived addresses (solana_lib.py, SolanaBurnRouter)', () => {
  const s = vectors.solana;
  it('accepts a key wallet and computes the reference commitment', () => {
    const wallet = solanaWallet(s.wallet, MINT);
    expect(wallet.ok).toBe(true);
    for (const k of s.keys) expect(solanaCommitment(fromHex(k.key)).toLowerCase()).toBe(k.commitment);
  });
  it('refuses the mint, program ids, derived addresses, small-order points and other text', () => {
    for (const k of s.keys.slice(1)) {
      const got = solanaWallet(k.text, MINT);
      const isPlainKey = k.onCurve && !k.smallOrder && ![MINT, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'].includes(k.text);
      expect(got.ok, k.text).toBe(isPlainKey);
    }
    for (const text of ['', '0x' + 'ab'.repeat(20), s.wallet + ' ', s.wallet.slice(0, 20), 'O0Il' + s.wallet.slice(4)])
      expect(solanaWallet(text, MINT).ok, text).toBe(false);
    expect(base58Encode(base58Decode(s.wallet)!)).toBe(s.wallet);
  });
  it('derives the reference program addresses and the associated token account', () => {
    const program = pubkey(s.program);
    const vault = findProgramAddress(s.vault.seeds.map(fromHex), program);
    expect(base58Encode(vault.address)).toBe(s.vault.address);
    expect(vault.bump).toBe(s.vault.bump);
    for (const p of s.pdas) {
      const got = findProgramAddress(p.seeds.map(fromHex), program);
      expect(base58Encode(got.address)).toBe(p.address);
      expect(got.bump).toBe(p.bump);
    }
    expect(base58Encode(associatedTokenAddress(pubkey(s.ata.owner), pubkey(s.ata.mint)))).toBe(s.ata.address);
  });
});

describe('Solana destination proof (sol_proof.py, docs/SOLANA-VAULT.md 11.3)', () => {
  const s = vectors.solana;
  const base = { format: FORMAT, mint: MINT, wallet: s.wallet, l2Account: s.l2Account as `0x${string}`, router: s.router as `0x${string}`, issued: s.issued, maxAgeSeconds: 600 };
  it('writes the reference message and envelopes byte for byte', () => {
    expect(exitProofMessage(FORMAT, s.wallet, s.l2Account as `0x${string}`, s.router as `0x${string}`, s.issued)).toBe(s.message);
    // Upper-case input still gives the lower-case line.
    expect(exitProofMessage(FORMAT, s.wallet, s.l2Account.toUpperCase().replace('0X', '0x') as `0x${string}`, s.router as `0x${string}`, s.issued)).toBe(s.message);
    const envelopes = proofEnvelopes(s.message, pubkey(s.wallet));
    expect(envelopes.map((e) => [e.name, toHex(e.bytes).slice(2)])).toEqual(s.envelopes.map((e) => [e.name, e.bytes]));
  });
  it('accepts a signature under each envelope the reference accepts', async () => {
    for (const sig of s.signatures) {
      const verdict = await verifyExitProof({ ...base, signature: fromHex(sig.signature), now: s.issued + 30 });
      expect(verdict.ok && verdict.proof.envelope, sig.name).toBe(sig.name);
    }
  });
  it('refuses an old proof, a future one, another L2 account, another router, another wallet and a changed signature', async () => {
    const signature = fromHex(s.signatures[0].signature);
    const refused = async (change: Partial<typeof base> & { now?: number; signature?: Uint8Array }) => {
      const verdict = await verifyExitProof({ ...base, signature, now: s.issued + 30, ...change });
      return verdict.ok ? '' : verdict.reason;
    };
    expect(await refused({ now: s.issued + 601 })).toMatch(/older than 10 minutes/);
    expect(await refused({ now: s.issued - 120 })).toMatch(/future/);
    expect(await refused({ l2Account: `0x${'11'.repeat(20)}` })).toMatch(/not by this wallet/);
    expect(await refused({ router: `0x${'22'.repeat(20)}` })).toMatch(/not by this wallet/);
    expect(await refused({ issued: s.issued + 1 })).toMatch(/not by this wallet/);
    expect(await refused({ wallet: vectors.solana.keys[7].text })).toMatch(/not by this wallet/);
    const flipped = signature.slice();
    flipped[5] ^= 1;
    expect(await refused({ signature: flipped })).toMatch(/not by this wallet/);
    expect(await refused({ wallet: MINT })).toMatch(/token itself/);
    expect(await refused({ signature: signature.slice(1) })).toMatch(/64 bytes/);
  });
  it('reads a signature from hex, base58 and base64 and nothing else', () => {
    const hex = s.signatures[0].signature;
    const raw = fromHex(hex);
    expect(toHex(parseSignature(hex)!)).toBe(`0x${hex}`);
    expect(toHex(parseSignature(`0x${hex}`)!)).toBe(`0x${hex}`);
    expect(toHex(parseSignature(base58Encode(raw))!)).toBe(`0x${hex}`);
    expect(toHex(parseSignature(btoa(String.fromCharCode(...raw)))!)).toBe(`0x${hex}`);
    expect(parseSignature(hex.slice(2))).toBeNull();
    expect(parseSignature('signature')).toBeNull();
    expect(utf8('a').length).toBe(1);
  });
});
