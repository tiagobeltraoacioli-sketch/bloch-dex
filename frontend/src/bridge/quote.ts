// What a deposit or an exit costs, pays, waits for and risks: everything the page shows BEFORE anything is signed.
// Pure functions of the route (the bridge's own interface file) and the user's numbers. Integer arithmetic in the
// smallest units; the rounding is the vaults' (fees round down, so the user never receives less than shown).
import { formatAmount } from '../amm';
import type { Route } from './config';
import { bitcoinDepositQuote, bitcoinExitQuote } from './bitcoin';

export type Direction = 'deposit' | 'exit';
export type Money = { amount: bigint; decimals: number; symbol: string };
export const money = (m: Money) => `${formatAmount(m.amount, m.decimals)} ${m.symbol}`;

export type QuoteLine = { label: string; value: string; note?: string; kind: 'amount' | 'fee' | 'cost' | 'receive' };
export type Quote = {
  /** False when the amount cannot be bridged as typed; `problems` say why. Nothing is built from such a quote. */
  ok: boolean;
  problems: string[];
  /** What arrives, at the least. Null when `ok` is false. */
  receive: Money | null;
  /** True when `receive` is a floor that the real payment can exceed (Bitcoin: a lower fee rate than the ceiling). */
  receiveIsMinimum: boolean;
  lines: QuoteLine[];
  /** Amount in L2 token units: what is minted (deposit) or burned (exit). */
  l2Units: bigint;
};

const bps = (amount: bigint, rate: number) => (amount * BigInt(rate)) / 10_000n;
const pct = (rate: number) => `${(rate / 100).toFixed(2)}%`;
const custody = (route: Route, units: bigint): Money => ({ amount: units, decimals: route.l2.decimals, symbol: route.asset.symbol });
const wrapped = (route: Route, units: bigint): Money => ({ amount: units, decimals: route.l2.decimals, symbol: route.l2.symbol });
const asset = (route: Route, assetUnits: bigint): Money => ({ amount: assetUnits, decimals: route.asset.decimals, symbol: route.asset.symbol });

export type DepositInput = {
  /** In the asset's own smallest unit on the source network (sat, stroop, 1e-6 USDC). */
  assetUnits: bigint;
  /** Bitcoin: the fee rate (sat/vB) the user expects the vault to pay when it collects the deposit. */
  feeRate?: bigint;
  /** Units the token can still mint before its supply cap, when the page has read it. */
  capHeadroom?: bigint;
};

