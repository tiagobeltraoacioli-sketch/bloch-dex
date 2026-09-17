import { afterEach, describe, expect, it, vi } from 'vitest';
import { installMobileHandoffHotfix } from '../mobile-handoff-hotfix';
import { discoverWallets, METAMASK_MOBILE_URL } from '../wallet';
const cleanups: (() => void)[] = [];
function modal() {
  const dialog = document.createElement('dialog');
  dialog.className = 'modal';
  dialog.open = true;
  dialog.innerHTML =
    '<div class="modal-content"><div class="modal-header"><h2>Connect a wallet</h2></div><div class="wallet-options"></div><div class="wallet-empty"><h3>No browser wallet detected</h3></div></div>';
  document.body.append(dialog);
  return dialog;
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
  document.body.replaceChildren();
  vi.useRealTimers();
});
describe('pinned production mobile handoff', () => {
  it('adds a fixed Safari handoff inside the native modal, preserving React nodes', async () => {
    history.replaceState(null, '', '/?return=https://evil.example&token=secret');
    const dialog = modal();
    const original = dialog.querySelector('.wallet-empty');
    cleanups.push(installMobileHandoffHotfix());
    await flush();
    expect(dialog.querySelector('a')!.href).toBe(METAMASK_MOBILE_URL);
    expect(dialog.querySelector('.wallet-empty')).toBe(original);
    expect(dialog.querySelector('[data-postern-mobile-handoff]')!.nextElementSibling).toBe(
      dialog.querySelector('.wallet-options'),
    );
    expect(dialog.querySelectorAll('[data-postern-mobile-handoff]')).toHaveLength(1);
    expect(dialog.querySelector('a')!.getAttribute('aria-disabled')).toBe('false');
    expect(dialog.open).toBe(true);
  });
  it('announces delayed providers to discovery without RPC, retaining stable identity', async () => {
    vi.useFakeTimers();
    const discovered = vi.fn();
    const announcement = vi.fn();
    cleanups.push(discoverWallets(discovered));
    window.addEventListener('eip6963:announceProvider', announcement);
    cleanups.push(() => window.removeEventListener('eip6963:announceProvider', announcement));
    cleanups.push(installMobileHandoffHotfix());
    await vi.advanceTimersByTimeAsync(6000);
    const provider = { isMetaMask: true, request: vi.fn() };
    window.ethereum = provider;
    window.dispatchEvent(new Event('ethereum#initialized'));
    window.dispatchEvent(new Event('pageshow'));
    expect(discovered).toHaveBeenCalledTimes(1);
    expect(discovered.mock.calls[0][0].provider).toBe(provider);
    const first = (announcement.mock.calls[0][0] as CustomEvent).detail;
    const second = (announcement.mock.calls[1][0] as CustomEvent).detail;
    expect(first.info.uuid).toBe(second.info.uuid);
    expect(first.provider).toBe(provider);
    expect(provider.request).not.toHaveBeenCalled();
  });
  it('opens only the header modal once for the marker and never authorizes or loops', async () => {
    history.replaceState(null, '', '/?connect=metamask');
    document.body.innerHTML =
      '<header class="topbar"><button class="connect-button">Connect wallet</button></header>';
    const open = vi.fn(() => modal());
    document.querySelector('button')!.addEventListener('click', open);
    window.ethereum = { isMetaMask: true, request: vi.fn() };
    cleanups.push(installMobileHandoffHotfix());
    await flush();
    window.dispatchEvent(new Event('focus'));
    expect(open).toHaveBeenCalledTimes(1);
    expect(window.ethereum.request).not.toHaveBeenCalled();
    expect(
      document
        .querySelector('dialog a')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
    ).toBe(false);
  });
  it('disables handoff and retry during pending authorization', async () => {
    const dialog = modal();
    dialog.querySelector('.wallet-options')!.innerHTML =
      '<button class="wallet-option" disabled>Connect MetaMask</button>';
    cleanups.push(installMobileHandoffHotfix());
    await flush();
    const link = dialog.querySelector('a')!;
    expect(link.getAttribute('aria-disabled')).toBe('true');
    expect(link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(
      false,
    );
    expect(
      dialog.querySelector<HTMLButtonElement>('[data-postern-mobile-handoff] button')!.disabled,
    ).toBe(true);
    dialog.querySelector<HTMLButtonElement>('.wallet-option')!.disabled = false;
    await flush();
    expect(link.getAttribute('aria-disabled')).toBe('false');
  });
  it('removes supplemental controls when the same dialog becomes connected', async () => {
    const dialog = modal();
    cleanups.push(installMobileHandoffHotfix());
    dialog.querySelector('h2')!.textContent = 'Connected wallet';
    await flush();
    expect(dialog.querySelector('[data-postern-mobile-handoff]')).toBeNull();
    expect(dialog.open).toBe(true);
  });
  it('survives React replacement and removes nodes, events and timers on cleanup', async () => {
    vi.useFakeTimers();
    const dialog = modal();
    const stop = installMobileHandoffHotfix();
    cleanups.push(stop);
    dialog.querySelector('[data-postern-mobile-handoff]')!.remove();
    await flush();
    expect(dialog.querySelectorAll('[data-postern-mobile-handoff]')).toHaveLength(1);
    stop();
    window.ethereum = { request: vi.fn() };
    const announcement = vi.fn();
    window.addEventListener('eip6963:announceProvider', announcement);
    cleanups.push(() => window.removeEventListener('eip6963:announceProvider', announcement));
    window.dispatchEvent(new Event('ethereum#initialized'));
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    modal();
    await vi.runAllTimersAsync();
    await flush();
    expect(announcement).not.toHaveBeenCalled();
    expect(document.querySelector('[data-postern-mobile-handoff]')).toBeNull();
  });
});
