// frontends-sec r10: RPC answers are untrusted text and numbers.
import { describe, expect, it } from 'vitest';
import { encodeFunctionResult, type Address } from 'viem';
import { httpRpc, LENS_ABI, quoteExactInput, rpcErrorText, RPC_TEXT_MAX } from '../devnet4/chain';
import type { DevnetDeployment } from '../devnet4/record';

describe('RPC error text', () => {
  it('drops links, handles, controls and length from an RPC message', () => {
    const text = rpcErrorText(
      'execution reverted: ‮held‬! Claim at https://bridge-support.example/claim or t.me/helpdesk, DM @bridgesupport, www.evil.test now',
    );
    expect(text).not.toMatch(/https?:|example|t\.me|@bridgesupport|www\.|‮/);
    expect(text).toMatch(/^execution reverted: held/);
    expect(Array.from(rpcErrorText('x'.repeat(5000))).length).toBe(RPC_TEXT_MAX + 1);
    expect(rpcErrorText({ toString: () => 'no' })).toBe('error');
    expect(rpcErrorText('claim on blochbridge-help.com today')).not.toMatch(/blochbridge-help/);
  });

  it('httpRpc carries only the cleaned text and a numeric code', async () => {
    const rpc = httpRpc(
      'https://x.invalid',
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            error: { code: 'x', message: 'Funds held. Recover at https://evil.example now' },
          }),
        ),
    );
    const error = await rpc('eth_call', []).catch((e: unknown) => e as Error & { code?: number });
    expect((error as Error).message).not.toMatch(/evil/);
    expect((error as { code?: number }).code).toBeUndefined();
  });
});

describe('lens quote consistency', () => {
  const A = `0x${'0a'.repeat(20)}` as Address;
  const B = `0x${'0b'.repeat(20)}` as Address;
  const W = `0x${'0c'.repeat(20)}` as Address;
  const d = {
    wrapped: W,
    lens: `0x${'0d'.repeat(20)}` as Address,
    pairs: [{ address: `0x${'0e'.repeat(20)}`, token0: A, token1: B }],
  } as unknown as DevnetDeployment;
  const answer = (q: { amountOut: bigint; minimumOut: bigint; amounts: bigint[] }) => async () =>
    encodeFunctionResult({
      abi: LENS_ABI,
      functionName: 'bestExactInput',
      result: [
        0n,
        [
          {
            available: true,
            blockNumber: 7n,
            timestamp: 1n,
            amountOut: q.amountOut,
            minimumOut: q.minimumOut,
            amounts: q.amounts,
            executionLossBps: [1n],
          },
          {
            available: false,
            blockNumber: 7n,
            timestamp: 1n,
            amountOut: 0n,
            minimumOut: 0n,
            amounts: [],
            executionLossBps: [],
          },
        ],
      ],
    });

  it('accepts the lens formula and refuses a minimum the slippage does not give', async () => {
    const ok = await quoteExactInput(
      answer({ amountOut: 1000n, minimumOut: 995n, amounts: [10n, 1000n] }),
      d,
      A,
      B,
      10n,
      50,
    );
    expect(ok?.minimumOut).toBe(995n);
    await expect(
      quoteExactInput(
        answer({ amountOut: 1000n, minimumOut: 1n, amounts: [10n, 1000n] }),
        d,
        A,
        B,
        10n,
        50,
      ),
    ).rejects.toThrow(/minimum does not match/);
  });

  it('refuses legs that do not describe this amount on this route', async () => {
    await expect(
      quoteExactInput(
        answer({ amountOut: 1000n, minimumOut: 995n, amounts: [9n, 1000n] }),
        d,
        A,
        B,
        10n,
        50,
      ),
    ).rejects.toThrow(/legs do not match/);
  });
});
