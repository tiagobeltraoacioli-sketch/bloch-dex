// Bloch L2 mainnet route (#/mainnet, chain 700770).
//
// Safe by default: until a verified deployment record, a live public RPC and
// a pinned L2 genesis are bundled, the route shows "Not yet live" with the
// planned caps and sends no RPC request and no transaction. Once live, every
// pool, balance, allowance and quote read is pinned to the finalized L2 block
// (the snapshot's block hash), and transactions are explicit wallet steps. The
// one read at `latest` is a lens quote that warns about a stale price and
// tightens the signed minimum after a better one (mainnet/quotecheck.ts); a
// worse price needs an explicit reconfirmation. A sent swap holds the Swap button
// until its outcome is known (mainnet/pendingswap.ts).
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  ArrowDown,
  ArrowDownUp,
  ArrowUpRight,
  CircleCheck,
  Layers,
  PanelRightOpen,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  TimerOff,
  TrendingDown,
  Wallet,
} from 'lucide-react';
import { GateGlyph } from './shell/BrandMark';
import { GateArch } from './gate/GateArch';
import { lampState } from './gate/lamp';
import { Passage, passageStage } from './gate/Passage';
import { PoolDepth } from './gate/PoolDepth';
import { poolDepth } from './gate/pool-depth';
import { Figure } from './ui/Figure';
import { useWide } from './ui/use-wide';
import { CopyButton } from './ui/CopyButton';
import { nextStep } from './ui/next-step';
import { TokenSheet } from './ui/TokenSheet';
import { Disclosure } from './ui/Disclosure';
import { Expander } from './ui/Expander';
import { ReferencePanel } from './ui/ReferencePanel';
import { DeadlineClock } from './ui/DeadlineClock';
import { ConfirmationProgress } from './ui/ConfirmationProgress';
import { ReadFailureBlock } from './ui/ReadFailure';
import { classifyReadFailure, readRetrySeconds } from './ui/read-failure';
import {
  backgroundRenewal,
  cannotRenewText,
  entryQuietMs,
  monotonicMs,
  ageSince,
  stampNow,
  NEVER,
  renewalCheckMs,
  renewalText,
  staleAt,
  type RenewalReason,
} from './ui/snapshot-renewal';
import type { ProgressRule } from './ui/confirmation-progress';
import { quoteRate } from './ui/rate';
import type { Address, Hex } from 'viem';
import { formatAmount, parseAmount } from './amm';
import {
  approveTransaction,
  ensureChain,
  resetAllowanceTransaction,
  sendTransaction,
  swapTransaction,
} from './devnet4/swap';
import {
  quoteExactInput,
  readSnapshot,
  routesFor,
  type LensQuote,
  type LivePool,
  type LiveToken,
  type Rpc,
  type Snapshot,
} from './devnet4/chain';
import type { DevnetDeployment } from './devnet4/record';
import type { Devnet4Wallet } from './Devnet4Live';
import {
  addChainParameters,
  DEFAULT_DEADLINE_MINUTES,
  DEFAULT_SLIPPAGE_BPS,
  FINALIZED_AGE_WARN_SECONDS,
  MAX_DEADLINE_MINUTES,
  MAX_SLIPPAGE_BPS,
  MIN_DEADLINE_MINUTES,
  type MainnetNetwork,
  type MainnetState,
  type PlannedCap,
  longestQuiet,
  swapClock,
} from './mainnet/config';
import {
  atKCeiling,
  checkRoute,
  closedByExcess,
  closureMinOutput,
  explainBlock,
  headroom,
  headroomUse,
  type RouteCheck,
} from './mainnet/caps';
import { submissionFeeNote } from './mainnet/submission-fees';
import { newSlotFeeNote } from './mainnet/newslotfee';
import {
  requireFinality,
  submissionContext,
  type ReplacementProof,
} from './mainnet/submission-outcome';
import { idleWaitNote, usePendingSwap, walletOnChain } from './mainnet/pendingswap';
import { settledCapital, worded, wording } from './mainnet/wording';
import { exitsBlocked, readBridgeHold, type BridgeHold } from './mainnet/bridgehold';
import { httpRpc } from './devnet4/chain';
import { explainSwapRevert, retryOffer, revertText, type SwapRetryInfo } from './mainnet/retry';
import { isAllowedSlippageBps } from './slippage';
import { loadHistory, recordFinished, type FinishedTx } from './mainnet/txhistory';
import { blocksSwap, compareQuotes, signedQuote, type QuoteCheck } from './mainnet/quotecheck';
import {
  readAllowance,
  readBalances,
  readExcess,
  skimTransaction,
  type Balances,
} from './mainnet/reads';

type Option = { key: string; label: string; token: LiveToken; native: boolean };
type Step = {
  label: string;
  hash?: Hex;
  state: 'waiting' | 'pending' | 'mined' | 'failed' | 'unknown';
  detail?: string;
};

