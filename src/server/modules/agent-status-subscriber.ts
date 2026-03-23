/**
 * Agent Status Subscriber
 *
 * 订阅 Agent 运行时事件，实时推送状态更新到通信通道
 * 替代轮询机制，降低资源占用
 *
 * 分层订阅策略：
 * - 主 Agent（当前编排者）：详细、高频、完整信息
 * - 子 Agent（被派发任务）：粗糙、低频、关键状态变化
 *
 * 这个原则递归应用：
 * - System Agent 层级：System Agent 详细，其派发的子 Agent 粗糙
 * - Project Agent 层级：Project Agent 详细，其派发的子 Agent 粗糙
 */

import type { AgentRuntimeDeps } from './agent-runtime/types.js';
import type { UnifiedEventBus } from '../../runtime/event-bus.js';
import type { RuntimeEvent, ToolErrorEvent, SystemErrorEvent, AgentStepCompletedEvent } from '../../runtime/events.js';
import type { ChannelBridgeEnvelope } from '../../bridges/envelope.js';
import {
  type SubscriptionLevel,
  type AgentSubscriptionConfig,
  type SessionEnvelopeMapping,
  type TaskContext,
  type AgentInfo,
  type WrappedStatusUpdate,
  KEY_STATE_CHANGES,
} from './agent-status-subscriber-types.js';
import { wrapStatusUpdate, getAgentIcon } from './agent-status-subscriber-helpers.js';
import { logger } from '../../core/logger.js';
import { sendStatusUpdate, startCleanup } from './agent-status-subscriber-runtime.js';
import {
  handleToolError as handleToolErrorEvent,
  handleSystemError as handleSystemErrorEvent,
  handleDispatch as handleDispatchEvent,
  handleStepCompleted as handleStepCompletedEvent,
  flushStepBuffer as flushStepBufferEvent,
  type HandlerContext,
} from './agent-status-subscriber-handlers.js';

const log = logger.module('AgentStatusSubscriber');

export type { SubscriptionLevel, AgentSubscriptionConfig, SessionEnvelopeMapping, TaskContext, AgentInfo, WrappedStatusUpdate };

export class AgentStatusSubscriber {
  private unsubscribe: (() => void) | null = null;
  private sessionEnvelopeMap = new Map<string, SessionEnvelopeMapping>();
  private agentSubscriptions = new Map<string, AgentSubscriptionConfig>(); // agentId -> config
  private primaryAgentId: string | null = null; // 当前主 Agent（编排者）
  private readonly cleanupIntervalMs = 24 * 60 * 60 * 1000; // 24小时清理一次过期映射（避免长任务丢失更新）
  private _stopCleanup: (() => void) | null = null;

  // Step batching: per-session buffer for batch step updates
  private stepBuffer = new Map<string, Array<{ index: number; summary: string; timestamp: string }>>();
  private stepBatchDefault = 5;

