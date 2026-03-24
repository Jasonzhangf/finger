/**
 * Agent Status Subscriber - Event Handlers
 *
 * 从主类提取的事件处理函数，减少 agent-status-subscriber.ts 文件大小
 */

import type {
  RuntimeEvent,
  ToolCallEvent,
  ToolResultEvent,
  ToolErrorEvent,
  SystemErrorEvent,
} from '../../runtime/events.js';
import type { SessionEnvelopeMapping, AgentInfo, WrappedStatusUpdate } from './agent-status-subscriber-types.js';
import { getAgentIcon } from './agent-status-subscriber-helpers.js';
import { sendStatusUpdate } from './agent-status-subscriber-runtime.js';
import { logger } from '../../core/logger.js';

const log = logger.module('AgentStatusSubscriberHandlers');
const RAW_TOOL_ERROR_SUPPRESSED_CHANNELS = new Set(['qqbot', 'openclaw-weixin']);

function shouldSuppressRawToolError(channelId?: string): boolean {
  if (!channelId) return false;
  return RAW_TOOL_ERROR_SUPPRESSED_CHANNELS.has(channelId);
}

/**
 * 处理上下文，包含事件处理所需的依赖
 */
export interface HandlerContext {
  messageHub?: import('../../orchestration/message-hub.js').MessageHub;
  channelBridgeManager?: import('../../bridges/manager.js').ChannelBridgeManager;
  broadcast?: (message: unknown) => void;
  resolveEnvelopeMapping: (sessionId: string) => SessionEnvelopeMapping | null;
  getAgentInfo: (agentId: string) => Promise<AgentInfo>;
  sendReasoningUpdate?: (sessionId: string, agentId: string, reasoningText: string) => Promise<void>;
  stepBuffer: Map<string, Array<{ index: number; summary: string; timestamp: string }>>;
  stepBatchDefault: number;
  primaryAgentId: string | null;
  registerChildAgent: (childAgentId: string, parentAgentId: string) => void;
  registerChildSession: (childSessionId: string, envelope: SessionEnvelopeMapping[ 'envelope']) => void;
}

/**
 * 处理 tool_call 事件
 */
export async function handleToolCall(
  event: ToolCallEvent,
  ctx: HandlerContext,
): Promise<void> {
  const sessionId = event.sessionId;
  const mapping = ctx.resolveEnvelopeMapping(sessionId);
  if (!mapping || !ctx.messageHub) return;


  const agentId = event.agentId || 'unknown-agent';
  const toolName = event.toolName || 'unknown-tool';
  const agentInfo = await ctx.getAgentInfo(agentId);

  const wrappedUpdate: WrappedStatusUpdate = {
    type: 'agent_status',
    eventId: event.toolId || `tool-call-${Date.now()}`,
    timestamp: event.timestamp,
    sessionId,
    task: {
      targetAgentId: agentId,
      taskDescription: `工具调用: ${toolName}`,
    },
    agent: agentInfo,
    status: {
      state: 'running',
      summary: `工具调用: ${toolName}`,
      details: {
        toolId: event.toolId,
        toolName,
      },
    },
    display: {
      title: `${getAgentIcon(agentInfo.agentRole)} 工具调用`,
      subtitle: `${agentInfo.agentName || agentId}: ${toolName}`,
      icon: getAgentIcon(agentInfo.agentRole),
      level: 'summary',
    },
  };

  await sendStatusUpdate(mapping.envelope, wrappedUpdate, ctx.messageHub, ctx.channelBridgeManager);
}

/**
 * 处理 tool_result 事件
 */
