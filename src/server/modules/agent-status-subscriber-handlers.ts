/**
 * Agent Status Subscriber - Event Handlers
 *
 * 从主类提取的事件处理函数，减少 agent-status-subscriber.ts 文件大小
 */

import type { RuntimeEvent, ToolErrorEvent, SystemErrorEvent } from '../../runtime/events.js';
import type { SessionEnvelopeMapping, AgentInfo, WrappedStatusUpdate } from './agent-status-subscriber-types.js';
import { getAgentIcon } from './agent-status-subscriber-helpers.js';
import { sendStatusUpdate } from './agent-status-subscriber-runtime.js';
import { logger } from '../../core/logger.js';

const log = logger.module('AgentStatusSubscriberHandlers');

/**
 * 处理上下文，包含事件处理所需的依赖
 */
export interface HandlerContext {
  messageHub?: import('../../orchestration/message-hub.js').MessageHub;
  channelBridgeManager?: import('../../bridges/manager.js').ChannelBridgeManager;
  broadcast?: (message: unknown) => void;
  resolveEnvelopeMapping: (sessionId: string) => SessionEnvelopeMapping | null;
  getAgentInfo: (agentId: string) => Promise<AgentInfo>;
  stepBuffer: Map<string, Array<{ index: number; summary: string; timestamp: string }>>;
  stepBatchDefault: number;
  primaryAgentId: string | null;
  registerChildAgent: (childAgentId: string, parentAgentId: string) => void;
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
    dispatchId?: string;
    targetAgentId?: string;
  };

  const targetAgentId = payload.targetAgentId;
  if (!targetAgentId) return;

  if (ctx.primaryAgentId && targetAgentId !== ctx.primaryAgentId) {
    ctx.registerChildAgent(targetAgentId, ctx.primaryAgentId);
  }
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
  const action = payload.action || '';
  const thought = payload.thought || '';
  const summary = action
    ? (thought ? `思考: ${thought}\n操作: ${action}` : `操作: ${action}`)
    : thought || `步骤 ${round}`;

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
