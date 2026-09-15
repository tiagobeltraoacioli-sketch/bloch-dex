import { validChain, type Provider } from './wallet';

// Network identity only. No router, token or deployment is inferred from a chain ID.
export const EVM_NETWORKS = Object.freeze([
  Object.freeze({ chainId: '0x1', name: 'Ethereum' }),
  Object.freeze({ chainId: '0xa4b1', name: 'Arbitrum One' }),
  Object.freeze({ chainId: '0x2105', name: 'Base' }),
]);

export function evmNetwork(chainId: unknown) {
  if (!validChain(chainId)) return undefined;
  return EVM_NETWORKS.find((network) => BigInt(network.chainId) === BigInt(chainId));
}

export async function switchEvmNetwork(provider: Provider, chainId: string): Promise<string> {
  const target = evmNetwork(chainId);
  if (!target) throw new Error('Unsupported network.');
  await provider.request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: target.chainId }],
  });
  const actual = await provider.request({ method: 'eth_chainId' });
  if (!validChain(actual) || BigInt(actual) !== BigInt(target.chainId)) {
    throw new Error('The wallet did not switch to the requested network.');
  }
  return target.chainId;
}

export function networkError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === 4001) return 'Network change declined.';
  if (code === 4902) return 'Add this network in your wallet, then try again.';
  if (code === -32002) return 'A wallet request is already open. Check your wallet.';
  return 'Could not verify the network change. Check your wallet and try again.';
}
