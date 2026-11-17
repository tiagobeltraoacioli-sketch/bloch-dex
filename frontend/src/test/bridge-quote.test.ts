// Fees, minimums and waits: the page's arithmetic against the vaults' own rules. Bitcoin against the answers of
// btc_policy.py (fixtures/bridge-vectors.json); the others against the formulas the bridges' files state.
import { describe, expect, it } from 'vitest';
import bundle from '@postern/bridge-bundle';
import vectors from './fixtures/bridge-vectors.json';
import { bitcoinDepositQuote, bitcoinExitQuote, bitcoinRefundQuote, parseFeeRate } from '../bridge/bitcoin';
import { parseBridgeBundle } from '../bridge/config';
import { depositWaits, exitWaits, limitLines, plainTime, quoteDeposit, quoteExit, releaseDelay, routeRisks } from '../bridge/quote';

const config = parseBridgeBundle(bundle, false);
const route = (id: string) => config.entries.find((e) => e.id === id)!.route!;
const PACE = { blockIntervalSeconds: 1800, longestQuietSeconds: 86400 };

describe('Bitcoin fee rules (btc_policy.py)', () => {
  const btc = route('bitcoin');
  it('uses the sizes and limits the reference vault computes', () => {
    const p = btc.bitcoin!.policy;
    expect([p.depositVbytes, p.releaseVbytes, p.refundVbytes]).toEqual([vectors.bitcoin.sizes.depositVbytes, vectors.bitcoin.sizes.releaseVbytes, vectors.bitcoin.sizes.refundVbytes]);
    const ref = vectors.bitcoin.policy;
    expect(p.dustSats).toBe(ref.dustSats);
    expect(p.feeRateCeiling).toBe(ref.maxFeerate);
    expect(p.depositMaxChargeBps).toBe(ref.maxChargeBps);
    expect(p.sweepConfirmations).toBe(ref.sweepDepth);
    expect(btc.finality.confirmations).toBe(ref.minConfirmations);
    expect(btc.limits.minDeposit * 100n).toBe(BigInt(ref.minDepositSats));
    expect(btc.limits.maxDeposit * 100n).toBe(BigInt(ref.maxDepositSats));
    expect(btc.limits.cap * 100n).toBe(BigInt(ref.capSats));
    expect(p.largeBurnThreshold * 100n).toBe(BigInt(ref.largeReleaseSats));
    expect(p.largeBurnDelaySeconds).toBe(ref.largeReleaseDelaySeconds);
    expect(btc.fee.depositBps).toBe(ref.depositFeeBps);
    expect(btc.fee.releaseBps).toBe(ref.releaseFeeBps);
  });
  it('credits a deposit exactly as deposit_credit does, and refuses where it refuses', () => {
    for (const v of vectors.bitcoin.credit) {
      const got = bitcoinDepositQuote(btc, BigInt(v.sats), BigInt(v.feeRate));
      if (typeof v.result === 'string') {
        expect(got.ok, `${v.sats}@${v.feeRate}`).toBe(false);
        if (!got.ok) expect(got.wait).toBe(/miner charge exceeds/.test(v.result));
      } else {
        expect(got).toEqual({ ok: true, units: BigInt(v.result[0]), bridgeFeeSats: BigInt(v.result[1]), minerChargeSats: BigInt(v.result[2]), restSats: BigInt(v.result[3]) });
        const q = quoteDeposit(btc, { assetUnits: BigInt(v.sats), feeRate: BigInt(v.feeRate) });
        expect(q.ok && q.receive!.amount).toBe(BigInt(v.result[0]));
      }
    }
  });
  it('pays an exit exactly as release_payout does (the router\'s quote), dust refused', () => {
    for (const v of vectors.bitcoin.payout) {
      const got = bitcoinExitQuote(btc, BigInt(v.units), BigInt(v.feeRate));
      if (typeof v.result === 'string') expect(got.dust).toBe(true);
      else expect(got).toEqual({ payoutSats: BigInt(v.result[0]), bridgeFeeSats: BigInt(v.result[1]), minerChargeSats: BigInt(v.result[2]), dust: false });
    }
    // The smallest burn still pays out at the ceiling (the file says so).
    expect(bitcoinExitQuote(btc, btc.limits.l2MinBurn, 200n).dust).toBe(false);
  });
  it('refunds as refund_amount does', () => {
    for (const v of vectors.bitcoin.refund) {
      const got = bitcoinRefundQuote(btc, BigInt(v.sats), BigInt(v.feeRate));
      expect(got).toEqual({ backSats: BigInt((v.result as number[])[0]), bridgeFeeSats: BigInt((v.result as number[])[1]), minerChargeSats: BigInt((v.result as number[])[2]) });
    }
  });
  it('takes a fee-rate ceiling only as a whole number from 1 to 200', () => {
    expect(parseFeeRate('1', 200)).toBe(1n);
    expect(parseFeeRate('200', 200)).toBe(200n);
    for (const bad of ['0', '201', '1.5', '-3', '', 'abc', '007', '1e2']) expect(parseFeeRate(bad, 200), bad).toBeNull();
  });
  it('an exit quote states the least received, and needs the ceiling', () => {
    const none = quoteExit(btc, { units: 50_000n });
    expect(none.ok).toBe(false);
    expect(none.problems[0]).toMatch(/highest Bitcoin fee rate/);
    const q = quoteExit(btc, { units: 50_000n, maxFeeRate: 60n });
    expect(q.ok && q.receiveIsMinimum).toBe(true);
    expect(q.receive).toEqual({ amount: BigInt((vectors.bitcoin.payout.find((v) => v.units === 50000 && v.feeRate === 60)!.result as number[])[0]), decimals: 8, symbol: 'BTC' });
    expect(quoteExit(btc, { units: 1000n, maxFeeRate: 200n }).ok).toBe(true);
    const dust = quoteExit({ ...btc, limits: { ...btc.limits, l2MinBurn: 1n } }, { units: 5n, maxFeeRate: 1n });
    expect(dust.ok).toBe(false);
    expect(dust.problems.join(' ')).toMatch(/router refuses this burn/);
  });
});