export function quoteDeposit(route: Route, input: DepositInput): Quote {
  const problems: string[] = [];
  const lines: QuoteLine[] = [];
  const unit = route.asset.unitsPerCustodyUnit;
  const sym = route.asset.symbol;
  const none = (l2Units = 0n): Quote => ({ ok: false, problems, receive: null, receiveIsMinimum: false, lines, l2Units });
  if (input.assetUnits <= 0n) {
    problems.push('Enter an amount.');
    return none();
  }
  lines.push({ label: `You send on ${route.name}`, value: money(asset(route, input.assetUnits)), kind: 'amount' });
  const min = route.limits.minDeposit * unit;
  const max = route.limits.maxDeposit * unit;
  if (input.assetUnits < min) problems.push(`The smallest deposit is ${money(asset(route, min))}.`);
  if (input.assetUnits > max) problems.push(`The largest single deposit is ${money(asset(route, max))}.`);
  let credited: bigint;
  let minimum = false;
  if (route.kind === 'utxo') {
    const rate = input.feeRate ?? 0n;
    if (rate <= 0n) {
      problems.push('Enter the Bitcoin fee rate you expect, to see the miner charge.');
      return none();
    }
    if (problems.length) return none();
    const q = bitcoinDepositQuote(route, input.assetUnits, rate);
    if (!q.ok) {
      problems.push(q.reason);
      return none();
    }
    lines.push({ label: `Bridge fee (${pct(route.fee.depositBps)})`, value: `− ${money(asset(route, q.bridgeFeeSats))}`, kind: 'fee' });
    lines.push({
      label: `Miner charge at ${rate} sat/vB`,
      value: `− ${money(asset(route, q.minerChargeSats))}`,
      note: `${route.bitcoin!.policy.depositVbytes} vbytes at the fee rate the signers pay when the vault collects your deposit: at most 1.5 times their own nodes' estimate and never above ${route.bitcoin!.policy.feeRateCeiling} sat/vB. This page cannot know that rate in advance; ${rate} sat/vB is your figure.`,
      kind: 'cost',
    });
    if (q.restSats > 0n)
      lines.push({ label: 'Below one token unit', value: `− ${money(asset(route, q.restSats))}`, note: 'bBTC counts in units of 0.000001 BTC (100 sat); the remainder stays in the vault\'s fee pool.', kind: 'cost' });
    credited = q.units;
    minimum = false;
  } else {
    if (input.assetUnits % unit !== 0n) {
      problems.push(`The amount must be a multiple of ${formatAmount(unit, route.asset.decimals)} ${sym}: the vault refuses anything finer.`);
      return none();
    }
    const gross = input.assetUnits / unit;
    const fee = bps(gross, route.fee.depositBps);
    lines.push({ label: `Bridge fee (${pct(route.fee.depositBps)})`, value: `− ${money(custody(route, fee))}`, note: `Kept by the vault on ${route.name} for the protocol.`, kind: 'fee' });
    credited = gross - fee;
  }
  if (input.capHeadroom !== undefined && credited > input.capHeadroom)
    problems.push(
      input.capHeadroom === 0n
        ? `The supply cap of ${route.l2.symbol} is reached: no deposit can be credited now.`
        : `Only ${money(wrapped(route, input.capHeadroom))} can still be minted under the supply cap.`,
    );
  if (problems.length) return none(credited);
  lines.push({ label: 'You receive on the Bloch L2', value: money(wrapped(route, credited)), kind: 'receive' });
  return { ok: true, problems, receive: wrapped(route, credited), receiveIsMinimum: minimum, lines, l2Units: credited };
}

export type ExitInput = {
  /** L2 token units to burn. */
  units: bigint;
  /** Bitcoin: the highest fee rate (sat/vB) the user accepts for the payout. */
  maxFeeRate?: bigint;
  /** The user's balance of the wrapped token at the finalized L2 block, when read. */
  balance?: bigint;
};

