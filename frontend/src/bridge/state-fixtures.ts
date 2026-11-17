// Fixed observations that reach every named state of status.ts once. Used by the rendering tests
// (src/test/bridge-status.test.tsx: one test per state) and by the state gallery (BridgeStates.tsx).
import type { Address, Hex } from 'viem';
import type { Route } from './config';
import type { BurnObservation, MintObservation } from './l2';
import { exitStatus, mintStatus, sourceDepositStatus, unfinalizedBurnStatus, type SourceExit, type Status } from './status';

export const NOW = 1_794_787_200n;
const id = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const RECIPIENT: Record<string, string> = {
  ethereum: '0x99ee0a068b17de102c3ef986247615e07996823f',
  'arbitrum-one': '0x99ee0a068b17de102c3ef986247615e07996823f',
  bitcoin: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
  solana: 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB',
  tron: 'TCQ2d5gxTczSeN2oeni16JwMW7HWLzXEKc',
  stellar: 'GAF2DTU23X5CFOPOUCUBTFJ5PKTSOV4GLZAJB5VMJW2JUA5KKYF5OLNA',
};
const burn = (route: Route, amount: bigint, over: Partial<BurnObservation> = {}): BurnObservation => ({
  burnId: id(7),
  burnNonce: 7n,
  amount,
  block: 412n,
  tx: id(0xabc),
  recipient: RECIPIENT[route.id] ?? RECIPIENT.ethereum,
  recipient20: '0x1111111111111111111111111111111111111111' as Address,
  maxFeeRate: route.kind === 'utxo' ? 12 : undefined,
  viaRouter: !!route.router,
  ...over,
});
const mint = (amount: bigint, over: Partial<MintObservation> = {}): MintObservation => ({
  replayKey: id(3),
  amount,
  queuedAt: { block: 400n, tx: id(0xdef) },
  pending: { readyAt: NOW + 30_000n },
  executed: null,
  cancelled: null,
  creditHead: false,
  ...over,
});
const vault = (over: Partial<Extract<SourceExit, { kind: 'vault' }>> = {}): SourceExit => ({ kind: 'vault', released: false, queuedUntil: null, pausedUntil: 0n, releasesEnabled: true, available: 10n ** 12n, ...over });
const record = (over: Partial<NonNullable<Extract<SourceExit, { kind: 'solana' }>['record']>> = {}) => ({
  state: 'approved' as const,
  burnNonce: 7n,
  commitment: '0x1111111111111111111111111111111111111111' as Hex,
  amount: 2_500_000_000n,
  nativeBurnId: id(7),
  readyAt: NOW - 10n,
  seq: 5n,
  paidAt: 0n,
  paidAmount: 0n,
  ...over,
});
const solana = (over: Partial<Extract<SourceExit, { kind: 'solana' }>> = {}): SourceExit => ({ kind: 'solana', record: null, paidBit: false, pausedUntil: 0n, voidThroughSeq: 0n, bucket: 10n ** 12n, destination: 'system', tokenAccount: true, ...over });
const stellar = (over: Partial<Extract<SourceExit, { kind: 'stellar' }>> = {}): SourceExit => ({ kind: 'stellar', burnStatus: 0, pending: null, pauseCount: 2n, pausedUntil: 0n, trustline: 'trusted', ...over });
const bitcoin = (over: Partial<Extract<SourceExit, { kind: 'bitcoin' }>> = {}): SourceExit => ({ kind: 'bitcoin', payment: null, feeEstimate: 8, setAside: false, claimed: false, ...over });

export type StateFixture = {
  id: string;
  /** The state name status.ts must give. */
  state: string;
  route: string;
  amount: bigint;
  heading: (route: Route) => string;
  status: (route: Route) => Status;
};
const USDC = 2_500_000_000n;
const BTC = 60_000n;
const exit = (fixtureId: string, state: string, route: string, amount: bigint, source: SourceExit, over: Partial<BurnObservation> = {}): StateFixture => ({
  id: fixtureId,
  state,
  route,
  amount,
  heading: () => 'Exit',
  status: (r) => exitStatus(r, burn(r, amount, over), source, NOW),
});
const deposit = (fixtureId: string, state: string, route: string, status: (route: Route) => Status): StateFixture => ({ id: fixtureId, state, route, amount: USDC, heading: () => 'Deposit', status });

