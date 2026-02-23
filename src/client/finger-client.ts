/**
 * FingerClient SDK
 * 
 * 统一的客户端 SDK，支持：
 * - HTTP API 调用
 * - WebSocket 实时订阅
 * - 用户决策响应
 * - 会话管理
 */

import WebSocket from 'ws';

// ============================================================================
// Types
// ============================================================================

export interface FingerClientOptions {
  httpUrl?: string;
  wsUrl?: string;
  reconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
}

export interface WorkflowState {
  workflowId: string;
  fsmState: string;
  simplifiedStatus: string;
  context: Record<string, unknown>;
  timestamp: string;
}

export interface RuntimeEvent {
  type: string;
  sessionId: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface UserDecision {
  decisionId: string;
  workflowId: string;
  message: string;
  options?: string[];
  timestamp: string;
}

export interface AgentInfo {
  id: string;
  name: string;
  type: string;
  status: string;
  capabilities: string[];
}

export interface TaskInfo {
  id: string;
  name: string;
  status: string;
  agentId?: string;
  progress?: number;
  error?: string;
}

export type EventHandler = (event: RuntimeEvent) => void;
export type DecisionHandler = (decision: UserDecision) => Promise<string>;

// ============================================================================
// Connection States
// ============================================================================

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

// ============================================================================
// FingerClient Class
// ============================================================================

export class FingerClient {
  private httpUrl: string;
  private wsUrl: string;
  private ws: WebSocket | null = null;
  private connectionState: ConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  
  private readonly reconnect: boolean;
  private readonly reconnectInterval: number;
  private readonly maxReconnectAttempts: number;
  
  private eventHandlers: Map<string, Set<EventHandler>> = new Map();
  private wildcardHandlers: Set<EventHandler> = new Set();
  private decisionHandler: DecisionHandler | null = null;
  private pendingDecisions: Map<string, { resolve: (response: string) => void; reject: (err: Error) => void }> = new Map();
  
  private stateChangeCallbacks: Set<(state: ConnectionState) => void> = new Set();

