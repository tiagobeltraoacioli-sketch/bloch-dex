import { QrWalletButton } from './QrWalletButton';
import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, ChevronDown, Info, LoaderCircle, Wallet } from 'lucide-react';
import { parseAmount } from './amm';
import { compactUsd, TOKENS, usd } from './data';
import { Detail, ExternalLink, Modal, PairIcons } from './components';
import LiquidityDialog from './LiquidityDialog';
import LivePoolsRuntime from './LivePoolsRuntime';
import Pools from './Pools';
import Portfolio from './Portfolio';
import Trade from './Trade';
import { useWallet } from './useWallet';
import { isMetaMaskWallet, METAMASK_MOBILE_URL } from './wallet';
import type { LiquidityAction, Page, Pool } from './model';
import { readLiveReadGate, type LiveReadGate } from './live-gate';

const pageFromHash = (): Page =>
  location.hash === '#/pools' ? 'pools' : location.hash === '#/portfolio' ? 'portfolio' : 'trade';
function parseStoredSlippage(raw: string | null) {
  if (raw === null || !/^(?:[1-9][0-9]{0,2})$/.test(raw)) return 50;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 500 ? value : 50;
}
function storedSlippage() {
  try {
    return parseStoredSlippage(localStorage.getItem('postern.slippage.v1'));
  } catch {
    return 50;
  }
}

function Settings({
  value,
  save,
  close,
}: {
  value: number;
  save: (value: number) => void;
  close: () => void;
}) {
  const [input, setInput] = useState((value / 100).toFixed(2));
  const parsed = parseAmount(input, 2);
  const valid = parsed !== null && parsed >= 1n && parsed <= 500n;
  return (
    <Modal title="Swap settings" onClose={close}>
      <p className="muted">Set the maximum output change you would accept.</p>
      <label className="field-label">
        Slippage tolerance (%)
        <input
          className="text-input"
          inputMode="decimal"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          aria-invalid={!valid}
          aria-describedby="slippage-help"
        />
      </label>
      <div className="segmented slippage-presets">
        {['0.10', '0.50', '1.00'].map((p) => (
          <button key={p} aria-pressed={input === p} onClick={() => setInput(p)}>
            {p}%
          </button>
        ))}
      </div>
      <p className={valid ? 'microcopy' : 'form-error'} id="slippage-help">
        Use 0.01% to 5.00%, with at most two decimal places.
      </p>
      {valid && parsed > 100n && (
        <p className="notice">
          A higher tolerance allows a larger reduction in the amount received.
        </p>
      )}
      <button
        className="button primary full-width"
        disabled={!valid}
        onClick={() => {
          if (valid) {
            save(Number(parsed));
            close();
          }
        }}
      >
        Save settings
      </button>
    </Modal>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <main className="error-page">
        <h1>Something interrupted the preview.</h1>
        <p>Your wallet and funds have not been changed.</p>
        <button className="button primary" onClick={() => location.reload()}>
          Reload Postern
        </button>
      </main>
    ) : (
      this.props.children
    );
  }
}

