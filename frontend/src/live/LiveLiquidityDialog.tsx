// The liquidity dialog of a live route: deposit into, or withdraw from, a pool the bundled record lists as open.
// The layout is the preview's dialog (LiquidityDialog.tsx); every figure here is computed from state read at the
// page's pinned block (mainnet/liquidity.ts) and every button is one explicit wallet step through the route's
// one tracker (mainnet/submit.ts): approve exactly the amount, then the deposit or the removal, with explicit
// minimums, the chain's deadline and a comparison with the latest block right before the wallet is asked.
import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { AlertTriangle, LoaderCircle } from 'lucide-react';
import type { Address } from 'viem';
import { formatAmount, parseAmount } from '../amm';
import type { LivePool, Rpc, Snapshot } from '../devnet4/chain';
import type { DevnetDeployment } from '../devnet4/record';
import type { Devnet4Wallet } from '../Devnet4Live';
import { approvalPlan, type ApprovalStep, type ApprovalToken } from '../mainnet/approval';
import {
  DEFAULT_DEADLINE_MINUTES,
  MAX_DEADLINE_MINUTES,
  MAX_SLIPPAGE_BPS,
  MIN_DEADLINE_MINUTES,
  swapClock,
  type MainnetNetwork,
} from '../mainnet/config';
import {
  belowMinimum,
  evaluateAdd,
  evaluateRemove,
  positionOf,
  quoteAdd,
  quoteRemove,
  readPoolShares,
  readPoolState,
  refusalText,
  sharePercentText,
  sharesForPercent,
  type Refusal,
} from '../mainnet/liquidity';
import { addLiquidityTransaction, removeLiquidityTransaction } from '../mainnet/liquidity-tx';
import type { usePendingSwap } from '../mainnet/pendingswap';
import { submitTracked, type TrackedRequest } from '../mainnet/submit';
import { settledCapital, wording } from '../mainnet/wording';
import { TokenMark } from '../marks/TokenMark';
import type { TokenFact } from '../multichain/token-facts';
import { isAllowedSlippageBps } from '../slippage';
import { Disclosure } from '../ui/Disclosure';
import { Modal } from '../ui/Modal';
import { monotonicMs, staleAt } from '../ui/snapshot-renewal';
import { LiquidityRisks } from './LiquidityRisks';
import { TrackedStatus, type ConfirmationFacts } from './TrackedStatus';
import type { PoolLiquidity } from './useLiquidity';

/** The snapshot's age bound on a public network (the same object the swap card is given). */
export type LiveFreshness = {
  maxAgeMs: number;
  ageMs: () => number;
  activity: MutableRefObject<{ editedAt: number; quoteOnScreen: boolean }>;
  renew: () => void;
};

export type LiquidityMode = 'add' | 'remove';

/** The name the page shows for a pool side: the native coin for the wrapped native token. */
export const sideName = (pool: LivePool, side: 0 | 1): string => {
  const token = side === 0 ? pool.token0 : pool.token1;
  return token.wrapped ? wording.native : token.symbol;
};
export const poolName = (pool: LivePool): string => `${pool.token0.symbol}/${pool.token1.symbol}`;

const approvalToken = (pool: LivePool, side: 0 | 1): ApprovalToken => {
  const token = side === 0 ? pool.token0 : pool.token1;
  return {
    address: token.address,
    label: token.symbol,
    decimals: token.decimals,
    // The token list's statement that approve refuses a change of a non-zero allowance (agent 409's field on the
    // record's token; absent on this line, where no listed token needs it).
    zeroFirst: (token as { approveZeroFirst?: boolean }).approveZeroFirst === true,
  };
};

const stepLabel = (step: ApprovalStep): string =>
  step.kind === 'reset'
    ? `Reset the ${step.token.label} allowance to zero`
    : `Approve ${formatAmount(step.amount, step.token.decimals)} ${step.token.label}`;

