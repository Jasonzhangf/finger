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
import type { SessionEnvelopeMapping, AgentInfo, WrappedStatusUpdate } from '../../server/modules/agent-status-subscriber-types.js';
import { getAgentIcon } from '../../server/modules/agent-status-subscriber-helpers.js';
import { sendStatusUpdate } from '../../server/modules/agent-status-subscriber-runtime.js';
import { logger } from '../../core/logger.js';
import type { PushSettings } from '../../bridges/types.js';
import {
  asRecord,
  asTrimmedString,
  buildDispatchReasonSummary,
  buildDispatchMailboxPreview,
  buildDispatchSourceSummary,
  filterStatusMappings,
  isMailboxDispatchStatus,
  parseToolSummary,
  resolvePushSettingsForChannel,
  shouldPushCommandStyleUpdates,
  sanitizeUserFacingStatusText,
  shouldSuppressRawToolError,
  truncateInline,
} from '../../server/modules/agent-status-subscriber-handler-helpers.js';
import {
  buildSessionRelationLine,
  resolveSessionRelationInfo,
} from '../../server/modules/agent-status-subscriber-session-utils.js';
import {
  parseProjectTaskState,
} from '../../common/project-task-state.js';
import {
  mergeSystemTaskState,
  parseSystemTaskState,
} from '../../common/system-task-state.js';
import { isNoActionableWatchdogText, isSystemRecoverySourceAgent } from '../../server/modules/agent-status-subscriber-noop.js';
import { resolveAgentDisplayName } from '../../server/modules/agent-name-resolver.js';
import { applyProjectStatusGatewayPatch } from '../../server/modules/project-status-gateway.js';

const log = logger.module('AgentStatusSubscriberHandlers');
const DISPATCH_QUEUED_SYSTEM_PUSH_COOLDOWN_MS = 10 * 60 * 1000;
const lastQueuedSystemDispatchPushByKey = new Map<string, number>();
const SYSTEM_AGENT_ID = 'finger-system-agent';
const STARTUP_NOISE_SOURCE_AGENTS = new Set([
  'system-recovery',
  'system-project-recovery',
  'system-reviewer-recovery',
  'system-startup-review',
]);

type PlanStepStatus = 'pending' | 'in_progress' | 'completed';
interface PlanStep {
  step: string;
  status: PlanStepStatus;
}

function isRestartInterruptionText(value: string): boolean {
  const text = value.trim().toLowerCase();
  if (!text) return false;
  return (
    text.includes('process exited with signal sigterm')
    || text.includes('exited with signal sigterm')
    || text.includes('signal sigterm')
    || text.includes('shutdown initiated: sigterm')
  );
}

/**
 * 处理上下文，包含事件处理所需的依赖
 */
export interface HandlerContext {
  messageHub?: import('../../orchestration/message-hub.js').MessageHub;
  channelBridgeManager?: import('../../bridges/manager.js').ChannelBridgeManager;
  broadcast?: (message: unknown) => void;
  resolveEnvelopeMapping: (sessionId: string) => SessionEnvelopeMapping | null;
  resolveEnvelopeMappings: (sessionId: string) => SessionEnvelopeMapping[];
  getAgentInfo: (agentId: string) => Promise<AgentInfo>;
  sendReasoningUpdate?: (sessionId: string, agentId: string, reasoningText: string) => Promise<void>;
  stepBuffer: Map<string, Array<{ index: number; summary: string; timestamp: string }>>;
  stepBatchDefault: number;
  primaryAgentId: string | null;
  registerChildAgent: (childAgentId: string, parentAgentId: string) => void;
  registerChildSession: (childSessionId: string, envelope: SessionEnvelopeMapping[ 'envelope']) => void;
  resolvePushSettings?: (
    sessionId: string,
    channelId: string,
    options?: {
      phase?: string;
      kind?: string;
      sourceType?: string;
      agentId?: string;
    },
  ) => PushSettings;
  deps?: import('../../server/modules/agent-runtime/types.js').AgentRuntimeDeps;
}

/**
 * 处理 tool_call 事件
 */
export async function handleToolCall(
  event: ToolCallEvent,
  _ctx: HandlerContext,
): Promise<void> {
  log.debug('[AgentStatusSubscriber] Skip tool_call push; only emit tool_result/tool_error', {
    sessionId: event.sessionId,
    agentId: event.agentId,
    toolName: event.toolName,
    toolId: event.toolId,
  });
}

/**
 * 处理 tool_result 事件
 */
