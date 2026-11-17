import { Check, ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { Popover } from '../ui/Popover';
import type { NetworkEntry, NetworkKey } from './networks';
import { NetworkGlyph } from '../marks/NetworkGlyph';

export function NetworkTile({ entry }: { entry: Pick<NetworkEntry, 'key' | 'glyph'> }) {
  return (
    <span className="network-tile" aria-hidden="true">
      <NetworkGlyph network={entry.key} fallback={entry.glyph} size={24} />
    </span>
  );
}

/**
 * The network switcher of the header. It navigates between the routes of
 * networks that have one; a network without a published deployment is listed
 * and cannot be selected. It never asks a wallet to change chain: that stays
 * an explicit step on the network's own page.
 */
export function NetworkSwitcher({
  current,
  entries,
  label,
  footer,
}: {
  current: NetworkKey;
  entries: NetworkEntry[];
  /** Visible content of the button (the route's own wording). */
  label: ReactNode;
  footer?: (close: () => void) => ReactNode;
}) {
  const active = entries.find((e) => e.key === current);
  return (
    <Popover
      className="network-switcher"
      buttonClassName="network-button"
      panelLabel="Select network"
      label={
        <>
          {active && <NetworkTile entry={active} />}
          <span className="network-button-label">{label}</span>
          <ChevronDown size={15} aria-hidden="true" />
        </>
      }
    >
      {(close) => (
        <>
          <p className="popover-title">Network</p>
          <ul className="network-list">
            {entries.map((e) => {
              const body = (
                <>
                  <NetworkTile entry={e} />
                  <span className="network-row-text">
                    <span className="network-row-name">{e.name}</span>
                    <span className="network-row-status">
                      {e.chainId !== undefined && <>Chain {e.chainId} · </>}
                      {e.status}
                    </span>
                  </span>
                  {e.key === current && <Check size={16} aria-label="Selected" />}
                </>
              );
              return (
                <li key={e.key}>
                  {e.state === 'available' && e.href ? (
                    <a
                      className="network-row"
                      href={e.href}
                      aria-current={e.key === current ? 'true' : undefined}
                      onClick={close}
                    >
                      {body}
                    </a>
                  ) : (
                    <span className="network-row" aria-disabled="true">
                      {body}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          {footer?.(close)}
        </>
      )}
    </Popover>
  );
}
