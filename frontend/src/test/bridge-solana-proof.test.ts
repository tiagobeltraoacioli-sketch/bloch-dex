// The Solana destination-key proof (exit and redirect) against the bridge's own published vectors
// (deployments/solana/exit-proof-vectors.json of bloch-l2-bridge, imported byte for byte by
// scripts/bridge/import-interfaces.mjs). The page builds the line from the format in page.json, never from a constant,
// and checks a proof the way the signers do: router shape, then the signature over the byte string of its own tag.
import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import vectors from '../../../deployments/bridges/solana/exit-proof-vectors.json';
import sources from '../../../deployments/bridges/sources.json';
import { parseBridgeBundle } from '../bridge/config';
import { exitProofMessage, verifyCarriedProof, verifyExitProof } from '../bridge/solana';
import { fromHex } from '../bridge/codec';
import bundle from '@postern/bridge-bundle';
import type { Address, Hex } from 'viem';

beforeAll(() => {
  if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
});

const config = parseBridgeBundle(bundle, false);
const solana = config.entries.find((e) => e.id === 'solana')!.route!.solana!;
const format = solana.proof;
const fields = { burner: vectors.burner as Address, router: vectors.router as Address, route: vectors.route as Hex };

describe('Solana destination proof: the format is data and matches the router of the imported commit', () => {
  it('the vectors come from the same bridge commit as the Solana interface file', () => {
    const net = sources.sources.find((s) => s.file === 'solana/bridge.network.json')!;
    const vec = sources.sources.find((s) => s.file === 'solana/exit-proof-vectors.json')!;
    expect(vec.commit).toBe(net.commit);
    expect(vectors.chainId).toBe(700770);
  });
  it('builds, byte for byte, the exit line and the redirect line of every valid vector', () => {
    expect(format.carriedBy).toBe('router');
    expect(format.redirectTemplate).not.toBeNull();
    for (const v of vectors.valid) {
      const line =
        v.kind === 'exit'
          ? exitProofMessage(format, { ...fields, wallet: v.wallet, amount: BigInt(v.amount!), nonce: BigInt(v.nonce) })
          : exitProofMessage({ ...format, template: format.redirectTemplate! }, { ...fields, wallet: v.wallet, burnId: v.burnId as Hex, nonce: BigInt(v.nonce) });
      expect(line, v.kind).toBe(v.message);
    }
  });
  it('accepts every valid proof (tags 0, 1, 2) as the router carries it', async () => {
    let n = 0;
    for (const v of vectors.valid)
      for (const p of v.proofs) {
        const verdict = await verifyCarriedProof(v.message, v.wallet, p.proof as Hex);
        expect(verdict.ok, `${v.kind} tag ${p.tag}`).toBe(true);
        n++;
      }
    expect(n).toBe(6);
  });
  it('refuses every invalid vector, each for its stated reason (wrong key, tag, bit, nonce, amount, burner, router, chain, route, shape, all zero, redirect shown for an exit)', async () => {
    expect(vectors.invalid.length).toBe(14);
    for (const v of vectors.invalid) {
      const verdict = await verifyCarriedProof(v.message, v.wallet, v.proof as Hex);
      expect(verdict.ok, v.why).toBe(false);
    }
  });
  it('a signature the wallet made with signMessage is turned into the router proof the vectors give (tag 0)', async () => {
    const v = vectors.valid.find((x) => x.kind === 'exit')!;
    const text = v.proofs.find((p) => p.tag === 0)!;
    const verdict = await verifyExitProof({
      format,
      mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      fields: { ...fields, wallet: v.wallet, amount: BigInt(v.amount!), nonce: BigInt(v.nonce) },
      signature: fromHex(text.signature.slice(2)),
      now: 1_800_000_000,
      maxAgeSeconds: solana.policy.proofMaxAgeSeconds,
    });
    expect(verdict.ok && verdict.proof.proofBytes).toBe(text.proof);
  });
  it('an exit signature never verifies as a redirect, nor a redirect as an exit', async () => {
    const exit = vectors.valid.find((x) => x.kind === 'exit')!;
    const redirect = vectors.valid.find((x) => x.kind === 'redirect')!;
    for (const p of exit.proofs) expect((await verifyCarriedProof(redirect.message, exit.wallet, p.proof as Hex)).ok).toBe(false);
    for (const p of redirect.proofs) expect((await verifyCarriedProof(exit.message, redirect.wallet, p.proof as Hex)).ok).toBe(false);
  });
  it('the page refuses a format whose redirect line could be confused with the exit line, or that misses a binding', () => {
    const state = (edit: (exitProof: Record<string, string>) => void) => {
      const b = JSON.parse(JSON.stringify(bundle)) as Record<string, any>;
      edit(b.page.networks.solana.exitProof);
      return parseBridgeBundle(b, false).entries.find((e) => e.id === 'solana')!.status.state;
    };
    const good = format.redirectTemplate!;
    const fine = state(() => undefined);
    expect(fine).not.toBe('unreadable');
    expect(state((p) => (p.redirectTemplate = good.replace(' Route {route}.', '')))).toBe('unreadable');
    expect(state((p) => (p.redirectTemplate = good.replace('{burnId}', 'X')))).toBe('unreadable');
    expect(state((p) => (p.redirectTemplate = `${good} {amount}`))).toBe('unreadable');
    expect(state((p) => (p.redirectTemplate = `Bloch bridge exit v1: ${good}`))).toBe('unreadable');
    expect(state((p) => (p.template = `${format.template} {burnId}`))).toBe('unreadable');
    expect(state((p) => ((p.carriedBy = 'page'), (p.template = 'pay {wallet} {burner} {router} {chainId} {issued}')))).toBe('unreadable');
    expect(state((p) => delete (p as Record<string, unknown>).redirectTemplate)).toBe(fine);
  });
});