const short = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`;
const percent = (part: bigint, whole: bigint) =>
  whole === 0n ? '0.00' : (Number((part * 10_000n) / whole) / 100).toFixed(2);
// Every sentence that comes from an error of the route's logic passes through `worded` (mainnet/wording.ts): the
// Bloch L2's words are returned as they are.
const message = (error: unknown, fallback: string) =>
  worded(error instanceof Error ? error.message : fallback);

/**
 * How a public network settles, for the page: the note that says what "confirmed" means there (always visible),
 * and the rule a tracked transaction is counted against. Absent on the Bloch L2.
 */
/**
 * What the swap form holds when the card is remounted for a renewed snapshot block (public networks only): the
 * user's own inputs, and whether a quote was on screen. Never a quote itself: that is read again at the new block.
 */
type FormMemory = {
  inKey: string;
  outKey: string;
  amount: string;
  slippage: string;
  deadline: string;
  quoted: boolean;
  /** Presentation the remount would otherwise undo: the focused field, the open settings, the open quote details. */
  focus: string | null;
  settingsOpen: boolean;
  detailsOpen: boolean;
  /** Set when the card asked for the renewal itself (ui/snapshot-renewal.ts): the new card says why, once. */
  renewal?: RenewalReason;
};

/** What the background renewal needs to know of the card (ui/snapshot-renewal.ts `backgroundRenewal`). */
type CardActivity = { editedAt: number; quoteOnScreen: boolean };

/** The snapshot's age bound, for the card (public networks only): its age now, and the route's renewal. */
type Freshness = {
  maxAgeMs: number;
  ageMs: () => number;
  activity: MutableRefObject<CardActivity>;
  renew: () => void;
};

export type ConfirmationView = {
  note: string;
  rule: ProgressRule;
  blockSeconds: number | null;
  /** The rule that settles a REVERTED swap (`confirmation.reverted`, else the strict rule; R328-3P-3). */
  reverted?: ProgressRule;
};

function ExplorerLink({
  network,
  kind,
  value,
}: {
  network: MainnetNetwork;
  kind: 'tx' | 'address';
  value: string;
}) {
  const what = kind === 'tx' ? 'transaction hash' : 'address';
  if (!network.explorerUrl)
    return (
      <span className="hashline">
        <code>{value}</code>
        <CopyButton value={value} what={what} />
      </span>
    );
  return (
    <span className="hashline">
      <a
        href={`${network.explorerUrl.replace(/\/$/, '')}/${kind}/${value}`}
        target="_blank"
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        title="Open in the explorer"
      >
        <code>{value}</code>
        <ArrowUpRight size={14} aria-hidden="true" />
      </a>
      <CopyButton value={value} what={what} />
    </span>
  );
}

export default function MainnetLive({
  network,
  load,
  rpc,
  wallet,
  planned,
  now = () => Date.now(),
  receiptPollMs,
  snapshotMaxAgeMs,
  ethRpc,
  confirmation,
}: {
  network: MainnetNetwork;
  load: () => Promise<MainnetState>;
  rpc: Rpc;
  wallet: Devnet4Wallet;
  planned: { caps: PlannedCap[]; pairs: [string, string][] };
  now?: () => number;
  receiptPollMs?: number;
  /** A public chain's endpoints keep a block's state for a minute or so: take a new snapshot block this often. */
  snapshotMaxAgeMs?: number;
  /** Ethereum RPC for the bUSDC hold status; defaults to the network file's status.ethRpcUrl. */
  ethRpc?: Rpc;
  /** A public network's confirmation rule in words and numbers (the multichain site); none on the Bloch L2. */
  confirmation?: ConfirmationView;
}) {
  const [state, setState] = useState<MainnetState | null>(null);
  const [hold, setHold] = useState<BridgeHold | null>(null);
  const holdSource = network.bridges.find((b) => b.status)?.status ?? null;
  const eth = useMemo(
    () => ethRpc ?? (holdSource ? httpRpc(holdSource.ethRpcUrl) : null),
    [ethRpc, holdSource],
  );
  const [observedSnapshot, setSnapshot] = useState<
    (Snapshot & { rpc: Rpc; deploymentId: Hex }) | null
  >(null);
  const [failure, setFailure] = useState('');
  const [generation, setGeneration] = useState(0);
  // Presentation of a failed read (ui/read-failure.ts): two kinds are read again by the page itself, later each
  // time; the count of failed reads in a row restarts with the first read that succeeds.
  const failedReads = useRef(0);
  const [retryAt, setRetryAt] = useState<number | null>(null);

  // When the snapshot on screen was read (monotonic clock), and whether a read is in flight: the age bound of a
  // public network's snapshot (ui/snapshot-renewal.ts). Read by the renewal only.
  const takenAt = useRef(NEVER);
  const reading = useRef(false);
  useEffect(() => {
    let current = true;
    setFailure('');
    reading.current = true;
    void (async () => {
      try {
        const s = await load();
        if (!current) return;
        setState(s);
        if (s.status !== 'live') return;
        const snap = await readSnapshot(rpc, s.deployment, 'mainnet');
        const pools = await readExcess(rpc, snap.finalized.hash, s.deployment.lens, snap.pools);
        if (current) takenAt.current = stampNow();
        if (current)
          setSnapshot({
            ...snap,
            pools,
            rpc,
            deploymentId: submissionContext(s.deployment).deploymentId,
          });
        const known = snap.tokens.some(
          (t) => t.address.toLowerCase() === holdSource?.token.toLowerCase(),
        );
        const h =
          holdSource && !known
            ? ({
                state: 'unknown',
                reason: 'the configured bUSDC token is not a token of this deployment',
              } as const)
            : await readBridgeHold(eth!, rpc, holdSource, snap.finalized.hash);
        if (current) setHold(h);
        if (current) failedReads.current = 0;
      } catch (error) {
        if (current) setFailure(message(error, 'Unavailable.'));
      } finally {
        if (current) reading.current = false;
      }
    })();
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, rpc, generation]);

  const readFailure = failure ? classifyReadFailure(failure) : null;
  const autoRetry = readFailure?.retry === 'auto';
  useEffect(() => {
    if (!autoRetry) return setRetryAt(null);
    const seconds = readRetrySeconds(failedReads.current++);
    setRetryAt(now() + seconds * 1000);
    const timer = setTimeout(() => setGeneration((g) => g + 1), seconds * 1000);
    return () => clearTimeout(timer);
    // One timer per failed read: `failure` is cleared when the next read starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRetry, failure]);
  // Review R328-5: every read is pinned to the snapshot block's hash and must be answered by two endpoints; public
  // endpoints stop serving a block's state after about a minute. The pin is renewed while the page is visible.
  // Shaped for the redesigned card (agent 327; 326's rule stands: on these chains a snapshot does not get older
  // than about a minute). A renewal remounts the swap card, so: it waits while the card has a wallet request in
  // flight or a hold is open (nothing can be quoted or sent then, and the hold's own reads are not pinned to the
  // snapshot; the end of a hold renews it), it leaves a failed read to that state's own counted retry, and the
  // card keeps what the user typed, where the cursor was and what was open, and reads its quote again at the new
  // block (`formMemory`, used only with this prop).
  // Round 18 (R328-3P-2): the timer no longer renews blindly every `snapshotMaxAgeMs`; it looks every few seconds
  // whether the snapshot is past the bound and renews only when nobody is typing in the card or reading a quote
  // (ui/snapshot-renewal.ts `backgroundRenewal`, every pause named there); the card renews on demand before a quote
  // or a swap on a snapshot past the bound, and once after an UNCONFIRMED quote read (`freshness` below).
  const cardBusy = useRef(false);
  const formMemory = useRef<FormMemory | null>(null);
  const cardActivity = useRef<CardActivity>({ editedAt: -Infinity, quoteOnScreen: false });
  const failed = useRef(false);
  failed.current = failure !== '';
  useEffect(() => {
    if (!snapshotMaxAgeMs) return;
    const look = () => {
      const at = monotonicMs();
      const due = backgroundRenewal({
        ageMs: ageSince(takenAt.current),
        maxAgeMs: snapshotMaxAgeMs,
        sinceEditMs: at - cardActivity.current.editedAt,
        quoteOnScreen: cardActivity.current.quoteOnScreen,
        walletRequest: cardBusy.current,
        holdOpen: holdOpen.current,
        failure: failed.current,
        reading: reading.current,
        hidden: typeof document !== 'undefined' && document.hidden,
      });
      if (due === 'renew') setGeneration((g) => g + 1);
    };
    const timer = setInterval(look, renewalCheckMs(snapshotMaxAgeMs));
    // A tab shown again (or a device woken: browsers throttle or stop timers meanwhile) looks at once (R364-7).
    const shown = () => {
      if (!document.hidden) look();
    };
    document.addEventListener('visibilitychange', shown);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [snapshotMaxAgeMs]);
  const freshness = useMemo<Freshness | undefined>(
    () =>
      snapshotMaxAgeMs
        ? {
            maxAgeMs: snapshotMaxAgeMs,
            ageMs: () => ageSince(takenAt.current),
            activity: cardActivity,
            renew: () => setGeneration((g) => g + 1),
          }
        : undefined,
    [snapshotMaxAgeMs],
  );

  const holdOpen = useRef(false);
  const live = state?.status === 'live';
  const snapshot = useMemo(
    () =>
      state?.status === 'live' &&
      observedSnapshot?.rpc === rpc &&
      observedSnapshot.deploymentId === submissionContext(state.deployment).deploymentId
        ? observedSnapshot
        : null,
    [state, observedSnapshot, rpc],
  );
  // Lives above SwapPanel, which remounts on every new finalized block.
  const pendingSwap = usePendingSwap({
    rpc,
    chainId: network.chainId,
    deployment: state?.status === 'live' ? state.deployment : undefined,
    provider: wallet.provider ?? undefined,
    account: wallet.account?.address.toLowerCase() as Address | undefined,
    enabled: live && !!snapshot,
    now,
    newSlotFee: network.newSlotFee,
    idleHeartbeatSeconds: network.noIdleHeartbeat ? 0 : longestQuiet(network.idle),
    onMined: () => setGeneration((g) => g + 1),
    explain: (swap, receipt) =>
      state?.status === 'live' && swap.retry
        ? explainSwapRevert(
            rpc,
            state.deployment.router,
            swap.retry,
            receipt.blockNumber,
            swap.deadline,
          )
        : Promise.resolve('unknown'),
    intervalMs: receiptPollMs,
  });
  holdOpen.current = pendingSwap.open;
  // The same conditions as the status block below, named for the layout.
  const ready = !failure && state?.status === 'live' && !!snapshot;
  const loading = !failure && (!state || (state.status === 'live' && !snapshot));
  // Presentation: the reference layer is a side panel unless a pool carries a notice the user must see
  // (excess above the reserves, a side at its cap, the k ceiling, held bUSDC exits) or the wallet is on
  // another chain; then it stays on the page.
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Presentation: where the gate sets a hold's recovery controls on a wide screen (beside it, in the rail), and
  // the outcome of the last transaction tracked in this visit, which the lamp shows once the form is at rest.
  const [railSlot, setRailSlot] = useState<HTMLDivElement | null>(null);
  const lastOutcome = useRef<string | null>(null);
  const attention =
    exitsBlocked(hold) ||
    // A wallet on another chain: the network block with its switch button stays on the page.
    (wallet.account !== null && BigInt(wallet.account.chainId) !== BigInt(network.chainId)) ||
    (snapshot?.pools ?? []).some(
      (p) =>
        (p.excess && (p.excess.excess0 > 0n || p.excess.excess1 > 0n)) ||
        atKCeiling(p) ||
        headroom(p.reserve0 + (p.excess?.excess0 ?? 0n), p.cap0) === 0n ||
        headroom(p.reserve1 + (p.excess?.excess1 ?? 0n), p.cap1) === 0n,
    );
  return (
    <section
      className="page devnet4-page mainnet-page"
      aria-labelledby="mainnet-title"
      data-layout={ready ? 'gate' : 'column'}
    >
      <div className="section-heading">
        <div>
          <span className="badge">
            {wording.title} · Chain {network.chainId}
            {live ? '' : ' · Not yet live'}
          </span>
          <h1 id="mainnet-title">{wording.title}</h1>
          <p className="muted">
            Pools, balances and quotes are read at the {wording.settled} {wording.block}, from a
            reviewed deployment record; a quote is also compared with the latest block to warn when
            it has gone stale. Swaps are sent only from your wallet, one explicit step at a time.{' '}
            {wording.launch}
          </p>
        </div>
      </div>
      {/* The page's status: what block it reads, the Refresh, and every page-wide alert, above the gate. */}
      <div className="page-status">
        {live && (
          <button
            className="button secondary page-refresh"
            onClick={() => setGeneration((g) => g + 1)}
          >
            <RefreshCw size={16} /> Refresh
          </button>
        )}
        {failure && readFailure ? (
          <ReadFailureBlock
            failure={readFailure}
            retryAt={retryAt}
            now={now}
            onRetry={() => setGeneration((g) => g + 1)}
          >
            {wording.reads} are unavailable: {failure.replace(/\.$/, '')}. No transaction can be
            sent from this page.
          </ReadFailureBlock>
        ) : !state ? (
          <p className="muted" role="status">
            <LoaderCircle size={16} className="spin" /> Checking the bundled deployment record…
          </p>
        ) : state.status === 'not-live' ? (
          <NotLive reasons={state.reasons} planned={planned} />
        ) : !snapshot ? (
          <p className="muted" role="status">
            <LoaderCircle size={16} className="spin" /> Verifying the deployment at the{' '}
            {wording.settled} block…
          </p>
        ) : (
          <>
            <FinalityAge finalizedAt={snapshot.finalized} now={now} />
            <BridgeHoldBanner hold={hold} network={network} />
          </>
        )}
        {confirmation && ready && (
          <button
            type="button"
            className="settle-jump"
            onClick={() =>
              document.querySelector('.confirmation-rule')?.scrollIntoView({ block: 'start' })
            }
          >
            <ArrowDown size={14} aria-hidden="true" /> Settlement rule of this network
          </button>
        )}
      </div>
      {/* The swap card is the page; verification and reference sit in the layer after it. */}
      {ready && state.status === 'live' && snapshot ? (
        <div className="live-hero">
          <SwapPanel
            key={`${snapshot.finalized.hash}:${pendingSwap.contextKey}`}
            network={network}
            deployment={state.deployment}
            multicall3={state.multicall3}
            snapshot={snapshot}
            rpc={rpc}
            wallet={wallet}
            now={now}
            pendingSwap={pendingSwap}
            hold={hold}
            holdToken={holdSource?.token}
            confirmation={confirmation}
            receiptPollMs={receiptPollMs}
            onRefresh={() => setGeneration((g) => g + 1)}
            memory={snapshotMaxAgeMs ? formMemory : undefined}
            freshness={freshness}
            busyRef={cardBusy}
            railSlot={railSlot}
            lastOutcome={lastOutcome}
          />
        </div>
      ) : (
        loading && <LoadingBlocks />
      )}
      {ready && <div className="rail-slot" ref={setRailSlot} />}
      {/* The verification rail: beside the gate on a wide screen, after it on a narrow one. */}
      {ready && state.status === 'live' && snapshot && (
        <TrustStrip
          snapshot={snapshot}
          attention={attention}
          onDetails={() => setDetailsOpen(true)}
        />
      )}
      {confirmation && <ConfirmationRule note={confirmation.note} />}
      {/* Docked (part of the page) until the route is live, and whenever a pool carries a notice. */}
      <ReferencePanel
        docked={!ready || attention}
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        title="Pools and verification"
      >
        {ready && state.status === 'live' && snapshot && (
          <PoolsTable
            snapshot={snapshot}
            network={network}
            rpc={rpc}
            wallet={wallet}
            pendingSwap={pendingSwap}
            now={now}
            heldToken={exitsBlocked(hold) ? holdSource?.token : undefined}
          />
        )}
        <NetworkPanel network={network} wallet={wallet} />
        {ready && state.status === 'live' && snapshot && (
          <DeploymentPanel network={network} deployment={state.deployment} snapshot={snapshot} />
        )}
        {network.bridges.length > 0 && <BridgePanel network={network} />}
      </ReferencePanel>
    </section>
  );
}

/**
 * A text of the logic modules set one sentence to a line, word for word (nothing is edited or dropped); the
 * sentence that tells the user what not to do is marked for the stylesheet.
 */
function Lines({ text }: { text: string }) {
  return (
    <>
      {text
        .trim()
        .split(/(?<=[.!?])\s+(?=[A-Z])/)
        .map((sentence, i) => (
          <Fragment key={i}>
            {i > 0 && ' '}
            <span className="hold-line" data-warn={/^Do not /.test(sentence) || undefined}>
              {sentence}
            </span>
          </Fragment>
        ))}
    </>
  );
}

/**
 * What "confirmed" means on this network, always on the page (review R309-MC-2). One paragraph with the note's
 * full text; its first sentence, the rule itself, is set in the reading colour.
 */
function ConfirmationRule({ note }: { note: string }) {
  const cut = note.indexOf('. ');
  const [rule, rest] = cut < 0 ? [note, ''] : [note.slice(0, cut + 1), note.slice(cut + 1)];
  return (
    <div className="confirmation-rule">
      <span className="confirmation-rule-label">
        <Layers size={14} aria-hidden="true" /> How this network settles here
      </span>
      <p data-testid="confirmation-rule">
        <strong>{rule}</strong>
        {rest}
      </p>
    </div>
  );
}

/** Placeholders with the height of the swap card while the record and the finalized block are checked. */
function LoadingBlocks() {
  return (
    <div className="live-hero" aria-hidden="true">
      <div className="card skeleton-card swap-card" data-lamp="idle">
        <GateArch />
        <span className="skeleton skeleton-title" />
        <span className="skeleton skeleton-leg" />
        <span className="skeleton skeleton-leg" />
        <span className="skeleton skeleton-line" />
        <span className="skeleton skeleton-button" />
      </div>
    </div>
  );
}

/**
 * One line of what stands behind the page (verified record, caps in use) and the button that opens the full
 * reference layer. A summary of figures shown in full there; it replaces nothing.
 */
function TrustStrip({
  snapshot,
  attention,
  onDetails,
}: {
  snapshot: Snapshot;
  attention: boolean;
  onDetails: () => void;
}) {
  return (
    <div className="trust-strip" data-testid="trust-strip">
      <span className="trust-item">
        <ShieldCheck size={16} aria-hidden="true" /> Record verified
      </span>
      {snapshot.pools.map((p) => (
        <span className="trust-item trust-pool" key={p.address}>
          {p.token0.symbol}/{p.token1.symbol} caps in use: {percent(p.reserve0, p.cap0)}% ·{' '}
          {percent(p.reserve1, p.cap1)}%
          <span className="trust-meters" aria-hidden="true">
            {(
              [
                [p.reserve0, p.cap0],
                [p.reserve1, p.cap1],
              ] as const
            ).map(([reserve, cap], i) => (
              <span
                key={i}
                className="cap-meter"
                style={
                  { '--used': `${Math.min(100, Number(percent(reserve, cap)))}%` } as CSSProperties
                }
              />
            ))}
          </span>
        </span>
      ))}
      {attention ? (
        <button
          type="button"
          className="trust-details"
          data-attention
          onClick={() => document.querySelector('.reference')?.scrollIntoView({ block: 'start' })}
        >
          <AlertTriangle size={16} aria-hidden="true" /> Notices and network below
        </button>
      ) : (
        <button type="button" className="trust-details" onClick={onDetails}>
          <PanelRightOpen size={16} aria-hidden="true" /> Pools and verification
        </button>
      )}
    </div>
  );
}

function NetworkPanel({ network, wallet }: { network: MainnetNetwork; wallet: Devnet4Wallet }) {
  const [note, setNote] = useState('');
  const onChain =
    wallet.account !== null && BigInt(wallet.account.chainId) === BigInt(network.chainId);
  async function addOrSwitch() {
    if (!wallet.provider) return;
    setNote('Confirm in your wallet.');
    try {
      await ensureChain(wallet.provider, addChainParameters(network));
      setNote(`Your wallet is on ${network.chainName} (chain ${network.chainId}).`);
    } catch (error) {
      setNote(message(error, 'The wallet refused the network.'));
    }
  }
  return (
    <div className="card mainnet-network" aria-label="Network">
      <h2>Network</h2>
      <dl className="detail-list">
        <dt>Network</dt>
        <dd>
          {network.chainName}, chain ID {network.chainId} (<code>{network.chainHex}</code>), native
          currency {network.nativeCurrency.symbol}
        </dd>
        <dt>RPC</dt>
        <dd>
          <code>{network.rpcUrl}</code>
          {network.rpcLive ? '' : ' (placeholder, not published yet)'}
        </dd>
        <dt>Explorer</dt>
        <dd>
          {network.explorerUrl ? (
            <a href={network.explorerUrl} target="_blank" rel="noopener noreferrer">
              {network.explorerUrl}
            </a>
          ) : (
            'Not published yet'
          )}
        </dd>
        <dt>{wording.genesis}</dt>
        <dd>{network.genesisHash ? <code>{network.genesisHash}</code> : 'Not pinned yet'}</dd>
      </dl>
      {!network.rpcLive ? (
        <p className="microcopy">
          Adding the network to a wallet is available once the public RPC is published.
        </p>
      ) : !wallet.account ? (
        <p className="microcopy">Connect a wallet below to add or switch to this network.</p>
      ) : (
        <button
          className="button secondary"
          disabled={!wallet.provider || onChain}
          onClick={() => void addOrSwitch()}
        >
          {onChain
            ? `Wallet is on chain ${network.chainId}`
            : `Add or switch to ${network.chainName}`}
        </button>
      )}
      {note && (
        <p className="microcopy" role="status">
          {note}
        </p>
      )}
    </div>
  );
}

function NotLive({
  reasons,
  planned,
}: {
  reasons: string[];
  planned: { caps: PlannedCap[]; pairs: [string, string][] };
}) {
  return (
    <div className="card mainnet-not-live" aria-label="Not yet live">
      <h2>Not yet live</h2>
      <p className="notice" role="status">
        The DEX is not deployed on {wording.where} yet. This page sends no RPC request and no
        transaction until a verified deployment record is published with this site.
      </p>
      <ul>
        {reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <h3>Planned launch pools and reserve caps</h3>
      <p className="microcopy">
        Caps are fixed in the factory constructor; there is no setter. A deposit or swap that would
        lift a reserve above its cap reverts. Raising them needs a new deployment.
      </p>
      <table className="devnet4-pools">
        <thead>
          <tr>
            <th scope="col">Token</th>
            <th scope="col">Reserve cap per pool</th>
          </tr>
        </thead>
        <tbody>
          {planned.caps.map((c) => (
            <tr key={c.symbol}>
              <th scope="row">{c.symbol}</th>
              <td>
                {formatAmount(c.cap, c.decimals)} {c.symbol}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="microcopy">Pools: {planned.pairs.map(([a, b]) => `${a}/${b}`).join(', ')}.</p>
    </div>
  );
}

/**
 * How old the finalized block behind every figure on this page is. Past the
 * monitor's warning age it says so: nothing else on the page changes during a
 * finality stall, because every read is pinned to that block.
 */
function FinalityAge({
  finalizedAt,
  now,
}: {
  finalizedAt: Snapshot['finalized'];
  now: () => number;
}) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((t) => t + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor(now() / 1000) - Number(finalizedAt.timestamp));
  const age =
    seconds < 3600
      ? `${Math.floor(seconds / 60)} min`
      : `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
  if (seconds < FINALIZED_AGE_WARN_SECONDS)
    return (
      <p className="microcopy finality-line" aria-label="Finality age">
        <CircleCheck size={16} aria-hidden="true" /> {settledCapital()} block{' '}
        {finalizedAt.number.toString()} is {age} old.
      </p>
    );
  return (
    <p className="form-error finality-line" role="alert" aria-label="Finality age">
      <AlertTriangle size={16} /> {wording.finality} looks stalled: {wording.settled} block{' '}
      {finalizedAt.number.toString()} is {age} old. Pools, balances, caps and quotes on this page
      are from that block. A swap executes on the latest state, and anything mined now stays out of
      these figures until {wording.settled === 'finalized' ? 'finality' : 'confirmation'} resumes.
    </p>
  );
}

