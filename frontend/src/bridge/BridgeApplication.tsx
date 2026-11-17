// The bridge route inside the site's frame (the same Shell, network switcher and wallet control as the swap route).
import { useEffect, useMemo } from 'react';
import bundle from '@postern/bridge-bundle';
import type { Rpc } from '../devnet4/chain';
import type { MainnetNetwork } from '../mainnet/config';
import { NetworkSwitcher } from '../shell/NetworkSwitcher';
import type { NetworkEntry } from '../shell/networks';
import { Shell } from '../shell/Shell';
import { WalletStatus } from '../shell/WalletStatus';
import { useWallet } from '../useWallet';
import BridgePage from './BridgePage';
import { Panel } from './BridgeParts';
import { BridgeStates } from './BridgeStates';
import { parseBridgeBundle, type BridgeConfig } from './config';

/** The bundled bridge configuration, or why it was refused. A rehearsal bundle is accepted by a local render build only. */
export function bundledBridge(): { config: BridgeConfig } | { error: string } {
  try {
    return { config: parseBridgeBundle(bundle, __POSTERN_LOCAL_RENDER__) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'unreadable' };
  }
}

export function BridgeApplication({ network, rpc, networks, states }: { network: MainnetNetwork; rpc: Rpc; networks: NetworkEntry[]; states: boolean }) {
  const wallet = useWallet();
  const loaded = useMemo(bundledBridge, []);
  useEffect(() => {
    document.title = 'PosternDEX — Bridge';
  }, []);
  return (
    <Shell
      network="bloch-l2"
      brandLabel="Postern preview home"
      navLabel="Mainnet navigation"
      nav={
        <>
          <a href="#/mainnet">Mainnet</a>
          <a href="#/bridge" aria-current="page">
            Bridge
          </a>
          <a href="#/trade">Preview</a>
        </>
      }
      actions={
        <>
          <NetworkSwitcher current="bloch-l2" entries={networks} label={<>Bloch L2 · Chain {network.chainId}</>} />
          <WalletStatus wallet={wallet} chainId={network.chainId} chainName={network.chainName} explorerUrl={network.explorerUrl || undefined} />
        </>
      }
      footer={
        <>
          <span className="footer-status">Bloch L2 mainnet · chain {network.chainId} · bridge</span>
          <span className="muted">The bridges' own published files · Finalized reads · No server of this site · Explicit wallet transactions</span>
        </>
      }
    >
      {'error' in loaded ? (
        <section className="page bridge-page">
          <Panel tone="danger" title="The bridge configuration could not be read" role="alert">
            <p>
              This build's bridge files were refused ({loaded.error}). No route is shown and nothing can be sent from this page.
            </p>
          </Panel>
        </section>
      ) : states && __POSTERN_LOCAL_RENDER__ ? (
        <BridgeStates config={loaded.config} />
      ) : (
        <BridgePage config={loaded.config} network={network} rpc={rpc} wallet={wallet} />
      )}
    </Shell>
  );
}
