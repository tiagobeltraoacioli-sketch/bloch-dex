import { createContext, useContext, type ReactNode } from 'react';

/**
 * One more way to connect a wallet, placed by the site inside the route's own connect step (the
 * `data-wallet-connect` block). The route knows nothing about it: the multichain site puts its mobile-wallet
 * button here (multichain/MobileWalletConnect.tsx); a site that provides nothing renders nothing.
 */
export const ConnectSlotContext = createContext<ReactNode>(null);

export function ConnectSlot() {
  return <>{useContext(ConnectSlotContext)}</>;
}
