// The Bloch L2 (chain 700770) as the seventh network of the multichain site "Bloch DEX" (agent 415, round 20):
// where its configuration comes from, why its route is not live, what the route shows and asks while it is not
// live (nothing), the Content-Security-Policy, and the Bloch-words guard of every public-chain route.
// The live route is in multichain-bloch-l2-live.test.tsx; the comparison of the two sites' mounts in
// multichain-bloch-l2-seam.test.tsx.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MultichainApplication, connectUnavailableNote } from '../MultichainApp';
import {
  bundledNetwork,
  bundledRecord,
  loadMainnetState,
  plannedCaps,
  plannedPairs,
} from '../mainnet/config';
import { renderHeadersFile } from '../mainnet/headers';
import { BLOCH_L2_WORDING, setWording } from '../mainnet/wording';
import {
  BLOCH_L2_SITE_WORDING,
  blochL2Entry,
  DEPOSIT_ONLY_REASON,
  isBlochL2,
  parsePhase,
} from '../multichain/bloch-l2';
import { bundledChains } from '../multichain/config';
import { blochL2PolicyUrls, multichainHeadersFile } from '../multichain/headers';
import multichainFile from '../../../deployments/multichain.json';
import l2Network from '../../../deployments/mainnet/frontend.network.json';
import l2Record from '../../../deployments/mainnet/dex-mainnet.record.json';
import l2Phase from '../../../deployments/mainnet/l2-phase.json';
import { L2_RPC_URL, liveL2Files } from './bloch-l2-fixture';

