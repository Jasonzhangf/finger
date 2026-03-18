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
import type { RuntimeEvent } from '../../runtime/events.js';
import { logger } from '../../core/logger.js';

const log = logger.module('AgentStatusSubscriber');

/**
 * 订阅级别
 */
export type SubscriptionLevel = 'detailed' | 'summary';

/**
 * Agent 订阅配置
 */
export interface AgentSubscriptionConfig {
  agentId: string;
  level: SubscriptionLevel;
  parentAgentId?: string; // 父 Agent ID（如果是子 Agent）
}

export interface SessionEnvelopeMapping {
  sessionId: string;
  envelope: {
    channel: string;
    envelopeId: string;
    userId?: string;
    groupId?: string;
  };
  timestamp: number;
}

/**
 * 任务上下文信息
 */
export interface TaskContext {
  taskId?: string;
  taskDescription?: string;
  sourceAgentId?: string;
  targetAgentId?: string;
}

/**
 * Agent 信息
 */
export interface AgentInfo {
  agentId: string;
  agentName?: string;
  agentRole?: 'orchestrator' | 'executor' | 'reviewer' | 'searcher';
}

/**
 * 包装后的状态更新事件
 */
export interface WrappedStatusUpdate {
  // 事件元数据
  type: 'agent_status';
  eventId: string;
  timestamp: string;

  // 会话信息
  sessionId: string;
  conversationId?: string;

  // 任务上下文
  task: TaskContext;

  // Agent 信息
  agent: AgentInfo;

  // 状态信息
  status: {
    state: 'running' | 'completed' | 'failed' | 'paused' | 'waiting';
    progress?: number; // 0-100
    summary: string;
    details?: Record<string, unknown>;
  };

  // 客户端展示信息
  display: {
    title: string;
    subtitle?: string;
    icon?: string;
    level: SubscriptionLevel; // 详细 vs 粗糙
  };
}

/**
 * 状态变化事件类型（用于粗糙订阅）
 */
const KEY_STATE_CHANGES = ['completed', 'failed', 'paused', 'waiting'];

export class AgentStatusSubscriber {
  private unsubscribe: (() => void) | null = null;
  private sessionEnvelopeMap = new Map<string, SessionEnvelopeMapping>();
  private agentSubscriptions = new Map<string, AgentSubscriptionConfig>(); // agentId -> config
  private primaryAgentId: string | null = null; // 当前主 Agent（编排者）
  private readonly cleanupIntervalMs = 5 * 60 * 1000; // 5分钟清理一次过期映射
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private eventBus: UnifiedEventBus,
    private deps: AgentRuntimeDeps,
    private messageHub?: import('../../orchestration/message-hub.js').MessageHub
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

    // 订阅 agent_runtime_status 和 agent_runtime_dispatch 事件
    this.unsubscribe = this.eventBus.subscribeMultiple(
      ['agent_runtime_status', 'agent_runtime_dispatch'],
      (event: RuntimeEvent) => {
        this.handleEvent(event).catch(err => {
          log.error('[AgentStatusSubscriber] Error handling event:', err);
        });
      }
    );

    // 启动定期清理
    this.startCleanup();

