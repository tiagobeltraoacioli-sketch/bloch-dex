import { AlertTriangle, LoaderCircle, Wallet } from 'lucide-react';
import { CopyButton } from '../ui/CopyButton';
import { Popover } from '../ui/Popover';

type WalletView = {
  account: { address: string; chainId: string; name: string } | null;
  pending: boolean;
};

const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Header wallet control of the live routes. It only shows the connection the
 * page already has: it never connects, disconnects, switches chain or sends.
 * Without an account it points at the page's own connect step.
 */
export function WalletStatus({
  wallet,
  chainId,
  chainName,
  explorerUrl,
}: {
  wallet: WalletView;
  chainId: number;
  chainName: string;
  explorerUrl?: string;
}) {
  if (!wallet.account) {
    return (
      <button
        type="button"
        className="button wallet-button"
        data-state={wallet.pending ? 'pending' : 'disconnected'}
        onClick={() => {
          const target = document.querySelector<HTMLElement>('[data-wallet-connect]');
          target?.scrollIntoView({ block: 'center' });
          (target?.querySelector<HTMLElement>('button:not(:disabled)') ?? target)?.focus();
        }}
      >
        {wallet.pending ? (
          <LoaderCircle size={16} className="spin" aria-hidden="true" />
        ) : (
          <Wallet size={16} aria-hidden="true" />
        )}
        <span>{wallet.pending ? 'Check your wallet' : 'Connect wallet'}</span>
      </button>
    );
  }
  const { address, name } = wallet.account;
  const walletChain = BigInt(wallet.account.chainId);
  const onChain = walletChain === BigInt(chainId);
  return (
    <Popover
      className="wallet-status"
      buttonClassName="button wallet-button"
      panelLabel="Connected wallet"
      buttonProps={{ 'data-state': onChain ? 'connected' : 'wrong-network' }}
      label={
        <>
          {onChain ? (
            <span className="wallet-dot" aria-hidden="true" />
          ) : (
            <AlertTriangle size={16} aria-hidden="true" />
          )}
          <span className="wallet-button-text">
            {!onChain && <span className="wallet-wrong">Wrong network · </span>}
            <span className="numeric">{shortAddress(address)}</span>
          </span>
        </>
      }
    >
      {() => (
        <>
          <p className="popover-title">{name}</p>
          <div className="hashline">
            <code>{address}</code>
            <CopyButton value={address} what="address" />
          </div>
          <dl className="popover-facts">
            <dt>Wallet network</dt>
            <dd>
              Chain {walletChain.toString()}
              {onChain ? ` · ${chainName}` : ''}
            </dd>
            <dt>This page</dt>
            <dd>
              Chain {chainId} · {chainName}
            </dd>
          </dl>
          {!onChain && (
            <p className="notice notice-warn">
              Your wallet is on another network. It will be asked to switch to chain {chainId}{' '}
              before a transaction.
            </p>
          )}
          {explorerUrl && (
            <a
              className="text-link"
              href={`${explorerUrl.replace(/\/$/, '')}/address/${address}`}
              target="_blank"
              rel="noopener noreferrer"
              referrerPolicy="no-referrer"
            >
              View on the explorer
            </a>
          )}
        </>
      )}
    </Popover>
  );
}
