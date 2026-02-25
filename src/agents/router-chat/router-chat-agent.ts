/**
 * RouterChatAgent - 统一的路由 + 聊天 Agent (支持流式输出)
 */

import type { AgentModule } from '../../orchestration/module-registry.js';
import type { MessageHub } from '../../orchestration/message-hub.js';
import { logger } from '../../core/logger.js';
import { BaseSessionAgent, type BaseSessionAgentConfig, type AgentContext } from '../base/base-session-agent.js';
import { IflowSessionManager } from '../chat/iflow-session-manager.js';
import { setGlobalSessionManager } from '../chat/session-types.js';
import { globalEventBus } from '../../runtime/event-bus.js';
import {
  ROUTER_SYSTEM_PROMPT,
  buildRouterPrompt,
  extractContentFeatures,
  parseRouterDecision,
  type RouterInputMessage,
  type TargetAgent,
} from '../router/router-prompt.js';
import { routerConfig, type RouteRule } from '../router/router-config.js';

const log = logger.module('RouterChatAgent');

export interface RouterChatAgentConfig extends BaseSessionAgentConfig {
  chatSystemPrompt?: string;
  routerSystemPrompt?: string;
}

export interface RouterInput {
  text: string;
  sessionId?: string;
  sender?: { id?: string; name?: string; role?: string };
  conversationId?: string;
  metadata?: Record<string, unknown>;
}

export interface RouterOutput {
  success: boolean;
  response?: string;
  isRouted: boolean;
  targetAgent?: string;
  sessionId: string;
  messageId?: string;
  error?: string;
}

export interface RouteDecision {
  isForced: boolean;
  matchedRule?: RouteRule;
  classification: { type: string; confidence: number; reasoning: string };
  target: { agentId: string; agentName: string; matchedCapabilities: string[]; reasoning: string };
  metadata: { inputSummary: string; keyFeatures: string[]; alternativeTargets: string[]; requiresHumanReview: boolean; preferredRoutes?: string[] };
  targetModule: string;
  requiredCapabilities: string[];
}

const DEFAULT_CONFIG: RouterChatAgentConfig = {
  id: 'router-chat-agent',
  name: 'Router Chat Agent',
  modelId: 'gpt-4',
  systemPrompt: '你是一个智能路由助手。',
  chatSystemPrompt: '你是一个 helpful 的 AI 助手，能够回答用户的各类问题。',
  routerSystemPrompt: ROUTER_SYSTEM_PROMPT,
  maxContextMessages: 20,
};

const DEFAULT_TARGETS: TargetAgent[] = [
  { id: 'task-orchestrator', name: 'Task Orchestrator', description: '任务编排和执行', capabilities: [{ id: 'execution', name: '执行', description: '任务执行', available: true }], priority: 100, available: true },
  { id: 'research-agent', name: 'Research Agent', description: '研究搜索', capabilities: [{ id: 'web-search', name: '网络搜索', description: '搜索网络资源', available: true }], priority: 100, available: true },
];

export class RouterChatAgent extends BaseSessionAgent {
  private localSessionManager: IflowSessionManager;
  private targets: TargetAgent[];

  constructor(config: Partial<RouterChatAgentConfig> = {}, targets: TargetAgent[] = DEFAULT_TARGETS) {
    super({ ...DEFAULT_CONFIG, ...config });
    this.localSessionManager = new IflowSessionManager();
    this.targets = targets;
  }

  protected async registerHandlers(hub: MessageHub): Promise<void> {
    await this.localSessionManager.initialize();
    setGlobalSessionManager(this.localSessionManager);
    log.info('Session manager initialized');

    hub.registerInput('router-chat-agent', async (message: unknown) => {
      const msg = message as RouterInput;
      try {
        const result = await this.handleRouterInput(msg);
        console.log("[RouterChatAgent] handleRouterInput result:", JSON.stringify(result).substring(0, 200));
        return result;
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        log.error('Router input handling failed', err);
        return { success: false, error: err.message, isRouted: false, sessionId: '' };
      }
    });

    log.info('RouterChatAgent registered to Message Hub');
  }

  protected async handleMessage(input: unknown, _context: AgentContext): Promise<unknown> {
    const msg = input as RouterInput;
    return this.handleRouterInput(msg);
  }

