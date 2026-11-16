// Reads of a public chain through its reviewed endpoints: the first that answers. An endpoint that fails (network
// error, HTTP error, a JSON-RPC error that says the node cannot serve the request) is skipped for this request and
// the next is tried; an execution error (a revert) is the chain's answer and is returned as it is. Block 0, which
// identifies the chain, is not served by every public node (history pruning): `null` for it also moves on.
import { ChainError, httpRpc, type Rpc } from '../devnet4/chain';

/** JSON-RPC error codes that are the chain's own answer to a call, not an endpoint's failure. */
const EXECUTION_ERROR_CODES = new Set([3, -32015]);

export function fallbackRpc(endpoints: Rpc[]): Rpc {
  if (endpoints.length === 0) throw new Error('no RPC endpoint');
  return async (method, params) => {
    let last: unknown;
    for (const endpoint of endpoints) {
      try {
        const result = await endpoint(method, params);
        const wantsGenesis = method === 'eth_getBlockByNumber' && params[0] === '0x0';
        if (wantsGenesis && result === null) {
          last = new ChainError('chain: this endpoint does not serve block 0');
          continue;
        }
        return result;
      } catch (error) {
        if (error instanceof ChainError && error.code !== undefined) {
          if (EXECUTION_ERROR_CODES.has(error.code) || /execution reverted/i.test(error.message))
            throw error;
        }
        last = error;
      }
    }
    throw last;
  };
}

export const fallbackHttpRpc = (urls: string[]): Rpc =>
  fallbackRpc(urls.map((url) => httpRpc(url)));
