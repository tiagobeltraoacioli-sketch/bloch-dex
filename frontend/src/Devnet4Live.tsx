import { useCallback, useEffect, useMemo, useState } from 'react';
import { LoaderCircle, RefreshCw, ShieldCheck, Wallet } from 'lucide-react';
import type { Address, Hex } from 'viem';
import { formatAmount, parseAmount } from './amm';
import {
  allowanceOf,
  approveTransaction,
  deadlineFrom,
  DEFAULT_DEADLINE_MINUTES,
  ensureDevnet4,
  sendTransaction,
  swapTransaction,
  waitForReceipt,
} from './devnet4/swap';
import {
  quoteExactInput,
  readSnapshot,
  type LensQuote,
  type LiveToken,
  type Rpc,
  type Snapshot,
} from './devnet4/chain';
import type { DevnetDeployment } from './devnet4/record';
import type { Provider, WalletAccount, WalletOption } from './wallet';
import { SLIPPAGE_RANGE_TEXT, isAllowedSlippageBps } from './slippage';

export type Devnet4Wallet = {
  account: WalletAccount | null;
  provider: Provider | null;
  wallets: WalletOption[];
  pending: boolean;
  error: string;
  connect(wallet: WalletOption): Promise<void> | void;
};

type Option = { key: string; label: string; token: LiveToken; native: boolean };
type Step = {
  label: string;
  hash?: Hex;
  state: 'waiting' | 'pending' | 'mined' | 'failed';
  detail?: string;
};

const short = (value: string) => `${value.slice(0, 8)}…${value.slice(-6)}`;
const percent = (part: bigint, whole: bigint) =>
  whole === 0n ? '0.00' : (Number((part * 10_000n) / whole) / 100).toFixed(2);

export default function Devnet4Live({
  load,
  rpc,
  walletRpcUrl,
  wallet,
  now = () => Date.now(),
}: {
  load: () => Promise<DevnetDeployment>;
  rpc: Rpc;
  walletRpcUrl: string;
  wallet: Devnet4Wallet;
  now?: () => number;
}) {
  const [deployment, setDeployment] = useState<DevnetDeployment | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [failure, setFailure] = useState('');
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let current = true;
    // A refresh keeps the last snapshot (and any quote or transaction status
    // below it) on screen until the new finalized read replaces it.
    setFailure('');
    void (async () => {
      try {
        const d = await load();
        if (!current) return;
        setDeployment(d);
        const s = await readSnapshot(rpc, d);
        if (current) setSnapshot(s);
      } catch (error) {
        if (current) setFailure(error instanceof Error ? error.message : 'Unavailable.');
      }
    })();
    return () => {
      current = false;
    };
  }, [load, rpc, generation]);

  return (
    <section className="page devnet4-page" aria-labelledby="devnet4-title">
      <div className="section-heading">
        <div>
          <span className="badge">Devnet4 · Zero value · Not mainnet</span>
          <h1 id="devnet4-title">Devnet4 live pools</h1>
          <p className="muted">
            Bloch L2 devnet4 (chain 700771). Tokens here have no value. Pool data is read at the
            finalized L2 block from a reviewed deployment record; swaps are sent only from your
            wallet, one explicit step at a time.
          </p>
        </div>
        <button className="button secondary" onClick={() => setGeneration((g) => g + 1)}>
          <RefreshCw size={16} /> Refresh
        </button>
      </div>
      {failure ? (
        <p className="form-error" role="alert">
          Devnet4 reads are unavailable: {failure}
        </p>
      ) : !deployment || !snapshot ? (
        <p className="muted" role="status">
          <LoaderCircle size={16} className="spin" /> Verifying the deployment record at the
          finalized block…
        </p>
      ) : (
        <>
          <DeploymentPanel deployment={deployment} snapshot={snapshot} />
          <PoolsTable snapshot={snapshot} />
          <SwapPanel
            deployment={deployment}
            snapshot={snapshot}
            rpc={rpc}
            walletRpcUrl={walletRpcUrl}
            wallet={wallet}
            now={now}
            onMined={() => setGeneration((g) => g + 1)}
          />
        </>
      )}
    </section>
  );
}

