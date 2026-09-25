import { useMemo, useState } from 'react';
import { ArrowDown, ArrowRight, ChevronDown, Info, Settings2 } from 'lucide-react';
import { findQuotes, formatAmount, parseAmount } from './amm';
import { marketSeries, PERIOD_LABELS, POOLS, TOKENS, usd } from './data';
import { Chart } from './Chart';
import { Detail, Modal, Stat, TokenIcon } from './components';
import type { Period, Quote, Symbol } from './model';

export default function Trade({
  slippage,
  onSettings,
}: {
  slippage: number;
  onSettings: () => void;
}) {
  const [from, setFrom] = useState<Symbol>('BLCH');
  const [to, setTo] = useState<Symbol>('USDC');
  const [input, setInput] = useState('1000');
  const [period, setPeriod] = useState<Period>('24H');
  const [picker, setPicker] = useState<'from' | 'to' | null>(null);
  const [search, setSearch] = useState('');
  const [review, setReview] = useState<(Quote & { slippageBps: number }) | null>(null);
  const inputUnits = parseAmount(input, TOKENS[from].decimals);
  const quotes = useMemo(
    () => findQuotes(inputUnits ?? 0n, from, to, POOLS, slippage),
    [inputUnits, from, to, slippage],
  );
  const best = quotes[0];
  const market = POOLS.find(
    (p) => (p.token0 === from && p.token1 === to) || (p.token1 === from && p.token0 === to),
  );
  const price = TOKENS[from].price / TOKENS[to].price;
  const change = { '1H': '+0.41%', '24H': '+3.42%', '1W': '−2.17%', '1M': '+8.24%' }[period];
  const error =
    input.trim() && inputUnits === null
      ? `Enter a valid amount with up to ${TOKENS[from].decimals} decimals.`
      : input.trim() && inputUnits === 0n
        ? 'Enter an amount greater than zero.'
        : inputUnits && !best
          ? 'No usable route for this amount. Try another pair or amount.'
          : '';
  const displayOutput = best ? formatAmount(best.output, TOKENS[to].decimals, 6) : '0';
  const selectToken = (symbol: Symbol) => {
    if (picker === 'from') {
      if (symbol === to) setTo(from);
      setFrom(symbol);
    } else {
      if (symbol === from) setFrom(to);
      setTo(symbol);
    }
    setInput('');
    setPicker(null);
  };

  return (
    <>
      <header className="page-heading">
        <div>
          <p className="eyebrow">TRADE</p>
          <h1>Every trade, in view.</h1>
        </div>
        <span className="preview-label">
          <span /> Interactive preview
        </span>
      </header>
      <div className="trade-grid">
        <div className="market-column">
          <section className="panel market-panel" aria-labelledby="market-title">
            <div className="market-top">
              <div className="token-title">
                <TokenIcon symbol={from} />
                <div>
                  <h2 id="market-title">
                    {from} / {to}
                  </h2>
                  <p className="muted">Market overview</p>
                </div>
              </div>
              <div className="period-switch" aria-label="Chart period">
                {(['1H', '24H', '1W', '1M'] as Period[]).map((p) => (
                  <button key={p} aria-pressed={period === p} onClick={() => setPeriod(p)}>
                    {p}
                  </button>
                ))}
              </div>
            </div>
            <div className="price-line">
              <strong>{to === 'USDC' ? usd(price, 4) : `${price.toFixed(5)}`}</strong>
              <span className={period === '1W' ? 'negative' : 'positive'}>{change}</span>
              <span className="muted">{period.toLowerCase()}</span>
            </div>
            <Chart
              values={marketSeries(price, period)}
              labels={PERIOD_LABELS[period]}
              label={`${from} / ${to}, ${period}`}
              price
            />
            <div className="market-stats">
              <Stat label="Volume · 24h" value={market ? usd(market.volume, 0) : '—'} />
              <Stat label="Liquidity" value={market ? usd(market.liquidity / 1e6) + 'M' : '—'} />
              <Stat
                label="Pool fee"
                value={market ? `${((market.swapFeeBps ?? 30) / 100).toFixed(2)}%` : 'Per hop'}
              />
            </div>
          </section>
          <section className="panel route-panel" aria-labelledby="route-title">
            <h2 id="route-title">
              Route comparison <Info size={16} aria-label="Comparison of available demo routes" />
            </h2>
            {quotes.length ? (
              <div className="routes">
                {quotes.map((q, index) => (
                  <div
                    className={`route ${index === 0 ? 'best-route' : ''}`}
                    key={q.path.join('-')}
                  >
                    <div className="route-path">
                      {q.path.map((symbol, i) => (
                        <span className="route-hop" key={`${symbol}-${i}`}>
                          {i > 0 && <ArrowRight size={14} />}
                          <TokenIcon symbol={symbol} small />
                          <span>{symbol}</span>
                        </span>
                      ))}
                      {index === 0 && <span className="badge">Best quote</span>}
                    </div>
                    <span className="route-amount">
                      {formatAmount(q.output, TOKENS[to].decimals, 4)}{' '}
                      <span className="muted">{to}</span>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted route-empty">Enter an amount to compare available routes.</p>
            )}
            <p className="microcopy">
              Sample reserves · Quotes include each pool’s configured fee.
            </p>
          </section>
        </div>
        <section className="panel swap-panel" aria-labelledby="swap-title">
          <div className="section-heading">
            <h2 id="swap-title">Swap</h2>
            <button className="icon-button" aria-label="Swap settings" onClick={onSettings}>
              <Settings2 size={20} />
            </button>
          </div>
          <div className="amount-box">
            <label htmlFor="swap-amount">You pay</label>
            <div className="amount-line">
              <input
                id="swap-amount"
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
                placeholder="0"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                maxLength={80}
                aria-invalid={!!error}
                aria-describedby={error ? 'amount-error' : undefined}
              />
              <button
                className="token-select"
                aria-label="Select pay token"
                onClick={() => {
                  setPicker('from');
                  setSearch('');
                }}
              >
                <TokenIcon symbol={from} small />
                {from}
                <ChevronDown size={16} />
              </button>
            </div>
            <span className="amount-fiat">
              {inputUnits
                ? `~${usd(Number(formatAmount(inputUnits, TOKENS[from].decimals)) * TOKENS[from].price)}`
                : '—'}
            </span>
          </div>
          <div className="reverse-row">
            <button
              className="reverse-button"
              aria-label="Reverse token pair"
              onClick={() => {
                setFrom(to);
                setTo(from);
                setInput(best ? formatAmount(best.output, TOKENS[to].decimals) : '');
              }}
            >
              <ArrowDown size={19} />
            </button>
          </div>
          <div className="amount-box output-box">
            <span className="muted">You receive</span>
            <div className="amount-line">
              <output className="output-amount" aria-label="Estimated output">
                {displayOutput}
              </output>
              <button
                className="token-select"
                aria-label="Select receive token"
                onClick={() => {
                  setPicker('to');
                  setSearch('');
                }}
              >
                <TokenIcon symbol={to} small />
                {to}
                <ChevronDown size={16} />
              </button>
            </div>
            <span className="amount-fiat">
              {best ? `~${usd(Number(displayOutput) * TOKENS[to].price)}` : '—'}
            </span>
          </div>
          {error && (
            <p className="form-error" id="amount-error" role="alert">
              {error}
            </p>
          )}
          <div className="swap-details">
            <Detail label="Slippage tolerance">
              <button className="inline-button" onClick={onSettings}>
                {(slippage / 100).toFixed(2)}%
              </button>
            </Detail>
            <Detail label="Minimum received">
              {best ? `${formatAmount(best.minimum, TOKENS[to].decimals, 6)} ${to}` : '—'}
            </Detail>
            <Detail label="Fee per pool">
              {best?.poolFeeBps?.map((fee) => `${(fee / 100).toFixed(2)}%`).join(' → ') || '—'}
            </Detail>
            <Detail label="Fee + price impact">
              {best ? `${(best.executionLossBps / 100).toFixed(2)}%` : '—'}
            </Detail>
          </div>
          <div className="swap-route">
            <Detail label="Route">{best?.path.join(' → ') || '—'}</Detail>
          </div>
          {best && best.executionLossBps > 500 && (
            <p className="form-error">High execution loss. Try a smaller amount.</p>
          )}
          <button
            className="button primary full-width"
            disabled={!best || !!error}
            onClick={() => best && setReview({ ...best, slippageBps: slippage })}
          >
            Review demo swap <ArrowRight size={17} />
          </button>
          <p className="microcopy centered">Preview only · No funds will move.</p>
        </section>
      </div>
      {picker && (
        <Modal title="Select a token" onClose={() => setPicker(null)}>
          <input
            className="text-input"
            aria-label="Search tokens"
            placeholder="Search by name or symbol"
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="token-options">
            {Object.values(TOKENS)
              .filter((t) => `${t.symbol} ${t.name}`.toLowerCase().includes(search.toLowerCase()))
              .map((t) => (
                <button
                  key={t.symbol}
                  aria-label={`Select ${t.symbol}, ${t.name}`}
                  onClick={() => selectToken(t.symbol)}
                >
                  <TokenIcon symbol={t.symbol} />
                  <span>
                    <strong>{t.symbol}</strong>
                    <small>{t.name}</small>
                  </span>
                  <span className="muted">{usd(t.price, t.price < 1 ? 4 : 2)}</span>
                </button>
              ))}
            {!Object.values(TOKENS).some((t) =>
              `${t.symbol} ${t.name}`.toLowerCase().includes(search.toLowerCase()),
            ) && <p className="muted">No matching demo tokens.</p>}
          </div>
          <p className="microcopy">Sample assets. Availability on a deployed network may differ.</p>
        </Modal>
      )}
      {review && (
        <Modal title="Review demo swap" onClose={() => setReview(null)}>
          <span className="badge">Simulation</span>
          <div className="review-amounts">
            <strong>
              {formatAmount(review.amounts[0], TOKENS[review.path[0]].decimals, 6)} {review.path[0]}
            </strong>
            <ArrowDown size={22} />
            <strong className="positive">
              {formatAmount(review.output, TOKENS[review.path[review.path.length - 1]].decimals, 6)}{' '}
              {review.path[review.path.length - 1]}
            </strong>
          </div>
          <div className="review-details">
            <Detail label="Minimum received">
              {formatAmount(
                review.minimum,
                TOKENS[review.path[review.path.length - 1]].decimals,
                6,
              )}{' '}
              {review.path[review.path.length - 1]}
            </Detail>
            <Detail label="Slippage">{(review.slippageBps / 100).toFixed(2)}%</Detail>
            <Detail label="Route">{review.path.join(' → ')}</Detail>
          </div>
          <p className="notice">
            This quote uses sample reserves. No approval, signature or transaction will be
            requested.
          </p>
          <button className="button primary full-width" onClick={() => setReview(null)}>
            Done
          </button>
        </Modal>
      )}
    </>
  );
}
