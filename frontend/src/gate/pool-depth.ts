/**
 * Pool depth of a quoted swap, for display only. Everything is computed from reserves the page already read at
 * the snapshot block and from the quote's own amounts: no request, no price history, no fee figure (the page has
 * no reviewed source for one, so the comparison with the pool's spot rate is stated as including the fee).
 * Nothing here feeds back into a quote, a minimum or a transaction.
 */
export type DepthPool = {
  token0: { address: string; symbol: string };
  token1: { address: string; symbol: string };
  reserve0: bigint;
  reserve1: bigint;
};

export type DepthHop = {
  /** Symbol of the token that goes into this pool. */
  symbolIn: string;
  reserveIn: bigint;
  reserveOut: bigint;
  amountIn: bigint;
  amountOut: bigint;
  /** amountIn as a share of reserveIn, in parts per million. */
  sharePpm: number;
};

export type Depth = {
  hops: DepthHop[];
  /** How far the quote's rate is below the product of the pools' spot rates, in parts per million (fee included). */
  belowSpotPpm: number;
};

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function poolDepth(
  pools: readonly DepthPool[],
  path: readonly string[],
  amounts: readonly bigint[],
): Depth | null {
  if (path.length < 2 || amounts.length !== path.length) return null;
  const hops: DepthHop[] = [];
  let spotNum = 1n;
  let spotDen = 1n;
  for (let i = 0; i + 1 < path.length; i++) {
    const pool = pools.find(
      (p) =>
        (same(p.token0.address, path[i]) && same(p.token1.address, path[i + 1])) ||
        (same(p.token1.address, path[i]) && same(p.token0.address, path[i + 1])),
    );
    if (!pool) return null;
    const forward = same(pool.token0.address, path[i]);
    const reserveIn = forward ? pool.reserve0 : pool.reserve1;
    const reserveOut = forward ? pool.reserve1 : pool.reserve0;
    if (reserveIn <= 0n || reserveOut <= 0n || amounts[i] <= 0n) return null;
    hops.push({
      symbolIn: forward ? pool.token0.symbol : pool.token1.symbol,
      reserveIn,
      reserveOut,
      amountIn: amounts[i],
      amountOut: amounts[i + 1],
      sharePpm: Number((amounts[i] * 1_000_000n) / reserveIn),
    });
    spotNum *= reserveOut;
    spotDen *= reserveIn;
  }
  // quote rate / spot rate = (out / in) / (spotNum / spotDen)
  const ratioPpm = Number(
    (amounts[amounts.length - 1] * spotDen * 1_000_000n) / (amounts[0] * spotNum),
  );
  return { hops, belowSpotPpm: Math.max(0, 1_000_000 - ratioPpm) };
}

/** "0.31%", "12.4%", "less than 0.01%". */
export function ppmText(ppm: number): string {
  if (ppm < 100) return 'less than 0.01%';
  const percent = ppm / 10_000;
  return `${percent >= 10 ? percent.toFixed(1) : percent.toFixed(2)}%`;
}

/**
 * Points of the pool's curve (x * y = k) around where it stands, in a unit box: x from half to twice the
 * reserve that goes in. Returns the polyline and the pool's place before and after the swap.
 */
export function depthCurve(hop: DepthHop, width: number, height: number) {
  const x0 = Number(hop.reserveIn);
  const y0 = Number(hop.reserveOut);
  const k = x0 * y0;
  const xMin = x0 * 0.5;
  const xMax = x0 * 2;
  const yMax = k / xMin;
  const yMin = k / xMax;
  const sx = (x: number) => ((x - xMin) / (xMax - xMin)) * width;
  const sy = (y: number) => height - ((y - yMin) / (yMax - yMin)) * height;
  const points: string[] = [];
  for (let i = 0; i <= 32; i++) {
    const x = xMin + ((xMax - xMin) * i) / 32;
    points.push(`${sx(x).toFixed(1)},${sy(k / x).toFixed(1)}`);
  }
  const x1 = Math.min(xMax, x0 + Number(hop.amountIn));
  const y1 = Math.max(yMin, y0 - Number(hop.amountOut));
  return {
    line: points.join(' '),
    before: { x: sx(x0), y: sy(y0) },
    after: { x: sx(x1), y: sy(y1) },
  };
}
