// Explicit devnet4 swap flow through an injected EIP-1193 wallet: switch to
// chain 700771, approve the exact input amount when the allowance is short,
// then call the router's swapExact* with the lens's slippage-bounded minimum
// and a wall-clock deadline (devnet4 L2 timestamps are wall-clock seconds).
// Every transaction carries an explicit gas limit: the L2 RPC cannot estimate
// against `pending`.
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';
import type { Provider } from '../wallet';
import { ERC20_ABI, readCall, type LensQuote, type Rpc } from './chain';
import type { DevnetDeployment } from './record';

export const ROUTER_ABI = parseAbi([
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
  'function swapExactBLCHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)',
  'function swapExactTokensForBLCH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
]);

export const APPROVE_GAS = 100_000n;
export const SWAP_GAS_PER_HOP = 250_000n;
export const DEFAULT_DEADLINE_MINUTES = 30;
/** One L2 block per settlement proof (10–20 min): wait up to an hour for a receipt. */
export const RECEIPT_TIMEOUT_MS = 60 * 60 * 1000;

export type TransactionRequest = {
  from: Address;
  to: Address;
  data: Hex;
  value: bigint;
  gas: bigint;
};
export type SwapSide = { token: Address; native: boolean };

export class SwapError extends Error {}
function refuse(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SwapError(message);
}

const hex = (value: bigint) => `0x${value.toString(16)}`;

/** Build the router call for a lens quote. Native BLCH in or out uses the BLCH entry points. */
export function swapTransaction(
  d: DevnetDeployment,
  quote: LensQuote,
  input: SwapSide,
  output: SwapSide,
  from: Address,
  deadline: bigint,
): TransactionRequest {
  refuse(!(input.native && output.native), 'Choose a token to swap BLCH for.');
  refuse(
    quote.path[0] === input.token && quote.path.at(-1) === output.token,
    'The quote is for another pair.',
  );
  refuse(!input.native || input.token === d.wrapped, 'Only BLCH is native.');
  refuse(!output.native || output.token === d.wrapped, 'Only BLCH is native.');
  refuse(
    quote.minimumOut > 0n && quote.minimumOut <= quote.amountOut,
    'The quote has no valid minimum.',
  );
  const gas = SWAP_GAS_PER_HOP * BigInt(quote.path.length - 1);
  const path = quote.path;
  const data = input.native
    ? encodeFunctionData({
        abi: ROUTER_ABI,
        functionName: 'swapExactBLCHForTokens',
        args: [quote.minimumOut, path, from, deadline],
      })
    : output.native
      ? encodeFunctionData({
          abi: ROUTER_ABI,
          functionName: 'swapExactTokensForBLCH',
          args: [quote.amountIn, quote.minimumOut, path, from, deadline],
        })
      : encodeFunctionData({
          abi: ROUTER_ABI,
          functionName: 'swapExactTokensForTokens',
          args: [quote.amountIn, quote.minimumOut, path, from, deadline],
        });
  return { from, to: d.router, data, value: input.native ? quote.amountIn : 0n, gas };
}

/** Approve exactly `amount` for the router (never unlimited). */
export function approveTransaction(
  d: DevnetDeployment,
  token: Address,
  from: Address,
  amount: bigint,
): TransactionRequest {
  refuse(amount > 0n, 'Nothing to approve.');
  return {
    from,
    to: token,
    data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [d.router, amount] }),
    value: 0n,
    gas: APPROVE_GAS,
  };
}

export function deadlineFrom(nowMs: number, minutes = DEFAULT_DEADLINE_MINUTES): bigint {
  return BigInt(Math.floor(nowMs / 1000) + minutes * 60);
}

export async function allowanceOf(
  rpc: Rpc,
  d: DevnetDeployment,
  token: Address,
  owner: Address,
): Promise<bigint> {
  return readCall<bigint>(rpc, ERC20_ABI, token, 'allowance', [owner, d.router], 'latest');
}

/** Ask the wallet to use devnet4, adding the network when the wallet does not know it. */
export async function ensureDevnet4(
  provider: Provider,
  d: DevnetDeployment,
  walletRpcUrl: string,
): Promise<void> {
  const chainId = `0x${d.chainId.toString(16)}`;
  if (String(await provider.request({ method: 'eth_chainId' })).toLowerCase() === chainId) return;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch (error) {
    if ((error as { code?: number })?.code !== 4902) throw error;
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId,
          chainName: 'Bloch L2 devnet4 (zero value)',
          nativeCurrency: { name: 'Bloch', symbol: 'BLCH', decimals: 18 },
          rpcUrls: [walletRpcUrl],
        },
      ],
    });
  }
  refuse(
    String(await provider.request({ method: 'eth_chainId' })).toLowerCase() === chainId,
    'The wallet is not on Bloch L2 devnet4.',
  );
}

/** Send through the wallet; returns the transaction hash. */
export async function sendTransaction(provider: Provider, tx: TransactionRequest): Promise<Hex> {
  const hash = await provider.request({
    method: 'eth_sendTransaction',
    params: [{ from: tx.from, to: tx.to, data: tx.data, value: hex(tx.value), gas: hex(tx.gas) }],
  });
  refuse(
    typeof hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(hash),
    'The wallet returned no transaction hash.',
  );
  return hash.toLowerCase() as Hex;
}

export type Receipt = { status: 'success' | 'reverted'; blockNumber: bigint; gasUsed: bigint };

/** Poll the RPC for a receipt. */
export async function waitForReceipt(
  rpc: Rpc,
  hash: Hex,
  {
    intervalMs = 10_000,
    timeoutMs = RECEIPT_TIMEOUT_MS,
    sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)),
  } = {},
): Promise<Receipt> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const receipt = (await rpc('eth_getTransactionReceipt', [hash])) as {
      status?: string;
      blockNumber?: string;
      gasUsed?: string;
    } | null;
    if (receipt?.blockNumber) {
      return {
        status: receipt.status === '0x1' ? 'success' : 'reverted',
        blockNumber: BigInt(receipt.blockNumber),
        gasUsed: BigInt(receipt.gasUsed ?? '0x0'),
      };
    }
    refuse(Date.now() < deadline, 'No receipt yet; check the transaction later.');
    await sleep(intervalMs);
  }
}
