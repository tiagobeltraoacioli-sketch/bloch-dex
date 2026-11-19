// The Bloch L2 (chain 700770) as a network of the multichain site "Bloch DEX" (owner, 2026-11-19).
//
// It is NOT a chain of deployments/multichain.json: that schema states that every Bloch-L2-only rule is off and
// multichain/config.ts refuses a file that turns one on, and refuses chain 700770 by its id. The L2 keeps what the
// Bloch L2 site reads, unchanged and in one place:
//   - deployments/mainnet/frontend.network.json and dex-mainnet.record.json, through the same parsers
//     (mainnet/config.ts `parseNetwork`, `loadMainnetState`: record domain `postern.dex.frontend-record.v1`, the
//     mainnet gate report, the pinned genesis), so the owner's L2 deployment procedure writes the same two files
//     for both sites;
//   - its reader: ONE endpoint read at the chain's own `finalized` block (devnet4/chain.ts `httpRpc`), not the
//     public chains' two agreeing endpoints with a confirmation depth;
//   - its rules, which the route component (MainnetLive) applies from the network file and the deployment: the
//     reserve caps and the k ceiling, the new-slot fee, the idle-block policy, the bridged-assets card and the
//     bridge hold, and the L2's words.
// What this file adds is what the multichain shell needs to list it: a key, the words of the heading, and, while
// the route is not live, why (deployments/mainnet/l2-phase.json).
import type { Rpc } from '../devnet4/chain';
import { httpRpc } from '../devnet4/chain';
import {
  bundledNetwork,
  bundledRecord,
  loadMainnetState,
  parseNetwork,
  plannedCaps,
  plannedPairs,
  type MainnetNetwork,
  type MainnetState,
  type PlannedCap,
} from '../mainnet/config';
import { BLOCH_L2_WORDING, type Wording } from '../mainnet/wording';
import { DEX_MAINNET_CHAIN_ID } from '../network-identity';
import phaseJson from '../../../deployments/mainnet/l2-phase.json';

export const BLOCH_L2_KEY = 'bloch-l2';
export const PHASE_DOMAIN = 'postern.dex.l2-network-phase.v1';

export class BlochL2ConfigError extends Error {}
function refuse(condition: unknown, message: string): asserts condition {
  if (!condition) throw new BlochL2ConfigError(`Bloch L2 route configuration: ${message}`);
}

/** Whether the L2 release in production accepts user transactions (deployments/mainnet/l2-phase.json). */
export type L2Phase = { userTransactions: 'not-enabled' | 'enabled' };

export function parsePhase(input: unknown): L2Phase {
  const p = input as Record<string, unknown>;
  refuse(
    p && typeof p === 'object' && !Array.isArray(p) && p.domain === PHASE_DOMAIN,
    'unsupported phase file',
  );
  refuse(p.schemaVersion === 1, 'unsupported phase file');
  refuse(
    Object.keys(p).every((key) =>
      ['schemaVersion', 'domain', 'network', 'chainId', 'userTransactions', 'note'].includes(key),
    ),
    'the phase file has an unknown field',
  );
  refuse(
    p.chainId === DEX_MAINNET_CHAIN_ID && p.network === 'bloch-l2-mainnet',
    `the phase file is not for chain ${DEX_MAINNET_CHAIN_ID}`,
  );
  refuse(
    p.userTransactions === 'not-enabled' || p.userTransactions === 'enabled',
    'userTransactions must be "not-enabled" or "enabled"',
  );
  return { userTransactions: p.userTransactions };
}

/**
 * Said first among the reasons while the route is not live and the phase file says `not-enabled`. The words are
 * the repository's: "the launch release is deposit-only" (docs/MAINNET-700770-PACKAGE.md) and the runbook's first
 * precondition, "The L2 mainnet (chain 700770) is activated and accepts user transactions"
 * (docs/MAINNET-READINESS.md, section 6). src/test/multichain-bloch-l2.test.tsx keeps both sentences in the docs.
 */
export const DEPOSIT_ONLY_REASON =
  'Bloch L2 runs its deposit-only launch release: it does not accept user transactions yet, so the exchange cannot be deployed on it and no swap can be sent there.';

/** The reasons of a route that is not live, with the phase: what the L2 site says, and before it why. */
export function notLiveReasons(reasons: string[], phase: L2Phase): string[] {
  return phase.userTransactions === 'not-enabled' ? [DEPOSIT_ONLY_REASON, ...reasons] : reasons;
}

/**
 * The words of the L2 route on this site: the Bloch L2's own (mainnet/wording.ts), with this site's heading
 * ("Bloch DEX on …", as every network here) and, for a failed read, the network's name instead of "Mainnet",
 * which on a site that lists Ethereum would name the wrong chain.
 */
export const BLOCH_L2_SITE_WORDING: Readonly<Wording> = Object.freeze({
  ...BLOCH_L2_WORDING,
  title: 'Bloch DEX on Bloch L2',
  reads: 'Bloch L2 reads',
});

export type BlochL2Entry = {
  kind: 'bloch-l2';
  key: typeof BLOCH_L2_KEY;
  network: MainnetNetwork;
  wording: Wording;
  planned: { caps: PlannedCap[]; pairs: [string, string][] };
  load: () => Promise<MainnetState>;
  /** The L2's own reader: one endpoint, read at the chain's finalized block by the route. */
  rpc: Rpc;
  phase: L2Phase;
};

/**
 * The entry from the L2 site's bundled files (the defaults), or from given ones (tests, and nothing else).
 * Creating it reads nothing from any network: `rpc` asks only when the route calls it, and the route calls it
 * only for a live state.
 */
export function blochL2Entry(
  input: { network?: unknown; record?: unknown; phase?: unknown } = {},
): BlochL2Entry {
  const network = input.network === undefined ? bundledNetwork() : parseNetwork(input.network);
  const record = input.record === undefined ? bundledRecord : input.record;
  const phase = parsePhase(input.phase === undefined ? phaseJson : input.phase);
  return {
    kind: 'bloch-l2',
    key: BLOCH_L2_KEY,
    network,
    wording: BLOCH_L2_SITE_WORDING,
    planned: { caps: plannedCaps(), pairs: plannedPairs() },
    // Verified again at every call, as on the Bloch L2 site (`bundledState`).
    load: () =>
      loadMainnetState(record, network).then((s) =>
        s.status === 'not-live' ? { ...s, reasons: notLiveReasons(s.reasons, phase) } : s,
      ),
    rpc: httpRpc(network.rpcUrl),
    phase,
  };
}

/** A network of this site that is the Bloch L2 (the others are the public chains of multichain/config.ts). */
export const isBlochL2 = (entry: object): entry is BlochL2Entry =>
  'kind' in entry && entry.kind === 'bloch-l2';
