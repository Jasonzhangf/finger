import type { AgentRuntimeDeps } from './agent-runtime/types.js';
import type { UnifiedEventBus } from '../../runtime/event-bus.js';
import type { RuntimeEvent, ToolErrorEvent, SystemErrorEvent } from '../../runtime/events.js';
import type { PushSettings } from '../../bridges/types.js';
import {
  type SubscriptionLevel,
  type AgentSubscriptionConfig,
  type SessionEnvelopeMapping,
  type AgentInfo,
  type TaskContext,
  type WrappedStatusUpdate,
} from './agent-status-subscriber-types.js';
import { logger } from '../../core/logger.js';
import { startCleanup } from './agent-status-subscriber-runtime.js';
import {
  handleToolCall as handleToolCallEvent,
  handleToolResult as handleToolResultEvent,
  handleToolError as handleToolErrorEvent,
  handleSystemError as handleSystemErrorEvent,
  handleDispatch as handleDispatchEvent,
  handleWaitingForUser as handleWaitingForUserEvent,
  handleStepCompleted as handleStepCompletedEvent,
  flushStepBuffer as flushStepBufferEvent,
  type HandlerContext,
} from './agent-status-subscriber-handlers.js';
import {
  applyProgressDeliveryPolicy,
  normalizeProgressDeliveryPolicy,
} from '../../common/progress-delivery-policy.js';
import {
  buildDeliveryRouteKey,
  cleanupRouteStateBySession,
  clearSessionObservers,
  finalizeChannelTurnDelivery,
  inferSessionUpdateSourceType,
  registerSessionMapping,
  resolveEnvelopeMappingForSession,
  resolveEnvelopeMappingsForSession,
  resolvePushSettingsForSession,
  type SubscriberRouteState,
} from './agent-status-subscriber-session-utils.js';
import {
  normalizeBodyForDedup,
  normalizeLinkDigestBody,
  sendBodyUpdate as sendBodyUpdateText,
  sendReasoningUpdate as sendReasoningUpdateText,
} from './agent-status-subscriber-text.js';
import {
  handleAgentRuntimeStatus,
  sendProgressUpdateToChannels,
} from './agent-status-subscriber-status.js';

/**
 * 默认订阅的事件类型列表
 * 可通过修改此列表来控制哪些事件会被实时推送到 channel
 */
const DEFAULT_SUBSCRIBED_EVENTS = [
  'agent_runtime_status',
  'agent_runtime_dispatch',
  'agent_step_completed',
  'tool_error',
  'system_error',
  'waiting_for_user',
  'tool_call',
  'tool_result',
] as const;

const log = logger.module('AgentStatusSubscriber');
const DEFAULT_REASONING_BODY_BUFFER_MS = 0;
const FALLBACK_PUSH_SETTINGS: PushSettings = {
  updateMode: 'both',
  reasoning: true,
  bodyUpdates: true,
  statusUpdate: true,
  toolCalls: true,
  stepUpdates: true,
  stepBatch: 1,
  progressUpdates: true,
};

function resolveReasoningBodyBufferMs(): number {
  const raw = process.env.FINGER_REASONING_BODY_BUFFER_MS;
  if (typeof raw !== 'string' || raw.trim().length === 0) return DEFAULT_REASONING_BODY_BUFFER_MS;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_REASONING_BODY_BUFFER_MS;
  return parsed;
}

export type { SubscriptionLevel, AgentSubscriptionConfig, SessionEnvelopeMapping, TaskContext, AgentInfo, WrappedStatusUpdate };

export class AgentStatusSubscriber {
  private unsubscribe: (() => void) | null = null;
  private sessionEnvelopeMap = new Map<string, SessionEnvelopeMapping>();
  private sessionObserverMap = new Map<string, SessionEnvelopeMapping['envelope'][]>();
  private agentSubscriptions = new Map<string, AgentSubscriptionConfig>(); // agentId -> config
  private primaryAgentId: string | null = null; // 当前主 Agent（编排者）
  private readonly cleanupIntervalMs = 24 * 60 * 60 * 1000; // 24小时清理一次过期映射（避免长任务丢失更新）
  private _stopCleanup: (() => void) | null = null;

