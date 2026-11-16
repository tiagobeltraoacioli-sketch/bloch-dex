import { QrWalletButton } from './QrWalletButton';
import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, Info, LoaderCircle, Wallet } from 'lucide-react';
import { parseAmount } from './amm';
import { compactUsd, TOKENS, usd } from './data';
import { Detail, ExternalLink, Modal, PairIcons } from './components';
import LiquidityDialog from './LiquidityDialog';
import { Shell } from './shell/Shell';
import { GateGlyph } from './shell/BrandMark';
import { NetworkSwitcher } from './shell/NetworkSwitcher';
import { WalletStatus } from './shell/WalletStatus';
import { networkEntries } from './shell/networks';
import LivePoolsRuntime from './LivePoolsRuntime';
import Pools from './Pools';
import Portfolio from './Portfolio';
import Trade from './Trade';
import { useWallet } from './useWallet';
import { isMetaMaskWallet, METAMASK_MOBILE_URL } from './wallet';
import type { LiquidityAction, Page, Pool } from './model';
import { readLiveReadGate, type LiveReadGate } from './live-gate';
import Devnet4Live from './Devnet4Live';
import { httpRpc } from './devnet4/chain';
import { verifyDeploymentRecord } from './devnet4/record';
import MainnetLive from './MainnetLive';
import { bundledNetwork, bundledState, plannedCaps, plannedPairs } from './mainnet/config';
import { DEFAULT_SLIPPAGE_BPS, SLIPPAGE_RANGE_TEXT, isAllowedSlippageBps } from './slippage';

// Devnet4 live route. The settled RPC sends no CORS headers: the app reads it
// through the dev/preview server proxy at /devnet4-rpc (see README); a wallet
// adding the network uses VITE_DEVNET4_WALLET_RPC_URL.
// The route exists only on the dev server or with VITE_DEVNET4_ROUTE=1, so a
// production bundle holds neither its endpoints nor its deployment record.
const DEVNET4_ROUTE = import.meta.env.DEV || import.meta.env.VITE_DEVNET4_ROUTE === '1';
const DEVNET4_RPC = httpRpc(
  DEVNET4_ROUTE ? (import.meta.env.VITE_DEVNET4_RPC_URL ?? '/devnet4-rpc') : '',
);
const DEVNET4_WALLET_RPC = DEVNET4_ROUTE
  ? (import.meta.env.VITE_DEVNET4_WALLET_RPC_URL ?? 'http://127.0.0.1:18945')
  : '';
const loadDevnet4Record = () => verifyDeploymentRecord();

// Mainnet route (chain 700770). Reads go to the public RPC from the bundled
// network file (it must send CORS headers for this site's origin and appear in
// the CSP connect-src), or to VITE_MAINNET_RPC_URL (a same-origin proxy).
const MAINNET_NETWORK = bundledNetwork();
// The RPC overrides apply only to a local render build (vite.config.ts), which
// shows LOCAL_RENDER_BANNER.
const renderOverride = (value: string | undefined) =>
  __POSTERN_LOCAL_RENDER__ ? value : undefined;
const MAINNET_RPC = httpRpc(
  renderOverride(import.meta.env.VITE_MAINNET_RPC_URL) ?? MAINNET_NETWORK.rpcUrl,
);
const MAINNET_PLANNED = { caps: plannedCaps(), pairs: plannedPairs() };
// bUSDC hold status: the Ethereum RPC of the network file's bridge status, or
// VITE_BRIDGE_ETH_RPC_URL (a same-origin proxy for a local render check).
const MAINNET_HOLD_URL =
  renderOverride(import.meta.env.VITE_BRIDGE_ETH_RPC_URL) ??
  MAINNET_NETWORK.bridges.find((b) => b.status)?.status?.ethRpcUrl;
const MAINNET_ETH_RPC = MAINNET_HOLD_URL ? httpRpc(MAINNET_HOLD_URL) : undefined;
// Header network switcher (presentation only; see shell/networks.ts).
const NETWORKS = networkEntries([
  {
    key: 'bloch-l2',
    name: 'Bloch L2',
    chainId: MAINNET_NETWORK.chainId,
    href: '#/mainnet',
    status: MAINNET_NETWORK.rpcLive ? 'Guarded launch' : 'Not yet live',
  },
  ...(DEVNET4_ROUTE
    ? [
        {
          key: 'devnet4',
          name: 'Bloch L2 devnet4',
          chainId: 700771,
          href: '#/devnet4',
          status: 'Zero value',
        },
      ]
    : []),
  { key: 'preview', name: 'Preview', href: '#/trade', status: 'Sample data, no network' },
]);

const pageFromHash = (): Page =>
  location.hash === '#/pools' ? 'pools' : location.hash === '#/portfolio' ? 'portfolio' : 'trade';
