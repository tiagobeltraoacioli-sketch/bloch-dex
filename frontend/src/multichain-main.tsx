import React from 'react';
import ReactDOM from 'react-dom/client';
import MultichainApp from './MultichainApp';
import './styles/tokens.css';
import './styles/preview.css';
import './styles/postern.css';
import './styles/gate.css';
import { applyTheme, initialTheme } from './shell/theme';

applyTheme(initialTheme());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MultichainApp />
  </React.StrictMode>,
);