function Application({ liveAvailable }: { liveAvailable: boolean }) {
  const [page, setPage] = useState<Page>(pageFromHash);
  const [modal, setModal] = useState<'wallet' | 'network' | 'guide' | 'settings' | null>(() =>
    ['metamask', 'qr'].includes(new URLSearchParams(location.search).get('connect') || '')
      ? 'wallet'
      : null,
  );
  const [pool, setPool] = useState<Pool | null>(null);
  const [liquidity, setLiquidity] = useState<LiquidityAction | null>(null);
  const [slippage, setSlippage] = useState(storedSlippage);
  const main = useRef<HTMLElement>(null);
  const wallet = useWallet();
  const [mobileOpened, setMobileOpened] = useState(false);
  useEffect(() => {
    if (modal === 'wallet') window.dispatchEvent(new Event('postern:discover-wallets'));
  }, [modal]);
  useEffect(() => {
    const change = () => {
      setPage(pageFromHash());
      main.current?.focus();
    };
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  useEffect(() => {
    document.title = `PosternDEX — ${page === 'trade' ? 'Trade' : page === 'pools' ? 'Pools' : 'Portfolio'}`;
  }, [page]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === 'postern.slippage.v1') setSlippage(parseStoredSlippage(event.newValue));
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  function saveSlippage(value: number) {
    setSlippage(value);
    try {
      localStorage.setItem('postern.slippage.v1', String(value));
    } catch {
      /* Continue with an in-memory preference. */
    }
  }
  function openLiquidity(action: LiquidityAction) {
    setPool(null);
    setLiquidity(action);
  }

  return (
    <div className="app-shell">
      <a
        href="#main-content"
        className="skip-link"
        onClick={(e) => {
          e.preventDefault();
          main.current?.focus();
        }}
      >
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#/trade" aria-label="Postern home">
            <img src={`${import.meta.env.BASE_URL}postern.svg`} alt="" width="38" height="38" />
            <span>POSTERN</span>
          </a>
          <nav className="main-nav" aria-label="Main navigation">
            {(['trade', 'pools', 'portfolio'] as Page[]).map((p) => (
              <a key={p} href={`#/${p}`} aria-current={page === p ? 'page' : undefined}>
                {p === 'trade' ? 'Trade' : p === 'pools' ? 'Pools' : 'Portfolio'}
              </a>
            ))}
            {liveAvailable && <a href="#/live-pools">Live read</a>}
          </nav>
          <div className="header-actions">
            <button className="network-button" onClick={() => setModal('network')}>
              <span className="status-dot" />
              <span>
                Bloch L2 <span className="muted">· Preview</span>
              </span>
              <ChevronDown size={15} />
            </button>
            <button className="button connect-button" onClick={() => setModal('wallet')}>
              <Wallet size={16} />
              <span>
                {wallet.account
                  ? `${wallet.account.address.slice(0, 6)}…${wallet.account.address.slice(-4)}`
                  : 'Connect wallet'}
              </span>
            </button>
          </div>
        </div>
      </header>
      <main id="main-content" ref={main} tabIndex={-1} className="main-content">
        {page === 'trade' && <Trade slippage={slippage} onSettings={() => setModal('settings')} />}
        {page === 'pools' && (
          <Pools
            onPool={setPool}
            onAdd={(p) => openLiquidity({ mode: 'add', pool: p })}
            onGuide={() => setModal('guide')}
          />
        )}
        {page === 'portfolio' && <Portfolio onLiquidity={openLiquidity} />}
      </main>
      <footer className="footer">
        <div className="footer-inner">
          <span className="footer-status">
            <span className="status-dot" /> Interactive preview{' '}
            <span className="footer-divider">/</span> Sample data
          </span>
          <div>
            <button onClick={() => setModal('guide')}>Docs</button>
            <a href="#/pools">Analytics</a>
            <button onClick={() => setModal('settings')}>Settings</button>
            <span className="footer-version">v0.1</span>
          </div>
        </div>
      </footer>

      {modal === 'settings' && (
        <Settings value={slippage} save={saveSlippage} close={() => setModal(null)} />
      )}
      {modal === 'wallet' && (
        <Modal
          title={wallet.account ? 'Connected wallet' : 'Connect a wallet'}
          onClose={() => {
            if (wallet.pending) wallet.disconnect();
            setModal(null);
          }}
        >
          <p className="notice wallet-notice">
            <Info size={18} />
            Connection only. Quotes and positions remain sample data. No signatures or transactions
            are requested.
          </p>
          {wallet.account ? (
            <>
              <div className="connected-account">
                <Wallet size={28} />
                <strong>{wallet.account.name}</strong>
                <code>{wallet.account.address}</code>
              </div>
              <Detail label="Wallet chain ID">{BigInt(wallet.account.chainId).toString()}</Detail>
              <p className="microcopy">
                This is the network reported by your wallet. It is not a configured Postern
                deployment.
              </p>
              <button className="button secondary full-width" onClick={wallet.disconnect}>
                Disconnect from this app
              </button>
            </>
          ) : (
            <>
              <p className="microcopy">
                Allow Postern to view your selected account address. Approve the connection in your
                wallet.
              </p>
              <QrWalletButton onConnect={wallet.connect} disabled={wallet.pending} />
              <div className="wallet-options">
                {wallet.wallets.map((w) => (
                  <button
                    className="wallet-option"
                    key={w.id}
                    aria-label={`Connect ${w.name}`}
                    disabled={wallet.pending}
                    onClick={() => void wallet.connect(w)}
                  >
                    <span className="wallet-option-icon">
                      <Wallet size={23} />
                    </span>
                    <span>
                      <strong>{w.name}</strong>
                      <small>Connect in this browser</small>
                    </span>
                    {wallet.pending ? (
                      <LoaderCircle className="spin" size={20} />
                    ) : (
                      <ArrowRight size={19} />
                    )}
                  </button>
                ))}
                {!wallet.wallets.some(isMetaMaskWallet) && (
                  <a
                    className="wallet-option"
                    href={wallet.pending ? undefined : METAMASK_MOBILE_URL}
                    aria-label="Open MetaMask Mobile"
                    aria-disabled={wallet.pending}
                    referrerPolicy="no-referrer"
                    onClick={(event) => {
                      if (wallet.pending) event.preventDefault();
                      else setMobileOpened(true);
                    }}
                  >
                    <span className="wallet-option-icon">
                      <Wallet size={23} />
                    </span>
                    <span>
                      <strong>MetaMask</strong>
                      <small>Open the MetaMask app to connect</small>
                    </span>
                    <ArrowRight size={19} />
                  </a>
                )}
              </div>
              {mobileOpened && (
                <p role="status" className="notice">
                  Continue in MetaMask: select Connect MetaMask and approve account access. If the
                  app did not open, open MetaMask yourself, choose its browser and enter
                  blochdex.com.
                </p>
              )}
              {wallet.wallets.length === 0 && (
                <div className="wallet-empty">
                  <Wallet size={32} />
                  <h3>Open your wallet app to connect</h3>
                  <p>
                    On iPhone Safari, tap MetaMask above to open the app. Then select Connect
                    MetaMask inside the app to approve account access. Safari alone does not provide
                    the wallet connection used here.
                  </p>
                  <p>
                    If the app does not open, open MetaMask, choose its browser and enter{' '}
                    <strong>blochdex.com</strong>. On desktop, use a compatible wallet extension.
                  </p>
                  <button
                    className="button secondary full-width"
                    disabled={wallet.pending}
                    onClick={() => window.dispatchEvent(new Event('postern:discover-wallets'))}
                  >
                    Check for wallet again
                  </button>
                </div>
              )}
              {wallet.pending && (
                <p role="status" className="muted">
                  Confirm the connection in your wallet…
                </p>
              )}
              {wallet.error && (
                <p role="alert" className="form-error">
                  {wallet.error}
                </p>
              )}
              <button
                className="button secondary full-width"
                onClick={() => {
                  if (wallet.pending) wallet.disconnect();
                  setModal(null);
                }}
              >
                Continue exploring
              </button>
            </>
          )}
        </Modal>
      )}
      {modal === 'network' && (
        <Modal title="Network preview" onClose={() => setModal(null)}>
          <span className="badge">Bloch L2 · Preview</span>
          <p className="notice">
            No live network or contract deployment is configured. All market data, positions and
            operation previews are illustrative.
          </p>
          <p className="muted">
            Wallet connection identifies an EVM account. It does not enable trading or change your
            wallet network.
          </p>
          {wallet.account && (
            <Detail label="Connected wallet chain ID">
              {BigInt(wallet.account.chainId).toString()}
            </Detail>
          )}
          <button className="button primary full-width" onClick={() => setModal(null)}>
            Got it
          </button>
        </Modal>
      )}
      {modal === 'guide' && (
        <Modal title="Understand your liquidity" onClose={() => setModal(null)} wide>
          <div className="guide-content">
            <span className="badge">Postern basics</span>
            <h3>Two tokens. One pool share.</h3>
            <p>
              Adding liquidity deposits both assets in the pool's current ratio. Your LP tokens
              represent a share of its reserves, which change as people trade.
            </p>
            <h3>Fees and position value</h3>
            <p>
              Each pool charges a 0.30% swap fee. Fees accrue in the pool; they are not a guaranteed
              yield. If relative token prices change, your position may be worth less than holding
              the tokens separately.
            </p>
            <h3>Review before you act</h3>
            <p>
              A quote is an estimate. Slippage sets your minimum received amount. Multi-pool routes
              pay a fee at every hop. Deposits and withdrawals can differ from reserve-based
              estimates for taxed or rebasing assets.
            </p>
            <h3>About this preview</h3>
            <p>
              All figures are sample data. Deposits, withdrawals and swaps are calculation previews.
              A wallet connection never replaces these samples with real balances.
            </p>
            <p>
              EVM compatibility belongs to the selected EVM environment. Bloch L1 authorization
              remains a separate post-quantum boundary.
            </p>
            <ExternalLink href="https://github.com/tiagobeltraoacioli-sketch/postern-dex">
              Repository and contract documentation
            </ExternalLink>
          </div>
        </Modal>
      )}
      {pool && (
        <Modal title={`${pool.token0} / ${pool.token1}`} onClose={() => setPool(null)}>
          <div className="liquidity-pair">
            <PairIcons a={pool.token0} b={pool.token1} />
            <span className="badge">Sample pool</span>
          </div>
          <div className="review-details">
            <Detail label="Liquidity">{compactUsd(pool.liquidity)}</Detail>
            <Detail label="Volume · 24h">{usd(pool.volume, 0)}</Detail>
            <Detail label="Fees · 24h">{usd(pool.fees)}</Detail>
            <Detail label="Pool fee">0.30%</Detail>
            <Detail label={TOKENS[pool.token0].name}>{pool.token0}</Detail>
            <Detail label={TOKENS[pool.token1].name}>{pool.token1}</Detail>
          </div>
          <p className="microcopy">Symbolic demo assets; no contract addresses are configured.</p>
          <button
            className="button primary full-width"
            onClick={() => openLiquidity({ mode: 'add', pool })}
          >
            Preview adding liquidity <ArrowRight size={17} />
          </button>
        </Modal>
      )}
      {liquidity && <LiquidityDialog action={liquidity} onClose={() => setLiquidity(null)} />}
    </div>
  );
}

function LiveReadUnavailable({
  reason,
}: {
  reason: Exclude<LiveReadGate, { available: true }>['reason'];
}) {
  const loading = reason === 'loading';
  return (
    <section className="panel pools-panel" aria-labelledby="live-read-unavailable-title">
      <p className="eyebrow">READ-ONLY GATE</p>
      <h1 id="live-read-unavailable-title">Live pool data is unavailable.</h1>
      <p className="notice" role={loading ? 'status' : 'alert'}>
        {loading
          ? 'Authenticating the read-only configuration…'
          : reason === 'missing'
            ? 'This host did not provide a reviewed read-only configuration.'
            : reason === 'untrusted'
              ? 'The host read-only configuration could not be authenticated.'
              : 'The host read-only configuration did not pass validation.'}
      </p>
      <p className="microcopy">Preview fixtures were not substituted on this route.</p>
      <a className="button secondary" href="#/trade">
        Return to preview
      </a>
    </section>
  );
}

function LiveReadApplication({ gate }: { gate: LiveReadGate }) {
  useEffect(() => {
    document.title = 'PosternDEX — Live read only';
  }, []);
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#/trade" aria-label="Postern preview home">
            <img src={`${import.meta.env.BASE_URL}postern.svg`} alt="" width="38" height="38" />
            <span>POSTERN</span>
          </a>
          <nav className="main-nav" aria-label="Read-only navigation">
            <a href="#/live-pools" aria-current="page">
              Live pools
            </a>
            <a href="#/trade">Preview</a>
          </nav>
          <span className="badge">Read only · No wallet</span>
        </div>
      </header>
      <main id="main-content" className="main-content">
        {gate.available ? (
          <LivePoolsRuntime factory={gate.factory} />
        ) : (
          <LiveReadUnavailable reason={gate.reason} />
        )}
      </main>
      <footer className="footer">
        <div className="footer-inner">
          <span className="footer-status">Reviewed deployment reads only</span>
          <span className="muted">No signing · No transactions · No fixture fallback</span>
        </div>
      </footer>
    </div>
  );
}

function ApplicationRouter() {
  const [hash, setHash] = useState(location.hash);
  const [gate, setGate] = useState<LiveReadGate>({ available: false, reason: 'loading' });
  useEffect(() => {
    let current = true;
    void readLiveReadGate().then((result) => {
      if (current) setGate(result);
    });
    return () => {
      current = false;
    };
  }, []);
  useEffect(() => {
    const change = () => setHash(location.hash);
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  return hash === '#/live-pools' ? (
    <LiveReadApplication gate={gate} />
  ) : (
    <Application liveAvailable={gate.available} />
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <ApplicationRouter />
    </ErrorBoundary>
  );
}