function DeploymentPanel({
  deployment: d,
  snapshot: s,
}: {
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
          <code>{d.router}</code>
        </dd>
        <dt>Lens</dt>
        <dd>
          <code>{d.lens}</code>
        </dd>
        <dt>Protocol fee recipient</dt>
        <dd>
          <code>{d.feeTo}</code>
        </dd>
      </dl>
    </div>
  );
}

function PoolsTable({ snapshot }: { snapshot: Snapshot }) {
  return (
    <div className="card">
      <h2>Pools at finalized block {snapshot.finalized.number.toString()}</h2>
      <table className="devnet4-pools">
        <thead>
          <tr>
            <th scope="col">Pool</th>
            <th scope="col">Reserves</th>
            <th scope="col">Reserve caps (used)</th>
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
              </td>
              <td>
                {formatAmount(p.cap0, p.token0.decimals)} {p.token0.symbol} (
                {percent(p.reserve0, p.cap0)}%)
                <br />
                {formatAmount(p.cap1, p.token1.decimals)} {p.token1.symbol} (
                {percent(p.reserve1, p.cap1)}%)
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SwapPanel({
  deployment: d,
  snapshot,
  rpc,
  walletRpcUrl,
  wallet,
  now,
  onMined,
}: {
  deployment: DevnetDeployment;
  snapshot: Snapshot;
  rpc: Rpc;
  walletRpcUrl: string;
  wallet: Devnet4Wallet;
  now: () => number;
  onMined: () => void;
}) {
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
  const [slippage, setSlippage] = useState('0.50');
  const [quote, setQuote] = useState<LensQuote | null>(null);
  const [quoteNote, setQuoteNote] = useState('');
  const [allowance, setAllowance] = useState<bigint | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const input = options.find((o) => o.key === inKey);
  const output = options.find((o) => o.key === outKey);
  const amountIn = input ? parseAmount(amount, input.token.decimals) : null;
  const slippageBps = parseAmount(slippage, 2);
  const slippageValid = slippageBps !== null && isAllowedSlippageBps(slippageBps);
  const account = wallet.account?.address.toLowerCase() as Address | undefined;
  const onChain = wallet.account ? BigInt(wallet.account.chainId) === BigInt(d.chainId) : false;

  async function getQuote() {
    setQuote(null);
    setQuoteNote('');
    if (!input || !output || input.key === output.key)
      return setQuoteNote('Choose two different tokens.');
    if (!amountIn || amountIn <= 0n) return setQuoteNote('Enter an amount.');
    if (!slippageValid) return setQuoteNote(`Use a slippage tolerance of ${SLIPPAGE_RANGE_TEXT}.`);
    try {
      const q = await quoteExactInput(
        rpc,
        d,
        input.token.address,
        output.token.address,
        amountIn,
        Number(slippageBps),
      );
      if (!q)
        return setQuoteNote(
          'No route can fill this amount (no liquidity, or a reserve cap would be exceeded).',
        );
      setQuote(q);
      if (account && !input.native)
        setAllowance(await allowanceOf(rpc, d, input.token.address, account));
    } catch (error) {
      setQuoteNote(error instanceof Error ? error.message : 'Quote unavailable.');
    }
  }

  const refreshAllowance = useCallback(async () => {
    if (account && input && !input.native)
      setAllowance(await allowanceOf(rpc, d, input.token.address, account));
    else setAllowance(null);
  }, [account, input, rpc, d]);
  useEffect(() => {
    void refreshAllowance().catch(() => setAllowance(null));
  }, [refreshAllowance]);

  async function run(label: string, build: () => Parameters<typeof sendTransaction>[1]) {
    const provider = wallet.provider;
    if (!provider) return;
    setBusy(true);
    const index = steps.length;
    const update = (step: Step) => setSteps((all) => [...all.slice(0, index), step]);
    update({ label, state: 'waiting', detail: 'Confirm in your wallet.' });
    try {
      await ensureDevnet4(provider, d, walletRpcUrl);
      const hash = await sendTransaction(provider, build());
      update({
        label,
        hash,
        state: 'pending',
        detail: 'Waiting for the next L2 block (10–20 minutes).',
      });
      const receipt = await waitForReceipt(rpc, hash);
      update({
        label,
        hash,
        state: receipt.status === 'success' ? 'mined' : 'failed',
        detail: `${receipt.status === 'success' ? 'Mined' : 'Reverted'} in block ${receipt.blockNumber} (gas ${receipt.gasUsed}).`,
      });
      if (receipt.status === 'success') onMined();
      await refreshAllowance();
    } catch (error) {
      update({
        label,
        state: 'failed',
        detail: error instanceof Error ? error.message : 'Rejected.',
      });
    } finally {
      setBusy(false);
    }
  }

  const needsApproval = !!quote && !!input && !input.native && (allowance ?? 0n) < quote.amountIn;
  return (
    <div className="card devnet4-swap">
      <h2>Swap on devnet4</h2>
      <div className="devnet4-form">
        <label className="field-label">
          You pay
          <select value={inKey} onChange={(e) => (setInKey(e.target.value), setQuote(null))}>
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
            onChange={(e) => (setAmount(e.target.value), setQuote(null))}
          />
        </label>
        <label className="field-label">
          You receive
          <select value={outKey} onChange={(e) => (setOutKey(e.target.value), setQuote(null))}>
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
            onChange={(e) => (setSlippage(e.target.value), setQuote(null))}
          />
        </label>
        <button className="button secondary" onClick={() => void getQuote()}>
          Get quote
        </button>
      </div>
      {quoteNote && (
        <p className="form-error" role="alert">
          {quoteNote}
        </p>
      )}
      {quote && input && output && (
        <dl className="detail-list" aria-label="Quote">
          <dt>Route</dt>
          <dd>
            {quote.path
              .map((a) => snapshot.tokens.find((t) => t.address === a)?.symbol ?? short(a))
              .join(' → ')}
          </dd>
          <dt>Expected output</dt>
          <dd>
            {formatAmount(quote.amountOut, output.token.decimals)} {output.label}
          </dd>
          <dt>Minimum received</dt>
          <dd>
            {formatAmount(quote.minimumOut, output.token.decimals)} {output.label}
          </dd>
          <dt>Quoted at</dt>
          <dd>
            Latest block {quote.blockNumber.toString()} (by the deployed lens, within the reserve
            caps)
          </dd>
          <dt>Deadline</dt>
          <dd>{DEFAULT_DEADLINE_MINUTES} minutes after you confirm (wall-clock seconds)</dd>
        </dl>
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
            {!onChain && ' (it will be asked to switch to devnet4)'}
          </p>
          {needsApproval && quote && input && (
            <button
              className="button primary"
              disabled={busy}
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
            disabled={busy || !quote || needsApproval || !input || !output}
            onClick={() =>
              void run(`Swap ${amount} ${input!.label} for ${output!.label}`, () =>
                swapTransaction(
                  d,
                  quote!,
                  { token: input!.token.address, native: input!.native },
                  { token: output!.token.address, native: output!.native },
                  account!,
                  deadlineFrom(now()),
                ),
              )
            }
          >
            Swap
          </button>
        </div>
      )}
      {steps.length > 0 && (
        <ol className="devnet4-steps" aria-label="Transactions">
          {steps.map((s, i) => (
            <li key={i} data-state={s.state}>
              <strong>{s.label}</strong>: {s.state}
              {s.hash && (
                <>
                  {' '}
                  <code>{s.hash}</code>
                </>
              )}
              {s.detail && <span className="muted"> {s.detail}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
