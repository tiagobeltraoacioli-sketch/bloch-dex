// The multichain site's mobile-wallet connect step: a button for the route's connect block and the dialog that
// shows the pairing code (a QR code on a desktop, links that open the wallet app on a phone). The session itself is
// multichain/walletconnect.ts, loaded only when the button is pressed. The dialog is owned by the site, above the
// route, so a route that re-renders its swap card (a renewed snapshot block) does not close a pairing in progress.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Smartphone } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { CopyButton } from '../ui/CopyButton';
import type { Provider, WalletOption } from '../wallet';

export type MobileConnectChain = { chainId: number; name: string };
type Stage =
  | { kind: 'preparing' }
  | {
      kind: 'code';
      uri: string;
      image: string;
      links: { name: string; href: string; app: boolean }[];
    }
  | { kind: 'failed'; text: string };

export const MOBILE_CONNECT_LABEL = 'Connect a mobile wallet';
export const MOBILE_CONNECT_UNSUPPORTED =
  'The wallet approved something this page cannot use (networks that were not asked for, not this page’s network, more than one account, or without the permission to send transactions). Nothing was connected. Try again with one account and this page’s network selected, or use another wallet.';
export const MOBILE_CONNECT_FAILED =
  'The connection was closed or could not be made. Nothing was connected. Check the wallet app and try again.';

/** A phone or tablet: the wallet app is on this device, so links come first and the QR code second. */
export function onHandheld(): boolean {
  try {
    const agent = navigator.userAgent;
    return (
      /Android|iPhone|iPad|iPod/i.test(agent) ||
      // iPadOS presents itself as a Mac.
      (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1)
    );
  } catch {
    return false;
  }
}

export const MOBILE_SESSION_NOTE =
  'Connected to a mobile wallet through WalletConnect. After you press Approve or Swap here, open the wallet app to confirm there.';

/**
 * `chains`: the networks of this site whose bundled record is live (the session is asked for these and no other);
 * `route`: the network of the page shown. Returns the button for the route's connect step, the dialog, and, while
 * the page's wallet is a mobile session opened here, a line that says so and ends it (an injected wallet is
 * disconnected in its own extension; a mobile session has no other handle on this page).
 */