export function quoteExit(route: Route, input: ExitInput): Quote {
  const problems: string[] = [];
  const lines: QuoteLine[] = [];
  const unit = route.asset.unitsPerCustodyUnit;
  const none = (): Quote => ({ ok: false, problems, receive: null, receiveIsMinimum: false, lines, l2Units: input.units });
  if (input.units <= 0n) {
    problems.push('Enter an amount.');
    return none();
  }
  lines.push({ label: 'You burn on the Bloch L2', value: money(wrapped(route, input.units)), kind: 'amount' });
  if (input.units < route.limits.l2MinBurn) problems.push(`The smallest exit is ${money(wrapped(route, route.limits.l2MinBurn))}.`);
  if (input.units > route.limits.l2MaxBurn) problems.push(`The largest single exit is ${money(wrapped(route, route.limits.l2MaxBurn))}.`);
  if (input.units >= 1n << 64n) problems.push('The amount is too large.');
  if (input.balance !== undefined && input.units > input.balance)
    problems.push(`Your balance is ${money(wrapped(route, input.balance))}.`);
  if (route.kind === 'utxo') {
    const policy = route.bitcoin!.policy;
    const rate = input.maxFeeRate ?? 0n;
    if (rate < 1n || rate > BigInt(policy.feeRateCeiling)) {
      problems.push(`Name the highest Bitcoin fee rate you accept: a whole number from 1 to ${policy.feeRateCeiling} sat/vB.`);
      return none();
    }
    const q = bitcoinExitQuote(route, input.units, rate);
    lines.push({ label: `Bridge fee (${pct(route.fee.releaseBps)})`, value: `− ${money(asset(route, q.bridgeFeeSats))}`, kind: 'fee' });
    lines.push({
      label: `Miner charge, at most (${rate} sat/vB)`,
      value: `− ${money(asset(route, q.minerChargeSats))}`,
      note: `${policy.releaseVbytes} vbytes at the fee rate of the payment. No signer pays your exit in a transaction above ${rate} sat/vB: while the market is above it, the exit waits. A lower rate at payment leaves you more.`,
      kind: 'cost',
    });
    if (q.dust) {
      problems.push(`At ${rate} sat/vB the payout would be below the smallest payment the vault makes (${policy.dustSats} sat): the router refuses this burn. Lower the fee rate or raise the amount.`);
      return none();
    }
    if (problems.length) return none();
    lines.push({ label: 'You receive on Bitcoin, at least', value: money(asset(route, q.payoutSats)), kind: 'receive' });
    return { ok: true, problems, receive: asset(route, q.payoutSats), receiveIsMinimum: true, lines, l2Units: input.units };
  }
  const fee = bps(input.units, route.fee.releaseBps);
  lines.push({ label: `Bridge fee (${pct(route.fee.releaseBps)})`, value: `− ${money(custody(route, fee))}`, note: `Kept by the vault on ${route.name} for the protocol.`, kind: 'fee' });
  let payout = input.units - fee;
  if (route.tron) {
    const flat = route.tron.policy.releaseFlat;
    lines.push({
      label: 'Fixed release fee',
      value: `− ${money(custody(route, flat))}`,
      note: `Charged on every exit to TRON, whatever its size, for the energy the payment costs. It is ${pct(Number((flat * 10_000n) / route.limits.l2MinBurn))} of the smallest exit.`,
      kind: 'fee',
    });
    payout = payout > flat ? payout - flat : 0n;
    if (payout === 0n) problems.push('The fees are larger than this amount.');
  }
  if (problems.length) return none();
  lines.push({ label: `You receive on ${route.name}`, value: money(asset(route, payout * unit)), kind: 'receive' });
  return { ok: true, problems, receive: asset(route, payout * unit), receiveIsMinimum: false, lines, l2Units: input.units };
}

// ── waits ────────────────────────────────────────────────────────────────────
/** A duration in plain words: "about 12 hours", "9 days 8 hours", "about a minute". */
export function plainTime(seconds: number): string {
  if (seconds <= 0) return 'no wait';
  if (seconds < 90) return seconds <= 45 ? 'under a minute' : 'about a minute';
  if (seconds < 5400) return `about ${Math.round(seconds / 60)} minutes`;
  if (seconds < 86400 * 2) {
    const hours = Math.round((seconds / 3600) * 2) / 2;
    return hours === 1 ? 'about 1 hour' : `about ${hours} hours`;
  }
  const days = Math.floor(seconds / 86400);
  const hours = Math.round((seconds - days * 86400) / 3600);
  return hours ? `${days} days ${hours} hours` : `${days} days`;
}

export type WaitStep = { label: string; typical: string; detail: string; seconds: number; worstSeconds?: number };
export type Waits = { steps: WaitStep[]; total: string; worst: string | null };

/** What the L2 itself adds to any wait: a transaction or a credit counts once its L2 block is finalized. */
export type L2Pace = { blockIntervalSeconds: number; longestQuietSeconds: number };

