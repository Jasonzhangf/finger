import { WebSocketServer, type WebSocket } from 'ws';
import type { UnifiedEventBus } from '../../runtime/event-bus.js';
import type { InputLockManager } from '../../runtime/input-lock.js';
import type { Mailbox } from '../mailbox.js';

export interface WebSocketServerDeps {
  port: number;
  serverPort: number;
  eventBus: UnifiedEventBus;
  mailbox: Mailbox;
  inputLockManager: InputLockManager;
  registerStateBridgeClient?: (ws: WebSocket) => void;
  unregisterStateBridgeClient?: (ws: WebSocket) => void;
}

export interface WebSocketServerRuntime {
  wss: WebSocketServer;
  wsClients: Set<WebSocket>;
  broadcast: (message: Record<string, unknown>) => void;
}

interface WebSocketWithClientId extends WebSocket {
  clientId?: string;
}

function generateClientId(): string {
  return `client_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function createWebSocketServer(deps: WebSocketServerDeps): WebSocketServerRuntime {
  const { port, serverPort, eventBus, mailbox, inputLockManager, registerStateBridgeClient, unregisterStateBridgeClient } = deps;
  const wss = new WebSocketServer({ port });
  const wsClients: Set<WebSocket> = new Set();

  const broadcast = (message: Record<string, unknown>): void => {
    const encoded = JSON.stringify(message);
    for (const client of wsClients) {
      if (client.readyState === 1) {
        client.send(encoded);
      }
    }
  };

  console.log(`[Server] Starting WebSocket server on port ${port} (PORT=${serverPort})`);

  wss.on('connection', (ws: WebSocketWithClientId) => {
    wsClients.add(ws);
    ws.clientId = generateClientId();
    console.log('[Server] WebSocket client connected, total clients:', wsClients.size, 'clientId:', ws.clientId);
    eventBus.registerWsClient(ws);
    if (registerStateBridgeClient) {
      registerStateBridgeClient(ws as WebSocket);
    }

    ws.send(JSON.stringify({
      type: 'client_id_assigned',
      clientId: ws.clientId,
      timestamp: new Date().toISOString(),
    }));

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'subscribe') {
          const types = msg.types || msg.events || [];
          const groups = msg.groups || [];

          if (groups.length > 0 || types.length > 0) {
            eventBus.setWsClientFilter(ws, { types, groups });
            ws.send(JSON.stringify({
              type: 'subscribe_confirmed',
              types,
              groups,
              timestamp: new Date().toISOString(),
            }));
          } else if (msg.messageId) {
            mailbox.subscribe(msg.messageId, (m) => {
              ws.send(JSON.stringify({ type: 'messageUpdate', message: m }));
            });
          }
        } else if (msg.type === 'unsubscribe') {
          eventBus.setWsClientFilter(ws, {});
          ws.send(JSON.stringify({ type: 'unsubscribe_confirmed', timestamp: new Date().toISOString() }));
        } else if (msg.type === 'input_lock_acquire') {
          const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
          if (!sessionId) {
            ws.send(JSON.stringify({
              type: 'input_lock_result',
              sessionId: '',
              acquired: false,
              clientId: ws.clientId,
              error: 'sessionId is required',
              timestamp: new Date().toISOString(),
            }));
            return;
          }
          const acquired = inputLockManager.acquire(sessionId, ws.clientId!);
          ws.send(JSON.stringify({
            type: 'input_lock_result',
            sessionId,
            acquired,
            clientId: ws.clientId,
            state: inputLockManager.getState(sessionId),
            timestamp: new Date().toISOString(),
          }));
        } else if (msg.type === 'input_lock_heartbeat') {
          const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
          if (!sessionId) return;
          const alive = inputLockManager.heartbeat(sessionId, ws.clientId!);
          ws.send(JSON.stringify({
            type: 'input_lock_heartbeat_ack',
            sessionId,
            alive,
            clientId: ws.clientId,
            state: inputLockManager.getState(sessionId),
            timestamp: new Date().toISOString(),
          }));
        } else if (msg.type === 'input_lock_release') {
          const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
          if (!sessionId) return;
          inputLockManager.release(sessionId, ws.clientId!);
        } else if (msg.type === 'typing_indicator') {
          const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : '';
          if (!sessionId) return;
          inputLockManager.setTyping(sessionId, ws.clientId!, msg.typing === true);
        }
      } catch {
        // ignore
      }
    });

    ws.on('close', () => {
      inputLockManager.forceRelease(ws.clientId!);
      wsClients.delete(ws);
      if (unregisterStateBridgeClient) {
        unregisterStateBridgeClient(ws as WebSocket);
      }
    });
  });

  console.log(`[Server] WebSocket server running at ws://localhost:${port}`);
  const addresses = wss.address();
  console.log('[Server] WebSocket server bound to:', addresses);

  return { wss, wsClients, broadcast };
}
