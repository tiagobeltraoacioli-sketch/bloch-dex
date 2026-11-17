// The bridge route of the Bloch L2 site: deposit an asset on its source network, receive its wrapped token on the
// L2, trade it, exit back. This component owns the reads and the wallet requests; what is shown comes from
// quote.ts (amounts, fees, waits, risks) and status.ts (states), and every transaction from l2.ts (exits through
// the right entry point) or from the per-network builders. A route that is not live gets no read, no address and
// no wallet request: the builders take a `LiveRoute`, which only `liveRoute()` hands out.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LoaderCircle, RefreshCw, Wallet } from 'lucide-react';
import { encodeFunctionData, type Address, type Hex } from 'viem';
import '../styles/bridge.css';
import { formatAmount, parseAmount } from '../amm';
import { ERC20_ABI, readCall, rpcErrorText, type Rpc } from '../devnet4/chain';
import { ensureChain, parseReceipt, sendTransaction, type TransactionRequest } from '../devnet4/swap';
import { addChainParameters, longestQuiet, type MainnetNetwork } from '../mainnet/config';
import { priceNewSlots } from '../mainnet/newslotfee';
import { walletOnChain } from '../mainnet/pendingswap';
import { withWalletRequestLock } from '../mainnet/submission-lock';
import { GateGlyph } from '../shell/BrandMark';
import type { useWallet } from '../useWallet';
import { validAddress } from '../wallet';
import { AssetMark, Exact, LimitsBlock, NetworkPicker, Panel, QuoteBlock, RisksBlock, RouteFacts, RouteState, StatusCard, WaitsBlock, WrappedTokenList } from './BridgeParts';
import { bitcoinFeeEstimate, bitcoinDeposits, evmDeposit, evmSourceGas, evmSourceRpc, readEvmDepositState, readSourceExit, solanaDepositCount, solanaDestination, stellarTrustline, VAULT_ABI, type Fetch } from './observe';
import { depositAddress, parseFeeRate, refundText } from './bitcoin';
import { p2wpkhKeyHash, stellarAddress, tronAddress20 } from './codec';
import { L2_CHAIN_ID, liveRoute, type BridgeConfig, type LiveRoute, type Route } from './config';
import { BridgeError, SOLANA_PROOF_ROUTER_ABI, applyRecovery, creditCalls, recoveryCalls, estimateStepGas, exitSteps, finalizedL2, readBurns, readL2Context, readMints, refusalText, stepTransaction, type BurnObservation, type ExitDestination, type ExitStep, type L2Context, type MintObservation } from './l2';
import { depositWaits, exitWaits, limitLines, money, quoteDeposit, quoteExit, routeRisks, type Direction, type Quote } from './quote';
import { depositInstruction, exitProofMessage, parseSignature, solanaWallet, verifyExitProof, type ExitProof, type ProofFields } from './solana';
import { discoverSolanaSigners, type SolanaSigner } from './solana-wallet';
import { exitStatus, mintStatus, sourceDepositStatus, unfinalizedBurnStatus, type SourceDeposit, type SourceExit, type StatusAction } from './status';
import { stellarDeposit } from './stellar';
import { tronDepositCalls } from './tron';

type WalletState = ReturnType<typeof useWallet>;
type Props = {
  config: BridgeConfig;
  network: MainnetNetwork;
  rpc: Rpc;
  wallet: WalletState;
  now?: () => number;
  fetchImpl?: Fetch;
  /** How often the page reads again by itself while it is visible. */
  refreshMs?: number;
};

const errorText = (error: unknown): string =>
  error instanceof BridgeError ? error.message : rpcErrorText(error instanceof Error ? error.message : String(error));
const declined = (error: unknown) => (error as { code?: number } | null)?.code === 4001;

function routeFromHash(config: BridgeConfig): { id: string; direction: Direction } {
  const [, , id, direction] = location.hash.split('/');
  return {
    id: config.entries.some((e) => e.id === id) ? id : (config.entries[0]?.id ?? ''),
    direction: direction === 'exit' ? 'exit' : 'deposit',
  };
}

/** A transaction of this page that is not yet in a finalized L2 block; kept across reloads, one per account. */
type Pending = { hash: Hex; label: string; kind: 'approve' | 'burn' | 'credit' | 'recovery'; routeId: string; sentAt: number };
const pendingKey = (account: string) => `postern.bridge.pending.v1.${L2_CHAIN_ID}.${account.toLowerCase()}`;
function loadPending(account: string): Pending | null {
  try {
    const p = JSON.parse(localStorage.getItem(pendingKey(account)) ?? 'null') as Pending | null;
    return p && /^0x[0-9a-f]{64}$/.test(p.hash) && typeof p.label === 'string' && typeof p.routeId === 'string' ? p : null;
  } catch {
    return null;
  }
}
function savePending(account: string, pending: Pending | null) {
  try {
    if (pending) localStorage.setItem(pendingKey(account), JSON.stringify(pending));
    else localStorage.removeItem(pendingKey(account));
  } catch {
    /* without storage the hold lasts for this page view only */
  }
}