function DeploymentPanel({
  network,
  deployment: d,
  snapshot: s,
}: {
  network: MainnetNetwork;
  deployment: DevnetDeployment;
  snapshot: Snapshot;
}) {
  return (
    <div className="card devnet4-record" aria-label="Deployment record">
      <h2>
        <ShieldCheck size={18} /> Verified deployment record
      </h2>
      <dl className="detail-list">
        <dt>Record</dt>
        <dd>
          {d.name} (<code>{d.path}</code>, revision <code>{d.revision.slice(0, 10)}</code>)
        </dd>
        <dt>Finality gate</dt>
        <dd>
          {d.gate.decision} at {wording.settled} block {d.gate.finalizedNumber.toString()}
        </dd>
        <dt>{settledCapital()} now</dt>
        <dd>
          Block {s.finalized.number.toString()}; chain, genesis and every runtime code hash match
          the record
        </dd>
        <dt>Router</dt>
        <dd>
          <ExplorerLink network={network} kind="address" value={d.router} />
        </dd>
        <dt>Lens</dt>
        <dd>
          <ExplorerLink network={network} kind="address" value={d.lens} />
        </dd>
        <dt>Protocol fee recipient</dt>
        <dd>
          <ExplorerLink network={network} kind="address" value={d.feeTo} />
        </dd>
      </dl>
    </div>
  );
}