function parseStoredSlippage(raw: string | null) {
  if (raw === null || !/^(?:[1-9][0-9]{0,2})$/.test(raw)) return DEFAULT_SLIPPAGE_BPS;
  const value = Number(raw);
  return isAllowedSlippageBps(value) ? value : DEFAULT_SLIPPAGE_BPS;
}
function storedSlippage() {
  try {
    return parseStoredSlippage(localStorage.getItem('postern.slippage.v1'));
  } catch {
    return DEFAULT_SLIPPAGE_BPS;
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
  const valid = parsed !== null && isAllowedSlippageBps(parsed);
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
        Use {SLIPPAGE_RANGE_TEXT}, with at most two decimal places.
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
        <GateGlyph size={40} />
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
    <Shell
      brandLabel="Postern home"
      navLabel="Main navigation"
      network="preview"
      mainRef={main}
      nav={
        <>
          {(['trade', 'pools', 'portfolio'] as Page[]).map((p) => (
            <a key={p} href={`#/${p}`} aria-current={page === p ? 'page' : undefined}>
              {p === 'trade' ? 'Trade' : p === 'pools' ? 'Pools' : 'Portfolio'}
            </a>
          ))}
          {liveAvailable && <a href="#/live-pools">Live read</a>}
          <a href="#/mainnet">Mainnet</a>
          {DEVNET4_ROUTE && <a href="#/devnet4">Devnet4 live</a>}
        </>
      }
      actions={
        <>
          <NetworkSwitcher
            current="preview"
            entries={NETWORKS}
            label={
              <>
                Bloch L2 <span className="muted">· Preview</span>
              </>
            }
            footer={(close) => (
              <button
                className="popover-action"
                onClick={() => {
                  close();
                  setModal('network');
                }}
              >
                <Info size={16} aria-hidden="true" /> About the preview network
              </button>
            )}
          />
          <button
            className="button connect-button wallet-button"
            data-state={wallet.account ? 'connected' : wallet.pending ? 'pending' : 'disconnected'}
            onClick={() => setModal('wallet')}
          >
            {wallet.account ? (
              <span className="wallet-dot" aria-hidden="true" />
            ) : (
              <Wallet size={16} aria-hidden="true" />
            )}
            <span>
              {wallet.account
                ? `${wallet.account.address.slice(0, 6)}…${wallet.account.address.slice(-4)}`
                : 'Connect wallet'}
            </span>
          </button>
        </>
      }
      footer={
        <>
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
        </>
      }
      after={
        <>
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
                Connection only. Quotes and positions remain sample data. No signatures or
                transactions are requested.
              </p>
              {wallet.account ? (
                <>
                  <div className="connected-account">
                    <Wallet size={28} />
                    <strong>{wallet.account.name}</strong>
                    <code>{wallet.account.address}</code>
                  </div>
                  <Detail label="Wallet chain ID">
                    {BigInt(wallet.account.chainId).toString()}
                  </Detail>
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
                    Allow Postern to view your selected account address. Approve the connection in
                    your wallet.
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
                      Continue in MetaMask: select Connect MetaMask and approve account access. If
                      the app did not open, open MetaMask yourself, choose its browser and enter
                      blochdex.com.
                    </p>
                  )}
                  {wallet.wallets.length === 0 && (
                    <div className="wallet-empty">
                      <Wallet size={32} />
                      <h3>Open your wallet app to connect</h3>
                      <p>
                        On iPhone Safari, tap MetaMask above to open the app. Then select Connect
                        MetaMask inside the app to approve account access. Safari alone does not
                        provide the wallet connection used here.
                      </p>
                      <p>
                        If the app does not open, open MetaMask, choose its browser and enter{' '}
                        <strong>blochdex.com</strong>. On desktop, use a compatible wallet
                        extension.
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
                Wallet connection identifies an EVM account. It does not enable trading or change
                your wallet network.
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
                  Each pool charges a 0.30% swap fee. Fees accrue in the pool; they are not a
                  guaranteed yield. If relative token prices change, your position may be worth less
                  than holding the tokens separately.
                </p>
                <h3>Review before you act</h3>
                <p>
                  A quote is an estimate. Slippage sets your minimum received amount. Multi-pool
                  routes pay a fee at every hop. Deposits and withdrawals can differ from
                  reserve-based estimates for taxed or rebasing assets.
                </p>
                <h3>About this preview</h3>
                <p>
                  All figures are sample data. Deposits, withdrawals and swaps are calculation
                  previews. A wallet connection never replaces these samples with real balances.
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
              <p className="microcopy">
                Symbolic demo assets; no contract addresses are configured.
              </p>
              <button
                className="button primary full-width"
                onClick={() => openLiquidity({ mode: 'add', pool })}
              >
                Preview adding liquidity <ArrowRight size={17} />
              </button>
            </Modal>
          )}
          {liquidity && <LiquidityDialog action={liquidity} onClose={() => setLiquidity(null)} />}
        </>
      }
    >
      {page === 'trade' && <Trade slippage={slippage} onSettings={() => setModal('settings')} />}
      {page === 'pools' && (
        <Pools
          onPool={setPool}
          onAdd={(p) => openLiquidity({ mode: 'add', pool: p })}
          onGuide={() => setModal('guide')}
        />
      )}
      {page === 'portfolio' && <Portfolio onLiquidity={openLiquidity} />}
    </Shell>
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
    <Shell
      network="preview"
      brandLabel="Postern preview home"
      navLabel="Read-only navigation"
      nav={
        <>
          <a href="#/live-pools" aria-current="page">
            Live pools
          </a>
          <a href="#/trade">Preview</a>
        </>
      }
      actions={<span className="badge">Read only · No wallet</span>}
      footer={
        <>
          <span className="footer-status">Reviewed deployment reads only</span>
          <span className="muted">No signing · No transactions · No fixture fallback</span>
        </>
      }
    >
      {gate.available ? (
        <LivePoolsRuntime factory={gate.factory} />
      ) : (
        <LiveReadUnavailable reason={gate.reason} />
      )}
    </Shell>
  );
}

