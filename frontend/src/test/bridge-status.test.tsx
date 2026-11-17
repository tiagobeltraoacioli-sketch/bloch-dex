// Every named state of a deposit and of an exit: reached from an observation, rendered, and worded so that a wait is
// never a failure. One generated test per fixture (bridge/state-fixtures.ts); the same fixtures feed the gallery.
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import bundle from '@postern/bridge-bundle';
import { StatusCard } from '../bridge/BridgeParts';
import { parseBridgeBundle } from '../bridge/config';
import { NOW, STATE_FIXTURES } from '../bridge/state-fixtures';
import { exitStatus } from '../bridge/status';

const config = parseBridgeBundle(bundle, false);
const route = (id: string) => config.entries.find((e) => e.id === id)!.route!;

describe('bridge states', () => {
  it('covers every state the brief names', () => {
    const states = new Set(STATE_FIXTURES.map((f) => f.state));
    for (const s of [
      'exit-approved-waiting-delay', 'exit-approved-payable', 'exit-approved-no-token-account', // Solana approve-then-execute
      'exit-held', 'exit-held-direct-burn', 'exit-set-aside', 'exit-voided-by-pause', 'exit-waiting-fee-rate',
      'exit-unclaimed', 'exit-queued', 'exit-vault-paused', 'exit-waiting-limit', 'exit-paid', 'exit-source-unread',
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
    expect(s.body).toMatch(/no refund path today/);
    expect(s.body).toMatch(/page's own reading of Solana/);
    expect(s.tone).toBe('danger');
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
