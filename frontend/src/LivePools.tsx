import { useEffect, useRef, useState } from 'react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { formatAmount } from './amm';
import {
  LatestReadGate,
  type DeploymentRegistry,
  type LivePoolPage,
  type LiveReadRequest,
  type LiveReadState,
  type LiveReadUnavailableReason,
} from './live-read';

export type LivePoolsReader = {
  readonly registry: DeploymentRegistry;
  pools(
    cursor: bigint,
    limit: number,
    request?: LiveReadRequest,
  ): Promise<LiveReadState<LivePoolPage>>;
};

type ViewState =
  | { kind: 'loading' }
  | { kind: 'unavailable'; reason: Exclude<LiveReadUnavailableReason, 'stale' | 'cancelled'> }
  | { kind: 'stale' }
  | { kind: 'ready'; page: LivePoolPage };

const unavailableCopy: Record<Exclude<LiveReadUnavailableReason, 'stale' | 'cancelled'>, string> = {
  'invalid-request': 'The live pool request did not satisfy the reviewed limits.',
  'missing-pool': 'The requested pool is not registered on this deployment.',
  'empty-pool': 'The pool exists but has no usable liquidity.',
  'quote-unavailable': 'The deployment could not provide an executable quote.',
  'provider-unavailable': 'The reviewed deployment could not be read at one consistent block.',
};

function shortAddress(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

/**
 * Isolated live-data surface. It never imports preview fixtures and deliberately
 * contains no swap, approval, deposit, withdrawal or wallet control.
 */
export default function LivePools({
  reader,
  onRefresh,
}: {
  reader: LivePoolsReader;
  onRefresh?: () => void;
}) {
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<ViewState>({ kind: 'loading' });
  const gate = useRef(new LatestReadGate());

  useEffect(() => {
    const controller = new AbortController();
    const request = gate.current.begin(controller.signal);
    let mounted = true;
    setState({ kind: 'loading' });
    void reader.pools(0n, 32, request).then(
      (result) => {
        if (!mounted) return;
        if (result.available) setState({ kind: 'ready', page: result.value });
        else if (result.reason === 'stale' || result.reason === 'cancelled')
          setState({ kind: 'stale' });
        else setState({ kind: 'unavailable', reason: result.reason });
      },
      () => {
        if (mounted) setState({ kind: 'unavailable', reason: 'provider-unavailable' });
      },
    );
    return () => {
      mounted = false;
      controller.abort();
      gate.current.invalidate();
    };
  }, [reader, reload]);

  const tokens = new Map(
    reader.registry.tokens.map((token) => [token.address.toLowerCase(), token]),
  );
  const refresh = () => (onRefresh ? onRefresh() : setReload((value) => value + 1));
  return (
    <section className="panel pools-panel" aria-labelledby="live-pools-title">
      <div className="pool-toolbar">
        <div>
          <p className="eyebrow">REVIEWED DEPLOYMENT</p>
          <h2 id="live-pools-title">Read-only pool snapshot</h2>
        </div>
        <span className="badge">
          <ShieldCheck size={15} /> No transactions
        </span>
      </div>

      {state.kind === 'loading' && (
        <p className="notice" role="status">
          Loading one authenticated block snapshot…
        </p>
      )}
      {state.kind === 'stale' && (
        <div className="notice" role="status">
          <p>This response became stale and was not displayed.</p>
          <button className="button secondary" onClick={refresh}>
            <RefreshCw size={16} /> Retry read
          </button>
        </div>
      )}
      {state.kind === 'unavailable' && (
        <div className="notice" role="alert">
          <p>{unavailableCopy[state.reason]}</p>
          <p className="microcopy">Preview data was not substituted for this failed live read.</p>
          <button className="button secondary" onClick={refresh}>
            <RefreshCw size={16} /> Retry read
          </button>
        </div>
      )}
      {state.kind === 'ready' && (
        <>
          <p className="microcopy" role="status">
            Snapshot block {state.page.blockNumber.toString()} ·{' '}
            {shortAddress(state.page.blockHash)}
          </p>
          {state.page.filteredUnsupported > 0 && (
            <p className="notice">
              {state.page.filteredUnsupported} permissionless{' '}
              {state.page.filteredUnsupported === 1 ? 'pool was' : 'pools were'} hidden because its
              tokens are not in the reviewed registry.
            </p>
          )}
          {state.page.pools.length === 0 ? (
            <div className="empty-state">
              <h3>No reviewed pools are available in this page.</h3>
              <p>No sample pools are shown in place of live results.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="pool-table">
                <thead>
                  <tr>
                    <th scope="col">Pool</th>
                    <th scope="col">Reserve 0</th>
                    <th scope="col">Reserve 1</th>
                    <th scope="col">LP supply</th>
                    <th scope="col">Contract</th>
                  </tr>
                </thead>
                <tbody>
                  {state.page.pools.map((pool) => {
                    const token0 = tokens.get(pool.token0.toLowerCase());
                    const token1 = tokens.get(pool.token1.toLowerCase());
                    if (!token0 || !token1) return null;
                    return (
                      <tr key={pool.pair}>
                        <td className="strong">
                          {token0.symbol} / {token1.symbol}
                        </td>
                        <td className="numeric" data-label="Reserve 0">
                          {formatAmount(pool.reserve0, token0.decimals, 6)} {token0.symbol}
                        </td>
                        <td className="numeric" data-label="Reserve 1">
                          {formatAmount(pool.reserve1, token1.decimals, 6)} {token1.symbol}
                        </td>
                        <td className="numeric" data-label="LP supply">
                          {pool.totalSupply.toString()}
                        </td>
                        <td>
                          <code title={pool.pair}>{shortAddress(pool.pair)}</code>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="table-footer">
            <span>
              Showing {state.page.pools.length} reviewed of {state.page.total.toString()} registered
              pools
            </span>
            <span className="muted">Read only · no fixture fallback</span>
            {onRefresh && (
              <button className="button secondary" onClick={refresh}>
                <RefreshCw size={16} /> Refresh snapshot
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
