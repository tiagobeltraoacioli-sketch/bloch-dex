// The named states of a deposit and of an exit, and what the user can do in each. Pure functions of canonical
// observations (the L2 at its finalized block, the source network at its finality rule); no backend, no guess.
// An exit is never shown as failed because it waits: a pause, a queue, a fee ceiling and a hold are states with
// their own names. "Held" on Solana is the signers' decision and is not on any chain: the page derives it from the
// same read the signers make (the destination account) and says that it is the page's reading.
import { formatAmount } from '../amm';
import type { Route } from './config';
import type { BurnObservation, MintObservation } from './l2';
import { plainTime } from './quote';
import type { ReleaseRecord } from './solana';

export type Tone = 'wait' | 'ok' | 'warn' | 'danger' | 'action';
export type StatusAction = {
  id: 'execute-credit' | 'drain-credits' | 'create-token-account' | 'execute-release' | 'add-trustline' | 'claim-direct-burn' | 'announce-wallet' | 'redirect-held-burn' | 'refund-request' | 'wait';
  label: string;
  /** What doing it involves, in a sentence. */
  detail: string;
};
export type Status = {
  /** Stable name of the state (tests, the harness and screenshots key on it). */
  state: string;
  title: string;
  body: string;
  tone: Tone;
  /** Where it stands in the route's steps, for the timeline: index of the current step and their names. */
  step: number;
  steps: string[];
  actions: StatusAction[];
  /** When the state is expected to change, as a unix time, if the chain says so. */
  until?: bigint;
};

const at = (seconds: bigint) =>
  new Date(Number(seconds) * 1000).toISOString().replace('T', ' ').replace(/:\d\d\.000Z$/, ' UTC');
const left = (until: bigint, now: bigint) => (until > now ? plainTime(Number(until - now)) : 'now');

// ── deposits ─────────────────────────────────────────────────────────────────
export const DEPOSIT_STEPS = ['Sent', 'Final on the source network', 'Attested, credit delay', 'Credited'];

/** A deposit seen on the source network only (no credit queued on the L2 yet). */
export type SourceDeposit =
  | { seen: false }
  | { seen: true; final: boolean; confirmations?: number; needed?: number };

export function sourceDepositStatus(route: Route, source: SourceDeposit): Status {
  const steps = DEPOSIT_STEPS;
  if (!source.seen)
    return {
      state: 'deposit-not-seen',
      title: `Not seen on ${route.name} yet`,
      body: `The page has not found this deposit in a block of ${route.name}. If you just sent it, it appears here once it is included. If you sent nothing, nothing is in flight.`,
      tone: 'wait',
      step: 0,
      steps,
      actions: [],
    };
  if (!source.final)
    return {
      state: 'deposit-source-pending',
      title: `Waiting for finality on ${route.name}`,
      body: `${route.finality.rule}${source.needed ? ` So far: ${source.confirmations ?? 0} of ${source.needed} confirmations.` : ''} Usually ${plainTime(route.finality.typicalSeconds)}; nothing to do.`,
      tone: 'wait',
      step: 1,
      steps,
      actions: [],
    };
  return {
    state: 'deposit-awaiting-attestation',
    title: 'Final on the source network; waiting for the committee',
    body: `${route.committee.threshold} signers attest the deposit to the Bloch L2. The credit then appears here with its ${plainTime(route.limits.mintDelaySeconds).replace('about ', '')} delay. Nothing to do.`,
    tone: 'wait',
    step: 2,
    steps,
    actions: [],
  };
}

