// New-slot priority fee for L2 user transactions (review A243-11 part b, round-12 task 259).
//
// The L2 settled RPC admits a transaction only when
//
//   gasUsed x effective tip >= charged new storage slots x fresh_slot_price_wei
//
// (bloch-l2-evm docs/MAINNET-RPC-READINESS.md, "Transaction-specific storage price"; the
// mainnet settler installs 200 µBLCH per slot). A wallet's own tip is far below that for a
// first `approve` (one new allowance slot), so the RPC refuses it with
// `sequencer-fee-underpriced` and the user would have to type a fee into the wallet.
//
// The RPC publishes no price or quote method: its exact figures exist only inside that
// refusal, which needs a signed transaction. So the page prices the transaction itself,
// before it asks the wallet, with standard methods the RPC does serve:
//
//   eth_createAccessList  -> the storage keys the call touches, and the gas it used
//   eth_getStorageAt      -> every touched key that reads zero at `latest` MAY be a new slot
//   eth_maxPriorityFeePerGas, eth_getBlockByNumber(latest) -> the published tip and base fee
//
//   maxPriorityFeePerGas = max(published tip, ceil(zeroKeys x price x (1 + margin) / gasUsed))
//   maxFeePerGas         = 2 x base fee + maxPriorityFeePerGas
//
// `gasUsed` is the simulated gas less the access list's own intrinsic cost (2,400 per address
// and 1,900 per key, EIP-2930): the wallet sends no access list, and the RPC measures that
// transaction. The result is a lower bound of its gas, so the tip is never too small for it.
//
// Zero keys are an upper bound of the slots the RPC charges (a new slot is a zero slot the
// transaction leaves non-zero), so the result errs towards a slightly higher tip, never a
// refusal. Two refinements keep the bound close to the RPC's own count:
//   * the launch WBLCH has two slots that a router swap sets and clears again inside the
//     transaction (the router's WBLCH balance and the withdraw latch); they read zero before
//     and after, the RPC does not charge them, and `transientSlots` excludes them;
//   * a new slot costs at least 20,000 gas (SSTORE from zero) and refunds never exceed a
//     fifth of the gas used, so the count is capped at (gasUsed - 21,000) / 16,000. This also
//     bounds the slot part of the tip at price x (1 + margin) / 16,000 per gas (13.75 gwei
//     with the committed policy), whatever a broken RPC answers. The published tip is refused
//     above 15 gwei, so the suggested tip never exceeds 15 gwei (0.0075 BLCH on a
//     500,000-gas swap).
// In headless Chrome against a node applying the RPC's rule from a state trace
// (frontend/integration/browser), a first approve, a first swap and repeat swaps are priced
// for exactly the slots the node measures. The
// price per slot is the network file's `newSlotFee.freshSlotPriceWei` (operator policy, not a
// consensus rule): if the operator raises it above that plus the margin, the RPC refuses once
// with its exact figures and the page explains them, as before this module.
//
// Since round 15 the user-transaction candidate of the L2 serves a read-only quote,
// `bloch_admissionQuote(call)` (agents/R15-CROSS-AREA.md, 2026-11-11 01:15 UTC, bloch-l2-evm
// 24a116e): the node executes the call as the sender's next transaction and answers with the
// figures a refusal would carry (`requiredPriorityFeePerGas`, `chargedFreshSlots`, `gasUsed`,
// …). The node's answer never wins alone (review R309-2P-2, coordinator decision): the page
// always makes its own access-list computation, and when the RPC also serves a quote the
// suggestion is the LARGER of the two, inside the same absolute bound (15 gwei of tip). The
// two must agree within a factor of two: a quote above twice the page's figure, or a quote
// that charges slots where the page's upper bound finds none, sends nothing. A quote that
// charges no slot does not lower the page's own figure. So an RPC can raise the suggestion
// to at most twice the page's bound and can never lower it; the quote protects against an
// operator price above the network file's. When the RPC serves no quote (the launch release,
// a gateway without the route, no admission policy, a sender whose balance the quote
// refuses, an answer that contradicts itself), the access-list figure stands alone.
//
// The candidate's per-sender credit rule (bloch-l2-evm 1b55ce1 to e8f40c2, docs/SEQUENCER-POLICY-V2.md
// "For wallets"): a wallet that has paid for no L2 transaction yet gets calls up to a gas limit of
// 1,500,000 executed, nobody more than 5,000,000. The page's own limits are below that (approve
// 100,000, skim 200,000, 250,000 per hop and at most four hops: test/RouteGas.t.sol), so its
// calls never need credit. The quote carries the node's verdict; when it says the call would not
// be executed nothing is sent and the text says what helps (a smaller route, or one plain
// transfer first, priced for the tip the page would send the call with). A higher fee never
// helps there and is never suggested. For a wallet without credit whose call is executable, the
// note adds that in full blocks one plain transfer first avoids waiting. The launch RPC has
// neither the method nor the fields: nothing changes there.
//
// With no possible new slot, or with the policy off, the wallet request is unchanged and the
// wallet picks the fee. The fee fields are a suggestion to the wallet: a wallet that ignores
// them behaves as before.
import { encodeAbiParameters, formatGwei, keccak256, type Address, type Hex } from 'viem';
import type { Rpc } from '../devnet4/chain';