function Devnet4Application() {
  const wallet = useWallet();
  useEffect(() => {
    document.title = 'PosternDEX — Devnet4 live (zero value)';
    window.dispatchEvent(new Event('postern:discover-wallets'));
  }, []);
  return (
    <Shell
      network="devnet4"
      brandLabel="Postern preview home"
      navLabel="Devnet4 navigation"
      nav={
        <>
          <a href="#/devnet4" aria-current="page">
            Devnet4 live
          </a>
          <a href="#/trade">Preview</a>
        </>
      }
      actions={
        <>
          <NetworkSwitcher current="devnet4" entries={NETWORKS} label="Devnet4 · Zero value" />
          <WalletStatus wallet={wallet} chainId={700771} chainName="Bloch L2 devnet4" />
        </>
      }
      footer={
        <>
          <span className="footer-status">Bloch L2 devnet4 · chain 700771 · not mainnet</span>
          <span className="muted">
            Reviewed deployment record · Finalized reads · Explicit wallet transactions
          </span>
        </>
      }
    >
      <Devnet4Live
        load={loadDevnet4Record}
        rpc={DEVNET4_RPC}
        walletRpcUrl={DEVNET4_WALLET_RPC}
        wallet={wallet}
      />
    </Shell>
  );
}

function MainnetApplication() {
  const wallet = useWallet();
  useEffect(() => {
    document.title = 'PosternDEX — Bloch L2 mainnet';
    window.dispatchEvent(new Event('postern:discover-wallets'));
  }, []);
  return (
    <Shell
      network="bloch-l2"
      brandLabel="Postern preview home"
      navLabel="Mainnet navigation"
      nav={
        <>
          <a href="#/mainnet" aria-current="page">
            Mainnet
          </a>
          <a href="#/trade">Preview</a>
        </>
      }
      actions={
        <>
          <NetworkSwitcher
            current="bloch-l2"
            entries={NETWORKS}
            label={<>Bloch L2 · Chain {MAINNET_NETWORK.chainId}</>}
          />
          <WalletStatus
            wallet={wallet}
            chainId={MAINNET_NETWORK.chainId}
            chainName={MAINNET_NETWORK.chainName}
            explorerUrl={MAINNET_NETWORK.explorerUrl || undefined}
          />
        </>
      }
      footer={
        <>
          <span className="footer-status">Bloch L2 mainnet · chain {MAINNET_NETWORK.chainId}</span>
          <span className="muted">
            Reviewed deployment record · Finalized reads · Fixed reserve caps · Explicit wallet
            transactions
          </span>
        </>
      }
    >
      <MainnetLive
        network={MAINNET_NETWORK}
        load={bundledState}
        rpc={MAINNET_RPC}
        wallet={wallet}
        planned={MAINNET_PLANNED}
        ethRpc={MAINNET_ETH_RPC}
      />
    </Shell>
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
  return hash === '#/mainnet' ? (
    <MainnetApplication />
  ) : DEVNET4_ROUTE && hash === '#/devnet4' ? (
    <Devnet4Application />
  ) : hash === '#/live-pools' ? (
    <LiveReadApplication gate={gate} />
  ) : (
    <Application liveAvailable={gate.available} />
  );
}

/** Only a local render build (RPC or configuration overrides) shows this. */
export const LOCAL_RENDER_BANNER =
  'Local render build with RPC or configuration overrides: not for publication.';

export default function App() {
  return (
    <ErrorBoundary>
      {__POSTERN_LOCAL_RENDER__ && import.meta.env.PROD && (
        <p className="form-error local-render-banner" role="alert">
          {LOCAL_RENDER_BANNER}
        </p>
      )}
      <ApplicationRouter />
    </ErrorBoundary>
  );
}
