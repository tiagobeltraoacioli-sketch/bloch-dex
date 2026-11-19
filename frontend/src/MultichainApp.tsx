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
import { tokenFacts } from './multichain/token-facts';
import { routeKeyOfHash } from './live/view';
import { chainHttpRpc } from './multichain/rpc';
import { useWallet } from './useWallet';
import { Shell } from './shell/Shell';
import { NetworkSwitcher } from './shell/NetworkSwitcher';
import { WalletStatus } from './shell/WalletStatus';
import { networkEntries } from './shell/networks';
import { NetworkGlyph } from './marks/NetworkGlyph';

const CHAINS = bundledChains();
/** The token list's statement per listed token (the liquidity screens' issuer-powers line). */
const TOKEN_FACTS = tokenFacts();
/** A pending swap is looked up this often: these chains settle in seconds, the Bloch L2 route's default is 10 s. */
const RECEIPT_POLL_MS = 4_000;
/**
 * Background renewal of the snapshot block (reviews R328-5, R328-3P-2). Every chain's first two endpoints, and a
 * third where listed, answered reads pinned to a block 300 s old and older (the reviewer's probe and the live
 * check with a snapshot kept ten minutes), so the pin is renewed every four minutes, not every 30 s. The route
 * must renew on demand as well (before a quote when the snapshot is older than this, and when a pinned read is
 * refused as UNCONFIRMED) and must never renew under a user who is typing or reading a quote.
 */
export const SNAPSHOT_MAX_AGE_MS = 240_000;
/** The site's name (owner, 2026-11-18: this DEX is "Bloch DEX"; "PosternDEX" is the perpetuals exchange). */
export const MULTICHAIN_SITE_NAME = 'Bloch DEX';
/** Shown on every route while no bundled record is of an open pool: the site is published before activation. */
export const MULTICHAIN_NOT_ACTIVE_BANNER =
  'Bloch DEX is not active yet. No pool is open on any network: nothing can be traded here, and this site sends no transaction.';
export const MULTICHAIN_RENDER_BANNER =
  'Local rehearsal build against loopback forks: not for publication.';

const keyFromHash = (chains: Chain[]): string => {
  // The first segment names the network; a second names a screen of it (`#/ethereum/pools`, live/view.ts).
  const wanted = routeKeyOfHash(location.hash);
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
  // Hash-pinned reads from two agreeing endpoints, settled by this chain's confirmation rule (multichain/rpc.ts).
  const rpc = useMemo(() => chainHttpRpc(chain.rpcUrls, chain.confirmation), [chain]);
  // What the route shows of the rule: the note (always on the page) and the count a sent swap is measured by.
  const confirmationView = useMemo(
    () => ({
      note: chain.confirmationNote,
      rule: chain.confirmation.settle,
      blockSeconds: chain.blockSeconds,
      // A reverted swap holds the account until this rule has passed (submission-outcome.ts `revertedOf`).
      reverted: chain.confirmation.reverted ?? chain.confirmation.strict,
    }),
    [chain],
  );
  useEffect(() => {
    document.title = `${MULTICHAIN_SITE_NAME} — ${chain.network.chainName}`;
  }, [chain]);
  // Header status of each network, from its bundled record (no RPC request: `load` reads the bundle).
  const [live, setLive] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let current = true;
    void Promise.all(
      chains.map((c) =>
        c.load().then(
          (state) => [c.key, state.status === 'live'] as const,
          () => [c.key, false] as const,
        ),
      ),
    ).then((entries) => current && setLive(Object.fromEntries(entries)));
    return () => {
      current = false;
    };
  }, [chains]);
  const entries = useMemo(
    () =>
      networkEntries(
        chains.map((c) => ({
          key: c.key,
          name: c.network.chainName,
          chainId: c.network.chainId,
          href: `#/${c.key}`,
          status: live[c.key] ? 'Live' : 'Not yet live',
        })),
        [],
      ),
    [chains, live],
  );
  return (
    <Shell
      network={chain.key}
      brandLabel={`${MULTICHAIN_SITE_NAME} home`}
      wordmark={MULTICHAIN_SITE_NAME}
      homeHref={`#/${chains[0].key}`}
      navLabel="Networks"
      nav={chains.map((c) => (
        <a key={c.key} href={`#/${c.key}`} aria-current={c.key === chain.key ? 'page' : undefined}>
          <NetworkGlyph network={c.key} size={18} />
          {c.network.chainName}
        </a>
      ))}
      actions={
        <>
          <NetworkSwitcher
            current={chain.key}
            entries={entries}
            label={
              <>
                {chain.network.chainName} · Chain {chain.network.chainId}
              </>
            }
          />
          <WalletStatus
            wallet={wallet}
            chainId={chain.network.chainId}
            chainName={chain.network.chainName}
            explorerUrl={chain.network.explorerUrl || undefined}
          />
        </>
      }
      footer={
        <>
          <span className="footer-status">
            {chain.network.chainName} · chain {chain.network.chainId}
          </span>
          <span className="muted">
            Reviewed deployment record · Reads pinned to one block, from two endpoints that agree ·
            Explicit wallet transactions · The same contracts on every listed network; each network
            has its own pools and liquidity
          </span>
        </>
      }
    >
      {Object.keys(live).length === chains.length && !Object.values(live).some(Boolean) && (
        <p className="notice not-active-banner" role="status" data-testid="not-active-banner">
          {MULTICHAIN_NOT_ACTIVE_BANNER}
        </p>
      )}
      {/* Agent 343's token notes (a label such as "USDC (Binance-Peg)" is explained on screen, without a click). */}
      {chain.tokenNotes.map((note) => (
        <p className="muted token-note" data-testid="token-note" key={note}>
          {note}
        </p>
      ))}
      <MainnetLive
        key={chain.key}
        network={chain.network}
        load={chain.load}
        rpc={rpc}
        wallet={wallet}
        planned={chain.planned}
        receiptPollMs={RECEIPT_POLL_MS}
        snapshotMaxAgeMs={SNAPSHOT_MAX_AGE_MS}
        confirmation={confirmationView}
        screens={{ base: `#/${chain.key}`, tokenFacts: TOKEN_FACTS[chain.key] }}
      />
    </Shell>
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
        <p className="form-error local-render-banner" role="alert">
          {MULTICHAIN_RENDER_BANNER}
        </p>
      )}
      <MultichainApplication />
    </ErrorBoundary>
  );
}
