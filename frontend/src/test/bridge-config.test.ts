// The bridge configuration: the bundled files parse, nothing is live today, a route that is not live cannot reach
// a builder, the generated token list is what the generator gives, and the numbers page.json copies out of the
// bridges' free text are still in that text.
import { describe, expect, it } from 'vitest';
import bundle from '@postern/bridge-bundle';
import { SOLANA_PROOF_PAGE_V0, liveRoute, notLiveReasons, parseBridgeBundle, routeStatus, type Route } from '../bridge/config';
import { wrappedTokens } from '../../../scripts/bridge/wrapped-tokens.mjs';
import { rehearsalBundle } from './fixtures/bridge-rehearsal';

const config = parseBridgeBundle(bundle, false);
const byId = (id: string) => config.entries.find((e) => e.id === id)!;
const file = (id: string) => (bundle.files as { network: { id: string } }[]).find((f) => f.network.id === id) as Record<string, any>;

describe('the committed bridge files', () => {
  it('lists the nine networks the coordinator shows, in order, and never BNB Smart Chain', () => {
    expect(config.entries.map((e) => e.id)).toEqual(['ethereum', 'arbitrum-one', 'op-mainnet', 'linea', 'base', 'bitcoin', 'solana', 'tron', 'stellar']);
    expect(config.rehearsal).toBe(false);
  });
  it('reads every file in full: no route is unreadable', () => {
    for (const entry of config.entries) expect(entry.status.state, entry.id).not.toBe('unreadable');
  });
  it('shows Base as not available yet, with the reason, and builds nothing for it', () => {
    const base = byId('base');
    expect(base.status).toEqual({ state: 'not-available-yet', reason: expect.stringMatching(/51 seconds/) });
    expect(liveRoute(base.route)).toBeNull();
  });
  it('has no live route today: every address is TBD-deploy, so no builder can be reached', () => {
    for (const entry of config.entries) {
      expect(entry.status.state === 'live', entry.id).toBe(false);
      expect(liveRoute(entry.route), entry.id).toBeNull();
      if (entry.status.state === 'not-live') expect(entry.status.reasons.length).toBeGreaterThan(0);
    }
    expect(notLiveReasons(byId('bitcoin').route!)).toEqual(expect.arrayContaining([expect.stringMatching(/token is not deployed/), expect.stringMatching(/vault on Bitcoin is not deployed/), expect.stringMatching(/exit router/), expect.stringMatching(/No reviewed endpoint/), expect.stringMatching(/vault keys are not published/)]));
  });
  it('sends Bitcoin, Solana and Stellar exits through a router and the others through the token', () => {
    for (const entry of config.entries) {
      const route = entry.route!;
      expect(route.router !== null, entry.id).toBe(['bitcoin', 'solana', 'stellar'].includes(entry.id));
    }
  });
  it('keeps one isolated token per network with its true name', () => {
    expect(config.tokens.map((t) => t.symbol)).toEqual(['bUSDC', 'bUSDC.arb', 'bUSDC.op', 'bUSDC.linea', 'bUSDC.base', 'bBTC', 'bUSDC.sol', 'bUSDT.trx', 'bUSDC.xlm']);
    expect(new Set(config.tokens.map((t) => t.symbol)).size).toBe(config.tokens.length);
    for (const t of config.tokens) {
      expect(t.address).toBeNull();
      expect(t.description).toMatch(/It is not/);
    }
    expect(config.tokens.find((t) => t.symbol === 'bUSDC.base')!.offered).toBe('not-available-yet');
    expect(config.tokens.some((t) => /bnb/i.test(t.symbol))).toBe(false);
  });
  it('carries the generated token list exactly as the generator writes it', () => {
    expect(wrappedTokens(bundle.files as never, bundle.launch as never, bundle.page as never)).toEqual(bundle.tokens);
  });
  it('records the commit each file was taken from', () => {
    for (const entry of config.entries) expect(entry.route!.source?.commit, entry.id).toMatch(/^[0-9a-f]{40}$/);
    expect(byId('ethereum').route!.source!.derived).toBe(true);
  });
});