export async function handleToolResult(
  event: ToolResultEvent,
  ctx: HandlerContext,
): Promise<void> {
  const sessionId = event.sessionId;
  const mapping = ctx.resolveEnvelopeMapping(sessionId);
  if (!mapping || !ctx.messageHub) return;


  const agentId = event.agentId || 'unknown-agent';
  const toolName = event.toolName || 'unknown-tool';
  const agentInfo = await ctx.getAgentInfo(agentId);

  const wrappedUpdate: WrappedStatusUpdate = {
    type: 'agent_status',
    eventId: event.toolId || `tool-result-${Date.now()}`,
    timestamp: event.timestamp,
    sessionId,
    task: {
      targetAgentId: agentId,
      taskDescription: `工具完成: ${toolName}`,
    },
    agent: agentInfo,
    status: {
      state: 'running',
      summary: `工具完成: ${toolName}`,
      details: {
        toolId: event.toolId,
        toolName,
        duration: event.payload?.duration,
      },
    },
    display: {
      title: `${getAgentIcon(agentInfo.agentRole)} 工具完成`,
      subtitle: `${agentInfo.agentName || agentId}: ${toolName}`,
      icon: getAgentIcon(agentInfo.agentRole),
      level: 'summary',
    },
  };

  await sendStatusUpdate(mapping.envelope, wrappedUpdate, ctx.messageHub, ctx.channelBridgeManager);
}

/**
 * 处理 tool_error 事件
 */
export async function handleToolError(
  event: ToolErrorEvent,
  ctx: HandlerContext,
): Promise<void> {
  const agentId = event.agentId || 'unknown-agent';
  const sessionId = event.sessionId;
  const mapping = ctx.resolveEnvelopeMapping(sessionId);
  if (!mapping) return;

  if (shouldSuppressRawToolError(mapping.envelope.channel)) {
    log.info('[AgentStatusSubscriber] Suppressed raw tool_error push for external channel', {
      channel: mapping.envelope.channel,
      sessionId,
      agentId,
      toolName: event.toolName,
      error: event.payload?.error,
    });
    return;
  }

  const agentInfo = await ctx.getAgentInfo(agentId);
  const wrappedUpdate: WrappedStatusUpdate = {
    type: 'agent_status',
    eventId: event.toolId || `tool-error-${Date.now()}`,
    timestamp: event.timestamp,
    sessionId,
    task: {
      targetAgentId: agentId,
      taskDescription: `工具失败: ${event.toolName}`,
    },
    agent: agentInfo,
    status: {
      state: 'failed',
      summary: `工具失败: ${event.toolName}`,
      details: { error: event.payload?.error, toolName: event.toolName },
    },
    display: {
      title: `${agentInfo.agentName || agentId} 工具失败`,
      subtitle: event.payload?.error,
      icon: getAgentIcon(agentInfo.agentRole),
      level: 'detailed',
    },
  };

  if (ctx.messageHub) {
    await sendStatusUpdate(mapping.envelope, wrappedUpdate, ctx.messageHub, ctx.channelBridgeManager);
  }
}

/**
 * 处理 system_error 事件
 */
export async function handleSystemError(
  event: SystemErrorEvent,
  ctx: HandlerContext,
): Promise<void> {
  const sessionId = event.sessionId;
  const mapping = ctx.resolveEnvelopeMapping(sessionId);
  if (!mapping) return;

  const wrappedUpdate: WrappedStatusUpdate = {
    type: 'agent_status',
    eventId: `system-error-${Date.now()}`,
    timestamp: event.timestamp,
    sessionId,
    task: {
      taskDescription: '系统错误',
    },
    agent: { agentId: 'system' },
    status: {
      state: 'failed',
      summary: event.payload?.error || '系统错误',
      details: { component: event.payload?.component, recoverable: event.payload?.recoverable },
    },
    display: {
      title: '系统错误',
      subtitle: event.payload?.error,
      icon: '⚠️',
      level: 'detailed',
    },
  };

  if (ctx.messageHub) {
    await sendStatusUpdate(mapping.envelope, wrappedUpdate, ctx.messageHub, ctx.channelBridgeManager);
  }
}

/**
 * 处理 dispatch 事件（任务派发）
 */
