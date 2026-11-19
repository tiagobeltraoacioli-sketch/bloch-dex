// A live Bloch L2 for the tests of the multichain site's seventh network (agent 415, round 20): the L2 site's two
// files as its deployment procedure writes them (the devnet4 two-pair record re-targeted at chain 700770, exactly
// the fixture of mainnet.test.tsx), and a chain that answers the route's reads with caps on both pools.
import {
  decodeFunctionData,
  encodeFunctionResult,
  keccak256,
  sha256,
  stringToBytes,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { ERC20_ABI, LENS_ABI, PAIR_ABI, type Rpc } from '../devnet4/chain';
import { committedRecord, stableJson } from '../devnet4/record';
import { MULTICALL3_CODE_HASH, type MainnetState } from '../mainnet/config';
import { blochL2Entry, type BlochL2Entry } from '../multichain/bloch-l2';
import networkJson from '../../../deployments/mainnet/frontend.network.json';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
export const L2_RPC_URL = 'https://l2rpc.blochl1.com';
export const BUSDC = '0x1b7c0fb59f34683cd9214566636e63a0f7e092f6' as Address;
export const WGSMH = '0xb2b4952b6e57e589109af764859886e236798ad4' as Address;
export const WBLCH = '0x7f889d9cb335bbdb197b75c74a6409ac2bbbe6e6' as Address;
export const GSMH_PAIR = '0xd71fc81263ba585561ad4d784a4bc096739927b4' as Address;
export const USD_PAIR = '0xd98230d9a13cb72f6d75e3bf46c01415027c8033' as Address;
export const L2_NOW_MS = 1_792_200_000_000;
const FINALIZED = {
  number: '0x1b8',
  hash: `0x${'f'.repeat(64)}`,
  timestamp: '0x6ad2cd04', // one minute before L2_NOW_MS
  baseFeePerGas: '0x3b9aca00',
};
const MULTICALL = '0x00000000000000000000000000000000000c0de3' as Address;

/** The two files of a deployed L2: `frontend.network.json` (RPC live, genesis pinned) and the record. */
export function liveL2Files(): { network: Json; record: Json } {
  const r = structuredClone(committedRecord) as { plan: Json; config: Json; gateReport: Json };
  r.config.network = {
    ...r.config.network,
    name: 'bloch-l2-mainnet',
    chainId: 700770,
    rehearsal: false,
  };
  r.plan.chain = { ...r.plan.chain, id: 700770, rehearsal: false };
  r.plan.configSha256 = sha256(stringToBytes(stableJson(r.config)));
  r.gateReport.chainId = 700770;
  const genesisHash = r.plan.chain.genesisHash as string;
  return {
    network: {
      ...structuredClone(networkJson),
      genesisHash,
      rpc: { url: L2_RPC_URL, status: 'live' },
    },
    record: {
      schemaVersion: 1,
      domain: 'postern.dex.frontend-record.v1',
      status: 'liquidity-enabled',
      rehearsalChain: true, // the fixture's genesis is not the pinned one (R309-2P-12)
      ...r,
      infra: {
        domain: 'postern.dex.mainnet-infra-plan.v1',
        chain: { id: 700770, genesisHash, rehearsal: false },
        contracts: { multicall3: { address: MULTICALL, codeHash: MULTICALL3_CODE_HASH } },
      },
    },
  };
}

/**
 * The entry of a live L2 over a fake chain. The record is verified by the entry's own `load` (the L2 site's
 * `loadMainnetState`); only the runtime code hashes are then replaced by those of the fake chain's code, as
 * mainnet.test.tsx does, because no test chain holds the real bytecode.
 */
export async function liveL2Entry(): Promise<{
  entry: BlochL2Entry;
  rpc: Rpc;
  calls: { method: string; params: unknown[] }[];
}> {
  const files = liveL2Files();
  const real = blochL2Entry(files);
  const state = await real.load();
  if (state.status !== 'live') throw new Error('expected a live state');
  const fakeCode = new Map<string, Hex>();
  const codeHashes: Record<Address, Hex> = {};
  Object.keys(state.deployment.codeHashes).forEach((address, i) => {
    const code = `0x60${(i + 1).toString(16).padStart(2, '0')}` as Hex;
    fakeCode.set(address, code);
    codeHashes[address as Address] = keccak256(code);
  });
  // Balances are read call by call here (the fake chain has no Multicall3 code to execute).
  const live: MainnetState = { status: 'live', deployment: { ...state.deployment, codeHashes } };
  const calls: { method: string; params: unknown[] }[] = [];
  const tokens: Record<string, [number, string, bigint]> = {
    [WBLCH]: [18, 'WBLCH', 0n],
    [BUSDC]: [6, 'bUSDC', 25_000_000n],
    [WGSMH]: [8, 'wGSMH', 0n],
  };
  const reserves: Record<string, [bigint, bigint, number]> = {
    [GSMH_PAIR]: [130_852_828_000_503_020n, 38_295_768n, 1],
    [USD_PAIR]: [5_571_215n, 272_177_475_029_800_010n, 1],
  };
  const caps: Record<string, [bigint, bigint]> = {
    [GSMH_PAIR]: [10n ** 19n, 100_000_000n],
    [USD_PAIR]: [1_000_000_000n, 10n ** 19n],
  };
  const reply = (abi: Abi, functionName: string, result: unknown) =>
    encodeFunctionResult({ abi, functionName, result } as never);
  const rpc: Rpc = async (method, params) => {
    calls.push({ method, params });
    switch (method) {
      case 'eth_chainId':
        return '0xab162';
      case 'eth_getBlockByNumber':
        return params[0] === '0x0'
          ? { number: '0x0', hash: state.deployment.genesisHash }
          : params[0] === 'finalized' || params[0] === 'latest' || params[0] === FINALIZED.number
            ? FINALIZED
            : null;
      case 'eth_getCode':
        return fakeCode.get(String(params[0])) ?? '0x';
      case 'eth_getBalance':
        return '0xde0b6b3a7640000';
      case 'eth_getTransactionCount':
        return '0x0';
      case 'eth_call': {
        const { to, data } = params[0] as { to: Address; data: Hex };
        for (const abi of [ERC20_ABI, PAIR_ABI, LENS_ABI] as Abi[]) {
          let call;
          try {
            call = decodeFunctionData({ abi, data });
          } catch {
            continue;
          }
          const name = call.functionName;
          if (name === 'decimals') return reply(abi, name, tokens[to][0]);
          if (name === 'symbol') return reply(abi, name, tokens[to][1]);
          if (name === 'balanceOf') return reply(abi, name, tokens[to][2]);
          if (name === 'allowance') return reply(abi, name, 0n);
          if (name === 'getReserves') return reply(abi, name, reserves[to]);
          if (name === 'reserveCaps') return reply(abi, name, caps[to]);
          if (name === 'pendingExcess')
            return reply(abi, name, {
              excess0: 0n,
              excess1: 0n,
              blocksInflow0: false,
              blocksInflow1: false,
            });
          if (name === 'bestExactInput') {
            // Like BDexLens.sol: the minimum follows the requested tolerance.
            const [amountIn, routes, slippageBps] = call.args as [bigint, Address[][], bigint];
            const amountOut = 31_000_000n;
            const q = (route: Address[]) => ({
              available: true,
              blockNumber: params[1] === 'latest' ? 500n : 440n,
              timestamp: 0n,
              amountOut,
              minimumOut: (amountOut * (10_000n - slippageBps)) / 10_000n,
              amounts: route.map((_, i) => (i === 0 ? amountIn : amountOut)),
              executionLossBps: route.slice(1).map(() => 30n),
            });
            return reply(abi, name, [0n, routes.map(q)]);
          }
        }
        throw new Error(`unexpected call ${to} ${data.slice(0, 10)}`);
      }
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  return { entry: { ...real, load: () => Promise.resolve(live) }, rpc, calls };
}

/** `fetch` for the entry's own reader (`httpRpc`): JSON-RPC over the fake chain, with every URL it was asked at. */
export function fetchOver(rpc: Rpc): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    const body = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
      params: unknown[];
    };
    try {
      const result = await rpc(body.method, body.params);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200 });
    } catch (error) {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          error: { code: (error as { code?: number }).code ?? -32000, message: String(error) },
        }),
        { status: 200 },
      );
    }
  };
  return { fetch: impl as typeof fetch, urls };
}