describe('bridge fees in basis points (5 each way; 10 on Bitcoin), fixed fees, minimums', () => {
  it('takes the rate of each route from its own file, never from a constant of the page', () => {
    const files = bundle.files as { network: { id: string }; fee: { depositBps: number; releaseBps: number } }[];
    for (const e of config.entries) {
      const file = files.find((f) => f.network.id === e.id)!;
      expect([e.route!.fee.depositBps, e.route!.fee.releaseBps], e.id).toEqual([file.fee.depositBps, file.fee.releaseBps]);
      // What the vaults' code allows at most (MAX_FEE_BPS 30); the page refuses a file above it.
      expect(Math.max(file.fee.depositBps, file.fee.releaseBps)).toBeLessThanOrEqual(30);
      const a = e.route!.limits.l2MaxBurn;
      if (e.id !== 'bitcoin' && e.id !== 'tron') expect(quoteExit(e.route!, { units: a }).receive!.amount, e.id).toBe((a - (a * BigInt(file.fee.releaseBps)) / 10_000n) * e.route!.asset.unitsPerCustodyUnit);
    }
    expect(route('ethereum').fee).toMatchObject({ depositBps: 5, releaseBps: 5 });
  });
  it('a USDC deposit of 1,000 nets 999.5 and the fee rounds down', () => {
    const eth = route('ethereum');
    const q = quoteDeposit(eth, { assetUnits: 1_000_000_000n });
    expect(q.ok && q.receive).toEqual({ amount: 999_500_000n, decimals: 6, symbol: 'bUSDC' });
    // 11.000001 USDC: fee floor(11000001 * 5 / 10000) = 5500 units.
    expect(quoteDeposit(eth, { assetUnits: 11_000_001n }).receive!.amount).toBe(11_000_001n - 5_500n);
    // The vault's rule, bit for bit: amount - (amount * bps) / 10000.
    for (const a of [11_000_000n, 12_345_678n, 9_999_999_999n]) expect(quoteDeposit(eth, { assetUnits: a }).receive!.amount).toBe(a - (a * 5n) / 10_000n);
  });
  it('refuses below the minimum, above the maximum and past the cap headroom', () => {
    const arb = route('ethereum');
    expect(quoteDeposit(arb, { assetUnits: 10_999_999n }).problems[0]).toMatch(/smallest deposit is 11 USDC/);
    expect(quoteDeposit(arb, { assetUnits: 10_000_000_001n }).problems[0]).toMatch(/largest single deposit is 10000 USDC/);
    for (const e of config.entries) {
      const r = e.route!;
      const unit = r.asset.unitsPerCustodyUnit;
      expect(quoteDeposit(r, { assetUnits: (r.limits.minDeposit - 1n) * unit, feeRate: 1n }).ok, e.id).toBe(false);
      expect(quoteDeposit(r, { assetUnits: (r.limits.maxDeposit + 1n) * unit, feeRate: 1n }).ok, e.id).toBe(false);
      expect(quoteDeposit(r, { assetUnits: r.limits.minDeposit * unit, feeRate: 1n }).ok, e.id).toBe(true);
      expect(quoteExit(r, { units: r.limits.l2MinBurn - 1n, maxFeeRate: 1n }).ok, e.id).toBe(false);
      expect(quoteExit(r, { units: r.limits.l2MinBurn, maxFeeRate: 1n }).ok, e.id).toBe(true);
    }
    expect(quoteDeposit(arb, { assetUnits: 1_000_000_000n, capHeadroom: 500_000_000n }).problems[0]).toMatch(/Only 500 bUSDC can still be minted/);
    expect(quoteDeposit(arb, { assetUnits: 1_000_000_000n, capHeadroom: 0n }).problems[0]).toMatch(/supply cap of bUSDC is reached/);
    expect(quoteDeposit(arb, { assetUnits: 0n }).ok).toBe(false);
  });
  it('TRON: a burn of A pays A - floor(A * 5 / 10000) - 13 USDT; minimum burn 65, minimum deposit 66', () => {
    const trx = route('tron');
    for (const a of [65_000_000n, 100_000_000n, 9_999_999_999n]) {
      const q = quoteExit(trx, { units: a });
      expect(q.ok && q.receive).toEqual({ amount: a - (a * 5n) / 10_000n - 13_000_000n, decimals: 6, symbol: 'USDT' });
    }
    expect(quoteExit(trx, { units: 64_999_999n }).problems[0]).toMatch(/smallest exit is 65 bUSDT.trx/);
    expect(quoteDeposit(trx, { assetUnits: 65_999_999n }).problems[0]).toMatch(/smallest deposit is 66 USDT/);
    const lines = quoteExit(trx, { units: 65_000_000n }).lines;
    expect(lines.find((l) => l.label === 'Fixed release fee')!.value).toBe('− 13 USDT');
    expect(lines.find((l) => l.label === 'Fixed release fee')!.note).toMatch(/20\.00% of the smallest exit/);
  });
  it('Stellar: 7-decimal amounts in multiples of 10 stroops; an exit pays stroops', () => {
    const xlm = route('stellar');
    expect(quoteDeposit(xlm, { assetUnits: 1_000_000_005n }).problems[0]).toMatch(/multiple of 0.000001 USDC/);
    expect(quoteDeposit(xlm, { assetUnits: 1_000_000_000n }).receive).toEqual({ amount: 99_950_000n, decimals: 6, symbol: 'bUSDC.xlm' });
    expect(quoteExit(xlm, { units: 100_000_000n }).receive).toEqual({ amount: 999_500_000n, decimals: 7, symbol: 'USDC' });
  });
  it('an exit above the balance, or outside the burn limits, is refused', () => {
    const sol = route('solana');
    expect(quoteExit(sol, { units: 20_000_000n, balance: 15_000_000n }).problems[0]).toMatch(/Your balance is 15 bUSDC.sol/);
    expect(quoteExit(sol, { units: 9_999_999n }).ok).toBe(false);
    expect(quoteExit(sol, { units: 10_000_000_001n }).ok).toBe(false);
    expect(quoteExit(sol, { units: 10_000_000n }).receive!.amount).toBe(9_995_000n);
  });
  it('lists minimums and limits per direction from the file', () => {
    expect(limitLines(route('tron'), 'exit').map((l) => l.value)).toEqual(['65 bUSDT.trx', '10000 bUSDT.trx', '10000 USDT']);
    expect(limitLines(route('bitcoin'), 'deposit').map((l) => l.value)).toEqual(['0.001 BTC', '0.1 BTC', '1 bBTC']);
  });
});