export async function handleDispatch(
  event: RuntimeEvent,
  ctx: HandlerContext,
): Promise<void> {
  const payload = event.payload as {
    sourceAgentId?: string;
    dispatchId?: string;
    targetAgentId?: string;
    status?: string;
    queuePosition?: number;
    result?: Record<string, unknown>;
    childSessionId?: string;
    sessionId?: string;
  };

  const targetAgentId = payload.targetAgentId;
  if (!targetAgentId) return;

  if (ctx.primaryAgentId && targetAgentId !== ctx.primaryAgentId) {
    ctx.registerChildAgent(targetAgentId, ctx.primaryAgentId);
  }

  const sessionId = event.sessionId;
  const mapping = ctx.resolveEnvelopeMapping(sessionId);
  if (!mapping || !ctx.messageHub) return;


  const agentInfo = await ctx.getAgentInfo(targetAgentId);
  const dispatchStatus = typeof payload.status === 'string' ? payload.status : 'queued';
  const queuePosition = typeof payload.queuePosition === 'number' ? payload.queuePosition : undefined;
  const mailboxMessageId = typeof payload.result?.messageId === 'string' ? payload.result.messageId : undefined;
  const state: WrappedStatusUpdate['status']['state'] = dispatchStatus === 'failed'
    ? 'failed'
    : dispatchStatus === 'completed'
      ? 'completed'
      : 'running';
  const summary = [
    `派发 ${targetAgentId}`,
    `状态: ${dispatchStatus}`,
    typeof queuePosition === 'number' ? `队列 #${queuePosition}` : '',
    mailboxMessageId ? `mailbox: ${mailboxMessageId}` : '',
  ].filter((item) => item.length > 0).join(' · ');

  const wrappedUpdate: WrappedStatusUpdate = {
    type: 'agent_status',
    eventId: payload.dispatchId || `dispatch-${Date.now()}`,
    timestamp: event.timestamp,
    sessionId,
    task: {
      taskId: payload.dispatchId,
      sourceAgentId: payload.sourceAgentId,
      targetAgentId,
      taskDescription: summary,
    },
    agent: agentInfo,
    status: {
      state,
      summary,
      details: {
        dispatchId: payload.dispatchId,
        sourceAgentId: payload.sourceAgentId,
        targetAgentId,
        dispatchStatus,
        ...(typeof queuePosition === 'number' ? { queuePosition } : {}),
        ...(mailboxMessageId ? { mailboxMessageId } : {}),
      },
    },
    display: {
      title: `${getAgentIcon(agentInfo.agentRole)} 派发更新`,
      // avoid duplication: summary is already rendered as status.summary
      subtitle: undefined,
      icon: getAgentIcon(agentInfo.agentRole),
      level: targetAgentId === ctx.primaryAgentId ? 'detailed' : 'summary',
    },
  };

  await sendStatusUpdate(mapping.envelope, wrappedUpdate, ctx.messageHub, ctx.channelBridgeManager);
}

export async function handleWaitingForUser(
  event: RuntimeEvent,
  ctx: HandlerContext,
): Promise<void> {
  const mapping = ctx.resolveEnvelopeMapping(event.sessionId);
  if (!mapping || !ctx.messageHub) return;


  const payload = event.payload as {
    reason?: string;
    options?: Array<{ id?: string; label?: string }>;
    context?: Record<string, unknown>;
  };
  const askContext = payload.context ?? {};
  const question = typeof askContext.question === 'string' && askContext.question.trim().length > 0
    ? askContext.question.trim()
    : '需要你回复后才能继续';
  const options = Array.isArray(payload.options)
    ? payload.options
      .map((item, index) => {
        const label = typeof item?.label === 'string' && item.label.trim().length > 0
          ? item.label.trim()
          : typeof item?.id === 'string' && item.id.trim().length > 0
            ? item.id.trim()
            : '';
        return label ? `${index + 1}. ${label}` : '';
      })
      .filter((item) => item.length > 0)
    : [];
  const extraContext = typeof askContext.context === 'string' && askContext.context.trim().length > 0
    ? askContext.context.trim()
    : '';

  const wrappedUpdate: WrappedStatusUpdate = {
    type: 'agent_status',
    eventId: `waiting-for-user-${Date.now()}`,
    timestamp: event.timestamp,
    sessionId: event.sessionId,
    agent: { agentId: typeof askContext.agentId === 'string' ? askContext.agentId : 'unknown-agent' },
    task: { taskDescription: question },
    status: {
      state: 'waiting',
      summary: question,
      details: {
        reason: payload.reason,
        requestId: typeof askContext.requestId === 'string' ? askContext.requestId : undefined,
      },
    },
    display: {
      title: '❓ 需要你回复',
      subtitle: [
        options.length > 0 ? `可选项：\n${options.join('\n')}` : '请直接回复你的答案。',
        extraContext ? `上下文：${extraContext}` : '',
      ].filter(Boolean).join('\n\n'),
      icon: '❓',
      level: 'detailed',
    },
  };

  await sendStatusUpdate(mapping.envelope, wrappedUpdate, ctx.messageHub, ctx.channelBridgeManager);
}