/** Mainnet settler policy `fresh_slot_price_wei`: 200 µBLCH per new storage slot. */
export const DEFAULT_FRESH_SLOT_PRICE_WEI = 200n * 10n ** 12n;
/** Above 0.01 BLCH per slot the network file is refused: a typo must not drain a wallet. */
export const MAX_FRESH_SLOT_PRICE_WEI = 10n ** 16n;
/** Policy `fresh_slots_per_block`: no admissible transaction creates more. */
export const MAX_NEW_SLOTS = 128n;
/** Gas used at inclusion can be lower than simulated (a slot written meanwhile, refunds). */
export const DEFAULT_MARGIN_BPS = 1_000;
export const MAX_MARGIN_BPS = 5_000;
/** Above this many touched keys every key counts as new instead of being read one by one. */
export const MAX_STORAGE_READS = 48;
/** The published tip is refused above this: a broken RPC must not set an absurd fee. The sequencer's
 * congestion tip tops out at 3 gwei (owner decision of 2026-11-02); this is five times that, and
 * it is the bound of the whole suggestion together with the slot bound below (review R309-A3). */
export const MAX_PUBLISHED_TIP_WEI = 15n * 10n ** 9n;
const INTRINSIC_GAS = 21_000n;
/** EIP-2930 intrinsic gas of an access list entry. */
const ACCESS_LIST_ADDRESS_GAS = 2_400n;
const ACCESS_LIST_KEY_GAS = 1_900n;
/** SSTORE of a non-zero value into a zero slot is 20,000 gas; four fifths of it survive any refund. */
const NEW_SLOT_GAS_AFTER_REFUNDS = 16_000n;
/** A base fee above this is refused: the wallet would have to reserve an absurd balance. */
export const MAX_BASE_FEE_WEI = 1_000n * 10n ** 9n;

export type NewSlotFeePolicy = { enabled: boolean; freshSlotPriceWei: bigint; marginBps: number };
export const NEW_SLOT_FEE_OFF: NewSlotFeePolicy = {
  enabled: false,
  freshSlotPriceWei: DEFAULT_FRESH_SLOT_PRICE_WEI,
  marginBps: DEFAULT_MARGIN_BPS,
};

export type PricedCall = { from: Address; to: Address; data: Hex; value: bigint; gas: bigint };
export type FeeFields = { maxPriorityFeePerGas: bigint; maxFeePerGas: bigint };
export type NewSlotFee = FeeFields & {
  /** `quote`: the node's own figures (bloch_admissionQuote). `access-list`: the page's upper bound. */
  source: 'quote' | 'access-list';
  /** Touched storage keys that read zero: an upper bound of the slots the RPC charges. With a
   * quote, the slots the node charges. */
  possibleNewSlots: bigint;
  gasUsed: bigint;
  publishedTip: bigint;
  baseFee: bigint;
  /** possibleNewSlots x price: what the sequencer must receive for the new slots, in wei. */
  slotCostWei: bigint;
  /**
   * Set when the node says this wallet has no credit for the call (candidate 28b74c4,
   * `first_transfer_priority_fee_wei`): the priority fee per gas of ONE plain transfer that makes
   * the call covered. Advice only; the call itself is executable.
   */
  firstTransferTip?: bigint;
};

