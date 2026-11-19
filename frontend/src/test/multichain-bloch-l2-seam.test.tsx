// One route component, two sites (agent 415, round 20): the Bloch L2 route of the multichain site "Bloch DEX" must
// mount MainnetLive with what the Bloch L2 site's own #/mainnet passes it, and with nothing a public chain gets.
// MainnetLive is replaced here by a recorder of its props; both applications are rendered from the committed files.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { MultichainApplication } from '../MultichainApp';
import type { Rpc } from '../devnet4/chain';
import type { MainnetNetwork, MainnetState } from '../mainnet/config';
import { BLOCH_L2_WORDING, setWording, wording } from '../mainnet/wording';
import { DEPOSIT_ONLY_REASON } from '../multichain/bloch-l2';

type Props = {
  network: MainnetNetwork;
  load: () => Promise<MainnetState>;
  rpc: Rpc;
  planned: unknown;
  [name: string]: unknown;
};
const mounts = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock('../MainnetLive', () => ({
  default: (props: Record<string, unknown>) => {
    mounts.push(props);
    return <div data-testid="route" />;
  },
}));

afterEach(() => {
  cleanup();
  mounts.length = 0;
  setWording({ ...BLOCH_L2_WORDING });
  vi.unstubAllGlobals();
});
const defined = (props: Record<string, unknown>) =>
  Object.keys(props)
    .filter((key) => props[key] !== undefined)
    .sort();
/** What one call of a reader sends: the URL and the request body. */
async function sent(rpc: Rpc) {
  const seen: { url: string; body: unknown }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0xab162' }));
  });
  expect(await rpc('eth_getBlockByNumber', ['finalized', false])).toBe('0xab162');
  vi.unstubAllGlobals();
  return seen;
}

describe('the Bloch L2 route on the two sites', () => {
  it('is mounted with the same network, record state, reader and planned caps, and with none of a public chain’s props', async () => {
    history.replaceState(null, '', '/#/mainnet');
    render(<App />);
    await screen.findByTestId('route');
    const own = mounts.at(-1) as Props;
    expect(document.title).toBe('PosternDEX — Bloch L2 mainnet');
    cleanup();
    mounts.length = 0;

    history.replaceState(null, '', '/#/bloch-l2');
    render(<MultichainApplication />);
    await screen.findByTestId('route');
    const here = mounts.at(-1) as Props;
    expect(document.title).toBe('Bloch DEX — Bloch L2');

    // The same props, by name: the route's five that carry a value, and no other.
    expect(defined(own)).toEqual(['load', 'network', 'planned', 'rpc', 'wallet']);
    expect(defined(here)).toEqual(defined(own));
    // Exactly (review R416-6): the L2 site's mount NAMES a sixth prop, `ethRpc` (the bridge-hold reader), and
    // passes `undefined` for it because the committed network file has no bridge status block; this site's mount
    // does not name it. With a status block the route builds that reader itself from the same field when none is
    // passed (MainnetLive), so the two are equal in effect: multichain-bloch-l2-live.test.tsx reads a hold through
    // this site's shell at the status block's endpoint.
    expect(Object.keys(own).sort()).toEqual([
      'ethRpc',
      'load',
      'network',
      'planned',
      'rpc',
      'wallet',
    ]);
    expect(own.ethRpc).toBeUndefined();
    expect(Object.keys(here).sort()).toEqual(['load', 'network', 'planned', 'rpc', 'wallet']);
    expect(own.network.bridges.map((b) => b.status)).toEqual([null]);
    for (const publicOnly of [
      'confirmation',
      'receiptPollMs',
      'snapshotMaxAgeMs',
      'screens',
      'now',
    ])
      expect([own[publicOnly], here[publicOnly]]).toEqual([undefined, undefined]);
    // The same values: the L2 network file as parsed by the L2 site's parser, and the planned caps.
    expect(here.network).toEqual(own.network);
    expect(here.planned).toEqual(own.planned);
    expect(here.network.chainId).toBe(700770);
    // The same record state; this site says first why (the phase file), then exactly the L2 site's reasons.
    const [ownState, hereState] = [await own.load(), await here.load()];
    if (ownState.status !== 'not-live' || hereState.status !== 'not-live')
      throw new Error('the committed record is not live');
    expect(hereState.reasons).toEqual([DEPOSIT_ONLY_REASON, ...ownState.reasons]);
    // The same reader: one request, to the one endpoint of the network file, with the same body.
    const [ownSent, hereSent] = [await sent(own.rpc), await sent(here.rpc)];
    expect(hereSent).toEqual(ownSent);
    expect(ownSent).toHaveLength(1);
    expect(ownSent[0].url).toBe(own.network.rpcUrl);
    // The words: the L2's own, but for the heading and the subject of a failed read.
    expect({ ...wording, title: BLOCH_L2_WORDING.title, reads: BLOCH_L2_WORDING.reads }).toEqual(
      BLOCH_L2_WORDING,
    );
    expect(wording.title).toBe('Bloch DEX on Bloch L2');
  });

  it('a public chain of the same site does get the public props: the comparison above is not blind to them', async () => {
    history.replaceState(null, '', '/#/base');
    render(<MultichainApplication />);
    await screen.findByTestId('route');
    const base = mounts.at(-1) as Props;
    expect(defined(base)).toEqual([
      'confirmation',
      'load',
      'network',
      'planned',
      'receiptPollMs',
      'rpc',
      'screens',
      'snapshotMaxAgeMs',
      'wallet',
    ]);
    expect(base.network.chainId).toBe(8453);
    expect(base.network.noIdleHeartbeat).toBe(true);
    expect(base.network.newSlotFee.enabled).toBe(false);
  });
});
