import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import App from '../App';

function navigate(page: string) {
  act(() => {
    history.replaceState(null, '', `/#/${page}`);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}

describe('Postern preview workflows', () => {
  it('calculates swap previews and blocks invalid and dust inputs', async () => {
    const user = userEvent.setup();
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Every trade, in view.' })).toBeTruthy();
    const initial = screen.getByLabelText('Estimated output').textContent;
    await user.clear(screen.getByLabelText('You pay'));
    await user.type(screen.getByLabelText('You pay'), '2000');
    expect(screen.getByLabelText('Estimated output').textContent).not.toBe(initial);
    await user.click(screen.getByRole('button', { name: /Review demo swap/ }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/No approval, signature or transaction/)).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    await user.clear(screen.getByLabelText('You pay'));
    await user.type(screen.getByLabelText('You pay'), '1e5');
    expect(
      (screen.getByRole('button', { name: /Review demo swap/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole('alert').textContent).toMatch(/valid amount/);
    fireEvent.change(screen.getByLabelText('You pay'), {
      target: { value: '0.000000000000000001' },
    });
    expect(
      (screen.getByRole('button', { name: /Review demo swap/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
  it('changes token selection and reverses the pair without silently truncating amounts', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Select pay token' }));
    await user.type(screen.getByLabelText('Search tokens'), 'WETH');
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', {
        name: 'Select WETH, Wrapped Ether',
      }),
    );
    expect((screen.getByLabelText('You pay') as HTMLInputElement).value).toBe('');
    await user.type(screen.getByLabelText('You pay'), '1');
    expect(screen.getByRole('heading', { name: 'WETH / USDC' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Reverse token pair' }));
    expect(screen.getByRole('heading', { name: 'USDC / WETH' })).toBeTruthy();
    expect(Number((screen.getByLabelText('You pay') as HTMLInputElement).value)).toBeGreaterThan(
      2300,
    );
  });
  it('validates slippage and persists only the preference', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: 'Swap settings' }));
    const input = screen.getByLabelText('Slippage tolerance (%)');
    await user.clear(input);
    await user.type(input, '99');
    expect(
      (screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    await user.clear(input);
    await user.type(input, '0.29');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(localStorage.getItem('postern.slippage.v1')).toBe('29');
    expect(screen.getByRole('button', { name: '0.29%' })).toBeTruthy();
  });
  it('filters pools, sorts activity and saves a device-local watchlist', async () => {
    const user = userEvent.setup();
    render(<App />);
    navigate('pools');
    await user.click(screen.getByRole('button', { name: 'Watch BLCH / USDC' }));
    await user.click(screen.getByRole('button', { name: /Watchlist/ }));
    expect(screen.getByText('Showing 1 of 4 pools')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem('postern.watchlist.v1')!)).toEqual(['blch-usdc']);
    await user.type(screen.getByLabelText('Search pools'), 'unknown');
    expect(screen.getByRole('heading', { name: 'No matching pools.' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Show all pools' }));
    await user.selectOptions(screen.getByLabelText('Sort pools'), 'volume');
    expect(within(screen.getAllByRole('row')[1]).getByText('WETH / USDC')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'View BLCH / USDC pool' }));
    await user.click(screen.getByRole('button', { name: /Preview adding liquidity/ }));
    await user.click(screen.getByRole('button', { name: 'Review deposit' }));
    expect(
      within(screen.getByRole('dialog')).getByText(/does not update your position/),
    ).toBeTruthy();
  });
  it('previews a proportional withdrawal and keeps the sample portfolio unchanged', async () => {
    const user = userEvent.setup();
    render(<App />);
    navigate('portfolio');
    await user.click(screen.getByRole('button', { name: 'Remove liquidity' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '50%' }));
    expect(within(screen.getByRole('dialog')).getByText('3120')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Review withdrawal' }));
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByText('$12,480.00')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Position opened/ }));
    expect(
      within(screen.getByRole('dialog')).getByText(/No transaction was submitted/),
    ).toBeTruthy();
  });
  it('never requests a wallet automatically and distinguishes sample data after connection', async () => {
    const methods: string[] = [];
    window.ethereum = {
      request: async ({ method }) => {
        methods.push(method);
        return method === 'eth_requestAccounts' ? ['0x' + '12'.repeat(20)] : '0x1';
      },
    };
    const user = userEvent.setup();
    render(<App />);
    expect(methods).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Connect wallet' }));
    await user.click(await screen.findByRole('button', { name: 'Connect Browser wallet' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Connected wallet' })).toBeTruthy(),
    );
    expect(methods).toEqual(['eth_requestAccounts', 'eth_chainId']);
    expect(screen.getByText(/Quotes and positions remain sample data/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Disconnect from this app' }));
    expect(screen.getByRole('heading', { name: 'Connect a wallet' })).toBeTruthy();
  });
  it('recovers from invalid stored preferences and closes dialogs on Escape events', async () => {
    localStorage.setItem('postern.slippage.v1', '99999');
    localStorage.setItem('postern.watchlist.v1', '{broken');
    const user = userEvent.setup();
    render(<App />);
    expect(screen.getByRole('button', { name: '0.50%' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Swap settings' }));
    fireEvent(
      screen.getByRole('dialog'),
      new Event('cancel', { bubbles: false, cancelable: true }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    const picker = screen.getByRole('button', { name: 'Select pay token' });
    await user.click(picker);
    await user.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(document.activeElement).toBe(picker);
    navigate('pools');
    expect(screen.getByText('Showing 4 of 4 pools')).toBeTruthy();
  });
});
