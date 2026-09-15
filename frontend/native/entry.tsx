import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/inter';
import NativeMarket from '../src/NativeMarket';
import '../src/styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="app-shell">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="/">
            POSTERN
          </a>
          <a className="button secondary" href="/#/onchain">
            Back to EVM testnet
          </a>
        </div>
      </header>
      <main className="main-content">
        <NativeMarket developmentHref="/#/develop" />
      </main>
    </div>
  </React.StrictMode>,
);
