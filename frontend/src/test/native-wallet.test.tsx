import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import NativeMarket from '../NativeMarket';
import { nativeProvider, reportedNativeAccount, type NativeProvider } from '../nativeWallet';

const address = 'bloch1q' + '12'.repeat(24);
function install(
  request = vi.fn(
    async (method: string): Promise<unknown> =>
      method === 'bloch_connect' ? { connected: true } : { address },
  ),
) {
  window.bloch = {
    isBloch: true,
    chain: 'bloch-genesis4',
    signatureSuite: 'ml-dsa-65+falcon-1024',
    request,
  };
  return request;
}
afterEach(() => vi.useRealTimers());
describe('native L1 wallet account access', () => {
  it('navigates to L1 without discovering accounts or using an EVM provider', async () => {
    const request = install();
    const evm = vi.fn();
    window.ethereum = { request: evm };
    render(<App />);
    await userEvent.setup().click(screen.getByRole('link', { name: 'Bloch L1' }));
    act(() => window.dispatchEvent(new HashChangeEvent('hashchange')));
    await screen.findByRole('heading', { name: 'Native BLCH / USDT' });
    expect(request).not.toHaveBeenCalled();
    expect(evm).not.toHaveBeenCalled();
    expect(screen.getByText(/Deposits, pool launch and trading are not enabled/)).toBeTruthy();
  });
  it('uses the native string-method protocol only after user action and refreshes explicitly', async () => {
    const request = install();
    render(<NativeMarket />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Connect Postern Wallet' }));
    await screen.findByText(address);
    expect(request.mock.calls.map(([m]) => m)).toEqual(['bloch_connect', 'bloch_getAccount']);
    await user.click(screen.getByRole('button', { name: 'Refresh L1 account' }));
    await screen.findByText(address);
    expect(request.mock.calls.map(([m]) => m)).toEqual([
      'bloch_connect',
      'bloch_getAccount',
      'bloch_getAccount',
    ]);
    await user.click(screen.getByRole('button', { name: 'Disconnect L1 wallet' }));
    expect(request.mock.calls.at(-1)?.[0]).toBe('bloch_disconnect');
    expect(screen.queryByText(address)).toBeNull();
  });
  it('does not adapt MetaMask or an incompatible native provider', async () => {
    const evm = vi.fn();
    window.ethereum = { isMetaMask: true, request: evm };
    render(<NativeMarket />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Connect Postern Wallet' }));
    expect(screen.getByRole('status').textContent).toContain('not detected');
    expect(evm).not.toHaveBeenCalled();
    window.bloch = { isBloch: true, chain: 'evm', request: evm } as unknown as NativeProvider;
    expect(nativeProvider()).toBeNull();
  });
  it('rejects unsuccessful permission and malformed, EVM or absent accounts', async () => {
    const request = install(vi.fn(async () => ({ connected: false })));
    render(<NativeMarket />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Connect Postern Wallet' }));
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toContain('not completed');
    for (const value of [
      null,
      {},
      { address: '0x' + 'ab'.repeat(20) },
      { address: address + 'x' },
      { address: '<script>' },
    ]) {
      expect(() => reportedNativeAccount(value)).toThrow();
    }
  });
  it('ignores a late connection after dismissal or unmount', async () => {
    let resolve!: (value: unknown) => void;
    const request = install(
      vi.fn(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
    );
    const view = render(<NativeMarket />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Postern Wallet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss request' }));
    await act(async () => resolve({ connected: true }));
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(address)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Postern Wallet' }));
    view.unmount();
    await act(async () => resolve({ connected: true }));
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('times out locally and ignores later wallet approval', async () => {
    vi.useFakeTimers();
    let resolve!: (value: unknown) => void;
    const request = install(
      vi.fn(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
    );
    render(<NativeMarket />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Postern Wallet' }));
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByRole('status').textContent).toContain('not responded');
    await act(async () => resolve({ connected: true }));
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('clears cached identity when hidden and handles wallet-side permission errors', async () => {
    const request = install();
    render(<NativeMarket />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Connect Postern Wallet' }));
    await screen.findByText(address);
    const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    fireEvent(document, new Event('visibilitychange'));
    expect(screen.queryByText(address)).toBeNull();
    state.mockRestore();
    request.mockRejectedValue(new Error('wallet locked'));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Connect Postern Wallet' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('not completed'));
  });
});
