// Every named state of a deposit and of an exit: reached from an observation, rendered, and worded so that a wait is
// never a failure. One generated test per fixture (bridge/state-fixtures.ts); the same fixtures feed the gallery.
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import bundle from '@postern/bridge-bundle';
import { StatusCard } from '../bridge/BridgeParts';
import { parseBridgeBundle } from '../bridge/config';
import { NOW, STATE_FIXTURES } from '../bridge/state-fixtures';
import { BITCOIN_ROUTER_ABI, STELLAR_CLAIM_ROUTER_ABI, applyRecovery, recoveryCalls } from '../bridge/l2';
import type { LiveRoute } from '../bridge/config';
import { decodeFunctionData, type Address, type Hex } from 'viem';
import { exitStatus } from '../bridge/status';

const config = parseBridgeBundle(bundle, false);
const route = (id: string) => config.entries.find((e) => e.id === id)!.route!;

describe('bridge states', () => {
  it('covers every state the brief names', () => {
    const states = new Set(STATE_FIXTURES.map((f) => f.state));
    for (const s of [
      'exit-approved-waiting-delay', 'exit-approved-payable', 'exit-approved-no-token-account', // Solana approve-then-execute
      'exit-held', 'exit-held-direct-burn', 'exit-set-aside', 'exit-voided-by-pause', 'exit-waiting-fee-rate',
      'exit-unclaimed', 'exit-held-no-proof', 'exit-queued', 'exit-vault-paused', 'exit-waiting-limit', 'exit-paid', 'exit-source-unread',
      'deposit-credit-delay', 'deposit-ready', 'deposit-ready-behind', 'deposit-cancelled', 'deposit-paused', 'deposit-credited',
    ])
      expect(states.has(s), s).toBe(true);
  });
  for (const fixture of STATE_FIXTURES) {
    it(`${fixture.id} -> ${fixture.state}`, () => {
      const r = route(fixture.route);
      const status = fixture.status(r);
      expect(status.state).toBe(fixture.state);
      expect(status.steps[status.step]).toBeTruthy();
      render(<StatusCard heading={`${fixture.heading(r)} on ${r.name}`} status={status} onAction={() => {}} reference={{ what: 'Burn id', value: '0x07' }} />);
      const card = screen.getByRole('article');
      expect(within(card).getByRole('status').textContent).toBe(status.title);
      expect(card.textContent).toContain(status.body);
      // Every action is on the card with what it involves; a state without one says so, unless it is done.
      for (const action of status.actions) {
        expect(card.textContent).toContain(action.label);
        expect(card.textContent).toContain(action.detail);
      }
      if (status.actions.length === 0 && status.tone !== 'ok') expect(card.textContent).toContain('Nothing for you to do in this state.');
      // A waiting, paused, queued or voided exit is never called failed or lost.
      if (status.tone !== 'danger') expect(`${status.title} ${status.body}`).not.toMatch(/\bfailed\b|(?<!nothing )(?<!not )\bis lost\b|\bwas lost\b/i);
      expect(card.getAttribute('data-state')).toBe(fixture.state);
    });
  }
  it('says "not lost" where a pause voids an approval or a queue', () => {
    for (const f of STATE_FIXTURES.filter((x) => x.state === 'exit-voided-by-pause')) {
      const s = f.status(route(f.route));
      expect(s.body).toMatch(/Nothing is lost|It is not lost/);
      expect(s.tone).toBe('warn');
    }
  });
  it('a held Solana exit says there is no refund and that held is the page\'s own reading', () => {
    const s = STATE_FIXTURES.find((f) => f.id === 'solana held: destination not a wallet')!.status(route('solana'));
    // Restated by agent 363: with the redirect of round 18 the text says "There is no refund." and names the one way
    // out (the burner's redirect); without a redirect format it still says "no refund path today" (below).
    expect(s.body).toMatch(/There is no refund\./);
    expect(s.body).toMatch(/stays held for good, even if the address changes later/);
    expect(s.actions.map((a) => a.id)).toEqual(['redirect-held-burn']);
    expect(s.body).toMatch(/page's own reading of Solana/);
    expect(s.tone).toBe('danger');
    const old = route('solana');
    const noRedirect = { ...old, solana: { ...old.solana!, proof: { ...old.solana!.proof, redirectTemplate: null } } };
    const t = STATE_FIXTURES.find((f) => f.id === 'solana held: destination not a wallet')!.status(noRedirect);
    expect(t.body).toMatch(/no refund path today/);
    expect(t.actions).toEqual([]);
  });
  it('offers "Credit now" as a button only for the credit head, and instructions elsewhere', () => {
    const ready = STATE_FIXTURES.find((f) => f.state === 'deposit-ready')!;
    render(<StatusCard heading="Deposit" status={ready.status(route(ready.route))} onAction={() => {}} />);
    expect((screen.getByRole('button', { name: 'Credit now' }) as HTMLButtonElement).disabled).toBe(false);
    const payable = STATE_FIXTURES.find((f) => f.state === 'exit-approved-payable')!;
    const view = render(<StatusCard heading="Exit" status={payable.status(route('solana'))} onAction={() => {}} />);
    expect(within(view.container).queryByRole('button', { name: /send the payment/ })).toBeNull();
    expect(view.container.textContent).toContain('execute_release');
  });
  it('a paid record wins over everything else, and the paid bit covers a closed record', () => {
    const sol = route('solana');
    const burn = { burnId: `0x${'07'.padStart(64, '0')}` as const, burnNonce: 7n, amount: 5n, block: 1n, tx: `0x${'0'.repeat(64)}` as const, recipient: 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB', recipient20: `0x${'1'.repeat(40)}` as const, viaRouter: true };
    const paid = exitStatus(sol, burn, { kind: 'solana', record: null, paidBit: true, pausedUntil: NOW + 99n, voidThroughSeq: 0n, bucket: 0n, destination: 'not-a-wallet', tokenAccount: false }, NOW);
    expect(paid.state).toBe('exit-paid');
  });
});

describe('round 18: held Solana exits are recovered by the burner\'s redirect; direct burns by a set-once claim', () => {
  const find = (id: string) => STATE_FIXTURES.find((f) => f.id === id)!;
  it('an exit whose published proof does not check is held, says why, and offers "Send to another address"', () => {
    const s = find('solana held: no valid proof').status(route('solana'));
    expect(s.state).toBe('exit-held-no-proof');
    expect(s.tone).toBe('danger');
    expect(s.body).toMatch(/does not check.*HOLDS.*stays held for good.*There is no refund/s);
    expect(s.actions.map((a) => a.id)).toEqual(['redirect-held-burn']);
    render(<StatusCard heading="Exit" status={s} onAction={() => {}} />);
    expect(screen.getByRole('button', { name: 'Send to another address' })).toBeTruthy();
  });
  it('a redirected held burn shows the new wallet and the one it replaced', () => {
    const s = find('solana held burn redirected, waiting for the committee').status(route('solana'));
    expect(s.body).toMatch(/You named CK892oB8o4LTPKEe2yXEBY5YG1DCh3fAcGN1AFx71eQG for it in L2 block 430 \(it was GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB\)/);
    expect(s.actions).toEqual([]);
  });
  it('a redirect of an exit that was not held is said not to be followed', () => {
    expect(find('solana redirect not followed (exit was not held)').status(route('solana')).body).toMatch(/redirect you sent later is not followed/);
  });
  it('a Stellar direct burn is never paid until its burner claims it once on the router; a claim then counts', () => {
    const s = find('stellar direct burn unclaimed').status(route('stellar'));
    expect(s.state).toBe('exit-unclaimed');
    expect(s.body).toMatch(/NEVER paid.*set once and cannot be changed.*never an exchange deposit address/s);
    expect(s.actions.map((a) => a.id)).toEqual(['claim-direct-burn']);
    const c = find('stellar direct burn claimed, waiting for the committee').status(route('stellar'));
    expect(c.state).toBe('exit-waiting-signatures');
    expect(c.body).toMatch(/You named GAF2DTU2.* for it in L2 block 431/);
  });
  it('a claimed Bitcoin direct burn is read like a router exit', () => {
    expect(find('bitcoin direct burn claimed, payable').status(route('bitcoin')).state).toBe('exit-payable');
  });
  it('applyRecovery follows the signers\' rule: claim for direct burns; redirect only for a held Solana burn', () => {
    const sol = route('solana') as LiveRoute;
    const redirect = { address: 'CK892oB8o4LTPKEe2yXEBY5YG1DCh3fAcGN1AFx71eQG', nonce: 2n, block: 9n, tx: `0x${'ab'.repeat(32)}` as Hex };
    const b = { burnId: `0x${'07'.repeat(32)}` as Hex, burnNonce: 7n, amount: 1n, block: 1n, tx: `0x${'cd'.repeat(32)}` as Hex, recipient: 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB', recipient20: '0x1111111111111111111111111111111111111111' as Address, viaRouter: true };
    const withRouter = { ...sol, router: { address: '0x2e234dae75c793f67a35089c9d99245e1c58470b' as Address, codeHash: `0x${'00'.repeat(32)}` as Hex } } as LiveRoute;
    // valid proof, wallet destination: not held, the redirect is not followed
    expect(applyRecovery(withRouter, { ...b, proof: { nonce: 1n, bytes: '0x', valid: true, reason: null }, redirect })).toMatchObject({ recipient: b.recipient, redirectIgnored: true });
    // held at the original destination: followed
    expect(applyRecovery(withRouter, { ...b, proof: { nonce: 1n, bytes: '0x', valid: true, reason: null }, redirect }, true)).toMatchObject({ recipient: redirect.address, recipientOriginal: b.recipient });
    // invalid proof: held, followed
    expect(applyRecovery(withRouter, { ...b, proof: { nonce: 1n, bytes: '0x', valid: false, reason: 'x' }, redirect }).recipient).toBe(redirect.address);
    // a direct burn: followed
    expect(applyRecovery(withRouter, { ...b, viaRouter: false, redirect }).recipient).toBe(redirect.address);
    // no redirect: unchanged
    expect(applyRecovery(withRouter, { ...b, viaRouter: false, redirect: null }).recipient).toBe(b.recipient);
  });
  it('recovery calls encode exactly the router functions, from the account that burned, and refuse other routes', () => {
    const btc = { ...(route('bitcoin') as LiveRoute), router: { address: '0x00000000000000000000000000000000000000b1' as Address, codeHash: `0x${'00'.repeat(32)}` as Hex } } as LiveRoute;
    const c = recoveryCalls.claimBitcoin(btc, 7n, 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 12);
    expect(decodeFunctionData({ abi: BITCOIN_ROUTER_ABI, data: c.data })).toMatchObject({ functionName: 'claimDirectBurn', args: [7n, 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 12] });
    expect(() => recoveryCalls.claimBitcoin(btc, 7n, 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 201)).toThrow(/out of range/);
    const xlm = { ...(route('stellar') as LiveRoute), router: { address: '0x00000000000000000000000000000000000000c1' as Address, codeHash: `0x${'00'.repeat(32)}` as Hex } } as LiveRoute;
    const x = recoveryCalls.claimStellar(xlm, 3n, 'GAF2DTU23X5CFOPOUCUBTFJ5PKTSOV4GLZAJB5VMJW2JUA5KKYF5OLNA');
    expect(decodeFunctionData({ abi: STELLAR_CLAIM_ROUTER_ABI, data: x.data })).toMatchObject({ functionName: 'claimDirectBurn', args: [3n, 'GAF2DTU23X5CFOPOUCUBTFJ5PKTSOV4GLZAJB5VMJW2JUA5KKYF5OLNA'] });
    expect(() => recoveryCalls.claimStellar(xlm, 0n, 'GAF2DTU23X5CFOPOUCUBTFJ5PKTSOV4GLZAJB5VMJW2JUA5KKYF5OLNA')).toThrow();
    expect(() => recoveryCalls.claimStellar(btc, 3n, 'G')).toThrow(/no claim/);
    expect(() => recoveryCalls.claimBitcoin(xlm, 3n, 'bc1q', 1)).toThrow(/no Bitcoin router/);
  });
});