export async function handleToolResult(
  event: ToolResultEvent,
  ctx: HandlerContext,
): Promise<void> {
  const sessionId = event.sessionId;
  const mappings = ctx.resolveEnvelopeMappings(sessionId);
  if (mappings.length === 0 || !ctx.messageHub) return;
  const toolPayload = asRecord(event.payload);
  if (!shouldPushCommandStyleUpdates(ctx, sessionId, mappings, {
    phase: 'execution',
    kind: 'tool',
    sourceType: typeof toolPayload?.source === 'string' ? toolPayload.source : undefined,
    agentId: event.agentId,
  })) return;


  const agentId = event.agentId || 'unknown-agent';
  const toolName = event.toolName || 'unknown-tool';
  const agentInfo = await ctx.getAgentInfo(agentId);
  const parsed = parseToolSummary(toolName, event.payload?.input, event.payload?.output);
  const statusTag = 'success';
  const signalText = parsed.signals && parsed.signals.length > 0 ? ` · ${parsed.signals.join(' · ')}` : '';
  const baseTaskDescription = `[${parsed.verb}] ${parsed.target ?? toolName} · ${statusTag}${signalText}`;
  const relationInfo = ctx.deps ? resolveSessionRelationInfo(ctx.deps, sessionId) : undefined;
  const relationLine = relationInfo ? buildSessionRelationLine(relationInfo) : undefined;
  const taskDescription = [baseTaskDescription, relationLine]
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .join('\n');

  const wrappedUpdate: WrappedStatusUpdate = {
    type: 'agent_status',
    eventId: event.toolId || `tool-result-${Date.now()}`,
    timestamp: event.timestamp,
    sessionId,
    task: {
      targetAgentId: agentId,
      taskDescription,
    },
    agent: agentInfo,
    status: {
      state: 'running',
      summary: taskDescription,
      details: {
        toolId: event.toolId,
        toolName,
        duration: event.payload?.duration,
        ...(parsed.signals && parsed.signals.length > 0 ? { signals: parsed.signals } : {}),
        ...(parsed.details ? parsed.details : {}),
        ...(relationLine && relationInfo ? { sessionRelation: relationInfo } : {}),
      },
    },
    display: {
      title: `${getAgentIcon(agentInfo.agentRole)} ${agentInfo.agentName || agentId}`,
      subtitle: `${agentInfo.agentName || agentId}`,
      icon: getAgentIcon(agentInfo.agentRole),
      level: 'summary',
    },
  };

  await sendStatusUpdate(mappings.map((item) => item.envelope), wrappedUpdate, ctx.messageHub, ctx.channelBridgeManager);
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
  const mappings = ctx.resolveEnvelopeMappings(sessionId);
  if (mappings.length === 0) return;
  const toolPayload = asRecord(event.payload);
  if (!shouldPushCommandStyleUpdates(ctx, sessionId, mappings, {
    phase: 'execution',
    kind: 'error',
    sourceType: typeof toolPayload?.source === 'string' ? toolPayload.source : undefined,
    agentId,
  })) return;

  const suppressRawToolError = mappings.every((mapping) => shouldSuppressRawToolError(mapping.envelope.channel));
  if (suppressRawToolError) {
    log.info('[AgentStatusSubscriber] Suppressed raw tool_error push for external channel', {
      channel: mappings.map((mapping) => mapping.envelope.channel).join(','),
      sessionId,
      agentId,
      toolName: event.toolName,
      error: event.payload?.error,
    });
  }

  const agentInfo = await ctx.getAgentInfo(agentId);
  const parsed = parseToolSummary(event.toolName || 'unknown-tool', event.payload?.input);
  const signalText = parsed.signals && parsed.signals.length > 0 ? ` · ${parsed.signals.join(' · ')}` : '';
  const rawErrorText = asTrimmedString(event.payload?.error);
  const sanitizedErrorText = sanitizeUserFacingStatusText(rawErrorText, 160);
  const detailError = suppressRawToolError
    ? (sanitizedErrorText || undefined)
    : (rawErrorText || undefined);
  const baseTaskDescription = `[${parsed.verb}] ${parsed.target ?? (event.toolName || 'unknown-tool')} · failed${signalText}`;
  const relationInfo = ctx.deps ? resolveSessionRelationInfo(ctx.deps, sessionId) : undefined;
  const relationLine = relationInfo ? buildSessionRelationLine(relationInfo) : undefined;
  const taskDescription = [baseTaskDescription, relationLine, suppressRawToolError ? sanitizedErrorText : undefined]
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .join('\n');
  const wrappedUpdate: WrappedStatusUpdate = {
    type: 'agent_status',
    eventId: event.toolId || `tool-error-${Date.now()}`,
    timestamp: event.timestamp,
    sessionId,
    task: {
      targetAgentId: agentId,
      taskDescription,
    },
    agent: agentInfo,
    status: {
      state: 'failed',
      summary: taskDescription,
      details: {
        error: detailError,
        toolName: event.toolName,
        ...(parsed.signals && parsed.signals.length > 0 ? { signals: parsed.signals } : {}),
        ...(parsed.details ? parsed.details : {}),
        ...(relationLine && relationInfo ? { sessionRelation: relationInfo } : {}),
      },
    },
    display: {
      title: `${getAgentIcon(agentInfo.agentRole)} ${agentInfo.agentName || agentId}`,
      subtitle: detailError,
      icon: getAgentIcon(agentInfo.agentRole),
      level: 'detailed',
    },
  };

  if (ctx.messageHub) {
    await sendStatusUpdate(mappings.map((item) => item.envelope), wrappedUpdate, ctx.messageHub, ctx.channelBridgeManager);
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
  const mappings = filterStatusMappings(ctx, sessionId, ctx.resolveEnvelopeMappings(sessionId), {
    phase: 'completion',
    kind: 'error',
    sourceType: 'system-inject',
  });
  if (mappings.length === 0) return;

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
    await sendStatusUpdate(mappings.map((item) => item.envelope), wrappedUpdate, ctx.messageHub, ctx.channelBridgeManager);
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
    assignment?: Record<string, unknown>;
    childSessionId?: string;
    sessionId?: string;
    rootSessionId?: string;
    parentSessionId?: string;
  };

  const targetAgentId = payload.targetAgentId;
  if (!targetAgentId) return;

  if (ctx.primaryAgentId && targetAgentId !== ctx.primaryAgentId) {
    ctx.registerChildAgent(targetAgentId, ctx.primaryAgentId);
  }

  const sessionId = event.sessionId;
  const dispatchParentSessionId = asTrimmedString(payload.parentSessionId)
    || asTrimmedString(payload.rootSessionId)
    || asTrimmedString(payload.sessionId);
  const resultRecord = asRecord(payload.result);
  const dispatchSourceType = typeof payload.sourceAgentId === 'string'
    ? payload.sourceAgentId
    : (typeof resultRecord?.source === 'string' ? resultRecord.source : undefined);

  let mappings = filterStatusMappings(ctx, sessionId, ctx.resolveEnvelopeMappings(sessionId), {
    phase: 'dispatch',
    kind: 'status',
    sourceType: dispatchSourceType,
    agentId: targetAgentId,
  });
  if (mappings.length === 0 && dispatchParentSessionId) {
    const parentMappings = filterStatusMappings(
      ctx,
      dispatchParentSessionId,
      ctx.resolveEnvelopeMappings(dispatchParentSessionId),
      {
        phase: 'dispatch',
        kind: 'status',
        sourceType: dispatchSourceType,
        agentId: targetAgentId,
      },
    );
    if (parentMappings.length > 0) {
      for (const mapping of parentMappings) {
        ctx.registerChildSession(sessionId, mapping.envelope);
      }
      mappings = filterStatusMappings(ctx, sessionId, ctx.resolveEnvelopeMappings(sessionId), {
        phase: 'dispatch',
        kind: 'status',
        sourceType: dispatchSourceType,
        agentId: targetAgentId,
      });
    }
  }
  if (mappings.length === 0 || !ctx.messageHub) return;


  const dispatchStatus = typeof payload.status === 'string' ? payload.status : 'queued';
  const queuePosition = typeof payload.queuePosition === 'number' ? payload.queuePosition : undefined;
  const resultStatus = asTrimmedString(resultRecord?.status);
  const resultSummary = sanitizeUserFacingStatusText(asTrimmedString(resultRecord?.summary), 240);
  const nextAction = sanitizeUserFacingStatusText(asTrimmedString(resultRecord?.nextAction), 240);
  const assignmentRecord = asRecord(payload.assignment);
  const assignerAgentId = asTrimmedString(
    assignmentRecord?.assignerAgentId
    ?? assignmentRecord?.assigner_agent_id
    ?? payload.sourceAgentId,
  );
  const assigneeAgentId = asTrimmedString(
    assignmentRecord?.assigneeAgentId
    ?? assignmentRecord?.assignee_agent_id
    ?? targetAgentId,
  );
  const assignerName = asTrimmedString(assignmentRecord?.assignerName ?? assignmentRecord?.assigner_name)
    || resolveAgentDisplayName(assignerAgentId || payload.sourceAgentId || 'unknown');
  const assigneeName = asTrimmedString(assignmentRecord?.assigneeName ?? assignmentRecord?.assignee_name)
    || resolveAgentDisplayName(assigneeAgentId || targetAgentId);
  const displayAgentId = assigneeAgentId || targetAgentId;
  const agentInfo = await ctx.getAgentInfo(displayAgentId);
  const assignmentTaskId = asTrimmedString(assignmentRecord?.taskId);
  const explicitMailboxMessageId = asTrimmedString(resultRecord?.mailboxMessageId);
  const candidateMessageId = asTrimmedString(resultRecord?.messageId);
  const mailboxFlow = isMailboxDispatchStatus(dispatchStatus)
    || isMailboxDispatchStatus(resultStatus)
    || explicitMailboxMessageId.length > 0;
  const mailboxMessageId = explicitMailboxMessageId || (mailboxFlow ? candidateMessageId : '');
  const mailboxPreview = mailboxFlow
    ? buildDispatchMailboxPreview({
        targetAgentId,
        mailboxMessageId,
        resultSummary,
        nextAction,
      })
    : '';
  const sourceAgentSummary = buildDispatchSourceSummary(asTrimmedString(payload.sourceAgentId) || 'unknown', assignerName);
  const reasonSummaryRaw = buildDispatchReasonSummary({
    dispatchStatus,
    resultStatus,
    queuePosition,
    mailboxFlow,
    mailboxPreview,
    resultSummary,
    nextAction,
    assignmentTaskId,
  });
  const rawError = asTrimmedString(resultRecord?.error) || '';
  const restartInterrupted = dispatchStatus === 'failed'
    && (
      isRestartInterruptionText(rawError)
      || isRestartInterruptionText(resultSummary)
      || isRestartInterruptionText(reasonSummaryRaw)
    );
  const displayDispatchStatus = restartInterrupted ? 'interrupted' : dispatchStatus;
  const reasonSummary = restartInterrupted
    ? '运行时重启导致本次派发中断，系统将继续恢复/重试'
    : reasonSummaryRaw;
  const childSessionId = asTrimmedString(payload.childSessionId)
    || asTrimmedString(resultRecord?.childSessionId)
    || (mailboxFlow ? '' : asTrimmedString(resultRecord?.sessionId));
  const normalizedChildSessionId = childSessionId
    && childSessionId !== dispatchParentSessionId
    && childSessionId !== sessionId
    ? childSessionId
    : '';
  if (normalizedChildSessionId) {
    for (const mapping of mappings) {
      ctx.registerChildSession(normalizedChildSessionId, mapping.envelope);
    }
  }
  const relationParts = [
    normalizedChildSessionId ? `子会话 ${truncateInline(normalizedChildSessionId, 40)}` : '',
    dispatchParentSessionId && normalizedChildSessionId ? `父会话 ${truncateInline(dispatchParentSessionId, 40)}` : '',
    targetAgentId ? `Agent ${assigneeName}(${targetAgentId})` : '',
  ].filter((item) => item.length > 0);
  const dispatchRelationLine = relationParts.length > 0 ? `关系: ${relationParts.join(' · ')}` : '';
  const state: WrappedStatusUpdate['status']['state'] = restartInterrupted
    ? 'waiting'
    : dispatchStatus === 'failed'
      ? 'failed'
      : dispatchStatus === 'completed'
        ? 'completed'
        : 'running';
  const sourceAgentId = asTrimmedString(payload.sourceAgentId);
  const isProjectRecoverySource = sourceAgentId === 'system-project-recovery';
  const isHeartbeatSource = sourceAgentId === 'system-heartbeat';
  const isSystemRecoverySource = isSystemRecoverySourceAgent(sourceAgentId);
  const isSystemTarget = targetAgentId === SYSTEM_AGENT_ID;
  const isStartupNoiseSource = STARTUP_NOISE_SOURCE_AGENTS.has(sourceAgentId);
  const isStartupTransientStatus = dispatchStatus === 'queued'
    || dispatchStatus === 'running'
    || dispatchStatus === 'completed'
    || restartInterrupted;
  if (isStartupNoiseSource && isStartupTransientStatus && !mailboxFlow) {
    log.debug('[AgentStatusSubscriber] Suppress startup/recovery dispatch noise', {
      sessionId,
      targetAgentId,
      sourceAgentId,
      dispatchStatus,
      resultStatus,
      reasonSummary,
      restartInterrupted,
    });
    return;
  }
  if (dispatchStatus === 'queued' && isProjectRecoverySource && !mailboxFlow) {
    // Startup recovery often emits many queued dispatch events across monitored projects.
    // Suppress these low-signal queue notifications to avoid channel spam.
    return;
  }
  if (isSystemTarget && isHeartbeatSource && dispatchStatus === 'queued' && !mailboxFlow) {
    // Heartbeat queued->system is internal control flow and creates frequent startup/runtime noise.
    return;
  }
  if (isSystemTarget && mailboxFlow && dispatchStatus !== 'failed' && !restartInterrupted) {
    // Mailbox handoff events routed back to system agent are internal coordination updates.
    // Keep hard failures visible; suppress routine queued/processing/completed noise.
    return;
  }
  const isSystemLikeSource = sourceAgentId === 'system-heartbeat'
    || sourceAgentId === 'finger-system-agent'
    || sourceAgentId.includes('system-agent');
  const isProjectTarget = targetAgentId.includes('project-agent');
  if (dispatchStatus === 'queued' && isSystemLikeSource && isProjectTarget && !mailboxFlow) {
    const suppressKey = `${sessionId}::${targetAgentId}::queued_system_dispatch`;
    const now = Date.now();
    const last = lastQueuedSystemDispatchPushByKey.get(suppressKey) ?? 0;
    if (now - last < DISPATCH_QUEUED_SYSTEM_PUSH_COOLDOWN_MS) {
      return;
    }
    lastQueuedSystemDispatchPushByKey.set(suppressKey, now);
  }
  const heartbeatNoopText = [
    reasonSummary,
    resultSummary,
    nextAction,
  ]
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .join(' ');
  const isHeartbeatNoop = isHeartbeatSource && isNoActionableWatchdogText(heartbeatNoopText);
  const isRecoveryNoop = isSystemRecoverySource && isNoActionableWatchdogText(heartbeatNoopText);
  if (isHeartbeatNoop) {
    const sessionManager = ctx.deps?.sessionManager as {
      getSession?: (id: string) => { context?: Record<string, unknown> } | undefined;
    } | undefined;
    if (ctx.deps?.sessionManager && sessionManager && typeof sessionManager.getSession === 'function') {
      const session = sessionManager.getSession(sessionId);
      const currentProjectTaskState = parseProjectTaskState(session?.context?.projectTaskState);
      if (currentProjectTaskState && currentProjectTaskState.targetAgentId === targetAgentId && currentProjectTaskState.active) {
        const nextRevision = typeof currentProjectTaskState.revision === 'number'
          ? currentProjectTaskState.revision + 1
          : undefined;
        applyProjectStatusGatewayPatch({
          sessionManager: ctx.deps.sessionManager,
          sessionIds: [sessionId],
          source: 'agent-status-subscriber.dispatch.heartbeat_noop',
          patch: {
            active: false,
            status: 'closed',
            ...(typeof nextRevision === 'number' ? { revision: nextRevision } : {}),
            note: 'watchdog_no_actionable_auto_closed',
            summary: reasonSummary || 'watchdog_no_actionable',
            taskId: currentProjectTaskState.taskId,
            taskName: currentProjectTaskState.taskName,
            dispatchId: currentProjectTaskState.dispatchId,
            boundSessionId: currentProjectTaskState.boundSessionId,
            sourceAgentId: currentProjectTaskState.sourceAgentId,
            targetAgentId: currentProjectTaskState.targetAgentId,
            assigneeWorkerId: currentProjectTaskState.assigneeWorkerId,
            assigneeWorkerName: currentProjectTaskState.assigneeWorkerName,
            blockedBy: currentProjectTaskState.blockedBy,
          },
        });
      }
    }
    log.debug('[AgentStatusSubscriber] Suppress heartbeat no-op dispatch update', {
      sessionId,
      targetAgentId,
      dispatchStatus,
      resultStatus,
      reasonSummary,
    });
    return;
  }
  if (isRecoveryNoop) {
    log.debug('[AgentStatusSubscriber] Suppress recovery no-op dispatch update', {
      sessionId,
      targetAgentId,
      dispatchStatus,
      resultStatus,
      reasonSummary,
      sourceAgentId,
    });
    return;
  }
  const heartbeatTimeLabel = isHeartbeatSource
    ? `心跳时间: ${new Date(event.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}`
    : '';

  const summary = [
    `派发 ${assigneeName}(${targetAgentId})`,
    `状态: ${displayDispatchStatus}`,
    `assigner: ${assignerName}${assignerAgentId ? `(${assignerAgentId})` : ''}`,
    `assignee: ${assigneeName}${assigneeAgentId ? `(${assigneeAgentId})` : ''}`,
    heartbeatTimeLabel,
    `来源: ${sourceAgentSummary}`,
    `原因: ${reasonSummary}`,
    typeof queuePosition === 'number' ? `队列 #${queuePosition}` : '',
    mailboxPreview ? `mailbox: ${mailboxPreview}` : '',
    !mailboxFlow && resultSummary ? `摘要: ${truncateInline(resultSummary, 96)}` : '',
  ].filter((item) => item.length > 0).join(' · ');
  const summaryWithRelation = [summary, dispatchRelationLine]
    .filter((item) => item.length > 0)
    .join('\n');

  const wrappedUpdate: WrappedStatusUpdate = {
    type: 'agent_status',
    eventId: payload.dispatchId || `dispatch-${Date.now()}`,
    timestamp: event.timestamp,
    sessionId,
    task: {
      taskId: payload.dispatchId,
      sourceAgentId: payload.sourceAgentId,
      targetAgentId,
      taskDescription: summaryWithRelation,
    },
    agent: agentInfo,
    status: {
      state,
      summary: summaryWithRelation,
      details: {
        dispatchId: payload.dispatchId,
        sourceAgentId: payload.sourceAgentId,
        assignerName,
        assigneeName,
        dispatchSourceSummary: sourceAgentSummary,
        targetAgentId,
        dispatchStatus,
        displayDispatchStatus,
        dispatchReasonSummary: reasonSummary,
        ...(restartInterrupted ? { restartInterrupted: true } : {}),
        ...(typeof queuePosition === 'number' ? { queuePosition } : {}),
        ...(resultStatus ? { resultStatus } : {}),
        ...(resultSummary ? { resultSummary: truncateInline(resultSummary, 240) } : {}),
        ...(normalizedChildSessionId ? { childSessionId: normalizedChildSessionId } : {}),
        ...(dispatchParentSessionId ? { parentSessionId: dispatchParentSessionId } : {}),
        ...(mailboxFlow ? { mailboxFlow: true } : {}),
        ...(mailboxPreview ? { mailboxPreview } : {}),
        ...(dispatchRelationLine ? { dispatchRelation: dispatchRelationLine } : {}),
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

  await sendStatusUpdate(mappings.map((item) => item.envelope), wrappedUpdate, ctx.messageHub, ctx.channelBridgeManager);
}

export async function handleWaitingForUser(
  event: RuntimeEvent,
  ctx: HandlerContext,
): Promise<void> {
  const payloadRecord = asRecord(event.payload);
  const mappings = filterStatusMappings(ctx, event.sessionId, ctx.resolveEnvelopeMappings(event.sessionId), {
    phase: 'execution',
    kind: 'decision',
    sourceType: typeof payloadRecord?.source === 'string' ? payloadRecord.source : undefined,
    agentId: typeof (event as { agentId?: string }).agentId === 'string' ? (event as { agentId?: string }).agentId : undefined,
  });
  if (mappings.length === 0 || !ctx.messageHub) return;


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

  await sendStatusUpdate(mappings.map((item) => item.envelope), wrappedUpdate, ctx.messageHub, ctx.channelBridgeManager);
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
  const payloadRecord = asRecord(event.payload);

  let stepBatch = ctx.stepBatchDefault;
  let stepUpdatesEnabled = true;
  if (ctx.channelBridgeManager || typeof ctx.resolvePushSettings === 'function') {
    const pushSettings = resolvePushSettingsForChannel(ctx, sessionId, mapping.envelope.channel, {
      phase: 'execution',
      kind: 'reasoning',
      sourceType: typeof payloadRecord?.source === 'string' ? payloadRecord.source : undefined,
      agentId: typeof (event as { agentId?: string }).agentId === 'string' ? (event as { agentId?: string }).agentId : undefined,
    });
    if (pushSettings) {
    stepUpdatesEnabled = pushSettings.stepUpdates;
    stepBatch = Math.max(1, pushSettings.stepBatch);
    }
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
