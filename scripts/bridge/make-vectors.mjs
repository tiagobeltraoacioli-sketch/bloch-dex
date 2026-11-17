#!/usr/bin/env node
// Test vectors for the bridge page's validators and computations, produced by the BRIDGES' OWN reference tools
// (Python, standard library) at the commits recorded in deployments/bridges/sources.json:
//
//   node scripts/bridge/make-vectors.mjs --btc <worktree> --solana <worktree> --stellar <worktree> --tron <worktree>
//
// Writes frontend/src/test/fixtures/bridge-vectors.json. The page's TypeScript is then tested against these
// answers (src/test/bridge-codec.test.ts and others). Keys are throwaway: small integers and fixed seeds.
// Each worktree must be at the commit sources.json names for that network; the script refuses otherwise.
import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const need = (name) => {
  const at = args.indexOf(name);
  if (at < 0) throw new Error(`missing ${name} <worktree>`);
  return args[at + 1];
};
const sources = JSON.parse(readFileSync(join(root, 'deployments/bridges/sources.json'), 'utf8')).sources;
const trees = {};
for (const [flag, network] of [['--btc', 'bitcoin'], ['--solana', 'solana'], ['--stellar', 'stellar'], ['--tron', 'tron']]) {
  const dir = need(flag);
  const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD']).toString().trim();
  const want = sources.find((s) => s.network === network).commit;
  if (head !== want) throw new Error(`${network}: ${dir} is at ${head}, sources.json names ${want}`);
  trees[network] = { dir, commit: head };
}
function py(dir, sub, code) {
  try {
    const source = `import sys, json\nsys.path.insert(0, ${JSON.stringify(join(dir, sub))})\n${code}`;
    return JSON.parse(execFileSync('python3', ['-c', source], { maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'pipe'] }).toString());
  } catch (error) {
    throw new Error(`the reference tool under ${dir}/${sub} failed: ${error.stderr?.toString() ?? error}`);
  }
}

// ── Bitcoin ──────────────────────────────────────────────────────────────────
const bitcoin = py(trees.bitcoin.dir, 'tools/signatario-btc', `
import btc_core as c, btc_policy as p
keys = [c.pubkey(k) for k in range(1, 8)]
anchor = ('11' * 32, 1)
owner = c.address_from_spk('bitcoin-mainnet', c.p2wpkh(bytes(range(1, 21))))
v = p.Vault('bitcoin-mainnet', 5, keys, anchor[0], anchor[1], owner, p.DEFAULT_POLICY)
recipients = ['00' * 19 + '01', 'ab' * 20, '99ee0a068b17de102c3ef986247615e07996823f']
h = [bytes(range(1, 21)), bytes([0xff] * 20), bytes.fromhex('751e76e8199196d454941c45d1b3a323f1433bd6')]
good = [c.address_from_spk('bitcoin-mainnet', c.p2wpkh(x)) for x in h]
def refused(a):
    try:
        p2 = c.p2wpkh_hash('bitcoin-mainnet', a); return False
    except Exception: return True
bad = [good[0].upper(), good[0][:-1] + ('q' if good[0][-1] != 'q' else 'p'), good[0][:-1],
       c.address_from_spk('bitcoin-mainnet', c.p2wsh(b'\\x51')), c.segwit_encode('bc', 1, bytes(32)),
       c.address_from_spk('bitcoin-regtest', c.p2wpkh(h[0])), '0x' + 'ab' * 20, '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
       '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', '', ' ' + good[0]]
def credit(value, rate):
    try: return list(p.deposit_credit(v, value, rate))
    except p.PolicyError as e: return str(e)
def payout(units, rate):
    try: return list(p.release_payout(v, units, rate))
    except p.PolicyError as e: return str(e)
def refund(value, rate):
    try: return list(p.refund_amount(v, value, rate))
    except p.PolicyError as e: return str(e)
print(json.dumps({
  'threshold': 5, 'publicKeys': [k.hex() for k in v.keys], 'vaultId': v.vault_id.hex(), 'anchor': {'txid': anchor[0], 'vout': anchor[1]},
  'deposits': [{'recipient': '0x' + r, 'address': v.deposit_address(bytes.fromhex(r)), 'script': v.deposit_script(bytes.fromhex(r)).hex()} for r in recipients],
  'p2wpkh': [{'address': a, 'keyHash': x.hex()} for a, x in zip(good, h)],
  'refused': [{'address': a, 'refused': refused(a)} for a in bad],
  'sizes': {'depositVbytes': v.deposit_vb + v.overhead_vb, 'releaseVbytes': v.release_vb, 'refundVbytes': v.deposit_vb + v.payout_vb + v.overhead_vb},
  'policy': p.DEFAULT_POLICY,
  'credit': [{'sats': s, 'feeRate': r, 'result': credit(s, r)} for s, r in [(100000, 1), (100000, 17), (99999, 1), (10000000, 200), (10000001, 1), (250000, 44), (123456, 3)]],
  'payout': [{'units': u, 'feeRate': r, 'result': payout(u, r)} for u, r in [(1000, 1), (1000, 200), (100000, 25), (5, 1), (50000, 60)]],
  'refund': [{'sats': s, 'feeRate': r, 'result': refund(s, r)} for s, r in [(100000, 5), (50000, 80), (20000000, 12)]],
  'refundText': c.refund_text(v.vault_id, '22' * 32, 3, good[0]),
}))`);