describe('numbers page.json copies from the bridges\' free text', () => {
  const text = (id: string) => JSON.stringify(file(id));
  it('Bitcoin: vbytes, fee ceiling, the 10% cap, the large-exit rule', () => {
    const t = text('bitcoin');
    const p = byId('bitcoin').route!.bitcoin!.policy;
    expect(t).toContain(`fee rate x ${p.depositVbytes} vbytes`);
    expect(t).toContain(`a release fee rate x ${p.releaseVbytes} vbytes`);
    expect(t).toContain(`a refund fee rate x ${p.refundVbytes} vbytes`);
    expect(t).toContain(`never above ${p.feeRateCeiling} sat/vB`);
    expect(t).toContain('exceeds 10% of it');
    expect(p.depositMaxChargeBps).toBe(1000);
    expect(t).toContain('a burn above 0.05 BTC waits 12 hours');
    expect([p.largeBurnThreshold, p.largeBurnDelaySeconds]).toEqual([50_000n, 43_200]);
    expect(t).toContain('swept it (2 confirmations)');
    expect(p.sweepConfirmations).toBe(2);
  });
  it('TRON: the fixed release fee and the issuer fee bound', () => {
    const t = text('tron');
    const p = byId('tron').route!.tron!.policy;
    expect(t).toContain(`A - floor(A * 5 / 10000) - ${p.releaseFlat}`);
    expect(t).toContain('an ESTIMATE of 25 TRX');
    expect(t).toContain('at most 20 bps and 50 USDT');
  });
  it('Solana: the large-release rule, the rent, and the page-only proof text and its age', () => {
    const t = text('solana');
    const s = byId('solana').route!.solana!;
    expect(t).toContain(`largeReleaseThreshold ${s.policy.largeReleaseThreshold} and releaseDelay ${s.policy.releaseDelaySeconds} seconds`);
    expect(t).toContain('about 0.0024 SOL');
    expect(t).toContain(`recordRetention ${s.policy.recordRetentionSeconds} seconds`);
    expect(t).toContain(`older than ${s.policy.proofMaxAgeSeconds} seconds`);
    // The interface file still states the proof the page alone checks; the committed page uses the router-carried
    // format of the bridge's router at the same branch (page.json solana.exitProof, provisional).
    const line = SOLANA_PROOF_PAGE_V0.template.replace('{wallet}', '<WALLET>').replace('{burner}', '<0x + 40 hex lowercase>').replace('{router}', '<0x + 40 hex lowercase>').replace('{chainId}', '700770').replace('{issued}', '<unix seconds>');
    expect(t).toContain(line);
    expect(s.proof.carriedBy).toBe('router');
    expect(s.proof.template).toMatch(/^Bloch bridge exit v1: pay \{amount\} units burned by \{burner\} to my Solana wallet \{wallet\}\. Nonce \{nonce\}\. Router \{router\}\. Chain \{chainId\}\. Route \{route\}\.$/);
  });
  it('refuses a proof format it cannot fill', () => {
    const bad = (exitProof: unknown) => {
      const b = JSON.parse(JSON.stringify(bundle)) as Record<string, any>;
      b.page.networks.solana.exitProof = exitProof;
      return parseBridgeBundle(b, false).entries.find((e) => e.id === 'solana')!.status.state;
    };
    expect(bad({ template: 'pay {wallet} {burner} {router} {chainId} {amount} {nonce} {route}', carriedBy: 'router' })).toBe('not-live');
    expect(bad({ template: 'pay {wallet} {burner} {router} {chainId}', carriedBy: 'router' })).toBe('unreadable');
    expect(bad({ template: 'pay {wallet} {burner} {router} {chainId}', carriedBy: 'page' })).toBe('unreadable');
    expect(bad({ template: 'pay {wallet} {burner} {router} {chainId} {issued} {memo}', carriedBy: 'page' })).toBe('unreadable');
    expect(bad({ template: 'pay {wallet} {wallet} {burner} {router} {chainId} {issued}', carriedBy: 'page' })).toBe('unreadable');
    expect(bad({ template: 'pay {wallet} {burner} {router} {chainId} {issued}\nsecond line', carriedBy: 'page' })).toBe('unreadable');
  });
  it('Stellar: the worst-case delay of 9 days 8 hours', () => {
    expect(text('stellar')).toContain('delay an exit by 9 days 8 h');
    expect(byId('stellar').route!.stellar!.policy.worstCaseGuardianDelaySeconds).toBe(9 * 86400 + 8 * 3600);
  });
});

