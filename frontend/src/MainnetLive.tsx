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
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, LoaderCircle, RefreshCw, ShieldCheck, Wallet } from 'lucide-react';
import type { Address, Hex } from 'viem';
import { formatAmount, parseAmount } from './amm';
import {
  approveTransaction,
  deadlineFrom,
  ensureChain,
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
import { usePendingSwap } from './mainnet/pendingswap';
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
const message = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

function ExplorerLink({
  network,
  kind,
  value,
}: {
  network: MainnetNetwork;
  kind: 'tx' | 'address';
  value: string;
}) {
  if (!network.explorerUrl) return <code>{value}</code>;
  return (
    <a
      href={`${network.explorerUrl.replace(/\/$/, '')}/${kind}/${value}`}
      target="_blank"
      rel="noopener noreferrer"
      referrerPolicy="no-referrer"
    >
      <code>{value}</code>
    </a>
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
  ethRpc,
}: {
  network: MainnetNetwork;
  load: () => Promise<MainnetState>;
  rpc: Rpc;
  wallet: Devnet4Wallet;
  planned: { caps: PlannedCap[]; pairs: [string, string][] };
  now?: () => number;
  receiptPollMs?: number;
  /** Ethereum RPC for the bUSDC hold status; defaults to the network file's status.ethRpcUrl. */
  ethRpc?: Rpc;
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

  useEffect(() => {
    let current = true;
    setFailure('');
    void (async () => {
      try {
        const s = await load();
        if (!current) return;
        setState(s);
        if (s.status !== 'live') return;
        const snap = await readSnapshot(rpc, s.deployment, 'mainnet');
        const pools = await readExcess(rpc, snap.finalized.hash, s.deployment.lens, snap.pools);
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
      } catch (error) {
        if (current) setFailure(message(error, 'Unavailable.'));
      }
    })();
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, rpc, generation]);

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
  return (
    <section className="page devnet4-page mainnet-page" aria-labelledby="mainnet-title">
      <div className="section-heading">
        <div>
          <span className="badge">
            Bloch L2 mainnet · Chain {network.chainId}
            {live ? '' : ' · Not yet live'}
          </span>
          <h1 id="mainnet-title">Bloch L2 mainnet</h1>
          <p className="muted">
            Pools, balances and quotes are read at the finalized L2 block, from a reviewed
            deployment record; a quote is also compared with the latest block to warn when it has
            gone stale. Swaps are sent only from your wallet, one explicit step at a time. Pools
            have fixed reserve caps; this is a guarded launch.
          </p>
        </div>
        {live && (
          <button className="button secondary" onClick={() => setGeneration((g) => g + 1)}>
            <RefreshCw size={16} /> Refresh
          </button>
        )}
      </div>
      <NetworkPanel network={network} wallet={wallet} />
      {failure ? (
        <p className="form-error" role="alert">
          Mainnet reads are unavailable: {failure}. No transaction can be sent from this page.
        </p>
      ) : !state ? (
        <p className="muted" role="status">
          <LoaderCircle size={16} className="spin" /> Checking the bundled deployment record…
        </p>
      ) : state.status === 'not-live' ? (
        <NotLive reasons={state.reasons} planned={planned} />
      ) : !snapshot ? (
        <p className="muted" role="status">
          <LoaderCircle size={16} className="spin" /> Verifying the deployment at the finalized
          block…
        </p>
      ) : (
        <>
          <FinalityAge finalizedAt={snapshot.finalized} now={now} />
          <BridgeHoldBanner hold={hold} network={network} />
          <DeploymentPanel network={network} deployment={state.deployment} snapshot={snapshot} />
          <PoolsTable
            snapshot={snapshot}
            network={network}
            rpc={rpc}
            wallet={wallet}
            pendingSwap={pendingSwap}
            now={now}
            heldToken={exitsBlocked(hold) ? holdSource?.token : undefined}
          />
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
          />
        </>
      )}
      <BridgePanel network={network} />
    </section>
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
        <dt>L2 genesis</dt>
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
        The DEX is not deployed on the Bloch L2 mainnet yet. This page sends no RPC request and no
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
      <p className="microcopy" aria-label="Finality age">
        Finalized block {finalizedAt.number.toString()} is {age} old.
      </p>
    );
  return (
    <p className="form-error" role="alert" aria-label="Finality age">
      <AlertTriangle size={16} /> L2 finality looks stalled: finalized block{' '}
      {finalizedAt.number.toString()} is {age} old. Pools, balances, caps and quotes on this page
      are from that block. A swap executes on the latest state, and anything mined now stays out of
      these figures until finality resumes.
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
          {d.gate.decision} at finalized block {d.gate.finalizedNumber.toString()}
        </dd>
        <dt>Finalized now</dt>
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
    <div className="card">
      <h2>Pools at finalized block {snapshot.finalized.number.toString()}</h2>
      <table className="devnet4-pools">
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
              <td>
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
              <td>
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
}) {
  const [holdAccepted, setHoldAccepted] = useState(false);
  const options = useMemo<Option[]>(
    () =>
      snapshot.tokens.map((token) =>
        token.wrapped
          ? { key: token.address, label: 'BLCH', token, native: true }
          : { key: token.address, label: token.symbol, token, native: false },
      ),
    [snapshot],
  );
  const [inKey, setInKey] = useState(options[0]?.key ?? '');
  const [outKey, setOutKey] = useState(options[1]?.key ?? '');
  const [amount, setAmount] = useState('');
  const [slippage, setSlippage] = useState((DEFAULT_SLIPPAGE_BPS / 100).toFixed(2));
  // 2 once the user took the page's one retry after a revert on the minimum (DEX-5).
  const [attempt, setAttempt] = useState<1 | 2>(1);
  const [deadline, setDeadline] = useState(String(DEFAULT_DEADLINE_MINUTES));
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
  const [requote, setRequote] = useState(0);
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
          'No route can fill this amount at the finalized block; the swap would revert.',
        );
      }
      setQuote(q);
      await crossCheck(q, null, generation);
    } catch (error) {
      if (superseded()) return;
      setQuoteNote(message(error, 'Quote unavailable.'));
    }
  }

  useEffect(() => {
    if (requote > 0) void getQuote();
    // Runs only when a reply was dropped, with the form of this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requote]);

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
      const deadline = deadlineFrom(now(), deadlineMinutes);
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

  return (
    <div className="card devnet4-swap">
      <h2>Swap</h2>
      <div className="devnet4-form">
        <label className="field-label">
          You pay
          <select
            value={inKey}
            onChange={(e) => (setInKey(e.target.value), setAttempt(1), clear())}
          >
            {options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label">
          Amount
          <input
            className="text-input"
            inputMode="decimal"
            value={amount}
            onChange={(e) => (setAmount(e.target.value), setAttempt(1), clear())}
          />
        </label>
        <label className="field-label">
          You receive
          <select
            value={outKey}
            onChange={(e) => (setOutKey(e.target.value), setAttempt(1), clear())}
          >
            {options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label">
          Slippage tolerance (%)
          <input
            className="text-input"
            inputMode="decimal"
            value={slippage}
            onChange={(e) => (setSlippage(e.target.value), clear())}
          />
        </label>
        <p className="microcopy" aria-label="Slippage note">
          Plan to lose up to this share of your output. Block order follows the tip paid, so someone
          can trade just before and after you and keep the difference, up to your minimum. Keep it
          low, and split large swaps.
        </p>
        <label className="field-label">
          Deadline (minutes)
          <input
            className="text-input"
            inputMode="numeric"
            value={deadline}
            onChange={(e) => (setDeadline(e.target.value), clear())}
          />
        </label>
        <button className="button secondary" onClick={() => void getQuote()}>
          Get quote
        </button>
      </div>
      {balances && (
        <p className="microcopy" aria-label="Finalized balances">
          Your balances at finalized block {snapshot.finalized.number.toString()}:{' '}
          {options
            .map((o) =>
              o.native
                ? `${formatAmount(balances.native, 18, 6)} BLCH`
                : `${formatAmount(balances.tokens.get(o.token.address) ?? 0n, o.token.decimals)} ${o.label}`,
            )
            .join(' · ')}
        </p>
      )}
      {quoteNote && (
        <p className="form-error" role="alert">
          {quoteNote}
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
      {quote && signed && input && output && (
        <>
          <dl className="detail-list" aria-label="Quote">
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
            <dt>Minimum received</dt>
            <dd>
              {formatAmount(signed.minimumOut, output.token.decimals)} {output.label} ({slippage}%
              slippage{tightened && ' from the better price at the latest block'})
            </dd>
            <dt>Quoted at</dt>
            <dd>
              {reconfirmed
                ? `Latest block ${quote.blockNumber.toString()}, not finalized; you reconfirmed this price`
                : `Finalized block ${quote.blockNumber.toString()}`}{' '}
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
          {check?.status === 'worse' && (
            <div className="form-error" role="alert" aria-label="Stale quote">
              <AlertTriangle size={16} /> The price moved after the finalized block. At the latest
              block this swap returns {formatAmount(check.latest.amountOut, output.token.decimals)}{' '}
              {output.label}, {percent(check.worseBps, 10_000n)}% worse than this quote and below
              your minimum received, so it would revert. Reconfirm to use the latest price, or
              change the amount.{' '}
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
          {check?.status === 'unknown' && (
            <p className="microcopy" role="status" aria-label="Stale quote">
              The latest block could not be read, so this finalized quote was not cross-checked.
              Your minimum received still applies on chain.
            </p>
          )}
          <div className="notice" aria-label="Revert conditions">
            The swap can still revert, and then only the gas is spent, if before it executes: other
            swaps or deposits fill a pool past its reserve cap (BDEX: RESERVE_CAP); the price moves
            more than your slippage tolerance (BDEX: INSUFFICIENT_OUTPUT_AMOUNT); or the deadline
            passes (BDEX: EXPIRED).
            {uses.some((u) => u.bps >= 8_000n) &&
              ' This swap uses most of the remaining cap headroom, so a revert is more likely.'}
          </div>
          {buysHeld && (
            <HoldSwapNotice hold={hold} accepted={holdAccepted} onAccept={setHoldAccepted} />
          )}
          {shortBalance && (
            <p className="form-error" role="alert">
              Your finalized {input.label} balance ({formatAmount(balanceIn!, input.token.decimals)}
              ) is below the amount; the swap would revert.
            </p>
          )}
        </>
      )}
      {!wallet.account ? (
        <div className="wallet-options">
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
        <div className="devnet4-actions">
          <p className="muted">
            Wallet <code>{wallet.account.address}</code> on chain{' '}
            {BigInt(wallet.account.chainId).toString()}
            {!onChain && ` (it will be asked to switch to chain ${d.chainId})`}
          </p>
          {needsApproval && quote && input && (
            <button
              className="button primary"
              disabled={busy || staleForm || pendingSwap.open}
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
            onClick={() => void swap(quote!)}
          >
            Swap
          </button>
        </div>
      )}
      {pendingSwap.storageProblem && (
        <p role="alert" className="form-error">
          {pendingSwap.storageProblem} No new transaction can be sent.
        </p>
      )}
      {tracked?.intent && (tracked.state === 'pending' || tracked.state === 'unknown') && (
        <SubmissionRecovery key={tracked.intent.id} pendingSwap={pendingSwap} />
      )}
      {history.some((h) => !steps.some((s) => s.hash === h.hash) && tracked?.hash !== h.hash) && (
        <ol className="devnet4-steps" aria-label="Earlier transactions">
          {history
            .filter((h) => !steps.some((s) => s.hash === h.hash) && tracked?.hash !== h.hash)
            .map((h) => (
              <li key={h.hash} data-state={h.state}>
                <strong>{h.label}</strong>: {h.state}{' '}
                <ExplorerLink network={network} kind="tx" value={h.hash} />
                {h.detail && <span className="muted"> {h.detail}</span>}
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
              {s.detail && <span className="muted"> {s.detail}</span>}
            </li>
          ))}
          {tracked && (
            <li data-state={tracked.state}>
              <strong>{tracked.label}</strong>: {tracked.state}{' '}
              {tracked.hash && <ExplorerLink network={network} kind="tx" value={tracked.hash} />}
              <span className="muted"> {tracked.detail}</span>
              {tracked.state === 'failed' && tracked.retry && tracked.cause && (
                <p className="notice" role="status" aria-label="Why the swap reverted">
                  {revertText(tracked.retry, tracked.cause)}
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
    </div>
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
        'The transaction matches the saved intent. Waiting for its canonical finalized receipt.',
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
        `Wallet returned ${candidate}. All known candidates remain tracked until one is canonically finalized.`,
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
      'Checking whether this different transaction canonically finalized at the original nonce…',
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
    <div className="notice" aria-label="Recover transaction tracking">
      <p>
        Check your wallet activity on this chain and copy the transaction hash. This check only
        restores tracking after matching the saved sender, destination, call, value and nonce. It
        never sends or replaces a transaction. Time passing or an empty explorer result cannot clear
        the hold.
      </p>
      <p>
        If your wallet shows no transaction for this request (it was refused, closed or never
        signed), the hold stays until this account&apos;s next transaction at the same nonce is
        finalized: send any other transaction from this account in your wallet, then paste its hash
        here and use the replacement check. A swap hold also ends by itself, with nothing sent,
        once the swap deadline has passed in a finalized block. Nothing else on this page clears
        a hold.
      </p>
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
      <p>
        If you cancelled or replaced the request in your wallet with a different call, check that
        transaction separately. Only a canonical finalized receipt at the original sender and nonce
        can establish that the original request cannot execute. This check makes no wallet request.
      </p>
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
            A different transaction finalized at nonce {replacement.nonce}. The original request
            cannot execute on this canonical chain. This is evidence of replacement, not successful
            execution of the original request. Closing this hold only updates this browser; it sends
            nothing.
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
            <dt>Canonical finalized inclusion</dt>
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
            and unchanged call. This is offered for approvals and skims only, where a second copy
            is harmless; a swap is never requested twice. An earlier attempt may still execute. This
            never chooses a new nonce. Review the decoded amounts, addresses and gas limit below.
            The page suggests a priority fee only when the call creates new storage slots on the
            L2, from its own simulation and never from an error's figures; you can adjust fees in
            the wallet. Cancelling this review keeps the hold. Some wallets ignore the nonce a site
            asks for: if your wallet shows a nonce other than the one below, reject the request
            there, because it would be a second transaction.
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
      {pendingSwap.review?.problem && <p>{pendingSwap.review.problem}</p>}
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
