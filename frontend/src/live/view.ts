// The three screens of a live route (Trade, Pools, Portfolio), named by the second segment of the hash:
// `#/ethereum` and `#/ethereum/trade` are Trade, `#/ethereum/pools`, `#/ethereum/portfolio`. Presentation only.
import { useEffect, useState } from 'react';

export const LIVE_VIEWS = ['trade', 'pools', 'portfolio'] as const;
export type LiveView = (typeof LIVE_VIEWS)[number];
export const LIVE_VIEW_NAMES: Record<LiveView, string> = {
  trade: 'Trade',
  pools: 'Pools',
  portfolio: 'Portfolio',
};

/** The route key of a hash: its first segment (`#/ethereum/pools` is the route `ethereum`). */
export const routeKeyOfHash = (hash: string): string =>
  hash.replace(/^#\/?/, '').split('/')[0] ?? '';

export function viewOfHash(hash: string, base: string): LiveView {
  const rest = hash.startsWith(`${base}/`) ? hash.slice(base.length + 1) : '';
  return (LIVE_VIEWS as readonly string[]).includes(rest) ? (rest as LiveView) : 'trade';
}

export const hrefOfView = (base: string, view: LiveView): string =>
  view === 'trade' ? base : `${base}/${view}`;

/** The screen the hash names, followed as the hash changes; `go` moves to another one. */
export function useLiveView(base: string): [LiveView, (view: LiveView) => void] {
  const [view, setView] = useState<LiveView>(() => viewOfHash(location.hash, base));
  useEffect(() => {
    const change = () => setView(viewOfHash(location.hash, base));
    change();
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, [base]);
  const go = (next: LiveView) => {
    const href = hrefOfView(base, next);
    if (location.hash !== href) location.hash = href;
    setView(next);
  };
  return [view, go];
}