// The mobile-wallet session module and the WalletConnect client: counted when first imported, as in
// multichain.test.tsx. They stay at zero on a route that is not live.
const loaded = vi.hoisted(() => ({ session: 0, client: 0, init: 0 }));
vi.mock('../multichain/walletconnect', () => {
  loaded.session++;
  return {};
});
vi.mock('@walletconnect/sign-client', () => {
  loaded.client++;
  return {
    default: { init: () => (loaded.init++, Promise.reject(new Error('not in this test'))) },
  };
});
function socketSpy() {
  const opened: string[] = [];
  vi.stubGlobal(
    'WebSocket',
    class {
      constructor(url: string) {
        opened.push(String(url));
      }
    },
  );
  return opened;
}
const FRONTEND = process.cwd();
const REPOSITORY = join(FRONTEND, '..');
const made: string[] = [];
afterEach(() => {
  setWording({ ...BLOCH_L2_WORDING });
  vi.unstubAllGlobals();
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const go = (hash: string) =>
  act(async () => {
    history.replaceState(null, '', `/${hash}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
const PUBLIC_KEYS = ['ethereum', 'base', 'arbitrum-one', 'op-mainnet', 'linea', 'bnb-smart-chain'];

describe('the Bloch L2 entry of the multichain site', () => {
  it('is built from the Bloch L2 site’s own files and parsers: one network file, one record, the planned caps', async () => {
    const entry = blochL2Entry();
    expect(isBlochL2(entry)).toBe(true);
    expect(entry.key).toBe('bloch-l2');
    // The same object the L2 site's #/mainnet gets from `bundledNetwork()`: every L2-only rule as that file says.
    expect(entry.network).toEqual(bundledNetwork());
    expect(entry.network.chainId).toBe(700770);
    expect(entry.network.nativeCurrency.symbol).toBe('BLCH');
    expect(entry.network.newSlotFee).toMatchObject({ enabled: true });
    expect(entry.network.idle).toEqual({
      skipIdleBlocks: true,
      heartbeatSeconds: 86_400,
      blockIntervalSeconds: 1_800,
    });
    expect(entry.network.noIdleHeartbeat).toBeUndefined();
    expect(entry.network.rpcUrls).toBeUndefined();
    expect(entry.network.bridges.map((b) => b.symbol)).toEqual(['bUSDC']);
    expect(entry.planned).toEqual({ caps: plannedCaps(), pairs: plannedPairs() });
    expect(entry.planned.caps.map((c) => [c.symbol, c.cap])).toEqual([
      ['WBLCH', 10n ** 19n],
      ['bUSDC', 1_000_000_000n],
    ]);
    // The state is the L2 site's `loadMainnetState` of the same record, with the phase's reason in front.
    const own = await loadMainnetState(bundledRecord, bundledNetwork());
    const here = await entry.load();
    if (own.status !== 'not-live' || here.status !== 'not-live')
      throw new Error('expected not live');
    expect(here.reasons.slice(1)).toEqual(own.reasons);
  });

  it('is not a chain of the public-chain schema, which still refuses it', () => {
    expect([...multichainFile.chains].sort()).toEqual([...PUBLIC_KEYS].sort());
    expect(bundledChains().map((c) => c.key)).toEqual(PUBLIC_KEYS);
    expect(bundledChains().some((c) => c.network.chainId === 700770)).toBe(false);
    expect(bundledChains().some(isBlochL2)).toBe(false);
  });

  it('keeps the Bloch L2’s words, with this site’s heading and the network’s name for a failed read', () => {
    const { title, reads, ...rest } = BLOCH_L2_SITE_WORDING;
    const { title: ownTitle, reads: ownReads, ...ownRest } = BLOCH_L2_WORDING;
    expect(rest).toEqual(ownRest);
    expect([title, reads]).toEqual(['Bloch DEX on Bloch L2', 'Bloch L2 reads']);
    expect([ownTitle, ownReads]).toEqual(['Bloch L2 mainnet', 'Mainnet reads']);
    // The words every L2-only behaviour of the logic modules keys on.
    expect(BLOCH_L2_SITE_WORDING.quiet).toBe('idle-l2');
    expect(BLOCH_L2_SITE_WORDING.settled).toBe('finalized');
    expect(BLOCH_L2_SITE_WORDING.native).toBe('BLCH');
    expect(blochL2Entry().wording).toBe(BLOCH_L2_SITE_WORDING);
  });
});

describe('why the Bloch L2 route is not live', () => {
  it('says it from data: the phase file, the record and the network file', async () => {
    expect(l2Phase.userTransactions).toBe('not-enabled');
    const state = await blochL2Entry().load();
    expect(state).toEqual({
      status: 'not-live',
      reasons: [
        'Bloch L2 runs its deposit-only launch release: it does not accept user transactions yet, so the exchange cannot be deployed on it and no swap can be sent there.',
        'No verified mainnet deployment record has been published.',
        'The public L2 RPC is not published yet.',
        'The reviewed L2 genesis hash is not pinned yet.',
      ],
    });
    expect(DEPOSIT_ONLY_REASON).toBe((state as { reasons: string[] }).reasons[0]);
    // No date and no clock in it: the same files give the same reasons at any time.
    vi.useFakeTimers({ now: new Date('2031-01-01T00:00:00Z') });
    try {
      expect(await blochL2Entry().load()).toEqual(state);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops the deposit-only reason when the phase file says user transactions are enabled, and each file keeps its own reason', async () => {
    const enabled = { ...l2Phase, userTransactions: 'enabled' };
    const state = await blochL2Entry({ phase: enabled }).load();
    expect(state).toEqual({
      status: 'not-live',
      reasons: [
        'No verified mainnet deployment record has been published.',
        'The public L2 RPC is not published yet.',
        'The reviewed L2 genesis hash is not pinned yet.',
      ],
    });
    // A published RPC and a pinned genesis with the committed record: one reason left, from the record.
    const files = liveL2Files();
    expect(await blochL2Entry({ network: files.network, phase: enabled }).load()).toEqual({
      status: 'not-live',
      reasons: ['No verified mainnet deployment record has been published.'],
    });
    // The record of a deployment while the RPC is still a placeholder: the network file's reason.
    expect(
      await blochL2Entry({
        network: { ...files.network, rpc: { url: L2_RPC_URL, status: 'placeholder' } },
        record: files.record,
        phase: enabled,
      }).load(),
    ).toEqual({ status: 'not-live', reasons: ['The public L2 RPC is not published yet.'] });
  });

  it('goes live by the record and the network file alone: a phase file left at "not-enabled" is not shown and holds nothing back', async () => {
    const files = liveL2Files();
    const state = await blochL2Entry(files).load();
    expect(state.status).toBe('live');
    // Exactly the L2 site's state for the same two files.
    expect(state).toEqual(await loadMainnetState(files.record, blochL2Entry(files).network));
    expect(JSON.stringify(state, (_, v) => (typeof v === 'bigint' ? String(v) : v))).not.toContain(
      'deposit-only',
    );
  });

  it('refuses a phase file of another domain, version, chain or value, and an unknown field', () => {
    expect(parsePhase(l2Phase)).toEqual({ userTransactions: 'not-enabled' });
    const bad = (change: Record<string, unknown>, message: RegExp) =>
      expect(() => blochL2Entry({ phase: { ...l2Phase, ...change } })).toThrow(message);
    bad({ domain: 'postern.dex.frontend-network.v1' }, /unsupported phase file/);
    bad({ schemaVersion: 2 }, /unsupported phase file/);
    bad({ chainId: 700771 }, /not for chain 700770/);
    bad({ network: 'bloch-l2-devnet4' }, /not for chain 700770/);
    bad({ userTransactions: true }, /userTransactions/);
    bad({ userTransactions: 'deposit-only' }, /userTransactions/);
    bad({ since: '2026-11-19' }, /unknown field/);
    expect(() => parsePhase(null)).toThrow(/unsupported phase file/);
    expect(() => parsePhase([])).toThrow(/unsupported phase file/);
  });

  it('takes its words from the repository’s documents, which still say them', () => {
    const packageDoc = readFileSync(join(REPOSITORY, 'docs/MAINNET-700770-PACKAGE.md'), 'utf8');
    const readiness = readFileSync(join(REPOSITORY, 'docs/MAINNET-READINESS.md'), 'utf8');
    expect(packageDoc).toContain('the launch release is deposit-only');
    expect(packageDoc).toMatch(/records the final L2 deposit-only launch\s+release/);
    expect(readiness.replace(/\s+/g, ' ')).toContain(
      'The L2 mainnet (chain 700770) is activated and accepts user transactions',
    );
    expect(DEPOSIT_ONLY_REASON).toContain('deposit-only launch release');
    expect(DEPOSIT_ONLY_REASON).toContain('does not accept user transactions yet');
    expect(l2Phase.note).toContain('docs/MAINNET-700770-PACKAGE.md');
    expect(l2Phase.note).toContain('docs/MAINNET-READINESS.md');
  });
});

describe('the multichain policy and the Bloch L2 endpoints', () => {
  const publicUrls = () => bundledChains().flatMap((c) => c.rpcUrls);
  const hold = {
    ethRpcUrl: 'https://ethereum-rpc.example.invalid',
    vault: `0x${'11'.repeat(20)}`,
    token: `0x${'22'.repeat(20)}`,
    vaultCodeHash: `0x${'33'.repeat(32)}`,
  };

  it('names an L2 origin exactly when the L2 route can be live: every state of the record, the RPC and the genesis', async () => {
    const files = liveL2Files();
    for (const deployed of [false, true])
      for (const rpcLive of [false, true])
        for (const pinned of [false, true]) {
          const network = {
            ...files.network,
            rpc: { url: L2_RPC_URL, status: rpcLive ? 'live' : 'placeholder' },
            genesisHash: pinned ? files.network.genesisHash : null,
          };
          const record = deployed ? files.record : l2Record;
          const urls = blochL2PolicyUrls(network, record);
          const state = await blochL2Entry({ network, record }).load();
          // The policy follows the route: an origin is named if and only if the route reads the chain.
          expect(urls.length > 0, `${deployed} ${rpcLive} ${pinned}`).toBe(state.status === 'live');
          expect(urls).toEqual(deployed && rpcLive && pinned ? [L2_RPC_URL] : []);
        }
    expect(blochL2PolicyUrls(l2Network, l2Record)).toEqual([]);
  });

  it('for a live L2 adds its RPC origin and the bridge-hold status origin to connect-src, and nothing else changes', () => {
    const files = liveL2Files();
    files.network.bridges[0].status = hold;
    const urls = blochL2PolicyUrls(files.network, files.record);
    expect(urls).toEqual([L2_RPC_URL, hold.ethRpcUrl]);
    const before = multichainHeadersFile(publicUrls(), renderHeadersFile);
    const after = multichainHeadersFile([...publicUrls(), ...urls], renderHeadersFile);
    const added = ` ${L2_RPC_URL} ${hold.ethRpcUrl}`;
    expect(after.length).toBe(before.length + added.length);
    expect(after.split(added)).toHaveLength(2);
    expect(after.replace(added, '')).toBe(before);
    const csp = after.split('\n').find((l) => l.includes('Content-Security-Policy'))!;
    expect(csp.match(/connect-src ([^;]*)/)![1]).toContain(added);
    // Only connect-src names them: no script, frame, image or form origin is added.
    expect(csp.replace(/connect-src [^;]*/, '')).not.toMatch(/blochl1|example\.invalid/);
  });

  it('refuses nothing silently: a network file without an RPC URL gives no policy', () => {
    const files = liveL2Files();
    expect(() =>
      blochL2PolicyUrls({ ...files.network, rpc: { status: 'live' } }, files.record),
    ).toThrow(/rpc\.url/);
    expect(() => blochL2PolicyUrls(null, files.record)).toThrow(/network file/);
    expect(() => blochL2PolicyUrls(files.network, null)).toThrow(/record/);
  });
});

describe('the build scripts and the Bloch L2 endpoints', () => {
  const built = () => {
    const dir = mkdtempSync(join(tmpdir(), 'postern-multichain-l2-'));
    made.push(dir);
    writeFileSync(join(dir, 'multichain.html'), '<!doctype html><title>built page</title>');
    for (const file of ['404.html', 'social-preview.png'])
      copyFileSync(join(FRONTEND, 'public', file), join(dir, file));
    writeFileSync(
      join(dir, 'THIRD-PARTY-NOTICES.txt'),
      readFileSync(join(FRONTEND, 'public/THIRD-PARTY-NOTICES.txt'), 'utf8').slice(0, 2000),
    );
    return dir;
  };
  const run = (script: string, args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [`scripts/${script}`, ...args], {
      cwd: FRONTEND,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
  // The published file: the six chains' endpoints in the order of deployments/multichain.json.
  const pinned = () =>
    multichainHeadersFile(
      multichainFile.chains.flatMap(
        (key) =>
          (
            JSON.parse(
              readFileSync(join(REPOSITORY, 'deployments', key, 'frontend.network.json'), 'utf8'),
            ) as { rpc: { urls: string[] } }
          ).rpc.urls,
      ),
      renderHeadersFile,
    );

  it('multichain-finish.mjs with the committed files writes the policy of the six public chains, without the L2 RPC', () => {
    const dir = built();
    const finished = run('multichain-finish.mjs', [dir]);
    expect(finished.stderr).toBe('');
    expect(finished.status).toBe(0);
    expect(finished.stdout).toContain('Bloch L2: not live, no origin');
    const headers = readFileSync(join(dir, '_headers'), 'utf8');
    expect(headers).toBe(pinned());
    expect(headers).not.toContain('blochl1.com');
  });

  it('multichain-finish.mjs given a live L2 (the rehearsal overrides of the L2 site) names its endpoint, on loopback without the upgrade', () => {
    const dir = built();
    const files = liveL2Files();
    files.network.rpc = { url: 'http://127.0.0.1:48510', status: 'live' };
    const network = join(dir, 'l2.network.json');
    const record = join(dir, 'l2.record.json');
    writeFileSync(network, JSON.stringify(files.network));
    writeFileSync(record, JSON.stringify(files.record));
    const finished = run('multichain-finish.mjs', [dir], {
      POSTERN_MAINNET_NETWORK: network,
      POSTERN_MAINNET_RECORD: record,
    });
    expect(finished.stderr).toBe('');
    expect(finished.status).toBe(0);
    expect(finished.stdout).toContain('Bloch L2: live, 1 origin');
    const headers = readFileSync(join(dir, '_headers'), 'utf8');
    expect(headers).toMatch(/connect-src [^;]* http:\/\/127\.0\.0\.1:48510 /);
    expect(headers).not.toContain('upgrade-insecure-requests');
    expect(headers).not.toContain('blochl1.com');
  });

  it('check-production-bundle.mjs --multichain passes the committed policy and refuses the L2 RPC, or any other origin, added to it', () => {
    const dir = built();
    expect(run('multichain-finish.mjs', [dir]).status).toBe(0);
    const clean = run('check-production-bundle.mjs', [dir, '--multichain']);
    expect(clean.stdout).toContain('0 hit(s)');
    expect(clean.status).toBe(0);
    const file = join(dir, '_headers');
    const headers = readFileSync(file, 'utf8');
    // The committed L2 files are not live: its RPC in connect-src is a hit (the rule of review R309-UI-6, restated).
    writeFileSync(
      file,
      headers.replace("connect-src 'self' ", `connect-src 'self' ${L2_RPC_URL} `),
    );
    const l2 = run('check-production-bundle.mjs', [dir, '--multichain']);
    expect(l2.status).toBe(1);
    expect(l2.stdout).toContain(
      'the Bloch L2 RPC is in the multichain connect-src while its route cannot be live',
    );
    // Nothing broader: an origin no committed file gives is a hit as well.
    writeFileSync(
      file,
      headers.replace("connect-src 'self' ", "connect-src 'self' https://rpc.example.invalid "),
    );
    const other = run('check-production-bundle.mjs', [dir, '--multichain']);
    expect(other.status).toBe(1);
    expect(other.stdout).toContain('_headers is not the policy the committed files give');
    writeFileSync(file, headers);
    expect(run('check-production-bundle.mjs', [dir, '--multichain']).status).toBe(0);
  });
});

describe('the Bloch L2 route of the multichain site, not live', () => {
  it('is reached from the header list and the network switcher, says why it is not live, and asks nothing of anyone', async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const sockets = socketSpy();
    const request = vi.fn();
    window.ethereum = { request };
    history.replaceState(null, '', '/#/base');
    render(<MultichainApplication />);
    await screen.findByLabelText('Not yet live');
    // The header list: the seventh link.
    const nav = screen.getByRole('navigation', { name: 'Networks' });
    const link = within(nav).getByRole('link', { name: 'Bloch L2' });
    expect(link.getAttribute('href')).toBe('#/bloch-l2');
    expect([...nav.querySelectorAll('a')].indexOf(link as HTMLAnchorElement)).toBe(6);
    // The switcher: the seventh row, selectable, with its chain id and status.
    await user.click(screen.getByRole('button', { name: /Base · Chain 8453/ }));
    const rows = [...screen.getByRole('dialog', { name: 'Select network' }).querySelectorAll('li')];
    expect(rows).toHaveLength(7);
    expect(rows[6].textContent).toBe('Bloch L2Chain 700770 · Not yet live');
    expect(rows[6].querySelector('a')!.getAttribute('href')).toBe('#/bloch-l2');
    await user.keyboard('{Escape}');

    await go('#/bloch-l2');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Bloch DEX on Bloch L2');
    expect(document.title).toBe('Bloch DEX — Bloch L2');
    expect(nav.querySelector('[aria-current="page"]')!.textContent).toBe('Bloch L2');
    expect(document.querySelector('.app-shell')!.getAttribute('data-network')).toBe('bloch-l2');
    expect(document.querySelector('.badge')!.textContent).toBe(
      'Bloch DEX on Bloch L2 · Chain 700770 · Not yet live',
    );
    const panel = await screen.findByLabelText('Not yet live');
    expect(panel.textContent).toContain('The DEX is not deployed on the Bloch L2 mainnet yet.');
    expect([...panel.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      DEPOSIT_ONLY_REASON,
      'No verified mainnet deployment record has been published.',
      'The public L2 RPC is not published yet.',
      'The reviewed L2 genesis hash is not pinned yet.',
    ]);
    // The L2's planned caps, from the L2's reviewed config (a public chain has none).
    expect([...panel.querySelectorAll('tbody tr')].map((tr) => tr.textContent)).toEqual([
      'WBLCH10 WBLCH',
      'bUSDC1000 bUSDC',
    ]);
    expect(panel.textContent).toContain('Pools: WBLCH/bUSDC.');
    // The L2's own network block and bridged-assets card, as on the L2 site.
    const network = screen.getByLabelText('Network');
    expect(network.textContent).toContain(
      'Bloch L2, chain ID 700770 (0xab162), native currency BLCH',
    );
    expect(network.textContent).toContain(`${L2_RPC_URL} (placeholder, not published yet)`);
    expect(screen.getByLabelText('Bridges').textContent).toContain('bUSDC');
    // Nothing of a public chain's rules: no confirmation note, no token note, no screens of the public routes.
    expect(screen.queryByTestId('confirmation-rule')).toBeNull();
    expect(screen.queryByTestId('token-note')).toBeNull();
    expect(screen.queryByRole('navigation', { name: 'Screens' })).toBeNull();
    // The notes about a usable route are for a live one.
    expect(screen.queryByTestId('l2-route-notes')).toBeNull();
    expect(document.querySelector('.footer')!.textContent).toContain(
      'Bloch L2 · chain 700770Reviewed deployment record · Finalized reads · Fixed reserve caps · Explicit wallet transactions',
    );
    expect(document.querySelector('.footer')!.textContent).not.toMatch(/two endpoints/);
    // The site-wide line still holds with seven networks: none is live.
    expect(screen.getByTestId('not-active-banner').textContent).toMatch(
      /^Bloch DEX is not active yet\. No pool is open on any network/,
    );
    expect(screen.queryByRole('button', { name: 'Swap' })).toBeNull();
    // The header's "Connect wallet": said, not silent.
    await user.click(screen.getByRole('button', { name: 'Connect wallet' }));
    expect(screen.getByTestId('wallet-unavailable').textContent).toBe(
      'Connecting a wallet becomes available when Bloch L2 is live on Bloch DEX. Nothing was asked of any wallet.',
    );
    expect(screen.getByTestId('wallet-unavailable').textContent).toBe(
      connectUnavailableNote('Bloch L2'),
    );
    // No request of any kind and nothing initialised: no RPC, no wallet, no session module, no client, no socket.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(document.querySelector('[data-wallet-connect]')).toBeNull();
    expect(document.querySelector('[data-mobile-wallet]')).toBeNull();
    expect(loaded).toEqual({ session: 0, client: 0, init: 0 });
    expect(sockets).toEqual([]);
  });

  it('opened directly by its address, and left for a public network, each page has its own words', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    history.replaceState(null, '', '/#/bloch-l2');
    render(<MultichainApplication />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Bloch DEX on Bloch L2');
    await screen.findByLabelText('Not yet live');
    expect(document.body.textContent).toContain('finalized L2 block');
    await go('#/base');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Bloch DEX on Base');
    expect((await screen.findByLabelText('Not yet live')).textContent).toContain(
      'The DEX is not deployed on Base yet.',
    );
    expect(document.querySelector('main')!.textContent).not.toMatch(/L2|BLCH|bUSDC|deposit-only/);
    expect(screen.getByTestId('confirmation-rule')).toBeTruthy();
    // A second segment is not a screen of the L2 route: the route is the one page.
    await go('#/bloch-l2/pools');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Bloch DEX on Bloch L2');
    expect(screen.queryByRole('navigation', { name: 'Screens' })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('the Bloch-words guard, route by route', () => {
  it('holds on each of the six public-chain routes with the switcher closed and open; the words belong to the L2 route', async () => {
    const user = userEvent.setup();
    history.replaceState(null, '', '/#/ethereum');
    render(<MultichainApplication />);
    for (const chain of bundledChains()) {
      await go(`#/${chain.key}`);
      await screen.findByLabelText('Not yet live');
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
        `Bloch DEX on ${chain.network.chainName}`,
      );
      for (const open of [false, true]) {
        if (open)
          await user.click(
            screen.getByRole('button', {
              name: new RegExp(`${chain.network.chainName} · Chain ${chain.network.chainId}`),
            }),
          );
        // Inside the route: nothing of the Bloch L2 at all, the site's name apart.
        const route = document.querySelector('main')!.textContent!.replaceAll('Bloch DEX', '');
        expect(route, chain.key).not.toMatch(/Bloch|BLCH|bUSDC/);
        // In the whole page: the site's name, and the controls that lead to the seventh network; they are
        // exactly a link to its route named by the network's name, and nothing else is set aside.
        const copy = document.body.cloneNode(true) as HTMLElement;
        const named = [...copy.querySelectorAll('a[href="#/bloch-l2"]')];
        expect(named.map((l) => l.textContent)).toEqual(
          open ? ['Bloch L2', 'Bloch L2Chain 700770 · Not yet live'] : ['Bloch L2'],
        );
        for (const link of named) link.remove();
        expect(copy.textContent!.replaceAll('Bloch DEX', ''), chain.key).not.toMatch(
          /Bloch|BLCH|bUSDC/,
        );
        // The guard is not vacuous: with the links left in, it trips.
        expect(document.body.textContent!.replaceAll('Bloch DEX', '')).toMatch(/Bloch/);
        if (open) await user.keyboard('{Escape}');
      }
      expect(document.title).toBe(`Bloch DEX — ${chain.network.chainName}`);
    }
    await go('#/bloch-l2');
    await screen.findByLabelText('Not yet live');
    const l2 = document.querySelector('main')!.textContent!;
    for (const word of ['Bloch L2', 'BLCH', 'bUSDC']) expect(l2).toContain(word);
  });
});
