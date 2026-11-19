// The Bloch L2 route of the multichain site: the route component of the Bloch L2 site (MainnetLive), mounted with
// what that site's #/mainnet passes it (App.tsx `MainnetApplication`): the L2 network file, its record, its
// one-endpoint reader, the planned caps, and none of the public chains' props (no confirmation rule, no snapshot
// renewal, no faster receipt poll, no Trade / Pools / Portfolio screens). src/test/multichain-bloch-l2-seam.test.tsx
// compares the two mounts prop by prop.
// Exactly (review R416-6): the L2 site's mount names SIX props, this one five. The sixth is `ethRpc`, the reader of
// the bridge-hold status. With the committed network file (no bridge status block) the L2 site passes `undefined`
// for it; with a status block it passes `httpRpc(status.ethRpcUrl)` of the first block. This mount passes none, and
// MainnetLive then makes that same reader itself from the same field (`ethRpc ?? httpRpc(holdSource.ethRpcUrl)`),
// so a production build of either site reads the hold at the same endpoint. The one difference is a local render
// build: the L2 site may route it through VITE_BRIDGE_ETH_RPC_URL, and the multichain build has no such override.
import MainnetLive from '../MainnetLive';
import type { Devnet4Wallet } from '../Devnet4Live';
import type { BlochL2Entry } from './bloch-l2';

/**
 * Decision of round 20 (agent 415): the Trade, Pools and Portfolio screens and the liquidity dialog are not
 * offered on the Bloch L2 yet. Their arithmetic models reserve caps and the k ceiling, but no run has shown them
 * refusing on a chain that has caps (review 413); until one has, the L2 route is the reviewed swap page alone.
 */
export const L2_SCREENS_NOTE =
  'On Bloch L2 this site offers swaps only. The Pools and Portfolio screens and adding or removing liquidity are not offered on this network yet: its pools have fixed reserve caps, and those screens have not been proven on a network with caps.';
/**
 * Which connections work on chain 700770. A browser wallet is asked to switch and, when it does not know the
 * chain, to add it (the route's own "Add or switch to Bloch L2"). The mobile-wallet session is not offered: it is
 * asked only for the public networks (MultichainApp.tsx), and a network cannot be added to an open session.
 */
export const L2_WALLET_NOTE =
  'Bloch L2 is chain 700770, which wallets do not list by themselves. Connect a browser wallet here (an extension, or the browser inside a wallet app): this page asks it to add the network. Connecting a mobile wallet by QR code (WalletConnect) is not offered on this network.';
/** Shown instead while the page's wallet is a mobile session opened on another network's page. */
export const L2_MOBILE_SESSION_NOTE =
  'The mobile wallet connected through WalletConnect cannot be used on Bloch L2: its session covers the other networks of this site only, and a network cannot be added to an open session. Disconnect it and connect a browser wallet to use this network. Nothing is sent to the mobile wallet from this page.';

export function BlochL2Route({
  entry,
  wallet,
  live,
  mobileSession,
}: {
  entry: BlochL2Entry;
  wallet: Devnet4Wallet;
  /** The bundled record made the route live: the two notes are about a route that can be used. */
  live: boolean;
  /** The page's wallet is the mobile session of this site. */
  mobileSession: boolean;
}) {
  return (
    <>
      {live && (
        <div className="l2-route-notes" data-testid="l2-route-notes">
          <p className="muted token-note" data-testid="l2-screens-note">
            {L2_SCREENS_NOTE}
          </p>
          {mobileSession ? (
            <p className="notice token-note" role="status" data-testid="l2-mobile-session-note">
              {L2_MOBILE_SESSION_NOTE}
            </p>
          ) : (
            <p className="muted token-note" data-testid="l2-wallet-note">
              {L2_WALLET_NOTE}
            </p>
          )}
        </div>
      )}
      <MainnetLive
        key={entry.key}
        network={entry.network}
        load={entry.load}
        rpc={entry.rpc}
        wallet={wallet}
        planned={entry.planned}
      />
    </>
  );
}
