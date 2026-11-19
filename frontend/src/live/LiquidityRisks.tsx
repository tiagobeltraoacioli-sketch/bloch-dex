import { AlertTriangle } from 'lucide-react';
import type { Address } from 'viem';
import { CopyButton } from '../ui/CopyButton';
import { POOL_FEE_TEXT } from '../mainnet/liquidity';
import type { TokenFact } from '../multichain/token-facts';

/**
 * What a liquidity provider must know before signing, next to the action and never behind a click. Each line
 * states where it comes from:
 *   1, 2  contracts/UniswapV2Pair.sol `burn` (pro rata of the balances at that time); docs/MULTICHAIN-DEPLOY.md
 *         section 12, item 1 (price risk of a pool's depositor)
 *   3     docs/MULTICHAIN-DEPLOY.md sections 8 and 12 item 10 (tokens at the pair's address are a gift to the pool);
 *         UniswapV2Pair.sol `mint` / `skim`
 *   4     UniswapV2Pair.sol `_mintFee` (one sixth of the fee growth, as shares, at the next mint or burn);
 *         UniswapV2Factory.sol (`feeTo` is immutable); the recipient is read from the deployment record
 *   5     docs/MULTICHAIN-DEPLOY.md section 4 (an issuer can pause a token and blacklist addresses); the token
 *         list's own statement per token (`facts`)
 */
export function LiquidityRisks({
  feeTo,
  facts,
  symbols,
}: {
  feeTo: Address;
  /** The token list's statement for each token of the pool(s) shown; empty where the list says nothing. */
  facts: TokenFact[];
  /** The two tokens of the pool the action is about, when it is about one pool. */
  symbols?: readonly [string, string];
}) {
  const pair = symbols ? `${symbols[0]} and ${symbols[1]}` : 'the two tokens';
  return (
    <div className="notice liquidity-risks" role="note" aria-label="Risks of providing liquidity">
      <strong className="liquidity-risks-title">
        <AlertTriangle size={16} aria-hidden="true" /> Before you provide liquidity
      </strong>
      <ul>
        <li>
          <strong>Your position follows the pool&apos;s price.</strong> When the prices of {pair}{' '}
          move apart, a position is worth less than the same tokens held outside the pool
          (divergence loss, also called impermanent loss). Fees may not make up for it.
        </li>
        <li>
          <strong>A removal pays both tokens at the pool&apos;s ratio at that time</strong>, not the
          amounts you put in. You can receive more of one token and less of the other.
        </li>
        <li>
          <strong>Tokens sent straight to a pool&apos;s address are a gift to the pool.</strong>{' '}
          They are not a deposit and give you no shares. Deposit only with the steps of this page.
        </li>
        <li>
          <strong>Fees.</strong> Every swap pays {POOL_FEE_TEXT} to the pool. One sixth of what the
          fees add goes to the protocol fee recipient, as pool shares minted when liquidity is next
          added or removed; the rest stays with the liquidity providers. The recipient is fixed in
          the factory and cannot be changed:{' '}
          <span className="hashline">
            <code>{feeTo}</code>
            <CopyButton value={feeTo} what="address" />
          </span>
        </li>
        <li>
          <strong>A token&apos;s issuer keeps its powers.</strong> An issuer that can pause its
          token, block addresses or change its contract can do so to a pool or to you: a blocked
          pool cannot pay that token out. This is the token&apos;s own risk on every exchange.
          {facts.length > 0 && (
            <>
              {' '}
              The reviewed token list says:
              <ul className="liquidity-token-facts">
                {facts.map((f) => (
                  <li key={f.name}>
                    <strong>{f.name}</strong>: {f.fact}.
                  </li>
                ))}
              </ul>
            </>
          )}
        </li>
      </ul>
    </div>
  );
}