  // Step batching: per-session buffer for batch step updates
  private stepBuffer = new Map<string, Array<{ index: number; summary: string; timestamp: string }>>();
  private stepBatchDefault = 5;
  private finalReplyBySession = new Map<string, { normalized: string; at: number }>();
  private lastBodySentBySession = new Map<string, { normalized: string; at: number }>();
  private lastBodySentByRoute = new Map<string, { normalized: string; at: number }>();
  private lastProgressMailboxSummaryBySession = new Map<string, string>();
  private lastReasoningPushAtByRoute = new Map<string, number>();
  private readonly reasoningBodyBufferMs = resolveReasoningBodyBufferMs();
  private getRouteState(): SubscriberRouteState {
    return {
      sessionEnvelopeMap: this.sessionEnvelopeMap,
      sessionObserverMap: this.sessionObserverMap,
      lastProgressMailboxSummaryBySession: this.lastProgressMailboxSummaryBySession,
      lastReasoningPushAtByRoute: this.lastReasoningPushAtByRoute,
    };
  }

  private getHandlerContext(): HandlerContext {
    return {
      messageHub: this.messageHub,
      channelBridgeManager: this.channelBridgeManager,
      broadcast: this.broadcast,
      resolveEnvelopeMapping: (sessionId: string) => this.resolveEnvelopeMapping(sessionId),
      resolveEnvelopeMappings: (sessionId: string) => this.resolveEnvelopeMappings(sessionId),
      getAgentInfo: (agentId: string) => this.getAgentInfo(agentId),
      sendReasoningUpdate: (sessionId: string, agentId: string, reasoningText: string) =>
        this.sendReasoningUpdate(sessionId, agentId, reasoningText),
      stepBuffer: this.stepBuffer,
      stepBatchDefault: this.stepBatchDefault,
      primaryAgentId: this.primaryAgentId,
      registerChildAgent: (childAgentId: string, parentAgentId: string) => this.registerChildAgent(childAgentId, parentAgentId),
      registerChildSession: (childSessionId: string, envelope: SessionEnvelopeMapping[ 'envelope']) => this.registerChildSession(childSessionId, envelope),
      resolvePushSettings: (sessionId: string, channelId: string, options) => this.resolvePushSettings(sessionId, channelId, options),
      deps: this.deps,
    };
  }

 constructor(
   private eventBus: UnifiedEventBus,
   private deps: AgentRuntimeDeps,
   private messageHub?: import('../../orchestration/message-hub.js').MessageHub,
   private channelBridgeManager?: import('../../bridges/manager.js').ChannelBridgeManager,
    private broadcast?: (message: unknown) => void,
 ) {}

  /**
   * 启动订阅
   */
  start(): void {
    if (this.unsubscribe) {
      log.warn('[AgentStatusSubscriber] Already started');
      return;
    }
    log.info(`[AgentStatusSubscriber] Starting... subscribing to: ${DEFAULT_SUBSCRIBED_EVENTS.join(", ")}`);

    this.unsubscribe = this.eventBus.subscribeMultiple(
      [...DEFAULT_SUBSCRIBED_EVENTS],
      (event: RuntimeEvent) => {
        this.handleEvent(event).catch(err => {
          log.error('[AgentStatusSubscriber] Error handling event:', err);
        });
      }
    );

    // 启动定期清理
    this._stopCleanup = startCleanup(this.sessionEnvelopeMap, this.cleanupIntervalMs);

    log.info('[AgentStatusSubscriber] Started');
  }

  async sendReasoningUpdate(sessionId: string, agentId: string, reasoningText: string): Promise<void> {
    await sendReasoningUpdateText({
      sessionId,
      agentId,
      reasoningText,
      resolveEnvelopeMappings: (targetSessionId) => this.resolveEnvelopeMappings(targetSessionId),
      resolvePushSettings: (targetSessionId, channelId, options) => this.resolvePushSettings(targetSessionId, channelId, options),
      resolveSourceType: (targetSessionId, sourceTypeHint) => this.resolveSourceType(targetSessionId, sourceTypeHint),
      messageHub: this.messageHub,
      state: this.getRouteState(),
      reasoningBodyBufferMs: this.reasoningBodyBufferMs,
    });
  }

