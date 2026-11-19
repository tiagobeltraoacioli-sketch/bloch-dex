// The screens of a live route in the layout the preview established (Trade, Pools, Portfolio, the liquidity
// dialog), over real data. Trade is the route's own reviewed page, passed in as `children` and never unmounted
// (its swap card, tracker views and recovery controls stay where they are); Pools and Portfolio are drawn here
// from the route's snapshot and from reads pinned to the same block. Nothing on these screens is a sample: where
// the preview showed a figure this page has no truthful source for (price history, 24-hour volume and fees,
// values in a currency), the place says so or is left out.
import {
  useContext,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import { Info, Minus, Plus, RefreshCw, Wallet } from 'lucide-react';
import type { Address } from 'viem';
import { formatAmount } from '../amm';
import type { LivePool, Rpc, Snapshot } from '../devnet4/chain';
import type { DevnetDeployment } from '../devnet4/record';
import type { Devnet4Wallet } from '../Devnet4Live';
import type { MainnetNetwork } from '../mainnet/config';
import { isOpen, POOL_FEE_TEXT, positionOf, sharePercentText } from '../mainnet/liquidity';
import type { usePendingSwap } from '../mainnet/pendingswap';
import { loadHistory } from '../mainnet/txhistory';
import { settledCapital, worded, wording } from '../mainnet/wording';
import { TokenMark } from '../marks/TokenMark';
import { ConnectSlot, ConnectSlotContext } from '../shell/connect-slot';
import type { TokenFact } from '../multichain/token-facts';
import { DEFAULT_SLIPPAGE_BPS } from '../slippage';
import { CopyButton } from '../ui/CopyButton';
import { LiquidityRisks } from './LiquidityRisks';
import { poolRatioText } from './ratio';
import {
  LiveLiquidityDialog,
  poolName,
  sideName,
  type DialogMemory,
  type LiquidityMode,
  type LiveFreshness,
} from './LiveLiquidityDialog';
import { TrackedStatus, type ConfirmationFacts } from './TrackedStatus';
import { useLiquidity, type PoolLiquidity } from './useLiquidity';
import { hrefOfView, LIVE_VIEW_NAMES, LIVE_VIEWS, useLiveView, type LiveView } from './view';

export type LiveScreensProps = {
  /** The hash of the route's Trade screen (`#/ethereum`); the other screens are `<base>/pools`, `<base>/portfolio`. */
  base: string;
  network: MainnetNetwork;
  /** Set once the route is live and its snapshot verified; until then only Trade (the route's status) is shown. */
  live: { deployment: DevnetDeployment; snapshot: Snapshot; multicall3?: Address } | null;
  rpc: Rpc;
  wallet: Devnet4Wallet;
  now: () => number;
  pendingSwap: ReturnType<typeof usePendingSwap>;
  confirmation?: ConfirmationFacts;
  receiptPollMs?: number;
  freshness?: LiveFreshness;
  busyRef?: MutableRefObject<boolean>;
  /** The pairs planned for this network, by the names the page shows; one without an open pool is said so. */
  plannedPairs: [string, string][];
  /** The token list's statement per token, by the name the page shows. */
  tokenFacts?: TokenFact[];
  /** The swap card's slippage setting now, when it has one. */
  slippage: () => string | undefined;
  onRefresh: () => void;
  children: ReactNode;
};

const PairMarks = ({ pool }: { pool: LivePool }) => (
  <span className="pair-icons">
    <TokenMark symbol={pool.token0.symbol} size={0} className="token-icon" />
    <TokenMark symbol={pool.token1.symbol} size={0} className="token-icon" />
  </span>
);

const NOT_OPEN_LINE =
  'Not open yet. Only the first depositor fixed in the factory can open a pool, so this page builds no first deposit for anyone.';

export function LiveScreens(props: LiveScreensProps) {
  const { base, network, live, rpc, wallet, now, pendingSwap, children } = props;
  const [hashView, go] = useLiveView(base);
  const view: LiveView = live ? hashView : 'trade';
  const [dialog, setDialog] = useState<{ mode: LiquidityMode; pool: Address } | null>(null);
  // The frame that moves focus to the Trade screen's connect step; never left to run after this route is gone.
  const connectFrame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(connectFrame.current), []);
  const account = (wallet.account?.address.toLowerCase() as Address | undefined) ?? null;
  const { data, error } = useLiquidity({
    rpc,
    snapshot: live?.snapshot ?? null,
    deployment: live?.deployment ?? null,
    multicall3: live?.multicall3,
    account,
    enabled: !!live && (view !== 'trade' || dialog !== null),
  });
  const facts = props.tokenFacts ?? [];
  const factsOf = (pool: LivePool) =>
    facts.filter((f) => f.name === pool.token0.symbol || f.name === pool.token1.symbol);
  // A planned pair with no pool in the record (the record lists a pair only when the post gate proved its opening).
  const openNames = new Set(
    (live?.snapshot.pools ?? []).flatMap((p) => [
      `${p.token0.symbol}/${p.token1.symbol}`,
      `${p.token1.symbol}/${p.token0.symbol}`,
    ]),
  );
  const notOpen = live ? props.plannedPairs.filter(([a, b]) => !openNames.has(`${a}/${b}`)) : [];
  // The dialog's inputs across a failed read (it is unmounted with the screens); forgotten when it is closed.
  const dialogMemory = useRef<DialogMemory | null>(null);
  const open = (mode: LiquidityMode, pool: LivePool) => {
    dialogMemory.current = null;
    setDialog({ mode, pool: pool.address });
  };
  const status = live && (
    <div className="live-status">
      <p className="microcopy finality-line">
        Read at {wording.settled} block {live.snapshot.finalized.number.toString()}, from the
        reviewed deployment record.
      </p>
      <button type="button" className="button secondary page-refresh" onClick={props.onRefresh}>
        <RefreshCw size={16} aria-hidden="true" /> Refresh
      </button>
    </div>
  );
  const tracked = live && (
    <TrackedStatus
      pendingSwap={pendingSwap}
      rpc={rpc}
      deployment={live.deployment}
      pools={live.snapshot.pools}
      sideName={sideName}
      confirmation={props.confirmation}
      receiptPollMs={props.receiptPollMs}
      now={now}
      onActivity={() => go('trade')}
    />
  );
  const readError = error && (
    <p className="form-error" role="alert">
      {wording.reads} are unavailable: {error.replace(/\.$/, '')}. No transaction can be sent from
      this screen.{' '}
      <button type="button" className="button secondary" onClick={props.onRefresh}>
        <RefreshCw size={16} aria-hidden="true" /> Refresh
      </button>
    </p>
  );
  // The wallet is connected by the route's own connect step, which is on the Trade screen. The block carries the
  // attribute the header's wallet button looks for, and stands before the Trade screen in the document.
  // What the site put into the connect slot (agent 410: the mobile wallet on the multichain site), and the
  // browser wallets the page found. With either, this screen connects by itself, with the same options as the
  // route's own connect step; with neither it leads to that step on Trade, as before.
  const slot = useContext(ConnectSlotContext);
  const direct = wallet.wallets.length > 0 || slot !== null;
  const connect = direct ? (
    <div className="wallet-options" data-wallet-connect tabIndex={-1}>
      {wallet.wallets.map((w) => (
        <button
          key={w.id}
          type="button"
          className="wallet-option"
          disabled={wallet.pending}
          onClick={() => void wallet.connect(w)}
        >
          <Wallet size={18} aria-hidden="true" /> Connect {w.name}
        </button>
      ))}
      <ConnectSlot />
      {wallet.error && <p className="form-error">{wallet.error}</p>}
    </div>
  ) : (
    <div className="wallet-options" data-wallet-connect tabIndex={-1}>
      <button
        type="button"
        className="wallet-option"
        disabled={wallet.pending}
        onClick={() => {
          go('trade');
          cancelAnimationFrame(connectFrame.current);
          connectFrame.current = requestAnimationFrame(() => {
            const targets = document.querySelectorAll<HTMLElement>('[data-wallet-connect]');
            const target = targets[targets.length - 1];
            target?.scrollIntoView?.({ block: 'center' });
            (target?.querySelector<HTMLElement>('button:not(:disabled)') ?? target)?.focus();
          });
        }}
      >
        <Wallet size={18} aria-hidden="true" /> Connect a wallet on the Trade screen
      </button>
    </div>
  );
  const dialogItem = dialog
    ? (data?.pools.find((p) => p.pool.address === dialog.pool) ?? null)
    : null;
  return (
    <>
      {live && (
        <nav className="live-tabs" aria-label="Screens">
          {LIVE_VIEWS.map((v) => (
            <a key={v} href={hrefOfView(base, v)} aria-current={view === v ? 'page' : undefined}>
              {LIVE_VIEW_NAMES[v]}
            </a>
          ))}
        </nav>
      )}
      {live && view === 'pools' && (
        <section className="page live-view" data-view="pools" aria-labelledby="live-pools-title">
          <header className="page-heading">
            <div>
              <p className="eyebrow">{wording.title}</p>
              <h1 id="live-pools-title">Pools</h1>
              <p className="page-subtitle">
                Every pool this site lists on {network.chainName}, with its reserves. Add or remove
                liquidity one explicit wallet step at a time.
              </p>
            </div>
          </header>
          {status}
          {readError}
          {tracked}
          {!wallet.account && connect}
          <div className="summary-grid">
            <section className="panel summary-panel">
              <div className="stat">
                <span className="muted">Open pools</span>
                <strong>{live.snapshot.pools.length}</strong>
              </div>
            </section>
            <section className="panel summary-panel">
              <div className="stat">
                <span className="muted">Pool fee</span>
                <strong>{POOL_FEE_TEXT}</strong>
                <span className="muted small-text">of every swap, paid to the pool</span>
              </div>
            </section>
            <section className="panel summary-panel">
              <div className="stat">
                <span className="muted">Volume and fees · 24h</span>
                <strong className="live-unavailable">Not available</strong>
                <span className="muted small-text">
                  This page reads one block and keeps no history.
                </span>
              </div>
            </section>
          </div>
          <section className="panel pools-panel" aria-label="Liquidity pools">
            <div className="table-wrap">
              <table className="pool-table">
                <thead>
                  <tr>
                    <th scope="col">Pool</th>
                    <th scope="col">Reserves</th>
                    <th scope="col">Your share</th>
                    <th scope="col">Pool fee</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {live.snapshot.pools.map((pool) => {
                    const item = data?.pools.find((p) => p.pool.address === pool.address);
                    const usable = !item || isOpen(item.state, item.shares);
                    const position = item?.account
                      ? positionOf(item.state, item.shares, item.account.shares)
                      : null;
                    return (
                      <tr key={pool.address}>
                        <td>
                          <div className="pool-identity">
                            <PairMarks pool={pool} />
                            <strong>{poolName(pool)}</strong>
                          </div>
                          <span className="hashline">
                            <code>{pool.address}</code>
                            <CopyButton value={pool.address} what="address" />
                          </span>
                        </td>
                        <td data-label="Reserves" className="numeric">
                          {formatAmount(pool.reserve0, pool.token0.decimals)} {pool.token0.symbol}
                          <br />
                          {formatAmount(pool.reserve1, pool.token1.decimals)} {pool.token1.symbol}
                        </td>
                        <td data-label="Your share" className="numeric">
                          {!wallet.account
                            ? 'Connect a wallet'
                            : !position
                              ? 'Reading…'
                              : sharePercentText(position.sharePpm, position.shares > 0n)}
                        </td>
                        <td data-label="Pool fee" className="numeric">
                          {POOL_FEE_TEXT}
                        </td>
                        <td>
                          {usable ? (
                            <div className="button-group">
                              <button
                                type="button"
                                className="button primary"
                                aria-label={`Add liquidity to ${poolName(pool)}`}
                                onClick={() => open('add', pool)}
                              >
                                <Plus size={17} aria-hidden="true" /> Add liquidity
                              </button>
                              {position && position.shares > 0n && (
                                <button
                                  type="button"
                                  className="button secondary"
                                  aria-label={`Remove liquidity from ${poolName(pool)}`}
                                  onClick={() => open('remove', pool)}
                                >
                                  <Minus size={17} aria-hidden="true" /> Remove
                                </button>
                              )}
                            </div>
                          ) : (
                            <span className="muted">{NOT_OPEN_LINE}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {notOpen.map(([a, b]) => (
                    <tr key={`${a}/${b}`} data-testid="pool-not-open">
                      <td>
                        <div className="pool-identity">
                          <strong>
                            {a}/{b}
                          </strong>
                        </div>
                      </td>
                      <td colSpan={4} className="muted">
                        {NOT_OPEN_LINE}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-footer">
              <span>
                {live.snapshot.pools.length} open{' '}
                {live.snapshot.pools.length === 1 ? 'pool' : 'pools'} at {wording.settled} block{' '}
                {live.snapshot.finalized.number.toString()}
              </span>
              <span className="muted">Only pools of the reviewed deployment record are listed</span>
            </div>
          </section>
          <LiquidityRisks feeTo={live.deployment.feeTo} facts={facts} />
        </section>
      )}
      {live && view === 'portfolio' && (
        <section
          className="page live-view"
          data-view="portfolio"
          aria-labelledby="live-portfolio-title"
        >
          <header className="page-heading portfolio-heading">
            <div>
              <p className="eyebrow">{wording.title}</p>
              <h1 id="live-portfolio-title">Portfolio</h1>
              <p className="page-subtitle">
                Your liquidity positions on {network.chainName}, as the pools hold them at the{' '}
                {wording.settled} block.
              </p>
            </div>
          </header>
          {status}
          {readError}
          {tracked}
          {!wallet.account ? (
            <div className="panel empty-state">
              <h3>Connect a wallet to see your positions.</h3>
              <p>Reading a position asks nothing of the wallet but its address.</p>
              {connect}
            </div>
          ) : !data ? (
            !error && (
              <p className="muted" role="status">
                Reading your positions at the {wording.settled} block…
              </p>
            )
          ) : (
            <Positions
              items={data.pools}
              onOpen={open}
              onPools={() => go('pools')}
              blockNumber={live.snapshot.finalized.number}
            />
          )}
          {wallet.account && (
            <PositionActivity
              chainId={network.chainId}
              account={wallet.account.address as Address}
            />
          )}
        </section>
      )}
      <div className="live-view" data-view="trade" hidden={view !== 'trade'}>
        {children}
        {live && view === 'trade' && (
          <Market snapshot={live.snapshot} onPools={() => go('pools')} />
        )}
      </div>
      {live && dialog && (
        <LiveLiquidityDialog
          mode={dialog.mode}
          poolAddress={dialog.pool}
          item={dialogItem}
          network={network}
          deployment={live.deployment}
          snapshot={live.snapshot}
          rpc={rpc}
          wallet={wallet}
          now={now}
          pendingSwap={pendingSwap}
          confirmation={props.confirmation}
          receiptPollMs={props.receiptPollMs}
          freshness={props.freshness}
          busyRef={props.busyRef}
          facts={dialogItem ? factsOf(dialogItem.pool) : []}
          initialSlippage={props.slippage() ?? (DEFAULT_SLIPPAGE_BPS / 100).toFixed(2)}
          onMode={(mode) => setDialog({ ...dialog, mode })}
          onActivity={() => go('trade')}
          memory={dialogMemory}
          onClose={() => {
            dialogMemory.current = null;
            setDialog(null);
          }}
        />
      )}
    </>
  );
}

/** Trade screen: the market of each open pool, from the reserves of the snapshot. No history is kept or shown. */
function Market({ snapshot, onPools }: { snapshot: Snapshot; onPools: () => void }) {
  return (
    <section className="panel live-market" aria-labelledby="live-market-title">
      <div className="section-heading">
        <h2 id="live-market-title">Market</h2>
        <button type="button" className="text-link" onClick={onPools}>
          Pools and liquidity
        </button>
      </div>
      {snapshot.pools.map((pool) => {
        return (
          <div className="live-market-pool" key={pool.address}>
            <div className="token-title">
              <PairMarks pool={pool} />
              <div>
                <h3>{poolName(pool)}</h3>
                <p className="muted">
                  Pool ratio at {wording.settled} block {snapshot.finalized.number.toString()}
                </p>
              </div>
            </div>
            <div className="market-stats">
              <div className="stat">
                <span className="muted">Pool ratio</span>
                <strong>{poolRatioText(pool)}</strong>
              </div>
              <div className="stat">
                <span className="muted">Liquidity</span>
                <strong>
                  {formatAmount(pool.reserve0, pool.token0.decimals, 4)} {pool.token0.symbol} +{' '}
                  {formatAmount(pool.reserve1, pool.token1.decimals, 4)} {pool.token1.symbol}
                </strong>
              </div>
              <div className="stat">
                <span className="muted">Pool fee</span>
                <strong>{POOL_FEE_TEXT}</strong>
              </div>
            </div>
          </div>
        );
      })}
      <p className="inline-note">
        <Info size={16} aria-hidden="true" />
        <span>
          Price chart and 24-hour volume are not available: this page reads one block from the chain
          and keeps no history.
        </span>
      </p>
    </section>
  );
}

function Positions({
  items,
  onOpen,
  onPools,
  blockNumber,
}: {
  items: PoolLiquidity[];
  onOpen: (mode: LiquidityMode, pool: LivePool) => void;
  onPools: () => void;
  blockNumber: bigint;
}) {
  const held = items.filter((i) => (i.account?.shares ?? 0n) > 0n);
  if (held.length === 0)
    return (
      <div className="panel empty-state">
        <h3>No liquidity position on this network.</h3>
        <p>This account holds no shares of a pool listed here at block {blockNumber.toString()}.</p>
        <button type="button" className="button secondary" onClick={onPools}>
          See the pools
        </button>
      </div>
    );
  return (
    <>
      {held.map(({ pool, state, shares, account }) => {
        const p = positionOf(state, shares, account!.shares);
        const rows = [
          [0, p.amount0],
          [1, p.amount1],
        ] as const;
        return (
          <section
            className="panel position-breakdown live-position"
            key={pool.address}
            aria-label={`Your position in ${poolName(pool)}`}
          >
            <div className="section-heading">
              <div className="token-title">
                <PairMarks pool={pool} />
                <div>
                  <h2>{poolName(pool)}</h2>
                  <p className="muted">Liquidity position</p>
                </div>
              </div>
              <div className="button-group">
                <button
                  type="button"
                  className="button secondary"
                  aria-label={`Remove liquidity from ${poolName(pool)}`}
                  onClick={() => onOpen('remove', pool)}
                >
                  <Minus size={17} aria-hidden="true" /> Remove liquidity
                </button>
                <button
                  type="button"
                  className="button primary"
                  aria-label={`Add liquidity to ${poolName(pool)}`}
                  onClick={() => onOpen('add', pool)}
                >
                  <Plus size={17} aria-hidden="true" /> Add liquidity
                </button>
              </div>
            </div>
            <div className="market-stats two-stats">
              <div className="stat">
                <span className="muted">Pool share</span>
                <strong>{sharePercentText(p.sharePpm, true)}</strong>
              </div>
              <div className="stat">
                <span className="muted">Pool fee</span>
                <strong>{POOL_FEE_TEXT}</strong>
              </div>
            </div>
            {rows.map(([side, amount]) => {
              const token = side === 0 ? pool.token0 : pool.token1;
              return (
                <div className="position-token" key={side}>
                  <TokenMark symbol={token.symbol} size={0} className="token-icon" />
                  <strong>{token.symbol}</strong>
                  <div>
                    <strong>{formatAmount(amount, token.decimals)}</strong>
                    <span>
                      what a removal of every share would pay at block {blockNumber.toString()}
                    </span>
                  </div>
                </div>
              );
            })}
            <div className="position-details">
              <div className="detail">
                <span className="muted">Pool shares</span>
                <span>{formatAmount(p.shares, 18)}</span>
              </div>
              <div className="detail">
                <span className="muted">Position type</span>
                <span>V2 liquidity</span>
              </div>
              <div className="detail">
                <span className="muted">Protocol fee dilution</span>
                <span>Included in these amounts</span>
              </div>
              <div className="detail">
                <span className="muted">Value in a currency, value history</span>
                <span>
                  Not available: this page has no reviewed price source and keeps no history
                </span>
              </div>
            </div>
            <div className="inline-note">
              <Info size={16} aria-hidden="true" />
              <p>
                The two amounts change with the pool&apos;s price, and the share changes as others
                add or remove liquidity. A removal pays the amounts of that moment.
              </p>
            </div>
          </section>
        );
      })}
    </>
  );
}

/** The liquidity transactions this page sent from this account on this device (the route's own history). */
function PositionActivity({ chainId, account }: { chainId: number; account: Address }) {
  const items = loadHistory(chainId, account).filter((h) =>
    // The labels the liquidity dialog writes, and no other: a swap's approval is not listed here (R413-10).
    /^(Add liquidity: |Remove liquidity: )|^(Approve|Reset) .* (for liquidity|pool shares)$/.test(
      h.label,
    ),
  );
  return (
    <section className="panel activity-panel" aria-labelledby="live-activity-title">
      <div className="section-heading">
        <h2 id="live-activity-title">Position activity</h2>
        <span className="muted small-text">Sent from this page on this device</span>
      </div>
      {items.length === 0 ? (
        <p className="activity-empty">No liquidity transaction from this page yet.</p>
      ) : (
        <ol className="devnet4-steps" aria-label="Liquidity transactions">
          {items.map((h) => (
            <li key={h.hash} data-state={h.state}>
              <strong>{h.label}</strong>: {h.state}{' '}
              <span className="hashline">
                <code>{h.hash}</code>
                <CopyButton value={h.hash} what="transaction hash" />
              </span>
              {h.detail && <span className="muted"> {worded(h.detail)}</span>}
            </li>
          ))}
        </ol>
      )}
      <p className="microcopy">
        {settledCapital()} outcomes only. Transactions sent elsewhere are not listed: this page
        reads no event history.
      </p>
    </section>
  );
}
