import { useEffect, useMemo, useState } from 'react';
import { ArrowUpRight, BookOpen, ChevronRight, Plus, Search, Star } from 'lucide-react';
import { POOLS, compactUsd, marketSeries, usd } from './data';
import { Chart } from './Chart';
import { EmptyState, PairIcons, Stat } from './components';
import type { Pool } from './model';

function readWatchlist(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem('postern.watchlist.v1') ?? '[]');
    return Array.isArray(parsed)
      ? parsed.filter(
          (id): id is string => typeof id === 'string' && POOLS.some((p) => p.id === id),
        )
      : [];
  } catch {
    return [];
  }
}

export default function Pools({
  onPool,
  onAdd,
  onGuide,
}: {
  onPool: (pool: Pool) => void;
  onAdd: (pool: Pool) => void;
  onGuide: () => void;
}) {
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'all' | 'watchlist'>('all');
  const [sort, setSort] = useState<'liquidity' | 'volume' | 'fees'>('liquidity');
  const [watchlist, setWatchlist] = useState<string[]>(readWatchlist);
  useEffect(() => {
    try {
      localStorage.setItem('postern.watchlist.v1', JSON.stringify(watchlist));
    } catch {
      /* Device-local preferences are optional. */
    }
  }, [watchlist]);
  const shown = useMemo(
    () =>
      POOLS.filter(
        (p) =>
          (tab === 'all' || watchlist.includes(p.id)) &&
          `${p.token0} ${p.token1}`.toLowerCase().includes(query.trim().toLowerCase()),
      ).sort((a, b) => b[sort] - a[sort]),
    [query, tab, sort, watchlist],
  );
  const totals = POOLS.reduce(
    (acc, p) => ({
      liquidity: acc.liquidity + p.liquidity,
      volume: acc.volume + p.volume,
      fees: acc.fees + p.fees,
    }),
    { liquidity: 0, volume: 0, fees: 0 },
  );

  return (
    <>
      <header className="page-heading">
        <div>
          <p className="eyebrow">LIQUIDITY</p>
          <h1>Discover your next pool.</h1>
          <p className="page-subtitle">Compare depth, volume and trading activity.</p>
        </div>
        <button className="button primary" onClick={() => onAdd(POOLS[0])}>
          <Plus size={17} /> Add liquidity
        </button>
      </header>
      <div className="summary-grid">
        {(
          [
            ['Total liquidity', compactUsd(totals.liquidity)],
            ['Volume · 24h', compactUsd(totals.volume)],
            ['Pool fees · 24h', usd(totals.fees, 0)],
          ] as const
        ).map(([label, value], i) => (
          <section className="panel summary-panel" key={label}>
            <Stat label={label} value={value} />
            <Chart values={marketSeries(1, i === 1 ? '1W' : '1M')} label={label} compact />
          </section>
        ))}
      </div>
      <section className="panel pools-panel" aria-label="Liquidity pools">
        <div className="pool-toolbar">
          <div className="segmented" aria-label="Pool view">
            <button aria-pressed={tab === 'all'} onClick={() => setTab('all')}>
              All pools
            </button>
            <button aria-pressed={tab === 'watchlist'} onClick={() => setTab('watchlist')}>
              Watchlist
              {watchlist.length > 0 && <span className="tab-count">{watchlist.length}</span>}
            </button>
          </div>
          <label className="search-field">
            <Search size={18} />
            <input
              placeholder="Search tokens or pools"
              aria-label="Search pools"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <label className="sort-field">
            <span className="sr-only">Sort pools</span>
            <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
              <option value="liquidity">Highest liquidity</option>
              <option value="volume">Highest volume</option>
              <option value="fees">Highest fees</option>
            </select>
          </label>
        </div>
        {shown.length > 0 ? (
          <div className="table-wrap">
            <table className="pool-table">
              <thead>
                <tr>
                  <th scope="col">Pool</th>
                  <th scope="col">Liquidity</th>
                  <th scope="col">Volume · 24h</th>
                  <th scope="col">Fees · 24h</th>
                  <th scope="col">Pool fee</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((pool) => (
                  <tr key={pool.id}>
                    <td>
                      <div className="pool-identity">
                        <button
                          className={`icon-button watch-star ${watchlist.includes(pool.id) ? 'is-watched' : ''}`}
                          aria-label={`Watch ${pool.token0} / ${pool.token1}`}
                          aria-pressed={watchlist.includes(pool.id)}
                          onClick={() =>
                            setWatchlist((current) =>
                              current.includes(pool.id)
                                ? current.filter((id) => id !== pool.id)
                                : [...current, pool.id],
                            )
                          }
                        >
                          <Star size={20} />
                        </button>
                        <PairIcons a={pool.token0} b={pool.token1} />
                        <strong>
                          {pool.token0} / {pool.token1}
                        </strong>
                      </div>
                    </td>
                    <td data-label="Liquidity" className="numeric strong">
                      {compactUsd(pool.liquidity)}
                    </td>
                    <td data-label="Volume · 24h" className="numeric">
                      {usd(pool.volume, 0)}
                    </td>
                    <td data-label="Fees · 24h" className="numeric">
                      {usd(pool.fees)}
                    </td>
                    <td data-label="Pool fee" className="numeric">
                      0.30%
                    </td>
                    <td>
                      <button
                        className="pool-view"
                        aria-label={`View ${pool.token0} / ${pool.token1} pool`}
                        onClick={() => onPool(pool)}
                      >
                        <span>View pool</span>
                        <ChevronRight size={18} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title={
              tab === 'watchlist' && !query ? 'Your watchlist starts here.' : 'No matching pools.'
            }
            description={
              tab === 'watchlist' && !query
                ? 'Star a pool to keep it close. Your watchlist stays on this device.'
                : 'Try another token symbol or clear your filters.'
            }
            action={
              <button
                className="button secondary"
                onClick={() => {
                  setQuery('');
                  setTab('all');
                }}
              >
                Show all pools
              </button>
            }
          />
        )}
        <div className="table-footer">
          <span aria-live="polite">
            Showing {shown.length} of {POOLS.length} pools
          </span>
          <span className="muted">Sample market data</span>
        </div>
      </section>
      <aside className="panel guide-callout">
        <div className="guide-icon">
          <BookOpen size={28} strokeWidth={1.4} />
        </div>
        <div>
          <h2>Understand your liquidity</h2>
          <p>Fees vary with activity. Token prices can change your position value.</p>
        </div>
        <button className="text-link" onClick={onGuide}>
          Read the guide <ArrowUpRight size={17} />
        </button>
      </aside>
    </>
  );
}
