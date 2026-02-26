interface ImportMetaEnv {
  readonly DEV: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __APP_VERSION__: string;

type BridgeXmppDebugApi = {
  forceReconnectReset: () => void;
  disconnectSoft: () => void;
  printReconnectState: () => {
    status: 'CONNECTED' | 'CONNECTING' | 'DISCONNECTED';
    reconnectWorkflowActive: boolean;
    reconnectInFlight: boolean;
    reconnectAttempts: number;
    activeReconnectAttemptId: number | null;
    hasReconnectTimer: boolean;
    hasReconnectGuardTimer: boolean;
    isExplicitDisconnect: boolean;
    hasSessionCredentials: boolean;
    isE2EEReady: boolean;
  };
};

interface Window {
  __bridgeDebug?: {
    xmpp?: BridgeXmppDebugApi;
  };
}
