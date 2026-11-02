// Whether bUSDC can leave to Ethereum right now, read from the bridge itself
// (agent 139 finding 1). The DEX contracts cannot see it: a forged mint that
// credits on the L2 makes the Ethereum vault (ProvenanceSourceVault, mode 1)
// refuse every burn made from then on, including bUSDC an LP takes out of a
// pool; a guardian pause stops releases for its term. Same reads as the bridge
// page (BridgedStablecoinV3 mintHead/mintCount against the vault's
// chainHeadAt) and the reservas monitor's `held` status. Read-only, no key.
import { keccak256, parseAbi, type Abi, type Address, type Hex } from 'viem';
import { readCall, type BlockTag, type Rpc } from '../devnet4/chain';

export const HOLD_TOKEN_ABI = parseAbi([
  'function mintCount() view returns (uint64)',
  'function mintHead() view returns (bytes32)',
]);
export const HOLD_VAULT_ABI = parseAbi([
  'function provenanceMode() view returns (uint8)',
  'function depositCount() view returns (uint64)',
  'function chainHeadAt(uint64) view returns (bytes32)',
  'function paused() view returns (bool)',
  'function pausedUntil() view returns (uint64)',
  'function releasesEnabled() view returns (bool)',
]);

export type BridgeStatusConfig = {
  /** Ethereum RPC the page reads the vault from (a CSP connect-src origin). */
  ethRpcUrl: string;
  vault: Address;
  /** The bUSDC token on the L2; must be a token of the DEX deployment. */
  token: Address;
  /** Optional keccak of the vault's runtime code, checked at the finalized Ethereum block. */
  vaultCodeHash: Hex | null;
};

export type BridgeHold =
  | { state: 'unchecked'; reason: string }
  | { state: 'unknown'; reason: string }
  | { state: 'normal'; checkedAt: { eth: bigint; l2: Hex } }
  | {
      state: 'held';
      /** Final: both sides at finality. Not final: only the latest blocks differ yet. */
      final: boolean;
      mintCount: bigint;
      depositCount: bigint;
      paused: boolean;
    }
  | { state: 'paused'; pausedUntil: bigint | null; releasesEnabled: boolean };

async function finalizedEth(rpc: Rpc): Promise<{ number: bigint; hash: Hex }> {
  const b = (await rpc('eth_getBlockByNumber', ['finalized', false])) as {
    number?: Hex;
    hash?: Hex;
  } | null;
  if (!b || !b.hash || !b.number) throw new Error('Ethereum has no finalized block');
  return { number: BigInt(b.number), hash: b.hash };
}

async function side(eth: Rpc, l2: Rpc, c: BridgeStatusConfig, ethAt: BlockTag, l2At: BlockTag) {
  const t = <T>(fn: string, args: unknown[] = []) =>
    readCall<T>(l2, HOLD_TOKEN_ABI as Abi, c.token, fn, args, l2At);
  const v = <T>(fn: string, args: unknown[] = []) =>
    readCall<T>(eth, HOLD_VAULT_ABI as Abi, c.vault, fn, args, ethAt);
  const [mintCount, mintHead, depositCount, mode] = await Promise.all([
    t<bigint>('mintCount'),
    t<Hex>('mintHead'),
    v<bigint>('depositCount'),
    v<number>('provenanceMode'),
  ]);
  if (Number(mode) !== 1) throw new Error('the vault is not in mint-chain mode');
  // Honest mints follow deposits: a token ahead of the vault is a lagging view at
  // finality, and a mint with no deposit at all at latest.
  const vaultHead =
    mintCount > depositCount ? null : (await v<Hex>('chainHeadAt', [mintCount])).toLowerCase();
  return {
    mintCount,
    depositCount,
    clean: vaultHead === null ? null : vaultHead === mintHead.toLowerCase(),
  };
}

/**
 * Hold status of bUSDC exits. `l2Final` is the DEX snapshot's finalized L2 block.
 * Any read failure is `unknown`: never reported as normal.
 */
export async function readBridgeHold(
  eth: Rpc,
  l2: Rpc,
  c: BridgeStatusConfig | null,
  l2Final: Hex,
): Promise<BridgeHold> {
  if (!c) return { state: 'unchecked', reason: 'no bridge status source is configured' };
  try {
    const ethFinal = await finalizedEth(eth);
    if (c.vaultCodeHash) {
      const code = (await eth('eth_getCode', [c.vault, { blockHash: ethFinal.hash }])) as Hex;
      if (keccak256(code) !== c.vaultCodeHash)
        throw new Error('the vault code is not the reviewed one');
    }
    const [final, latest] = await Promise.all([
      side(eth, l2, c, { blockHash: ethFinal.hash }, { blockHash: l2Final }),
      side(eth, l2, c, 'latest', 'latest'),
    ]);
    const v = <T>(fn: string) => readCall<T>(eth, HOLD_VAULT_ABI as Abi, c.vault, fn, [], 'latest');
    const [paused, pausedUntil, releasesEnabled] = await Promise.all([
      v<boolean>('paused'),
      v<bigint>('pausedUntil'),
      v<boolean>('releasesEnabled'),
    ]);
    // A finalized credit beyond every deposit the vault has even at latest has no deposit at all.
    const heldFinal =
      final.clean === false || (final.clean === null && final.mintCount > latest.depositCount);
    const heldLatest = latest.clean !== true;
    if (heldFinal || heldLatest)
      return {
        state: 'held',
        final: heldFinal,
        mintCount: (heldFinal ? final : latest).mintCount,
        depositCount: (heldFinal ? final : latest).depositCount,
        paused,
      };
    if (paused || !releasesEnabled)
      return { state: 'paused', pausedUntil: paused ? pausedUntil : null, releasesEnabled };
    return { state: 'normal', checkedAt: { eth: ethFinal.number, l2: l2Final } };
  } catch (error) {
    return {
      state: 'unknown',
      reason: error instanceof Error ? error.message : 'the bridge could not be read',
    };
  }
}

/** True when bUSDC bought or withdrawn now may not reach Ethereum soon. */
export const exitsBlocked = (h: BridgeHold | null) => h?.state === 'held' || h?.state === 'paused';
