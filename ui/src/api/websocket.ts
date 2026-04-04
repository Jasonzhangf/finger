/**
 * WebSocket Client - 实时消息订阅
 */

import type { WsMessage } from './types.js';

type MessageHandler = (msg: WsMessage) => void;
type ErrorHandler = (err: Event) => void;

function readWsUrlOverrideFromLocation(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const value = params.get('ws') ?? params.get('ws_url') ?? params.get('wsUrl');
    if (!value) return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function readWsUrlOverrideFromStorage(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = window.localStorage?.getItem('finger-ui-ws-url');
    if (!value) return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function readWsUrlOverrideFromGlobal(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const value = (window as unknown as { __FINGER_WS_URL?: unknown }).__FINGER_WS_URL;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

function resolveDefaultWebSocketUrl(): string {
  const fallback = 'ws://127.0.0.1:9998';
  if (typeof window === 'undefined') return fallback;

  const explicitOverride = readWsUrlOverrideFromLocation()
    ?? readWsUrlOverrideFromStorage()
    ?? readWsUrlOverrideFromGlobal();
  if (explicitOverride) return explicitOverride;

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const hostname = window.location.hostname || '127.0.0.1';
  const pagePort = window.location.port;

  // Local dev: HTTP UI on :9999, WS daemon on :9998.
  if (pagePort === '9999') {
    return `${protocol}//${hostname}:9998`;
  }

  // Remote/proxied deployments usually expose a single port.
  // Prefer same-origin websocket to avoid fixed-port failures.
  if (window.location.host && window.location.host.trim().length > 0) {
    return `${protocol}//${window.location.host}`;
  }

  return `${protocol}//${hostname}${pagePort ? `:${pagePort}` : ''}`;
}

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectInterval: number;
  private maxReconnectAttempts: number;
  private reconnectAttempts = 0;
  private messageHandlers: Set<MessageHandler> = new Set();
  private errorHandlers: Set<ErrorHandler> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connecting: Promise<void> | null = null;
  clientId: string | null = null;

 constructor(
   url: string = 'ws://localhost:9998',
   options: { reconnectInterval?: number; maxReconnectAttempts?: number } = {}
 ) {
   this.url = url;
   this.reconnectInterval = options.reconnectInterval ?? 3000;
   this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
 }

 connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    if (this.ws && this.ws.readyState === WebSocket.CONNECTING && this.connecting) {
      return this.connecting;
    }
    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = new Promise((resolve, reject) => {
      try {
        const socket = new WebSocket(this.url);
        this.ws = socket;

        socket.onopen = () => {
          if (this.ws !== socket) {
            try {
              socket.close();
            } catch {
              // ignore
            }
            return;
          }
          console.log('[WS] Connected to', this.url);
          this.reconnectAttempts = 0;
          this.connecting = null;

          try {
            socket.send(JSON.stringify({
              type: 'subscribe',
              types: [
                'workflow_update',
                'task_update',
                'agent_update',
                'task_started',
                'task_completed',
                'task_failed',
                'tool_call',
                'tool_result',
                'tool_error',
                'chat_codex_turn',
                'user_message',
                'assistant_chunk',
                'assistant_complete',
                'waiting_for_user',
                'phase_transition',
                'workflow_progress',
                'input_lock_changed',
                'typing_indicator',
                'agent_runtime_catalog',
                'agent_runtime_dispatch',
                'agent_runtime_control',
                'agent_runtime_status',
                'resource_update',
                'session_created',
                'session_resumed',
                'session_paused',
                'session_compressed',
                'session_changed',
                'messageCreated',
                'messageCompleted',
                'performance_metrics',
              ],
              groups: ['SESSION', 'TASK', 'TOOL', 'DIALOG', 'PROGRESS', 'PHASE', 'HUMAN_IN_LOOP', 'SYSTEM', 'INPUT_LOCK', 'AGENT_RUNTIME'],
            }));
          } catch (err) {
            console.error('[WS] Failed to send subscribe:', err);
          }
          resolve();
        };

        socket.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data) as WsMessage;

            // 处理 client_id_assigned 消息
            if (msg.type === 'client_id_assigned') {
              if (typeof msg.clientId === 'string' && msg.clientId.trim().length > 0) {
                this.clientId = msg.clientId;
                console.log('[WS] Assigned clientId:', this.clientId);
              }
            }

            this.messageHandlers.forEach((h) => h(msg));
          } catch {
            console.warn('[WS] Failed to parse message:', event.data);
          }
        };

        socket.onerror = (err) => {
          if (this.ws !== socket) return;
          console.error('[WS] Error:', err);
          this.errorHandlers.forEach((h) => h(err));
        };

        socket.onclose = () => {
          if (this.ws !== socket) return;
          console.log('[WS] Disconnected');
          this.ws = null;
          this.connecting = null;
          this.scheduleReconnect();
        };
      } catch (err) {
        this.connecting = null;
        reject(err);
      }
    });

    return this.connecting;
 }

 private scheduleReconnect(): void {
   if (this.reconnectTimer) return;
   if (this.reconnectAttempts >= this.maxReconnectAttempts) {
     console.warn('[WS] Max reconnect attempts reached');
     return;
   }
   this.reconnectAttempts++;
   console.log(`[WS] Reconnecting in ${this.reconnectInterval}ms (attempt ${this.reconnectAttempts})`);
   this.reconnectTimer = setTimeout(() => {
     this.reconnectTimer = null;
     this.connect().catch((e) => console.error('[WS] Reconnect failed:', e));
   }, this.reconnectInterval);
 }

 disconnect(): void {
   if (this.reconnectTimer) {
     clearTimeout(this.reconnectTimer);
     this.reconnectTimer = null;
   }
    this.connecting = null;
   if (this.ws) {
     this.ws.close();
     this.ws = null;
   }
 }

 onMessage(handler: MessageHandler): () => void {
   this.messageHandlers.add(handler);
   return () => this.messageHandlers.delete(handler);
 }

 onError(handler: ErrorHandler): () => void {
   this.errorHandlers.add(handler);
   return () => this.errorHandlers.delete(handler);
 }

 send(msg: unknown): void {
   if (this.ws && this.ws.readyState === WebSocket.OPEN) {
     this.ws.send(JSON.stringify(msg));
   } else {
     console.warn('[WS] Not connected, cannot send');
   }
 }

 isConnected(): boolean {
   return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
 }

 getClientId(): string | null {
   return this.clientId;
 }
}

// Singleton instance
let wsInstance: WebSocketClient | null = null;

export function getWebSocket(): WebSocketClient {
  if (!wsInstance) {
    wsInstance = new WebSocketClient(resolveDefaultWebSocketUrl());
  }
  return wsInstance;
}
