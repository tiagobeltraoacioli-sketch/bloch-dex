import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/inter';
import MultichainApp from './MultichainApp';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MultichainApp />
  </React.StrictMode>,
);
