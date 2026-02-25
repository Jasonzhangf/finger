/**
 * Router Agent - 语义路由控制器 (基于 iFlow SDK)
 */

import type { AgentModule } from '../../orchestration/module-registry.js';
import type { MessageHub } from '../../orchestration/message-hub.js';
import { logger } from '../../core/logger.js';
import {
  ROUTER_SYSTEM_PROMPT,
  buildRouterPrompt,
  extractContentFeatures,
  parseRouterDecision,
  type RouterInputMessage,
  type TargetAgent,
} from './router-prompt.js';
import { routerConfig, type RouteRule } from './router-config.js';
import { IflowBaseAgent } from '../sdk/iflow-base.js';

const log = logger.module('RouterAgent');

export interface RouterConfig {
  id: string;
  name: string;
  modelId: string;
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

const DEFAULT_CONFIG: RouterConfig = { id: 'router-agent', name: 'Semantic Router', modelId: 'gpt-4' };

const DEFAULT_TARGETS: TargetAgent[] = [
  { id: 'chat-agent', name: 'Chat Agent', description: '处理通用问答', capabilities: [{ id: 'conversation', name: '对话', description: '自然语言对话', available: true }], priority: 100, available: true },
  { id: 'task-orchestrator', name: 'Task Orchestrator', description: '任务编排和执行', capabilities: [{ id: 'execution', name: '执行', description: '任务执行', available: true }], priority: 100, available: true },
  { id: 'research-agent', name: 'Research Agent', description: '研究搜索', capabilities: [{ id: 'web-search', name: '网络搜索', description: '搜索网络资源', available: true }], priority: 100, available: true },
];

export class RouterAgent extends IflowBaseAgent {
  private config: RouterConfig;
  private targets: TargetAgent[];
  private hub: MessageHub | null = null;

  constructor(config: Partial<RouterConfig> = {}, targets: TargetAgent[] = DEFAULT_TARGETS) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.targets = targets;
  }

  async initializeHub(hub: MessageHub): Promise<void> {
    this.hub = hub;
    await super.initialize(false);
    log.info('Connected to iFlow', { sessionId: this.info.sessionId });

    hub.registerInput('router-input', async (message: unknown) => {
      const msg = message as RouterMessage;
      try {
        const input = this.normalizeInput(msg);
        const decision = await this.analyzeAndDecide(input, msg.sender?.id, msg.type);
        return { success: true, decision };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return { success: false, error: err.message, decision: this.getFallbackDecision(msg.text || '') };
      }
    });

    hub.registerOutput('router-output', async (message: unknown) => message);
    log.info('Router Agent registered to Message Hub');
  }

  private normalizeInput(msg: RouterMessage): RouterInputMessage {
    const features = extractContentFeatures(msg.text || '');
    return {
      id: `msg-${Date.now()}`,
      text: msg.text || '',
      messageType: 'text' as any,
      sender: msg.sender ? { id: msg.sender.id || 'unknown', name: msg.sender.name, role: msg.sender.role } : undefined,
      context: msg.conversationId ? { conversationId: msg.conversationId, messageIndex: 0 } : undefined,
      contentFeatures: features,
      timestamp: new Date().toISOString(),
      raw: msg,
    };
  }

  private async analyzeAndDecide(input: RouterInputMessage, senderId?: string, messageType?: string): Promise<RouteDecision> {
    const forcedRoute = routerConfig.matchForcedRoute(input.text, senderId, messageType);
    if (forcedRoute) return this.createForcedDecision(forcedRoute, input);

    const preferredRoutes = routerConfig.matchPreferredRoutes(input.text, senderId, messageType);
    const prompt = this.buildPromptWithPreferences(input, preferredRoutes);

    try {
      const modelResult = await this.callModelViaIflow(prompt);
      const parsed = parseRouterDecision(modelResult);
      if (!parsed) throw new Error('Failed to parse model response');

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
      return this.ruleBasedDecision(input, preferredRoutes);
    }
  }

