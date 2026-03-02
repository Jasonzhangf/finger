/**
 * UI 测试辅助工具
 * 提供统一的测试 API 和状态同步
 */

import type { RuntimeEvent, WorkflowExecutionState } from './index.js';

export interface UITestHelper {
  // 服务器管理
  checkServerHealth(): Promise<boolean>;
  startTestServer(): Promise<void>;
  stopTestServer(): Promise<void>;
  
  // 状态管理
  getExecutionState(): Promise<WorkflowExecutionState>;
  resetTestState(): Promise<void>;
  
  // 用户交互
  sendUserInput(text: string): Promise<void>;
  waitForResponse(timeout?: number): Promise<RuntimeEvent[]>;
  
  // 事件订阅
  subscribeToEvents(callback: (event: RuntimeEvent) => void): () => void;
  
  // 断言工具
  assertMessageVisible(selector: string): Promise<boolean>;
  assertAgentStatus(agentId: string, status: string): Promise<boolean>;
}

class UITestHelperImpl implements UITestHelper {
  private eventCallbacks: Set<(event: RuntimeEvent) => void> = new Set();
  private ws: WebSocket | null = null;

  async checkServerHealth(): Promise<boolean> {
    try {
      const res = await fetch('/health');
      return res.ok;
    } catch {
      return false;
    }
  }

  async startTestServer(): Promise<void> {
    if (!await this.checkServerHealth()) {
      throw new Error('Server is not running. Please start with: npm run server');
    }

    // 建立 WebSocket 连接
    const wsUrl = `ws://${window.location.hostname}:5522`;
    this.ws = new WebSocket(wsUrl);
    
    this.ws.onopen = () => {
      console.log('[TestHelper] WebSocket connected');
      // 订阅所有事件组
      this.ws?.send(JSON.stringify({
        type: 'subscribe',
        groups: ['TASK', 'DIALOG', 'PROGRESS', 'HUMAN_IN_LOOP']
      }));
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const runtimeEvent = this.convertToRuntimeEvent(msg);
        this.eventCallbacks.forEach(cb => cb(runtimeEvent));
      } catch (e) {
        console.warn('[TestHelper] Failed to parse message:', e);
      }
    };

    await new Promise<void>((resolve) => {
      if (!this.ws) {
        resolve();
        return;
      }
      this.ws.onopen = () => resolve();
      setTimeout(() => resolve(), 5000);
    });
  }

  async stopTestServer(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  async getExecutionState(): Promise<WorkflowExecutionState> {
    const res = await fetch('/api/v1/workflows/execution-state');
    if (!res.ok) {
      throw new Error(`Failed to get execution state: ${res.statusText}`);
    }
    return res.json();
  }

  async resetTestState(): Promise<void> {
    await fetch('/api/v1/test/reset', { method: 'POST' });
  }

  async sendUserInput(text: string): Promise<void> {
    const res = await fetch('/api/v1/workflows/input', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        input: text,
        sessionId: 'test-session'
      }),
    });

    if (!res.ok) {
      throw new Error(`Failed to send input: ${res.statusText}`);
    }
  }

  async waitForResponse(timeout = 30000): Promise<RuntimeEvent[]> {
    const events: RuntimeEvent[] = [];

    return new Promise((resolve) => {
      const unsubscribe = this.subscribeToEvents((event) => {
        events.push(event);
        
        // 检查是否收到 agent 响应
        if (event.role === 'agent') {
          unsubscribe();
          resolve(events);
        }
      });

      // 超时处理
      setTimeout(() => {
        unsubscribe();
        resolve(events);
      }, timeout);
    });
  }

  subscribeToEvents(callback: (event: RuntimeEvent) => void): () => void {
    this.eventCallbacks.add(callback);
    return () => this.eventCallbacks.delete(callback);
  }

  async assertMessageVisible(selector: string): Promise<boolean> {
    // 等待元素出现
    const startTime = Date.now();
    while (Date.now() - startTime < 5000) {
      const element = document.querySelector(selector);
      if (element) return true;
      await new Promise(r => setTimeout(r, 100));
    }
    return false;
  }

  async assertAgentStatus(agentId: string, status: string): Promise<boolean> {
    try {
      const state = await this.getExecutionState();
      const agent = state.agents.find(a => a.id === agentId);
      return agent?.status === status;
    } catch {
      return false;
    }
  }

  private convertToRuntimeEvent(msg: unknown): RuntimeEvent {
    const data = msg as Record<string, unknown>;
    const payload = data.payload as Record<string, unknown> || {};
    
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: String(data.type || 'unknown'),
      role: this.inferRole(data.type as string),
      agentId: payload.agentId as string,
      agentName: payload.agentName as string || payload.agentId as string,
      kind: this.inferKind(data.type as string, payload),
      content: this.extractContent(payload),
      timestamp: new Date().toISOString(),
    };
  }

  private inferRole(type: string): 'user' | 'agent' | 'system' {
    if (type?.includes('user')) return 'user';
    if (type?.includes('agent')) return 'agent';
    return 'system';
  }

  private inferKind(_type: string, payload: Record<string, unknown>): 'thought' | 'action' | 'observation' | 'status' {
    const step = isRecord(payload.step) ? payload.step : undefined;
    if (typeof step?.thought === 'string' && step.thought.length > 0) return 'thought';
    if (typeof step?.action === 'string' && step.action.length > 0) return 'action';
    if (typeof step?.observation === 'string' && step.observation.length > 0) return 'observation';
    return 'status';
  }

  private extractContent(payload: Record<string, unknown>): string {
    const step = payload.step as Record<string, string>;
    if (step?.thought) return step.thought;
    if (step?.action) return step.action;
    if (step?.observation) return step.observation;
    return String(payload.status || payload.message || '');
  }
}

export function createUITestHelper(): UITestHelper {
  return new UITestHelperImpl();
}

function isRecord(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null;
}

// 导出单例
export const uiTestHelper = createUITestHelper();
