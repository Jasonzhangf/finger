/**
 * RouterChatAgent - 基于 BaseAgent 的路由聊天 Agent
 */

import type { AgentModule } from '../../orchestration/module-registry.js';
import type { MessageHub } from '../../orchestration/message-hub.js';
import { BaseAgent } from '../base/base-agent.js';
import { routerConfig } from '../router/router-config.js';

export interface RouterChatConfig {
  id: string;
  name: string;
  systemPrompt: string;
  modelId: string;
}

const DEFAULT_CONFIG: RouterChatConfig = {
  id: 'router-chat-agent',
  name: 'Router Chat Agent',
  systemPrompt: `你是一个智能路由助手。分析用户输入并返回 JSON 格式的路由决策。

可用路由:
- chat: 通用聊天和简单问答
- task-orchestrator: 任务执行、代码相关  
- research-agent: 搜索、研究
- system-agent: 系统命令（/开头）

返回格式:
{
  "intent": "chat|task|research|system",
  "confidence": 0.0-1.0,
  "targetAgent": "chat-agent|task-orchestrator|research-agent|system-agent",
  "reasoning": "理由",
  "shouldRoute": true/false,
  "directResponse": "如果是聊天直接回答，否则留空"
}

只返回 JSON。`,
  modelId: 'gpt-4',
};

export class RouterChatAgentSimple extends BaseAgent {
  constructor(config: Partial<RouterChatConfig> = {}) {
    super({ ...DEFAULT_CONFIG, ...config });
  }

  protected async onInitialize(hub: MessageHub): Promise<void> {
    // 注册 input handler
    hub.registerInput('router-chat-agent', async (message: unknown, callback?: any) => {
      const msg = message as { text?: string; sessionId?: string; sender?: any; callbackId?: string };
      const text = msg.text || '';
      const sessionId = msg.sessionId || `session-${Date.now()}`;
      
      try {
        // 1. 获取/创建会话
        await this.getOrCreateSession(sessionId, 'Router Chat Session');
        
        // 2. 添加用户消息到历史
        await this.addMessage('user', text, { sender: msg.sender });
        
        // 3. 发送分析开始事件
        this.emitStatusUpdate('thinking', 'analyzing', '正在分析用户意图...');
        
        // 4. 检查强制路由
        const forcedRoute = routerConfig.matchForcedRoute(text, msg.sender?.id, 'text');
        if (forcedRoute) {
          this.emitStatusUpdate('routing', 'forced', `命中强制路由：${forcedRoute.name}`, {
            routeName: forcedRoute.name,
            targetAgent: forcedRoute.targetAgentId,
          });
          
          const result = {
            success: true,
            result: {
              isRouted: true,
              targetAgent: forcedRoute.targetAgentId,
              isForced: true,
              routeName: forcedRoute.name,
            },
          };
          
          this.emitStatusUpdate('completed', 'routed', `已路由到 ${forcedRoute.targetAgentId}`, { result });
          if (callback) callback(result);
          return result;
        }
        
        // 5. 调用 LLM 进行语义分析
        const analysisPrompt = `分析以下用户输入的意图，返回 JSON:
用户输入：${text}
返回格式：{"intent":"chat|task|research|system","confidence":0.0-1.0,"targetAgent":"...","reasoning":"...","shouldRoute":true/false,"directResponse":"..."}
只返回 JSON。`;

        const chatResult = await this.callLLM(analysisPrompt);
        
        // 6. 解析响应
        let decision: any;
        try {
          const jsonMatch = chatResult.match(/\{[\s\S]*\}/);
          if (!jsonMatch) throw new Error('No JSON found');
          decision = JSON.parse(jsonMatch[0]);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          this.emitStatusUpdate('analyzing', 'parse_error', `解析失败：${errMsg}`);
          decision = {
            intent: 'chat',
            confidence: 0.5,
            targetAgent: 'chat-agent',
            shouldRoute: false,
            directResponse: chatResult,
          };
        }
        
        // 7. 根据决策返回
        let result: any;
        if (decision.shouldRoute && decision.targetAgent !== 'chat-agent') {
          this.emitStatusUpdate('routing', 'decided', `将路由到 ${decision.targetAgent}`, {
            targetAgent: decision.targetAgent,
            intent: decision.intent,
            confidence: decision.confidence,
          });
          
          result = {
            success: true,
            result: {
              isRouted: true,
              targetAgent: decision.targetAgent,
              intent: decision.intent,
              confidence: decision.confidence,
              reasoning: decision.reasoning,
            },
          };
          
          this.emitStatusUpdate('completed', 'routed', `已路由到 ${decision.targetAgent}`, { result });
        } else {
          this.emitStatusUpdate('responding', 'direct', '直接回复');
          
          result = {
            success: true,
            result: {
              isRouted: false,
              targetAgent: 'self',
              intent: decision.intent,
              confidence: decision.confidence,
              response: decision.directResponse || chatResult,
            },
          };
          
          this.emitStatusUpdate('completed', 'responded', '已回复', { result });
          
          // 添加助手回复到历史
          await this.addMessage('assistant', result.result.response || '');
        }
        
        if (callback) callback(result);
        return result;
        
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.emitStatusUpdate('failed', 'error', err.message, { stack: err.stack });
        
        const result = {
          success: false,
          error: err.message,
          result: { isRouted: false, targetAgent: 'self', response: `错误：${err.message}` },
        };
        
        if (callback) callback(result);
        return result;
      }
    });

    // 注册 output handler
    hub.registerOutput('router-chat-agent', async (message: unknown) => {
      return message;
    });

    this.emitStatusUpdate('pending', 'ready', `${this.config.name} 已就绪`);
  }
}

// AgentModule 导出
export const routerChatAgent: AgentModule = {
  id: 'router-chat-agent',
  type: 'agent',
  name: 'router-chat-agent',
  version: '1.0.0',
  capabilities: ['routing', 'chat', 'intent-classification'],

  initialize: async (hub: MessageHub): Promise<void> => {
    const agent = new RouterChatAgentSimple();
    await agent.initializeBase(hub);
  },

  execute: async (command: string) => {
    if (command === 'getConfig') return { config: DEFAULT_CONFIG };
    throw new Error(`Unknown command: ${command}`);
  },
};

export default routerChatAgent;