export function mintStatus(route: Route, mint: MintObservation, now: bigint, mintsPausedUntil: bigint): Status {
  const steps = DEPOSIT_STEPS;
  const amount = `${formatAmount(mint.amount, route.l2.decimals)} ${route.l2.symbol}`;
  if (mint.executed)
    return { state: 'deposit-credited', title: `${amount} credited`, body: `The tokens are in your L2 account since finalized block ${mint.executed.block}. You can trade them on the DEX or exit back to ${route.name}.`, tone: 'ok', step: 3, steps, actions: [] };
  if (mint.cancelled)
    return {
      state: 'deposit-cancelled',
      title: 'Credit cancelled by the guardians; held for the committee',
      body: `Two guardians cancelled this queued credit in block ${mint.cancelled.block}. That is their check against a credit with no deposit behind it. If your deposit is real and final on ${route.name}, the committee queues the credit again and it appears here; your funds on ${route.name} stay in the vault meanwhile. This is not a refund and not a loss; there is nothing to send again.`,
      tone: 'warn',
      step: 2,
      steps,
      actions: [],
    };
  if (!mint.pending)
    return { state: 'deposit-unknown', title: 'Queued credit no longer pending', body: 'The token shows neither a pending nor an executed credit for this deposit at the finalized block. Refresh; if it stays, check the token on the explorer.', tone: 'warn', step: 2, steps, actions: [] };
  if (mintsPausedUntil > now)
    return {
      state: 'deposit-paused',
      title: 'Credits are paused on the L2 token',
      body: `A guardian paused ${route.l2.symbol} mints until ${at(mintsPausedUntil)}. Your credit of ${amount} stays queued and is made after the pause. Nothing to do.`,
      tone: 'warn',
      step: 2,
      steps,
      actions: [],
      until: mintsPausedUntil,
    };
  if (mint.pending.readyAt > now)
    return {
      state: 'deposit-credit-delay',
      title: `Credit of ${amount} in ${left(mint.pending.readyAt, now)}`,
      body: `The committee attested your deposit. Every credit waits ${plainTime(route.limits.mintDelaySeconds).replace('about ', '')} before it is made; this one is ready at ${at(mint.pending.readyAt)}. The tokens are not usable until then. Nothing to do.`,
      tone: 'wait',
      step: 2,
      steps,
      actions: [],
      until: mint.pending.readyAt,
    };
  if (mint.creditHead)
    return {
      state: 'deposit-ready',
      title: `Credit of ${amount} is ready`,
      body: 'The delay is over. A relayer normally makes the credit within minutes; anyone may make it, you included.',
      tone: 'action',
      step: 2,
      steps,
      actions: [{ id: 'execute-credit', label: 'Credit now', detail: `Sends executeMint for this deposit on the ${route.l2.symbol} token from your wallet. It moves nothing of yours; you pay the L2 fee.` }],
    };
  return {
    state: 'deposit-ready-behind',
    title: `Credit of ${amount} is ready, behind an earlier deposit`,
    body: `The token credits deposits in the vault's order. An earlier deposit is still waiting for its own delay or has not been credited yet; yours follows it. Anyone may ask the token to credit every deposit that is due.`,
    tone: 'wait',
    step: 2,
    steps,
    actions: [{ id: 'drain-credits', label: 'Credit all that are due', detail: `Sends drain() on the ${route.l2.symbol} token: it credits, in order, the queued deposits whose delay is over. It does nothing if the first in line is not due.` }],
  };
}

// ── exits ────────────────────────────────────────────────────────────────────
export const EXIT_STEPS = ['Burned', 'Final on the L2', 'Certified', 'Paid'];

/** What the source network shows for one exit, per network kind; `unread` when the page has no way to read it. */
export type SourceExit =
  | { kind: 'unread'; reason: string }
  | {
      kind: 'vault';
      /** EVM and TRON vaults: releasedBurn(burnId). */
      released: boolean;
      /** A queued release (vaults with a release delay) and when it can be paid. */
      queuedUntil: bigint | null;
      pausedUntil: bigint;
      releasesEnabled: boolean;
      /** What the release bucket allows now, in custody units. */
      available: bigint;
    }
  | {
      kind: 'solana';
      record: ReleaseRecord | null;
      paidBit: boolean;
      pausedUntil: bigint;
      voidThroughSeq: bigint;
      /** What the release bucket allows now (the vault's stored level; it refills over the window). */
      bucket: bigint;
      /** The destination wallet's account on Solana at finalized: what the signers read before certifying. */
      destination: 'absent' | 'system' | 'not-a-wallet';
      /** The wallet's USDC associated token account exists. */
      tokenAccount: boolean;
    }
  | {
      kind: 'stellar';
      /** burn_status(nonce, burnId): 0 open, 1 queued, 2 paid, 3 held. */
      burnStatus: 0 | 1 | 2 | 3;
      /** pending(releaseId), when the page could read it. */
      pending: { readyAt: bigint; pauseCount: bigint } | null;
      pauseCount: bigint;
      pausedUntil: bigint;
      trustline: 'trusted' | 'no-trustline' | 'unauthorized' | 'no-account' | 'contract';
    }
  | {
      kind: 'bitcoin';
      /** A payment from the vault to the destination address found on Bitcoin. */
      payment: { txid: string; confirmations: number; sats: bigint } | null;
      /** The fee rate the next blocks ask for, by the endpoint's estimate (sat/vB); null when unknown. */
      feeEstimate: number | null;
      /** The vault has set this burn aside (its thread marker says so); null when the page cannot tell. */
      setAside: boolean | null;
      /** A direct burn: whether its burner has claimed it through the router. */
      claimed: boolean;
    };