export default function BridgePage({ config, network, rpc, wallet, now = Date.now, fetchImpl = fetch, refreshMs = 60_000 }: Props) {
  const initial = useMemo(() => routeFromHash(config), [config]);
  const [routeId, setRouteId] = useState(initial.id);
  const [direction, setDirection] = useState<Direction>(initial.direction);
  const [amountText, setAmountText] = useState('');
  const [feeRateText, setFeeRateText] = useState('');
  const [generation, setGeneration] = useState(0);
  const refresh = useCallback(() => setGeneration((g) => g + 1), []);
  const entry = config.entries.find((e) => e.id === routeId) ?? config.entries[0];
  const route = entry?.route ?? null;
  const account = (wallet.account?.address.toLowerCase() ?? null) as Address | null;

  // The L2 itself must be published before any route can be live.
  const l2Reasons = useMemo(() => {
    const reasons: string[] = [];
    if (!network.rpcLive) reasons.push('The public RPC of the Bloch L2 is not published yet.');
    if (!network.genesisHash) reasons.push('The reviewed genesis hash of the Bloch L2 is not pinned yet.');
    return reasons;
  }, [network]);
  const live = l2Reasons.length === 0 ? liveRoute(route) : null;

  useEffect(() => {
    document.title = 'PosternDEX — Bridge';
    window.dispatchEvent(new Event('postern:discover-wallets'));
  }, []);
  useEffect(() => {
    if (!entry) return;
    const next = `#/bridge/${entry.id}/${direction}`;
    if (location.hash !== next) history.replaceState(null, '', next);
  }, [entry, direction]);
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => !document.hidden && refresh(), refreshMs);
    return () => clearInterval(timer);
  }, [live, refresh, refreshMs]);

  // L2 context at the finalized block: balances, allowance, cap headroom, pauses.
  const [context, setContext] = useState<{ key: string; value: L2Context } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const contextKey = `${routeId}:${account ?? ''}`;
  useEffect(() => {
    if (!live) return;
    let current = true;
    readL2Context(rpc, live, network.genesisHash, account).then(
      (value) => current && (setContext({ key: contextKey, value }), setFailure(null)),
      (error) => current && (setContext(null), setFailure(errorText(error))),
    );
    return () => {
      current = false;
    };
  }, [live, rpc, network.genesisHash, account, generation, contextKey]);
  const ctx = live && context?.key === contextKey ? context.value : null;

  // Amounts.
  const assetAmount = route ? parseAmount(amountText, route.asset.decimals) : null;
  const l2Amount = route ? parseAmount(amountText, route.l2.decimals) : null;
  const feeRate = route?.bitcoin ? parseFeeRate(feeRateText, route.bitcoin.policy.feeRateCeiling) : null;
  const quote: Quote | null = useMemo(() => {
    if (!route || amountText.trim() === '') return null;
    if (direction === 'deposit') {
      if (assetAmount === null) return null;
      return quoteDeposit(route, { assetUnits: assetAmount, feeRate: feeRate ?? undefined, capHeadroom: ctx?.capHeadroom });
    }
    if (l2Amount === null) return null;
    return quoteExit(route, { units: l2Amount, maxFeeRate: feeRate ?? undefined, balance: ctx?.balance ?? undefined });
  }, [route, direction, amountText, assetAmount, l2Amount, feeRate, ctx]);
  const amountInvalid = amountText.trim() !== '' && (direction === 'deposit' ? assetAmount === null : l2Amount === null);
  const pace = { blockIntervalSeconds: network.idle.blockIntervalSeconds, longestQuietSeconds: longestQuiet(network.idle) };
  const waits = route ? (direction === 'deposit' ? depositWaits(route, quote?.l2Units ?? route.limits.minDeposit, pace) : exitWaits(route, quote?.l2Units ?? route.limits.l2MinBurn, pace)) : null;

  // Sending on the L2: one wallet request at a time, and a hold until its block is finalized.
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'danger' | 'info' | 'ok'; text: string } | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  useEffect(() => setPending(account ? loadPending(account) : null), [account]);
  useEffect(() => {
    if (!pending || !account) return;
    let current = true;
    const look = async () => {
      try {
        const receipt = parseReceipt(await rpc('eth_getTransactionReceipt', [pending.hash]));
        if (!receipt) return;
        const finalized = await finalizedL2(rpc, network.genesisHash);
        if (finalized.number < receipt.blockNumber || !current) return;
        savePending(account, null);
        setPending(null);
        setNotice(
          receipt.status === 'success'
            ? { tone: 'ok', text: `${pending.label}: done, in finalized L2 block ${receipt.blockNumber}.` }
            : { tone: 'danger', text: `${pending.label}: the transaction reverted in block ${receipt.blockNumber}. Nothing was moved; only the fee was spent.` },
        );
        refresh();
      } catch {
        /* keep the hold; the next look tries again */
      }
    };
    void look();
    const timer = setInterval(() => void look(), 4000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [pending, account, rpc, network.genesisHash, refresh]);

  const sendL2 = useCallback(
    async (label: string, kind: Pending['kind'], call: { to: Address; data: Hex }, step?: ExitStep) => {
      if (!live || !account || !wallet.provider || busy || pending) return;
      setBusy(true);
      setNotice(null);
      try {
        await finalizedL2(rpc, network.genesisHash);
        if (!(await walletOnChain(wallet.provider, L2_CHAIN_ID))) await ensureChain(wallet.provider, addChainParameters(network));
        if (!(await walletOnChain(wallet.provider, L2_CHAIN_ID))) throw new BridgeError('The wallet is not on the Bloch L2 (chain 700770). Nothing was sent.');
        const asStep: ExitStep = step ?? { id: 'burn', title: label, detail: label, ...call };
        let gas: bigint;
        try {
          gas = await estimateStepGas(rpc, account, asStep);
        } catch (error) {
          throw new BridgeError(`${refusalText(error, live) ?? `The L2 would refuse this transaction (${errorText(error)})`} Nothing was sent.`);
        }
        const tx: TransactionRequest = stepTransaction(account, asStep, gas);
        const fee = await priceNewSlots(rpc, { from: account, to: tx.to, data: tx.data, value: 0n, gas }, network.newSlotFee);
        if (fee) Object.assign(tx, { maxPriorityFeePerGas: fee.maxPriorityFeePerGas, maxFeePerGas: fee.maxFeePerGas });
        const hash = await withWalletRequestLock(account, () => sendTransaction(wallet.provider!, tx));
        const record: Pending = { hash, label, kind, routeId: live.id, sentAt: Math.floor(now() / 1000) };
        savePending(account, record);
        setPending(record);
      } catch (error) {
        setNotice(declined(error) ? { tone: 'info', text: 'You declined the request in your wallet. Nothing was sent.' } : { tone: 'danger', text: errorText(error) });
      } finally {
        setBusy(false);
      }
    },
    [live, account, wallet.provider, busy, pending, rpc, network, now],
  );

  // Activity of this account on the selected route: credits and exits, from the L2's logs at the finalized block.
  const [activity, setActivity] = useState<{ key: string; mints: MintObservation[]; burns: { burn: BurnObservation; source: SourceExit }[]; error: string | null } | null>(null);
  useEffect(() => {
    if (!live || !account || !ctx) return;
    let current = true;
    (async () => {
      try {
        const [mints, burns] = await Promise.all([readMints(rpc, live, ctx.finalized, account), readBurns(rpc, live, ctx.finalized, account)]);
        // The destination the signers pay (a claim or a redirect by the burner, final on the L2), then its source state.
        // A Solana router exit with a valid proof follows a redirect only when its own destination is held.
        const withSource = await Promise.all(
          burns.slice(0, 6).map(async (observed) => {
            let burn = applyRecovery(live, observed);
            let source = await readSourceExit(live, burn, fetchImpl);
            if (burn.redirectIgnored && source.kind === 'solana' && source.destination === 'not-a-wallet' && !source.record) {
              burn = applyRecovery(live, observed, true);
              source = await readSourceExit(live, burn, fetchImpl);
            }
            return { burn, source };
          }),
        );
        if (current) setActivity({ key: contextKey, mints, burns: withSource, error: null });
      } catch (error) {
        if (current) setActivity({ key: contextKey, mints: [], burns: [], error: errorText(error) });
      }
    })();
    return () => {
      current = false;
    };
  }, [live, account, ctx, rpc, fetchImpl, contextKey]);
  const shown = activity?.key === contextKey ? activity : null;
  // One recovery form open at a time (a claim or a redirect of one burn).
  const [recovering, setRecovering] = useState<Hex | null>(null);
  const nowSeconds = BigInt(Math.floor(now() / 1000));

  if (!entry)
    return (
      <section className="page bridge-page">
        <Panel tone="danger" title="The bridge configuration could not be read" role="alert">
          <p>No route is shown and nothing can be sent from this page.</p>
        </Panel>
      </section>
    );

  const symbolFrom = direction === 'deposit' ? route?.asset.symbol : route?.l2.symbol;
  const symbolTo = direction === 'deposit' ? route?.l2.symbol : route?.asset.symbol;
  const onAction = (action: StatusAction, mint?: MintObservation) => {
    if (!live) return;
    if (action.id === 'execute-credit' && mint) void sendL2(`Credit of ${formatAmount(mint.amount, live.l2.decimals)} ${live.l2.symbol}`, 'credit', creditCalls.execute(live.l2.token, mint.replayKey));
    if (action.id === 'drain-credits') void sendL2(`Credit the ${live.l2.symbol} deposits that are due`, 'credit', creditCalls.drain(live.l2.token));
  };

  return (
    <section className="page bridge-page" aria-labelledby="bridge-title">
      <div className="bridge-heading">
        <span className="badge">Bloch L2 · Chain {network.chainId} · Bridge</span>
        <h1 id="bridge-title">Bridge</h1>
        <p className="muted">
          Bring an asset from its own network through the gate: it is held in a vault there and you receive its wrapped
          token on the Bloch L2, one token per network. Exit the same way. Everything you pay, wait for and risk is on
          this page before your wallet is asked anything.
        </p>
      </div>

      <div className="live-hero bridge-hero">
        <div className="card bridge-card" data-direction={direction}>
          <div className="segmented bridge-direction" role="group" aria-label="Direction">
            <button type="button" aria-pressed={direction === 'deposit'} onClick={() => (setDirection('deposit'), setNotice(null))}>
              Deposit
            </button>
            <button type="button" aria-pressed={direction === 'exit'} onClick={() => (setDirection('exit'), setNotice(null))}>
              Exit
            </button>
          </div>
          <NetworkPicker entries={config.entries} value={entry.id} onChoose={(id) => (setRouteId(id), setAmountText(''), setNotice(null))} />
          {route && (
            <>
              <div className="bridge-legs">
                <div className="bridge-leg" data-leg="from">
                  <span className="bridge-leg-caption">
                    {direction === 'deposit' ? `From ${route.name}` : 'From the Bloch L2'}
                  </span>
                  <label className="bridge-leg-amount">
                    <span className="visually-hidden">Amount of {symbolFrom}</span>
                    <input
                      className="text-input amount-input"
                      inputMode="decimal"
                      placeholder="0"
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={amountInvalid || undefined}
                      value={amountText}
                      onChange={(e) => setAmountText(e.target.value)}
                    />
                  </label>
                  <span className="bridge-leg-token">
                    <AssetMark symbol={route.asset.symbol} networkId={direction === 'deposit' ? route.id : 'bloch-l2'} networkName={direction === 'deposit' ? route.name : 'Bloch L2'} />
                    {symbolFrom}
                  </span>
                </div>
                <div className="swap-gate bridge-gate" aria-hidden="true">
                  <GateGlyph />
                </div>
                <div className="bridge-leg" data-leg="to">
                  <span className="bridge-leg-caption">
                    {direction === 'deposit' ? 'To the Bloch L2' : `To ${route.name}`}
                    {quote?.ok && quote.receiveIsMinimum ? ', at least' : ''}
                  </span>
                  <span className="bridge-leg-amount amount-output" data-empty={!quote?.ok || undefined} data-testid="bridge-receive">
                    {quote?.ok && quote.receive ? formatAmount(quote.receive.amount, quote.receive.decimals) : '—'}
                  </span>
                  <span className="bridge-leg-token">
                    <AssetMark symbol={route.asset.symbol} networkId={direction === 'deposit' ? 'bloch-l2' : route.id} networkName={direction === 'deposit' ? 'Bloch L2' : route.name} />
                    {symbolTo}
                  </span>
                </div>
              </div>
              {amountInvalid && (
                <p className="form-error" role="alert">
                  Enter the amount as a number with at most {direction === 'deposit' ? route.asset.decimals : route.l2.decimals} decimals.
                </p>
              )}
              {route.bitcoin && (
                <label className="field-label bridge-field">
                  {direction === 'deposit' ? 'Bitcoin fee rate you expect (sat/vB)' : 'Highest Bitcoin fee rate you accept (sat/vB)'}
                  <input className="text-input" inputMode="numeric" placeholder={`1 to ${route.bitcoin.policy.feeRateCeiling}`} value={feeRateText} onChange={(e) => setFeeRateText(e.target.value)} aria-describedby="bridge-fee-rate-help" />
                  <span className="microcopy" id="bridge-fee-rate-help">
                    {direction === 'deposit'
                      ? 'The vault pays the miners from your deposit when it collects it. Enter a rate to see the charge; the real one is set by the signers at that time.'
                      : 'Your payout is never charged above this rate. While the Bitcoin fee market is above it, the exit waits; it cannot be raised afterwards.'}
                    {live && <FeeHint route={live} fetchImpl={fetchImpl} onUse={setFeeRateText} />}
                  </span>
                </label>
              )}
              {ctx && direction === 'exit' && ctx.balance !== null && (
                <p className="microcopy" data-testid="bridge-balance">
                  Your balance at finalized block {ctx.finalized.number.toString()}: {formatAmount(ctx.balance, route.l2.decimals)} {route.l2.symbol}
                </p>
              )}
            </>
          )}

          {live && failure && (
            <Panel tone="danger" title="The Bloch L2 could not be read" role="alert" testId="bridge-read-failure">
              <p>{failure} No transaction can be sent from this page until it can.</p>
              <button type="button" className="button secondary" onClick={refresh}>
                <RefreshCw size={16} aria-hidden="true" /> Read again
              </button>
            </Panel>
          )}

          {live && !failure && (
            <div className="bridge-action" data-testid="bridge-action">
              {!wallet.account ? (
                <div className="wallet-options" data-wallet-connect tabIndex={-1}>
                  <p className="microcopy">Connect the wallet that holds your Bloch L2 account.</p>
                  {wallet.wallets.length === 0 && <p className="muted">No browser wallet found.</p>}
                  {wallet.wallets.map((w) => (
                    <button key={w.id} className="wallet-option" disabled={wallet.pending} onClick={() => void wallet.connect(w)}>
                      <Wallet size={18} /> Connect {w.name}
                    </button>
                  ))}
                  {wallet.error && <p className="form-error">{wallet.error}</p>}
                </div>
              ) : !ctx ? (
                <p className="muted" role="status">
                  <LoaderCircle size={16} className="spin" /> Reading the Bloch L2 at its finalized block…
                </p>
              ) : direction === 'exit' ? (
                <ExitFlow key={`${live.id}:${account}`} route={live} ctx={ctx} account={account!} quote={quote} feeRate={feeRate} busy={busy} held={pending} now={now} fetchImpl={fetchImpl} wallet={wallet} rpc={rpc} onSend={sendL2} />
              ) : (
                <DepositFlow key={`${live.id}:${account}`} route={live} ctx={ctx} account={account!} quote={quote} assetAmount={assetAmount} wallet={wallet} fetchImpl={fetchImpl} />
              )}
              {pending && (
                <Panel tone="wait" title={`${pending.label}: sent, waiting for a finalized L2 block`} role="status" testId="bridge-pending">
                  <p>
                    The page sends nothing else until this transaction is in a finalized block. The L2 makes a block when it
                    has work and finalizes it when its proof settles. Do not send it again.
                  </p>
                  <Exact label="Transaction" value={pending.hash} what="transaction hash" />
                </Panel>
              )}
              {notice && (
                <Panel tone={notice.tone} title={notice.tone === 'ok' ? 'Done' : notice.tone === 'info' ? 'Nothing was sent' : 'Refused'} role={notice.tone === 'danger' ? 'alert' : 'status'} testId="bridge-notice">
                  <p>{notice.text}</p>
                </Panel>
              )}
            </div>
          )}
        </div>
      </div>

      <RouteState entry={entry} l2Reasons={l2Reasons} />

      {route && route.launch.state === 'shown' && (
        <div className="bridge-details">
          {quote ? <QuoteBlock quote={quote} direction={direction} /> : <FeeSummary route={route} direction={direction} />}
          <LimitsBlock lines={limitLines(route, direction)} />
          {waits && <WaitsBlock waits={waits} />}
          <RisksBlock risks={routeRisks(route, direction)} />
          <RouteFacts route={route} />
        </div>
      )}

      {live && account && (
        <div className="bridge-activity" aria-label="Your deposits and exits" data-testid="bridge-activity">
          <div className="bridge-activity-head">
            <h2>
              Your {route!.l2.symbol} deposits and exits
            </h2>
            <button type="button" className="button secondary" onClick={refresh}>
              <RefreshCw size={16} aria-hidden="true" /> Refresh
            </button>
          </div>
          <p className="microcopy">
            Read from the Bloch L2 at its finalized block{ctx ? ` ${ctx.finalized.number}` : ''} and from {route!.name} at its own finality rule. No server of this site is asked.
          </p>
          {pending?.kind === 'burn' && pending.routeId === live.id && ctx && (
            <StatusCard heading="Exit just sent" reference={{ what: 'L2 transaction', value: pending.hash }} status={unfinalizedBurnStatus(live, null, ctx.finalized.number)} />
          )}
          {shown?.error && (
            <Panel tone="danger" title="Your activity could not be read" role="alert">
              <p>{shown.error}</p>
            </Panel>
          )}
          {shown && shown.burns.length === 0 && shown.mints.length === 0 && !shown.error && <p className="muted activity-empty">Nothing yet for this account on this route.</p>}
          {shown?.burns.map(({ burn, source }) => (
            <StatusCard
              key={burn.burnId}
              heading={`Exit of ${formatAmount(burn.amount, live.l2.decimals)} ${live.l2.symbol} to ${burn.recipient}`}
              reference={{ what: 'Burn id', value: burn.burnId }}
              status={exitStatus(live, burn, source, nowSeconds)}
              onAction={(action) => (action.id === 'claim-direct-burn' || action.id === 'redirect-held-burn') && setRecovering(burn.burnId)}
              busy={busy || !!pending}
            >
              {recovering === burn.burnId && ctx && (
                <ExitRecovery route={live} rpc={rpc} ctx={ctx} account={account} burn={burn} busy={busy || !!pending} now={now} fetchImpl={fetchImpl} onClose={() => setRecovering(null)} onSend={sendL2} />
              )}
            </StatusCard>
          ))}
          {shown?.mints.map((mint) => (
            <StatusCard
              key={mint.replayKey}
              heading={`Deposit credit of ${formatAmount(mint.amount, live.l2.decimals)} ${live.l2.symbol}`}
              reference={{ what: 'Deposit id', value: mint.replayKey }}
              status={mintStatus(live, mint, nowSeconds, ctx?.mintsPausedUntil ?? 0n)}
              onAction={(action) => onAction(action, mint)}
              busy={busy || !!pending}
            />
          ))}
        </div>
      )}

      <WrappedTokenList tokens={config.tokens} />
    </section>
  );
}

/** The fees of the route before an amount is typed. */
function FeeSummary({ route, direction }: { route: Route; direction: Direction }) {
  const rate = direction === 'deposit' ? route.fee.depositBps : route.fee.releaseBps;
  return (
    <div className="bridge-block" aria-label="Fees" data-testid="bridge-quote">
      <h3>What you pay and receive</h3>
      <dl className="bridge-lines">
        <div className="bridge-line" data-kind="fee">
          <dt>Bridge fee</dt>
          <dd>{(rate / 100).toFixed(2)}% of the amount</dd>
        </div>
        {route.tron && direction === 'exit' && (
          <div className="bridge-line" data-kind="fee">
            <dt>Fixed release fee</dt>
            <dd>{money({ amount: route.tron.policy.releaseFlat, decimals: route.l2.decimals, symbol: route.asset.symbol })} on every exit</dd>
          </div>
        )}
        {route.tron && direction === 'deposit' && (
          <div className="bridge-line" data-kind="cost">
            <dt>TRON network cost of a deposit</dt>
            <dd>about {route.tron.policy.depositTrxEstimate} TRX (an estimate), paid by you</dd>
          </div>
        )}
        {route.bitcoin && (
          <div className="bridge-line" data-kind="cost">
            <dt>Miner charge</dt>
            <dd>
              fee rate × {direction === 'deposit' ? route.bitcoin.policy.depositVbytes : route.bitcoin.policy.releaseVbytes} vbytes, taken from the amount
            </dd>
          </div>
        )}
        {route.solana && direction === 'deposit' && (
          <div className="bridge-line" data-kind="cost">
            <dt>Solana rent of the deposit record</dt>
            <dd>about {formatAmount(route.solana.policy.depositRentLamports, 9)} SOL, paid by you, not returned</dd>
          </div>
        )}
      </dl>
      <p className="microcopy">Enter an amount to see exactly what you receive.</p>
    </div>
  );
}

function FeeHint({ route, fetchImpl, onUse }: { route: LiveRoute; fetchImpl: Fetch; onUse: (text: string) => void }) {
  const [estimate, setEstimate] = useState<number | null>(null);
  useEffect(() => {
    let current = true;
    void bitcoinFeeEstimate(route, fetchImpl).then((v) => current && setEstimate(v));
    return () => {
      current = false;
    };
  }, [route, fetchImpl]);
  if (estimate === null) return null;
  const ceiling = route.bitcoin!.policy.feeRateCeiling;
  const proposed = Math.min(ceiling, Math.max(2, Math.ceil(estimate * 1.5)));
  return (
    <>
      {' '}
      The next blocks ask about {estimate} sat/vB.{' '}
      <button type="button" className="bridge-link" onClick={() => onUse(String(proposed))}>
        Use {proposed} sat/vB
      </button>{' '}
      (the estimate with a margin of one half).
    </>
  );
}

// ── exit ─────────────────────────────────────────────────────────────────────
function ExitFlow({
  route,
  ctx,
  account,
  quote,
  feeRate,
  busy,
  held,
  now,
  fetchImpl,
  wallet,
  rpc,
  onSend,
}: {
  route: LiveRoute;
  rpc: Rpc;
  ctx: L2Context;
  account: Address;
  quote: Quote | null;
  feeRate: bigint | null;
  busy: boolean;
  held: Pending | null;
  now: () => number;
  fetchImpl: Fetch;
  wallet: WalletState;
  onSend: (label: string, kind: Pending['kind'], call: { to: Address; data: Hex }, step?: ExitStep) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [read, setRead] = useState(false);
  const [check, setCheck] = useState<{ for: string; tone: 'ok' | 'warn' | 'danger'; text: string; blocks: boolean } | null>(null);
  const [proof, setProof] = useState<ExitProof | null>(null);
  const kind = route.kind;
  const trimmed = text;
  const units0 = quote?.ok ? quote.l2Units : null;
  // A proof the router carries is bound to the amount: another amount needs another signature.
  const proofFor = (p: ExitProof | null, wallet: string, units: bigint | null) => !!p && p.wallet === wallet && (route.solana?.proof.carriedBy !== 'router' || (units !== null && p.amount === units));

  // Validation in the page, per network; the router (or the token) checks again on the L2.
  const validation = useMemo((): { ok: true; destination: ExitDestination | null } | { ok: false; reason: string } => {
    if (trimmed === '') return { ok: false, reason: '' };
    if (kind === 'evm') return validAddress(trimmed) ? { ok: true, destination: { kind: 'evm', address: trimmed as Address } } : { ok: false, reason: `Enter the ${route.name} address as 0x and 40 hex characters.` };
    if (kind === 'tvm') {
      const a = tronAddress20(trimmed);
      return a.ok ? { ok: true, destination: { kind: 'tvm', address: trimmed, address20: a.address20 as Address } } : { ok: false, reason: a.reason };
    }
    if (kind === 'utxo') {
      const a = p2wpkhKeyHash(route.bitcoin?.script?.hrp ?? 'bc', trimmed);
      if (!a.ok) return { ok: false, reason: a.reason };
      return { ok: true, destination: feeRate ? { kind: 'utxo', address: trimmed, maxFeeRate: Number(feeRate) } : null };
    }
    if (kind === 'stellar') {
      const a = stellarAddress(trimmed);
      return a.ok ? { ok: true, destination: { kind: 'stellar', address: trimmed } } : { ok: false, reason: a.reason };
    }
    const w = solanaWallet(trimmed, route.asset.id);
    if (!w.ok) return { ok: false, reason: w.reason };
    return { ok: true, destination: proofFor(proof, trimmed, units0) ? { kind: 'svm', proof: proof! } : null };
  }, [trimmed, kind, route, feeRate, proof, units0]);

  // What the source network says about the destination, read before anything is burned.
  useEffect(() => {
    setCheck(null);
    if (!validation.ok) return;
    let current = true;
    const set = (tone: 'ok' | 'warn' | 'danger', message: string, blocks = false) => current && setCheck({ for: trimmed, tone, text: message, blocks });
    if (kind === 'svm')
      solanaDestination(route, trimmed, fetchImpl).then(
        (d) =>
          d.destination === 'not-a-wallet'
            ? set('danger', 'On Solana this address exists and is not a plain wallet (a program owns it, or it holds data). The signers would HOLD an exit to it for good. Choose a wallet you control.', true)
            : set(d.tokenAccount ? 'ok' : 'warn', d.tokenAccount ? 'On Solana this is a wallet address and its USDC account exists.' : 'On Solana this is a wallet address, but it has no USDC token account yet. Create it before or after the burn (receiving any USDC creates it): the payment waits until it exists.'),
        () => set('danger', 'Solana could not be read, so this page cannot check the destination. Nothing is sent until it can.', true),
      );
    if (kind === 'stellar')
      stellarTrustline(route, trimmed, fetchImpl).then(
        (t) =>
          t === 'trusted' || t === 'contract'
            ? set('ok', t === 'contract' ? 'A contract address: it needs no trustline.' : 'This account exists and holds the USDC trustline.')
            : t === 'unauthorized'
              ? set('danger', 'The issuer has revoked this account\'s USDC authorization. It cannot be paid until the issuer restores it.', true)
              : set('danger', t === 'no-account' ? 'This account does not exist on Stellar. Fund it and add the USDC trustline first: an exit to it would stay unpaid until then.' : 'This account holds no USDC trustline. Add the trustline first: an exit to it would stay unpaid until then.', true),
        () => set('danger', 'Stellar could not be read, so this page cannot check the account and its trustline. Nothing is sent until it can.', true),
      );
    return () => {
      current = false;
    };
  }, [validation.ok, trimmed, kind, route, fetchImpl]);

  const destination = validation.ok ? validation.destination : null;
  const units = quote?.ok ? quote.l2Units : null;
  const checkReady = kind !== 'svm' && kind !== 'stellar' ? true : check?.for === trimmed && !check.blocks;
  let steps: ExitStep[] = [];
  let stepError = '';
  if (destination && units !== null && checkReady) {
    try {
      steps = exitSteps(route, units, destination, ctx.allowance ?? 0n);
    } catch (error) {
      stepError = errorText(error);
    }
  }
  const next = steps[0];
  const proofStale = kind === 'svm' && proof?.issued !== undefined && Math.floor(now() / 1000) - proof.issued > route.solana!.policy.proofMaxAgeSeconds;
  const canSend = !!next && read && !busy && !held && !(next.id === 'burn' && proofStale);
  const label: Record<string, string> = { evm: `Recipient on ${route.name}`, tvm: 'Recipient on TRON (T…)', utxo: 'Your Bitcoin address (bc1q…)', stellar: 'Recipient on Stellar (G… or C…)', svm: 'Your Solana wallet address' };
  const hint: Record<string, string> = {
    evm: `An address you control on ${route.name}. The burn names it for good.`,
    tvm: 'As your wallet shows it, starting with T. It needs no TRX to receive.',
    utxo: 'A native segwit address (bc1q…, 42 characters) of a wallet you control. No other address type can be paid.',
    stellar: 'A G… account that already holds a USDC trustline, or a C… contract. No memo can be attached: an exchange deposit that needs a memo cannot be paid.',
    svm: 'A wallet you control: it must sign a message below. An exchange deposit address cannot sign and must not be used.',
  };

  return (
    <div className="bridge-flow" data-testid="exit-flow">
      <label className="field-label bridge-field">
        {label[kind]}
        <input className="text-input bridge-address" autoComplete="off" spellCheck={false} autoCapitalize="off" value={text} onChange={(e) => (setText(e.target.value.trim()), setProof(null))} aria-invalid={(!validation.ok && trimmed !== '') || undefined} data-testid="exit-destination" />
        <span className="microcopy">{hint[kind]}</span>
      </label>
      <p className="bridge-own-wallet" data-testid="exit-own-wallet">
        Exits go to a wallet you control, never to an exchange deposit address: an exchange may not credit a payment from the bridge, and an exit that is paid cannot be called back.
      </p>
      {!validation.ok && validation.reason && (
        <p className="form-error" role="alert" data-testid="exit-destination-error">
          {validation.reason}
        </p>
      )}
      {check && check.for === trimmed && (
        <Panel tone={check.tone} title={check.tone === 'ok' ? `Checked on ${route.name}` : check.blocks ? 'This destination cannot be used' : `Read this before you burn`} role={check.blocks ? 'alert' : 'status'} testId="exit-destination-check">
          <p>{check.text}</p>
        </Panel>
      )}
      {kind === 'svm' && validation.ok && checkReady && (route.solana!.proof.carriedBy === 'page' || units !== null) && (
        <SolanaProof route={route} rpc={rpc} ctx={ctx} wallet={trimmed} account={account} units={units} proof={proofFor(proof, trimmed, units) ? proof : null} stale={proofStale} now={now} onProof={setProof} />
      )}
      {kind === 'svm' && validation.ok && checkReady && route.solana!.proof.carriedBy === 'router' && units === null && <p className="microcopy">Enter the amount first: the message your Solana wallet signs names it.</p>}
      {kind === 'utxo' && validation.ok && !feeRate && <p className="form-error">Name the highest fee rate you accept, above.</p>}
      {stepError && (
        <p className="form-error" role="alert">
          {stepError}
        </p>
      )}
      {quote?.ok && quote.receive && destination && (
        <Panel tone="info" title="Before you sign" testId="exit-summary">
          <p>
            You burn {formatAmount(quote.l2Units, route.l2.decimals)} {route.l2.symbol} and receive {quote.receiveIsMinimum ? 'at least ' : ''}
            {money(quote.receive)} at <span className="bridge-break">{text}</span> on {route.name}.{' '}
            {kind === 'svm' && route.solana!.proof.redirectTemplate
              ? 'The burn cannot be undone. It can be sent to another wallet only if the signers hold it (for example, the destination turns out not to be a wallet), and only by you.'
              : 'The burn cannot be undone or redirected.'}
          </p>
          {steps.length > 0 && (
            <ol className="bridge-steps">
              {steps.map((step) => (
                <li key={step.id}>
                  <strong>{step.title}.</strong> <span className="bridge-break">{step.detail}</span>
                </li>
              ))}
            </ol>
          )}
          <label className="checkbox-label">
            <input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} /> I have read the fees, the wait and the risks of this route on this page.
          </label>
        </Panel>
      )}
      <button
        type="button"
        className="button primary bridge-primary"
        disabled={!canSend}
        data-testid="exit-send"
        onClick={() => next && void onSend(next.id === 'approve' ? `Approval of ${formatAmount(units!, route.l2.decimals)} ${route.l2.symbol}` : `Burn of ${formatAmount(units!, route.l2.decimals)} ${route.l2.symbol}`, next.id, { to: next.to, data: next.data }, next)}
      >
        {busy ? 'Check your wallet…' : next ? next.title : `Exit to ${route.name}`}
      </button>
      <p className="next-step" data-tone={canSend ? 'action' : held ? 'wait' : 'idle'} data-testid="exit-next">
        {held
          ? 'Waiting for the transaction above to be in a finalized L2 block.'
          : !quote?.ok
            ? 'Next: enter an amount within the limits.'
            : !validation.ok
              ? 'Next: enter where the exit is paid.'
              : !checkReady
                ? `Next: the page checks the destination on ${route.name}.`
                : !destination
                  ? kind === 'svm'
                    ? 'Next: sign the destination proof with your Solana wallet.'
                    : 'Next: name the highest Bitcoin fee rate you accept.'
                  : proofStale && next?.id === 'burn'
                    ? 'Next: the proof is too old; sign a new one.'
                    : !read
                      ? 'Next: confirm that you have read the fees, the wait and the risks.'
                      : next?.id === 'approve'
                        ? `Next: ${next.title} opens your wallet. The burn is a second step.`
                        : `Next: ${next?.title ?? 'the burn'} opens your wallet. It burns the tokens.`}
      </p>
      <p className="microcopy">
        Wallet <code>{account}</code>. {wallet.account && BigInt(wallet.account.chainId) !== BigInt(L2_CHAIN_ID) ? 'It will be asked to switch to the Bloch L2 (chain 700770) first.' : ''}
      </p>
    </div>
  );
}

/** The destination-key proof of a Solana exit: the wallet signs one line; the page verifies it before any L2 call. */
function SolanaProof({ route, rpc, ctx, wallet, account, units, proof, stale, now, onProof, redirectOf }: { route: LiveRoute; rpc: Rpc; ctx: L2Context; wallet: string; account: Address; units: bigint | null; proof: ExitProof | null; stale: boolean; now: () => number; onProof: (proof: ExitProof | null) => void; redirectOf?: Hex }) {
  const [signers, setSigners] = useState<SolanaSigner[]>([]);
  const [issued, setIssued] = useState(() => Math.floor(now() / 1000));
  const [pasted, setPasted] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  // What the router-carried format binds the line to, read from the router at the finalized block.
  const [bound, setBound] = useState<{ nonce: bigint; route: Hex; routerLine: string } | null>(null);
  useEffect(() => discoverSolanaSigners((s) => setSigners((list) => (list.some((x) => x.id === s.id) ? list : [...list, s]))), []);
  // A redirect signs the route's redirect line for one burn; an exit signs the exit line for one amount.
  const base = route.solana!.proof;
  const format = useMemo(() => (redirectOf ? { ...base, template: base.redirectTemplate! } : base), [base, redirectOf]);
  const router = route.router!.address!;
  const carried = format.carriedBy === 'router';
  useEffect(() => {
    setBound(null);
    if (!carried || (units === null && !redirectOf)) return;
    let current = true;
    (async () => {
      try {
        const at = { blockHash: ctx.finalized.hash };
        const nonce = await readCall<bigint>(rpc, SOLANA_PROOF_ROUTER_ABI, router, 'nextNonce', [account], at);
        const routeId = await readCall<Hex>(rpc, SOLANA_PROOF_ROUTER_ABI, router, 'route', [], at);
        const routerLine = redirectOf
          ? await readCall<string>(rpc, SOLANA_PROOF_ROUTER_ABI, router, 'redirectMessage', [account, redirectOf, wallet, nonce], at)
          : await readCall<string>(rpc, SOLANA_PROOF_ROUTER_ABI, router, 'exitMessage', [account, units, wallet, nonce], at);
        if (current) (setBound({ nonce: BigInt(nonce), route: routeId, routerLine }), setError(''));
      } catch (e) {
        if (current) setError(`The exit router could not be asked for the message (${errorText(e)}). Nothing is sent.`);
      }
    })();
    return () => {
      current = false;
    };
  }, [carried, units, rpc, router, account, wallet, ctx.finalized.hash, redirectOf]);
  const fieldsAt = useCallback(
    (at: number): ProofFields | null =>
      redirectOf
        ? bound
          ? { wallet, burner: account, router, burnId: redirectOf, nonce: bound.nonce, route: bound.route }
          : null
        : carried
          ? bound && units !== null
            ? { wallet, burner: account, router, amount: units, nonce: bound.nonce, route: bound.route }
            : null
          : { wallet, burner: account, router, issued: at },
    [carried, bound, units, wallet, account, router, redirectOf],
  );
  const fields = fieldsAt(issued);
  const message = useMemo(() => {
    try {
      return fields ? exitProofMessage(format, fields) : null;
    } catch {
      return null;
    }
  }, [format, fields]);
  // The router's own line must be the page's line: a router that would have the wallet sign anything else is not the reviewed one.
  const mismatch = carried && bound !== null && message !== null && bound.routerLine !== message;
  const accept = async (signature: Uint8Array, f: ProofFields) => {
    const verdict = await verifyExitProof({ format, mint: route.asset.id, fields: f, signature, now: Math.floor(now() / 1000), maxAgeSeconds: route.solana!.policy.proofMaxAgeSeconds });
    if (verdict.ok) (onProof(verdict.proof), setError(''));
    else (onProof(null), setError(verdict.reason));
  };
  const signWith = async (signer: SolanaSigner) => {
    setWorking(true);
    setError('');
    try {
      const addresses = await signer.connect();
      if (!addresses.includes(wallet)) throw new Error(`${signer.name} is on another account (${addresses[0]?.slice(0, 8) ?? 'none'}…). Select the destination wallet in it, or enter that wallet's address above.`);
      const at = Math.floor(now() / 1000);
      setIssued(at);
      const f = fieldsAt(at);
      if (!f) throw new Error('The message is not ready yet.');
      await accept(await signer.signMessage(wallet, exitProofMessage(format, f)), f);
    } catch (e) {
      setError(declined(e) ? 'You declined the signature. Nothing was sent.' : e instanceof Error ? e.message.slice(0, 240) : 'The wallet did not sign.');
    } finally {
      setWorking(false);
    }
  };
  const done = proof && !stale;
  return (
    <Panel tone={done ? 'ok' : 'action'} title={done ? 'Destination proven: this wallet signed' : redirectOf ? 'Prove that you control the new destination wallet' : 'Prove that you control the destination wallet'} testId="solana-proof">
      <p>
        Exits go to a wallet you control. {redirectOf ? 'Before the redirect is sent, the NEW wallet' : 'Before the burn, that wallet'} signs the line below: a message, not a Solana transaction; it costs nothing and moves nothing. This page checks the signature itself
        {carried ? `, the exit router publishes it with the ${redirectOf ? 'redirect' : 'burn'}, and every signer checks it again before paying: ${redirectOf ? 'a redirect' : 'an exit'} without a valid one is ${redirectOf ? 'not followed' : 'held'}` : ''}. An exchange deposit address cannot sign and must not be used.
      </p>
      {mismatch ? (
        <p className="form-error" role="alert" data-testid="solana-proof-error">
          The exit router asks for another message than the one this page was reviewed with. Nothing is signed or sent.
        </p>
      ) : message ? (
        <Exact label="Message to sign" value={message} what="message" />
      ) : (
        !error && (
          <p className="muted" role="status">
            <LoaderCircle size={16} className="spin" /> Reading the message from the exit router…
          </p>
        )
      )}
      {done ? (
        <p className="microcopy">
          Signed {proof.envelope === 'text' ? 'as text' : 'as a Solana off-chain message'}.{' '}
          {proof.issued !== undefined
            ? `Valid for ${Math.round(route.solana!.policy.proofMaxAgeSeconds / 60)} minutes: if the burn is sent later, the page asks for a new signature.`
            : redirectOf
              ? 'It is valid for this redirect of this burn only.'
              : 'It is valid for this amount and this exit only: change the amount and the page asks for a new signature.'}
        </p>
      ) : (
        message &&
        !mismatch &&
        fields && (
          <>
            {stale && <p className="form-error">The signature is older than {Math.round(route.solana!.policy.proofMaxAgeSeconds / 60)} minutes. Sign again.</p>}
            <div className="bridge-signers">
              {signers.map((signer) => (
                <button key={signer.id} type="button" className="button secondary" disabled={working} onClick={() => void signWith(signer)}>
                  <Wallet size={16} aria-hidden="true" /> Sign with {signer.name}
                </button>
              ))}
              {signers.length === 0 && <p className="microcopy">No Solana wallet was found in this browser. Sign the message with a hardware wallet or the Solana CLI (solana sign-offchain-message), and paste the signature:</p>}
            </div>
            <label className="field-label bridge-field">
              Or paste the signature (base58, hex or base64)
              <input className="text-input bridge-address" autoComplete="off" spellCheck={false} value={pasted} onChange={(e) => setPasted(e.target.value)} data-testid="solana-signature" />
            </label>
            <button
              type="button"
              className="button secondary"
              disabled={working || pasted.trim() === ''}
              onClick={() => {
                const signature = parseSignature(pasted);
                if (!signature) setError('A signature is 64 bytes, written in base58, hex or base64.');
                else void accept(signature, fields);
              }}
            >
              Check the signature
            </button>
            {!carried && (
              <button type="button" className="bridge-link" onClick={() => (setIssued(Math.floor(now() / 1000)), onProof(null))}>
                New message with the current time
              </button>
            )}
          </>
        )
      )}
      {error && (
        <p className="form-error" role="alert" data-testid="solana-proof-error">
          {error}
        </p>
      )}
    </Panel>
  );
}

/**
 * Recovery of one exit by the account that burned: a Solana redirect of a held burn (or of a burn made directly on the
 * token) to a wallet that signs the route's redirect line, or the set-once claim of a direct burn on Bitcoin or
 * Stellar. Validated in the page, checked on the source network, shown in full before the wallet is asked.
 */
function ExitRecovery({ route, rpc, ctx, account, burn, busy, now, fetchImpl, onClose, onSend }: { route: LiveRoute; rpc: Rpc; ctx: L2Context; account: Address; burn: BurnObservation; busy: boolean; now: () => number; fetchImpl: Fetch; onClose: () => void; onSend: (label: string, kind: Pending['kind'], call: { to: Address; data: Hex }) => Promise<void> }) {
  const [text, setText] = useState('');
  const [rateText, setRateText] = useState('');
  const [read, setRead] = useState(false);
  const [proof, setProof] = useState<ExitProof | null>(null);
  const [check, setCheck] = useState<{ for: string; ok: boolean; text: string } | null>(null);
  const kind = route.kind;
  const amount = `${formatAmount(burn.amount, route.l2.decimals)} ${route.l2.symbol}`;
  const rate = route.bitcoin ? parseFeeRate(rateText, route.bitcoin.policy.feeRateCeiling) : null;
  const validation = useMemo((): { ok: true } | { ok: false; reason: string } => {
    if (text === '') return { ok: false, reason: '' };
    if (kind === 'svm') {
      const w = solanaWallet(text, route.asset.id);
      return w.ok ? { ok: true } : { ok: false, reason: w.reason };
    }
    if (kind === 'stellar') {
      const a = stellarAddress(text);
      return a.ok ? { ok: true } : { ok: false, reason: a.reason };
    }
    const a = p2wpkhKeyHash(route.bitcoin?.script?.hrp ?? 'bc', text);
    return a.ok ? { ok: true } : { ok: false, reason: a.reason };
  }, [text, kind, route]);
  useEffect(() => {
    setCheck(null);
    if (!validation.ok || kind === 'utxo') return;
    let current = true;
    const set = (ok: boolean, message: string) => current && setCheck({ for: text, ok, text: message });
    if (kind === 'svm')
      solanaDestination(route, text, fetchImpl).then(
        (d) => (d.destination === 'not-a-wallet' ? set(false, 'On Solana this address exists and is not a plain wallet. The signers would hold the burn again. Choose a wallet you control.') : set(true, d.tokenAccount ? 'A wallet address with a USDC account.' : 'A wallet address without a USDC account yet: create it, the payment waits for it.')),
        () => set(false, 'Solana could not be read, so the new destination cannot be checked. Nothing is sent until it can.'),
      );
    else
      stellarTrustline(route, text, fetchImpl).then(
        (t) => (t === 'trusted' || t === 'contract' ? set(true, t === 'contract' ? 'A contract address: it needs no trustline.' : 'This account exists and holds the USDC trustline.') : set(false, t === 'unauthorized' ? 'The issuer has revoked this account\'s USDC authorization.' : t === 'no-account' ? 'This account does not exist on Stellar. Fund it and add the USDC trustline first: the claim cannot be changed later.' : 'This account holds no USDC trustline. Add it first: the claim cannot be changed later.')),
        () => set(false, 'Stellar could not be read, so the account cannot be checked. Nothing is sent until it can.'),
      );
    return () => {
      current = false;
    };
  }, [validation.ok, text, kind, route, fetchImpl]);
  const checked = kind === 'utxo' ? true : check?.for === text && check.ok;
  let call: { to: Address; data: Hex } | null = null;
  let detail = '';
  let failure = '';
  try {
    if (validation.ok && checked) {
      if (kind === 'svm' && proof && proof.wallet === text) {
        call = recoveryCalls.redirect(route, burn.burnId, proof);
        detail = `redirectHeldBurn(${burn.burnId}, ${text}, ${proof.nonce}, <the new wallet's signature>) on the exit router`;
      } else if (kind === 'stellar') {
        call = recoveryCalls.claimStellar(route, burn.burnNonce, text);
        detail = `claimDirectBurn(${burn.burnNonce}, ${text}) on the exit router`;
      } else if (kind === 'utxo' && rate) {
        call = recoveryCalls.claimBitcoin(route, burn.burnNonce, text, Number(rate));
        detail = `claimDirectBurn(${burn.burnNonce}, ${text}, ${rate}) on the exit router`;
      }
    }
  } catch (error) {
    failure = errorText(error);
  }
  const verb = kind === 'svm' ? 'Send to another address' : 'Claim this burn';
  return (
    <Panel tone="action" title={kind === 'svm' ? `Send the exit of ${amount} to another wallet` : `Claim the burn of ${amount}`} testId="exit-recovery">
      <p>
        {kind === 'svm'
          ? 'Name the wallet the signers should pay instead. It must be a wallet you control: it signs one line below. The redirect moves nothing on the L2; it counts once it is final, only for a held burn, and never after an approval. A later redirect replaces an earlier one.'
          : 'Name where this burn is paid. The claim is a transaction from the account that burned; it is set once and cannot be changed, so check the address twice.'}{' '}
        Never an exchange deposit address.
      </p>
      <label className="field-label bridge-field">
        {kind === 'svm' ? 'New Solana wallet address' : kind === 'stellar' ? 'Stellar address (G… or C…)' : 'Your Bitcoin address (bc1q…)'}
        <input className="text-input bridge-address" autoComplete="off" spellCheck={false} autoCapitalize="off" value={text} onChange={(e) => (setText(e.target.value.trim()), setProof(null))} aria-invalid={(!validation.ok && text !== '') || undefined} data-testid="recovery-destination" />
      </label>
      {kind === 'utxo' && (
        <label className="field-label bridge-field">
          Highest Bitcoin fee rate you accept (sat/vB)
          <input className="text-input" inputMode="numeric" placeholder={`1 to ${route.bitcoin!.policy.feeRateCeiling}`} value={rateText} onChange={(e) => setRateText(e.target.value)} data-testid="recovery-fee-rate" />
        </label>
      )}
      {!validation.ok && validation.reason && (
        <p className="form-error" role="alert">
          {validation.reason}
        </p>
      )}
      {check && check.for === text && (
        <p className={check.ok ? 'microcopy' : 'form-error'} role={check.ok ? 'status' : 'alert'} data-testid="recovery-check">
          {check.text}
        </p>
      )}
      {kind === 'svm' && validation.ok && checked && (
        <SolanaProof route={route} rpc={rpc} ctx={ctx} wallet={text} account={account} units={null} proof={proof && proof.wallet === text ? proof : null} stale={false} now={now} onProof={setProof} redirectOf={burn.burnId} />
      )}
      {failure && (
        <p className="form-error" role="alert">
          {failure}
        </p>
      )}
      {call && (
        <>
          <p className="microcopy bridge-break" data-testid="recovery-call">
            Your wallet is asked to send {detail}, from {account}. Nothing is burned or moved by it.
          </p>
          <label className="checkbox-label">
            <input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} /> {kind === 'svm' ? 'This is a wallet I control.' : 'This address is mine and correct; I know the claim cannot be changed.'}
          </label>
        </>
      )}
      <div className="bridge-signers">
        <button type="button" className="button primary" disabled={!call || !read || busy} data-testid="recovery-send" onClick={() => call && void onSend(`${verb} (${amount})`, 'recovery', call)}>
          {busy ? 'Check your wallet…' : verb}
        </button>
        <button type="button" className="button secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </Panel>
  );
}