export const STATE_FIXTURES: StateFixture[] = [
  // deposits
  deposit('deposit not seen', 'deposit-not-seen', 'ethereum', (r) => sourceDepositStatus(r, { seen: false })),
  deposit('deposit waiting for source finality', 'deposit-source-pending', 'bitcoin', (r) => sourceDepositStatus(r, { seen: true, final: false, confirmations: 3, needed: 8 })),
  deposit('deposit final, awaiting attestation', 'deposit-awaiting-attestation', 'solana', (r) => sourceDepositStatus(r, { seen: true, final: true })),
  deposit('credit delay', 'deposit-credit-delay', 'arbitrum-one', (r) => mintStatus(r, mint(USDC), NOW, 0n)),
  deposit('credit ready', 'deposit-ready', 'tron', (r) => mintStatus(r, mint(USDC, { pending: { readyAt: NOW - 5n }, creditHead: true }), NOW, 0n)),
  deposit('credit ready behind another', 'deposit-ready-behind', 'stellar', (r) => mintStatus(r, mint(USDC, { pending: { readyAt: NOW - 5n } }), NOW, 0n)),
  deposit('mints paused', 'deposit-paused', 'ethereum', (r) => mintStatus(r, mint(USDC), NOW, NOW + 100_000n)),
  deposit('credit cancelled by guardians', 'deposit-cancelled', 'solana', (r) => mintStatus(r, mint(USDC, { pending: null, cancelled: { block: 405n, tx: id(0xc) } }), NOW, 0n)),
  deposit('credited', 'deposit-credited', 'bitcoin', (r) => mintStatus(r, mint(USDC, { pending: null, executed: { block: 431n, tx: id(0xe) } }), NOW, 0n)),
  // exits: the L2 part
  { id: 'burn sent', state: 'exit-burn-sent', route: 'ethereum', amount: USDC, heading: () => 'Exit', status: (r) => unfinalizedBurnStatus(r, null, 411n) },
  { id: 'burn not final', state: 'exit-burn-not-final', route: 'ethereum', amount: USDC, heading: () => 'Exit', status: (r) => unfinalizedBurnStatus(r, 412n, 411n) },
  // EVM and TRON vaults
  exit('waiting for signatures', 'exit-waiting-signatures', 'ethereum', USDC, vault()),
  exit('vault paused', 'exit-vault-paused', 'arbitrum-one', USDC, vault({ pausedUntil: NOW + 200_000n })),
  exit('releases closed', 'exit-releases-closed', 'tron', USDC, vault({ releasesEnabled: false })),
  exit('waiting for the daily limit', 'exit-waiting-limit', 'tron', USDC, vault({ available: 100_000_000n })),
  exit('paid', 'exit-paid', 'ethereum', USDC, vault({ released: true })),
  exit('source unread', 'exit-source-unread', 'stellar', USDC, { kind: 'unread', reason: 'This page cannot read the Stellar vault\'s own record of an exit yet (queued, voided by a pause, paid). The recipient account exists and can receive USDC.' }),
  // Solana: approve, then execute
  exit('solana waiting for signatures', 'exit-waiting-signatures', 'solana', USDC, solana()),
  exit('solana approved, waiting the delay', 'exit-approved-waiting-delay', 'solana', USDC, solana({ record: record({ readyAt: NOW + 1500n }) })),
  exit('solana approved, payable', 'exit-approved-payable', 'solana', USDC, solana({ record: record() })),
  exit('solana approved, no token account', 'exit-approved-no-token-account', 'solana', USDC, solana({ record: record(), tokenAccount: false })),
  exit('solana approved, waiting for the limit', 'exit-waiting-limit', 'solana', USDC, solana({ record: record(), bucket: 1n })),
  exit('solana approval voided by a pause', 'exit-voided-by-pause', 'solana', USDC, solana({ record: record(), voidThroughSeq: 9n, pausedUntil: NOW + 250_000n })),
  exit('solana vault paused', 'exit-vault-paused', 'solana', USDC, solana({ pausedUntil: NOW + 250_000n })),
  exit('solana held: destination not a wallet', 'exit-held', 'solana', USDC, solana({ destination: 'not-a-wallet' })),
  exit('solana direct burn held', 'exit-held-direct-burn', 'solana', USDC, solana(), { viaRouter: false, recipient: '0x1111111111111111111111111111111111111111' }),
  exit('solana paid', 'exit-paid', 'solana', USDC, solana({ paidBit: true })),
  // Stellar: the queue and the pause that voids it
  exit('stellar waiting for the committee', 'exit-waiting-signatures', 'stellar', USDC, stellar()),
  exit('stellar no trustline', 'exit-waiting-signatures', 'stellar', USDC, stellar({ trustline: 'no-trustline' })),
  exit('stellar queued', 'exit-queued', 'stellar', USDC, stellar({ burnStatus: 1, pending: { readyAt: NOW + 6000n, pauseCount: 2n } })),
  exit('stellar queued, payable', 'exit-queued-payable', 'stellar', USDC, stellar({ burnStatus: 1, pending: { readyAt: NOW - 1n, pauseCount: 2n } })),
  exit('stellar queue voided by a pause', 'exit-voided-by-pause', 'stellar', USDC, stellar({ burnStatus: 1, pending: { readyAt: NOW + 6000n, pauseCount: 1n }, pausedUntil: NOW + 250_000n })),
  exit('stellar paused', 'exit-vault-paused', 'stellar', USDC, stellar({ pausedUntil: NOW + 250_000n })),
  exit('stellar held', 'exit-held', 'stellar', USDC, stellar({ burnStatus: 3 })),
  exit('stellar paid', 'exit-paid', 'stellar', USDC, stellar({ burnStatus: 2 })),
  // Bitcoin: the fee ceiling
  exit('bitcoin payable', 'exit-payable', 'bitcoin', BTC, bitcoin()),
  exit('bitcoin waiting for fees', 'exit-waiting-fee-rate', 'bitcoin', BTC, bitcoin({ feeEstimate: 85 })),
  exit('bitcoin set aside', 'exit-set-aside', 'bitcoin', BTC, bitcoin({ setAside: true })),
  exit('bitcoin direct burn unclaimed', 'exit-unclaimed', 'bitcoin', BTC, bitcoin(), { viaRouter: false, recipient: '0x1111111111111111111111111111111111111111' }),
  exit('bitcoin paid', 'exit-paid', 'bitcoin', BTC, bitcoin({ payment: { txid: 'f'.repeat(64), confirmations: 3, sats: 5_992_176n } })),
];