/** Storage keys, by lowercase contract address, that a transaction sets and clears again. */
export type TransientSlots = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * The launch WBLCH (contracts/assets/WBLCH.sol; the page verifies its code hash): slot 1 is
 * `balanceOf`, slot 3 the `withdrawing` latch. The router never keeps WBLCH: a swap credits
 * its balance and moves all of it on in the same transaction, and `withdraw` sets the latch
 * and clears it. If the router does hold WBLCH (someone sent it some), its balance slot is
 * not zero and is not counted anyway.
 */
export function transientSlots(deployment: { wrapped: Address; router: Address }): TransientSlots {
  const routerBalance = keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [deployment.router, 1n]),
  );
  const latch = `0x${'3'.padStart(64, '0')}`;
  return new Map([
    [deployment.wrapped.toLowerCase(), new Set([routerBalance.toLowerCase(), latch])],
  ]);
}

export class NewSlotFeeError extends Error {}
/** The node would not execute the call (credit rule); carries what the text is made of. */
class NotExecutableError extends NewSlotFeeError {
  // Plain fields, no parameter properties: this file is also loaded by Node with its types stripped.
  readonly reply: Record<string, unknown>;
  readonly requiredTip: bigint | null;
  constructor(reply: Record<string, unknown>, requiredTip: bigint | null) {
    super(notExecutableText(reply));
    this.reply = reply;
    this.requiredTip = requiredTip;
  }
}
function notExecutableText(reply: Record<string, unknown>, transferTip?: bigint): string {
  const said = creditRefusalText(reply.not_executable_reason, reply, transferTip);
  return `${said ?? `The L2 reports that it would not execute this transaction (${String(reply.not_executable_reason).slice(0, 60)}). A higher fee is not known to help.`} Nothing was sent.`;
}
function refuse(condition: unknown, message: string): asserts condition {
  if (!condition) throw new NewSlotFeeError(message);
}

/** Read the optional `newSlotFee` block of the network file; absent means off. */
export function parseNewSlotFeePolicy(value: unknown, field = 'newSlotFee'): NewSlotFeePolicy {
  if (value === undefined || value === null) return NEW_SLOT_FEE_OFF;
  refuse(typeof value === 'object' && !Array.isArray(value), `${field} must be an object`);
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v))
    refuse(
      ['enabled', 'freshSlotPriceWei', 'marginBps'].includes(key),
      `${field}.${key} is not known`,
    );
  refuse(typeof v.enabled === 'boolean', `${field}.enabled must be true or false`);
  const price = v.freshSlotPriceWei ?? DEFAULT_FRESH_SLOT_PRICE_WEI.toString();
  refuse(
    typeof price === 'string' && /^[1-9][0-9]{0,17}$/.test(price),
    `${field}.freshSlotPriceWei must be a positive decimal string of wei`,
  );
  refuse(
    BigInt(price) <= MAX_FRESH_SLOT_PRICE_WEI,
    `${field}.freshSlotPriceWei is above ${MAX_FRESH_SLOT_PRICE_WEI} wei (0.01 BLCH) per slot`,
  );
  const marginBps = v.marginBps ?? DEFAULT_MARGIN_BPS;
  refuse(
    Number.isSafeInteger(marginBps) &&
      (marginBps as number) >= 0 &&
      (marginBps as number) <= MAX_MARGIN_BPS,
    `${field}.marginBps must be an integer from 0 to ${MAX_MARGIN_BPS}`,
  );
  return { enabled: v.enabled, freshSlotPriceWei: BigInt(price), marginBps: marginBps as number };
}

/** ceil(slots x price x (10000 + marginBps) / (gasUsed x 10000)). */
export function slotTipFor(
  slots: bigint,
  gasUsed: bigint,
  priceWei: bigint,
  marginBps: number,
): bigint {
  if (slots <= 0n) return 0n;
  refuse(gasUsed > 0n, 'gas used must be positive');
  const numerator = slots * priceWei * (10_000n + BigInt(marginBps));
  const denominator = gasUsed * 10_000n;
  return (numerator + denominator - 1n) / denominator;
}

function quantity(value: unknown, field: string): bigint {
  refuse(
    typeof value === 'string' && /^0x(0|[1-9a-f][0-9a-f]{0,63})$/i.test(value),
    `the L2 RPC returned no ${field}`,
  );
  return BigInt(value);
}
const hex = (value: bigint) => `0x${value.toString(16)}`;

export type CreditRefusalKind = 'needs-credit' | 'gas-limit-above-cap';
const count = (value: unknown): bigint | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? BigInt(value)
    : typeof value === 'string' && /^(0|[1-9][0-9]{0,40})$/.test(value)
      ? BigInt(value)
      : null;

