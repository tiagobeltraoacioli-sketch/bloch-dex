import { METAMASK_MOBILE_URL, type Provider } from './wallet';

/** Compatibility layer for the pinned production release; never requests accounts. */
export function installMobileHandoffHotfix(): () => void {
  const owned = new Set<HTMLElement>();
  const identities = new WeakMap<Provider, string>();
  let stopped = false;
  let landingHandled = new URLSearchParams(location.search).get('connect') !== 'metamask';

  const announce = () => {
    if (stopped) return;
    const provider = window.ethereum;
    if (!provider || typeof provider.request !== 'function') return;
    let uuid = identities.get(provider);
    if (!uuid) {
      uuid = crypto.randomUUID();
      identities.set(provider, uuid);
    }
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: {
          info: {
            uuid,
            name: provider.isMetaMask === true ? 'MetaMask' : 'Browser wallet',
            // Provider identity is a presentation hint, not authenticated identity.
            rdns: provider.isMetaMask === true ? 'io.metamask' : 'local.injected',
            icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
          },
          provider,
        },
      }),
    );
  };
  const isPending = (dialog: Element) =>
    !!dialog.querySelector('.wallet-option:disabled') ||
    [...dialog.querySelectorAll('[role="status"]')].some((node) =>
      node.textContent?.includes('Confirm the connection in your wallet'),
    );

  const reconcile = () => {
    if (stopped) return;
    if (!landingHandled && !document.querySelector('dialog[open]')) {
      const button = document.querySelector<HTMLButtonElement>('header.topbar .connect-button');
      if (button && !button.disabled && button.textContent?.trim() === 'Connect wallet') {
        landingHandled = true;
        // This pinned release's header button opens a modal; it never calls a provider.
        button.click();
      }
    }
    for (const node of owned) {
      if (
        !node.isConnected ||
        node.closest('dialog')?.querySelector('.modal-header h2')?.textContent !==
          'Connect a wallet'
      ) {
        node.remove();
        owned.delete(node);
      }
    }
    for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog.modal[open]')) {
      if (dialog.querySelector('.modal-header h2')?.textContent !== 'Connect a wallet') continue;
      const content = dialog.querySelector<HTMLElement>('.modal-content');
      if (!content) continue;
      let container = [...owned].find((node) => node.parentElement === content);
      if (!container) {
        container = document.createElement('div');
        container.dataset.posternMobileHandoff = 'true';
        container.className = 'wallet-mobile-handoff';
        const link = document.createElement('a');
        link.className = 'button primary full-width';
        link.href = METAMASK_MOBILE_URL;
        link.textContent = 'Open MetaMask';
        link.addEventListener('click', (event) => {
          if (isPending(dialog) || window.ethereum?.isMetaMask === true) event.preventDefault();
        });
        const instructions = document.createElement('p');
        instructions.className = 'microcopy';
        instructions.textContent =
          'On iPhone Safari, open MetaMask, then select the wallet in this connection window and approve in the app. If the link does not open, use the MetaMask app browser to visit blochdex.com.';
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.className = 'button secondary full-width';
        retry.textContent = 'Check for wallet again';
        retry.addEventListener('click', () => {
          if (isPending(dialog)) return;
          window.dispatchEvent(new Event('eip6963:requestProvider'));
          announce();
          reconcile();
        });
        container.append(link, instructions, retry);
        owned.add(container);
        // Place the handoff before the empty-state explanation so Safari users see it
        // without scrolling. Only our own node is inserted; React retains its nodes.
        content.insertBefore(container, content.querySelector('.wallet-options'));
      }
      const pending = isPending(dialog);
      const link = container.querySelector('a')!;
      const disabled = pending || window.ethereum?.isMetaMask === true;
      if (link.getAttribute('aria-disabled') !== String(disabled)) {
        link.setAttribute('aria-disabled', String(disabled));
        link.tabIndex = disabled ? -1 : 0;
      }
      const retry = container.querySelector('button')!;
      if (retry.disabled !== pending) retry.disabled = pending;
      const instructions = container.querySelector('p')!;
      const text =
        window.ethereum?.isMetaMask === true
          ? 'MetaMask is available. Select it above to request connection, then approve in the app.'
          : 'On iPhone Safari, open MetaMask, then select the wallet in this connection window and approve in the app. If the link does not open, use the MetaMask app browser to visit blochdex.com.';
      if (instructions.textContent !== text) instructions.textContent = text;
    }
  };
  const refresh = () => {
    announce();
    reconcile();
  };
  const observer = new MutationObserver(reconcile);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['open', 'disabled'],
  });
  const events = ['ethereum#initialized', 'focus', 'pageshow'];
  events.forEach((event) => window.addEventListener(event, refresh));
  window.addEventListener('eip6963:requestProvider', announce);
  const timers = [0, 250, 500, 1000, 2000, 3000, 5000].map((delay) =>
    window.setTimeout(refresh, delay),
  );
  reconcile();
  return () => {
    stopped = true;
    observer.disconnect();
    timers.forEach((timer) => window.clearTimeout(timer));
    events.forEach((event) => window.removeEventListener(event, refresh));
    window.removeEventListener('eip6963:requestProvider', announce);
    owned.forEach((node) => node.remove());
    owned.clear();
  };
}
