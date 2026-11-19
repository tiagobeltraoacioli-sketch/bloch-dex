// One place decides the approve sequence for a token (round 20, agent 411).
//
// The route approves EXACTLY the amount a transaction needs, never an unlimited allowance, and asks for one
// wallet step at a time. `approvalPlan` returns the steps still needed before `needed` can be pulled by the
// router; the caller shows the FIRST step only, and asks again after it has settled and the allowance was read
// again at the page's pinned block.
//
// Seam for tokens whose `approve` deviates (agent 409, USDT): a token whose record says its approve reverts when a
// non-zero allowance is changed to another non-zero amount gets a reset step first. That rule is one branch here
// (`zeroFirst`); the liquidity dialog and any later caller get it without change. The pool-share token of a pair
// (UniswapV2ERC20) is a plain ERC-20 approve and takes the same path.
import type { Address } from 'viem';
import { encodeFunctionData } from 'viem';
import { ERC20_ABI } from '../devnet4/chain';
import type { DevnetDeployment } from '../devnet4/record';
import { APPROVE_GAS, approveTransaction, type TransactionRequest } from '../devnet4/swap';

export type ApprovalToken = {
  address: Address;
  /** The name the page shows. */
  label: string;
  decimals: number;
  /** The token's approve reverts on a change from one non-zero allowance to another (set by the token list). */
  zeroFirst?: boolean;
};

export type ApprovalStep = {
  kind: 'reset' | 'approve';
  token: ApprovalToken;
  /** The allowance this step sets: zero for a reset, else exactly the amount needed. */
  amount: bigint;
  build: () => TransactionRequest;
};

/** The steps that bring the router's allowance of `token` to at least `needed`, in order. Empty: nothing to do. */
export function approvalPlan(
  d: DevnetDeployment,
  token: ApprovalToken,
  owner: Address,
  current: bigint,
  needed: bigint,
): ApprovalStep[] {
  if (needed <= 0n || current >= needed) return [];
  const approve: ApprovalStep = {
    kind: 'approve',
    token,
    amount: needed,
    build: () => approveTransaction(d, token.address, owner, needed),
  };
  if (token.zeroFirst && current > 0n)
    return [
      {
        kind: 'reset',
        token,
        amount: 0n,
        build: () => ({
          from: owner,
          to: token.address,
          data: encodeFunctionData({
            abi: ERC20_ABI,
            functionName: 'approve',
            args: [d.router, 0n],
          }),
          value: 0n,
          gas: APPROVE_GAS,
        }),
      },
      approve,
    ];
  return [approve];
}
