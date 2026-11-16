import type { ReactNode, Ref } from 'react';
import { BrandMark } from './BrandMark';
import { ThemeToggle } from './ThemeToggle';
import { Toaster } from '../ui/toast';
import type { NetworkKey } from './networks';

/**
 * The frame every route shares: brand, navigation, header actions (network,
 * wallet, theme), main region and footer. Presentation only; routes pass
 * their own content. `network` selects the lamp colour (styles/tokens.css).
 */
export function Shell({
  network,
  brandLabel,
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
          <a className="brand" href="#/trade" aria-label={brandLabel}>
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
        {children}
      </main>
      <footer className="footer">
        <div className="footer-inner">{footer}</div>
      </footer>
      {after}
      <Toaster />
    </div>
  );
}