/**
 * What the L2's per-sender credit rule refuses (bloch-l2-evm 1b55ce1, docs/SEQUENCER-POLICY-V2.md
 * section 6), said for a user. A wallet that has paid for no L2 transaction yet ("without credit")
 * gets plain transfers and calls up to `uncovered_max_gas`; nobody gets more than `max_tx_gas`.
 * For both refusals a higher fee does NOT help, and the text never suggests one. Null: the data is
 * not one of the two refusals.
 */
export function creditRefusalText(
  kind: unknown,
  data: Record<string, unknown>,
  /** The transfer fee to name instead of the node's: the node's figures are for one exact tip, the page's own
   * tip can be higher (its margin, its own upper bound of the slots). */
  transferTipOverride?: bigint,
): string | null {
  const gas = count(data.gas_limit);
  if (kind === 'gas-limit-above-cap' || kind === 'sequencer-gas-limit-above-cap') {
    const cap = count(data.max_tx_gas);
    return `The L2 does not take this transaction: its gas limit${gas === null ? '' : ` of ${gas}`} is above the L2's maximum${cap === null ? '' : ` of ${cap}`} for one transaction. A higher fee does not help. Use a smaller route (fewer hops).`;
  }
  if (kind === 'needs-credit' || kind === 'sequencer-needs-credit') {
    const limit = count(data.uncovered_max_gas);
    const needed = count(data.credit_needed_wei);
    const stated = count(data.first_transfer_priority_fee_wei);
    const exact =
      stated !== null && stated > 0n
        ? stated
        : needed === null || needed === 0n
          ? null
          : (needed + 20_999n) / 21_000n;
    const transferTip =
      transferTipOverride !== undefined && (exact === null || transferTipOverride > exact)
        ? transferTipOverride
        : exact;
    return `The L2 does not take this transaction from a wallet that has not paid for an L2 transaction yet: its gas limit${gas === null ? '' : ` of ${gas}`} is above the${limit === null ? ' limit' : ` ${limit}`} the L2 allows such a wallet for one call. A higher fee does not help. What helps: a smaller route (fewer hops), or one earlier transaction from this wallet, because every included transaction earns credit${transferTip === null ? '' : ` (one plain transfer with a priority fee of ${transferTip} wei per gas earns enough in one step)`}.`;
  }
  return null;
}

export const ADMISSION_QUOTE_METHOD = 'bloch_admissionQuote';
/** The node's quote may exceed the page's own figure by at most this factor; beyond it nothing is sent. */
export const QUOTE_DISAGREEMENT_FACTOR = 2n;

/**
 * The node's own admission quote for one call, or undefined when this RPC does not serve one
 * for it (method unknown, no admission policy, the sender's balance, busy, or an answer that
 * does not hold together): the caller then prices with the access list. Null: the node charges
 * no new slot, the wallet picks the fee. Throws only when the node's requirement is outside
 * the page's bounds, where falling back to a lower figure would be refused by the node anyway.
 */
