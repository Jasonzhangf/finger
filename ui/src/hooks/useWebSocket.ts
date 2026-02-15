import { useEffect, useRef } from 'react';
import { getWebSocket } from '../api/websocket.js';
import type { WsMessage } from '../api/types.js';

type MessageHandler = (msg: WsMessage) => void;

export function useWebSocket(onMessage?: MessageHandler): {
  send: (msg: unknown) => void;
  isConnected: () => boolean;
} {
  const ws = getWebSocket();
  const unsubscribeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!ws.isConnected()) {
      ws.connect().catch((e) => console.error('[WS] Connection failed:', e));
    }

    if (onMessage) {
      unsubscribeRef.current = ws.onMessage(onMessage);
    }

    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
      }
    };
  }, [ws, onMessage]);

  const send = (msg: unknown) => {
    ws.send(msg);
  };

  const isConnected = () => ws.isConnected();

  return { send, isConnected };
}