// ── deposit ──────────────────────────────────────────────────────────────────
function DepositFlow({ route, ctx, account, quote, assetAmount, wallet, fetchImpl }: { route: LiveRoute; ctx: L2Context; account: Address; quote: Quote | null; assetAmount: bigint | null; wallet: WalletState; fetchImpl: Fetch }) {
  const [recipientText, setRecipientText] = useState<string>(account);
  const [read, setRead] = useState(false);
  const recipient = validAddress(recipientText) ? (recipientText.toLowerCase() as Address) : null;
  const custodyUnits = assetAmount !== null && assetAmount % route.asset.unitsPerCustodyUnit === 0n ? assetAmount / route.asset.unitsPerCustodyUnit : null;
  const ready = !!quote?.ok && !!recipient && read;
  return (
    <div className="bridge-flow" data-testid="deposit-flow">
      {ctx.mintsPaused && (
        <Panel tone="warn" title={`Credits of ${route.l2.symbol} are paused`} role="status">
          <p>A guardian paused mints on the L2 token. A deposit made now is credited only after the pause.</p>
        </Panel>
      )}
      <label className="field-label bridge-field">
        Bloch L2 address that receives {route.l2.symbol}
        <input className="text-input bridge-address" autoComplete="off" spellCheck={false} value={recipientText} onChange={(e) => setRecipientText(e.target.value.trim())} aria-invalid={!recipient || undefined} data-testid="deposit-recipient" />
        <span className="microcopy">
          {recipient === account ? 'Your connected account.' : 'Not your connected account: the tokens go to this address.'} The deposit names it and cannot be redirected. Do not name a contract unless it can move the token.
        </span>
      </label>
      {!recipient && <p className="form-error">Enter an L2 address: 0x and 40 hex characters, not the zero address.</p>}
      {quote?.ok && quote.receive && recipient && (
        <Panel tone="info" title="Before you send" testId="deposit-summary">
          <p>
            {money(quote.receive)} is credited to <span className="bridge-break">{recipient}</span> on the Bloch L2 after finality on {route.name} and the credit delay.
          </p>
          <label className="checkbox-label">
            <input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} /> I have read the fees, the wait and the risks of this route on this page.
          </label>
        </Panel>
      )}
      {!ready ? (
        <p className="next-step" data-tone="idle" data-testid="deposit-next">
          {!quote?.ok ? 'Next: enter an amount within the limits.' : !recipient ? 'Next: enter the L2 address that receives the tokens.' : `Next: confirm that you have read the fees, the wait and the risks; the page then shows how to deposit on ${route.name}.`}
        </p>
      ) : route.kind === 'evm' ? (
        <EvmDeposit route={route} account={account} recipient={recipient!} amount={custodyUnits!} wallet={wallet} fetchImpl={fetchImpl} />
      ) : route.kind === 'utxo' ? (
        <BitcoinDeposit route={route} recipient={recipient!} account={account} sats={assetAmount!} fetchImpl={fetchImpl} wallet={wallet} />
      ) : route.kind === 'svm' ? (
        <SolanaDeposit route={route} recipient={recipient!} amount={custodyUnits!} fetchImpl={fetchImpl} />
      ) : route.kind === 'tvm' ? (
        <TronDeposit route={route} recipient={recipient!} amount={custodyUnits!} />
      ) : (
        <StellarDeposit route={route} recipient={recipient!} amount={custodyUnits!} />
      )}
      <p className="microcopy">The credit appears under "Your deposits and exits" below once the committee has attested it.</p>
    </div>
  );
}