export async function quoteNewSlots(
  rpc: Rpc,
  tx: PricedCall,
  policy: NewSlotFeePolicy,
): Promise<NewSlotFee | null | undefined> {
  let reply: Record<string, unknown> = {};
  let figures: Record<string, bigint> | undefined;
  let notExecutable: Record<string, unknown> | undefined;
  try {
    const answer = await rpc(ADMISSION_QUOTE_METHOD, [
      { from: tx.from, to: tx.to, data: tx.data, value: hex(tx.value), gas: hex(tx.gas) },
    ]);
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return undefined;
    reply = answer as Record<string, unknown>;
    if (reply.kind !== 'sequencer-admission-quote' || reply.scope !== 'latest-state-next-block')
      return undefined;
    // The credit rule (candidate 1b55ce1): the node says whether it would execute this call at all. Read before
    // the fee figures, and never turned into a fallback: the access list knows nothing about credit.
    if (reply.executable === false) notExecutable = reply;
    figures = Object.fromEntries(
      [
        'baseFeePerGas',
        'requiredPriorityFeePerGas',
        'requiredMaxFeePerGas',
        'minimumPriorityFeePerGas',
        'gasUsed',
        'freshSlots',
        'chargedFreshSlots',
        'freshSlotPriceWei',
      ].map((name) => [name, quantity(reply[name], name)]),
    );
  } catch {
    if (!notExecutable) return undefined;
  }
  if (notExecutable)
    throw new NotExecutableError(notExecutable, figures?.requiredPriorityFeePerGas ?? null);
  const q = figures!;
  // An answer that contradicts itself is not a quote: use the access list.
  if (
    q.gasUsed < INTRINSIC_GAS ||
    q.gasUsed > tx.gas ||
    q.chargedFreshSlots > q.freshSlots ||
    q.freshSlots > MAX_NEW_SLOTS ||
    q.requiredPriorityFeePerGas < q.minimumPriorityFeePerGas ||
    q.requiredMaxFeePerGas !== q.requiredPriorityFeePerGas + q.baseFeePerGas ||
    q.requiredPriorityFeePerGas * q.gasUsed < q.chargedFreshSlots * q.freshSlotPriceWei
  )
    return undefined;
  if (q.chargedFreshSlots === 0n) return null;
  refuse(
    q.baseFeePerGas <= MAX_BASE_FEE_WEI,
    `the L2 RPC reports a base fee of ${formatGwei(q.baseFeePerGas)} gwei, above ${formatGwei(MAX_BASE_FEE_WEI)} gwei`,
  );
  refuse(
    q.minimumPriorityFeePerGas <= MAX_PUBLISHED_TIP_WEI,
    `the L2 RPC asks a ${formatGwei(q.minimumPriorityFeePerGas)} gwei priority fee, above ${formatGwei(MAX_PUBLISHED_TIP_WEI)} gwei`,
  );
  // The margin covers a head that moves between the quote and the signature.
  const withMargin =
    (q.requiredPriorityFeePerGas * (10_000n + BigInt(policy.marginBps)) + 9_999n) / 10_000n;
  refuse(
    withMargin <= MAX_PUBLISHED_TIP_WEI,
    `the L2 asks a priority fee of ${formatGwei(q.requiredPriorityFeePerGas)} gwei for this transaction's new storage slots, above the ${formatGwei(MAX_PUBLISHED_TIP_WEI)} gwei this page will suggest; nothing was sent`,
  );
  const maxPriorityFeePerGas =
    withMargin > q.minimumPriorityFeePerGas ? withMargin : q.minimumPriorityFeePerGas;
  const firstTransferTip =
    reply.covered === false ? count(reply.first_transfer_priority_fee_wei) : null;
  return {
    ...(firstTransferTip !== null && firstTransferTip > 0n ? { firstTransferTip } : {}),
    source: 'quote',
    maxPriorityFeePerGas,
    maxFeePerGas: 2n * q.baseFeePerGas + maxPriorityFeePerGas,
    possibleNewSlots: q.chargedFreshSlots,
    gasUsed: q.gasUsed,
    publishedTip: q.minimumPriorityFeePerGas,
    baseFee: q.baseFeePerGas,
    slotCostWei: q.chargedFreshSlots * q.freshSlotPriceWei,
  };
}

/**
 * Price one L2 transaction, or null when it can create no new slot (the wallet then picks
 * the fee as before). Throws when the RPC cannot price it or the call would revert: the
 * caller sends nothing, because an unpriced first approve is refused by the RPC and leaves a
 * submission with an unknown outcome.
 */