describe('waits in plain time', () => {
  it('words durations', () => {
    expect(plainTime(0)).toBe('no wait');
    expect(plainTime(30)).toBe('under a minute');
    expect(plainTime(60)).toBe('about a minute');
    expect(plainTime(1200)).toBe('about 20 minutes');
    expect(plainTime(3600)).toBe('about 60 minutes');
    expect(plainTime(7200)).toBe('about 2 hours');
    expect(plainTime(43200)).toBe('about 12 hours');
    expect(plainTime(259200)).toBe('3 days');
    expect(plainTime(806400)).toBe('9 days 8 hours');
  });
  it('a deposit waits source finality, the 12 hour credit delay and a finalized L2 block', () => {
    const w = depositWaits(route('ethereum'), 1_000_000n, PACE);
    expect(w.steps.map((s) => [s.label, s.typical])).toEqual([
      ['Finality on Ethereum', 'about 15 minutes'],
      ['Credit delay on the Bloch L2', 'about 12 hours'],
      ['Finalized L2 block', 'about 30 minutes'],
    ]);
    expect(w.total).toBe('about 13 hours');
    expect(w.worst).toBe('2 days 12 hours');
    expect(depositWaits(route('bitcoin'), 1000n, PACE).steps[0].typical).toBe('about 1.5 hours');
  });
  it('an exit waits L2 finality and the release, plus the route\'s own delay', () => {
    expect(exitWaits(route('ethereum'), 10_000_000n, PACE).steps.map((s) => s.label)).toEqual(['Finalized L2 block', 'Signatures and payment on Ethereum']);
    const xlm = exitWaits(route('stellar'), 10_000_000n, PACE);
    expect(xlm.steps.at(-1)).toMatchObject({ label: 'Release queue on Stellar', typical: 'about 2 hours' });
    expect(xlm.steps.at(-1)!.detail).toMatch(/9 days 8 hours; it is never lost/);
    expect(releaseDelay(route('solana'), 1_000_000_000n)).toBeNull();
    expect(releaseDelay(route('solana'), 1_000_000_001n)).toMatchObject({ seconds: 1800, label: 'Large-exit delay on Solana' });
    expect(releaseDelay(route('bitcoin'), 50_000n)).toBeNull();
    expect(releaseDelay(route('bitcoin'), 50_001n)).toMatchObject({ seconds: 43200 });
    expect(releaseDelay(route('tron'), 9_000_000_000n)).toBeNull();
  });
});

