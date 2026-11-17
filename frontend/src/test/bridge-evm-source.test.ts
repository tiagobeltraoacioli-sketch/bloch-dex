// R364-6 (reviewer 364, fourth pass of agents/328-dex-review-r17.md): the bridge page's EVM deposit read the vault and
// token state from the FIRST endpoint alone and signed a gas limit from that one endpoint's estimate. Now every read
// the deposit decides on goes through the DEX's two-endpoint agreement (one block hash, both endpoints), and the gas
// limit is the higher of two endpoints' estimates. Failing first: at 4aa0b47 neither export exists and the page used
// httpRpc(route.read.urls[0]).
import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, type Address, type Hex } from 'viem';
import { ERC20_ABI } from '../devnet4/chain';
import { VAULT_ABI, evmSourceGas, readEvmDepositState } from '../bridge/observe';
import type { LiveRoute } from '../bridge/config';

const TOKEN = '0x00000000000000000000000000000000000000aa' as Address;
const VAULT = '0x00000000000000000000000000000000000000bb' as Address;
const ACCOUNT = '0x00000000000000000000000000000000000000cc' as Address;
const HASH = `0x${'12'.repeat(32)}` as Hex;
const route = (urls: string[]) => ({ id: 'ethereum', name: 'Ethereum', chainId: '1', read: { urls }, custody: { address: VAULT }, asset: { id: TOKEN } }) as unknown as LiveRoute;

type Facts = { paused: boolean; balance: bigint; gas: bigint | null };
function chain(facts: Record<string, Facts>): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const { id, method, params } = JSON.parse(String(init.body)) as { id: number; method: string; params: unknown[] };
    const f = facts[url];
    const block = { number: '0x10', hash: HASH, timestamp: '0x6553f100', parentHash: `0x${'11'.repeat(32)}` };
    let result: unknown;
    if (method === 'eth_chainId') result = '0x1';
    else if (method === 'eth_blockNumber') result = '0x10';
    else if (method === 'eth_getBlockByNumber' || method === 'eth_getBlockByHash') result = block;
    else if (method === 'eth_estimateGas') {
      if (f.gas === null) return new Response('busy', { status: 503 });
      result = `0x${f.gas.toString(16)}`;
    } else if (method === 'eth_call') {
      const [call] = params as [{ to: Address; data: Hex }];
      const abi = call.to === TOKEN ? ERC20_ABI : VAULT_ABI;
      const { functionName } = decodeFunctionData({ abi, data: call.data } as never) as { functionName: string };
      const value: Record<string, unknown> = { allowance: 0n, balanceOf: f.balance, totalLocked: 0n, cap: 10n ** 12n, depositsEnabled: true, paused: f.paused };
      result = encodeFunctionResult({ abi, functionName, result: value[functionName] } as never);
    } else return new Response(JSON.stringify({ jsonrpc: '2.0', id, error: { message: `no ${method}` } }));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
  }) as typeof fetch;
}
const A = 'https://a.example';
const B = 'https://b.example';
const honest: Facts = { paused: true, balance: 5_000_000n, gas: 90_000n };

describe('R364-6: the EVM deposit reads and gas come from two agreeing endpoints', () => {
  it('reads the state at one block both endpoints report, and agrees with them', async () => {
    const s = await readEvmDepositState(route([A, B]), ACCOUNT, chain({ [A]: honest, [B]: honest }));
    expect(s).toMatchObject({ balance: 5_000_000n, open: false, block: HASH });
  });
  it('refuses when the first endpoint says a paused vault is open (the old page believed it)', async () => {
    await expect(readEvmDepositState(route([A, B]), ACCOUNT, chain({ [A]: { ...honest, paused: false }, [B]: honest }))).rejects.toThrow(/disagree|DISAGREE/i);
  });
  it('refuses a balance only one endpoint reports', async () => {
    await expect(readEvmDepositState(route([A, B]), ACCOUNT, chain({ [A]: { ...honest, balance: 9n ** 20n }, [B]: honest }))).rejects.toThrow(/disagree|DISAGREE/i);
  });
  it('refuses a route with one endpoint outside a rehearsal', async () => {
    await expect(readEvmDepositState(route([A]), ACCOUNT, chain({ [A]: honest }))).rejects.toThrow(/two independent endpoints/);
  });
  it('signs the HIGHER of two estimates plus a third, never the first endpoint\'s low one', async () => {
    const call = { to: VAULT, data: '0x' as Hex };
    expect(await evmSourceGas(route([A, B]), ACCOUNT, call, chain({ [A]: { ...honest, gas: 30_000n }, [B]: honest }))).toBe(120_000n);
    await expect(evmSourceGas(route([A, B]), ACCOUNT, call, chain({ [A]: honest, [B]: { ...honest, gas: null } }))).rejects.toThrow();
    await expect(evmSourceGas(route([A, B]), ACCOUNT, call, chain({ [A]: { ...honest, gas: 5_000_000n }, [B]: honest }))).rejects.toThrow(/outside/);
  });
});