export function exitStatus(route: Route, burn: BurnObservation, source: SourceExit, now: bigint): Status {
  const steps = EXIT_STEPS;
  const amount = `${formatAmount(burn.amount, route.l2.decimals)} ${route.l2.symbol}`;
  const to = burn.recipient;
  const waitingCommittee = (extra = ''): Status => ({
    state: 'exit-waiting-signatures',
    title: 'Final on the L2; waiting for the committee',
    body: `Your burn of ${amount} is in finalized L2 block ${burn.block}.${burn.recipientOriginal ? ` You named ${to} for it in L2 block ${(burn.redirect ?? burn.claim)?.block ?? '?'} (it was ${burn.recipientOriginal}).` : ''} ${route.committee.threshold} signers now certify it for ${route.name}; a relayer then sends the payment to ${to}. Usually ${plainTime(route.release.typicalSeconds)}.${extra}${burn.redirectIgnored ? ' A redirect you sent later is not followed: this exit was not held, so the signers pay the destination the burn named.' : ''} Nothing to do.`,
    tone: 'wait',
    step: 2,
    steps,
    actions: [],
  });
  const paid = (detail: string): Status => ({ state: 'exit-paid', title: `Paid on ${route.name}`, body: detail, tone: 'ok', step: 3, steps, actions: [] });
  const canRedirect = route.kind === 'svm' && !!route.solana?.proof.redirectTemplate;
  const redirectAction: StatusAction[] = canRedirect
    ? [{ id: 'redirect-held-burn', label: 'Send to another address', detail: 'Sends redirectHeldBurn(burn id, new wallet, nonce, proof) on the exit router from the account that burned, after the NEW wallet signs one line. It moves nothing on the L2; the signers then pay the new wallet. Only a held burn (or one made directly on the token) can be redirected, never after an approval; of several redirects the one with the highest nonce counts.' }]
    : [];
  // A redirect or claim the page applied: the destination shown is the one named later, by the burner, on the L2.
  const named = burn.recipientOriginal ? ` You named ${to} for it in L2 block ${(burn.redirect ?? burn.claim)?.block ?? '?'} (it was ${burn.recipientOriginal}).` : '';

  // A burn made directly on the token of a route that exits through a router: the bridge does not pay it as is.
  // A claim (Bitcoin, Stellar) or a redirect (Solana) by its burner, final on the L2, names where it is paid; the
  // page then reads that destination like any exit.
  const recovered = !!burn.claim || (route.kind === 'svm' && !!burn.redirect);
  if (route.router && !burn.viaRouter && !recovered) {
    if (route.kind === 'utxo') {
      if (source.kind === 'bitcoin' && source.payment) return paid(`The vault paid ${formatAmount(source.payment.sats, 8)} BTC in transaction ${source.payment.txid}.`);
      if (!(source.kind === 'bitcoin' && source.claimed))
        return {
          state: 'exit-unclaimed',
          title: 'Burned directly on the token: not payable until claimed',
          body: `This burn of ${amount} was not made through the exit router, so the 20 bytes it names are not treated as a Bitcoin address and it is NEVER paid as it is. The account that burned must name a Bitcoin address and a fee ceiling once, through the router. There is no time limit; until then the coins stay in the vault.`,
          tone: 'danger',
          step: 1,
          steps,
          actions: [{ id: 'claim-direct-burn', label: 'Claim this burn', detail: 'Sends claimDirectBurn(burn nonce, Bitcoin address, highest fee rate) on the exit router from the account that burned. Set once; it cannot be changed.' }],
        };
    } else if (route.kind === 'stellar' && route.stellar?.policy.directBurnClaim === 'router')
      return {
        state: 'exit-unclaimed',
        title: 'Burned directly on the token: not payable until claimed',
        body: `This burn of ${amount} was not made through the exit router, so it is NEVER paid to the 20 bytes it names. The account that burned must name a Stellar address for it once, with a transaction on the exit router of the L2; the claim counts once it is final on the L2. It is set once and cannot be changed, there is no time limit and no other way, and a contract that cannot send that call can never be paid. Name a wallet you control that holds the USDC trustline, never an exchange deposit address.`,
        tone: 'danger',
        step: 1,
        steps,
        actions: [{ id: 'claim-direct-burn', label: 'Claim this burn', detail: 'Sends claimDirectBurn(burn nonce, Stellar address) on the exit router from the account that burned. Set once; it cannot be changed.' }],
      };
    else
      return {
        state: 'exit-held-direct-burn',
        title: 'Burned directly on the token: held',
        body:
          route.kind === 'svm'
            ? canRedirect
              ? `This burn of ${amount} was not made through the exit router, so no wallet has proven it is its destination: the signers hold it. Its burner can name a wallet for it with "Send to another address" (that wallet signs one line first). Until then it is not paid; there is no refund path today.`
              : `This burn of ${amount} was not made through the exit router. The signers hold it until a wallet that hashes to the 20 bytes it names is announced on the recipient registry; if those bytes are not a wallet commitment (an Ethereum address typed by habit), it can never be paid and there is no refund path today.`
            : `This burn of ${amount} was not made through the exit router. It is held, and paid only when the account that burned signs a claim naming a Stellar address and hands it to the bridge operators; a contract cannot claim.`,
        tone: 'danger',
        step: 1,
        steps,
        actions:
          route.kind === 'svm'
            ? [...redirectAction, { id: 'announce-wallet', label: 'How to announce the wallet', detail: 'announce(bytes32 wallet) on SolanaRecipientRegistry, once per wallet; only useful when the burn names that wallet\'s commitment.' }]
            : [],
      };
  }

  if (source.kind === 'unread') {
    const base = waitingCommittee();
    return { ...base, state: 'exit-source-unread', title: `Final on the L2; ${route.name} cannot be read by this page`, body: `Your burn of ${amount} is in finalized L2 block ${burn.block}; that part is certain. ${source.reason} Look up ${to} on a ${route.name} explorer to see the payment. An exit that is late is waiting, not lost.`, tone: 'warn' };
  }

  if (source.kind === 'vault') {
    if (source.released && source.queuedUntil === null) return paid(`The vault on ${route.name} has released this burn to ${to}.`);
    if (source.released && source.queuedUntil !== null)
      return {
        state: 'exit-queued',
        title: source.queuedUntil > now ? `Certified; payable in ${left(source.queuedUntil, now)}` : 'Certified; payable now',
        body: `The vault queued this release until ${at(source.queuedUntil)}. After that anyone may execute it.`,
        tone: source.queuedUntil > now ? 'wait' : 'action',
        step: 2,
        steps,
        actions: [],
        until: source.queuedUntil,
      };
    if (source.pausedUntil > now)
      return { state: 'exit-vault-paused', title: `The vault on ${route.name} is paused`, body: `A guardian paused releases until ${at(source.pausedUntil)}. Your exit of ${amount} is paid after the pause; a pause cannot move or cancel it. Nothing to do.`, tone: 'warn', step: 2, steps, actions: [], until: source.pausedUntil };
    if (!source.releasesEnabled)
      return { state: 'exit-releases-closed', title: 'The committee has closed releases', body: `Releases on ${route.name} are switched off by the committee (5 of 7). Your exit of ${amount} stays payable and is paid when they are switched on again. Nothing to do.`, tone: 'warn', step: 2, steps, actions: [] };
    if (source.available < burn.amount)
      return { state: 'exit-waiting-limit', title: 'Waiting for the daily release limit', body: `At most ${formatAmount(route.limits.window, route.l2.decimals)} ${route.asset.symbol} leaves the vault per ${plainTime(route.limits.windowSeconds).replace('about ', '')}. The limit has ${formatAmount(source.available, route.l2.decimals)} left now and refills steadily; your exit of ${amount} is paid when it fits. Nothing to do.`, tone: 'wait', step: 2, steps, actions: [] };
    return waitingCommittee();
  }

  if (source.kind === 'solana') {
    if (source.paidBit || source.record?.state === 'paid')
      return paid(`The vault paid this exit to the USDC account of ${to}${source.record ? `: ${formatAmount(source.record.paidAmount, route.l2.decimals)} USDC` : ''}.${named}`);
    const latch = canRedirect
      ? ' A held burn stays held for good, even if the address changes later; only you, the account that burned, can release it, by naming a wallet you control with "Send to another address". There is no refund.'
      : ' There is no refund path today.';
    // The exit's own proof, checked by the page as every signer checks it: without a valid one the burn is held.
    if (burn.viaRouter && burn.proof && !burn.proof.valid && !burn.recipientOriginal)
      return {
        state: 'exit-held-no-proof',
        title: 'Held: no valid proof from the destination wallet',
        body: `The exit router published this burn of ${amount} with a destination proof that does not check (${burn.proof.reason}). Every signer checks it the same way and HOLDS such a burn: it is not certified, approved or paid.${latch} This is this page's own reading; the signers' decision is not written on any chain.`,
        tone: 'danger',
        step: 1,
        steps,
        actions: redirectAction,
      };
    if (source.destination === 'not-a-wallet')
      return {
        state: 'exit-held',
        title: 'Held: the destination is not a wallet',
        body: `On Solana the address ${to} exists and is not a plain wallet (it is owned by a program, or holds data). The signers read the same and HOLD such a burn: it is not certified, approved or paid.${latch}${named} This is this page's own reading of Solana; the signers' decision is theirs and is not written on any chain.`,
        tone: 'danger',
        step: 1,
        steps,
        actions: burn.recipientOriginal ? [] : redirectAction,
      };
    const record = source.record;
    if (record && record.seq <= source.voidThroughSeq)
      return {
        state: 'exit-voided-by-pause',
        title: 'Approval voided by a pause; waiting for the committee again',
        body: `A guardian pause voided the approval of this exit before it was paid. Nothing is lost: the burn is final on the L2 and the committee certifies it again after the pause${source.pausedUntil > now ? ` (until ${at(source.pausedUntil)})` : ''}; it is then approved and paid once. Nothing to do.`,
        tone: 'warn',
        step: 1,
        steps,
        actions: [],
        until: source.pausedUntil > now ? source.pausedUntil : undefined,
      };
    if (!record) {
      if (source.pausedUntil > now)
        return { state: 'exit-vault-paused', title: 'The vault on Solana is paused', body: `A guardian paused the vault until ${at(source.pausedUntil)}. Your exit of ${amount} is certified and approved after the pause. Nothing to do.`, tone: 'warn', step: 1, steps, actions: [], until: source.pausedUntil };
      return waitingCommittee(source.tokenAccount ? '' : ` The wallet ${to} has no USDC token account yet: create it now, the payment needs it.`);
    }
    // approved
    if (source.pausedUntil > now)
      return { state: 'exit-vault-paused', title: 'Approved; the vault on Solana is paused', body: `A guardian paused the vault until ${at(source.pausedUntil)}. A pause voids approvals that are not yet paid; the committee then certifies this exit again. Nothing is lost and there is nothing to do.`, tone: 'warn', step: 2, steps, actions: [], until: source.pausedUntil };
    if (record.readyAt > now)
      return { state: 'exit-approved-waiting-delay', title: `Approved; payable in ${left(record.readyAt, now)}`, body: `Step one of two is done: the vault recorded the committee's approval. An exit above ${formatAmount(route.solana!.policy.largeReleaseThreshold, route.l2.decimals)} USDC waits ${plainTime(route.solana!.policy.releaseDelaySeconds).replace('about ', '')} before step two, the payment; this one is payable at ${at(record.readyAt)}.`, tone: 'wait', step: 2, steps, actions: [], until: record.readyAt };
    if (!source.tokenAccount)
      return {
        state: 'exit-approved-no-token-account',
        title: 'Approved; your wallet has no USDC account yet',
        body: `The payment goes to the USDC associated token account of ${to}, which does not exist. Relayers do not create it. Create it from your wallet (receiving any USDC creates it, or use your wallet's "add token"); the approval stays payable meanwhile.`,
        tone: 'action',
        step: 2,
        steps,
        actions: [{ id: 'create-token-account', label: 'How to create the account', detail: `Create the associated token account of ${to} for the USDC mint ${route.asset.id}; it costs about 0.002 SOL of rent.` }],
      };
    if (source.bucket < record.amount)
      return { state: 'exit-waiting-limit', title: 'Approved; waiting for the daily release limit', body: `At most ${formatAmount(route.limits.window, route.l2.decimals)} USDC leaves the vault per ${plainTime(route.limits.windowSeconds).replace('about ', '')}. The limit refills steadily; this exit is paid when it fits. The approval does not expire.`, tone: 'wait', step: 2, steps, actions: [] };
    return {
      state: 'exit-approved-payable',
      title: 'Approved; payable now',
      body: 'Step one of two is done. Step two, the payment, needs no signature of the committee: a relayer normally sends it within minutes, and anyone may send it, you included.',
      tone: 'action',
      step: 2,
      steps,
      actions: [{ id: 'execute-release', label: 'How to send the payment yourself', detail: `Instruction execute_release of the vault program with your wallet ${to} as its only argument; the payer needs a little SOL. It can only pay your wallet's USDC account.` }],
    };
  }

  if (source.kind === 'stellar') {
    if (source.burnStatus === 2) return paid(`The vault on Stellar paid this exit to ${to}.`);
    if (source.burnStatus === 3)
      return { state: 'exit-held', title: 'Held by the vault', body: `The vault on Stellar holds a release under this burn's nonce that names another burn. That points to a credited mint without a deposit or a disagreement between the vault and the L2; releases wait until the operators resolve it. Your burn is final on the L2. Nothing to do; this is not a refusal of your exit.`, tone: 'danger', step: 1, steps, actions: [] };
    const trust: StatusAction[] =
      source.trustline === 'no-trustline' || source.trustline === 'no-account'
        ? [{ id: 'add-trustline', label: 'How to add the trustline', detail: `${source.trustline === 'no-account' ? 'Fund the account first (it does not exist on Stellar), then a' : 'A'}dd a trustline to USDC of the issuer named in the route details, from your Stellar wallet.` }]
        : [];
    const trustText =
      source.trustline === 'no-account'
        ? ` The account ${to} does not exist on Stellar: it cannot be paid until it is funded and trusts USDC.`
        : source.trustline === 'no-trustline'
          ? ` The account ${to} holds no USDC trustline: the payment stays unpaid, and can be retried, until it does.`
          : source.trustline === 'unauthorized'
            ? ' The issuer has revoked this account\'s authorization for USDC: it cannot be paid until the issuer restores it.'
            : '';
    if (source.burnStatus === 1) {
      const voided = source.pending !== null && source.pending.pauseCount !== source.pauseCount;
      if (source.pausedUntil > now || voided)
        return { state: 'exit-voided-by-pause', title: 'Queue voided by a pause; waiting for the committee again', body: `A guardian paused the Stellar vault${source.pausedUntil > now ? ` until ${at(source.pausedUntil)}` : ''}. A pause voids every queued release; the committee certifies this exit again by itself afterwards and it waits the queue again. It is not lost. Nothing to do.${trustText}`, tone: 'warn', step: 1, steps, actions: trust, until: source.pausedUntil > now ? source.pausedUntil : undefined };
      if (source.pending && source.pending.readyAt > now)
        return { state: 'exit-queued', title: `Certified; in the release queue for ${left(source.pending.readyAt, now)}`, body: `Every exit waits ${plainTime(route.limits.releaseDelaySeconds).replace('about ', '')} in the vault's queue. This one can be paid at ${at(source.pending.readyAt)}. A guardian pause before that voids the queue and the wait starts again after re-certification.${trustText}`, tone: 'wait', step: 2, steps, actions: trust, until: source.pending.readyAt };
      return { state: 'exit-queued-payable', title: source.pending ? 'Certified; payable now' : 'Certified; in the release queue', body: `${source.pending ? 'The queue time is over: anyone may execute the release, and a relayer normally does within minutes.' : `Every exit waits ${plainTime(route.limits.releaseDelaySeconds).replace('about ', '')} in the vault's queue before anyone can pay it.`} A large exit ahead of yours can hold the queue until the daily limit refills.${trustText}`, tone: trust.length ? 'action' : 'wait', step: 2, steps, actions: trust };
    }
    // 0: open. Never released, or voided by a pause; also 0 while a pause lasts.
    if (source.pausedUntil > now)
      return { state: 'exit-vault-paused', title: 'The Stellar vault is paused; waiting for the committee', body: `A guardian paused the vault until ${at(source.pausedUntil)}. Your exit of ${amount} is certified after the pause and then waits the queue. It is not lost. Nothing to do.${trustText}`, tone: 'warn', step: 1, steps, actions: trust, until: source.pausedUntil };
    const base = waitingCommittee(trustText);
    return { ...base, actions: trust, tone: trust.length ? 'action' : 'wait' };
  }

  // bitcoin
  if (source.payment)
    return paid(`The vault paid ${formatAmount(source.payment.sats, 8)} BTC to ${to} in transaction ${source.payment.txid} (${source.payment.confirmations} confirmation${source.payment.confirmations === 1 ? '' : 's'}).`);
  const ceiling = burn.maxFeeRate ?? 0;
  if (source.setAside)
    return { state: 'exit-set-aside', title: 'Set aside by the vault; paid in a later transaction', body: `The vault's last transaction set this burn aside because its fee rate was above your ceiling of ${ceiling} sat/vB. The burn stays owed: it is paid in a later vault transaction at or below your ceiling. Nothing to do.`, tone: 'wait', step: 2, steps, actions: [] };
  if (source.feeEstimate !== null && ceiling > 0 && source.feeEstimate > ceiling)
    return { state: 'exit-waiting-fee-rate', title: 'Waiting for Bitcoin fees to fall', body: `You accepted at most ${ceiling} sat/vB for this payout; the next blocks ask about ${source.feeEstimate} sat/vB. No signer pays the exit above your ceiling, so it waits, with no time limit, and is paid when the market is at or below it. The ceiling cannot be raised afterwards.`, tone: 'warn', step: 2, steps, actions: [] };
  const delay = route.bitcoin && burn.amount > route.bitcoin.policy.largeBurnThreshold ? ` An exit above ${formatAmount(route.bitcoin.policy.largeBurnThreshold, route.l2.decimals)} bBTC waits ${plainTime(route.bitcoin.policy.largeBurnDelaySeconds).replace('about ', '')} first.` : '';
  return { ...waitingCommittee(delay), state: 'exit-payable' };
}

/** A burn the user's wallet sent that is not yet in a finalized L2 block (from the page's own record of the send). */
export function unfinalizedBurnStatus(_route: Route, inBlock: bigint | null, finalized: bigint): Status {
  return {
    state: inBlock === null ? 'exit-burn-sent' : 'exit-burn-not-final',
    title: inBlock === null ? 'Burn sent; not in a block yet' : `Burn in block ${inBlock}; waiting for L2 finality`,
    body: `The committee acts only on a burn in a finalized L2 block (finalized now: ${finalized}). The L2 makes a block when it has work and finalizes it after its proof settles. Do not send the burn again.`,
    tone: 'wait',
    step: inBlock === null ? 0 : 1,
    steps: EXIT_STEPS,
    actions: [],
  };
}
