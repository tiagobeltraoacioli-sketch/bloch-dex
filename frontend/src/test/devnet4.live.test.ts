// Opt-in check against the real devnet4 RPC (skipped unless DEVNET4_LIVE_RPC
// is set, e.g. http://127.0.0.1:18945 through an SSH tunnel). Read-only.
import { describe, expect, it } from 'vitest';
import { httpRpc, quoteExactInput, readSnapshot } from '../devnet4/chain';
import { verifyDeploymentRecord } from '../devnet4/record';

const url = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.DEVNET4_LIVE_RPC;

describe.skipIf(!url)('devnet4 live RPC (opt-in)', () => {
  it('verifies the committed record at the finalized block and quotes through the lens', async () => {
    const rpc = httpRpc(url!);
    const deployment = await verifyDeploymentRecord();
    const snapshot = await readSnapshot(rpc, deployment);
    expect(snapshot.finalized.number >= deployment.gate.finalizedNumber).toBe(true);
    const [bUSDC, wGSMH] = ['bUSDC', 'wGSMH'].map((s) => deployment.tokens.find((t) => t.symbol === s)!.address);
    const quote = await quoteExactInput(rpc, deployment, bUSDC, wGSMH, 100_000n, 50);
    console.log(
      JSON.stringify(
        {
          finalized: snapshot.finalized.number.toString(),
          pools: snapshot.pools.map((p) => ({
            pair: `${p.token0.symbol}/${p.token1.symbol}`,
            reserves: [p.reserve0.toString(), p.reserve1.toString()],
            caps: [p.cap0.toString(), p.cap1.toString()],
          })),
          quote: quote && { path: quote.path, amountOut: quote.amountOut.toString(), minimumOut: quote.minimumOut.toString(), block: quote.blockNumber.toString() },
        },
        null,
        1,
      ),
    );
    expect(quote?.path).toHaveLength(3);
  });
});