// ── Solana ───────────────────────────────────────────────────────────────────
// An Ed25519 throwaway key from a fixed seed (PKCS#8 wrapping of the 32-byte seed), signed with node:crypto.
const seed = Buffer.alloc(32, 7);
const priv = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
const pub = createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(-32);
const solana = py(trees.solana.dir, 'tools/signatario-solana', `
import solana_lib as S, sol_proof as P
pub = bytes.fromhex('${pub.toString('hex')}')
wallet = S.b58encode(pub)
l2 = '0x99ee0a068b17de102c3ef986247615e07996823f'; router = '0x5fbdb2315678afecb367f032d93f642f64180aa3'
msg = P.exit_message(wallet, l2, router, 1794787200)
keys = [pub, S.pubkey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'), S.TOKEN_PROGRAM, S.SYSTEM_PROGRAM, S.ATA_PROGRAM,
        bytes(32), (1).to_bytes(32, 'little'), S.sha256(b'a'), S.sha256(b'b'), S.sha256(b'c'), S.sha256(b'd'),
        (0x05fc536d880238b13933c6d305acdfd5f098eff289f4c345b027b2c28f95e826).to_bytes(32, 'little'), bytes([0xec] + [0xff] * 30 + [0x7f]), bytes([0xee] + [0xff] * 30 + [0x7f])]
program = S.sha256(b'throwaway program')
while S.on_curve(program): program = S.sha256(program)
vault = S.find_program_address([b'vault', S.sha256(b'config')], program)
pdas = []
for seeds in ([b'tokens', vault[0]], [b'deposit', vault[0], (0).to_bytes(8, 'little')], [b'deposit', vault[0], (7).to_bytes(8, 'little')],
              [b'release', vault[0], (1).to_bytes(8, 'little')], [b'paid', vault[0], (0).to_bytes(8, 'little')]):
    a, bump = S.find_program_address(seeds, program)
    pdas.append({'seeds': [s.hex() for s in seeds], 'address': S.b58encode(a), 'bump': bump})
mint = S.pubkey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')
print(json.dumps({
  'wallet': wallet, 'l2Account': l2, 'router': router, 'issued': 1794787200, 'message': msg,
  'envelopes': [{'name': n, 'bytes': b.hex()} for n, b in P.envelopes(msg.encode(), pub)],
  'keys': [{'key': k.hex(), 'text': S.b58encode(k), 'onCurve': S.on_curve(k), 'smallOrder': S.small_order(k), 'commitment': '0x' + S.account_id(k).hex()} for k in keys],
  'program': S.b58encode(program), 'vault': {'address': S.b58encode(vault[0]), 'bump': vault[1], 'seeds': [b'vault'.hex(), S.sha256(b'config').hex()]},
  'pdas': pdas, 'ata': {'owner': wallet, 'mint': S.b58encode(mint), 'address': S.b58encode(S.associated_token_address(pub, mint))},
  'chainId': '0x' + S.chain_id_of(S.pubkey(S.MAINNET_GENESIS)).hex(),
}))`);
solana.signatures = solana.envelopes.map((e) => ({ name: e.name, signature: sign(null, Buffer.from(e.bytes, 'hex'), priv).toString('hex') }));
// The reference verifier must accept each of them (and refuse a changed message).
for (const s of solana.signatures) {
  const verdict = py(trees.solana.dir, 'tools/signatario-solana', `
import sol_proof as P
print(json.dumps(P.verify(${JSON.stringify(solana.wallet)}, ${JSON.stringify(solana.message)}, ${JSON.stringify(s.signature)})))`);
  if (verdict !== s.name) throw new Error(`sol_proof.verify answered ${verdict} for ${s.name}`);
}

// ── Stellar ──────────────────────────────────────────────────────────────────
const stellar = py(trees.stellar.dir, 'tools/signatario-stellar', `
import stellar_net as N
keys = [bytes(range(32)), bytes([0xaa] * 32), N.keccak256(b'k')]
good = [N.strkey_encode('account', k) for k in keys] + [N.strkey_encode('contract', keys[0]),
        'GAF2DTU23X5CFOPOUCUBTFJ5PKTSOV4GLZAJB5VMJW2JUA5KKYF5OLNA', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN']
def refused(s):
    try: N.recipient_commitment(s); return False
    except Exception: return True
bad = [good[0].lower(), good[0][:-1] + ('A' if good[0][-1] != 'A' else 'B'), good[0][:-1], 'M' + good[0][1:], '0x' + 'ab' * 20, '', good[0] + ' ']
print(json.dumps({
  'accepted': [{'address': a, 'kind': N.strkey_decode(a)[0], 'key': N.strkey_decode(a)[1].hex(), 'commitment': '0x' + N.recipient_commitment(a).hex()} for a in good],
  'refused': [{'address': a, 'refused': refused(a)} for a in bad],
}))`);

// ── TRON ─────────────────────────────────────────────────────────────────────
const tron = py(trees.tron.dir, 'tools/signatario-tron', `
import tronlib as T
good = ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', 'TCQ2d5gxTczSeN2oeni16JwMW7HWLzXEKc', T.base58('0x' + 'ab' * 20), T.base58('0x' + '00' * 19 + '01')]
def refused(s):
    try: T.b58check_decode(s); return False
    except Exception: return True
bad = [good[0][:-1] + ('u' if good[0][-1] != 'u' else 'v'), good[0][:-1], good[0].lower(), '0x' + 'ab' * 20, '', 'T' * 34]
print(json.dumps({
  'accepted': [{'address': a, 'address20': T.evm_address(a)} for a in good],
  'refused': [{'address': a, 'refused': refused(a)} for a in bad],
}))`);

const outFile = join(root, 'frontend/src/test/fixtures/bridge-vectors.json');
writeFileSync(
  outFile,
  `${JSON.stringify({ note: 'Generated by scripts/bridge/make-vectors.mjs from the bridges\' reference tools; do not edit.', commits: Object.fromEntries(Object.entries(trees).map(([k, v]) => [k, v.commit])), bitcoin, solana, stellar, tron }, null, 1)}\n`,
);
console.log(`wrote ${outFile}`);
