/**
 * Network glyphs. Every network is drawn as a gate lit in its own lamp colour (the colour comes from
 * `data-network`, styles/tokens.css) with a monogram in the display face; the Bloch L2, whose gate this is,
 * shows the opening itself. Original drawings: no third-party logo or trademark is reproduced.
 */
const MONOGRAM: Record<string, string> = {
  ethereum: 'E',
  linea: 'L',
  'arbitrum-one': 'A',
  'bnb-smart-chain': 'Bn',
  base: 'Ba',
  'op-mainnet': 'Op',
  devnet4: 'D4',
  preview: 'P',
  bitcoin: 'B',
  solana: 'S',
  tron: 'T',
  stellar: 'X',
};

export function NetworkGlyph({
  network,
  size,
  fallback,
  className = '',
}: {
  /** Lamp key (the directory name under deployments/, or an origin network such as `bitcoin`). */
  network: string;
  /** Pixels; without it the stylesheet sizes the glyph. */
  size?: number;
  /** Letters for a network this file does not know. */
  fallback?: string;
  className?: string;
}) {
  const letters = MONOGRAM[network] ?? fallback?.slice(0, 2) ?? network.slice(0, 1).toUpperCase();
  return (
    <span
      className={`network-glyph ${className}`}
      data-network={network}
      style={size ? { width: size, height: size } : undefined}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" focusable="false">
        <path className="network-glyph-body" d="M3.5 22.5V11a8.5 8.5 0 0 1 17 0v11.5Z" />
        <path className="network-glyph-sheen" d="M5.6 11.2a6.4 6.4 0 0 1 6.4-6.4" />
        {network === 'bloch-l2' && (
          <>
            <path className="network-glyph-ink" d="M8.6 22.5v-8.2a3.4 3.4 0 0 1 6.8 0v8.2Z" />
            <circle className="network-glyph-ink" cx="12" cy="6.6" r="1.25" />
          </>
        )}
      </svg>
      {/* The monogram is drawn by the stylesheet (generated content), so it is no part of the page's text. */}
      {network !== 'bloch-l2' && (
        <span
          className="mark-letter network-glyph-letter"
          data-glyph={letters}
          data-long={letters.length > 1 || undefined}
        />
      )}
    </span>
  );
}