  async sendBodyUpdate(sessionId: string, agentId: string, bodyText: string): Promise<void> {
    await sendBodyUpdateText({
      sessionId,
      agentId,
      bodyText,
      resolveEnvelopeMappings: (targetSessionId) => this.resolveEnvelopeMappings(targetSessionId),
      resolvePushSettings: (targetSessionId, channelId, options) => this.resolvePushSettings(targetSessionId, channelId, options),
      resolveSourceType: (targetSessionId, sourceTypeHint) => this.resolveSourceType(targetSessionId, sourceTypeHint),
      messageHub: this.messageHub,
      state: this.getRouteState(),
      reasoningBodyBufferMs: this.reasoningBodyBufferMs,
      finalReplyBySession: this.finalReplyBySession,
      lastBodySentBySession: this.lastBodySentBySession,
      lastBodySentByRoute: this.lastBodySentByRoute,
    });
  }

  markFinalReplySent(sessionId: string, replyText: string): void {
    const text = replyText.trim();
    if (!text) return;
    this.finalReplyBySession.set(sessionId, {
      normalized: normalizeBodyForDedup(text),
      at: Date.now(),
    });
  }

  clearFinalReplySent(sessionId: string): void {
    this.finalReplyBySession.delete(sessionId);
  }

  wasBodyUpdateRecentlySent(sessionId: string, text: string, windowMs = 12_000): boolean {
    const normalized = normalizeBodyForDedup(text);
    if (!normalized) return false;
    const recent = this.lastBodySentBySession.get(sessionId);
    if (!recent) return false;
    const ageMs = Date.now() - recent.at;
    if (ageMs > windowMs) {
      this.lastBodySentBySession.delete(sessionId);
      return false;
    }
    return recent.normalized === normalized;
  }

  wasBodyUpdateRecentlySentForRoute(
    route: { channelId: string; userId?: string; groupId?: string },
    text: string,
    windowMs = 12_000,
  ): boolean {
    const normalized = normalizeBodyForDedup(text);
    if (!normalized) return false;
    const routeKey = buildDeliveryRouteKey(route.channelId, route.userId, route.groupId);
    const recent = this.lastBodySentByRoute.get(routeKey);
    if (!recent) return false;
    const ageMs = Date.now() - recent.at;
    if (ageMs > windowMs) {
      this.lastBodySentByRoute.delete(routeKey);
      return false;
    }
    return recent.normalized === normalized;
  }

  wasAnyBodyUpdateRecentlySentForRoute(
    route: { channelId: string; userId?: string; groupId?: string },
    windowMs = 12_000,
  ): boolean {
    const routeKey = buildDeliveryRouteKey(route.channelId, route.userId, route.groupId);
    const recent = this.lastBodySentByRoute.get(routeKey);
    if (!recent) return false;
    const ageMs = Date.now() - recent.at;
    if (ageMs > windowMs) {
      this.lastBodySentByRoute.delete(routeKey);
      return false;
    }
    return true;
  }

  /**
   * 停止订阅
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this._stopCleanup?.();
    this._stopCleanup = null;
    log.info('[AgentStatusSubscriber] Stopped');
  }

  /**
   * 设置主 Agent（编排者）
   */
  setPrimaryAgent(agentId: string): void {
    this.primaryAgentId = agentId;

    // 更新订阅配置：主 Agent 为详细订阅
    this.agentSubscriptions.set(agentId, {
      agentId,
      level: 'detailed',
    });

    log.info(`[AgentStatusSubscriber] Set primary agent: ${agentId}`);
  }

  /**
   * 注册子 Agent（被派发的任务）
   */
  registerChildAgent(childAgentId: string, parentAgentId: string): void {
    this.agentSubscriptions.set(childAgentId, {
      agentId: childAgentId,
      level: 'summary', // 子 Agent 使用粗糙订阅
      parentAgentId,
    });

    log.info(`[AgentStatusSubscriber] Registered child agent: ${childAgentId} (parent: ${parentAgentId})`);
  }

  /**
   * 注销 Agent
   */

  /**
   * 注册子会话的 envelope 映射
   * 当 dispatch 创建子 agent 时，将子 agent 的 sessionId 映射到父会话的 channel envelope
   * 这样子 agent 的 tool_call/tool_result 等事件可以直接找到 envelope 进行推送
   */
  registerChildSession(childSessionId: string, envelope: SessionEnvelopeMapping['envelope']): void {
    if (this.sessionEnvelopeMap.has(childSessionId)) {
      log.debug(`[AgentStatusSubscriber] Child session ${childSessionId} already registered`);
      return;
    }
    this.sessionEnvelopeMap.set(childSessionId, {
      sessionId: childSessionId,
      envelope,
      timestamp: Date.now(),
    });
    log.info(`[AgentStatusSubscriber] Registered child session envelope: ${childSessionId} -> ${envelope.channel}`);
  }

