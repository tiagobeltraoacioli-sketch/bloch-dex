// F-L2 (round 15): on the pinned mainnet genesis the page accepts only a report of the mainnet gate.
import { describe, expect, it } from 'vitest';
import pins from '../../../deployments/mainnet/700770/pins.json';
import { requireMainnetGateReport } from '../mainnet/config';

const PINNED = pins.l2.genesisHash;
const SAFE = `0x${'5'.repeat(40)}`;
const TOKEN = `0x${'6'.repeat(40)}`;
const WRAPPED = `0x${'7'.repeat(40)}`;
const deployment = {
  feeTo: SAFE,
  tokens: [
    { address: TOKEN, wrapped: false },
    { address: WRAPPED, wrapped: true },
  ],
};
type Report = {
  pinned?: { chainId: number; genesisHash: string; safe: string };
  bridgeTokens: { symbol: string; address: string }[];
};
const report = (): Report => ({
  pinned: { chainId: 700770, genesisHash: PINNED, safe: SAFE },
  bridgeTokens: [{ symbol: 'bUSDC', address: TOKEN }],
});

describe('mainnet gate report (F-L2)', () => {
  it('accepts the mainnet wrapper report on the pinned genesis', () => {
    expect(() => requireMainnetGateReport(report(), deployment, PINNED)).not.toThrow();
  });

  it('does not apply to a rehearsal genesis', () => {
    expect(() => requireMainnetGateReport({}, deployment, `0x${'9'.repeat(64)}`)).not.toThrow();
  });

  const cases: [string, (r: Report) => void, RegExp][] = [
    [
      'a generic-gate report without the pinned block',
      (r) => {
        delete r.pinned;
      },
      /not written by the mainnet gate/,
    ],
    [
      'another genesis in the pinned block',
      (r) => {
        r.pinned!.genesisHash = `0x${'1'.repeat(64)}`;
      },
      /not written by the mainnet gate/,
    ],
    [
      'another chain',
      (r) => {
        r.pinned!.chainId = 1;
      },
      /not written by the mainnet gate/,
    ],
    [
      'a Safe that is not the fee recipient',
      (r) => {
        r.pinned!.safe = `0x${'4'.repeat(40)}`;
      },
      /not written by the mainnet gate/,
    ],
    [
      'no bridge token checked',
      (r) => {
        r.bridgeTokens = [];
      },
      /every bridge token/,
    ],
    [
      'another token checked',
      (r) => {
        r.bridgeTokens[0].address = WRAPPED;
      },
      /every bridge token/,
    ],
  ];
  it.each(cases)('refuses %s', (_name, change, pattern) => {
    const r = report();
    change(r);
    expect(() => requireMainnetGateReport(r, deployment, PINNED)).toThrow(pattern);
  });
});
