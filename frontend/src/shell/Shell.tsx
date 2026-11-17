import type { ReactNode, Ref } from 'react';
import { BrandMark } from './BrandMark';
import { ThemeToggle } from './ThemeToggle';
import { Toaster } from '../ui/toast';
import type { NetworkKey } from './networks';
import { NetworkKeyContext } from './network-context';

/**
 * The frame every route shares: brand, navigation, header actions (network,
 * wallet, theme), main region and footer. Presentation only; routes pass
 * their own content. `network` selects the lamp colour (styles/tokens.css).
 */
export function Shell({
  network,
  brandLabel,
  homeHref = '#/trade',
  navLabel,
  nav,
  actions,
  footer,
  children,
  after,
  mainRef,
}: {
  network: NetworkKey;
  brandLabel: string;
  /** Where the brand links (the Bloch L2 site's preview by default). */
  homeHref?: string;
  navLabel: string;
  nav: ReactNode;
  actions: ReactNode;
  footer: ReactNode;
  children: ReactNode;
  /** Dialogs and other siblings of the page regions. */
  after?: ReactNode;
  mainRef?: Ref<HTMLElement>;
}) {
  return (
    <div className="app-shell" data-network={network}>
      <a
        href="#main-content"
        className="skip-link"
        onClick={(e) => {
          // Routes live in the hash: move focus without changing it.
          e.preventDefault();
          document.getElementById('main-content')?.focus();
        }}
      >
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href={homeHref} aria-label={brandLabel}>
            <BrandMark />
            <span className="wordmark">Postern</span>
          </a>
          <nav className="main-nav" aria-label={navLabel}>
            {nav}
          </nav>
          <div className="header-actions">
            {actions}
            <ThemeToggle />
          </div>
        </div>
        <div className="lintel" aria-hidden="true" />
      </header>
      <main id="main-content" ref={mainRef} tabIndex={-1} className="main-content">
        <NetworkKeyContext.Provider value={network}>{children}</NetworkKeyContext.Provider>
      </main>
      <footer className="footer">
        <div className="footer-inner">
          {footer}
          {/* Third-party licences and notices (docs/LICENSING.md), shipped by both builds. */}
          <a className="footer-licences" href="./THIRD-PARTY-NOTICES.txt">
            Licences
          </a>
        </div>
      </footer>
      {after}
      <Toaster />
      {/* The wall: lit courses and the lamp's pool of light, placed by the gate (styles/gate.css). */}
      <div className="wall-light" aria-hidden="true" />
    </div>
  );
}
