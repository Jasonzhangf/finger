import { useCallback, useRef, useState, useEffect } from 'react';
import { getWebSocket } from '../api/websocket.js';
import type { WsMessage } from '../api/types.js';

export function useWebSocket(onMessage: (msg: WsMessage) => void) {
  const wsRef = useRef(getWebSocket());
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    const ws = wsRef.current;
    
    const connect = async () => {
      try {
        await ws.connect();
        setIsConnected(true);
      } catch (e) {
        console.error('WebSocket connect error:', e);
        setIsConnected(false);
      }
    };

    if (!ws.isConnected()) {
      connect();
    } else {
      setIsConnected(true);
    }

    const unsubscribe = ws.onMessage((msg) => {
      onMessage(msg);
    });

    return () => {
      unsubscribe();
    };
  }, [onMessage]);

  return {
    isConnected: () => isConnected,
    send: useCallback((msg: unknown) => {
      wsRef.current.send(msg);
    }, []),
  };
}
