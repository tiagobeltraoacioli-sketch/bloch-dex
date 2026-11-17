// Reads of the SOURCE networks, at their own finality rule, straight from the endpoints the route lists
// (page.json `read.urls`): Ethereum-style JSON-RPC, the TRON HTTP API's solidified views, Solana JSON-RPC at
// `finalized`, an Esplora-style Bitcoin API, Horizon for a Stellar account. No backend of ours is involved and no
// answer is trusted beyond what it says about the chain; when the route lists two or more endpoints a fact that
// decides "paid" must be the same on all of them.
//
// What is NOT read here (stated on the page where it matters): the Stellar vault's burn_status (a Soroban contract
// read needs a transaction envelope this page does not build), and the Bitcoin vault's marker (which burn a vault
// transaction pays or sets aside); see `stellarExit` and `bitcoinExit`.
import { decodeFunctionResult, parseAbi, type Address, type Hex } from 'viem';
import { ERC20_ABI, httpRpc, readCall, type Rpc } from '../devnet4/chain';
import { agreeingRpc } from '../multichain/rpc';
import type { LiveRoute } from './config';
import { base58Encode, concat, fromHex, segwitV0Encode, sha256Bytes, tronAddress20, tronAddressText, type Bytes } from './codec';
import type { BurnObservation } from './l2';
import { associatedTokenAddress, parseReleaseRecord, parseVaultState, paidBit, pubkey, SYSTEM_PROGRAM, vaultAddresses } from './solana';
import type { SourceDeposit, SourceExit } from './status';
import { trustlineState } from './stellar';

export const VAULT_ABI = parseAbi([
  'function releasedBurn(bytes32) view returns (bool)',
  'function paused() view returns (bool)',
  'function pausedUntil() view returns (uint64)',
  'function releasesEnabled() view returns (bool)',
  'function depositsEnabled() view returns (bool)',
  'function availableToRelease() view returns (uint256)',
  'function totalLocked() view returns (uint64)',
  'function cap() view returns (uint64)',
  'function deposit(uint64 amount, bytes32 l2Recipient) returns (bytes32 id)',
  'event Deposited(bytes32 indexed id, bytes32 indexed route, uint64 nonce, address sender, uint64 amount, bytes32 pqRecipientHash)',
]);

export type Fetch = typeof fetch;
const TIMEOUT = 20_000;
class ReadError extends Error {}
const refuse: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new ReadError(message);
};

async function getJson(fetchImpl: Fetch, url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
  if (response.status === 404) return null;
  refuse(response.ok, `the endpoint answered HTTP ${response.status}`);
  return response.json();
}
const join = (base: string, path: string) => `${base.replace(/\/+$/, '')}${path}`;

/** Every endpoint must give the same answer (compared as JSON); with one endpoint, that one. */
async function agreed<T>(urls: string[], read: (url: string) => Promise<T>): Promise<T> {
  const answers = await Promise.all(urls.map(read));
  const text = (v: T) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? `${x}n` : x));
  refuse(answers.every((a) => text(a) === text(answers[0])), 'the endpoints of this network disagree; nothing is concluded from them');
  return answers[0];
}

const unread = (route: LiveRoute, error: unknown): SourceExit => ({
  kind: 'unread',
  reason: `${route.name} could not be read just now (${error instanceof ReadError ? error.message : 'the endpoint did not answer'}).`,
});

// ── Ethereum-style vaults ────────────────────────────────────────────────────
/**
 * The RPC of an EVM source network for everything a deposit decides on or signs (review finding R364-6): the DEX's
 * two-endpoint agreement (multichain/rpc.ts `agreeingRpc`): a tag resolves to one block two endpoints report with the
 * same hash, and every state read at that hash must be the same on both. One endpoint is accepted only when every
 * listed endpoint is loopback (a rehearsal bundle; config.ts admits loopback in local render builds only).
 */