export async function priceNewSlots(
  rpc: Rpc,
  tx: PricedCall,
  policy: NewSlotFeePolicy,
  transient: TransientSlots = new Map(),
): Promise<NewSlotFee | null> {
  if (!policy.enabled) return null;
  // The node's quote, when it serves one, is combined with the page's own figure; it never replaces it.
  let quoted: NewSlotFee | null | undefined;
  try {
    quoted = await quoteNewSlots(rpc, tx, policy);
  } catch (error) {
    if (!(error instanceof NotExecutableError)) throw error;
    // Nothing is sent. The access list is read only to name the plain transfer that would cover this call at
    // the tip the page would send it with (the larger of its own figure and the node's plus the margin).
    const own = await priceByAccessList(rpc, tx, policy, transient).catch(() => null);
    const withMargin =
      error.requiredTip === null
        ? 0n
        : (error.requiredTip * (10_000n + BigInt(policy.marginBps)) + 9_999n) / 10_000n;
    const tip =
      own && own.maxPriorityFeePerGas > withMargin ? own.maxPriorityFeePerGas : withMargin;
    throw new NewSlotFeeError(
      notExecutableText(error.reply, tip > 0n ? (tx.gas * tip + 20_999n) / 21_000n : undefined),
    );
  }
  const own = await priceByAccessList(rpc, tx, policy, transient);
  if (quoted === undefined || quoted === null) return own;
  refuse(
    own !== null,
    `the L2 charges ${quoted.possibleNewSlots} new storage slot(s) for this transaction, but the page finds none it could create; nothing was sent`,
  );
  refuse(
    quoted.maxPriorityFeePerGas <= QUOTE_DISAGREEMENT_FACTOR * own.maxPriorityFeePerGas,
    `the L2 asks a priority fee of ${formatGwei(quoted.maxPriorityFeePerGas)} gwei, more than ${QUOTE_DISAGREEMENT_FACTOR} times the ${formatGwei(own.maxPriorityFeePerGas)} gwei the page computes for this transaction; nothing was sent`,
  );
  // The node's transfer figure is for its exact tip; the call is sent at the page's tip, so the transfer that
  // covers it is priced for that tip (the wallet's present credit is ignored: slightly more than needed).
  const firstTransfer = (tip: bigint) => {
    if (quoted.firstTransferTip === undefined) return {};
    const own = (tx.gas * tip + 20_999n) / 21_000n;
    return { firstTransferTip: own > quoted.firstTransferTip ? own : quoted.firstTransferTip };
  };
  if (quoted.maxPriorityFeePerGas <= own.maxPriorityFeePerGas)
    return { ...own, ...firstTransfer(own.maxPriorityFeePerGas) };
  // The node asks more than the page's bound (an operator price above the network file's): its
  // tip, on the larger of the two base fees.
  const baseFee = quoted.baseFee > own.baseFee ? quoted.baseFee : own.baseFee;
  return {
    ...quoted,
    baseFee,
    maxFeePerGas: 2n * baseFee + quoted.maxPriorityFeePerGas,
    ...firstTransfer(quoted.maxPriorityFeePerGas),
  };
}