  constructor(options: FingerClientOptions = {}) {
    this.httpUrl = options.httpUrl || process.env.FINGER_HTTP_URL || 'http://localhost:8080';
    this.wsUrl = options.wsUrl || process.env.FINGER_WS_URL || 'ws://localhost:5522';
    this.reconnect = options.reconnect ?? true;
    this.reconnectInterval = options.reconnectInterval ?? 3000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  async connect(): Promise<void> {
    if (this.connectionState === 'connected' || this.connectionState === 'connecting') {
      return;
    }

    this.setConnectionState('connecting');

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.wsUrl);

        this.ws.on('open', () => {
          this.setConnectionState('connected');
          this.reconnectAttempts = 0;
          this.subscribeToEvents();
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          this.handleMessage(data);
        });

        this.ws.on('close', () => {
          this.handleDisconnect();
        });

        this.ws.on('error', (err: Error) => {
          if (this.connectionState === 'connecting') {
            reject(err);
          }
          console.error('[FingerClient] WebSocket error:', err.message);
        });
      } catch (err) {
        this.setConnectionState('disconnected');
        reject(err);
      }
    });
  }

  disconnect(): void {
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.setConnectionState('disconnected');
  }

  getConnectionState(): ConnectionState {
    return this.connectionState;
  }

  onStateChange(callback: (state: ConnectionState) => void): () => void {
    this.stateChangeCallbacks.add(callback);
    return () => this.stateChangeCallbacks.delete(callback);
  }

  private setConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    this.stateChangeCallbacks.forEach(cb => cb(state));
  }

  private handleDisconnect(): void {
    if (this.connectionState === 'connected') {
      this.setConnectionState('disconnected');
    }

    if (this.reconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
      this.setConnectionState('reconnecting');
      this.reconnectAttempts++;
      console.log(`[FingerClient] Reconnecting in ${this.reconnectInterval}ms (attempt ${this.reconnectAttempts})`);
      
      this.reconnectTimer = setTimeout(() => {
        this.connect().catch(() => {
          // Reconnect failed, will retry
        });
      }, this.reconnectInterval);
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ============================================================================
  // Event Subscription
  // ============================================================================

  subscribe(eventTypes: string[], handler: EventHandler): () => void {
    eventTypes.forEach(type => {
      if (!this.eventHandlers.has(type)) {
        this.eventHandlers.set(type, new Set());
      }
      this.eventHandlers.get(type)!.add(handler);
    });

    // Return unsubscribe function
    return () => {
      eventTypes.forEach(type => {
        this.eventHandlers.get(type)?.delete(handler);
      });
    };
  }

  subscribeAll(handler: EventHandler): () => void {
    this.wildcardHandlers.add(handler);
    return () => this.wildcardHandlers.delete(handler);
  }

  onDecision(handler: DecisionHandler): void {
    this.decisionHandler = handler;
  }

  private subscribeToEvents(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Subscribe to all event types we're interested in
    const eventTypes = Array.from(this.eventHandlers.keys());
    if (eventTypes.length > 0) {
      this.ws.send(JSON.stringify({
        type: 'subscribe',
        events: eventTypes,
      }));
    }

    // Also subscribe to user decision events
    this.ws.send(JSON.stringify({
      type: 'subscribe',
      groups: ['HUMAN_IN_LOOP'],
    }));
  }

  private handleMessage(data: WebSocket.Data): void {
    try {
      const message = JSON.parse(data.toString());
      
      if (message.type === 'user_decision_required') {
        this.handleUserDecision(message.payload);
      } else {
        this.dispatchEvent(message);
      }
    } catch (err) {
      console.error('[FingerClient] Failed to parse message:', err);
    }
  }

  private dispatchEvent(event: RuntimeEvent): void {
    // Dispatch to specific handlers
    const handlers = this.eventHandlers.get(event.type);
    if (handlers) {
      handlers.forEach(h => {
        try {
          h(event);
        } catch (err) {
          console.error('[FingerClient] Handler error:', err);
        }
      });
    }

    // Dispatch to wildcard handlers
    this.wildcardHandlers.forEach(h => {
      try {
        h(event);
      } catch (err) {
        console.error('[FingerClient] Wildcard handler error:', err);
      }
    });
  }

  private async handleUserDecision(payload: UserDecision): Promise<void> {
    if (this.decisionHandler) {
      try {
        const response = await this.decisionHandler(payload);
        await this.respondDecision(payload.decisionId, response);
      } catch (err) {
        console.error('[FingerClient] Decision handler error:', err);
      }
    }
  }

  // ============================================================================
  // HTTP API Calls
  // ============================================================================

  private async fetchAPI<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.httpUrl}${path}`;
    const res = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!res.ok) {
      const error = await res.text();
      throw new Error(`API error: ${res.status} - ${error}`);
    }

    return res.json() as Promise<T>;
  }

  // ============================================================================
  // Workflow Operations
  // ============================================================================

  async orchestrate(task: string, options: { blocking?: boolean; sessionId?: string } = {}): Promise<{ workflowId: string; messageId: string }> {
    const result = await this.fetchAPI<{ success: boolean; messageId: string; workflowId?: string }>('/api/v1/message', {
      method: 'POST',
      body: JSON.stringify({
        target: 'orchestrator-loop',
        message: { content: task },
        blocking: options.blocking ?? false,
        sender: options.sessionId,
      }),
    });

    return {
      workflowId: result.workflowId || result.messageId,
      messageId: result.messageId,
    };
  }

  async sendInput(workflowId: string, input: string): Promise<void> {
    await this.fetchAPI('/api/v1/workflow/input', {
      method: 'POST',
      body: JSON.stringify({ workflowId, input }),
    });
  }

  async pause(workflowId: string): Promise<void> {
    await this.fetchAPI('/api/v1/workflow/pause', {
      method: 'POST',
      body: JSON.stringify({ workflowId }),
    });
  }

  async resume(workflowId: string): Promise<void> {
    await this.fetchAPI('/api/v1/workflow/resume', {
      method: 'POST',
      body: JSON.stringify({ workflowId }),
    });
  }

  async cancel(workflowId: string): Promise<void> {
    await this.fetchAPI('/api/v1/workflow/cancel', {
      method: 'POST',
      body: JSON.stringify({ workflowId }),
    });
  }

  async getStatus(workflowId: string): Promise<WorkflowState> {
    return this.fetchAPI<WorkflowState>(`/api/v1/workflows/${workflowId}/state`);
  }

  async listWorkflows(): Promise<WorkflowState[]> {
    const result = await this.fetchAPI<{ snapshots: WorkflowState[] }>('/api/v1/workflows/state');
    return result.snapshots;
  }

  // ============================================================================
  // User Decision
  // ============================================================================

  async respondDecision(decisionId: string, response: string): Promise<void> {
    await this.fetchAPI(`/api/v1/decision/${decisionId}/respond`, {
      method: 'POST',
      body: JSON.stringify({ response }),
    });

    // Resolve pending promise if exists
    const pending = this.pendingDecisions.get(decisionId);
    if (pending) {
      pending.resolve(response);
      this.pendingDecisions.delete(decisionId);
    }
  }

  async waitForDecision(decisionId: string, timeout = 60000): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingDecisions.delete(decisionId);
        reject(new Error('Decision timeout'));
      }, timeout);

      this.pendingDecisions.set(decisionId, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  // ============================================================================
  // Agent Operations
  // ============================================================================

  async listAgents(): Promise<AgentInfo[]> {
    const result = await this.fetchAPI<{ agents: AgentInfo[] }>('/api/v1/agents');
    return result.agents;
  }

  async getAgentCapabilities(agentId: string): Promise<string[]> {
    const result = await this.fetchAPI<{ capabilities: string[] }>(`/api/v1/agents/${agentId}/capabilities`);
    return result.capabilities;
  }

  // ============================================================================
  // Session Operations
  // ============================================================================

  async listResumableSessions(): Promise<Array<{ id: string; task: string; progress: number; timestamp: string }>> {
    const result = await this.fetchAPI<{ sessions: Array<{ id: string; task: string; progress: number; timestamp: string }> }>('/api/v1/sessions/resumable');
    return result.sessions;
  }

  async resumeSession(sessionId: string): Promise<void> {
    await this.fetchAPI(`/api/v1/sessions/${sessionId}/resume`, {
      method: 'POST',
    });
  }

  // ============================================================================
  // Event History
  // ============================================================================

  async getEventHistory(options: { type?: string; group?: string; limit?: number } = {}): Promise<RuntimeEvent[]> {
    const params = new URLSearchParams();
    if (options.type) params.set('type', options.type);
    if (options.group) params.set('group', options.group);
    if (options.limit) params.set('limit', String(options.limit));

    const result = await this.fetchAPI<{ events: RuntimeEvent[] }>(`/api/v1/events/history?${params}`);
    return result.events;
  }
}

// ============================================================================
// Default Export
// ============================================================================

export default FingerClient;
