import { describe, expect, it } from 'vitest';
import networks from '../../../deployments/networks.json';
import {
  DEX_MAINNET_CHAIN_ID,
  DEX_STAGING_CAIP_CHAIN,
  DEX_STAGING_CHAIN_HEX,
  DEX_STAGING_CHAIN_ID,
} from '../network-identity';

describe('network identity', () => {
  it('reads chain IDs from the shared deployments/networks.json', () => {
    expect(DEX_MAINNET_CHAIN_ID).toBe(networks.mainnet.chainId);
    expect(DEX_MAINNET_CHAIN_ID).toBe(700770);
    expect(DEX_STAGING_CHAIN_ID).toBe(700771);
    expect(DEX_STAGING_CAIP_CHAIN).toBe('eip155:700771');
    expect(DEX_STAGING_CHAIN_HEX).toBe('0xab163');
  });
});