export function useMobileWalletConnect({
  wallet,
  chains,
  route,
}: {
  wallet: {
    pending: boolean;
    provider?: Provider | null;
    connect(option: WalletOption): Promise<void> | void;
    disconnect?(): void;
  };
  chains: MobileConnectChain[];
  route: MobileConnectChain;
}): { button: ReactNode; dialog: ReactNode; session: ReactNode; open(): void } {
  const [stage, setStage] = useState<Stage | null>(null);
  // The provider of the session opened here, to tell it from an injected wallet.
  const [opened, setOpened] = useState<Provider | null>(null);
  const attempt = useRef<AbortController | null>(null);
  const available = chains.some((c) => c.chainId === route.chainId);
  const close = () => {
    attempt.current?.abort();
    attempt.current = null;
    setStage(null);
  };
  // Another page, or leaving the site: a pairing belongs to the page it was started on.
  useEffect(
    () => () => {
      attempt.current?.abort();
      attempt.current = null;
      setStage(null);
    },
    [route.chainId],
  );

  async function start() {
    if (!available || wallet.pending || attempt.current) return;
    const controller = new AbortController();
    attempt.current = controller;
    setStage({ kind: 'preparing' });
    try {
      const [{ connectMobileWallet, mobileWalletLinks }, { default: encodeQR }] = await Promise.all(
        [import('./walletconnect'), import('qr')],
      );
      const option = await connectMobileWallet({
        signal: controller.signal,
        chainIds: chains.map((c) => c.chainId),
        routeChainId: route.chainId,
        onUri: (uri) => {
          if (controller.signal.aborted) return;
          // The page's own renderer: an image built here, no request to anyone.
          const svg = encodeQR(uri, 'svg', { ecc: 'medium', border: 4 });
          setStage({
            kind: 'code',
            uri,
            image: `data:image/svg+xml;base64,${btoa(svg)}`,
            links: mobileWalletLinks(uri),
          });
        },
      });
      if (controller.signal.aborted) {
        option.provider.disconnect?.();
        return;
      }
      setOpened(option.provider);
      await wallet.connect(option);
      if (attempt.current === controller) {
        attempt.current = null;
        setStage(null);
      }
    } catch (error) {
      if (controller.signal.aborted || attempt.current !== controller) return;
      attempt.current = null;
      const unsupported = error instanceof Error && /unsupported session/.test(error.message);
      setStage({
        kind: 'failed',
        text: unsupported ? MOBILE_CONNECT_UNSUPPORTED : MOBILE_CONNECT_FAILED,
      });
    }
  }

  const button = available ? (
    <button
      type="button"
      className="wallet-option"
      data-mobile-wallet
      disabled={wallet.pending || stage !== null}
      onClick={() => void start()}
    >
      <span className="wallet-option-icon" aria-hidden="true">
        <Smartphone size={18} />
      </span>
      <span>
        <strong>{MOBILE_CONNECT_LABEL}</strong>
        <small>QR code or wallet app · WalletConnect</small>
      </span>
    </button>
  ) : null;

  const handheld = stage?.kind === 'code' && onHandheld();
  const dialog = stage ? (
    <Modal title={MOBILE_CONNECT_LABEL} onClose={close}>
      <div className="mobile-connect" data-testid="mobile-connect">
        {stage.kind === 'preparing' && (
          <p role="status" className="microcopy">
            Preparing a connection code…
          </p>
        )}
        {stage.kind === 'code' && (
          <>
            {handheld && (
              <div className="mobile-connect-links">
                <p>Open your wallet app from this phone:</p>
                {stage.links.map((link) => (
                  <a
                    key={link.name}
                    className={
                      link.app ? 'button primary full-width' : 'button secondary full-width'
                    }
                    href={link.href}
                    // A wallet's own link host opens in a new tab, so this page and its pairing stay open when
                    // the app is not installed; the wc: scheme has no page to open.
                    {...(link.app ? {} : { target: '_blank' })}
                    rel="noopener noreferrer"
                    referrerPolicy="no-referrer"
                  >
                    {link.name}
                  </a>
                ))}
                <p className="microcopy">
                  Approve the connection in the wallet, then come back to this page in your browser.
                </p>
              </div>
            )}
            <p>
              {handheld
                ? 'Or scan this code with a wallet on another device:'
                : 'Scan this code with the wallet app on your phone (in the app: WalletConnect, or Scan).'}
            </p>
            <div className="mobile-connect-code">
              <img src={stage.image} alt="QR code that connects a mobile wallet to this page" />
            </div>
            <div className="hashline mobile-connect-copy">
              <span className="microcopy">Or copy the connection link into the wallet</span>
              <CopyButton value={stage.uri} what="connection link" />
            </div>
            <p role="status" className="microcopy">
              Waiting for the wallet to approve…
            </p>
          </>
        )}
        {stage.kind === 'failed' && (
          <>
            <p role="alert" className="form-error">
              {stage.text}
            </p>
            <button
              type="button"
              className="button primary full-width"
              onClick={() => void start()}
            >
              Try again
            </button>
          </>
        )}
        <p className="microcopy mobile-connect-scope">
          The wallet is asked for one thing: to show you this page&rsquo;s transactions for
          confirmation, on {chains.map((c) => c.name).join(', ')}. It is not asked to sign messages,
          and nothing is sent without your confirmation in the wallet. A wallet may list more
          permissions than that when it connects; this page uses none of them. This page keeps
          reading the network from its own endpoints, not from the wallet.
        </p>
        <button type="button" className="button secondary full-width" onClick={close}>
          Cancel
        </button>
      </div>
    </Modal>
  ) : null;
  const session =
    opened !== null && wallet.provider === opened && wallet.disconnect ? (
      <p className="muted mobile-session" data-testid="mobile-session">
        {MOBILE_SESSION_NOTE}{' '}
        <button type="button" className="text-link" onClick={() => wallet.disconnect?.()}>
          Disconnect the mobile wallet
        </button>
      </p>
    ) : null;
  // `open`: the same start as the button's, for another control of the site; it has the button's guards.
  return { button, dialog, session, open: () => void start() };
}
