// What the Pools and Portfolio screens and the liquidity dialog need beyond the route's snapshot: the share
// token's state of every pool of the record and, for a connected account, its shares, balances and approvals.
// Every read is pinned to the snapshot's block hash and goes through the route's RPC (on a public chain: two
// endpoints that must agree, multichain/rpc.ts). A result is used only with the snapshot it was read at.
import { useEffect, useState } from 'react';
import type { Address, Hex } from 'viem';
import type { LivePool, Rpc, Snapshot } from '../devnet4/chain';
import type { DevnetDeployment } from '../devnet4/record';
import {
  poolState,
  readLiquidityAccount,
  readPoolShares,
  type LiquidityAccount,
  type PoolShares,
  type PoolState,
} from '../mainnet/liquidity';
import { worded } from '../mainnet/wording';

export type PoolLiquidity = {
  pool: LivePool;
  state: PoolState;
  shares: PoolShares;
  /** Null while no wallet is connected. */
  account: LiquidityAccount | null;
};
export type LiquidityData = {
  /** The snapshot block the figures were read at. */
  at: Hex;
  account: Address | null;
  pools: PoolLiquidity[];
};

export function useLiquidity({
  rpc,
  snapshot,
  deployment,
  multicall3,
  account,
  enabled,
}: {
  rpc: Rpc;
  snapshot: Snapshot | null;
  deployment: DevnetDeployment | null;
  multicall3?: Address;
  account: Address | null;
  enabled: boolean;
}): { data: LiquidityData | null; error: string } {
  const [data, setData] = useState<LiquidityData | null>(null);
  const [error, setError] = useState('');
  const at = snapshot?.finalized.hash ?? null;
  useEffect(() => {
    if (!enabled || !snapshot || !deployment || !at) return;
    let current = true;
    setError('');
    void (async () => {
      try {
        const pools: PoolLiquidity[] = [];
        for (const pool of snapshot.pools) {
          const shares = await readPoolShares(rpc, { blockHash: at }, deployment, pool.address);
          pools.push({
            pool,
            state: poolState(pool, deployment.wrapped),
            shares,
            account: account
              ? await readLiquidityAccount(rpc, at, deployment, pool, account, multicall3)
              : null,
          });
        }
        if (current) setData({ at, account, pools });
      } catch (failure) {
        if (current) setError(worded(failure instanceof Error ? failure.message : 'Unavailable.'));
      }
    })();
    return () => {
      current = false;
    };
    // The snapshot object changes with its block hash; `at` stands for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, rpc, at, deployment, multicall3, account]);
  const fresh = data && data.at === at && data.account === account ? data : null;
  return { data: fresh, error };
}
