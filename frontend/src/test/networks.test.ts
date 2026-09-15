import { describe, it, expect, vi } from 'vitest';
import { EVM_NETWORKS, evmNetwork, switchEvmNetwork } from '../networks';
describe('EVM network selection', () => {
  it('recognizes only configured mainnets', () => {
    expect(evmNetwork('0x01')?.name).toBe('Ethereum');
    expect(evmNetwork('0xA4B1')?.name).toBe('Arbitrum One');
    expect(evmNetwork('0x2105')?.name).toBe('Base');
    for (const value of [null, '', '1', '0x0', '0x14a34'])
      expect(evmNetwork(value)).toBeUndefined();
  });
  for (const network of EVM_NETWORKS)
    it(`switches and verifies ${network.name}`, async () => {
      const request = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(network.chainId);
      expect(await switchEvmNetwork({ request }, network.chainId)).toBe(network.chainId);
      expect(request.mock.calls).toEqual([
        [{ method: 'wallet_switchEthereumChain', params: [{ chainId: network.chainId }] }],
        [{ method: 'eth_chainId' }],
      ]);
    });
  it('refuses unsupported targets before contacting wallet', async () => {
    const request = vi.fn();
    await expect(switchEvmNetwork({ request }, '0x99')).rejects.toThrow('Unsupported');
    expect(request).not.toHaveBeenCalled();
  });
  it('rejects a mismatched response', async () => {
    const request = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('0x1');
    await expect(switchEvmNetwork({ request }, '0x2105')).rejects.toThrow('did not switch');
  });
  it('does not automatically add unknown networks', async () => {
    const request = vi.fn().mockRejectedValue({ code: 4902 });
    await expect(switchEvmNetwork({ request }, '0x2105')).rejects.toEqual({ code: 4902 });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