  unregisterAgent(agentId: string): void {
    this.agentSubscriptions.delete(agentId);

    if (this.primaryAgentId === agentId) {
      this.primaryAgentId = null;
    }
  }

  /**
   * 注册 sessionId 与 envelope 的映射
   */
  registerSession(sessionId: string, envelope: SessionEnvelopeMapping['envelope']): void {
    log.info(`[AgentStatusSubscriber] Registering session ${sessionId}`);
    registerSessionMapping(sessionId, envelope, this.getRouteState());
  }

  /**
   * 注销 sessionId
   */
  unregisterSession(sessionId: string): void {
    this.sessionEnvelopeMap.delete(sessionId);
    this.sessionObserverMap.delete(sessionId);
    cleanupRouteStateBySession(sessionId, this.getRouteState());
  }

  clearSessionObservers(sessionId: string): void {
    clearSessionObservers(sessionId, this.getRouteState());
  }

  /**
   * 解析 sessionId 对应的 envelope 映射（支持 runtime 子会话回退到 root/parent）
   */
  private resolveEnvelopeMapping(sessionId: string): SessionEnvelopeMapping | null {
    const mapping = resolveEnvelopeMappingForSession(sessionId, this.deps, this.getRouteState());
    if (mapping && !this.sessionEnvelopeMap.has(sessionId) && mapping.envelope.channel) {
      log.info('[AgentStatusSubscriber] Recovered session envelope from session/context fallback', {
        sessionId,
        channel: mapping.envelope.channel,
        hasMessageId: mapping.envelope.envelopeId.length > 0,
      });
    }
    return mapping;
  }

  private resolveEnvelopeMappings(sessionId: string): SessionEnvelopeMapping[] {
    return resolveEnvelopeMappingsForSession(sessionId, this.deps, this.getRouteState());
  }

  async finalizeChannelTurn(sessionId: string, finalReply?: string, agentId?: string, finishReason?: string): Promise<void> {
    await finalizeChannelTurnDelivery({
      sessionId,
      finalReply,
      agentId,
      finishReason,
      deps: this.deps,
      state: this.getRouteState(),
      messageHub: this.messageHub,
      resolveEnvelopeMapping: (targetSessionId) => this.resolveEnvelopeMapping(targetSessionId),
      resolvePushSettings: (targetSessionId, channelId, options) => this.resolvePushSettings(targetSessionId, channelId, options),
      resolveSourceType: (targetSessionId, sourceTypeHint) => this.resolveSourceType(targetSessionId, sourceTypeHint),
    });
  }

  /**
   * 处理事件
   */
  private async handleEvent(event: RuntimeEvent): Promise<void> {
    const ctx = this.getHandlerContext();
    if (event.type === 'agent_runtime_dispatch') {
      await handleDispatchEvent(event, ctx);
    } else if (event.type === 'agent_runtime_status') {
      await this.handleStatus(event);
    } else if (event.type === 'agent_step_completed') {
      await handleStepCompletedEvent(event, ctx);
    } else if (event.type === 'tool_call') {
      await handleToolCallEvent(event, ctx);
    } else if (event.type === 'tool_result') {
      await handleToolResultEvent(event, ctx);
    } else if (event.type === 'tool_error') {
      await handleToolErrorEvent(event as ToolErrorEvent, ctx);
    } else if (event.type === 'system_error') {
      await handleSystemErrorEvent(event as SystemErrorEvent, ctx);
    } else if (event.type === 'waiting_for_user') {
      await handleWaitingForUserEvent(event, ctx);
    }
  }

  private async flushStepBuffer(sessionId: string, mapping: SessionEnvelopeMapping): Promise<void> {
    await flushStepBufferEvent(sessionId, mapping, this.getHandlerContext());
  }