/** A deposit on an EVM source network, through the injected wallet: exact approval, then the vault's deposit call. */
function EvmDeposit({ route, account, recipient, amount, wallet, fetchImpl }: { route: LiveRoute; account: Address; recipient: Address; amount: bigint; wallet: WalletState; fetchImpl: Fetch }) {
  // Two agreeing endpoints for every read and receipt (R364-6); a route with one endpoint is refused there.
  const source = useMemo(() => { try { return evmSourceRpc(route, fetchImpl); } catch (e) { return (async () => { throw e; }) as Rpc; } }, [route, fetchImpl]);
  const vault = route.custody.address as Address;
  const token = route.asset.id as Address;
  const [state, setState] = useState<{ allowance: bigint; balance: bigint; room: bigint; open: boolean } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<{ hash: Hex; kind: 'approve' | 'deposit' } | null>(null);
  const [tracked, setTracked] = useState<(SourceDeposit & { depositId?: Hex }) | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let current = true;
    (async () => {
      try {
        const { allowance, balance, room, open } = await readEvmDepositState(route, account, fetchImpl);
        if (current) (setState({ allowance, balance, room, open }), setError(''));
      } catch (e) {
        if (current) (setState(null), setError(errorText(e)));
      }
    })();
    return () => {
      current = false;
    };
  }, [route, account, fetchImpl, tick]);
  useEffect(() => {
    if (!sent) return;
    let current = true;
    const look = async () => {
      try {
        if (sent.kind === 'approve') {
          const receipt = parseReceipt(await source('eth_getTransactionReceipt', [sent.hash]));
          if (receipt && current) (setSent(null), setTick((t) => t + 1));
        } else {
          const seen = await evmDeposit(route, sent.hash, fetchImpl);
          if (current) setTracked(seen);
        }
      } catch {
        /* next look */
      }
    };
    void look();
    const timer = setInterval(() => void look(), 4000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [sent, source, route, fetchImpl]);

  const needsApproval = !!state && state.allowance < amount;
  const problem = !state ? '' : !state.open ? `Deposits on ${route.name} are paused or switched off right now.` : state.balance < amount ? `Your ${route.asset.symbol} balance on ${route.name} does not cover this amount.` : state.room < amount ? 'The vault\'s cap leaves no room for this amount.' : '';
  const send = async (kind: 'approve' | 'deposit') => {
    if (!wallet.provider || busy) return;
    setBusy(true);
    setError('');
    try {
      const chainHex = `0x${BigInt(route.chainId).toString(16)}`;
      if (!(await walletOnChain(wallet.provider, Number(route.chainId)))) await wallet.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainHex }] });
      if (!(await walletOnChain(wallet.provider, Number(route.chainId)))) throw new BridgeError(`The wallet is not on ${route.name}. Nothing was sent.`);
      const call =
        kind === 'approve'
          ? { to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [vault, amount] }) }
          : { to: vault, data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'deposit', args: [amount, `0x${recipient.slice(2).padStart(64, '0')}` as Hex] }) };
      const gas = await evmSourceGas(route, account, call, fetchImpl);
      const hash = await withWalletRequestLock(account, () => sendTransaction(wallet.provider!, { from: account, ...call, value: 0n, gas, chainId: Number(route.chainId) }));
      setSent({ hash, kind });
    } catch (e) {
      setError(declined(e) ? 'You declined the request in your wallet. Nothing was sent.' : `${errorText(e)} Nothing was sent.`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="bridge-instruction" data-testid="evm-deposit">
      <ol className="bridge-steps">
        <li data-done={!needsApproval || undefined}>
          <strong>Approve the vault for exactly this amount</strong> on the {route.asset.symbol} contract: approve({vault}, {amount.toString()}).
        </li>
        <li>
          <strong>Deposit</strong>: deposit({amount.toString()}, your L2 address as 32 bytes) on the vault <span className="bridge-break">{vault}</span>.
        </li>
      </ol>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {problem && <p className="form-error">{problem}</p>}
      {tracked ? (
        <StatusCard heading={`Deposit on ${route.name}`} reference={{ what: `${route.name} transaction`, value: sent!.hash }} status={sourceDepositStatus(route, tracked)} />
      ) : (
        <>
          <button type="button" className="button primary bridge-primary" disabled={!state || !!problem || busy || !!sent} onClick={() => void send(needsApproval ? 'approve' : 'deposit')} data-testid="deposit-send">
            {busy ? 'Check your wallet…' : sent ? 'Waiting for the transaction…' : needsApproval ? `Approve ${route.asset.symbol} on ${route.name}` : `Deposit on ${route.name}`}
          </button>
          <p className="next-step" data-tone={state && !problem ? 'action' : 'idle'}>
            {!state ? `Reading ${route.name}…` : needsApproval ? `Next: your wallet switches to ${route.name} and approves the vault; the deposit is a second step.` : `Next: your wallet switches to ${route.name} and sends the deposit.`}
          </p>
        </>
      )}
    </div>
  );
}