/**
 * 处理 agent_step_completed 事件（step 批量推送）
 */
export async function handleStepCompleted(
  event: RuntimeEvent,
  ctx: HandlerContext,
): Promise<void> {
  const sessionId = event.sessionId;
  const mapping = ctx.resolveEnvelopeMapping(sessionId);
  if (!mapping) return;

  let stepBatch = ctx.stepBatchDefault;
  let stepUpdatesEnabled = true;
  if (ctx.channelBridgeManager) {
    const pushSettings = ctx.channelBridgeManager.getPushSettings(mapping.envelope.channel);
    stepUpdatesEnabled = pushSettings.stepUpdates;
    stepBatch = Math.max(1, pushSettings.stepBatch);
  }
  if (!stepUpdatesEnabled) return;

  const payload = event.payload as {
    round?: number;
    thought?: string;
    action?: string;
    observation?: string;
    success?: boolean;
  };
  const round = payload.round ?? 0;
  const action = (payload.action || '').trim();
  const thought = (payload.thought || '').trim();
  const observation = (payload.observation || '').trim();

  // Jason 要求：reasoning 不要批量，收到就立刻推送
  if (thought && ctx.sendReasoningUpdate) {
    const stepAgentId = typeof (event as { agentId?: unknown }).agentId === 'string'
      ? ((event as { agentId?: string }).agentId as string)
      : (ctx.primaryAgentId || 'unknown-agent');
    await ctx.sendReasoningUpdate(sessionId, stepAgentId, thought);
  }

  const actionSummary = action
    ? (observation ? `操作: ${action}\n观察: ${observation}` : `操作: ${action}`)
    : '';
  const summary = actionSummary || (!thought ? `步骤 ${round}` : '');
  if (!summary) {
    return;
  }

  const buffer = ctx.stepBuffer.get(sessionId) || [];
  buffer.push({ index: round, summary, timestamp: event.timestamp as string });
  ctx.stepBuffer.set(sessionId, buffer);

  if (buffer.length >= stepBatch) {
    await flushStepBuffer(sessionId, mapping, ctx);
  }
}

/**
 * 刷新 step buffer，批量发送到通道
 */
export async function flushStepBuffer(
  sessionId: string,
  mapping: SessionEnvelopeMapping,
  ctx: HandlerContext,
): Promise<void> {
  const buffer = ctx.stepBuffer.get(sessionId);
  if (!buffer || buffer.length === 0) return;

  ctx.stepBuffer.delete(sessionId);

  if (!ctx.messageHub) return;

  const lines = buffer.map((s, i) => `${i + 1}) ${s.summary}`).join('\n');
  const content = `📋 中间步骤（${buffer.length}）:\n${lines}`;

  const wrappedUpdate: WrappedStatusUpdate = {
    type: 'agent_status',
    eventId: `batch-steps-${Date.now()}`,
    timestamp: new Date().toISOString(),
    sessionId,
    agent: { agentId: 'batch-steps' },
    task: { taskDescription: `执行了 ${buffer.length} 个步骤` },
    status: {
      state: 'running',
      summary: `执行了 ${buffer.length} 个步骤`,
    },
    display: {
      title: '📋 中间步骤',
      subtitle: content,
      icon: '🔄',
      level: 'detailed',
    },
  };

  await sendStatusUpdate(mapping.envelope, wrappedUpdate, ctx.messageHub, ctx.channelBridgeManager);
  log.debug(`[AgentStatusSubscriber] Flushed ${buffer.length} steps for session ${sessionId}`);
}