  private getHandlerContext(): HandlerContext {
    return {
      messageHub: this.messageHub,
      channelBridgeManager: this.channelBridgeManager,
      broadcast: this.broadcast,
      resolveEnvelopeMapping: (sessionId: string) => this.resolveEnvelopeMapping(sessionId),
      getAgentInfo: (agentId: string) => this.getAgentInfo(agentId),
      stepBuffer: this.stepBuffer,
      stepBatchDefault: this.stepBatchDefault,
      primaryAgentId: this.primaryAgentId,
      registerChildAgent: (childAgentId: string, parentAgentId: string) => this.registerChildAgent(childAgentId, parentAgentId),
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

    log.info('[AgentStatusSubscriber] Starting...');

    // 订阅 agent_runtime_status / agent_runtime_dispatch / agent_step_completed / tool_error / system_error 事件
    this.unsubscribe = this.eventBus.subscribeMultiple(
      ['agent_runtime_status', 'agent_runtime_dispatch', 'agent_step_completed', 'tool_error', 'system_error'],
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

  /**
   * 发送 reasoning 更新到通道（用于 QQBot）
   */
  async sendReasoningUpdate(sessionId: string, agentId: string, reasoningText: string): Promise<void> {
    const mapping = this.resolveEnvelopeMapping(sessionId);
    if (!mapping) {
      // No envelope mapping - silently skip (heartbeat/system tasks don't need channel routing)
      return;
    }
    if (!this.messageHub) {
      log.warn('[AgentStatusSubscriber] No messageHub available for reasoning update');
      return;
    }

    // 检查该 channel 的 pushSettings.reasoning 配置
    if (this.channelBridgeManager) {
      const pushSettings = this.channelBridgeManager.getPushSettings(mapping.envelope.channel);
      if (!pushSettings.reasoning) {
        // 该 channel 配置为不推送 reasoning
        return;
      }
    }

    const outputId = 'channel-bridge-' + mapping.envelope.channel;
    const originalEnvelope: ChannelBridgeEnvelope = {
      id: mapping.envelope.envelopeId,
      channelId: mapping.envelope.channel,
      accountId: 'default',
      type: mapping.envelope.groupId ? 'group' : 'direct',
      senderId: mapping.envelope.userId || 'unknown',
      senderName: 'user',
      content: '',
      timestamp: Date.now(),
      metadata: {
        messageId: mapping.envelope.envelopeId,
        ...(mapping.envelope.groupId ? { groupId: mapping.envelope.groupId } : {}),
      },
    };

    const content = `思考：${reasoningText}`;
    const message = {
      channelId: mapping.envelope.channel,
      target: mapping.envelope.groupId ? `group:${mapping.envelope.groupId}` : (mapping.envelope.userId || 'unknown'),
      content,
      originalEnvelope,
      reasoning: {
        sessionId,
        agentId,
      },
    };

    await this.messageHub.routeToOutput(outputId, message);
    log.debug('[AgentStatusSubscriber] Sent reasoning update via MessageHub: ' + outputId);
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
    this.sessionEnvelopeMap.set(sessionId, {
      sessionId,
      envelope,
      timestamp: Date.now(),
    });
  }

  /**
   * 注销 sessionId
   */
  unregisterSession(sessionId: string): void {
    this.sessionEnvelopeMap.delete(sessionId);
  }

  /**
   * 解析 sessionId 对应的 envelope 映射（支持 runtime 子会话回退到 root/parent）
   */
  private resolveEnvelopeMapping(sessionId: string): SessionEnvelopeMapping | null {
    const direct = this.sessionEnvelopeMap.get(sessionId);
    if (direct) return direct;

    // fallback: default/system session -> real system session mapping
    if (sessionId === 'default' || sessionId === 'system-default-session') {
      const getSystemSession = (this.deps.sessionManager as any).getOrCreateSystemSession;
      if (typeof getSystemSession === 'function') {
        const systemSession = getSystemSession.call(this.deps.sessionManager);
        const systemMapping = systemSession ? this.sessionEnvelopeMap.get(systemSession.id) : null;
        if (systemMapping) {
          return {
            sessionId,
            envelope: systemMapping.envelope,
            timestamp: Date.now(),
          };
        }
      }
    }

    const session = this.deps.sessionManager.getSession(sessionId);
    if (!session) return null;

    const context = (session.context && typeof session.context === 'object')
      ? (session.context as Record<string, unknown>)
      : {};
    const parentSessionId = typeof context.parentSessionId === 'string' ? context.parentSessionId : '';
    const rootSessionId = typeof context.rootSessionId === 'string' ? context.rootSessionId : '';
    const fallbackId = rootSessionId || parentSessionId;
    if (!fallbackId) return null;

    const fallback = this.sessionEnvelopeMap.get(fallbackId);
    if (!fallback) return null;

    // 缓存 runtime session 的映射，避免重复回退
    const mapped: SessionEnvelopeMapping = {
      sessionId,
      envelope: fallback.envelope,
      timestamp: Date.now(),
    };
    this.sessionEnvelopeMap.set(sessionId, mapped);
    return mapped;
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
    } else if (event.type === 'tool_error') {
      await handleToolErrorEvent(event as ToolErrorEvent, ctx);
    } else if (event.type === 'system_error') {
      await handleSystemErrorEvent(event as SystemErrorEvent, ctx);
    }
  }

  private async handleToolError(event: ToolErrorEvent): Promise<void> {
    await handleToolErrorEvent(event, this.getHandlerContext());
  }

  private async handleSystemError(event: SystemErrorEvent): Promise<void> {
    await handleSystemErrorEvent(event, this.getHandlerContext());
  }

  private async handleDispatch(event: RuntimeEvent): Promise<void> {
    await handleDispatchEvent(event, this.getHandlerContext());
  }

  private async handleStepCompleted(event: RuntimeEvent): Promise<void> {
    await handleStepCompletedEvent(event, this.getHandlerContext());
  }

  private async flushStepBuffer(sessionId: string, mapping: SessionEnvelopeMapping): Promise<void> {
    await flushStepBufferEvent(sessionId, mapping, this.getHandlerContext());
  }

  /**
   * 处理 status 事件
   */
  private async handleStatus(event: RuntimeEvent): Promise<void> {
    const payload = event.payload as {
      scope: string;
      status: string;
      agentId?: string;
      summary?: string;
    };

    const agentId = payload.agentId || (event as any).agentId;
    if (!agentId) {
      log.warn('[AgentStatusSubscriber] No agentId in event');
      return;
    }

    // 获取订阅配置
    const config = this.agentSubscriptions.get(agentId);
    const level = config?.level || 'summary'; // 默认粗糙订阅

    // 如果是粗糙订阅，只处理关键状态变化
    if (level === 'summary' && !KEY_STATE_CHANGES.includes(payload.status)) {
      log.debug(`[AgentStatusSubscriber] Skipping non-key status for ${agentId}: ${payload.status}`);
      return;
    }

    // 获取 Agent 信息
    const agentInfo = await this.getAgentInfo(agentId);

    // 构建任务上下文
    const taskContext: TaskContext = {
      taskId: (event as any).dispatchId,
      targetAgentId: agentId,
      sourceAgentId: config?.parentAgentId || (event as any).sourceAgentId,
      taskDescription: payload.summary,
    };

    // 包装状态更新
    const wrappedUpdate = wrapStatusUpdate(event, payload, agentInfo, taskContext, level);

    // 查找对应的 session
    const sessionId = event.sessionId;
    const mapping = this.resolveEnvelopeMapping(sessionId);

    if (!mapping) {
      log.debug(`[AgentStatusSubscriber] No envelope mapping for session ${sessionId}`);
      return;
    }

    // 更新时间戳，避免长任务被清理
    mapping.timestamp = Date.now();

    // 发送状态更新到通信通道 (QQBot)
    if (this.messageHub) { await sendStatusUpdate(mapping.envelope, wrappedUpdate, this.messageHub, this.channelBridgeManager); };

    // 同时广播到 WebUI
    if (this.broadcast) {
      this.broadcast({
        type: 'agent_status',
        sessionId,
        agentId,
        timestamp: event.timestamp,
        payload: {
          status: payload.status,
          summary: payload.summary,
          agentName: agentInfo.agentName,
          agentRole: agentInfo.agentRole,
        },
      });
    }

    // 终态时先刷新剩余 steps buffer
    if (payload.status === 'completed' || payload.status === 'failed') {
      const remainingBuffer = this.stepBuffer.get(sessionId);
      if (remainingBuffer && remainingBuffer.length > 0) {
        await this.flushStepBuffer(sessionId, mapping);
      }
    }

    // 终态自动解除订阅（完成/失败）
    if (payload.status === 'completed' || payload.status === 'failed') {
      this.unregisterSession(sessionId);
      log.info('[AgentStatusSubscriber] Unregistered session (terminal status)', { sessionId, status: payload.status });
    }
  }

  /**
   * 推送进度报告到通道（由 ProgressMonitor 调用）
   */
  async sendProgressUpdate(report: {
    sessionId: string;
    agentId: string;
    summary: string;
    progress: { status: string; toolCallsCount: number; modelRoundsCount: number; elapsedMs: number };
  }): Promise<void> {
    const mapping = this.resolveEnvelopeMapping(report.sessionId);
    if (!mapping) return;
    if (!this.messageHub) return;

    // 检查该 channel 是否配置了 progressUpdates
    if (this.channelBridgeManager) {
      const pushSettings = this.channelBridgeManager.getPushSettings(mapping.envelope.channel);
      if (!pushSettings.progressUpdates) return;
    }

    const wrappedUpdate: WrappedStatusUpdate = {
      type: 'agent_status',
      eventId: `progress-${Date.now()}`,
      timestamp: new Date().toISOString(),
      sessionId: report.sessionId,
      agent: { agentId: report.agentId },
      task: { taskDescription: report.summary },
      status: {
        state: report.progress.status === 'completed' ? 'completed'
          : report.progress.status === 'failed' ? 'failed'
          : 'running',
        summary: report.summary,
        details: {
          toolCalls: report.progress.toolCallsCount,
          modelRounds: report.progress.modelRoundsCount,
          elapsedMs: report.progress.elapsedMs,
        },
      },
      display: {
        title: '📊 进度更新',
        // avoid duplication: report.summary is already rendered as status.summary
        subtitle: undefined,
        icon: '🔄',
        level: 'detailed',
      },
    };

    await sendStatusUpdate(mapping.envelope, wrappedUpdate, this.messageHub, this.channelBridgeManager);
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
        return {
          agentId: agent.id,
          agentName: agent.name,
          agentRole: agent.type,
        };
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.warn(`[AgentStatusSubscriber] Failed to get agent info for :`, { error: errorMessage });
    }

    return { agentId };
  }

}

export default AgentStatusSubscriber;