// A loopback-only route exists only in a local render build (config.ts); production bundles drop this test entirely.
const rehearsalOnly = (route: LiveRoute) => (__POSTERN_LOCAL_RENDER__ ? route.read.urls.every((u) => u.startsWith('http://127.0.0.1')) : false);
export function evmSourceRpc(route: LiveRoute, fetchImpl: Fetch = fetch): Rpc {
  const loopback = rehearsalOnly(route);
  refuse(route.read.urls.length >= 2 || loopback, `${route.name}: a deposit needs two independent endpoints of the network, and this route lists one. Nothing is read or sent.`);
  return agreeingRpc(route.read.urls.map((u) => httpRpc(u, fetchImpl)));
}

export type EvmDepositState = { block: Hex; allowance: bigint; balance: bigint; room: bigint; open: boolean };
/** Allowance, balance, cap room and whether deposits are open, at one block two endpoints agree on. */
export async function readEvmDepositState(route: LiveRoute, account: Address, fetchImpl: Fetch = fetch): Promise<EvmDepositState> {
  const source = evmSourceRpc(route, fetchImpl);
  const vault = route.custody.address as Address;
  const token = route.asset.id as Address;
  refuse(BigInt((await source('eth_chainId', [])) as string) === BigInt(route.chainId), `The endpoint is not ${route.name}.`);
  const block = (await source('eth_getBlockByNumber', ['latest', false])) as { hash?: unknown } | null;
  refuse(typeof block?.hash === 'string' && /^0x[0-9a-f]{64}$/.test(block.hash), 'the endpoints report no common head block');
  const at = { blockHash: block.hash as Hex };
  const [allowance, balance, locked, cap, enabled, paused] = await Promise.all([
    readCall<bigint>(source, ERC20_ABI, token, 'allowance', [account, vault], at),
    readCall<bigint>(source, ERC20_ABI, token, 'balanceOf', [account], at),
    readCall<bigint>(source, VAULT_ABI, vault, 'totalLocked', [], at),
    readCall<bigint>(source, VAULT_ABI, vault, 'cap', [], at),
    readCall<boolean>(source, VAULT_ABI, vault, 'depositsEnabled', [], at),
    readCall<boolean>(source, VAULT_ABI, vault, 'paused', [], at),
  ]);
  return { block: at.blockHash, allowance, balance, room: BigInt(cap) - BigInt(locked), open: enabled && !paused };
}

/**
 * The gas limit the page names for a source-network call: the HIGHER of the first two endpoints' estimates (both must
 * answer), plus a third, inside fixed bounds. A low estimate from one endpoint can no longer make the deposit run out
 * of gas; a high one is bounded. (agreeingRpc leaves estimates to one endpoint, so they are asked here separately.)
 */
export async function evmSourceGas(route: LiveRoute, from: Address, call: { to: Address; data: Hex }, fetchImpl: Fetch = fetch): Promise<bigint> {
  const loopback = rehearsalOnly(route);
  refuse(route.read.urls.length >= 2 || loopback, `${route.name}: a deposit needs two independent endpoints of the network, and this route lists one. Nothing is sent.`);
  const estimates = await Promise.all(
    route.read.urls.slice(0, 2).map(async (u) => {
      const value = await httpRpc(u, fetchImpl)('eth_estimateGas', [{ from, ...call }, 'latest']);
      refuse(typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value), 'an endpoint answered the gas estimate in a form this page cannot read');
      const gas = BigInt(value);
      refuse(gas >= 21_000n && gas <= 3_000_000n, 'a gas estimate is outside what this page sends');
      return gas;
    }),
  );
  const high = estimates.reduce((a, b) => (a > b ? a : b));
  return (high * 4n) / 3n;
}

async function finalizedHash(rpc: Rpc): Promise<Hex> {
  const block = (await rpc('eth_getBlockByNumber', ['finalized', false])) as { hash?: unknown } | null;
  refuse(typeof block?.hash === 'string' && /^0x[0-9a-f]{64}$/.test(block.hash), 'the endpoint reports no finalized block');
  return block.hash as Hex;
}

