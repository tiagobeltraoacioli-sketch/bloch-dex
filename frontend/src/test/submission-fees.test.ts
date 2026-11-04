import { describe, expect, it } from 'vitest';
import { submissionFeeNote } from '../mainnet/submission-fees';
// Captured by the L2 local admission rehearsal; no real funds or wallet data.
import fixture from './fixtures/sequencer-fee-error.json';

describe('wallet submission fee diagnostics', () => {
  it('reports validated integer fields without claiming the wallet did not send', () => {
    const note = submissionFeeNote(fixture.error)!;
    expect(note).toContain(
      `priority fee ${BigInt(fixture.error.data.requiredPriorityFeePerGas)} wei/gas`,
    );
    expect(note).toContain(`max fee ${BigInt(fixture.error.data.requiredMaxFeePerGas)} wei/gas`);
    expect(note).toContain('not bound to your wallet');
    expect(note).toContain('outcome remains unknown');
    expect(note).toContain('no retry or fee increase');
    expect(note).not.toContain(fixture.error.data.transactionHash);
  });
  it('accepts a bounded structured wallet wrapper', () => {
    expect(submissionFeeNote({ code: -32603, data: { originalError: fixture.error } })).toBe(
      submissionFeeNote(fixture.error),
    );
    expect(submissionFeeNote({ cause: fixture.error })).toBe(submissionFeeNote(fixture.error));
  });
  it.each([
    ['kind', 'underpriced'],
    ['scope', 'latest'],
    ['transactionHash', `0x${'0'.repeat(64)}`],
    ['gasUsed', '0x0'],
    ['headNumber', '0x01'],
    ['requiredMaxFeePerGas', '0x1'],
    ['chargedFreshSlots', '0x2'],
    ['requiredPriorityFeePerGas', '-1'],
    ['headHash', 'help.example.com'],
  ])('ignores invalid diagnostic %s', (field, value) => {
    expect(
      submissionFeeNote({ ...fixture.error, data: { ...fixture.error.data, [field]: value } }),
    ).toBeUndefined();
  });
  it('ignores text-only, wrong-code and cyclic errors', () => {
    expect(submissionFeeNote(new Error(fixture.error.message))).toBeUndefined();
    expect(submissionFeeNote({ ...fixture.error, code: 4001 })).toBeUndefined();
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(submissionFeeNote(cyclic)).toBeUndefined();
  });
});