    log.info('[AgentStatusSubscriber] Started');
  }

  /**
   * 停止订阅
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

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
    log.debug(`[AgentStatusSubscriber] Registering session ${sessionId}`);
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
    if (event.type === 'agent_runtime_dispatch') {
      await this.handleDispatch(event);
    } else if (event.type === 'agent_runtime_status') {
      await this.handleStatus(event);
    }
  }

  /**
   * 处理 dispatch 事件（任务派发）
   */
  private async handleDispatch(event: RuntimeEvent): Promise<void> {
    const payload = event.payload as {
      dispatchId?: string;
      targetAgentId?: string;
    };

    const targetAgentId = payload.targetAgentId;
    if (!targetAgentId) return;

    // 如果当前有主 Agent，且派发目标不是主 Agent，则注册为子 Agent
    if (this.primaryAgentId && targetAgentId !== this.primaryAgentId) {
      this.registerChildAgent(targetAgentId, this.primaryAgentId);
    }
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
    const wrappedUpdate = this.wrapStatusUpdate(event, payload, agentInfo, taskContext, level);

    // 查找对应的 session
    const sessionId = event.sessionId;
    const mapping = this.resolveEnvelopeMapping(sessionId);

    if (!mapping) {
      log.debug(`[AgentStatusSubscriber] No envelope mapping for session ${sessionId}`);
      return;
    }

    // 发送状态更新到通信通道
    await this.sendStatusUpdate(mapping.envelope, wrappedUpdate);
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

  /**
   * 包装状态更新事件
   */
  private wrapStatusUpdate(
    event: RuntimeEvent,
    payload: any,
    agentInfo: AgentInfo,
    taskContext: TaskContext,
    level: SubscriptionLevel
  ): WrappedStatusUpdate {
    const statusMap: Record<string, WrappedStatusUpdate['status']['state']> = {
      'running': 'running',
      'idle': 'completed',
      'error': 'failed',
      'paused': 'paused',
      'waiting_input': 'waiting',
      'completed': 'completed',
      'failed': 'failed',
    };

    const state = statusMap[payload.status] || 'running';

    const update: WrappedStatusUpdate = {
      type: 'agent_status',
      eventId: `evt-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      timestamp: event.timestamp,

      sessionId: event.sessionId,

      task: taskContext,

      agent: agentInfo,

      status: {
        state,
        summary: payload.summary || `${agentInfo.agentName || agentInfo.agentId} ${state}`,
      },

      display: {
        title: `${agentInfo.agentName || agentInfo.agentId} 任务状态`,
        subtitle: taskContext.taskDescription || payload.summary,
        icon: this.getAgentIcon(agentInfo.agentRole),
        level,
      },
    };

    // 详细订阅时添加更多信息
    if (level === 'detailed') {
      update.status.details = {
        rawStatus: payload.status,
        scope: payload.scope,
      };
    }

    return update;
  }

  /**
   * 获取 Agent 图标
   */
  private getAgentIcon(role?: string): string {
    const icons: Record<string, string> = {
      'orchestrator': '🎯',
      'executor': '⚡',
      'reviewer': '🔍',
      'searcher': '🔎',
    };
    return icons[role || ''] || '🤖';
  }

  /**
   * 发送状态更新到通信通道
   */
  private async sendStatusUpdate(
    envelope: SessionEnvelopeMapping['envelope'],
    statusUpdate: WrappedStatusUpdate
  ): Promise<void> {
    try {
      log.info(`[AgentStatusSubscriber] Sending status update to channel ${envelope.channel}:`, {
        agent: statusUpdate.agent.agentName || statusUpdate.agent.agentId,
        status: statusUpdate.status.state,
        level: statusUpdate.display.level,
        task: statusUpdate.task.taskDescription,
      });

      // 通过 MessageHub 路由到 channel-bridge output
      if (this.messageHub) {
        const outputId = 'channel-bridge-' + envelope.channel;
        const message = {
          channelId: envelope.channel,
          envelopeId: envelope.envelopeId,
          userId: envelope.userId,
          groupId: envelope.groupId,
          statusUpdate,
        };

        await this.messageHub.routeToOutput(outputId, message);
        log.debug('[AgentStatusSubscriber] Sent status update via MessageHub: ' + outputId);
      } else {
        log.warn('[AgentStatusSubscriber] No messageHub available, skipping channel-bridge output');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`[AgentStatusSubscriber] Failed to send status update: `);
    }
  }

  /**
   * 启动定期清理过期映射
   */
  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      const expired: string[] = [];

      for (const [sessionId, mapping] of this.sessionEnvelopeMap.entries()) {
        if (now - mapping.timestamp > this.cleanupIntervalMs) {
          expired.push(sessionId);
        }
      }

      expired.forEach(sessionId => this.sessionEnvelopeMap.delete(sessionId));

      if (expired.length > 0) {
        log.info(`[AgentStatusSubscriber] Cleaned up ${expired.length} expired session mappings`);
      }
    }, this.cleanupIntervalMs);
  }
}

export default AgentStatusSubscriber;
