/**
 * Test API - UI 自测系统统一接口
 * 与编排 app 统一状态，建立自动化测试系统
 */

import type { 
  RuntimeEvent, 
  WorkflowExecutionState,
  AgentState,
  WsMessage 
} from '../api/types.js';
import { getWebSocket, WebSocketClient } from '../api/websocket.js';

export interface TestAPI {
  startServer(): Promise<void>;
  stopServer(): Promise<void>;
  resetState(): Promise<void>;
  sendUserInput(text: string): Promise<void>;
  waitForAgentResponse(timeout?: number): Promise<RuntimeEvent[]>;
  getExecutionState(): Promise<WorkflowExecutionState>;
  subscribeToEvents(callback: (event: RuntimeEvent) => void): () => void;
  waitForWorkflowStatus(status: string, timeout?: number): Promise<boolean>;
  listAgents(): Promise<AgentState[]>;
}

class TestAPIImpl implements TestAPI {
  private ws: WebSocketClient | null = null;
  private eventSubscribers: Set<(event: RuntimeEvent) => void> = new Set();
  private collectedEvents: RuntimeEvent[] = [];
  private serverStarted = false;

  async startServer(): Promise<void> {
    // 检查服务器健康状态
    const health = await fetch('/health').catch(() => null);
    if (!health || !health.ok) {
      throw new Error('Server is not running. Please start server manually.');
    }
    this.serverStarted = true;
    
    // 建立 WebSocket 连接
    this.ws = getWebSocket();
    await this.ws.connect();
    
    // 订阅所有相关事件
    this.ws.onMessage((msg: WsMessage) => {
      if (msg.type === 'agent_update' || msg.type === 'workflow_update') {
        const event = this.convertWsMessageToRuntimeEvent(msg);
        this.collectedEvents.push(event);
        this.eventSubscribers.forEach(cb => cb(event));
      }
    });
  }

  async stopServer(): Promise<void> {
    if (this.ws) {
      this.ws.disconnect();
      this.ws = null;
    }
    this.serverStarted = false;
  }

  async resetState(): Promise<void> {
    this.collectedEvents = [];
    
    // 调用重置 API
    await fetch('/api/v1/test/reset', { 
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }).catch(() => {
      console.warn('Reset API not available, clearing local state only');
    });
  }

  async sendUserInput(text: string): Promise<void> {
    const response = await fetch('/api/v1/workflows/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        input: text,
        sessionId: 'test-session'
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to send input: ${response.statusText}`);
    }
  }

  async waitForAgentResponse(timeout = 30000): Promise<RuntimeEvent[]> {
    const startTime = Date.now();
    const initialCount = this.collectedEvents.length;
    
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        const newEvents = this.collectedEvents.slice(initialCount);
        
        // 检查是否收到 agent 响应
        const hasAgentResponse = newEvents.some(e => 
          e.role === 'agent' && e.kind === 'thought'
        );
        
        if (hasAgentResponse || elapsed >= timeout) {
          clearInterval(checkInterval);
          resolve(newEvents);
        }
      }, 100);
    });
  }

  async getExecutionState(): Promise<WorkflowExecutionState> {
    const response = await fetch('/api/v1/workflows/execution-state');
    if (!response.ok) {
      throw new Error('Failed to get execution state');
    }
    return response.json();
  }

  subscribeToEvents(callback: (event: RuntimeEvent) => void): () => void {
    this.eventSubscribers.add(callback);
    return () => this.eventSubscribers.delete(callback);
  }

  async waitForWorkflowStatus(status: string, timeout = 30000): Promise<boolean> {
    const startTime = Date.now();
    
    return new Promise((resolve) => {
      const check = async () => {
        const elapsed = Date.now() - startTime;
        if (elapsed >= timeout) {
          resolve(false);
          return;
        }
        
        try {
          const state = await this.getExecutionState();
          if (state.status === status) {
            resolve(true);
            return;
          }
        } catch {
          // 忽略错误，继续轮询
        }
        
        setTimeout(check, 500);
      };
      
      check();
    });
  }

  async listAgents(): Promise<AgentState[]> {
    const state = await this.getExecutionState();
    return state.agents;
  }

  private convertWsMessageToRuntimeEvent(msg: WsMessage): RuntimeEvent {
    if (msg.type === 'agent_update') {
      const payload = msg.payload as Record<string, unknown>;
      return {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'agent_update',
        role: 'agent',
        agentId: payload.agentId as string,
        agentName: payload.agentId as string,
        kind: payload.step ? 'thought' : 'status',
        content: (payload.step as Record<string, string>)?.thought || 
                 (payload.step as Record<string, string>)?.action || 
                 String(payload.status),
        timestamp: new Date().toISOString(),
      };
    }
    
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: msg.type,
      role: 'system',
      kind: 'status',
      content: JSON.stringify(msg.payload),
      timestamp: new Date().toISOString(),
    };
  }
}

export function createTestAPI(): TestAPI {
  return new TestAPIImpl();
}

// 导出单例
export const testAPI = createTestAPI();
