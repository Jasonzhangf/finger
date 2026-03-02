/**
 * WebSocket Client - 实时消息订阅
 */

import type { WsMessage } from './types.js';

type MessageHandler = (msg: WsMessage) => void;
type ErrorHandler = (err: Event) => void;

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectInterval: number;
  private maxReconnectAttempts: number;
  private reconnectAttempts = 0;
  private messageHandlers: Set<MessageHandler> = new Set();
  private errorHandlers: Set<ErrorHandler> = new Set();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  clientId: string | null = null;

 constructor(
   url: string = 'ws://localhost:5522',
   options: { reconnectInterval?: number; maxReconnectAttempts?: number } = {}
 ) {
   this.url = url;
   this.reconnectInterval = options.reconnectInterval ?? 3000;
   this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
 }

 connect(): Promise<void> {
   return new Promise((resolve, reject) => {
     try {
       this.ws = new WebSocket(this.url);

       this.ws.onopen = () => {
         console.log('[WS] Connected to', this.url);
         this.reconnectAttempts = 0;

          // Subscribe to both legacy workflow stream and grouped EventBus stream.
          this.ws?.send(JSON.stringify({
            type: 'subscribe',
            types: [
              'workflow_update',
              'agent_update',
              'task_started',
              'task_completed',
              'task_failed',
              'tool_call',
              'tool_result',
              'tool_error',
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
            ],
            groups: ['SESSION', 'TASK', 'TOOL', 'DIALOG', 'PROGRESS', 'PHASE', 'HUMAN_IN_LOOP', 'SYSTEM', 'INPUT_LOCK', 'AGENT_RUNTIME'],
          }));
         resolve();
       };

	       this.ws.onmessage = (event) => {
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
         } catch (e) {
           console.warn('[WS] Failed to parse message:', event.data);
         }
       };

       this.ws.onerror = (err) => {
         console.error('[WS] Error:', err);
         this.errorHandlers.forEach((h) => h(err));
       };

       this.ws.onclose = () => {
         console.log('[WS] Disconnected');
         this.scheduleReconnect();
       };
     } catch (err) {
       reject(err);
     }
   });
 }

 private scheduleReconnect(): void {
   if (this.reconnectAttempts >= this.maxReconnectAttempts) {
     console.warn('[WS] Max reconnect attempts reached');
     return;
   }
   this.reconnectAttempts++;
   console.log(`[WS] Reconnecting in ${this.reconnectInterval}ms (attempt ${this.reconnectAttempts})`);
   this.reconnectTimer = setTimeout(() => {
     this.connect().catch((e) => console.error('[WS] Reconnect failed:', e));
   }, this.reconnectInterval);
 }

 disconnect(): void {
   if (this.reconnectTimer) {
     clearTimeout(this.reconnectTimer);
     this.reconnectTimer = null;
   }
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
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.hostname;
    const port = 5522;
    wsInstance = new WebSocketClient(`${protocol}//${host}:${port}`);
  }
  return wsInstance;
}
