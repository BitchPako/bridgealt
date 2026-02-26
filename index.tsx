
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { xmppService } from './services/xmppService';

if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__bridgeDebug = {
    ...(window.__bridgeDebug || {}),
    xmpp: {
      forceReconnectReset: () => xmppService.forceReconnectReset(),
      disconnectSoft: () => xmppService.disconnectSoft(),
      printReconnectState: () => xmppService.printReconnectState(),
    },
  };
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