  private buildPromptWithPreferences(input: RouterInputMessage, preferredRoutes: RouteRule[]): string {
    const basePrompt = buildRouterPrompt(input, this.targets);
    if (preferredRoutes.length > 0) {
      return basePrompt + '\n\n## 用户偏好路由\n' + preferredRoutes.map(r => `- ${r.name}: ${r.targetAgentName}`).join('\n');
    }
    return basePrompt;
  }

  private async callModelViaIflow(prompt: string): Promise<string> {
    // 使用 iFlow SDK 调用 LLM - 具体 API 需要根据实际 SDK 调整
    if (!this.client) throw new Error('iFlow client not initialized');
    
    // 这里调用 iFlow 的实际 API，示例使用通用方法
    const response = await (this.client as any).chat?.({
      messages: [{ role: 'user', content: prompt }],
      model: this.config.modelId,
      systemPrompt: ROUTER_SYSTEM_PROMPT,
    });

    return response?.content || response || '';
  }

  private createForcedDecision(route: RouteRule, input: RouterInputMessage): RouteDecision {
    return {
      isForced: true,
      matchedRule: route,
      classification: { type: 'forced', confidence: 1.0, reasoning: `命中强制路由：${route.name}` },
      target: { agentId: route.targetAgentId, agentName: route.targetAgentName || route.targetAgentId, matchedCapabilities: [], reasoning: route.description || '' },
      metadata: { inputSummary: input.text.substring(0, 100), keyFeatures: ['forced'], alternativeTargets: [], requiresHumanReview: false },
      targetModule: route.targetAgentId,
      requiredCapabilities: [],
    };
  }

  private ruleBasedDecision(input: RouterInputMessage, preferredRoutes: RouteRule[]): RouteDecision {
    const text = input.text.toLowerCase();
    
    if (preferredRoutes.length > 0) {
      const topRoute = preferredRoutes[0];
      return {
        isForced: false,
        classification: { type: 'preferred', confidence: 0.7, reasoning: `匹配优选路由：${topRoute.name}` },
        target: { agentId: topRoute.targetAgentId, agentName: topRoute.targetAgentName || topRoute.targetAgentId, matchedCapabilities: [], reasoning: topRoute.description || '' },
        metadata: { inputSummary: input.text.substring(0, 100), keyFeatures: [], alternativeTargets: ['chat-agent'], requiresHumanReview: false, preferredRoutes: preferredRoutes.map(r => r.id) },
        targetModule: topRoute.targetAgentId,
        requiredCapabilities: [],
      };
    }

    const isTask = ['创建', '修改', '删除', '运行', '执行', '代码', '文件'].some(k => text.includes(k));
    const targetModule = isTask ? 'task-orchestrator' : 'chat-agent';
    const intentType = isTask ? 'task.execute' : 'chat';

    return {
      isForced: false,
      classification: { type: intentType, confidence: 0.6, reasoning: '基于关键词的规则决策' },
      target: { agentId: targetModule, agentName: targetModule, matchedCapabilities: ['execution'], reasoning: '规则匹配' },
      metadata: { inputSummary: input.text.substring(0, 100), keyFeatures: [], alternativeTargets: ['chat-agent'], requiresHumanReview: false },
      targetModule,
      requiredCapabilities: ['execution'],
    };
  }

  private getFallbackDecision(text: string): RouteDecision {
    return this.ruleBasedDecision({ text, id: 'fallback', messageType: 'text' as any, contentFeatures: extractContentFeatures(text), timestamp: new Date().toISOString() }, []);
  }
}

interface RouterMessage {
  type: string;
  text: string;
  sender?: { id?: string; name?: string; role?: string };
  conversationId?: string;
  metadata?: Record<string, unknown>;
}

export const routerAgent: AgentModule = {
  id: 'router-agent',
  type: 'agent',
  name: 'router-agent',
  version: '1.0.0',
  capabilities: ['routing', 'intent-classification', 'semantic-understanding'],

  initialize: async (hub: MessageHub): Promise<void> => {
    const agent = new RouterAgent();
    await agent.initializeHub(hub);
  },

  execute: async (command: string) => {
    if (command === 'getConfig') return { config: { id: 'router-agent' } };
    throw new Error(`Unknown command: ${command}`);
  },
};

export default routerAgent;