export function depositWaits(route: Route, l2Units: bigint, pace: L2Pace): Waits {
  const steps: WaitStep[] = [];
  steps.push({
    label: `Finality on ${route.name}`,
    typical: plainTime(route.finality.typicalSeconds),
    detail: `${route.finality.rule} In the worst case this takes ${plainTime(route.finality.worstCaseSeconds)}.`,
    seconds: route.finality.typicalSeconds,
    worstSeconds: route.finality.worstCaseSeconds,
  });
  const delayed = l2Units > route.limits.largeItemThreshold;
  steps.push({
    label: 'Credit delay on the Bloch L2',
    typical: delayed ? plainTime(route.limits.mintDelaySeconds) : 'no wait',
    detail: delayed
      ? `Every deposit${route.limits.largeItemThreshold > 0n ? ` above ${formatAmount(route.limits.largeItemThreshold, route.l2.decimals)} ${route.l2.symbol}` : ''} waits ${plainTime(route.limits.mintDelaySeconds)} between the committee's attestation and the credit. During this time the guardians can cancel a credit that has no deposit behind it. Your tokens are not usable until the credit is made.`
      : 'A deposit of this size is credited without the delay.',
    seconds: delayed ? route.limits.mintDelaySeconds : 0,
  });
  steps.push({
    label: 'Finalized L2 block',
    typical: plainTime(pace.blockIntervalSeconds),
    detail: `The credit counts once its L2 block is finalized. The L2 makes a block only when it has work; on a quiet chain a block can be up to ${plainTime(pace.longestQuietSeconds)} away.`,
    seconds: pace.blockIntervalSeconds,
    worstSeconds: pace.longestQuietSeconds,
  });
  return total(steps);
}

export function exitWaits(route: Route, units: bigint, pace: L2Pace): Waits {
  const steps: WaitStep[] = [];
  steps.push({
    label: 'Finalized L2 block',
    typical: plainTime(pace.blockIntervalSeconds),
    detail: `The committee signs only a burn that is in a finalized L2 block. On a quiet chain a block can be up to ${plainTime(pace.longestQuietSeconds)} away.`,
    seconds: pace.blockIntervalSeconds,
    worstSeconds: pace.longestQuietSeconds,
  });
  steps.push({
    label: `Signatures and payment on ${route.name}`,
    typical: plainTime(route.release.typicalSeconds),
    detail: `${route.committee.threshold} of the committee's signers certify the burn, then a relayer sends the payment. This is the bridge's own typical figure.`,
    seconds: route.release.typicalSeconds,
  });
  const delay = releaseDelay(route, units);
  if (delay)
    steps.push({ label: delay.label, typical: plainTime(delay.seconds), detail: delay.detail, seconds: delay.seconds, worstSeconds: delay.worstSeconds });
  return total(steps);
}

/** The source-side delay of an exit of this size, if the route has one. */
export function releaseDelay(route: Route, units: bigint): { label: string; seconds: number; worstSeconds?: number; detail: string } | null {
  if (route.bitcoin && units > route.bitcoin.policy.largeBurnThreshold)
    return {
      label: 'Large-exit delay',
      seconds: route.bitcoin.policy.largeBurnDelaySeconds,
      detail: `An exit above ${formatAmount(route.bitcoin.policy.largeBurnThreshold, route.l2.decimals)} ${route.l2.symbol} waits ${plainTime(route.bitcoin.policy.largeBurnDelaySeconds)} before it is paid.`,
    };
  if (route.solana && units > route.solana.policy.largeReleaseThreshold)
    return {
      label: 'Large-exit delay on Solana',
      seconds: route.solana.policy.releaseDelaySeconds,
      detail: `An exit above ${formatAmount(route.solana.policy.largeReleaseThreshold, route.l2.decimals)} ${route.asset.symbol} waits ${plainTime(route.solana.policy.releaseDelaySeconds)} on Solana between its approval and its payment.`,
    };
  if (route.limits.releaseDelaySeconds > 0 && units > route.limits.largeItemThreshold)
    return {
      label: `Release queue on ${route.name}`,
      seconds: route.limits.releaseDelaySeconds,
      worstSeconds: route.stellar?.policy.worstCaseGuardianDelaySeconds,
      detail: `Every exit waits ${plainTime(route.limits.releaseDelaySeconds)} in the vault's queue before anyone can pay it.${
        route.stellar
          ? ` A guardian pause empties the queue: the exit is then certified again and waits the delay again. With every guardian key hostile an exit can be delayed by ${plainTime(route.stellar.policy.worstCaseGuardianDelaySeconds)}; it is never lost.`
          : ''
      }`,
    };
  return null;
}

