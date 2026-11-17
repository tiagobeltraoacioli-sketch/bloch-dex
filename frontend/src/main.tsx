import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/tokens.css';
import './styles/preview.css';
import './styles/postern.css';
import './styles/gate.css';
import { applyTheme, initialTheme } from './shell/theme';

applyTheme(initialTheme());

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
