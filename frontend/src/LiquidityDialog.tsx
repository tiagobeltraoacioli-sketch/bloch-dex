import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { formatAmount, parseAmount } from './amm';
import { DEMO_POSITION, TOKENS } from './data';
import { Detail, Modal, PairIcons } from './components';
import type { LiquidityAction } from './model';

export default function LiquidityDialog({
  action,
  onClose,
}: {
  action: LiquidityAction;
  onClose: () => void;
}) {
  const { mode, pool } = action;
  const [input, setInput] = useState('1000');
  const [percentage, setPercentage] = useState(25);
  const [review, setReview] = useState(false);
  const isAdd = mode === 'add';
  const parsed = parseAmount(input, TOKENS[pool.token0].decimals);
  const amount0 = isAdd ? (parsed ?? 0n) : (DEMO_POSITION.token0 * BigInt(percentage)) / 100n;
  const amount1 = isAdd
    ? (amount0 * pool.reserve1) / pool.reserve0
    : (DEMO_POSITION.token1 * BigInt(percentage)) / 100n;
  const valid = isAdd
    ? amount0 > 0n && amount1 > 0n && amount0 <= pool.reserve0
    : pool.id === DEMO_POSITION.pool.id && percentage > 0;
  const title = review
    ? `Review ${isAdd ? 'deposit' : 'withdrawal'}`
    : `${isAdd ? 'Add' : 'Remove'} liquidity`;

  return (
    <Modal title={title} onClose={onClose}>
      <div className="liquidity-pair">
        <PairIcons a={pool.token0} b={pool.token1} />
        <strong>
          {pool.token0} / {pool.token1}
        </strong>
        <span className="badge">Demo</span>
      </div>
      {!review &&
        (isAdd ? (
          <label className="field-label">
            Amount of {pool.token0}
            <input
              className="text-input amount-input"
              inputMode="decimal"
              maxLength={80}
              autoFocus
              value={input}
              onChange={(e) => setInput(e.target.value)}
              aria-invalid={!valid}
            />
            <small>Sample deposit preview. Maximum: one current pool reserve.</small>
          </label>
        ) : (
          <div className="withdrawal-controls">
            <span className="withdrawal-percentage">{percentage}%</span>
            <input
              type="range"
              min="1"
              max="100"
              step="1"
              value={percentage}
              aria-label="Percentage to remove"
              onChange={(e) => setPercentage(Number(e.target.value))}
            />
            <div className="segmented">
              {[25, 50, 75, 100].map((p) => (
                <button key={p} aria-pressed={percentage === p} onClick={() => setPercentage(p)}>
                  {p}%
                </button>
              ))}
            </div>
          </div>
        ))}
      <div className="review-details">
        <Detail label={pool.token0}>
          {formatAmount(amount0, TOKENS[pool.token0].decimals, 6)}
        </Detail>
        <Detail label={pool.token1}>
          {formatAmount(amount1, TOKENS[pool.token1].decimals, 6)}
        </Detail>
        <Detail label={isAdd ? 'Deposit ratio' : 'Position removed'}>
          {isAdd ? 'Current sample reserves' : `${percentage}%`}
        </Detail>
      </div>
      {isAdd && !valid && (
        <p className="form-error" role="alert">
          Enter an amount within the sample pool limit that produces both tokens.
        </p>
      )}
      <p className="notice">
        {review
          ? 'This is a calculation preview. It does not update your position or submit a transaction.'
          : 'Amounts use sample reserves. Actual deposits and withdrawals need a fresh quote and transaction review.'}
      </p>
      {review ? (
        <div className="button-group">
          <button className="button secondary" onClick={() => setReview(false)}>
            Back
          </button>
          <button className="button primary grow" onClick={onClose}>
            Done
          </button>
        </div>
      ) : (
        <button
          className="button primary full-width"
          disabled={!valid}
          onClick={() => setReview(true)}
        >
          Review {isAdd ? 'deposit' : 'withdrawal'} <ArrowRight size={17} />
        </button>
      )}
    </Modal>
  );
}
