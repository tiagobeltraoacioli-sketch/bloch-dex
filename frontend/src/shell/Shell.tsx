import type { ReactNode, Ref } from 'react';

/**
 * The frame every route shares: brand, navigation, header actions, main
 * region and footer. Presentation only; routes pass their own content.
 */
export function Shell({
  brandLabel,
  navLabel,
  nav,
  actions,
  footer,
  children,
  after,
  skipLink,
  mainRef,
  mainFocusable = false,
}: {
  brandLabel: string;
  navLabel: string;
  nav: ReactNode;
  actions: ReactNode;
  footer: ReactNode;
  children: ReactNode;
  /** Dialogs and other siblings of the page regions. */
  after?: ReactNode;
  skipLink?: ReactNode;
  mainRef?: Ref<HTMLElement>;
  mainFocusable?: boolean;
}) {
  return (
    <div className="app-shell">
      {skipLink}
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#/trade" aria-label={brandLabel}>
            <img src={`${import.meta.env.BASE_URL}postern.svg`} alt="" width="38" height="38" />
            <span>POSTERN</span>
          </a>
          <nav className="main-nav" aria-label={navLabel}>
            {nav}
          </nav>
          {actions}
        </div>
      </header>
      <main
        id="main-content"
        ref={mainRef}
        tabIndex={mainFocusable ? -1 : undefined}
        className="main-content"
      >
        {children}
      </main>
      <footer className="footer">
        <div className="footer-inner">{footer}</div>
      </footer>
      {after}
    </div>
  );
}
