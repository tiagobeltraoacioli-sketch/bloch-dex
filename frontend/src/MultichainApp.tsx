// The multichain site: the DEX on public EVM chains other than the Bloch L2 (docs/MULTICHAIN-DEPLOY.md). A
// network selector over the bundled chains; the selected chain is shown by the same route component as the
// Bloch L2 mainnet (MainnetLive), with that chain's network file, record, endpoints and wording. Selecting a
// network asks nothing of the wallet: the wallet is asked to switch (wallet_switchEthereumChain, then
// wallet_addEthereumChain when it does not know the chain) by the route's own "Add or switch to …" button, or by
// the route itself right before a transaction. This file is not part of the Bloch L2 site's bundle (multichain.html is its own
// entry, built by vite.multichain.config.ts).
import { Component, useEffect, useMemo, useState, type ReactNode } from 'react';
import MainnetLive from './MainnetLive';
import { setWording } from './mainnet/wording';
import { bundledChains, type Chain } from './multichain/config';
import { fallbackHttpRpc } from './multichain/rpc';
import { useWallet } from './useWallet';

const CHAINS = bundledChains();
export const MULTICHAIN_RENDER_BANNER =
  'Local rehearsal build against loopback forks: not for publication.';

const keyFromHash = (chains: Chain[]): string => {
  const wanted = location.hash.replace(/^#\/?/, '');
  return chains.some((c) => c.key === wanted) ? wanted : chains[0].key;
};

export function MultichainApplication({ chains = CHAINS }: { chains?: Chain[] }) {
  const wallet = useWallet();
  const [key, setKey] = useState(() => keyFromHash(chains));
  useEffect(() => {
    const change = () => setKey(keyFromHash(chains));
    window.addEventListener('hashchange', change);
    window.dispatchEvent(new Event('postern:discover-wallets'));
    return () => window.removeEventListener('hashchange', change);
  }, [chains]);
  const chain = chains.find((c) => c.key === key) ?? chains[0];
  // The route's chain words, before it renders (mainnet/wording.ts).
  setWording(chain.wording);
  const rpc = useMemo(() => fallbackHttpRpc(chain.rpcUrls), [chain]);
  useEffect(() => {
    document.title = `PosternDEX — ${chain.network.chainName}`;
  }, [chain]);
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href={`#/${chains[0].key}`} aria-label="Postern home">
            <img src={`${import.meta.env.BASE_URL}postern.svg`} alt="" width="38" height="38" />
            <span>POSTERN</span>
          </a>
          <nav className="main-nav" aria-label="Networks">
            {chains.map((c) => (
              <a
                key={c.key}
                href={`#/${c.key}`}
                aria-current={c.key === chain.key ? 'page' : undefined}
              >
                {c.network.chainName}
              </a>
            ))}
          </nav>
          <span className="badge">
            {chain.network.chainName} · Chain {chain.network.chainId}
          </span>
        </div>
      </header>
      <main id="main-content" className="main-content">
        <MainnetLive
          key={chain.key}
          network={chain.network}
          load={chain.load}
          rpc={rpc}
          wallet={wallet}
          planned={chain.planned}
        />
      </main>
      <footer className="footer">
        <div className="footer-inner">
          <span className="footer-status">
            {chain.network.chainName} · chain {chain.network.chainId}
          </span>
          <span className="muted">
            Reviewed deployment record · Finalized reads · Explicit wallet transactions · The same
            contracts on every listed network; each network has its own pools and liquidity
          </span>
        </div>
      </footer>
    </div>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="main-content">
        <p className="form-error" role="alert">
          This page could not start with its bundled configuration. Nothing was sent. Reload the
          page; if this stays, do not use this copy of the site.
        </p>
      </main>
    );
  }
}

export default function MultichainApp() {
  return (
    <ErrorBoundary>
      {__POSTERN_LOCAL_RENDER__ && import.meta.env.PROD && (
        <p className="form-error" role="alert">
          {MULTICHAIN_RENDER_BANNER}
        </p>
      )}
      <MultichainApplication />
    </ErrorBoundary>
  );
}