export async function evmVaultExit(route: LiveRoute, burn: BurnObservation, fetchImpl: Fetch = fetch): Promise<SourceExit> {
  try {
    const vault = route.custody.address as Address;
    return await agreed(route.read.urls, async (url) => {
      const rpc = httpRpc(url, fetchImpl);
      refuse(BigInt((await rpc('eth_chainId', [])) as string) === BigInt(route.chainId), 'the endpoint is another chain');
      const at = { blockHash: await finalizedHash(rpc) };
      const read = <T>(fn: string, args: unknown[] = []) => readCall<T>(rpc, VAULT_ABI, vault, fn, args, at);
      const [released, pausedUntil, releasesEnabled, available] = await Promise.all([
        read<boolean>('releasedBurn', [burn.burnId]),
        read<bigint>('pausedUntil'),
        read<boolean>('releasesEnabled'),
        read<bigint>('availableToRelease'),
      ]);
      // Only what decides the state is compared between endpoints; the bucket level moves with every block.
      return { kind: 'vault' as const, released, queuedUntil: null, pausedUntil: BigInt(pausedUntil), releasesEnabled, available: released ? 0n : available >= burn.amount ? burn.amount : available };
    });
  } catch (error) {
    return unread(route, error);
  }
}

/** A deposit transaction on an EVM source network: its Deposited log, and whether its block is finalized. */
export async function evmDeposit(route: LiveRoute, txHash: Hex, fetchImpl: Fetch = fetch): Promise<SourceDeposit & { depositId?: Hex }> {
  const rpc = httpRpc(route.read.urls[0], fetchImpl);
  const receipt = (await rpc('eth_getTransactionReceipt', [txHash])) as { status?: string; blockNumber?: string; blockHash?: string; logs?: { address: string; topics: Hex[] }[] } | null;
  if (!receipt || receipt.status !== '0x1' || !receipt.blockNumber) return { seen: false };
  const vault = (route.custody.address as string).toLowerCase();
  const log = (receipt.logs ?? []).find((l) => l.address.toLowerCase() === vault && l.topics.length === 3);
  if (!log) return { seen: false };
  const finalized = (await rpc('eth_getBlockByNumber', ['finalized', false])) as { number?: string } | null;
  const canonical = (await rpc('eth_getBlockByNumber', [receipt.blockNumber, false])) as { hash?: string } | null;
  const final = !!finalized?.number && BigInt(finalized.number) >= BigInt(receipt.blockNumber) && canonical?.hash === receipt.blockHash;
  return { seen: true, final, depositId: log.topics[1] };
}

// ── TRON ─────────────────────────────────────────────────────────────────────
/** A constant call answered from the SOLIDIFIED state (`/walletsolidity`), never the head. */
async function tronView(fetchImpl: Fetch, url: string, contract: string, signature: string, parameter: string): Promise<Hex> {
  const body = (await getJson(fetchImpl, join(url, '/walletsolidity/triggerconstantcontract'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ owner_address: contract, contract_address: contract, function_selector: signature, parameter, visible: true }),
  })) as { result?: { result?: boolean }; constant_result?: string[] } | null;
  refuse(body?.result?.result === true && Array.isArray(body.constant_result) && /^[0-9a-f]+$/i.test(body.constant_result[0] ?? ''), 'the TRON endpoint did not answer the solidified read');
  return `0x${body.constant_result[0]}`;
}

export async function tronVaultExit(route: LiveRoute, burn: BurnObservation, fetchImpl: Fetch = fetch): Promise<SourceExit> {
  try {
    const vault20 = tronAddress20(route.custody.address);
    refuse(vault20.ok, 'the vault address is not a TRON address');
    const vault = tronAddressText(vault20.address20);
    return await agreed(route.read.urls, async (url) => {
      const view = async <T>(functionName: string, signature: string, parameter = ''): Promise<T> =>
        decodeFunctionResult({ abi: VAULT_ABI, functionName, data: await tronView(fetchImpl, url, vault, signature, parameter) } as never) as T;
      const released = await view<boolean>('releasedBurn', 'releasedBurn(bytes32)', burn.burnId.slice(2));
      const pausedUntil = await view<bigint>('pausedUntil', 'pausedUntil()');
      const releasesEnabled = await view<boolean>('releasesEnabled', 'releasesEnabled()');
      const available = await view<bigint>('availableToRelease', 'availableToRelease()');
      return { kind: 'vault' as const, released, queuedUntil: null, pausedUntil: BigInt(pausedUntil), releasesEnabled, available: released ? 0n : available >= burn.amount ? burn.amount : available };
    });
  } catch (error) {
    return unread(route, error);
  }
}