  /**
   * 处理 status 事件
   */
  private async handleStatus(event: RuntimeEvent): Promise<void> {
    await handleAgentRuntimeStatus({
      event,
      deps: this.deps,
      primaryAgentId: this.primaryAgentId,
      agentSubscriptions: this.agentSubscriptions,
      stepBuffer: this.stepBuffer,
      getAgentInfo: (agentId) => this.getAgentInfo(agentId),
      resolveEnvelopeMappings: (sessionId) => this.resolveEnvelopeMappings(sessionId),
      resolvePushSettings: (sessionId, channelId, options) => this.resolvePushSettings(sessionId, channelId, options),
      flushStepBuffer: (sessionId, mapping) => this.flushStepBuffer(sessionId, mapping),
      messageHub: this.messageHub,
      channelBridgeManager: this.channelBridgeManager,
      broadcast: this.broadcast,
    });
  }

  /**
   * 推送进度报告到通道（由 ProgressMonitor 调用）
   */
  async sendProgressUpdate(report: {
    sessionId: string;
    agentId: string;
    summary: string;
    progress: {
      status: string;
      toolCallsCount: number;
      modelRoundsCount: number;
      elapsedMs: number;
      contextUsagePercent?: number;
      estimatedTokensInContextWindow?: number;
      maxInputTokens?: number;
      contextBreakdown?: {
        historyContextTokens?: number;
        historyCurrentTokens?: number;
        historyTotalTokens?: number;
        historyContextMessages?: number;
        historyCurrentMessages?: number;
        systemPromptTokens?: number;
        developerPromptTokens?: number;
        userInstructionsTokens?: number;
        environmentContextTokens?: number;
        turnContextTokens?: number;
        skillsTokens?: number;
        mailboxTokens?: number;
        projectTokens?: number;
        flowTokens?: number;
        contextSlotsTokens?: number;
        inputTextTokens?: number;
        inputMediaTokens?: number;
        inputMediaCount?: number;
        inputTotalTokens?: number;
        toolsSchemaTokens?: number;
        toolExecutionTokens?: number;
        contextLedgerConfigTokens?: number;
        responsesConfigTokens?: number;
        totalKnownTokens?: number;
        source?: string;
      };
      contextBreakdownMode?: 'release' | 'dev';
    };
  }): Promise<void> {
    await sendProgressUpdateToChannels({
      deps: this.deps,
      report,
      primaryAgentId: this.primaryAgentId,
      lastProgressMailboxSummaryBySession: this.lastProgressMailboxSummaryBySession,
      resolveEnvelopeMappings: (sessionId) => this.resolveEnvelopeMappings(sessionId),
      resolvePushSettings: (sessionId, channelId, options) => this.resolvePushSettings(sessionId, channelId, options),
      messageHub: this.messageHub,
      channelBridgeManager: this.channelBridgeManager,
    });
  }

  /**
   * 获取 Agent 信息
   */
  private async getAgentInfo(agentId: string): Promise<AgentInfo> {
    try {
      const catalog = await this.deps.agentRuntimeBlock.execute('catalog', { layer: 'summary' });
      const agents = Array.isArray((catalog as any).agents) ? (catalog as any).agents : [];
      const agent = agents.find((a: any) => a.id === agentId);

      if (agent) {
        return { agentId: agent.id, agentName: agent.name, agentRole: agent.type };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.warn(`[AgentStatusSubscriber] Failed to get agent info for :`, { error: errorMessage });
    }

    return { agentId };
  }

  private resolvePushSettings(
    sessionId: string,
    channelId: string,
    options?: {
      phase?: string;
      kind?: string;
      sourceType?: string;
      agentId?: string;
    },
  ): PushSettings {
    return resolvePushSettingsForSession({
      sessionId,
      channelId,
      deps: this.deps,
      channelBridgeManager: this.channelBridgeManager,
      fallbackPushSettings: FALLBACK_PUSH_SETTINGS,
      normalizePolicy: normalizeProgressDeliveryPolicy,
      applyPolicy: applyProgressDeliveryPolicy,
      phase: options?.phase,
      kind: options?.kind,
      sourceType: options?.sourceType,
      agentId: options?.agentId,
    });
  }

  private resolveSourceType(sessionId: string, sourceTypeHint?: string) {
    return inferSessionUpdateSourceType({
      sessionId,
      deps: this.deps,
      sourceTypeHint,
    });
  }
}
export default AgentStatusSubscriber;
