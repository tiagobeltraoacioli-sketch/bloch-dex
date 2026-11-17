// Review r17 (agent 328): R309-MC-6 at 0566af3. Every bundled chain gives the route a 20-minute default deadline.
import { expect, it } from 'vitest';
import { bundledChains } from '../../multichain/config';

it('R309-MC-6: the six bundled chains carry a default swap deadline of 20 minutes', () => {
  const chains = bundledChains();
  expect(chains.map((c) => c.key)).toHaveLength(6);
  for (const chain of chains) expect(chain.network.defaultDeadlineMinutes).toBe(20);
});