function BitcoinDeposit({ route, recipient, account, sats, fetchImpl, wallet }: { route: LiveRoute; recipient: Address; account: Address; sats: bigint; fetchImpl: Fetch; wallet: WalletState }) {
  const derived = useMemo(() => depositAddress(route, recipient), [route, recipient]);
  const [payments, setPayments] = useState<Awaited<ReturnType<typeof bitcoinDeposits>> | null>(null);
  const [refundTo, setRefundTo] = useState('');
  const [refund, setRefund] = useState<{ text: string; signature?: string } | null>(null);
  const [error, setError] = useState('');
  const look = useCallback(() => void bitcoinDeposits(route, derived.address, fetchImpl).then(setPayments, () => setPayments(null)), [route, derived.address, fetchImpl]);
  useEffect(look, [look]);
  const needed = route.bitcoin!.policy.sweepConfirmations + route.finality.confirmations;
  const unit = route.asset.unitsPerCustodyUnit;
  const refundAddress = p2wpkhKeyHash(route.bitcoin!.script!.hrp, refundTo);
  return (
    <div className="bridge-instruction" data-testid="bitcoin-deposit">
      <Panel tone="action" title="Send BTC to your own deposit address">
        <p>
          This address is computed in this page from the vault's keys and your L2 address <span className="bridge-break">{recipient}</span>; whatever is paid to it is credited to that L2 address and to no other. Send {formatAmount(sats, 8)} BTC to it in one ordinary payment from any wallet.
        </p>
        <Exact label="Deposit address (P2WSH)" value={derived.address} what="deposit address" />
        <ul className="bridge-reasons">
          <li>
            One payment must be between {formatAmount(route.limits.minDeposit * unit, 8)} and {formatAmount(route.limits.maxDeposit * unit, 8)} BTC. Outside these bounds it is not credited; only a refund request signed by the L2 address can bring it back.
          </li>
          <li>Check the address in your wallet character by character before you send. Do not reuse an address computed for another L2 address.</li>
          <li>
            {ctx0(route)}
          </li>
        </ul>
        <details className="bridge-verify">
          <summary>Verify this address yourself</summary>
          <p className="microcopy">The witness script behind the address. Its first push is the vault id followed by your L2 address; the rest is the committee's {route.bitcoin!.script!.threshold}-of-{route.bitcoin!.script!.publicKeys.length} keys. The bridge's own tool prints the same address: python3 tools/signatario-btc/btc_relay.py address --recipient {recipient}</p>
          <Exact label="Witness script" value={derived.witnessScript} what="witness script" />
        </details>
      </Panel>
      <div className="bridge-block">
        <div className="bridge-activity-head">
          <h3>Payments seen at this address</h3>
          <button type="button" className="button secondary" onClick={look}>
            <RefreshCw size={16} aria-hidden="true" /> Look again
          </button>
        </div>
        {payments === null ? (
          <p className="muted">Bitcoin could not be read just now.</p>
        ) : payments.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          payments.map((p) => (
            <StatusCard
              key={`${p.txid}:${p.vout}`}
              heading={`${formatAmount(p.sats, 8)} BTC received`}
              reference={{ what: 'Outpoint', value: `${p.txid}:${p.vout}` }}
              status={sourceDepositStatus(route, { seen: true, final: p.confirmations >= needed, confirmations: p.confirmations, needed })}
            />
          ))
        )}
      </div>
      <Panel tone="info" title="Refund of a payment that is not collected">
        <p>
          A payment the vault has not collected (outside the bounds, cap reached, or unwanted) is sent back, less the fee and the miner charge, when the L2 address it names signs this request. The signature is a message, not a transaction. A contract address cannot sign.
        </p>
        <label className="field-label bridge-field">
          Bitcoin address for the refund (bc1q…)
          <input className="text-input bridge-address" value={refundTo} onChange={(e) => (setRefundTo(e.target.value.trim()), setRefund(null))} autoComplete="off" spellCheck={false} />
        </label>
        {refundTo && !refundAddress.ok && <p className="form-error">{refundAddress.reason}</p>}
        {payments?.map((p) => (
          <button
            key={`${p.txid}:${p.vout}`}
            type="button"
            className="button secondary"
            disabled={!refundAddress.ok || recipient !== account || !wallet.provider}
            onClick={async () => {
              setError('');
              try {
                const text = refundText(route, p.txid, p.vout, refundTo);
                const hex = `0x${Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, '0')).join('')}`;
                const signature = (await wallet.provider!.request({ method: 'personal_sign', params: [hex, account] })) as string;
                setRefund({ text, signature });
              } catch (e) {
                setError(declined(e) ? 'You declined the signature.' : errorText(e));
              }
            }}
          >
            Sign the refund request for {p.txid.slice(0, 10)}…:{p.vout}
          </button>
        ))}
        {recipient !== account && <p className="microcopy">Only the L2 address the deposit names can sign: connect that account.</p>}
        {error && <p className="form-error">{error}</p>}
        {refund && (
          <>
            <Exact label="Request" value={refund.text} what="refund request" />
            {refund.signature && <Exact label="Signature" value={refund.signature} what="signature" />}
            <p className="microcopy">Give both to the bridge's relayer operators. This page has no channel to them: the bridge defines none for pages yet.</p>
          </>
        )}
      </Panel>
    </div>
  );
}
const ctx0 = (route: LiveRoute) =>
  `The vault collects the payment after ${route.bitcoin!.policy.sweepConfirmations} confirmations; the credit follows ${route.finality.confirmations} confirmations of that, or more for large amounts.`;

