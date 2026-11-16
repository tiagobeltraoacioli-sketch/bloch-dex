import { describe, expect, it } from 'vitest';
import { CHAIN_INDEX, plannedFromIndex } from '../shell/chain-index';
import { networkEntries } from '../shell/networks';
import { bundledChains } from '../multichain/config';
import shared from '../../../deployments/multichain.json';

describe('network switcher and the per-chain files', () => {
  it('indexes every chain of deployments/multichain.json with the name and chain ID of its network file', () => {
    const chains = bundledChains();
    expect(CHAIN_INDEX.map((c) => c.key)).toEqual(shared.chains);
    for (const c of CHAIN_INDEX) {
      const chain = chains.find((x) => x.key === c.key)!;
      expect(c.name).toBe(chain.network.chainName);
      expect(c.chainId).toBe(chain.network.chainId);
    }
  });
  it('the Bloch L2 site lists them and cannot select them without a configured multichain address', () => {
    const entries = networkEntries(
      [
        {
          key: 'bloch-l2',
          name: 'Bloch L2',
          chainId: 700770,
          href: '#/mainnet',
          status: 'Not yet live',
        },
      ],
      [{ key: 'bloch-l2', name: 'Bloch L2', chainId: 700770 }, ...plannedFromIndex()],
    );
    expect(entries.map((e) => e.key)).toEqual(['bloch-l2', ...shared.chains]);
    for (const e of entries.slice(1)) {
      expect(e.state).toBe('unavailable');
      expect(e.href).toBeUndefined();
      expect(e.status).toMatch(/^(Not deployed yet|On the multichain site)$/);
    }
  });
  it('the multichain site lists exactly its bundled chains, all selectable', () => {
    const entries = networkEntries(
      bundledChains().map((c) => ({
        key: c.key,
        name: c.network.chainName,
        chainId: c.network.chainId,
        href: `#/${c.key}`,
        status: 'Not yet live',
      })),
      [],
    );
    expect(entries).toHaveLength(shared.chains.length);
    expect(entries.every((e) => e.state === 'available' && e.href === `#/${e.key}`)).toBe(true);
  });
});
