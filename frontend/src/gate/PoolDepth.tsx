import { depthCurve, ppmText, type Depth } from './pool-depth';

/**
 * A small picture of how much of the pool a quoted swap takes: the pool's curve with its place before and
 * after the swap, the share of the reserve that goes in, and how far the quote sits below the pool's spot rate.
 * Computed from the snapshot's reserves and the quote's amounts (gate/pool-depth.ts); nothing is requested.
 */
export function PoolDepth({ depth }: { depth: Depth }) {
  // The deepest cut of the route: the hop that takes the largest share of its pool.
  const hop = depth.hops.reduce((a, b) => (b.sharePpm > a.sharePpm ? b : a));
  const curve = depthCurve(hop, 96, 48);
  return (
    <div className="pool-depth" aria-label="Pool depth">
      <svg
        className="pool-depth-curve"
        viewBox="-4 -4 104 56"
        width="104"
        height="56"
        aria-hidden="true"
        focusable="false"
      >
        <polyline className="depth-line" points={curve.line} />
        <line
          className="depth-move"
          x1={curve.before.x}
          y1={curve.before.y}
          x2={curve.after.x}
          y2={curve.after.y}
        />
        <circle className="depth-before" cx={curve.before.x} cy={curve.before.y} r="3.5" />
        <circle className="depth-after" cx={curve.after.x} cy={curve.after.y} r="2.5" />
      </svg>
      <p className="pool-depth-text">
        <span className="pool-depth-title">Pool depth</span>
        <span>
          This swap puts in {ppmText(hop.sharePpm)} of the pool&apos;s {hop.symbolIn} reserve.
        </span>
        <span>
          Its rate is {ppmText(depth.belowSpotPpm)} below the pool&apos;s spot rate, the pool&apos;s
          fee included.
        </span>
      </p>
    </div>
  );
}