function SolanaDeposit({ route, recipient, amount, fetchImpl }: { route: LiveRoute; recipient: Address; amount: bigint; fetchImpl: Fetch }) {
  const [depositor, setDepositor] = useState('');
  const [count, setCount] = useState<bigint | null>(null);
  const [error, setError] = useState('');
  const wallet = depositor ? solanaWallet(depositor, route.asset.id) : null;
  useEffect(() => {
    let current = true;
    solanaDepositCount(route, fetchImpl).then(
      (n) => current && (setCount(n), setError('')),
      (e) => current && setError(e instanceof Error ? e.message : 'Solana could not be read.'),
    );
    return () => {
      current = false;
    };
  }, [route, fetchImpl]);
  const instruction = useMemo(() => {
    if (!wallet?.ok || count === null) return null;
    try {
      return depositInstruction(route, depositor, amount, recipient, count);
    } catch (e) {
      return e instanceof Error ? e.message : 'The instruction could not be built.';
    }
  }, [wallet, count, route, depositor, amount, recipient]);
  return (
    <div className="bridge-instruction" data-testid="solana-deposit">
      <label className="field-label bridge-field">
        Solana wallet that holds the USDC
        <input className="text-input bridge-address" value={depositor} onChange={(e) => setDepositor(e.target.value.trim())} autoComplete="off" spellCheck={false} data-testid="solana-depositor" />
        <span className="microcopy">It signs the deposit and pays about {formatAmount(route.solana!.policy.depositRentLamports, 9)} SOL of rent for the deposit record, which is not returned.</span>
      </label>
      {wallet && !wallet.ok && <p className="form-error">{wallet.reason}</p>}
      {error && <p className="form-error">Solana could not be read ({error}), so no instruction is shown.</p>}
      {typeof instruction === 'string' && <p className="form-error">{instruction}</p>}
      {instruction && typeof instruction !== 'string' && (
        <Panel tone="action" title="The deposit instruction, unsigned">
          <p>
            One instruction of the vault program, to be signed by your own wallet or the Solana CLI; this page signs nothing on Solana. Its data names the amount and your L2 address <span className="bridge-break">{recipient}</span>.
          </p>
          <Exact label="Program" value={instruction.programId} />
          <Exact label="Data (hex): 01 | amount, 8 bytes little-endian | L2 address" value={instruction.data} what="instruction data" />
          <table className="bridge-accounts">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Account</th>
                <th scope="col">Role</th>
              </tr>
            </thead>
            <tbody>
              {instruction.accounts.map((a, i) => (
                <tr key={`${a.address}:${i}`}>
                  <td>{i + 1}</td>
                  <td>
                    <code>{a.address}</code>
                  </td>
                  <td>
                    {a.role}
                    {a.signer ? ', signer' : ''}
                    {a.writable ? ', writable' : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Exact label="The same as JSON" value={JSON.stringify(instruction)} what="instruction JSON" />
        </Panel>
      )}
    </div>
  );
}

function TronDeposit({ route, recipient, amount }: { route: LiveRoute; recipient: Address; amount: bigint }) {
  const [from, setFrom] = useState('');
  const owner = from ? tronAddress20(from) : null;
  const calls = useMemo(() => {
    if (!owner?.ok) return null;
    try {
      return tronDepositCalls(route, from, amount, recipient);
    } catch (e) {
      return e instanceof Error ? e.message : 'The calls could not be built.';
    }
  }, [owner, route, from, amount, recipient]);
  return (
    <div className="bridge-instruction" data-testid="tron-deposit">
      <label className="field-label bridge-field">
        TRON address that holds the USDT (T…)
        <input className="text-input bridge-address" value={from} onChange={(e) => setFrom(e.target.value.trim())} autoComplete="off" spellCheck={false} data-testid="tron-depositor" />
        <span className="microcopy">It pays the two transactions in TRX: about {route.tron!.policy.depositTrxEstimate} TRX in all at today's energy price (an estimate of the bridge, not measured on mainnet).</span>
      </label>
      {owner && !owner.ok && <p className="form-error">{owner.reason}</p>}
      {typeof calls === 'string' && <p className="form-error">{calls}</p>}
      {calls && typeof calls !== 'string' && (
        <Panel tone="action" title="Two TRON transactions, unsigned">
          <p>Send them in this order from your own wallet (the fields are those of the TRON API's triggersmartcontract). This page signs nothing on TRON. The deposit reverts while the issuer charges a transfer fee or has paused the token.</p>
          {calls.map((call, i) => (
            <div key={call.functionSelector} className="bridge-call">
              <p>
                <strong>
                  {i + 1}. {call.step}
                </strong>
              </p>
              <Exact label="Contract" value={call.contract} />
              <Exact label="Function" value={call.functionSelector} />
              <Exact label="Parameter (ABI-encoded, hex)" value={call.parameter} what="parameter" />
            </div>
          ))}
          <Exact label="Both as JSON" value={JSON.stringify(calls)} what="calls JSON" />
        </Panel>
      )}
    </div>
  );
}

function StellarDeposit({ route, recipient, amount }: { route: LiveRoute; recipient: Address; amount: bigint }) {
  const [from, setFrom] = useState('');
  const source = from ? stellarAddress(from) : null;
  const call = useMemo(() => {
    if (!source?.ok) return null;
    try {
      return stellarDeposit(route, from, amount, recipient);
    } catch (e) {
      return e instanceof Error ? e.message : 'The call could not be built.';
    }
  }, [source, route, from, amount, recipient]);
  return (
    <div className="bridge-instruction" data-testid="stellar-deposit">
      <label className="field-label bridge-field">
        Stellar account that holds the USDC (G…)
        <input className="text-input bridge-address" value={from} onChange={(e) => setFrom(e.target.value.trim())} autoComplete="off" spellCheck={false} data-testid="stellar-depositor" />
        <span className="microcopy">It signs the contract call. A classic payment to the vault's address is not a deposit, and no memo is used.</span>
      </label>
      {source && !source.ok && <p className="form-error">{source.reason}</p>}
      {typeof call === 'string' && <p className="form-error">{call}</p>}
      {call && typeof call !== 'string' && (
        <Panel tone="action" title="The deposit call, unsigned">
          <p>One call of the vault contract, signed by your own account; this page signs nothing on Stellar.</p>
          <Exact label="Contract" value={call.contract} />
          <Exact label="Function" value={`${call.function}(${call.args.map((a) => a.name).join(', ')})`} />
          {call.args.map((a) => (
            <Exact key={a.name} label={`${a.name}: ${a.type}`} value={a.value} />
          ))}
          <Exact label="With the Stellar CLI" value={call.cli} what="command" />
        </Panel>
      )}
    </div>
  );
}
