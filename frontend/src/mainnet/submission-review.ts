// Stored intent is data, not authority for arbitrary wallet calls. Rebuild it
// with the reviewed deployment's existing transaction builders before review.
import { decodeFunctionData, type Address } from 'viem';
import { ERC20_ABI } from '../devnet4/chain';
import type { DevnetDeployment } from '../devnet4/record';
import {
  approveTransaction,
  resetAllowanceTransaction,
  ROUTER_ABI,
  swapTransaction,
  type TransactionRequest,
} from '../devnet4/swap';
import { skimTransaction } from './reads';
import {
  assertSubmissionContext,
  submissionContext,
  type SubmissionIntent,
} from './submission-outcome';

function requireCall(condition: unknown): asserts condition {
  if (!condition)
    throw new Error(
      'The saved call does not match an allowed transaction of this verified deployment. Its hold remains; no wallet request was made.',
    );
}

export function transactionForSameNonceReview(
  intent: SubmissionIntent,
  deadline: bigint,
  deployment: DevnetDeployment,
): TransactionRequest {
  assertSubmissionContext(intent, submissionContext(deployment));
  const { from } = intent;
  let expected: TransactionRequest;
  if (intent.kind === 'approval') {
    requireCall(deadline === 0n && deployment.tokens.some((token) => token.address === intent.to));
    const call = decodeFunctionData({ abi: ERC20_ABI, data: intent.data });
    requireCall(call.functionName === 'approve');
    const [spender, amount] = call.args;
    // Round 20: an approval of zero is the allowance reset of a token whose record says `approveZeroFirst`
    // (Tether on Ethereum), and of no other token. Every other approval is an exact, non-zero, bounded amount.
    const reset =
      amount === 0n &&
      deployment.tokens.some((token) => token.address === intent.to && token.approveZeroFirst);
    requireCall(
      spender.toLowerCase() === deployment.router &&
        (reset || (amount > 0n && amount < 2n ** 256n - 1n)),
    );
    expected = reset
      ? resetAllowanceTransaction(deployment, intent.to, from)
      : approveTransaction(deployment, intent.to, from, amount);
  } else if (intent.kind === 'skim') {
    requireCall(deadline === 0n && deployment.pairs.some((pair) => pair.address === intent.to));
    expected = skimTransaction(intent.to, from);
  } else {
    requireCall(intent.kind === 'swap' && intent.to === deployment.router && deadline > 0n);
    const call = decodeFunctionData({ abi: ROUTER_ABI, data: intent.data });
    const nativeIn = call.functionName === 'swapExactBLCHForTokens';
    const nativeOut = call.functionName === 'swapExactTokensForBLCH';
    let amount: bigint,
      minimum: bigint,
      route: readonly Address[],
      recipient: Address,
      savedDeadline: bigint;
    if (call.functionName === 'swapExactBLCHForTokens') {
      [minimum, route, recipient, savedDeadline] = call.args;
      amount = BigInt(intent.value);
    } else {
      [amount, minimum, route, recipient, savedDeadline] = call.args;
    }
    const path = route.map((address) => address.toLowerCase() as Address);
    requireCall(
      amount > 0n &&
        minimum > 0n &&
        savedDeadline === deadline &&
        recipient.toLowerCase() === from &&
        path.length >= 2 &&
        path.length <= 3 &&
        new Set(path).size === path.length &&
        path.every((address) => deployment.tokens.some((token) => token.address === address)) &&
        path
          .slice(1)
          .every((address, index) =>
            deployment.pairs.some(
              (pair) =>
                (pair.token0 === path[index] && pair.token1 === address) ||
                (pair.token1 === path[index] && pair.token0 === address),
            ),
          ),
    );
    expected = swapTransaction(
      deployment,
      {
        path,
        amountIn: amount,
        minimumOut: minimum,
        amountOut: minimum,
        amounts: [],
        executionLossBps: [],
        blockNumber: 0n,
      },
      { token: path[0], native: nativeIn },
      { token: path.at(-1)!, native: nativeOut },
      from,
      deadline,
    );
  }
  requireCall(
    expected.to.toLowerCase() === intent.to &&
      expected.data.toLowerCase() === intent.data &&
      expected.value.toString() === intent.value &&
      expected.gas.toString() === intent.gas,
  );
  return { ...expected, chainId: intent.chainId, nonce: BigInt(intent.nonce) };
}

/** Describe decoded, allowed bytes, never a mutable local-storage label. */
export function sameNonceReviewDetails(
  intent: SubmissionIntent,
  deadline: bigint,
  deployment: DevnetDeployment,
): [string, string][] {
  transactionForSameNonceReview(intent, deadline, deployment);
  const details: [string, string][] = [['Request', intent.kind]];
  if (intent.kind === 'approval') {
    const call = decodeFunctionData({ abi: ERC20_ABI, data: intent.data });
    requireCall(call.functionName === 'approve');
    details.push(
      ['Token', intent.to],
      ['Spender', call.args[0].toLowerCase()],
      ['Exact allowance (base units)', call.args[1].toString()],
    );
  } else if (intent.kind === 'swap') {
    const call = decodeFunctionData({ abi: ROUTER_ABI, data: intent.data });
    if (call.functionName === 'swapExactBLCHForTokens') {
      details.push(
        ['Native input (wei)', intent.value],
        ['Minimum output (base units)', call.args[0].toString()],
        ['Token path', call.args[1].join(' → ')],
        ['Recipient', call.args[2].toLowerCase()],
      );
    } else {
      details.push(
        ['Input (base units)', call.args[0].toString()],
        ['Minimum output (base units)', call.args[1].toString()],
        ['Token path', call.args[2].join(' → ')],
        ['Recipient', call.args[3].toLowerCase()],
      );
    }
  } else details.push(['Recipient', intent.from]);
  return [
    ...details,
    ['Chain ID', intent.chainId.toString()],
    ['From', intent.from],
    ['To', intent.to],
    ['Nonce', intent.nonce],
    ['Native value (wei)', intent.value],
    ['Gas limit', intent.gas],
    ['Original deadline (Unix seconds)', deadline === 0n ? 'None' : deadline.toString()],
    ['Calldata', intent.data],
  ];
}