// ── Solana ───────────────────────────────────────────────────────────────────
type SolanaAccount = { owner: string; data: Bytes; lamports: number } | null;
async function solanaAccount(fetchImpl: Fetch, url: string, address: string): Promise<SolanaAccount> {
  const rpc = httpRpc(url, fetchImpl);
  const answer = (await rpc('getAccountInfo', [address, { commitment: 'finalized', encoding: 'base64' }])) as { value?: { owner?: unknown; data?: unknown; lamports?: unknown } | null } | null;
  refuse(answer && 'value' in answer, 'the Solana endpoint did not answer the account read');
  if (answer.value === null || answer.value === undefined) return null;
  const { owner, data, lamports } = answer.value;
  refuse(typeof owner === 'string' && Array.isArray(data) && data[1] === 'base64' && typeof data[0] === 'string', 'the Solana endpoint answered in another encoding');
  return { owner, data: Uint8Array.from(atob(data[0]), (c) => c.charCodeAt(0)), lamports: Number(lamports) };
}

/** What the signers read before certifying an exit: the destination address at `finalized`. */
export async function solanaDestination(route: LiveRoute, wallet: string, fetchImpl: Fetch = fetch): Promise<{ destination: 'absent' | 'system' | 'not-a-wallet'; tokenAccount: boolean }> {
  return agreed(route.read.urls, async (url) => {
    const account = await solanaAccount(fetchImpl, url, wallet);
    const destination = account === null ? ('absent' as const) : account.owner === SYSTEM_PROGRAM && account.data.length === 0 ? ('system' as const) : ('not-a-wallet' as const);
    const ata = base58Encode(associatedTokenAddress(pubkey(wallet), pubkey(route.asset.id)));
    return { destination, tokenAccount: (await solanaAccount(fetchImpl, url, ata)) !== null };
  });
}

export async function solanaExit(route: LiveRoute, burn: BurnObservation, fetchImpl: Fetch = fetch): Promise<SourceExit> {
  try {
    const a = vaultAddresses(route);
    const program = base58Encode(a.program);
    return await agreed(route.read.urls, async (url) => {
      const owned = async (address: Bytes) => {
        const account = await solanaAccount(fetchImpl, url, base58Encode(address));
        if (account) refuse(account.owner === program, 'an account of the vault is owned by another program');
        return account?.data ?? null;
      };
      const state = await owned(a.vault);
      refuse(state, 'the vault account does not exist on this endpoint');
      const vault = parseVaultState(state);
      const record = parseReleaseRecord(await owned(a.releaseRecord(burn.burnNonce)), a.vault);
      if (record) refuse(record.burnNonce === burn.burnNonce && record.nativeBurnId === burn.burnId, 'the release record names another burn');
      const paid = record ? false : paidBit(await owned(a.paidPage(burn.burnNonce)), a.vault, burn.burnNonce);
      const dest = await solanaDestination({ ...route, read: { urls: [url] } } as LiveRoute, burn.recipient, fetchImpl);
      return { kind: 'solana' as const, record, paidBit: paid, pausedUntil: vault.pausedUntil, voidThroughSeq: vault.voidThroughSeq, bucket: record && vault.releaseBucket >= record.amount ? record.amount : vault.releaseBucket, ...dest };
    });
  } catch (error) {
    return unread(route, error);
  }
}