describe('fail closed', () => {
  const clone = () => JSON.parse(JSON.stringify(bundle)) as Record<string, any>;
  const entry = (b: unknown, id: string) => parseBridgeBundle(b, false).entries.find((e) => e.id === id)!;
  it('shows a file with an unknown top-level key, a wrong schema or a broken number as unreadable, never as usable', () => {
    for (const edit of [
      (f: Record<string, any>) => (f.extra = 1),
      (f: Record<string, any>) => (f.schema = 'bloch.bridge.network.v2'),
      (f: Record<string, any>) => (f.limits.minDeposit = 11000000),
      (f: Record<string, any>) => (f.l2.chainId = 700771),
      (f: Record<string, any>) => (f.l2.symbol = 'bUSDC arbitrum!'),
      (f: Record<string, any>) => (f.fee.depositBps = 500),
      (f: Record<string, any>) => delete f.finality,
      (f: Record<string, any>) => (f.l2.token = '0x1234'),
      (f: Record<string, any>) => (f.explorers.source.tx = 'javascript:alert(1)'),
    ]) {
      const b = clone();
      edit(b.files.find((f: any) => f.network.id === 'arbitrum-one'));
      const e = entry(b, 'arbitrum-one');
      expect(e.status.state).toBe('unreadable');
      expect(e.route).toBeNull();
      expect(liveRoute(e.route)).toBeNull();
    }
  });
  it('never offers a network whose own file says it is not in v1, whatever the page list says', () => {
    const b = clone();
    b.launch.networks.base = { state: 'shown' };
    expect(entry(b, 'base').status.state).toBe('not-available-yet');
  });
  it('refuses a router named for a route that burns on the token, and a missing router where one is required', () => {
    const b = clone();
    b.page.networks.tron.router = 'TBD-deploy';
    expect(entry(b, 'tron').status.state).toBe('unreadable');
    const c = clone();
    delete c.page.networks.solana.router;
    expect(entry(c, 'solana').status.state).toBe('unreadable');
  });
  it('refuses a rehearsal bundle outside a local render build, and a loopback endpoint in a committed bundle', () => {
    expect(() => parseBridgeBundle(rehearsalBundle(), false)).toThrow(/rehearsal/);
    const b = clone();
    b.page.networks.ethereum.read = { urls: ['http://127.0.0.1:8545'] };
    expect(entry(b, 'ethereum').status.state).toBe('unreadable');
    const c = clone();
    c.page.networks.ethereum.read = { urls: ['https://user:pw@rpc.example/'] };
    expect(entry(c, 'ethereum').status.state).toBe('unreadable');
  });
  it('refuses a stale generated token list', () => {
    const b = clone();
    b.tokens.tokens[1].name = 'USD Coin';
    expect(() => parseBridgeBundle(b, false)).toThrow(/stale/);
  });
  it('a route becomes live only when every address, the router code hash, the endpoints and (Bitcoin) the keys are there', () => {
    const live = parseBridgeBundle(rehearsalBundle(), true);
    for (const id of ['ethereum', 'bitcoin', 'solana', 'tron', 'stellar']) expect(live.entries.find((e) => e.id === id)!.status.state, id).toBe('live');
    const strip = (edit: (b: Record<string, any>) => void, id: string): Route => {
      const b = rehearsalBundle() as Record<string, any>;
      edit(b);
      // The generated list follows the files in a real import; here only the route matters.
      b.tokens = { tokens: [] };
      return parseBridgeBundle(b, true).entries.find((e) => e.id === id)!.route!;
    };
    expect(routeStatus(strip((b) => (b.page.networks.bitcoin.routerCodeHash = 'TBD-deploy'), 'bitcoin')).state).toBe('not-live');
    expect(routeStatus(strip((b) => (b.page.networks.bitcoin.script = 'TBD-deploy'), 'bitcoin')).state).toBe('not-live');
    expect(routeStatus(strip((b) => (b.page.networks.solana.read = 'TBD-owner'), 'solana')).state).toBe('not-live');
    expect(routeStatus(strip((b) => (b.files.find((f: any) => f.network.id === 'tron').custody.address = 'TBD-deploy'), 'tron')).state).toBe('not-live');
    expect(routeStatus(strip((b) => (b.files.find((f: any) => f.network.id === 'stellar').l2.token = 'TBD-deploy'), 'stellar')).state).toBe('not-live');
  });
});
