// Optional real RPC compatibility test. One synthetic EOA fixture transaction,
// not a DEX deployment, wallet extension test, or L1 finality rehearsal.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keccak256, sha256, stringToBytes, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Rpc } from '../src/devnet4/chain';
import { pollPendingSwap } from '../src/mainnet/pendingswap';
import {
  submissionBoundary,
  verifySubmissionHash,
  verifySameNonceReview,
  type SubmissionContext,
  type SubmissionIntent,
} from '../src/mainnet/submission-outcome';

const enabled = process.env.POSTERN_RETH_SUBMISSION_TEST === '1';
const account = privateKeyToAccount(`0x${'07'.repeat(32)}`); // Public synthetic fixture only.
const from = account.address.toLowerCase() as Address;
const to = `0x${'11'.repeat(20)}` as Address;
const chainId = 700771;

describe.skipIf(!enabled)('frontend submission helpers against isolated Bloch Reth', () => {
  let child: ChildProcessWithoutNullStreams | undefined;
  let out: string;
  let log = '';
  let rpc: Rpc;
  let context: SubmissionContext;
  let intent: SubmissionIntent;
  let hash: Hex;
  let included: Record<string, unknown>;
  const calls: { method: string; params: unknown[] }[] = [];
  const evidence: Record<string, unknown> = {
    schema: 'postern.frontend.submission-reth.v1',
    synthetic: true,
    l1Verified: false,
    finalized: false,
    walletExtension: false,
    assertions: [],
  };

  const save = async () => {
    if (out)
      await writeFile(join(out, 'result.json'), JSON.stringify(evidence, null, 2) + '\n', {
        mode: 0o600,
      });
  };

  beforeAll(async () => {
    const binary = process.env.BLOCH_EVM_DEV_BINARY;
    if (!binary || !isAbsolute(binary))
      throw new Error(
        'BLOCH_EVM_DEV_BINARY must name a trusted local executable by absolute path. No RPC endpoint or key can be supplied.',
      );
    out = await mkdtemp(join(tmpdir(), 'postern-submission-reth-'));
    evidence.binarySha256 = createHash('sha256')
      .update(await readFile(binary))
      .digest('hex');
    evidence.output = out;
    // Fixed synthetic flag, new owned database, ephemeral loopback port. There
    // is no option to contact a pre-existing node or substitute a funded key.
    child = spawn(binary, [
      '--synthetic-dev',
      '--init',
      '--fund',
      account.address,
      '--data-dir',
      join(out, 'synthetic-db'),
      '--port',
      '0',
      '--block-interval-ms',
      '1000',
    ]);
    const childProcess = child;
    const endpoint = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Synthetic RPC startup timed out.')), 15_000);
      const finish = (error?: Error, endpoint?: string) => {
        clearTimeout(timer);
        error ? reject(error) : resolve(endpoint!);
      };
      childProcess.once('error', (error) => finish(error));
      childProcess.once('exit', (code) =>
        finish(new Error(`Synthetic RPC exited during startup: ${code}`)),
      );
      const read = (chunk: Buffer) => {
        log = (log + chunk.toString()).slice(-2 * 1024 * 1024);
        const match = /SYNTHETIC DEV ONLY: HTTP=(http:\/\/127\.0\.0\.1:\d+)/.exec(log);
        if (match) finish(undefined, match[1]);
      };
      childProcess.stdout.on('data', read);
      childProcess.stderr.on('data', read);
    });
    let requestId = 0;
    rpc = async (method, params) => {
      calls.push({ method, params });
      const id = ++requestId;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) throw new Error(`Local RPC HTTP ${response.status}`);
      const body = (await response.json()) as {
        jsonrpc?: unknown;
        id?: unknown;
        result?: unknown;
        error?: { code: number; message: string };
      };
      if (body.jsonrpc !== '2.0' || body.id !== id)
        throw new Error('Local RPC response identity mismatch.');
      if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code });
      return body.result;
    };
    const identity = (await rpc('bloch_chainIdentity', [])) as Record<string, unknown>;
    expect(identity).toMatchObject({
      format: 'bloch-chain-identity-v1',
      headerFormat: 'bloch-node-header-v2-fixed-width',
      domain: `0x${'d3'.repeat(32)}`,
    });
    expect(BigInt(String(await rpc('eth_chainId', [])))).toBe(BigInt(chainId));
    const genesis = (await rpc('eth_getBlockByNumber', ['0x0', false])) as { hash: Hex };
    context = {
      chainId,
      genesisHash: genesis.hash,
      deploymentId: sha256(stringToBytes('synthetic frontend helper fixture; no deployed DEX')),
    };
    evidence.identity = identity;
    const head = (await rpc('eth_getBlockByNumber', ['latest', false])) as {
      number: Hex;
      hash: Hex;
    };
    const nonce = BigInt(
      String(
        await rpc('eth_getTransactionCount', [
          from,
          { blockHash: head.hash, requireCanonical: true },
        ]),
      ),
    );
    expect(nonce).toBe(0n);
    const boundary = {
      afterBlockNumber: BigInt(head.number).toString(),
      afterBlockHash: head.hash,
      nonce: nonce.toString(),
    };
    evidence.intentOrigin =
      'Explicit synthetic fixture; not approved by submissionBoundary or the app.';
    // The kind is metadata for the generic tracker. This EOA fixture deliberately
    // does not exercise MainnetLive deployment loading or contract call builders.
    intent = {
      ...context,
      ...boundary,
      id: '12345678-1234-1234-1234-123456789abc',
      kind: 'approval',
      from,
      to,
      data: '0x1234',
      value: '1',
      gas: '100000',
    };
    const raw = await account.signTransaction({
      type: 'eip1559',
      chainId,
      nonce: Number(intent.nonce),
      to,
      data: intent.data,
      value: 1n,
      gas: 100000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 100_000_000n,
    });
    hash = keccak256(raw);
    evidence.transaction = { hash, intent, state: 'before-send' };
    await save();
    // Exactly one publication attempt. A lost reply is never retried.
    expect(await rpc('eth_sendRawTransaction', [raw])).toBe(hash);
    const until = Date.now() + 15_000;
    for (;;) {
      const receipt = (await rpc('eth_getTransactionReceipt', [hash])) as Record<
        string,
        unknown
      > | null;
      if (receipt) {
        included = receipt;
        break;
      }
      if (Date.now() >= until)
        throw new Error('Synthetic transaction remained unresolved; no resend was attempted.');
      await delay(100);
    }
    expect(included).toMatchObject({ transactionHash: hash, status: '0x1', from, to });
    const canonical = (await rpc('eth_getBlockByNumber', [included.blockNumber, false])) as {
      hash: Hex;
    };
    expect(canonical.hash).toBe(included.blockHash);
    evidence.transaction = { hash, intent, state: 'included', receipt: included };
    await save();
  });

  it('refuses app preparation and same-nonce review without real finality', async () => {
    await expect(submissionBoundary(rpc, context, from)).rejects.toThrow(/final|settlement/i);
    await expect(verifySameNonceReview(rpc, intent, context, 0n)).rejects.toThrow(
      /final|settlement/i,
    );
    expect(calls.filter((call) => call.method === 'eth_sendRawTransaction')).toHaveLength(1);
    (evidence.assertions as string[]).push('missing-finality-refuses-preparation-and-review');
  });

  it('verifies the explicit fixture intent against the real RPC transaction body', async () => {
    await expect(verifySubmissionHash(rpc, hash, intent, context)).resolves.toBeUndefined();
    (evidence.assertions as string[]).push('explicit-fixture-real-transaction-body');
  });

  it('refuses a different saved nonce even when all call fields match', async () => {
    await expect(
      verifySubmissionHash(
        rpc,
        hash,
        { ...intent, nonce: (BigInt(intent.nonce) + 1n).toString() },
        context,
      ),
    ).rejects.toThrow(/nonce/);
    (evidence.assertions as string[]).push('different-nonce-refused');
  });

  it('keeps an included transaction unresolved without real finality', async () => {
    try {
      evidence.finalityObservation = await rpc('eth_getBlockByNumber', ['finalized', false]);
    } catch (error) {
      evidence.finalityObservation = { error: String(error) };
    }
    const result = await pollPendingSwap(
      rpc,
      { hash, intent, label: 'Synthetic helper fixture', deadline: 0n, sentAtMs: 0 },
      Date.now(),
      context,
    );
    expect(['waiting', 'unreachable']).toContain(result.kind);
    expect(result.kind).not.toBe('receipt');
    evidence.poll = result;
    (evidence.assertions as string[]).push('included-without-finality-retains-hold');
  });

  afterAll(async () => {
    try {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        const childProcess = child;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            childProcess.kill('SIGKILL');
            reject(new Error('Synthetic RPC shutdown timed out.'));
          }, 10_000);
          childProcess.once('exit', (code) => {
            clearTimeout(timer);
            code === 0 ? resolve() : reject(new Error(`Synthetic shutdown exit ${code}`));
          });
          childProcess.kill('SIGINT');
        });
      }
      if (child?.pid) expect(child.exitCode).toBe(0);
      evidence.completedAssertions = (evidence.assertions as string[]).length;
      evidence.passed = evidence.completedAssertions === 4;
    } catch (error) {
      evidence.passed = false;
      evidence.shutdownError = String(error);
      throw error;
    } finally {
      if (out) {
        await writeFile(join(out, 'server.log'), log, { mode: 0o600 });
        await save();
        console.log(`Synthetic frontend RPC evidence: ${out}`);
      }
    }
  });
});