/** The vault's deposit count at `finalized`, for the deposit instruction's record addresses. */
export async function solanaDepositCount(route: LiveRoute, fetchImpl: Fetch = fetch): Promise<bigint> {
  const a = vaultAddresses(route);
  return agreed(route.read.urls, async (url) => {
    const state = await solanaAccount(fetchImpl, url, base58Encode(a.vault));
    refuse(state && state.owner === base58Encode(a.program), 'the vault account does not exist on this endpoint');
    const vault = parseVaultState(state.data);
    refuse(vault.depositsEnabled, 'deposits are switched off on the vault');
    return vault.depositCount;
  });
}

// ── Stellar ──────────────────────────────────────────────────────────────────
/** A G… account on Horizon: whether it exists and trusts the route's asset. C… contracts need no trustline. */
export async function stellarTrustline(route: LiveRoute, address: string, fetchImpl: Fetch = fetch): Promise<'trusted' | 'no-trustline' | 'unauthorized' | 'no-account' | 'contract'> {
  if (address.startsWith('C')) return 'contract';
  const [code, issuer] = route.asset.id.split(' ')[0].split(':');
  refuse(code && /^G[A-Z2-7]{55}$/.test(issuer ?? ''), 'the route does not name the asset as CODE:ISSUER');
  return agreed(route.read.urls, async (url) => {
    const account = await getJson(fetchImpl, join(url, `/accounts/${address}`));
    return account === null ? ('no-account' as const) : trustlineState(account, code, issuer);
  });
}

export async function stellarExit(route: LiveRoute, burn: BurnObservation, fetchImpl: Fetch = fetch): Promise<SourceExit> {
  // The vault's burn_status(nonce, burnId) is a Soroban contract read; this page does not build the envelope for it
  // (interface gap, cross-area log). What it can read is the recipient's account.
  let trust = '';
  try {
    const line = await stellarTrustline(route, burn.recipient, fetchImpl);
    trust =
      line === 'no-account'
        ? ` The account ${burn.recipient} does not exist on Stellar yet: fund it and add the USDC trustline, or the payment cannot be made.`
        : line === 'no-trustline'
          ? ` The account ${burn.recipient} holds no USDC trustline: add it, or the payment stays unpaid.`
          : line === 'unauthorized'
            ? ' The issuer has revoked this account\'s USDC authorization.'
            : ' The recipient account exists and can receive USDC.';
  } catch {
    trust = '';
  }
  return { kind: 'unread', reason: `This page cannot read the Stellar vault's own record of an exit yet (queued, voided by a pause, paid).${trust}` };
}

// ── Bitcoin ──────────────────────────────────────────────────────────────────
/** The vault's thread address: P2WSH of the committee's k-of-n multisig script (btc_policy.Vault.thread_spk). */
export function bitcoinThreadAddress(route: LiveRoute): string {
  const script = route.bitcoin!.script!;
  const keys = script.publicKeys.map(fromHex);
  const multisig = concat(Uint8Array.of(0x50 + script.threshold), ...keys.map((k) => concat(Uint8Array.of(0x21), k)), Uint8Array.of(0x50 + keys.length, 0xae));
  return segwitV0Encode(script.hrp, sha256Bytes(multisig));
}

type EsploraTx = { txid?: unknown; status?: { confirmed?: unknown; block_height?: unknown }; vin?: { prevout?: { scriptpubkey_address?: unknown } }[]; vout?: { scriptpubkey_address?: unknown; value?: unknown }[] };

/**
 * A payment to the exit's address by a transaction that spends the vault thread, for an amount the burn can pay
 * (between the least and the most the vault's rule allows). The page does not parse the vault's marker, so two
 * exits of similar size to one address cannot be told apart, and "set aside" cannot be read: `setAside` is null.
 */
