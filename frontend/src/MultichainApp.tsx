// The multichain site: the DEX on public EVM chains other than the Bloch L2 (docs/MULTICHAIN-DEPLOY.md), and
// since round 20 the Bloch L2 itself as a seventh network of its own kind (`BLOCH_L2` below). A
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
import { ConnectSlotContext } from './shell/connect-slot';
import { useMobileWalletConnect } from './multichain/MobileWalletConnect';
import { blochL2Entry, isBlochL2, type BlochL2Entry } from './multichain/bloch-l2';
import { BlochL2Route } from './multichain/BlochL2Route';
import { showCurrentNetwork } from './multichain/nav-scroll';

const CHAINS = bundledChains();
/**
 * The seventh network (owner, 2026-11-19): the Bloch L2, from the Bloch L2 site's own files, with its own reader
 * and rules (multichain/bloch-l2.ts). It is not a chain of deployments/multichain.json and takes none of the
 * public chains' props below.
 */
const BLOCH_L2 = blochL2Entry();
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
/** The header's "Connect wallet" on a route whose record is not live: said, not silent; nothing is asked or read. */
export const connectUnavailableNote = (chainName: string) =>
  `Connecting a wallet becomes available when ${chainName} is live on ${MULTICHAIN_SITE_NAME}. Nothing was asked of any wallet.`;
export const MULTICHAIN_RENDER_BANNER =
  'Local rehearsal build against loopback forks: not for publication.';

const keyFromHash = (chains: { key: string }[]): string => {
  // The first segment names the network; a second names a screen of it (`#/ethereum/pools`, live/view.ts).
  const wanted = routeKeyOfHash(location.hash);
  return chains.some((c) => c.key === wanted) ? wanted : chains[0].key;
};

export function MultichainApplication({
  chains: publicChains = CHAINS,
  l2 = BLOCH_L2,
}: {
  chains?: Chain[];
  /** The Bloch L2 entry, listed after the public chains; `null` leaves it out. */
  l2?: BlochL2Entry | null;
}) {
  const wallet = useWallet();
  const chains = useMemo<(Chain | BlochL2Entry)[]>(
    () => (l2 ? [...publicChains, l2] : publicChains),
    [publicChains, l2],
  );
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
  // The Bloch L2 has neither: its route (multichain/BlochL2Route.tsx) reads through its entry's own reader and
  // gets no confirmation rule; for it the value below is that same reader and is not passed on from here.
  const rpc = useMemo(
    () => (isBlochL2(chain) ? chain.rpc : chainHttpRpc(chain.rpcUrls, chain.confirmation)),
    [chain],
  );
  // What the route shows of the rule: the note (always on the page) and the count a sent swap is measured by.
  const confirmationView = useMemo(
    () =>
      isBlochL2(chain)
        ? undefined
        : {
            note: chain.confirmationNote,
            rule: chain.confirmation.settle,
            blockSeconds: chain.blockSeconds,
            // A reverted swap holds the account until this rule has passed (submission-outcome.ts `revertedOf`).
            reverted: chain.confirmation.reverted ?? chain.confirmation.strict,
          },
    [chain],
  );
  useEffect(() => {
    document.title = `${MULTICHAIN_SITE_NAME} — ${chain.network.chainName}`;
    // Seven names do not fit a phone's header list: the selected one is scrolled into the list's view.
    showCurrentNetwork();
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
  // The mobile-wallet session is offered the networks whose bundled record is live, and only those: a record goes
  // live with a new build of the site, which a session (kept in memory) does not outlive anyway.
  // Never the Bloch L2 (agent 415): wallet apps do not know chain 700770 and a network cannot be added inside a
  // session, so asking for it would change what every wallet is shown on the six public networks for a chain the
  // session could not serve. Its route says which connection works there (multichain/BlochL2Route.tsx).
  const liveChains = useMemo(
    () =>
      chains
        .filter((c) => !isBlochL2(c) && live[c.key])
        .map((c) => ({ chainId: c.network.chainId, name: c.network.chainName })),
    [chains, live],
  );
  const mobile = useMobileWalletConnect({
    wallet,
    chains: liveChains,
    route: { chainId: chain.network.chainId, name: chain.network.chainName },
  });
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
      site="multichain"
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
            unavailable={
              live[chain.key] === false
                ? connectUnavailableNote(chain.network.chainName)
                : undefined
            }
          />
        </>
      }
      after={mobile.dialog}
      footer={
        <>
          <span className="footer-status">
            {chain.network.chainName} · chain {chain.network.chainId}
          </span>
          {isBlochL2(chain) ? (
            // The Bloch L2 site's own line: one endpoint read at the chain's finalized block, and fixed caps.
            <span className="muted">
              Reviewed deployment record · Finalized reads · Fixed reserve caps · Explicit wallet
              transactions
            </span>
          ) : (
            <span className="muted">
              Reviewed deployment record · Reads pinned to one block, from two endpoints that agree
              · Explicit wallet transactions · The same contracts on every listed network; each
              network has its own pools and liquidity
            </span>
          )}
        </>
      }
    >
      {Object.keys(live).length === chains.length && !Object.values(live).some(Boolean) && (
        <p className="notice not-active-banner" role="status" data-testid="not-active-banner">
          {MULTICHAIN_NOT_ACTIVE_BANNER}
        </p>
      )}
      {/* Agent 343's token notes (a label such as "USDC (Binance-Peg)" is explained on screen, without a click). */}
      {(isBlochL2(chain) ? [] : chain.tokenNotes).map((note) => (
        <p className="muted token-note" data-testid="token-note" key={note}>
          {note}
        </p>
      ))}
      {mobile.session}
      <ConnectSlotContext.Provider value={mobile.button}>
        {isBlochL2(chain) ? (
          <BlochL2Route
            key={chain.key}
            entry={chain}
            wallet={wallet}
            live={live[chain.key] === true}
            mobileSession={mobile.session !== null}
          />
        ) : (
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
        )}
      </ConnectSlotContext.Provider>
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