export function LiveLiquidityDialog({
  mode,
  item,
  network,
  deployment: d,
  snapshot,
  rpc,
  wallet,
  now,
  pendingSwap,
  confirmation,
  receiptPollMs,
  freshness,
  busyRef,
  facts,
  initialSlippage,
  onMode,
  onActivity,
  onClose,
}: {
  mode: LiquidityMode;
  /** The pool with its figures at the snapshot block; null while they are being read again. */
  item: PoolLiquidity | null;
  network: MainnetNetwork;
  deployment: DevnetDeployment;
  snapshot: Snapshot;
  rpc: Rpc;
  wallet: Devnet4Wallet;
  now: () => number;
  pendingSwap: ReturnType<typeof usePendingSwap>;
  confirmation?: ConfirmationFacts;
  receiptPollMs?: number;
  freshness?: LiveFreshness;
  /** Told while a wallet request of this dialog is in flight, so a timed snapshot renewal waits. */
  busyRef?: MutableRefObject<boolean>;
  facts: TokenFact[];
  /** The page's slippage setting when the dialog opens (the swap card's, or the default). */
  initialSlippage: string;
  onMode: (mode: LiquidityMode) => void;
  onActivity: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState<{ side: 0 | 1; text: string }>({ side: 0, text: '' });
  const [percent, setPercent] = useState(25);
  const [slippage, setSlippage] = useState(initialSlippage);
  const [deadline, setDeadline] = useState(
    String(network.defaultDeadlineMinutes ?? DEFAULT_DEADLINE_MINUTES),
  );
  const [note, setNote] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped on every change of the form: a send that started under an older value is dropped.
  const formGeneration = useRef(0);
  const currentWallet = useRef(wallet);
  currentWallet.current = wallet;
  const currentBlock = useRef(snapshot.finalized.hash);
  currentBlock.current = snapshot.finalized.hash;
  useEffect(() => {
    if (!busyRef) return;
    busyRef.current = busy;
    return () => {
      busyRef.current = false;
    };
  }, [busy, busyRef]);
  const edited = () => {
    formGeneration.current++;
    setNote(null);
    // The background renewal of the snapshot waits while the user is typing (ui/snapshot-renewal.ts).
    if (freshness) freshness.activity.current.editedAt = monotonicMs();
  };

  const title = mode === 'add' ? 'Add liquidity' : 'Remove liquidity';
  if (!item)
    return (
      <Modal title={title} onClose={onClose}>
        <p className="muted" role="status">
          <LoaderCircle size={16} className="spin" aria-hidden="true" /> Reading the pool at the{' '}
          {wording.settled} block…
        </p>
      </Modal>
    );
  const { pool, state, shares, account } = item;
  const pair = d.pairs.find((p) => p.address === pool.address)!;
  const names = [sideName(pool, 0), sideName(pool, 1)] as const;
  const decimals = [pool.token0.decimals, pool.token1.decimals] as const;
  const show = (amount: bigint, side: 0 | 1) =>
    `${formatAmount(amount, decimals[side])} ${names[side]}`;
  const slippageBps = parseAmount(slippage, 2);
  const slippageValid = slippageBps !== null && isAllowedSlippageBps(slippageBps);
  const deadlineMinutes = /^[0-9]{1,3}$/.test(deadline) ? Number(deadline) : NaN;
  const deadlineValid =
    deadlineMinutes >= MIN_DEADLINE_MINUTES && deadlineMinutes <= MAX_DEADLINE_MINUTES;
  const settingsProblem = !slippageValid
    ? `Use a slippage tolerance of 0.01% to ${(MAX_SLIPPAGE_BPS / 100).toFixed(2)}%.`
    : !deadlineValid
      ? `Use a deadline of ${MIN_DEADLINE_MINUTES} to ${MAX_DEADLINE_MINUTES} minutes.`
      : '';
  const from = wallet.account?.address.toLowerCase() as Address | undefined;
  const onChain = wallet.account ? BigInt(wallet.account.chainId) === BigInt(d.chainId) : false;
  const position = positionOf(state, shares, account?.shares ?? 0n);

  // ---- the deposit ----
  const amount = parseAmount(typed.text, decimals[typed.side]);
  const add =
    mode === 'add' && amount !== null && amount > 0n && slippageValid
      ? quoteAdd(state, shares, { side: typed.side, amount }, Number(slippageBps))
      : null;
  const otherSide = typed.side === 0 ? 1 : 0;
  const otherText =
    add && add.desired0 > 0n && add.desired1 > 0n
      ? formatAmount(otherSide === 0 ? add.desired0 : add.desired1, decimals[otherSide])
      : '';
  // ---- the removal ----
  const liquidity = sharesForPercent(account?.shares ?? 0n, percent);
  const remove =
    mode === 'remove' && account && slippageValid
      ? quoteRemove(state, shares, liquidity, account.shares, Number(slippageBps))
      : null;

  const refusal: Refusal | null =
    add && !add.outcome.ok
      ? add.outcome.refusal
      : remove && !remove.outcome.ok
        ? remove.outcome.refusal
        : null;
  // What the wallet must hold: the desired amounts (the router pulls at most these).
  const short: (0 | 1)[] =
    add && add.outcome.ok && account
      ? ([0, 1] as const).filter(
          (side) =>
            (side === 0 ? add.desired0 : add.desired1) >
            (side === 0 ? account.balance0 : account.balance1),
        )
      : [];
  // One place decides the approve sequence of each token (mainnet/approval.ts); the first step is shown.
  const plan: ApprovalStep[] =
    !from || !account
      ? []
      : add && add.outcome.ok
        ? ([0, 1] as const).flatMap((side) => {
            const allowance = side === 0 ? account.allowance0 : account.allowance1;
            return allowance === null
              ? []
              : approvalPlan(
                  d,
                  approvalToken(pool, side),
                  from,
                  allowance,
                  side === 0 ? add.desired0 : add.desired1,
                );
          })
        : remove && remove.outcome.ok
          ? approvalPlan(
              d,
              { address: pool.address, label: `${poolName(pool)} pool shares`, decimals: 18 },
              from,
              account.sharesAllowance,
              remove.liquidity,
            )
          : [];
  const quoted = (add?.outcome.ok || remove?.outcome.ok) && !settingsProblem;
  const blocked =
    busy ||
    pendingSwap.open ||
    !!pendingSwap.storageProblem ||
    !!pendingSwap.unreadable ||
    !from ||
    !account ||
    !quoted ||
    short.length > 0;
  const stale = () => !!freshness && staleAt(freshness.ageMs(), freshness.maxAgeMs);

  async function send(request: Omit<TrackedRequest, 'build'> & { build: TrackedRequest['build'] }) {
    const provider = wallet.provider;
    if (!provider || !wallet.account) return;
    const generation = formGeneration.current;
    const block = currentBlock.current;
    const result = await submitTracked({
      provider,
      account: wallet.account.address,
      network,
      rpc,
      pendingSwap,
      request,
      now,
      unchanged: () => generation === formGeneration.current && block === currentBlock.current,
      currentWallet: () => ({
        provider: currentWallet.current.provider,
        account: currentWallet.current.account?.address ?? null,
      }),
      onStatus: (text) => setNote({ tone: 'info', text }),
    });
    setNote(result.state === 'tracked' ? null : { tone: 'error', text: result.note });
  }

  /** A figure on a snapshot past the age bound is never signed: the page reads a newer block first. */
  function renewIfStale(): boolean {
    if (!stale()) return false;
    freshness!.renew();
    setNote({
      tone: 'info',
      text: `These figures were older than this page allows before a transaction. They are being read again at a newer ${wording.settled} block; check them and press again.`,
    });
    return true;
  }

  async function approve(step: ApprovalStep) {
    if (blocked || renewIfStale()) return;
    setBusy(true);
    setNote({ tone: 'info', text: 'Confirm in your wallet.' });
    try {
      await send({ label: stepLabel(step), kind: 'approval', deadline: 0n, build: step.build });
    } finally {
      setBusy(false);
    }
  }

  async function act() {
    if (blocked || plan.length > 0 || !from || renewIfStale()) return;
    const generation = formGeneration.current;
    setBusy(true);
    setNote({ tone: 'info', text: 'Comparing with the latest block…' });
    try {
      // The pool may have moved since the pinned block: the same call is evaluated on the latest state (read
      // through the route's RPC, which pins it to a block two endpoints agree on). A refusal there stops here.
      let crossChecked = true;
      try {
        const latest = await readPoolState(rpc, 'latest', pool, d.wrapped);
        const latestShares = await readPoolShares(rpc, 'latest', d, pool.address);
        let refused: Refusal | null = null;
        if (add && add.outcome.ok) {
          const outcome = evaluateAdd(
            latest,
            latestShares,
            add.desired0,
            add.desired1,
            add.min0,
            add.min1,
          );
          if (!outcome.ok) refused = outcome.refusal;
        } else if (remove && remove.outcome.ok) {
          const outcome = evaluateRemove(latest, latestShares, remove.liquidity);
          refused = outcome.ok
            ? belowMinimum(latest, outcome, remove.min0, remove.min1)
            : outcome.refusal;
        }
        if (refused)
          return setNote({
            tone: 'error',
            text: `At the latest block: ${refusalText(refused, names, mode)} Nothing was sent. Refresh the page's figures and review the amounts again.`,
          });
      } catch {
        crossChecked = false;
      }
      if (generation !== formGeneration.current)
        return setNote({ tone: 'error', text: 'The form changed, so nothing was sent.' });
      const head = (await rpc('eth_getBlockByNumber', ['latest', false])) as {
        timestamp?: unknown;
      } | null;
      if (!head || typeof head.timestamp !== 'string' || !/^0x[0-9a-f]+$/i.test(head.timestamp))
        return setNote({
          tone: 'error',
          text: `The latest ${wording.block} could not be read, so nothing was sent.`,
        });
      const clock = swapClock(now(), BigInt(head.timestamp), network.idle, deadlineMinutes);
      if (!clock.ok)
        return setNote({ tone: 'error', text: clock.problem.replace('swap deadline', 'deadline') });
      const until = clock.deadline;
      setNote({
        tone: 'info',
        text: crossChecked
          ? 'Confirm in your wallet.'
          : 'The latest block could not be read, so these figures were not cross-checked. Your minimums still apply on chain. Confirm in your wallet.',
      });
      if (add && add.outcome.ok)
        await send({
          label: `Add liquidity: ${show(add.outcome.amount0, 0)} + ${show(add.outcome.amount1, 1)}`,
          kind: 'liquidity',
          deadline: until,
          build: () => addLiquidityTransaction(d, pair, add, from, until),
        });
      else if (remove && remove.outcome.ok)
        await send({
          label: `Remove liquidity: ${percent}% of ${poolName(pool)} shares`,
          kind: 'liquidity',
          deadline: until,
          build: () => removeLiquidityTransaction(d, pair, remove, from, until),
        });
    } catch (error) {
      setNote({
        tone: 'error',
        text: error instanceof Error ? error.message : 'No wallet request was sent.',
      });
    } finally {
      setBusy(false);
    }
  }

  const step = plan[0];
  const actionLabel = mode === 'add' ? 'Add liquidity' : 'Remove liquidity';
  const next = !wallet.account
    ? 'Next: close this dialog and connect a wallet on the Trade screen.'
    : pendingSwap.open
      ? 'Sending is paused while the transaction below is tracked. It reopens when that one is settled.'
      : busy
        ? 'In progress: the request is being prepared and shown in your wallet.'
        : settingsProblem
          ? `Next: ${settingsProblem}`
          : !quoted
            ? mode === 'add'
              ? 'Next: enter an amount of either token.'
              : position.shares === 0n
                ? 'This account holds no shares of this pool.'
                : 'Next: choose how much to remove.'
            : short.length > 0
              ? 'Next: lower the amount to what the wallet holds.'
              : step
                ? `Step ${1} of ${plan.length + 1}: ${stepLabel(step)} in your wallet. Last step: ${actionLabel}.${onChain ? '' : ` Your wallet is first asked to switch to chain ${d.chainId}.`}`
                : `Next: ${actionLabel} opens your wallet with these figures.${onChain ? '' : ` Your wallet is first asked to switch to chain ${d.chainId}.`}`;

  const amountField = (side: 0 | 1) => (
    <label className="field-label">
      Amount of {names[side]}
      <input
        className="text-input amount-input"
        inputMode="decimal"
        placeholder="0"
        maxLength={80}
        autoComplete="off"
        spellCheck={false}
        value={typed.side === side ? typed.text : otherText}
        aria-invalid={(typed.side === side && typed.text !== '' && amount === null) || undefined}
        onChange={(e) => (edited(), setTyped({ side, text: e.target.value }))}
      />
      {account && (
        <small>
          Wallet: {show(side === 0 ? account.balance0 : account.balance1, side)}
          {(side === 0 ? pool.token0 : pool.token1).wrapped && ' (keep some for the network fee)'}
        </small>
      )}
    </label>
  );

  return (
    <Modal title={title} onClose={onClose}>
      <div className="liquidity-pair">
        <span className="pair-icons">
          <TokenMark symbol={pool.token0.symbol} size={0} className="token-icon" />
          <TokenMark symbol={pool.token1.symbol} size={0} className="token-icon" />
        </span>
        <strong>{poolName(pool)}</strong>
        <span className="badge">Open pool</span>
      </div>
      <div className="segmented live-mode" aria-label="Deposit or withdraw">
        <button
          type="button"
          aria-pressed={mode === 'add'}
          onClick={() => (edited(), onMode('add'))}
        >
          Add
        </button>
        <button
          type="button"
          aria-pressed={mode === 'remove'}
          onClick={() => (edited(), onMode('remove'))}
        >
          Remove
        </button>
      </div>
      {mode === 'add' ? (
        <div className="live-amounts">
          {amountField(0)}
          {amountField(1)}
          <p className="microcopy">
            Type either amount; the other is what the pool&apos;s own ratio asks for it at{' '}
            {wording.settled} block {snapshot.finalized.number.toString()}.
          </p>
        </div>
      ) : (
        <div className="withdrawal-controls">
          <span className="withdrawal-percentage">{percent}%</span>
          <input
            type="range"
            min="1"
            max="100"
            step="1"
            value={percent}
            aria-label="Percentage of your pool shares to remove"
            onChange={(e) => (edited(), setPercent(Number(e.target.value)))}
          />
          <div className="segmented">
            {[25, 50, 75, 100].map((p) => (
              <button
                type="button"
                key={p}
                aria-pressed={percent === p}
                onClick={() => (edited(), setPercent(p))}
              >
                {p}%
              </button>
            ))}
          </div>
        </div>
      )}
      <Disclosure
        className="swap-settings"
        summary={() => (
          <>
            <span className="settings-label">Settings</span>
            <span className="chip">Slippage {slippage}%</span>
            <span className="chip">Deadline {deadline} min</span>
          </>
        )}
      >
        <div className="swap-terms">
          <label className="field-label">
            Slippage tolerance (%)
            <input
              className="text-input"
              inputMode="decimal"
              value={slippage}
              onChange={(e) => (edited(), setSlippage(e.target.value))}
            />
          </label>
          <label className="field-label">
            Deadline (minutes)
            <input
              className="text-input"
              inputMode="numeric"
              value={deadline}
              onChange={(e) => (edited(), setDeadline(e.target.value))}
            />
          </label>
          <p className="microcopy">
            The minimums below are this far under the amounts. If the pool&apos;s ratio moves by
            more before your transaction runs, it reverts and only the gas is spent.
          </p>
        </div>
      </Disclosure>
      {settingsProblem && (
        <p className="form-error" role="alert">
          {settingsProblem}
        </p>
      )}
      <dl className="detail-list live-figures" aria-label={mode === 'add' ? 'Deposit' : 'Removal'}>
        {add && add.outcome.ok && (
          <>
            <dt>You deposit</dt>
            <dd>
              {show(add.outcome.amount0, 0)} + {show(add.outcome.amount1, 1)}
              {(add.outcome.amount0 < add.desired0 || add.outcome.amount1 < add.desired1) &&
                ' (the ratio needs slightly less than was typed; the rest stays in your wallet)'}
            </dd>
            <dt>Minimum deposited</dt>
            <dd>
              {show(add.min0, 0)} and {show(add.min1, 1)} ({slippage}% slippage)
            </dd>
            <dt>Pool shares you receive</dt>
            <dd>{formatAmount(add.outcome.liquidity, 18)}</dd>
            <dt>Your share of the pool after</dt>
            <dd>
              {sharePercentText(
                (((account?.shares ?? 0n) + add.outcome.liquidity) * 1_000_000n) /
                  add.outcome.supplyAfter,
                true,
              )}
            </dd>
          </>
        )}
        {remove && remove.outcome.ok && (
          <>
            <dt>You receive</dt>
            <dd>
              {show(remove.outcome.amount0, 0)} + {show(remove.outcome.amount1, 1)}
            </dd>
            <dt>Minimum received</dt>
            <dd>
              {show(remove.min0, 0)} and {show(remove.min1, 1)} ({slippage}% slippage)
            </dd>
            <dt>Pool shares removed</dt>
            <dd>
              {formatAmount(remove.liquidity, 18)} of {formatAmount(position.shares, 18)}
            </dd>
            <dt>Your share of the pool after</dt>
            <dd>
              {sharePercentText(
                remove.outcome.supplyAfter === 0n
                  ? 0n
                  : ((position.shares - remove.liquidity) * 1_000_000n) /
                      remove.outcome.supplyAfter,
                position.shares > remove.liquidity,
              )}
            </dd>
          </>
        )}
        <dt>Your position now</dt>
        <dd>
          {!account
            ? 'Connect a wallet to read it'
            : position.shares === 0n
              ? 'No shares of this pool'
              : `${formatAmount(position.shares, 18)} shares (${sharePercentText(position.sharePpm, true)}): ${show(position.amount0, 0)} + ${show(position.amount1, 1)}`}
        </dd>
        <dt>Read at</dt>
        <dd>
          {settledCapital()} block {snapshot.finalized.number.toString()}; compared with the latest
          block before your wallet is asked
        </dd>
        <dt>Deadline</dt>
        <dd>{deadlineValid ? `${deadlineMinutes} minutes after you confirm` : 'Not set'}</dd>
      </dl>
      {refusal && (
        <p className="form-error" role="alert" data-refusal={refusal.code}>
          <AlertTriangle size={16} aria-hidden="true" /> {refusalText(refusal, names, mode)}
        </p>
      )}
      {short.map((side) => (
        <p className="form-error" role="alert" key={side}>
          Your {wording.settled} {names[side]} balance (
          {formatAmount(side === 0 ? account!.balance0 : account!.balance1, decimals[side])}) is
          below the amount; the deposit would revert.
        </p>
      ))}
      <LiquidityRisks
        feeTo={d.feeTo}
        facts={facts}
        symbols={[pool.token0.symbol, pool.token1.symbol]}
      />
      <p className="microcopy">
        A deposit or removal can still revert, and then only the gas is spent, if before it runs the
        pool&apos;s ratio moves by more than your tolerance (BDEX: INSUFFICIENT_A_AMOUNT or
        INSUFFICIENT_B_AMOUNT), its deadline passes (BDEX: EXPIRED), or a token refuses the
        transfer.
        {mode === 'remove' &&
          ' The first 1000 base units of shares of every pool were locked for ever when it opened; they belong to nobody and are not part of any position.'}
      </p>
      {note && (
        <p
          className={note.tone === 'error' ? 'form-error' : 'microcopy'}
          role={note.tone === 'error' ? 'alert' : 'status'}
          data-testid="liquidity-note"
        >
          {note.text}
        </p>
      )}
      <TrackedStatus
        pendingSwap={pendingSwap}
        rpc={rpc}
        deployment={d}
        pools={snapshot.pools}
        sideName={sideName}
        confirmation={confirmation}
        receiptPollMs={receiptPollMs}
        now={now}
        onActivity={() => (onClose(), onActivity())}
      />
      {step ? (
        <button
          type="button"
          className="button primary full-width"
          disabled={blocked}
          onClick={() => void approve(step)}
        >
          {stepLabel(step)}
        </button>
      ) : (
        <button
          type="button"
          className="button primary full-width"
          disabled={blocked}
          onClick={() => void act()}
        >
          {actionLabel}
        </button>
      )}
      <p className="next-step" data-testid="liquidity-next-step">
        {next}
      </p>
    </Modal>
  );
}
