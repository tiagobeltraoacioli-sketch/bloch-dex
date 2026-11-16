import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DeadlineClock } from '../ui/DeadlineClock';
import { Disclosure } from '../ui/Disclosure';
import { Expander } from '../ui/Expander';
import { ReferencePanel } from '../ui/ReferencePanel';

describe('expander and disclosure', () => {
  it('the expander always renders its content and reports its state', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Expander more="All quote details" less="Fewer quote details">
        <dl>
          <dt className="glance">Rate</dt>
          <dd className="glance">1</dd>
          <dt>Route</dt>
          <dd>A → B</dd>
        </dl>
      </Expander>,
    );
    const toggle = screen.getByRole('button', { name: 'All quote details' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByText('A → B')).toBeTruthy();
    expect(container.querySelector('.expander')!.hasAttribute('data-expanded')).toBe(false);
    await user.click(toggle);
    expect(
      screen.getByRole('button', { name: 'Fewer quote details' }).getAttribute('aria-expanded'),
    ).toBe('true');
    expect(container.querySelector('.expander')!.hasAttribute('data-expanded')).toBe(true);
  });

  it('a closed disclosure keeps its content in the document, inert, and opens on its button', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Disclosure clip summary={() => 'What can I do?'}>
        <p>It never sends or replaces a transaction.</p>
      </Disclosure>,
    );
    const region = container.querySelector('.disclosure-region')!;
    expect(region.textContent).toBe('It never sends or replaces a transaction.');
    expect(region.hasAttribute('inert')).toBe(true);
    expect(container.querySelector('.disclosure')!.className).toContain('disclosure-clip');
    const toggle = screen.getByRole('button', { name: 'What can I do?' });
    expect(toggle.getAttribute('aria-controls')).toBe(region.id);
    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(region.hasAttribute('inert')).toBe(false);
    await user.click(toggle);
    expect(region.hasAttribute('inert')).toBe(true);
  });
});

describe('deadline line of a tracked swap', () => {
  it('shows the time left by the given clock, the bar, and says when the deadline has passed', () => {
    vi.useFakeTimers();
    try {
      let now = 1_000_000;
      const deadline = BigInt((now + 60 * 60_000) / 1000);
      const { container } = render(
        <DeadlineClock deadline={deadline} sentAtMs={now} now={() => now} />,
      );
      // A real countdown (agent 327): hours, minutes and seconds, not "in about 60 min".
      expect(container.textContent).toMatch(
        /^Saved deadline in 1:00:00 \(at \d\d:\d\d\), by this device's clock\.$/,
      );
      expect((container.querySelector('.deadline-bar > span') as HTMLElement).style.width).toBe(
        '0%',
      );
      now += 29 * 60_000 + 30_000;
      act(() => void vi.advanceTimersByTime(1_000));
      expect(container.textContent).toMatch(/^Saved deadline in 30:30 /);
      now += 31 * 60_000;
      act(() => void vi.advanceTimersByTime(1_000));
      expect(container.textContent).toMatch(
        /^Saved deadline passed 0:30 ago \(at \d\d:\d\d\), by this device's clock\. Unless the swap's receipt arrives first, the page releases the hold by itself once a finalized block is later than the deadline\.$/,
      );
      expect(container.querySelector('.deadline-clock')!.hasAttribute('data-passed')).toBe(true);
      expect((container.querySelector('.deadline-bar > span') as HTMLElement).style.width).toBe(
        '100%',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('reference panel', () => {
  const Panel = ({
    docked,
    open,
    onClose,
  }: {
    docked: boolean;
    open: boolean;
    onClose: () => void;
  }) => (
    <>
      <button>Outside</button>
      <ReferencePanel docked={docked} open={open} onClose={onClose} title="Pools and verification">
        <button>First inside</button>
        <a href="#x">Last inside</a>
      </ReferencePanel>
    </>
  );

  it('docked: part of the page, never inert, no dialog role', () => {
    render(<Panel docked open={false} onClose={() => {}} />);
    const panel = screen.getByLabelText('Pools and verification');
    expect(panel.getAttribute('data-mode')).toBe('docked');
    expect(panel.hasAttribute('inert')).toBe(false);
    expect(panel.getAttribute('role')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close details' })).toBeNull();
  });

  it('closed panel is inert with its content still rendered', () => {
    render(<Panel docked={false} open={false} onClose={() => {}} />);
    const panel = screen.getByLabelText('Pools and verification');
    expect(panel.hasAttribute('inert')).toBe(true);
    expect(panel.textContent).toContain('First inside');
  });

  it('open panel takes focus, keeps Tab inside, closes on Escape and returns focus', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(<Panel docked={false} open={false} onClose={onClose} />);
    const outside = screen.getByRole('button', { name: 'Outside' });
    outside.focus();
    rerender(<Panel docked={false} open onClose={onClose} />);
    const panel = screen.getByRole('dialog', { name: 'Pools and verification' });
    expect(document.activeElement).toBe(panel);
    const close = screen.getByRole('button', { name: 'Close details' });
    const last = screen.getByRole('link', { name: 'Last inside' });
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(last);
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<Panel docked={false} open={false} onClose={onClose} />);
    expect(document.activeElement).toBe(outside);
  });
});