function total(steps: WaitStep[]): Waits {
  const sum = steps.reduce((n, s) => n + s.seconds, 0);
  const worst = steps.reduce((n, s) => n + (s.worstSeconds ?? s.seconds), 0);
  return { steps, total: plainTime(sum), worst: worst > sum ? plainTime(worst) : null };
}

// ── limits ───────────────────────────────────────────────────────────────────
export type LimitLine = { label: string; value: string };
export function limitLines(route: Route, direction: Direction): LimitLine[] {
  const unit = route.asset.unitsPerCustodyUnit;
  const a = (u: bigint) => money(asset(route, u * unit));
  const w = (u: bigint) => money(wrapped(route, u));
  const day = plainTime(route.limits.windowSeconds).replace('about ', '');
  return direction === 'deposit'
    ? [
        { label: 'Smallest deposit', value: a(route.limits.minDeposit) },
        { label: 'Largest single deposit', value: a(route.limits.maxDeposit) },
        { label: `Total supply cap of ${route.l2.symbol}`, value: w(route.limits.cap) },
      ]
    : [
        { label: 'Smallest exit', value: w(route.limits.l2MinBurn) },
        { label: 'Largest single exit', value: w(route.limits.l2MaxBurn) },
        { label: `All exits together, per ${day}`, value: a(route.limits.window) },
      ];
}

// ── risks ────────────────────────────────────────────────────────────────────
export type Risk = { id: string; title: string; body: string; tone: 'warn' | 'danger' | 'info' };