export async function bitcoinExit(route: LiveRoute, burn: BurnObservation, claimed: boolean, fetchImpl: Fetch = fetch): Promise<SourceExit> {
  try {
    const thread = bitcoinThreadAddress(route);
    const gross = burn.amount * route.asset.unitsPerCustodyUnit;
    return await agreed(route.read.urls, async (url) => {
      const txs = (await getJson(fetchImpl, join(url, `/address/${burn.recipient}/txs`))) as EsploraTx[] | null;
      refuse(Array.isArray(txs), 'the Bitcoin endpoint did not list the address');
      const tip = Number(await getJson(fetchImpl, join(url, '/blocks/tip/height')));
      refuse(Number.isSafeInteger(tip), 'the Bitcoin endpoint did not report its tip');
      let payment: { txid: string; confirmations: number; sats: bigint } | null = null;
      for (const tx of txs) {
        if (typeof tx.txid !== 'string' || tx.status?.confirmed !== true || !Number.isSafeInteger(tx.status.block_height)) continue;
        if (!(tx.vin ?? []).some((i) => i.prevout?.scriptpubkey_address === thread)) continue;
        const out = (tx.vout ?? []).find((o) => o.scriptpubkey_address === burn.recipient && typeof o.value === 'number' && BigInt(o.value) <= gross && BigInt(o.value) > 0n);
        if (out) payment = { txid: tx.txid, confirmations: tip - (tx.status.block_height as number) + 1, sats: BigInt(out.value as number) };
      }
      const fees = (await getJson(fetchImpl, join(url, '/fee-estimates')).catch(() => null)) as Record<string, unknown> | null;
      const next = typeof fees?.['2'] === 'number' ? Math.ceil(fees['2'] as number) : null;
      return { kind: 'bitcoin' as const, payment, feeEstimate: payment ? null : next, setAside: null, claimed };
    });
  } catch (error) {
    return unread(route, error);
  }
}

/** The fee rate the next blocks ask for, to propose a ceiling with a margin; null when the endpoint gives none. */
export async function bitcoinFeeEstimate(route: LiveRoute, fetchImpl: Fetch = fetch): Promise<number | null> {
  try {
    const fees = (await getJson(fetchImpl, join(route.read.urls[0], '/fee-estimates'))) as Record<string, unknown> | null;
    return typeof fees?.['2'] === 'number' && fees['2'] > 0 ? Math.ceil(fees['2'] as number) : null;
  } catch {
    return null;
  }
}

/** Payments received at a deposit address (confirmed or not), for the deposit status. */
export async function bitcoinDeposits(route: LiveRoute, depositAddress: string, fetchImpl: Fetch = fetch): Promise<{ txid: string; vout: number; sats: bigint; confirmations: number; spent: boolean }[]> {
  const url = route.read.urls[0];
  const txs = (await getJson(fetchImpl, join(url, `/address/${depositAddress}/txs`))) as EsploraTx[] | null;
  refuse(Array.isArray(txs), 'the Bitcoin endpoint did not list the address');
  const tip = Number(await getJson(fetchImpl, join(url, '/blocks/tip/height')));
  const spentIn = new Set(txs.flatMap((tx) => ((tx.vin ?? []).some((i) => i.prevout?.scriptpubkey_address === depositAddress) ? [1] : [])));
  const out: { txid: string; vout: number; sats: bigint; confirmations: number; spent: boolean }[] = [];
  for (const tx of txs)
    (tx.vout ?? []).forEach((o, vout) => {
      if (o.scriptpubkey_address === depositAddress && typeof o.value === 'number' && typeof tx.txid === 'string')
        out.push({ txid: tx.txid, vout, sats: BigInt(o.value), confirmations: tx.status?.confirmed === true ? tip - Number(tx.status.block_height) + 1 : 0, spent: spentIn.size > 0 });
    });
  return out;
}

/** The source reading of one exit, by the route's network kind. */
export function readSourceExit(route: LiveRoute, burn: BurnObservation, fetchImpl: Fetch = fetch): Promise<SourceExit> {
  switch (route.kind) {
    case 'evm':
      return evmVaultExit(route, burn, fetchImpl);
    case 'tvm':
      return tronVaultExit(route, burn, fetchImpl);
    case 'svm':
      return solanaExit(route, burn, fetchImpl);
    case 'stellar':
      return stellarExit(route, burn, fetchImpl);
    case 'utxo':
      return bitcoinExit(route, burn, !!burn.claim, fetchImpl);
  }
}