  private async handleRouterInput(input: RouterInput): Promise<RouterOutput> {
    const decision = await this.analyzeAndDecide(input);

    if (decision.classification.type === 'chat' || decision.targetModule === 'chat-agent') {
      return this.handleDirectChat(input);
    } else {
      return this.routeToAgent(input, decision);
    }
  }

  private async analyzeAndDecide(input: RouterInput): Promise<RouteDecision> {
    const text = input.text || '';
    const senderId = input.sender?.id;
    const messageType = 'text';

    const forcedRoute = routerConfig.matchForcedRoute(text, senderId, messageType);
    if (forcedRoute) {
      return this.createForcedDecision(forcedRoute, text);
    }

    const preferredRoutes = routerConfig.matchPreferredRoutes(text, senderId, messageType);

    const routerInput: RouterInputMessage = {
      id: `msg-${Date.now()}`,
      text,
      messageType: 'text' as never,
      sender: input.sender ? { id: input.sender.id || 'unknown', name: input.sender.name, role: input.sender.role } : undefined,
      context: input.conversationId ? { conversationId: input.conversationId, messageIndex: 0 } : undefined,
      contentFeatures: extractContentFeatures(text),
      timestamp: new Date().toISOString(),
      raw: input,
    };

    const prompt = buildRouterPrompt(routerInput, this.targets);
    const routerPrompt = this.config.routerSystemPrompt || ROUTER_SYSTEM_PROMPT;

    try {
      const modelResult = await this.callRouterLLM(prompt, routerPrompt);
      const parsed = parseRouterDecision(modelResult);

      if (!parsed) {
        log.warn('Failed to parse router decision, model returned:' + modelResult.substring(0, 200));
        throw new Error('Failed to parse model response');
      }

      return {
        isForced: false,
        classification: { type: parsed.intent.type, confidence: parsed.intent.confidence, reasoning: parsed.intent.reasoning },
        target: parsed.target,
        metadata: { ...parsed.metadata, preferredRoutes: preferredRoutes.map(r => r.id) },
        targetModule: parsed.target.agentId,
        requiredCapabilities: parsed.target.matchedCapabilities,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('LLM analysis failed, using fallback', err);
      return this.ruleBasedDecision(text, preferredRoutes);
    }
  }

  private async callRouterLLM(prompt: string, systemPrompt: string): Promise<string> {
    if (!this.client) {
      throw new Error('iFlow client not initialized');
    }

    const fullMessage = `${systemPrompt}\n\n${prompt}`;

    try {
      log.debug('Sending router request to iFlow', { messageLength: fullMessage.length });
      await this.client.sendMessage(fullMessage);

      let finalOutput = '';
      for await (const msg of this.client.receiveMessages()) {
        if (msg.type === 'assistant' && 'chunk' in msg) {
          const chunk = (msg as { chunk?: { text?: string } }).chunk;
          if (chunk?.text) {
            finalOutput += chunk.text;
          }
        } else if (msg.type === 'task_finish') {
          break;
        } else if (msg.type === 'error') {
          const errorMsg = (msg as { message?: string }).message || 'Unknown error';
          if (errorMsg.includes("并发限制") || errorMsg.includes("rate limit")) {
            log.warn(`iFlow rate limit, will use fallback: ${errorMsg}`);
            throw new Error(`Rate limit: ${errorMsg}`);
          }
          throw new Error(`iFlow error: ${errorMsg}`);
        }
      }

      log.debug('Received router response from iFlow', { responseLength: finalOutput.length, preview: finalOutput.substring(0, 100) });
      return finalOutput;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('Router LLM call failed', err);
      throw err;
    }
  }

  private async handleDirectChat(input: RouterInput): Promise<RouterOutput> {
    const chatContext = await this.ensureAgentContext('chat', 'Chat Session', input.text.substring(0, 50));
    await this.addMessageToContext('user', input.text, 'chat');
    const history = await this.getContextHistory('chat', this.config.maxContextMessages);
    const chatPrompt = this.config.chatSystemPrompt || this.config.systemPrompt || '';

    console.log("[handleDirectChat] Calling LLM with:", input.text.substring(0, 50));
    
    // 流式调用 LLM，实时发送 chunk 事件
    const response = await this.callLLMStreaming(input.text, chatPrompt, history, chatContext.sessionId);
    
    console.log("[handleDirectChat] LLM response:", response.substring(0, 100));
    const assistantMsg = await this.addMessageToContext('assistant', response, 'chat');

    return {
      success: true,
      response,
      isRouted: false,
      targetAgent: 'self',
      sessionId: chatContext.sessionId,
      messageId: assistantMsg?.id,
    };
  }

  /**
   * 流式调用 LLM - 实时发送 assistant_chunk 事件
   */
  private async callLLMStreaming(
    userMessage: string,
    systemPrompt: string | undefined,
    history: Array<{ role: string; content: string }>,
    sessionId: string
  ): Promise<string> {
    if (!this.client) {
      throw new Error('iFlow client not initialized');
    }

    let fullMessage = userMessage;
    const parts: string[] = [];
    
    if (systemPrompt || this.config.systemPrompt) {
      parts.push(`[系统指令] ${systemPrompt || this.config.systemPrompt}`);
    }
    
    if (history && history.length > 0) {
      const recentHistory = history.slice(-(this.config.maxContextMessages || 20));
      for (const msg of recentHistory) {
        const roleLabel = msg.role === 'user' ? '用户' : msg.role === 'assistant' ? '助手' : '系统';
        parts.push(`[${roleLabel}] ${msg.content}`);
      }
    }
    
    if (parts.length > 0) {
      parts.push(`[用户] ${userMessage}`);
      fullMessage = parts.join('\n\n');
    }

    try {
      log.debug('Sending message to iFlow', { messageLength: fullMessage.length });
      await this.client.sendMessage(fullMessage);
      
      let finalOutput = '';
      let messageId = `msg-${Date.now()}`;
      
      for await (const msg of this.client.receiveMessages()) {
        if (msg.type === 'assistant' && 'chunk' in msg) {
          const chunk = (msg as { chunk?: { text?: string }; id?: string }).chunk;
          const id = (msg as { id?: string }).id;
          if (id) messageId = id;
          
          if (chunk?.text) {
            finalOutput += chunk.text;
            
            // 实时发送 chunk 事件 - WebSocket 客户端会立即收到
            globalEventBus.emit({
              type: 'assistant_chunk',
              sessionId,
              agentId: 'router-chat-agent',
              timestamp: new Date().toISOString(),
              payload: { messageId, content: chunk.text },
            });
          }
        } else if (msg.type === 'tool_call') {
          const toolMsg = msg as { toolName?: string; status?: string };
          globalEventBus.emit({
            type: 'tool_call',
            sessionId,
            agentId: 'router-chat-agent',
            timestamp: new Date().toISOString(),
            toolId: `tool-${Date.now()}`,
            toolName: toolMsg.toolName || 'unknown',
            payload: { input: { text: toolMsg.toolName || 'unknown', status: toolMsg.status || 'running' } },
          });
        } else if (msg.type === 'task_finish') {
          // 发送完成事件
          globalEventBus.emit({
            type: 'assistant_complete',
            sessionId,
            agentId: 'router-chat-agent',
            timestamp: new Date().toISOString(),
            payload: { messageId, content: finalOutput, stopReason: 'completed' },
          });
          break;
        } else if (msg.type === 'error') {
          const errorMsg = (msg as { message?: string }).message || 'Unknown error';
          throw new Error(`iFlow error: ${errorMsg}`);
        }
      }

      log.debug('Received iFlow response', { responseLength: finalOutput.length });
      return finalOutput || '抱歉，我没有收到回复。';
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error('LLM call failed', err);
      return `抱歉，对话服务暂时不可用：${err.message}`;
    }
  }

  private async routeToAgent(input: RouterInput, decision: RouteDecision): Promise<RouterOutput> {
    const targetModule = decision.targetModule;
    const agentContext = await this.ensureAgentContext(targetModule, decision.target.agentName, `${decision.target.agentName} - ${input.text.substring(0, 30)}`);
    await this.addMessageToContext('user', input.text, targetModule);

    if (this.hub) {
      try {
        const routedResult = await this.hub.sendToModule(targetModule, {
          text: input.text,
          sessionId: agentContext.sessionId,
          sender: input.sender,
          metadata: { ...input.metadata, routedBy: 'router-chat-agent', classification: decision.classification },
        });

        log.info('Routed to agent', { targetModule, sessionId: agentContext.sessionId });

        return {
          success: true,
          response: typeof routedResult === 'string' ? routedResult : JSON.stringify(routedResult),
          isRouted: true,
          targetAgent: targetModule,
          sessionId: agentContext.sessionId,
        };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        log.error(`Failed to route to ${targetModule}, falling back to direct chat`, error);
        return this.handleDirectChat(input);
      }
    }

    return {
      success: false,
      error: 'MessageHub not available',
      isRouted: true,
      targetAgent: targetModule,
      sessionId: agentContext.sessionId,
    };
  }

  private createForcedDecision(route: RouteRule, text: string): RouteDecision {
    return {
      isForced: true,
      matchedRule: route,
      classification: { type: 'forced', confidence: 1.0, reasoning: `命中强制路由：${route.name}` },
      target: { agentId: route.targetAgentId, agentName: route.targetAgentName || route.targetAgentId, matchedCapabilities: [], reasoning: route.description || '' },
      metadata: { inputSummary: text.substring(0, 100), keyFeatures: ['forced'], alternativeTargets: [], requiresHumanReview: false },
      targetModule: route.targetAgentId,
      requiredCapabilities: [],
    };
  }

  private ruleBasedDecision(text: string, preferredRoutes: RouteRule[]): RouteDecision {
    const lowerText = text.toLowerCase();

    if (preferredRoutes.length > 0) {
      const topRoute = preferredRoutes[0];
      return {
        isForced: false,
        classification: { type: 'preferred', confidence: 0.7, reasoning: `匹配优选路由：${topRoute.name}` },
        target: { agentId: topRoute.targetAgentId, agentName: topRoute.targetAgentName || topRoute.targetAgentId, matchedCapabilities: [], reasoning: topRoute.description || '' },
        metadata: { inputSummary: text.substring(0, 100), keyFeatures: [], alternativeTargets: ['chat-agent'], requiresHumanReview: false, preferredRoutes: preferredRoutes.map(r => r.id) },
        targetModule: topRoute.targetAgentId,
        requiredCapabilities: [],
      };
    }

    const isTask = ['创建', '修改', '删除', '运行', '执行', '代码', '文件'].some(k => lowerText.includes(k));
    const targetModule = isTask ? 'task-orchestrator' : 'chat-agent';
    const intentType = isTask ? 'task.execute' : 'chat';

    return {
      isForced: false,
      classification: { type: intentType, confidence: 0.6, reasoning: '基于关键词的规则决策' },
      target: { agentId: targetModule, agentName: targetModule, matchedCapabilities: ['execution'], reasoning: '规则匹配' },
      metadata: { inputSummary: text.substring(0, 100), keyFeatures: [], alternativeTargets: ['chat-agent'], requiresHumanReview: false },
      targetModule,
      requiredCapabilities: ['execution'],
    };
  }

  async switchToAgentSession(agentId: string): Promise<boolean> {
    return this.switchToAgent(agentId);
  }

  getAllAgentContexts(): AgentContext[] {
    return this.getActiveContexts();
  }
}

export const routerChatAgent: AgentModule = {
  id: 'router-chat-agent',
  type: 'agent',
  name: 'router-chat-agent',
  version: '1.0.0',
  capabilities: ['routing', 'chat', 'intent-classification', 'semantic-understanding', 'session-management'],

  initialize: async (hub: MessageHub): Promise<void> => {
    const agent = new RouterChatAgent();
    const sessionManager = new IflowSessionManager();
    await sessionManager.initialize();
    await agent.initializeHub(hub, sessionManager);
  },

  execute: async (command: string, _params: Record<string, unknown>) => {
    if (command === 'route') {
      return { success: true, decision: 'routed' };
    }
    if (command === 'chat') {
      return { success: true, response: 'chat response' };
    }
    throw new Error(`Unknown command: ${command}`);
  },
};

export default RouterChatAgent;
