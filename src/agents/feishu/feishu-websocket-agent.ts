/**
 * Feishu WebSocket Agent - 飞书消息接入模块
 * 
 * 实现飞书 WebSocket 的消息收发能力：
 * - Input: 接收飞书消息，转发到 MessageHub
 * - Output: 从 MessageHub 接收回调，发送到飞书
 */

import type { AgentModule } from '../../orchestration/module-registry.js';
import type { MessageHub } from '../../orchestration/message-hub.js';
import WebSocket from 'ws';

export interface FeishuMessage {
  type: 'text' | 'image' | 'file' | 'event';
  chatId: string;
  userId: string;
  content: string;
  messageId: string;
  timestamp: number;
}

export interface FeishuConfig {
  appId: string;
  appSecret: string;
  webhookUrl?: string;
  wsEndpoint?: string;
}

export class FeishuWebSocketAgent implements AgentModule {
  id = 'feishu-websocket-agent';
  type = 'agent' as const;
  name = 'Feishu WebSocket Agent';
  version = '1.0.0';
  capabilities = ['receive', 'send', 'webhook'];

  private config: FeishuConfig;
  private hub?: MessageHub;
  private ws?: WebSocket;

  constructor(config: FeishuConfig) {
    this.config = config;
  }

  async initialize(hub: MessageHub): Promise<void> {
    this.hub = hub;
    
    // 注册输入模块 - 接收飞书消息
    hub.registerInput('feishu-ws-input', async (message) => {
      return this.handleIncomingMessage(message);
    });

    // 注册输出模块 - 发送回调到飞书
    hub.registerOutput('feishu-ws-output', async (message, callback) => {
      return this.handleOutgoingMessage(message, callback);
    });

    // 添加显式路由：feishu.message -> feishu-ws-output
    if (hasAddRoute(hub)) {
      hub.addRoute({
        id: 'feishu-to-output',
        pattern: 'feishu.message',
        handler: async (msg: any) => {
          const payload = (msg as { payload?: unknown }).payload ?? msg;
          return hub.routeToOutput('feishu-ws-output', payload);
        },
        blocking: true,
        priority: 100
      });
    }

    console.log('[FeishuAgent] Initialized with input: feishu-ws-input, output: feishu-ws-output');
  }

  async execute(command: string, params: Record<string, unknown>): Promise<unknown> {
    switch (command) {
      case 'connect': {
        const wsEndpoint = params.wsEndpoint as string | undefined || this.config.wsEndpoint;
        return this.connectWebSocket(wsEndpoint);
      }
      case 'disconnect':
        return this.disconnect();
     case 'send': {
        const message = params as unknown as FeishuMessage;
       return this.sendToFeishu(message);
     }
      default:
        throw new Error(`Unknown command: ${command}`);
    }
  }

  private async handleIncomingMessage(message: unknown): Promise<unknown> {
    const feishuMsg = message as FeishuMessage;
    console.log(`[FeishuAgent] Received message from ${feishuMsg.userId}: ${feishuMsg.content}`);
    
    // Only route valid feishu messages (text, image, file, event)
    const validTypes = ['text', 'image', 'file', 'event'];
    if (!validTypes.includes(feishuMsg.type)) {
      console.log(`[FeishuAgent] Skipping invalid message type: ${feishuMsg.type}`);
      return { success: true, forwarded: false, reason: 'Type mismatch' };
    }
    
    // 转发到 hub 进行路由
    if (this.hub) {
      const result = await this.hub.send({
        type: 'feishu.message',
        payload: feishuMsg,
        meta: { source: 'feishu-ws-input', id: `feishu-${Date.now()}` }
      });
      return { success: true, forwarded: true, result };
    }
    return { success: false, error: 'Hub not initialized' };
  }

  private async handleOutgoingMessage(
    message: unknown, 
    callback?: (result: unknown) => void
  ): Promise<unknown> {
    const result = await this.sendToFeishu(message as FeishuMessage);
    if (callback) {
      callback(result);
    }
    return result;
  }

  private async connectWebSocket(wsEndpoint?: string): Promise<{ success: boolean; endpoint?: string }> {
    const endpoint = wsEndpoint || 'wss://default.feishu.cn';
    console.log(`[FeishuAgent] Connecting to WebSocket endpoint: ${endpoint}`);
    
    // 模拟连接（实际实现会使用 new WebSocket(endpoint)）
    return { success: true, endpoint };
  }

  private async disconnect(): Promise<{ success: boolean }> {
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
    return { success: true };
  }

  private async sendToFeishu(message: FeishuMessage): Promise<{ success: boolean; messageId?: string }> {
    console.log(`[FeishuAgent] Sending to chat ${message.chatId} (user: ${message.userId}): ${message.content}`);
    return { 
      success: true, 
      messageId: `msg-${Date.now()}` 
    };
  }
}

// 类型守卫：检查对象是否有 addRoute 方法
function hasAddRoute(hub: MessageHub): hub is MessageHub & { addRoute: (route: unknown) => void } {
  return typeof (hub as unknown as Record<string, unknown>).addRoute === 'function';
}

// 默认导出 AgentModule 实例（用于动态加载）
const feishuModule: AgentModule = {
  id: 'feishu-websocket-agent',
  type: 'agent',
  name: 'Feishu WebSocket Agent',
  version: '1.0.0',
  capabilities: ['receive', 'send', 'webhook'],
  initialize: async (hub: MessageHub) => {
    // 从环境变量读取配置，支持自定义
    const config: FeishuConfig = {
      appId: process.env.FEISHU_APP_ID || 'default-app-id',
      appSecret: process.env.FEISHU_APP_SECRET || 'default-secret',
      wsEndpoint: process.env.FEISHU_WS_ENDPOINT,
      webhookUrl: process.env.FEISHU_WEBHOOK_URL,
    };
    const agent = new FeishuWebSocketAgent(config);
    await agent.initialize(hub);
  },
  execute: async (command: string, params: Record<string, unknown>) => {
    const config: FeishuConfig = {
      appId: process.env.FEISHU_APP_ID || 'default-app-id',
      appSecret: process.env.FEISHU_APP_SECRET || 'default-secret',
      wsEndpoint: process.env.FEISHU_WS_ENDPOINT,
      webhookUrl: process.env.FEISHU_WEBHOOK_URL,
    };
    const agent = new FeishuWebSocketAgent(config);
    return agent.execute(command, params);
  }
};

// Helper function for testing
export function createFeishuAgent(config: FeishuConfig): FeishuWebSocketAgent {
  return new FeishuWebSocketAgent(config);
}

export default feishuModule;