/** The risks that are particular to this route and direction. Every one is shown; none sits behind a click. */
export function routeRisks(route: Route, direction: Direction): Risk[] {
  const risks: Risk[] = [];
  const sym = route.asset.symbol;
  const issuerName = route.asset.issuer.split(' (')[0];
  risks.push({
    id: 'wrapped',
    title: `${route.l2.symbol} is not ${sym}`,
    body: `${route.l2.symbol} is a claim on ${sym} held in one vault on ${route.name}. It is a separate token from every other wrapped token here (each network has its own vault, cap and books) and is worth ${sym} only while that vault holds it and ${route.committee.threshold} of the bridge's signers keep to the rules.`,
    tone: 'info',
  });
  if (!route.asset.issuerNative)
    risks.push({
      id: 'peg',
      title: `${sym} on ${route.name} is itself a peg token`,
      body: `It is issued by ${issuerName}, not by the asset's own issuer: its value depends on that custodian as well as on this bridge.`,
      tone: 'danger',
    });
  const powers = route.asset.issuerPowers.join(' ').toLowerCase();
  if (/freeze|blacklist|seize|pause/.test(powers))
    risks.push({
      id: 'issuer',
      title: `${issuerName} can freeze ${sym}`,
      body:
        route.kind === 'tvm'
          ? `The issuer can blacklist an address, pause the token, and destroy blacklisted funds. If it blacklists the vault or pauses the token, no exit can be paid until that ends. A blacklisted recipient is still paid, and the funds are then frozen at that address by the issuer. If the issuer switches on its own transfer fee (0 today, at most ${route.tron!.policy.issuerFeeMaxBps / 100}% and ${formatAmount(route.tron!.policy.issuerFeeMaxUnits, route.l2.decimals)} ${sym}), exits pay less by that fee and deposits stop.`
          : route.kind === 'stellar'
            ? `The issuer can revoke the authorization of any balance, the vault's included. While it does, exits cannot be paid; a recipient whose own authorization is revoked cannot be paid until the issuer restores it.`
            : `The issuer can blacklist an address${/pause/.test(powers) ? ' and pause the token' : ''}. If it freezes the vault, no exit can be paid until it lifts that. ${direction === 'exit' ? 'A recipient the issuer has blacklisted cannot be paid, and the burn cannot be redirected to another address.' : ''}`.trim(),
      tone: 'warn',
    });
  if (route.kind === 'utxo')
    risks.push({
      id: 'btc-custody',
      title: 'There is no contract on Bitcoin',
      body: `${route.committee.threshold} of the committee's keys can spend the whole vault and every deposit the vault has not collected yet. Every limit on the Bitcoin side is a rule each signer applies before signing, not code on the chain.`,
      tone: 'warn',
    });
  if (direction === 'deposit') {
    if (route.kind === 'utxo')
      risks.push({
        id: 'btc-deposit',
        title: 'A payment outside the limits is not credited',
        body: 'A payment below the minimum, above the maximum, or made while the supply cap is reached stays at the deposit address. Only the L2 address it names can have it sent back, by signing a refund request; an L2 address that is a contract and cannot sign cannot ask for a refund. A payment to an address computed for another L2 address is credited to that address.',
        tone: 'danger',
      });
    risks.push({
      id: 'recipient',
      title: 'The L2 address you name receives the tokens',
      body: 'A deposit cannot be redirected after it is made. Do not name a contract unless it can move the token.',
      tone: 'info',
    });
  } else {
    if (route.kind === 'svm')
      risks.push({
        id: 'sol-held',
        title: 'Exits go to a wallet you control',
        body: 'The destination wallet must sign a message before the burn. An exchange deposit address cannot sign and must not be used. An exit sent to any address that is not a wallet (a token account, a program), or made outside this page, may be HELD permanently by the signers: nothing is paid and there is no refund.',
        tone: 'danger',
      });
    if (route.kind === 'utxo')
      risks.push({
        id: 'btc-exit',
        title: 'An exit can wait for lower Bitcoin fees',
        body: 'You name the highest fee rate you accept. While the Bitcoin fee market is above it, the exit is not paid; it waits, with no time limit and no way to raise the ceiling afterwards. A burn made directly on the token, not through this page\'s router, is never paid until the account that burned claims it through the router.',
        tone: 'warn',
      });
    if (route.kind === 'stellar')
      risks.push({
        id: 'xlm-queue',
        title: 'A guardian pause empties the exit queue',
        body: `Every exit waits in the vault's queue. If a guardian pauses the vault (72 hours), every queued exit is voided, certified again by the committee after the pause, and waits the delay again. With hostile guardian keys an exit can be delayed by ${plainTime(route.stellar!.policy.worstCaseGuardianDelaySeconds)}. It is not lost and this page never shows it as failed. A G… account must already hold a ${sym} trustline, or the payment waits until it does.`,
        tone: 'warn',
      });
    if (route.kind === 'tvm' || route.kind === 'evm')
      risks.push({
        id: 'recipient-exit',
        title: 'The burn names the recipient for good',
        body: `The ${sym} is paid to the address you enter and to no other. An address you do not control, or one on the wrong network, cannot be corrected after the burn.`,
        tone: 'warn',
      });
    risks.push({
      id: 'pause',
      title: 'A guardian can pause the vault',
      body: `One guardian can pause payments on ${route.name} for ${plainTime(route.committee.pauseSeconds).replace('about ', '')}. A burned exit is paid after the pause; the pause cannot move funds.`,
      tone: 'info',
    });
  }
  risks.push({
    id: 'audit',
    title: 'This bridge is new and not audited',
    body: 'Its own files say so. Bridge only what you can afford to have delayed or lost.',
    tone: 'warn',
  });
  return risks;
}
