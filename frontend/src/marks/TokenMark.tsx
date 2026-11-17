import { useContext, useId } from 'react';
import { NetworkKeyContext } from '../shell/network-context';
import { NetworkGlyph } from './NetworkGlyph';
import { tokenMark } from './assets';

/**
 * Token marks: one struck coin per underlying asset, with the badge of the network a bridged or per-network
 * token comes from. BLCH, the coin of the gate's own chain, carries the gate and its lamp; every other asset
 * carries its letterform in the display face on a field of its own colour. Original drawings; decorative
 * (the token's name is always written next to it).
 */
export function TokenMark({
  symbol,
  network,
  size = 28,
  className = '',
}: {
  symbol: string;
  /** Lamp key of the network the page is on (see marks/assets.ts); the shell's network by default. */
  network?: string;
  /** Pixels; 0 leaves the size to the stylesheet. */
  size?: number;
  className?: string;
}) {
  const shellNetwork = useContext(NetworkKeyContext);
  const { asset, glyph, origin } = tokenMark(symbol, network ?? shellNetwork);
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  return (
    <span
      className={`token-mark ${className}`}
      data-asset={asset}
      style={size ? { width: size, height: size } : undefined}
      aria-hidden="true"
    >
      <svg viewBox="0 0 32 32" focusable="false">
        <defs>
          <linearGradient id={`${id}f`} x1="0.2" y1="0" x2="0.8" y2="1">
            <stop offset="0" className="coin-hi" />
            <stop offset="1" className="coin-lo" />
          </linearGradient>
          {origin && (
            // The badge sits in a notch cut from the coin, so the two never touch.
            <mask id={`${id}m`}>
              <rect width="32" height="32" fill="#fff" />
              <circle cx="25" cy="25" r="8.6" fill="#000" />
            </mask>
          )}
        </defs>
        <g mask={origin ? `url(#${id}m)` : undefined}>
          <circle cx="16" cy="16" r="15.5" fill={`url(#${id}f)`} />
          <circle className="coin-reeding" cx="16" cy="16" r="14.4" />
          <circle className="coin-rim" cx="16" cy="16" r="12.6" />
          <path className="coin-sheen" d="M5.2 13.4A11.2 11.2 0 0 1 13.4 5.2" />
          {asset === 'blch' && (
            <>
              <path className="coin-ink" d="M11.4 23.4v-7.2a4.6 4.6 0 0 1 9.2 0v7.2Z" />
              <rect
                className="coin-ink coin-sill"
                x="8.6"
                y="23.4"
                width="14.8"
                height="1.3"
                rx="0.65"
              />
              <circle className="coin-lamp" cx="16" cy="8.3" r="1.55" />
            </>
          )}
        </g>
      </svg>
      {/* The letterform is drawn by the stylesheet (generated content), so it is no part of the page's text. */}
      {asset !== 'blch' && (
        <span
          className="mark-letter coin-letter"
          data-glyph={glyph}
          data-long={glyph.length > 1 || undefined}
        />
      )}
      {origin && <NetworkGlyph network={origin} className="token-mark-badge" />}
    </span>
  );
}