/** The page's own figure: an upper bound of the slots, a lower bound of the gas. */
async function priceByAccessList(
  rpc: Rpc,
  tx: PricedCall,
  policy: NewSlotFeePolicy,
  transient: TransientSlots,
): Promise<NewSlotFee | null> {
  const call = { from: tx.from, to: tx.to, data: tx.data, value: hex(tx.value), gas: hex(tx.gas) };
  const reply = (await rpc('eth_createAccessList', [call, 'latest'])) as {
    accessList?: unknown;
    gasUsed?: unknown;
    error?: unknown;
  } | null;
  refuse(reply && Array.isArray(reply.accessList), 'the L2 RPC returned no access list');
  refuse(
    reply.error === undefined || reply.error === null,
    'this transaction would fail if sent now, so nothing was sent',
  );
  const keys: [string, string][] = [];
  for (const item of reply.accessList as { address?: unknown; storageKeys?: unknown }[]) {
    refuse(
      item && typeof item.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(item.address),
      'the L2 RPC returned a malformed access list',
    );
    refuse(Array.isArray(item.storageKeys), 'the L2 RPC returned a malformed access list');
    for (const key of item.storageKeys as unknown[]) {
      refuse(
        typeof key === 'string' && /^0x[0-9a-fA-F]{64}$/.test(key),
        'the L2 RPC returned a malformed access list',
      );
      if (!transient.get(item.address.toLowerCase())?.has(key.toLowerCase()))
        keys.push([item.address, key]);
    }
  }
  const simulated = quantity(reply.gasUsed, 'simulated gas');
  refuse(
    simulated >= INTRINSIC_GAS && simulated <= tx.gas,
    `the simulated gas (${simulated}) is outside 21000 to the gas limit ${tx.gas}`,
  );
  const listed = (reply.accessList as { storageKeys: unknown[] }[]).reduce(
    (n, item) => n + item.storageKeys.length,
    0,
  );
  const listGas =
    ACCESS_LIST_ADDRESS_GAS * BigInt(reply.accessList.length) +
    ACCESS_LIST_KEY_GAS * BigInt(listed);
  const gasUsed = simulated - listGas > INTRINSIC_GAS ? simulated - listGas : INTRINSIC_GAS;
  let possibleNewSlots = BigInt(keys.length);
  if (keys.length > 0 && keys.length <= MAX_STORAGE_READS) {
    const words = await Promise.all(
      keys.map(([address, key]) => rpc('eth_getStorageAt', [address, key, 'latest'])),
    );
    possibleNewSlots = 0n;
    for (const word of words) {
      refuse(
        typeof word === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(word),
        'the L2 RPC returned no storage word',
      );
      if (BigInt(word) === 0n) possibleNewSlots += 1n;
    }
  }
  // Each new slot costs the transaction itself at least 20,000 gas (SSTORE from zero), and
  // refunds are at most a fifth of the gas used. Counting no more slots than the gas left
  // after the 21,000 intrinsic can pay at 16,000 each also bounds the tip, whatever the RPC
  // answers: at most price x (1 + margin) / 16,000 per gas.
  const byGas = (gasUsed - INTRINSIC_GAS) / NEW_SLOT_GAS_AFTER_REFUNDS;
  if (possibleNewSlots > byGas) possibleNewSlots = byGas;
  if (possibleNewSlots === 0n) return null;
  refuse(
    possibleNewSlots <= MAX_NEW_SLOTS,
    `this transaction may create ${possibleNewSlots} new storage slots; the L2 takes at most ${MAX_NEW_SLOTS} in one transaction`,
  );
  const publishedTip = quantity(await rpc('eth_maxPriorityFeePerGas', []), 'priority fee');
  refuse(
    publishedTip <= MAX_PUBLISHED_TIP_WEI,
    `the L2 RPC asks a ${formatGwei(publishedTip)} gwei priority fee, above ${formatGwei(MAX_PUBLISHED_TIP_WEI)} gwei`,
  );
  const block = (await rpc('eth_getBlockByNumber', ['latest', false])) as {
    baseFeePerGas?: unknown;
  } | null;
  refuse(block, 'the latest L2 block could not be read');
  const baseFee = quantity(block.baseFeePerGas, 'base fee');
  refuse(
    baseFee <= MAX_BASE_FEE_WEI,
    `the L2 RPC reports a base fee of ${formatGwei(baseFee)} gwei, above ${formatGwei(MAX_BASE_FEE_WEI)} gwei`,
  );
  const slotTip = slotTipFor(possibleNewSlots, gasUsed, policy.freshSlotPriceWei, policy.marginBps);
  const maxPriorityFeePerGas = slotTip > publishedTip ? slotTip : publishedTip;
  // The absolute bound holds whatever the network file's price and margin are (review R309-2P-6).
  refuse(
    maxPriorityFeePerGas <= MAX_PUBLISHED_TIP_WEI,
    `this transaction would need a priority fee of ${formatGwei(maxPriorityFeePerGas)} gwei for its new storage slots, above the ${formatGwei(MAX_PUBLISHED_TIP_WEI)} gwei this page will suggest; nothing was sent`,
  );
  return {
    source: 'access-list',
    maxPriorityFeePerGas,
    maxFeePerGas: 2n * baseFee + maxPriorityFeePerGas,
    possibleNewSlots,
    gasUsed,
    publishedTip,
    baseFee,
    slotCostWei: possibleNewSlots * policy.freshSlotPriceWei,
  };
}

/** What the page says while the wallet is open; empty when the wallet picks the fee. */
export function newSlotFeeNote(fee: NewSlotFee | null): string {
  if (!fee) return '';
  // A wallet without credit (docs/SEQUENCER-POLICY-V2.md of the L2, "For wallets"): in a full block its first
  // call comes after every plain transfer of such wallets, at any fee. Never "raise the fee".
  const first =
    fee.firstTransferTip === undefined
      ? ''
      : `This wallet has not paid for an L2 transaction yet. If L2 blocks are full, its first call can wait whatever fee it offers; one plain transfer first (to your own address is enough) with a priority fee of at least ${formatGwei(fee.firstTransferTip)} gwei avoids that.`;
  if (fee.maxPriorityFeePerGas === fee.publishedTip) return first;
  const slots =
    fee.possibleNewSlots === 1n
      ? '1 new storage slot'
      : `${fee.source === 'quote' ? '' : 'up to '}${fee.possibleNewSlots} new storage slots`;
  return (
    `This transaction creates ${slots} on the L2, which the network charges through the priority fee. ` +
    `The page suggests ${formatGwei(fee.maxPriorityFeePerGas)} gwei to your wallet; keep the suggested fee, ` +
    'a lower one is refused by the network.' +
    (first ? ` ${first}` : '')
  );
}