describe('risks particular to the route', () => {
  const ids = (id: string, direction: 'deposit' | 'exit') => routeRisks(route(id), direction).map((r) => r.id);
  it('names the issuer freeze where the issuer has that power, and not on Bitcoin', () => {
    for (const id of ['ethereum', 'arbitrum-one', 'op-mainnet', 'linea', 'solana', 'tron', 'stellar']) expect(ids(id, 'exit'), id).toContain('issuer');
    expect(ids('bitcoin', 'exit')).not.toContain('issuer');
    expect(routeRisks(route('tron'), 'exit').find((r) => r.id === 'issuer')!.body).toMatch(/transfer fee .*0\.2% and 50 USDT/);
  });
  it('says what is particular: the Stellar queue, the Solana hold without refund, the Bitcoin fee ceiling and keys', () => {
    expect(routeRisks(route('stellar'), 'exit').find((r) => r.id === 'xlm-queue')!.body).toMatch(/voided.*9 days 8 hours.*not lost.*never shows it as failed/s);
    const held = routeRisks(route('solana'), 'exit').find((r) => r.id === 'sol-held')!;
    expect(held.tone).toBe('danger');
    expect(held.body).toMatch(/exchange deposit address cannot sign and must not be used/);
    expect(held.body).toMatch(/HELD permanently.*no refund/s);
    expect(ids('bitcoin', 'exit')).toEqual(expect.arrayContaining(['btc-custody', 'btc-exit']));
    expect(routeRisks(route('bitcoin'), 'deposit').find((r) => r.id === 'btc-deposit')!.body).toMatch(/contract and cannot sign cannot ask for a refund/);
  });
  it('flags a peg asset when the file says the asset is not issuer-native', () => {
    const peg = { ...route('ethereum'), asset: { ...route('ethereum').asset, issuerNative: false, issuer: 'Binance' } };
    expect(routeRisks(peg, 'deposit').find((r) => r.id === 'peg')!.title).toMatch(/itself a peg token/);
    expect(ids('ethereum', 'deposit')).not.toContain('peg');
  });
  it('always says that the token is not the asset and that the bridge is unaudited', () => {
    for (const e of config.entries) for (const d of ['deposit', 'exit'] as const) expect(ids(e.id, d), e.id).toEqual(expect.arrayContaining(['wrapped', 'audit']));
  });
});
