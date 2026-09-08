import { useState } from 'react';
import { ArrowUpRight, Info, Minus, Plus } from 'lucide-react';
import { DEMO_POSITION, POSITION_HISTORY, TOKENS, number, usd } from './data';
import { formatAmount } from './amm';
import { Chart } from './Chart';
import { Detail, Modal, PairIcons, Stat, TokenIcon } from './components';
import type { LiquidityAction } from './model';

const activity = [
  {
    title: 'Liquidity added',
    amount: '20,000 BLCH + 3,640 USDC',
    date: 'Sep 06, 2026',
    note: 'A sample deposit used to illustrate position activity.',
  },
  {
    title: 'Liquidity added',
    amount: '12,000 BLCH + 2,208 USDC',
    date: 'Aug 23, 2026',
    note: 'Pool balances and position value may change after a deposit.',
  },
  {
    title: 'Position opened',
    amount: 'BLCH / USDC',
    date: 'Aug 09, 2026',
    note: 'An illustrative starting point. No transaction was submitted.',
  },
];

export default function Portfolio({
  onLiquidity,
}: {
  onLiquidity: (action: LiquidityAction) => void;
}) {
  const [period, setPeriod] = useState('1M');
  const [selected, setSelected] = useState<(typeof activity)[number] | null>(null);
  const { pool, value, token0, token1 } = DEMO_POSITION;
  const history =
    period === '1D'
      ? POSITION_HISTORY.slice(-7)
      : period === '1W'
        ? POSITION_HISTORY.slice(-15)
        : POSITION_HISTORY;
  const labels =
    period === '1D'
      ? ['00:00', '06:00', '12:00', '18:00', '24:00']
      : period === '1W'
        ? ['Sep 02', 'Sep 04', 'Sep 06', 'Sep 07', 'Sep 08']
        : ['Aug 09', 'Aug 16', 'Aug 23', 'Aug 30', 'Sep 08'];

  return (
    <>
      <header className="page-heading portfolio-heading">
        <div>
          <p className="breadcrumb">
            Portfolio <span>/</span> BLCH–USDC
          </p>
          <div className="portfolio-title">
            <PairIcons a="BLCH" b="USDC" />
            <div>
              <h1>BLCH / USDC</h1>
              <p className="page-subtitle">
                Liquidity position <span className="badge">Demo</span>
              </p>
            </div>
          </div>
        </div>
        <div className="button-group">
          <button
            className="button secondary"
            onClick={() => onLiquidity({ mode: 'remove', pool })}
          >
            <Minus size={17} /> Remove liquidity
          </button>
          <button className="button primary" onClick={() => onLiquidity({ mode: 'add', pool })}>
            <Plus size={17} /> Add liquidity
          </button>
        </div>
      </header>
      <div className="portfolio-grid">
        <section className="panel position-value">
          <div className="section-heading">
            <h2>Position value</h2>
            <div className="period-switch" aria-label="Position chart period">
              {['1D', '1W', '1M'].map((p) => (
                <button key={p} aria-pressed={period === p} onClick={() => setPeriod(p)}>
                  {p}
                </button>
              ))}
            </div>
          </div>
          <strong className="position-total">{usd(value)}</strong>
          <p className="muted value-caption">Estimated at sample pool prices</p>
          <Chart values={history} labels={labels} label={`Sample position value, ${period}`} />
          <div className="market-stats two-stats">
            <Stat label="Pool share" value={`${((value / pool.liquidity) * 100).toFixed(4)}%`} />
            <Stat label="Pool fee" value="0.30%" />
          </div>
        </section>
        <section className="panel position-breakdown">
          <h2>Your position</h2>
          <div
            className="composition-bar"
            role="img"
            aria-label="Sample composition: 50 percent BLCH and 50 percent USDC"
          >
            <span />
            <span />
          </div>
          <div className="composition-labels">
            <div>
              <TokenIcon symbol="BLCH" small />
              <span>
                BLCH<small>50%</small>
              </span>
            </div>
            <div>
              <TokenIcon symbol="USDC" small />
              <span>
                USDC<small>50%</small>
              </span>
            </div>
          </div>
          {(
            [
              ['BLCH', token0],
              ['USDC', token1],
            ] as const
          ).map(([symbol, amount]) => (
            <div className="position-token" key={symbol}>
              <TokenIcon symbol={symbol} />
              <strong>{symbol}</strong>
              <div>
                <strong>{number(Number(formatAmount(amount, TOKENS[symbol].decimals)))}</strong>
                <span>{usd(value / 2)} · 50%</span>
              </div>
            </div>
          ))}
          <div className="position-details">
            <Detail label="Position type">V2 liquidity</Detail>
            <Detail label="Protocol fee dilution">Included in estimate</Detail>
            <Detail label="Ownership">Pool share</Detail>
          </div>
          <div className="inline-note">
            <Info size={16} />
            <p>Pool share changes as liquidity is added or removed.</p>
          </div>
        </section>
      </div>
      <section className="panel activity-panel">
        <div className="section-heading">
          <h2>Position activity</h2>
          <span className="muted small-text">Sample activity</span>
        </div>
        <div className="activity-list">
          {activity.map((item) => (
            <button className="activity-row" key={item.date} onClick={() => setSelected(item)}>
              <span className="activity-kind">
                <span className="activity-icon">
                  <Plus size={17} />
                </span>
                <strong>{item.title}</strong>
              </span>
              <span className="activity-amount">{item.amount}</span>
              <time>{item.date}</time>
              <ArrowUpRight size={16} />
            </button>
          ))}
        </div>
      </section>
      {selected && (
        <Modal title={selected.title} onClose={() => setSelected(null)}>
          <span className="badge">Sample activity</span>
          <p className="activity-modal-amount">{selected.amount}</p>
          <Detail label="Date">{selected.date}</Detail>
          <p className="notice">
            {selected.note} This record is not associated with a connected wallet.
          </p>
          <button className="button primary full-width" onClick={() => setSelected(null)}>
            Done
          </button>
        </Modal>
      )}
    </>
  );
}
