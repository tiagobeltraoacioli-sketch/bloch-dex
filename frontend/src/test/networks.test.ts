import { describe, expect, it } from 'vitest';
import { networkEntries, PLANNED_NETWORKS } from '../shell/networks';

describe('network switcher entries', () => {
  it('lists every planned network and makes only the published ones selectable', () => {
    const entries = networkEntries([
      {
        key: 'bloch-l2',
        name: 'Bloch L2',
        chainId: 700770,
        href: '#/mainnet',
        status: 'Not yet live',
      },
      { key: 'preview', name: 'Preview', href: '#/trade', status: 'Sample data, no network' },
    ]);
    expect(entries.map((e) => e.key)).toEqual([...PLANNED_NETWORKS.map((p) => p.key), 'preview']);
    expect(entries.filter((e) => e.state === 'available').map((e) => e.key)).toEqual([
      'bloch-l2',
      'preview',
    ]);
    for (const e of entries.filter((x) => x.state === 'unavailable')) {
      expect(e.href).toBeUndefined();
      expect(e.status).toBe('No deployment published');
    }
  });
  it('takes name, chain ID, route and status of a published network from the caller', () => {
    const [, ethereum] = networkEntries([
      {
        key: 'ethereum',
        name: 'Ethereum',
        chainId: 1,
        href: './multichain.html#/ethereum',
        status: 'Live',
      },
    ]);
    expect(ethereum).toMatchObject({
      href: './multichain.html#/ethereum',
      status: 'Live',
      state: 'available',
      glyph: 'E',
    });
  });
});