function PendingExcess({
  pool,
  network,
  rpc,
  wallet,
  pendingSwap,
  now,
}: {
  pool: LivePool;
  network: MainnetNetwork;
  rpc: Rpc;
  wallet: Devnet4Wallet;
  pendingSwap: ReturnType<typeof usePendingSwap>;
  now: () => number;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const currentWallet = useRef(wallet);
  currentWallet.current = wallet;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const e = pool.excess;
  if (!e || (e.excess0 === 0n && e.excess1 === 0n)) return null;
  const blocked = e.blocksInflow0 || e.blocksInflow1;
  const minimum = closureMinOutput(pool);
  const minimums = [
    [minimum.amount0, pool.token0],
    [minimum.amount1, pool.token1],
  ] as const;
  const parts = [
    [e.excess0, pool.token0],
    [e.excess1, pool.token1],
  ] as const;
  async function skim() {
    if (!wallet.provider || !wallet.account || pendingSwap.holds()) return;
    const { provider, account } = wallet;
    setBusy(true);
    setNote('Confirm in your wallet.');
    let intentId: string | undefined;
    let hash: Hex | undefined;
    try {
      await pendingSwap.withWalletRequest(async () => {
        try {
          await ensureChain(provider, addChainParameters(network));
          await requireFinality(rpc);
          const to = account.address.toLowerCase() as Address;
          const tx = {
            ...skimTransaction(pool.address, to),
            chainId: network.chainId,
          };
          // Priced before the intent is saved: a failure here leaves nothing behind.
          const fee = await pendingSwap.price(tx);
          if (fee && mounted.current)
            setNote(`Confirm in your wallet. ${newSlotFeeNote(fee)}`.trim());
          const reservation = await pendingSwap.reserve(
            { label: 'Skim to my wallet', deadline: 0n, sentAtMs: now() },
            'skim',
            tx,
          );
          intentId = reservation.id;
          // The wallet's chain again, last of the awaited reads (review R309-A4): the user may have switched
          // network meanwhile, and not every wallet enforces a request's chain ID. The checks below are synchronous.
          if (!(await walletOnChain(provider, network.chainId))) {
            await pendingSwap.rejected(intentId);
            intentId = undefined;
            throw new Error(
              `Your wallet is no longer on the ${wording.network} network. Nothing was sent. Select the network in your wallet and try again.`,
            );
          }
          if (
            !mounted.current ||
            currentWallet.current.provider !== provider ||
            currentWallet.current.account?.address !== account.address ||
            !pendingSwap.ready(intentId)
          ) {
            await pendingSwap.rejected(intentId);
            intentId = undefined;
            throw new Error(
              'The wallet or page context changed before the request. Nothing was sent.',
            );
          }
          hash = await sendTransaction(provider, {
            ...tx,
            nonce: reservation.nonce,
            ...(fee
              ? { maxPriorityFeePerGas: fee.maxPriorityFeePerGas, maxFeePerGas: fee.maxFeePerGas }
              : {}),
          });
          await pendingSwap.updateSubmission(intentId, hash);
          setNote('Skim submitted. Its outcome is tracked below; do not repeat it.');
        } catch (error) {
          if (intentId && !hash && (error as { code?: unknown })?.code === 4001) {
            await pendingSwap.rejected(intentId);
            setNote('The wallet request was rejected by you. Nothing was sent.');
          } else if (intentId) {
            await pendingSwap.updateSubmission(intentId, hash, submissionFeeNote(error));
            setNote('Skim submission outcome unknown. Check wallet activity; do not repeat it.');
          } else setNote(message(error, 'No wallet request was sent.'));
        }
      });
    } catch (error) {
      setNote(message(error, 'No wallet request was sent.'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={blocked ? 'form-error' : 'microcopy'} aria-label="Pending excess">
      Pending excess:{' '}
      {parts
        .filter(([amount]) => amount > 0n)
        .map(([amount, t]) => `${formatAmount(amount, t.decimals)} ${t.symbol}`)
        .join(' and ')}{' '}
      above the reserves.{' '}
      {closedByExcess(pool)
        ? minimums.some(([amount]) => amount > 0n)
          ? `This pool is closed: deposits, swaps into the full side, and swaps that take out less than ${minimums
              .filter(([amount]) => amount > 0n)
              .map(([amount, t]) => `${formatAmount(amount, t.decimals)} ${t.symbol}`)
              .join(' or ')} revert until someone calls skim. `
          : 'This pool is closed: swaps in both directions and deposits revert until someone calls skim. '
        : blocked && 'Swaps and deposits on that side revert until someone calls skim. '}
      Anyone can call <code>skim</code> on this pool; the caller receives the excess.{' '}
      {wallet.account && (
        <button
          className="button secondary"
          disabled={busy || pendingSwap.open}
          onClick={() => void skim()}
        >
          Skim to my wallet
        </button>
      )}
      {note && <span role="status"> {note}</span>}
    </div>
  );
}

function PoolsTable({
  snapshot,
  network,
  rpc,
  wallet,
  pendingSwap,
  now,
  heldToken,
}: {
  snapshot: Snapshot;
  network: MainnetNetwork;
  rpc: Rpc;
  wallet: Devnet4Wallet;
  pendingSwap: ReturnType<typeof usePendingSwap>;
  now: () => number;
  /** The bUSDC token while its exits to Ethereum are held or paused. */
  heldToken?: Address;
}) {
  const side = (reserve: bigint, excess: bigint, cap: bigint, t: LiveToken, closed: boolean) => {
    // Excess is in the balance, and the cap check reads the balance.
    const room = headroom(reserve + excess, cap);
    return (
      <>
        {formatAmount(cap, t.decimals)} {t.symbol} ({percent(reserve, cap)}% used)
        {cap > 0n && (
          <span
            className="cap-meter"
            aria-hidden="true"
            data-full={room === 0n || closed || undefined}
            style={
              { '--used': `${Math.min(100, Number(percent(reserve, cap)))}%` } as CSSProperties
            }
          />
        )}
        <br />
        <span className={room === 0n || closed ? 'form-error' : 'muted'}>
          {room === null
            ? 'Uncapped'
            : closed
              ? `${t.symbol} inflow closed until someone calls skim`
              : room === 0n
                ? `${t.symbol} inflow paused (at cap)`
                : `${formatAmount(room, t.decimals)} ${t.symbol} more can flow in`}
        </span>
      </>
    );
  };
  return (
    <div className="card pools-card">
      <h2>
        Pools at {wording.settled} block {snapshot.finalized.number.toString()}
      </h2>
      <table className="devnet4-pools pool-cards">
        <thead>
          <tr>
            <th scope="col">Pool</th>
            <th scope="col">Reserves</th>
            <th scope="col">Reserve caps</th>
          </tr>
        </thead>
        <tbody>
          {snapshot.pools.map((p) => (
            <tr key={p.address}>
              <th scope="row">
                {p.token0.symbol}/{p.token1.symbol}
                <br />
                <code>{short(p.address)}</code>
              </th>
              <td data-label="Reserves">
                {formatAmount(p.reserve0, p.token0.decimals)} {p.token0.symbol}
                <br />
                {formatAmount(p.reserve1, p.token1.decimals)} {p.token1.symbol}
                <PendingExcess
                  pool={p}
                  network={network}
                  rpc={rpc}
                  wallet={wallet}
                  pendingSwap={pendingSwap}
                  now={now}
                />
                {heldToken &&
                  [p.token0, p.token1].some(
                    (t) => t.address.toLowerCase() === heldToken.toLowerCase(),
                  ) && (
                    <div className="form-error" role="alert" aria-label="Held exit LP notice">
                      <AlertTriangle size={14} /> Removing liquidity from this pool pays you bUSDC
                      that cannot leave to Ethereum right now (see the bridge notice above). Your
                      pool share is not affected; only the exit of the bUSDC is.
                    </div>
                  )}
                {atKCeiling(p) && !closedByExcess(p) && (
                  <div className="microcopy" aria-label="K ceiling">
                    At the pool&apos;s k ceiling: deposits revert with BDEX: K_CEILING. Swaps still
                    run, but their fee stays outside the reserves, so liquidity providers and the
                    protocol earn nothing from it, and anyone can collect it with skim.
                  </div>
                )}
              </td>
              <td data-label="Reserve caps">
                {side(p.reserve0, p.excess?.excess0 ?? 0n, p.cap0, p.token0, closedByExcess(p))}
                <br />
                {side(p.reserve1, p.excess?.excess1 ?? 0n, p.cap1, p.token1, closedByExcess(p))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SwapPanel({
  network,
  deployment: d,
  multicall3,
  snapshot,
  rpc,
  wallet,
  now,
  pendingSwap,
  hold = null,
  holdToken,
  confirmation,
  receiptPollMs,
  onRefresh,
  memory,
  freshness,
  busyRef,
  railSlot,
  lastOutcome,
}: {
  network: MainnetNetwork;
  deployment: DevnetDeployment;
  multicall3?: Address;
  snapshot: Snapshot;
  rpc: Rpc;
  wallet: Devnet4Wallet;
  now: () => number;
  pendingSwap: ReturnType<typeof usePendingSwap>;
  hold?: BridgeHold | null;
  holdToken?: Address;
  confirmation?: ConfirmationView;
  receiptPollMs?: number;
  /** The page's own Refresh (a new snapshot block); offered inside an alert that a newer block can clear. */
  onRefresh?: () => void;
  /** Set on a network whose snapshot block is renewed by a timer: the form's inputs survive the remount. */
  memory?: MutableRefObject<FormMemory | null>;
  /** Set on the same networks: the snapshot's age bound, renewed on demand before a quote or a swap. */
  freshness?: Freshness;
  /** Told while a wallet request of this card is in flight, so a timed renewal waits. */
  busyRef?: MutableRefObject<boolean>;
  /** Layout: on a wide screen a hold's recovery controls are drawn here, beside the gate. */
  railSlot?: HTMLElement | null;
  /** Layout: the state of the last transaction tracked in this visit, for the lamp. */
  lastOutcome?: MutableRefObject<string | null>;
}) {
  const [holdAccepted, setHoldAccepted] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const options = useMemo<Option[]>(
    () =>
      snapshot.tokens.map((token) =>
        token.wrapped
          ? { key: token.address, label: wording.native, token, native: true }
          : { key: token.address, label: token.symbol, token, native: false },
      ),
    [snapshot],
  );
  // Read once, at mount: the inputs of the card this one replaces after a renewed snapshot (public networks).
  const [kept] = useState(() => {
    const m = memory?.current ?? null;
    return m && options.some((o) => o.key === m.inKey) && options.some((o) => o.key === m.outKey)
      ? m
      : null;
  });
  const [inKey, setInKey] = useState(kept?.inKey ?? options[0]?.key ?? '');
  const [outKey, setOutKey] = useState(kept?.outKey ?? options[1]?.key ?? '');
  const [amount, setAmount] = useState(kept?.amount ?? '');
  const [slippage, setSlippage] = useState(
    kept?.slippage ?? (DEFAULT_SLIPPAGE_BPS / 100).toFixed(2),
  );
  // 2 once the user took the page's one retry after a revert on the minimum (DEX-5).
  const [attempt, setAttempt] = useState<1 | 2>(1);
  const [deadline, setDeadline] = useState(
    kept?.deadline ?? String(network.defaultDeadlineMinutes ?? DEFAULT_DEADLINE_MINUTES),
  );
  const [quote, setQuote] = useState<LensQuote | null>(null);
  const [blocked, setBlocked] = useState<RouteCheck[]>([]);
  const [quoteNote, setQuoteNote] = useState('');
  const [check, setCheck] = useState<QuoteCheck | null>(null);
  // True once the user accepted a latest-block price in place of the finalized one.
  const [reconfirmed, setReconfirmed] = useState(false);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!busyRef) return;
    busyRef.current = busy;
    return () => {
      busyRef.current = false;
    };
  }, [busy, busyRef]);
  // Presentation the remount would undo, noted as it happens (a remounted card reads the memory while it renders,
  // before the old card is gone): the focused field, the open settings, the open quote details.
  const shown = useRef({
    focus: kept?.focus ?? null,
    settingsOpen: kept?.settingsOpen ?? false,
    detailsOpen: kept?.detailsOpen ?? false,
  });
  const note = (patch: Partial<(typeof shown)['current']>) => {
    shown.current = { ...shown.current, ...patch };
    if (memory?.current) memory.current = { ...memory.current, ...shown.current };
  };
  // After a transaction of this card the form starts empty, as before: nothing is kept while a hold is open or
  // a wallet request is in flight, nor after a transaction of this card got a hash until the user edits the form
  // again (R344-UI-6: else the card came back after a mined swap with the same amount and a fresh quote).
  const sentSinceEdit = useRef(false);
  const hashedSeen = useRef(0);
  const hashed = steps.filter((s) => s.hash).length;
  if (pendingSwap.open || hashed > hashedSeen.current) {
    sentSinceEdit.current = true;
    hashedSeen.current = hashed;
  }
  // Set when this card asks for a renewal itself; the new card reads it from the memory and says why.
  const renewing = useRef<RenewalReason | null>(null);
  useEffect(() => {
    if (!memory) return;
    memory.current =
      pendingSwap.open || busy || sentSinceEdit.current
        ? null
        : {
            inKey,
            outKey,
            amount,
            slippage,
            deadline,
            quoted: !!quote || quoting,
            ...shown.current,
            ...(renewing.current ? { renewal: renewing.current } : {}),
          };
  });
  // What the background renewal reads of this card: when the user last typed or chose, and whether a quote is on
  // screen (it is then left alone; a quote past the bound is renewed by the Swap button instead).
  const edited = () => {
    // Refs only: a state update here would re-render a controlled <select> between its input and change events
    // and put its old value back.
    sentSinceEdit.current = false;
    if (freshness) freshness.activity.current.editedAt = monotonicMs();
  };
  useEffect(() => {
    if (!freshness) return;
    const activity = freshness.activity;
    activity.current.quoteOnScreen = !!quote;
    return () => {
      activity.current.quoteOnScreen = false;
    };
  }, [quote, freshness]);
  const renewedBy = kept?.renewal ?? null;
  useLayoutEffect(() => {
    const field = kept?.focus
      ? cardRef.current?.querySelector<HTMLInputElement>(`input[data-field="${kept.focus}"]`)
      : null;
    if (field) {
      field.focus();
      // The cursor goes back to the end of what was typed.
      field.setSelectionRange(field.value.length, field.value.length);
    }
    // At mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const tracked = pendingSwap.tracked;
  const historyAccount = wallet.account?.address as Address | undefined;
  const [history, setHistory] = useState<FinishedTx[]>(() =>
    historyAccount ? loadHistory(network.chainId, historyAccount) : [],
  );
  const remember = (tx: { label: string; hash?: Hex; state: string; detail?: string }) => {
    if (!historyAccount || !tx.hash) return;
    if (!['mined', 'failed', 'unknown', 'expired', 'replaced'].includes(tx.state)) return;
    // Only these fields: a tracked swap also carries a bigint deadline, which JSON cannot store.
    const entry: FinishedTx = {
      label: tx.label,
      hash: tx.hash,
      state: tx.state as FinishedTx['state'],
      ...(tx.detail ? { detail: tx.detail } : {}),
    };
    setHistory((list) => recordFinished(network.chainId, historyAccount, list, entry));
  };
  useEffect(() => {
    if (tracked && tracked.hash) remember(tracked);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tracked?.hash, tracked?.state]);
  // Bumped on every form change. A reply or a send that started under an older
  // value belongs to a form the user has since changed, and is dropped.
  const formGeneration = useRef(0);
  const currentWallet = useRef(wallet);
  currentWallet.current = wallet;
  useEffect(
    () => () => {
      formGeneration.current++;
    },
    [],
  );
  const lastQuoteRequest = useRef(0);
  // A quote that was on screen when the snapshot was renewed is asked again, once, by the unchanged getQuote().
  const [requote, setRequote] = useState(kept?.quoted ? 1 : 0);
  const input = options.find((o) => o.key === inKey);
  const output = options.find((o) => o.key === outKey);
  const amountIn = input ? parseAmount(amount, input.token.decimals) : null;
  const slippageBps = parseAmount(slippage, 2);
  const slippageValid = slippageBps !== null && isAllowedSlippageBps(slippageBps);
  const deadlineMinutes = /^[0-9]{1,3}$/.test(deadline) ? Number(deadline) : NaN;
  const deadlineValid =
    deadlineMinutes >= MIN_DEADLINE_MINUTES && deadlineMinutes <= MAX_DEADLINE_MINUTES;
  const account = wallet.account?.address.toLowerCase() as Address | undefined;
  const onChain = wallet.account ? BigInt(wallet.account.chainId) === BigInt(d.chainId) : false;
  const at = snapshot.finalized.hash;

  useEffect(() => {
    let current = true;
    setBalances(null);
    if (account)
      void readBalances(rpc, at, account, snapshot.tokens, multicall3)
        .then((b) => current && setBalances(b))
        .catch(() => current && setBalances(null));
    return () => {
      current = false;
    };
  }, [rpc, at, account, snapshot, multicall3]);

  useEffect(() => {
    let current = true;
    setAllowance(null);
    if (account && input && !input.native)
      void readAllowance(rpc, at, input.token.address, account, d.router)
        .then((value) => {
          if (current) setAllowance(value);
        })
        .catch(() => {
          if (current) setAllowance(null);
        });
    return () => {
      current = false;
    };
  }, [account, input, rpc, at, d.router]);

  const clear = () => (
    formGeneration.current++,
    setQuote(null),
    setBlocked([]),
    setQuoteNote(''),
    setCheck(null),
    setReconfirmed(false)
  );

  /** Compare the active quote with the latest block; a failed read never hides the finalized quote. */
  async function crossCheck(
    active: LensQuote,
    previous: QuoteCheck | null,
    generation: number,
  ): Promise<QuoteCheck> {
    const last =
      previous?.status === 'ok'
        ? previous.latest
        : previous?.status === 'unknown'
          ? previous.last
          : undefined;
    let result: QuoteCheck = { status: 'unknown', last };
    try {
      const latest = await quoteExactInput(
        rpc,
        d,
        input!.token.address,
        output!.token.address,
        active.amountIn,
        Number(slippageBps),
        'latest',
      );
      result = compareQuotes(active, latest);
    } catch {
      // Stays 'unknown'.
    }
    if (generation === formGeneration.current) setCheck(result);
    return result;
  }

  function reconfirm() {
    if (check?.status !== 'worse') return;
    setQuote(check.latest);
    setCheck({ status: 'ok', latest: check.latest });
    setReconfirmed(true);
  }

  async function getQuote() {
    clear();
    const generation = formGeneration.current;
    const request = ++lastQuoteRequest.current;
    // The form changed during the read: this reply is dropped, and the newest
    // request is asked again with what the form says now.
    const superseded = () => {
      if (generation === formGeneration.current) return false;
      if (request === lastQuoteRequest.current) setRequote((n) => n + 1);
      return true;
    };
    if (!input || !output || input.key === output.key)
      return setQuoteNote('Choose two different tokens.');
    if (!amountIn || amountIn <= 0n) return setQuoteNote('Enter an amount.');
    if (!slippageValid)
      return setQuoteNote(
        `Use a slippage tolerance of 0.01% to ${(MAX_SLIPPAGE_BPS / 100).toFixed(2)}%.`,
      );
    if (!deadlineValid)
      return setQuoteNote(
        `Use a deadline of ${MIN_DEADLINE_MINUTES} to ${MAX_DEADLINE_MINUTES} minutes.`,
      );
    try {
      const q = await quoteExactInput(
        rpc,
        d,
        input.token.address,
        output.token.address,
        amountIn,
        Number(slippageBps),
        { blockHash: at },
      );
      if (superseded()) return;
      if (!q) {
        const checks = routesFor(d, input.token.address, output.token.address).map((path) =>
          checkRoute(snapshot.pools, path, amountIn),
        );
        setBlocked(checks.filter((c) => c.block));
        return setQuoteNote(
          `No route can fill this amount at the ${wording.settled} block; the swap would revert.`,
        );
      }
      setQuote(q);
      await crossCheck(q, null, generation);
    } catch (error) {
      if (superseded()) return;
      setQuoteNote(message(error, 'Quote unavailable.'));
    }
  }

  // R328-3P-2: a quote is never built on a snapshot past the age bound (public networks): the card asks the route
  // for a newer block first, keeps its inputs across the remount (memory, with `quoted` so the new card quotes at
  // the new block through the unchanged getQuote()), and the new card says why. While a hold is open or a wallet
  // request is in flight the remount would clear what the card holds, so no quote is read and the card says so.
  const stale = () => !!freshness && staleAt(freshness.ageMs(), freshness.maxAgeMs);
  // A renewal that read the same block again does not remount the card (its key is the block hash): the card then
  // quotes itself, on the renewed (fresh) snapshot.
  const firstSnapshot = useRef(snapshot);
  useEffect(() => {
    if (snapshot === firstSnapshot.current || !renewing.current) return;
    renewing.current = null;
    void getQuote().finally(() => setQuoting(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);
  function renewFirst(reason: RenewalReason, now = true) {
    if (!freshness) return;
    if (pendingSwap.open || busy)
      return setQuoteNote(
        cannotRenewText(pendingSwap.open ? 'hold' : 'wallet-request', freshness.maxAgeMs),
      );
    renewing.current = reason;
    setQuoting(true);
    // `now` false: the user is typing (a reply superseded by an edit); the background renewal takes it once the
    // user pauses, and the remounted card quotes then.
    if (now) freshness.renew();
  }
  function quoteOrRenew() {
    // A press of Get quote ends the entry: an UNCONFIRMED refusal of this quote may renew at once.
    if (freshness) freshness.activity.current.editedAt = -Infinity;
    if (stale()) return renewFirst('quote');
    setQuoting(true);
    void getQuote().finally(() => setQuoting(false));
  }
  useEffect(() => {
    if (requote > 0) {
      if (stale()) {
        const since = monotonicMs() - (freshness?.activity.current.editedAt ?? -Infinity);
        return renewFirst('quote', since >= entryQuietMs(freshness!.maxAgeMs));
      }
      void getQuote();
    }
    // Runs only when a reply was dropped, with the form of this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requote]);
  // Once per card that was not itself made for this reason: a pinned quote read refused as UNCONFIRMED (one endpoint
  // no longer serves the block) is asked again at a newer block. Never while the user is typing.
  const refusedUnconfirmed =
    !!freshness && !!quoteNote && classifyReadFailure(quoteNote).kind === 'unconfirmed';
  useEffect(() => {
    if (!refusedUnconfirmed || renewedBy === 'unconfirmed' || renewing.current) return;
    const since = monotonicMs() - freshness!.activity.current.editedAt;
    if (since < entryQuietMs(freshness!.maxAgeMs)) return;
    renewFirst('unconfirmed');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refusedUnconfirmed]);

  /**
   * Persist the intent before calling the wallet. A missing hash after that
   * boundary is an unknown outcome, unless the user explicitly rejected it.
   */
  async function run(
    label: string,
    build: () => Parameters<typeof sendTransaction>[1],
    swapInfo?: { deadline: bigint; retry: SwapRetryInfo },
  ) {
    const provider = wallet.provider;
    if (!provider || pendingSwap.holds()) return false;
    const generation = formGeneration.current;
    setBusy(true);
    const index = steps.length;
    const update = (step: Step) => {
      setSteps((all) => [...all.slice(0, index), step]);
      remember(step);
    };
    update({ label, state: 'waiting', detail: 'Confirm in your wallet.' });
    let hash: Hex | undefined;
    let intentId: string | undefined;
    try {
      return await pendingSwap.withWalletRequest(async () => {
        try {
          await ensureChain(provider, addChainParameters(network));
          await requireFinality(rpc);
          if (generation !== formGeneration.current)
            throw new Error('The form changed, so nothing was sent. Get a new quote.');
          const tx = { ...build(), chainId: network.chainId };
          // Priced before the intent is saved: a failure here leaves nothing behind.
          const fee = await pendingSwap.price(tx);
          if (generation !== formGeneration.current)
            throw new Error('The form changed, so nothing was sent. Get a new quote.');
          if (fee)
            update({
              label,
              state: 'waiting',
              detail: `Confirm in your wallet. ${newSlotFeeNote(fee)}`.trim(),
            });
          const reservation = await pendingSwap.reserve(
            {
              label,
              deadline: swapInfo?.deadline ?? 0n,
              sentAtMs: now(),
              ...(swapInfo ? { retry: swapInfo.retry } : {}),
            },
            swapInfo ? 'swap' : 'approval',
            tx,
          );
          intentId = reservation.id;
          // The wallet's chain again, last of the awaited reads (review R309-A4): the user may have switched
          // network meanwhile, and not every wallet enforces a request's chain ID. The checks below are synchronous.
          if (!(await walletOnChain(provider, network.chainId))) {
            await pendingSwap.rejected(intentId);
            intentId = undefined;
            throw new Error(
              `Your wallet is no longer on the ${wording.network} network. Nothing was sent. Select the network in your wallet and try again.`,
            );
          }
          if (
            generation !== formGeneration.current ||
            currentWallet.current.provider !== provider ||
            currentWallet.current.account?.address !== wallet.account?.address ||
            !pendingSwap.ready(intentId)
          ) {
            await pendingSwap.rejected(intentId);
            intentId = undefined;
            throw new Error(
              'The form or wallet context changed before the wallet request. Nothing was sent. Get a new quote.',
            );
          }
          hash = await sendTransaction(provider, {
            ...tx,
            nonce: reservation.nonce,
            ...(fee
              ? { maxPriorityFeePerGas: fee.maxPriorityFeePerGas, maxFeePerGas: fee.maxFeePerGas }
              : {}),
          });
          await pendingSwap.updateSubmission(intentId, hash);
          setSteps((all) => all.slice(0, index));
          // The shared tracker authenticates the call and its finalized receipt.
          // Approval allowance is reread from finalized state after settlement.
          return false;
        } catch (error) {
          if (intentId && !hash && (error as { code?: unknown })?.code === 4001) {
            await pendingSwap.rejected(intentId);
            update({
              label,
              state: 'failed',
              detail: 'The wallet request was rejected by you. Nothing was sent.',
            });
          } else if (intentId) {
            await pendingSwap.updateSubmission(intentId, hash, submissionFeeNote(error));
            setSteps((all) => all.slice(0, index));
          } else
            update({
              label,
              state: 'failed',
              detail: message(error, 'No wallet request was sent.'),
            });
          return false;
        }
      });
    } catch (error) {
      update({ label, state: 'failed', detail: message(error, 'No wallet request was sent.') });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function swap(active: LensQuote) {
    setBusy(true);
    const generation = formGeneration.current;
    try {
      if (pendingSwap.holds()) return;
      // The price may have moved while the form was open.
      const fresh = await crossCheck(active, check, generation);
      if (generation !== formGeneration.current)
        return setQuoteNote('The form changed, so nothing was sent. Get a new quote.');
      if (blocksSwap(fresh)) return;
      const signed = signedQuote(active, fresh);
      const label = `Swap ${formatAmount(signed.amountIn, input!.token.decimals)} ${input!.label} for ${output!.label}`;
      const head = (await rpc('eth_getBlockByNumber', ['latest', false])) as {
        timestamp?: unknown;
      } | null;
      if (!head || typeof head.timestamp !== 'string' || !/^0x[0-9a-f]+$/i.test(head.timestamp))
        return setQuoteNote(`The latest ${wording.block} could not be read, so nothing was sent.`);
      const clock = swapClock(now(), BigInt(head.timestamp), network.idle, deadlineMinutes);
      if (!clock.ok) return setQuoteNote(clock.problem);
      // An idle L2 does not close the page: the user is told the wait, and the deadline covers it.
      if (clock.notice) setQuoteNote(clock.notice);
      const deadline = clock.deadline;
      const retry: SwapRetryInfo = {
        tokenIn: input!.token.address,
        tokenOut: output!.token.address,
        amountIn: signed.amountIn,
        path: [...signed.path],
        minimumOut: signed.minimumOut,
        slippageBps: Number(slippageBps),
        attempt,
      };
      await run(
        label,
        () =>
          swapTransaction(
            d,
            signed,
            { token: input!.token.address, native: input!.native },
            { token: output!.token.address, native: output!.native },
            account!,
            deadline,
          ),
        { deadline, retry },
      );
    } finally {
      setBusy(false);
    }
  }

  /** Refill the form with the reverted swap at the retry tolerance and quote it again. */
  function retryAt(info: SwapRetryInfo, bps: number) {
    const from = options.find((o) => o.token.address === info.tokenIn);
    const to = options.find((o) => o.token.address === info.tokenOut);
    if (!from || !to || !isAllowedSlippageBps(bps)) return;
    edited();
    clear();
    setInKey(from.key);
    setOutKey(to.key);
    setAmount(formatAmount(info.amountIn, from.token.decimals));
    setSlippage((bps / 100).toFixed(2));
    setAttempt(2);
    setRequote((n) => n + 1);
  }
  const offer =
    tracked?.state === 'failed' && tracked.retry && tracked.cause
      ? retryOffer(tracked.retry, tracked.cause)
      : null;

  const needsApproval = !!quote && !!input && !input.native && (allowance ?? 0n) < quote.amountIn;
  // Round 20: a token whose approve reverts when a non-zero allowance is changed to another non-zero amount
  // (Tether on Ethereum; the record's `approveZeroFirst`). While an allowance from an earlier quote stands, the
  // exact approval would revert: the page asks for a reset to zero first, and offers no approval while the
  // allowance of such a token has not been read.
  const zeroFirst = !!input && !input.native && input.token.approveZeroFirst === true;
  const needsReset = needsApproval && zeroFirst && (allowance ?? 0n) > 0n;
  const allowanceUnread = needsApproval && zeroFirst && allowance === null;
  const balanceIn =
    balances && input
      ? input.native
        ? balances.native
        : (balances.tokens.get(input.token.address) ?? 0n)
      : null;
  const shortBalance = !!quote && balanceIn !== null && balanceIn < quote.amountIn;
  const signed = quote ? signedQuote(quote, check) : null;
  const tightened = !!quote && !!signed && signed.minimumOut > quote.minimumOut;
  const staleForm = !!quote && quote.amountIn !== amountIn;
  const buysHeld =
    !!output && !!holdToken && output.token.address.toLowerCase() === holdToken.toLowerCase();
  const holdBlocksSend = buysHeld && exitsBlocked(hold) && !holdAccepted;
  const uses = signed ? headroomUse(snapshot.pools, signed.path, signed.amounts) : [];
  const symbolOf = (a: Address) => options.find((o) => o.token.address === a)?.label ?? short(a);
  // The token of a leg changes through one handler, whether the select or the token sheet asks.
  const choosePay = (key: string) => (edited(), setInKey(key), setAttempt(1), clear());
  const chooseReceive = (key: string) => (edited(), setOutKey(key), setAttempt(1), clear());
  const choices = options.map((o) => ({
    key: o.key,
    label: o.label,
    detail: balances
      ? o.native
        ? formatAmount(balances.native, 18, 6)
        : formatAmount(balances.tokens.get(o.token.address) ?? 0n, o.token.decimals)
      : undefined,
  }));
  const rate =
    quote && signed && input
      ? quoteRate(quote.amountIn, input.token.decimals, signed.amountOut)
      : null;
  // Presentation only: the line that says what the buttons below will do next.
  const next = nextStep({
    connected: !!wallet.account,
    walletPending: wallet.pending,
    onChain,
    chainId: d.chainId,
    storageBlocked: !!pendingSwap.storageProblem || !!pendingSwap.unreadable,
    busy,
    holdOpen: pendingSwap.open,
    hasQuote: !!quote,
    staleForm,
    shortBalance,
    quoteBlocked: blocksSwap(check),
    approval:
      needsApproval && quote && input
        ? `Approve ${formatAmount(quote.amountIn, input.token.decimals)} ${input.label}`
        : null,
    acknowledgementMissing: holdBlocksSend,
  });
  // Presentation: a quote refused because the endpoints disagree, did not confirm or limit requests is named
  // (ui/read-failure.ts); every other note is shown as before.
  // The same naming for an endpoint problem the tracker states in a held transaction's own sentence.
  const holdKind =
    tracked && (tracked.state === 'pending' || tracked.state === 'unknown')
      ? classifyReadFailure(tracked.detail)
      : null;
  // Only the two refusals the page itself writes (multichain/rpc.ts); a wallet's own error text is not renamed.
  const holdTrouble =
    holdKind &&
    (holdKind.kind === 'unconfirmed' ||
      holdKind.kind === 'behind' ||
      holdKind.kind === 'disagreement')
      ? holdKind
      : null;
  const quoteKind = quoteNote ? classifyReadFailure(quoteNote) : null;
  const quoteFailure = quoteKind && quoteKind.kind !== 'other' ? quoteKind : null;
  const earlier = history.filter(
    (h) => !steps.some((x) => x.hash === h.hash) && tracked?.hash !== h.hash,
  );
  // Presentation only: the lamp over the gate (gate/lamp.ts) and the pool-depth picture of the quote
  // (gate/pool-depth.ts), both from values this card already holds. Nothing reads them back.
  const wide = useWide();
  const beside = (node: ReactNode) => (wide && railSlot ? createPortal(node, railSlot) : node);
  if (lastOutcome && tracked) lastOutcome.current = tracked.state;
  const lamp = lampState({
    quoting,
    hasQuote: !!quote,
    busy,
    holdOpen: pendingSwap.open,
    tracked: tracked?.state ?? lastOutcome?.current ?? undefined,
    lastStep: steps[steps.length - 1]?.state,
    refused:
      !!quoteNote ||
      blocked.length > 0 ||
      blocksSwap(check) ||
      shortBalance ||
      !!pendingSwap.storageProblem,
    caution: holdBlocksSend || !!pendingSwap.unreadable || (!!wallet.account && !onChain),
  });
  const depth = signed ? poolDepth(snapshot.pools, signed.path, signed.amounts) : null;

  // The tracked transaction's text, with the idle-chain explanation (the exact sentence pendingswap.ts appended)
  // set apart so it can sit behind "Why is this waiting?". No word is changed or dropped.
  const idleNote = tracked
    ? idleWaitNote(tracked, network.noIdleHeartbeat ? 0 : longestQuiet(network.idle))
    : '';
  const held =
    tracked && idleNote && tracked.detail.includes(idleNote)
      ? { visible: tracked.detail.replace(idleNote, ''), why: idleNote.trim() }
      : { visible: tracked?.detail ?? '', why: '' };
  // Blocks of the card that change place while a hold is open (alerts, then the tracked transaction and its
  // recovery controls, come directly under the form). The same elements in either place; nothing is duplicated.
  const staleAlerts = quote && signed && input && output && (
    <>
      {check?.status === 'worse' && (
        <div className="form-error" role="alert" aria-label="Stale quote">
          <AlertTriangle size={16} /> The price moved after the {wording.settled} block. At the
          latest block this swap returns{' '}
          {formatAmount(check.latest.amountOut, output.token.decimals)} {output.label},{' '}
          {percent(check.worseBps, 10_000n)}% worse than this quote and below your minimum received,
          so it would revert. Reconfirm to use the latest price, or change the amount.{' '}
          <button className="button secondary" onClick={reconfirm}>
            Reconfirm at the latest price
          </button>
        </div>
      )}
      {check?.status === 'unavailable' && (
        <p className="form-error" role="alert" aria-label="Stale quote">
          At the latest block no route can fill this amount, so the swap would revert. Lower the
          amount or get a new quote.
        </p>
      )}
    </>
  );
  const nextLine = (
    <p className="next-step" data-tone={next.tone} data-testid="next-step">
      {next.text}
    </p>
  );
  const recoveryBlock = (
    <>
      {tracked?.intent && (tracked.state === 'pending' || tracked.state === 'unknown') && (
        <SubmissionRecovery key={tracked.intent.id} pendingSwap={pendingSwap} />
      )}
    </>
  );
  const activityBlock = (
    <>
      <h3 className="activity-title">Activity</h3>
      {wallet.account && earlier.length === 0 && steps.length === 0 && !tracked && (
        <p className="activity-empty">No transactions from this page yet.</p>
      )}
      {!wallet.account && (
        <p className="activity-empty">Transactions you send from this page are listed here.</p>
      )}
      {history.some((h) => !steps.some((s) => s.hash === h.hash) && tracked?.hash !== h.hash) && (
        <ol className="devnet4-steps" aria-label="Earlier transactions">
          {history
            .filter((h) => !steps.some((s) => s.hash === h.hash) && tracked?.hash !== h.hash)
            .map((h) => (
              <li key={h.hash} data-state={h.state}>
                <strong>{h.label}</strong>: {h.state}{' '}
                <ExplorerLink network={network} kind="tx" value={h.hash} />
                {h.detail && <span className="muted"> {worded(h.detail)}</span>}
              </li>
            ))}
        </ol>
      )}
      {(steps.length > 0 || tracked) && (
        <ol className="devnet4-steps" aria-label="Transactions">
          {steps.map((s, i) => (
            <li key={i} data-state={s.state}>
              <strong>{s.label}</strong>: {s.state}
              {s.hash && (
                <>
                  {' '}
                  <ExplorerLink network={network} kind="tx" value={s.hash} />
                </>
              )}
              {s.state === 'waiting' && <Passage stage="wallet" settled={wording.settled} />}
              {s.detail && <span className="muted"> {worded(s.detail)}</span>}
            </li>
          ))}
          {tracked && (
            <li data-state={tracked.state}>
              <strong>{tracked.label}</strong>: <span className="state-pill">{tracked.state}</span>{' '}
              {tracked.hash && <ExplorerLink network={network} kind="tx" value={tracked.hash} />}
              <Passage
                stage={passageStage(tracked.state, !!tracked.hash)}
                settled={wording.settled}
              />
              <span className="muted">
                {' '}
                <Lines text={worded(held.visible)} />
              </span>
              {holdTrouble && (
                <span className="confirm-trouble hold-trouble" role="status">
                  <strong>{holdTrouble.title}.</strong> The page keeps trying by itself; the hold
                  stays until the outcome is verified. Your transaction is not affected.
                </span>
              )}
              {confirmation &&
                tracked.hash &&
                (tracked.state === 'pending' || tracked.state === 'unknown') && (
                  <ConfirmationProgress
                    rpc={rpc}
                    hash={tracked.hash}
                    rule={confirmation.rule}
                    blockSeconds={confirmation.blockSeconds}
                    pollMs={receiptPollMs}
                    reverted={tracked.intent?.kind === 'swap' ? confirmation.reverted : undefined}
                    now={now}
                  />
                )}
              {tracked.deadline > 0n &&
                (tracked.state === 'pending' || tracked.state === 'unknown') && (
                  <DeadlineClock
                    deadline={tracked.deadline}
                    sentAtMs={tracked.sentAtMs}
                    now={now}
                    settled={wording.settled}
                  />
                )}
              {held.why && (
                <Disclosure clip className="hold-why" summary={() => 'Why is this waiting?'}>
                  <p>{held.why}</p>
                </Disclosure>
              )}
              {tracked.state === 'failed' && tracked.retry && tracked.cause && (
                <p className="notice" role="status" aria-label="Why the swap reverted">
                  {worded(revertText(tracked.retry, tracked.cause))}
                  {offer?.kind === 'retry' && (
                    <>
                      {' '}
                      <button
                        className="button secondary"
                        disabled={busy || pendingSwap.open || attempt === 2}
                        onClick={() => retryAt(tracked.retry!, offer.slippageBps)}
                      >
                        Retry once at {(offer.slippageBps / 100).toFixed(2)}%
                      </button>
                    </>
                  )}
                </p>
              )}
            </li>
          )}
        </ol>
      )}
    </>
  );
  return (
    <div
      ref={cardRef}
      onFocusCapture={(e) => note({ focus: (e.target as HTMLElement).dataset?.field ?? null })}
      onInputCapture={edited}
      onBlurCapture={() => note({ focus: null })}
      className="card devnet4-swap swap-card"
      data-phase={quote ? 'quoted' : 'form'}
      data-quoting={quoting || undefined}
      data-hold={pendingSwap.open || undefined}
      data-lamp={lamp}
    >
      <GateArch anchor />
      <h2>Swap</h2>
      <div className="devnet4-form swap-form">
        <div className="swap-leg" data-leg="pay">
          <label className="field-label token-field">
            You pay
            <select
              className="token-native-select"
              tabIndex={-1}
              aria-hidden="true"
              value={inKey}
              onChange={(e) => choosePay(e.target.value)}
            >
              {options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <TokenSheet caption="You pay" value={inKey} options={choices} onChoose={choosePay} />
          <label
            className="field-label amount-field"
            style={{ '--chars': Math.max(1, amount.length) } as CSSProperties}
          >
            Amount
            <input
              className="text-input amount-input"
              data-field="amount"
              inputMode="decimal"
              placeholder="0"
              autoComplete="off"
              spellCheck={false}
              value={amount}
              onChange={(e) => (setAmount(e.target.value), setAttempt(1), clear())}
            />
          </label>
        </div>
        {/* The same two handlers the token sheets call, with the two tokens exchanged. */}
        <button
          type="button"
          className="swap-gate"
          aria-label="Exchange the pay and receive tokens"
          title="Exchange the pay and receive tokens"
          onClick={() => {
            const [pay, receive] = [inKey, outKey];
            choosePay(receive);
            chooseReceive(pay);
          }}
        >
          <GateGlyph />
          <ArrowDownUp size={12} aria-hidden="true" className="swap-gate-arrows" />
        </button>
        <div className="swap-leg" data-leg="receive">
          <label className="field-label token-field">
            You receive
            <select
              className="token-native-select"
              tabIndex={-1}
              aria-hidden="true"
              value={outKey}
              onChange={(e) => chooseReceive(e.target.value)}
            >
              {options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <TokenSheet
            caption="You receive"
            value={outKey}
            options={choices}
            onChoose={chooseReceive}
          />
          {/* Mirror of "Expected output" in the quote below, which is the accessible figure. */}
          <div className="amount-field amount-mirror" aria-hidden="true">
            <Figure
              className="amount-output"
              empty={!(quote && signed && output)}
              text={
                quote && signed && output
                  ? formatAmount(signed.amountOut, output.token.decimals)
                  : '\u2014'
              }
            />
          </div>
        </div>
        <Disclosure
          className="swap-settings"
          defaultOpen={kept?.settingsOpen}
          onToggle={(open) => note({ settingsOpen: open })}
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
                data-field="slippage"
                inputMode="decimal"
                value={slippage}
                onChange={(e) => (setSlippage(e.target.value), clear())}
              />
            </label>
            <label className="field-label">
              Deadline (minutes)
              <input
                className="text-input"
                data-field="deadline"
                inputMode="numeric"
                value={deadline}
                onChange={(e) => (setDeadline(e.target.value), clear())}
              />
            </label>
            <p className="microcopy" aria-label="Slippage note">
              Plan to lose up to this share of your output. Block order follows the tip paid, so
              someone can trade just before and after you and keep the difference, up to your
              minimum. Keep it low, and split large swaps.
            </p>
          </div>
        </Disclosure>
        <button
          className="button secondary get-quote"
          aria-busy={quoting || undefined}
          onClick={() => {
            // Presentation: the card shows that a quote is being read. getQuote itself is unchanged; on a snapshot
            // past the age bound the card first asks for a newer block (R328-3P-2).
            quoteOrRenew();
          }}
        >
          {quoting ? (
            <LoaderCircle size={16} className="spin" aria-hidden="true" />
          ) : (
            quote && <RefreshCw size={14} aria-hidden="true" className="requote-icon" />
          )}
          Get quote
        </button>
        {renewedBy &&
          freshness &&
          // Until the user changes the form the renewal was made for.
          kept?.inKey === inKey &&
          kept.outKey === outKey &&
          kept.amount === amount &&
          kept.slippage === slippage &&
          kept.deadline === deadline && (
          <p className="microcopy renewal-note" role="status" data-testid="renewal-note">
            {renewalText(renewedBy, freshness.maxAgeMs)}
          </p>
        )}
      </div>
      {balances && (
        <p className="microcopy balances-line" aria-label={`${settledCapital()} balances`}>
          Your balances at {wording.settled} block {snapshot.finalized.number.toString()}:{' '}
          {options
            .map((o) =>
              o.native
                ? `${formatAmount(balances.native, 18, 6)} ${wording.native}`
                : `${formatAmount(balances.tokens.get(o.token.address) ?? 0n, o.token.decimals)} ${o.label}`,
            )
            .join(' · ')}
        </p>
      )}
      {quoteNote && (
        <p className="form-error" role="alert" data-kind={quoteFailure?.kind}>
          {quoteFailure && <strong className="alert-title">{quoteFailure.title}. </strong>}
          {worded(quoteNote)}
          {quoteFailure && <span className="alert-advice"> {quoteFailure.quoteAdvice}</span>}
          {quoteFailure?.refresh && onRefresh && (
            <button type="button" className="button secondary" onClick={onRefresh}>
              <RefreshCw size={16} aria-hidden="true" /> Refresh
            </button>
          )}
        </p>
      )}
      {blocked.length > 0 && (
        <ul className="mainnet-blocked" aria-label="Why this swap would revert">
          {blocked.map((c) => (
            <li key={c.path.join('-')}>
              <strong>{c.path.map(symbolOf).join(' → ')}</strong>: {explainBlock(c.block!)}
            </li>
          ))}
        </ul>
      )}
      {pendingSwap.storageProblem && (
        <p role="alert" className="form-error">
          {worded(pendingSwap.storageProblem)} No new transaction can be sent.
        </p>
      )}
      {pendingSwap.unreadable && <DiscardUnreadable pendingSwap={pendingSwap} />}
      {pendingSwap.open && (
        <>
          {staleAlerts}
          {nextLine}
          {activityBlock}
          {beside(recoveryBlock)}
        </>
      )}
      {quote && signed && input && output && (
        <>
          <Expander
            className="quote-box"
            more="All quote details"
            less="Fewer quote details"
            defaultExpanded={kept?.detailsOpen}
            onToggle={(open) => note({ detailsOpen: open })}
          >
            <dl className="detail-list quote-list" aria-label="Quote">
              {rate !== null && (
                <>
                  <dt className="glance">Rate</dt>
                  <dd className="glance">
                    1 {input.label} = {formatAmount(rate, output.token.decimals)} {output.label}
                  </dd>
                </>
              )}
              <dt>Route</dt>
              <dd>{signed.path.map(symbolOf).join(' → ')}</dd>
              <dt>Amount in</dt>
              <dd>
                {formatAmount(quote.amountIn, input.token.decimals)} {input.label}
              </dd>
              <dt>Expected output</dt>
              <dd>
                {formatAmount(signed.amountOut, output.token.decimals)} {output.label}
              </dd>
              <dt className="glance">Minimum received</dt>
              <dd className="glance">
                {formatAmount(signed.minimumOut, output.token.decimals)} {output.label} ({slippage}%
                slippage{tightened && ' from the better price at the latest block'})
              </dd>
              <dt className={reconfirmed || tightened ? 'glance' : undefined}>Quoted at</dt>
              <dd className={reconfirmed || tightened ? 'glance' : undefined}>
                {reconfirmed
                  ? `Latest block ${quote.blockNumber.toString()}, not ${wording.settled}; you reconfirmed this price`
                  : `${settledCapital()} block ${quote.blockNumber.toString()}`}{' '}
                (by the deployed lens, within the reserve caps)
                {tightened &&
                  `. The latest block returns more than block ${quote.blockNumber.toString()}, so the expected output and minimum use the latest price`}
              </dd>
              <dt>Reserve cap headroom used</dt>
              <dd>
                {uses.length === 0
                  ? 'No capped reserve on this route'
                  : uses
                      .map(
                        (u) =>
                          `${u.pool.token0.symbol}/${u.pool.token1.symbol}: ${percent(u.bps, 10_000n)}% of the ${u.token.symbol} headroom`,
                      )
                      .join('; ')}
              </dd>
              <dt>Deadline</dt>
              <dd>{deadlineMinutes} minutes after you confirm (wall-clock seconds)</dd>
            </dl>
            {depth && <PoolDepth depth={depth} />}
          </Expander>
          {!pendingSwap.open && staleAlerts}
          {check?.status === 'unknown' && (
            <p className="microcopy" role="status" aria-label="Stale quote">
              The latest block could not be read, so this {wording.settled} quote was not
              cross-checked. Your minimum received still applies on chain.
            </p>
          )}
          {/* The same sentence, word for word, set as a lead and its three conditions. */}
          <div className="notice revert-panel" aria-label="Revert conditions">
            <span className="revert-lead">
              The swap can still revert, and then only the gas is spent, if before it executes:
            </span>{' '}
            <span className="revert-item">
              <Layers size={15} aria-hidden="true" />
              other swaps or deposits fill a pool past its reserve cap (BDEX: RESERVE_CAP);
            </span>{' '}
            <span className="revert-item">
              <TrendingDown size={15} aria-hidden="true" />
              the price moves more than your slippage tolerance (BDEX: INSUFFICIENT_OUTPUT_AMOUNT);
            </span>{' '}
            <span className="revert-item">
              <TimerOff size={15} aria-hidden="true" />
              or the deadline passes (BDEX: EXPIRED).
            </span>
            {uses.some((u) => u.bps >= 8_000n) && (
              <span className="revert-more">
                {' '}
                This swap uses most of the remaining cap headroom, so a revert is more likely.
              </span>
            )}
          </div>
          {buysHeld && (
            <HoldSwapNotice hold={hold} accepted={holdAccepted} onAccept={setHoldAccepted} />
          )}
          {shortBalance && (
            <p className="form-error" role="alert">
              Your {wording.settled} {input.label} balance (
              {formatAmount(balanceIn!, input.token.decimals)}) is below the amount; the swap would
              revert.
            </p>
          )}
        </>
      )}
      {!wallet.account ? (
        <div className="wallet-options" data-wallet-connect tabIndex={-1}>
          {wallet.wallets.length === 0 && <p className="muted">No browser wallet found.</p>}
          {wallet.wallets.map((w) => (
            <button
              key={w.id}
              className="wallet-option"
              disabled={wallet.pending}
              onClick={() => void wallet.connect(w)}
            >
              <Wallet size={18} /> Connect {w.name}
            </button>
          ))}
          {wallet.error && <p className="form-error">{wallet.error}</p>}
        </div>
      ) : (
        <div className="devnet4-actions swap-actions">
          <p className="muted wallet-line">
            Wallet <code>{wallet.account.address}</code> on chain{' '}
            {BigInt(wallet.account.chainId).toString()}
            {!onChain && ` (it will be asked to switch to chain ${d.chainId})`}
          </p>
          {needsReset && quote && input && (
            <>
              <p className="microcopy" data-testid="allowance-reset-note">
                {input.label} does not let an allowance be changed from one amount to another: the
                router still holds an allowance of{' '}
                {formatAmount(allowance ?? 0n, input.token.decimals)} {input.label} from an earlier
                approval, less than this swap needs. Set it to zero first (one transaction), then
                approve the exact amount.
              </p>
              <button
                className="button primary"
                disabled={busy || staleForm || pendingSwap.open}
                onClick={() =>
                  void run(`Reset the ${input.label} allowance to zero`, () =>
                    resetAllowanceTransaction(d, input.token.address, account!),
                  )
                }
              >
                Reset the {input.label} allowance to zero
              </button>
            </>
          )}
          {needsApproval && !needsReset && quote && input && (
            <button
              className="button primary"
              disabled={busy || staleForm || pendingSwap.open || allowanceUnread}
              onClick={() =>
                void run(
                  `Approve ${formatAmount(quote.amountIn, input.token.decimals)} ${input.label}`,
                  () => approveTransaction(d, input.token.address, account!, quote.amountIn),
                )
              }
            >
              Approve {formatAmount(quote.amountIn, input.token.decimals)} {input.label}
            </button>
          )}
          <button
            className="button primary"
            disabled={
              busy ||
              !quote ||
              needsApproval ||
              shortBalance ||
              !input ||
              !output ||
              blocksSwap(check) ||
              staleForm ||
              holdBlocksSend ||
              pendingSwap.open
            }
            onClick={() => (stale() ? renewFirst('swap') : void swap(quote!))}
          >
            Swap
          </button>
        </div>
      )}
      {!pendingSwap.open && (
        <>
          {nextLine}
          {recoveryBlock}
          {activityBlock}
        </>
      )}
    </div>
  );
}

/** The only manual way out of a stored record the page cannot read. It removes that record and nothing else. */
function DiscardUnreadable({ pendingSwap }: { pendingSwap: ReturnType<typeof usePendingSwap> }) {
  const [understood, setUnderstood] = useState(false);
  const [note, setNote] = useState('');
  return (
    <details aria-label="Discard the unreadable saved record">
      <summary>Discard the unreadable saved record</summary>
      <p>
        This browser holds a saved record of an earlier wallet request of this account that the page
        cannot read (it is damaged, was edited, or names a deadline that is not the one in its saved
        call). The page cannot tell what that request was or whether it can still execute, so it
        sends nothing while the record is there, and nothing on the chain can clear it.
      </p>
      <p>
        Discarding it removes the page&apos;s only memory of that request. If the request was a swap
        that your wallet still holds, or that is still queued, it can still execute; if you then
        swap again, both swaps execute. Before you discard: open your wallet&apos;s activity, reject
        every open request from this site, and make sure no transaction of this account is pending.
        The safe alternative is to wait: the longest swap deadline this page allows is 180 minutes,
        and once a {wording.settled} {wording.block} is later than that after your last request, no
        swap from it can execute. This makes no wallet request and sends nothing.
      </p>
      <label>
        <input
          type="checkbox"
          checked={understood}
          onChange={(event) => setUnderstood(event.target.checked)}
        />{' '}
        I checked my wallet: no request from this site is open and no transaction of this account is
        pending.
      </label>
      <button
        className="button secondary"
        disabled={!understood}
        onClick={() =>
          void pendingSwap
            .discardUnreadable()
            .then((done) =>
              setNote(
                done
                  ? 'The unreadable record was removed.'
                  : 'The record could not be removed, or it is readable now. Reload the page.',
              ),
            )
        }
      >
        Discard the unreadable record
      </button>
      {note && <p role="status">{note}</p>}
    </details>
  );
}

function SubmissionRecovery({ pendingSwap }: { pendingSwap: ReturnType<typeof usePendingSwap> }) {
  const [hash, setHash] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [replacement, setReplacement] = useState<ReplacementProof | null>(null);
  const recover = async () => {
    if (busy) return;
    setBusy(true);
    setNote('Checking the saved transaction against the RPC…');
    try {
      await pendingSwap.recover(hash);
      setNote(
        worded(
          'The transaction matches the saved intent. Waiting for its canonical finalized receipt.',
        ),
      );
    } catch (error) {
      setNote(
        message(error, 'The transaction could not be verified. The submission hold remains.'),
      );
    } finally {
      setBusy(false);
    }
  };
  const reviewInWallet = async () => {
    if (busy || pendingSwap.walletBusy) return;
    setBusy(true);
    setNote('Checking the original nonce, call and deadline before opening the wallet…');
    try {
      const candidate = await pendingSwap.reviewInWallet();
      setNote(
        worded(
          `Wallet returned ${candidate}. All known candidates remain tracked until one is canonically finalized.`,
        ),
      );
    } catch (error) {
      setNote(
        message(error, 'The review outcome is unknown. The original submission hold remains.'),
      );
    } finally {
      setBusy(false);
    }
  };
  const checkReplacement = async () => {
    if (busy) return;
    setBusy(true);
    setReplacement(null);
    setNote(
      worded(
        'Checking whether this different transaction canonically finalized at the original nonce…',
      ),
    );
    try {
      setReplacement(await pendingSwap.checkReplacement(hash));
      setNote(
        'Replacement verified. The original hold remains until you explicitly close it below.',
      );
    } catch (error) {
      setNote(message(error, 'The replacement could not be verified. The original hold remains.'));
    } finally {
      setBusy(false);
    }
  };
  const closeReplacement = async () => {
    if (busy || !replacement) return;
    setBusy(true);
    setNote('Rechecking the replacement before closing only its local hold…');
    try {
      await pendingSwap.closeReplacement(replacement);
    } catch (error) {
      setReplacement(null);
      setNote(message(error, 'The original hold remains.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="notice hold-recovery" aria-label="Recover transaction tracking">
      <p>
        Check your wallet activity on this chain and copy the transaction hash. Time passing or an
        empty explorer result cannot clear the hold.
      </p>
      <p>
        A swap for which your wallet returned no hash ends in one of two ways only: its hash, found
        in your wallet activity and checked here, or its deadline passing in a {wording.settled}{' '}
        block (nothing to do: the page then releases the hold by itself). Nothing else on this page
        clears a hold.
      </p>
      <Disclosure clip className="hold-help" summary={() => 'What can I do?'}>
        <p>
          This check only restores tracking after matching the saved sender, destination, call,
          value and nonce. It never sends or replaces a transaction.
        </p>
        <p>
          Another transaction at the same nonce does not release it, because an open wallet request
          could still be signed at another nonce. For an approval or a skim your wallet never
          signed, send any other transaction from this account, paste its hash and use the
          replacement check.
        </p>
        <p>
          If you cancelled or replaced the request in your wallet with a different call, check that
          transaction separately. Only a canonical {wording.settled} receipt at the original sender
          and nonce can establish that the original request cannot execute. This check makes no
          wallet request.
        </p>
      </Disclosure>
      <label>
        Transaction hash from wallet activity
        <input
          value={hash}
          disabled={busy}
          onChange={(event) => {
            setHash(event.target.value);
            setReplacement(null);
          }}
          placeholder="0x…"
          maxLength={66}
          spellCheck={false}
          autoComplete="off"
        />
      </label>
      <button
        className="button secondary"
        disabled={busy || !hash.trim() || !!pendingSwap.storageProblem}
        onClick={() => void recover()}
      >
        Check transaction hash
      </button>
      <button
        className="button secondary"
        disabled={busy || !hash.trim() || !!pendingSwap.storageProblem}
        onClick={() => void checkReplacement()}
      >
        Check cancellation or replacement
      </button>
      {replacement && (
        <div className="notice" aria-label="Verified replacement">
          <p>
            A different transaction {wording.settled} at nonce {replacement.nonce}. The original
            request cannot execute on this canonical chain. This is evidence of replacement, not
            successful execution of the original request. Closing this hold only updates this
            browser; it sends nothing.
          </p>
          <dl>
            <dt>Replacement hash</dt>
            <dd style={{ overflowWrap: 'anywhere' }}>{replacement.transactionHash}</dd>
            <dt>From</dt>
            <dd style={{ overflowWrap: 'anywhere' }}>{replacement.from}</dd>
            <dt>To</dt>
            <dd style={{ overflowWrap: 'anywhere' }}>{replacement.to ?? 'Contract creation'}</dd>
            <dt>Native value (wei)</dt>
            <dd>{replacement.value}</dd>
            <dt>Calldata</dt>
            <dd style={{ overflowWrap: 'anywhere' }}>{replacement.data}</dd>
            <dt>Canonical {wording.settled} inclusion</dt>
            <dd>Block {replacement.blockNumber}</dd>
            <dt>Replacement receipt status</dt>
            <dd>{replacement.receiptStatus}</dd>
          </dl>
          <button
            className="button secondary"
            disabled={busy || !!pendingSwap.storageProblem}
            onClick={() => void closeReplacement()}
          >
            Close local hold as replaced
          </button>
        </div>
      )}
      {pendingSwap.review?.details && (
        <details>
          <summary>Review the original request in your wallet</summary>
          <p>
            If no hash is available, you can explicitly ask your wallet to review this same nonce
            and unchanged call. This is offered for approvals and skims only, where a second copy is
            harmless; a swap is never requested twice. An earlier attempt may still execute. This
            never chooses a new nonce. Review the decoded amounts, addresses and gas limit below.
            {wording.feeSuggestion} Cancelling this review keeps the hold. Some wallets ignore the
            nonce a site asks for: if your wallet shows a nonce other than the one below, reject the
            request there, because it would be a second transaction.
          </p>
          <dl aria-label="Validated original transaction">
            {pendingSwap.review.details.map(([name, value]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd style={{ overflowWrap: 'anywhere' }}>{value}</dd>
              </div>
            ))}
          </dl>
          <button
            className="button secondary"
            disabled={busy || pendingSwap.walletBusy || !!pendingSwap.storageProblem}
            onClick={() => void reviewInWallet()}
          >
            Review same nonce in wallet
          </button>
        </details>
      )}
      {pendingSwap.review?.problem && <p>{worded(pendingSwap.review.problem)}</p>}
      {note && <p role="status">{note}</p>}
    </div>
  );
}

function BridgePanel({ network }: { network: MainnetNetwork }) {
  return (
    <div className="card mainnet-bridges" aria-label="Bridges">
      <h2>Bridged assets</h2>
      <ul>
        {network.bridges.map((b) => {
          const links = [
            ['Deposit', b.depositUrl],
            ['Withdraw', b.withdrawUrl],
            ['Documentation', b.docsUrl],
          ].filter((l): l is [string, string] => !!l[1]);
          return (
            <li key={b.symbol}>
              <strong>{b.symbol}</strong> ({b.name}):{' '}
              {links.length === 0
                ? 'bridge not live yet; links will be published with the bridge deployment.'
                : links.map(([label, href], i) => (
                    <span key={label}>
                      {i > 0 && ' · '}
                      <a href={href} target="_blank" rel="noopener noreferrer">
                        {label}
                      </a>
                    </span>
                  ))}
            </li>
          );
        })}
      </ul>
      <p className="microcopy">
        Bridged tokens carry the bridge's own risk. Each pool's cap on a bridged token is at most a
        tenth of that bridge's rate-limit bucket.
      </p>
    </div>
  );
}

const holdWhat = (h: BridgeHold) =>
  h.state === 'held'
    ? `a credited bUSDC mint has no Ethereum deposit behind it${h.final ? '' : ' (seen at the latest blocks, not final yet)'}, so the Ethereum vault refuses every bUSDC burn made from now on`
    : h.state === 'paused'
      ? h.pausedUntil !== null
        ? `a bridge guardian paused the Ethereum vault until ${new Date(Number(h.pausedUntil) * 1000).toISOString().replace('.000Z', ' UTC').replace('T', ' ')}, so releases to Ethereum wait`
        : 'releases are switched off at the Ethereum vault, so releases to Ethereum wait'
      : '';

/** Page-wide notice when bUSDC exits to Ethereum are held or paused (agent 139 finding 1). */
function BridgeHoldBanner({ hold, network }: { hold: BridgeHold | null; network: MainnetNetwork }) {
  if (!hold || hold.state === 'normal' || hold.state === 'unchecked') return null;
  const link = network.bridges.find((b) => b.status)?.withdrawUrl;
  if (hold.state === 'unknown')
    return (
      <p className="notice" role="status" aria-label="Bridge exit status">
        Whether bUSDC can leave to Ethereum could not be checked ({hold.reason}). Check the bridge
        page before you buy bUSDC or remove liquidity from a bUSDC pool.
      </p>
    );
  return (
    <div className="form-error mainnet-hold" role="alert" aria-label="Bridge exit status">
      <AlertTriangle size={16} />{' '}
      <strong>
        {hold.state === 'held'
          ? 'bUSDC exits to Ethereum are held.'
          : 'bUSDC exits to Ethereum are paused.'}
      </strong>{' '}
      The bridge reports that {holdWhat(hold)}. This includes bUSDC you buy here or take out of a
      pool.{' '}
      {hold.state === 'held'
        ? 'Nothing is lost on the L2, but such bUSDC waits for the bridge owner’s settlement, with no set date.'
        : 'It can be sent once the pause ends.'}{' '}
      Swaps and pools on this page keep working.
      {link && (
        <>
          {' '}
          <a href={link} target="_blank" rel="noopener noreferrer">
            Bridge status
          </a>
        </>
      )}
    </div>
  );
}

function HoldSwapNotice({
  hold,
  accepted,
  onAccept,
}: {
  hold: BridgeHold | null;
  accepted: boolean;
  onAccept: (v: boolean) => void;
}) {
  if (!hold || hold.state === 'normal') return null;
  if (hold.state === 'unknown' || hold.state === 'unchecked')
    return (
      <p className="microcopy" role="status" aria-label="bUSDC exit notice">
        This page could not check whether bUSDC can leave to Ethereum now. Check the bridge before
        you rely on withdrawing it.
      </p>
    );
  return (
    <div className="form-error" role="alert" aria-label="bUSDC exit notice">
      <AlertTriangle size={16} /> You are buying bUSDC while its exits to Ethereum are {hold.state}:{' '}
      {holdWhat(hold)}. You can hold and trade it on the L2, but not withdraw it to Ethereum until
      the bridge clears this.
      <label className="checkbox-label">
        <input type="checkbox" checked={accepted} onChange={(e) => onAccept(e.target.checked)} /> I
        understand; swap anyway
      </label>
    </div>
  );
}
