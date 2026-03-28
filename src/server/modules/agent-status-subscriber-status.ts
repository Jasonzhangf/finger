import type { AgentRuntimeDeps } from './agent-runtime/types.js';
import type { RuntimeEvent } from '../../runtime/events.js';
import type { SessionEnvelopeMapping, TaskContext, WrappedStatusUpdate } from './agent-status-subscriber-types.js';
import { wrapStatusUpdate } from './agent-status-subscriber-helpers.js';
import { sendStatusUpdate, buildMailboxProgressSnapshot } from './agent-status-subscriber-runtime.js';
import { buildContextUsageLine, normalizeContextUsageSnapshot } from './progress-monitor-utils.js';
import { buildSessionRelationLine, resolveSessionRelationInfo } from './agent-status-subscriber-session-utils.js';
import { logger } from '../../core/logger.js';

const log = logger.module('AgentStatusSubscriberStatus');

export async function handleAgentRuntimeStatus(params: {
  event: RuntimeEvent;
  deps: AgentRuntimeDeps;
  primaryAgentId: string | null;
  agentSubscriptions: Map<string, { agentId: string; level: 'detailed' | 'summary'; parentAgentId?: string }>;
  stepBuffer: Map<string, Array<{ index: number; summary: string; timestamp: string }>>;
  getAgentInfo: (agentId: string) => Promise<{ agentId: string; agentName?: string; agentRole?: 'system' | 'project' | 'reviewer' }>;
  resolveEnvelopeMappings: (sessionId: string) => SessionEnvelopeMapping[];
  resolvePushSettings: (sessionId: string, channelId: string) => { statusUpdate: boolean };
  flushStepBuffer: (sessionId: string, mapping: SessionEnvelopeMapping) => Promise<void>;
  messageHub?: import('../../orchestration/message-hub.js').MessageHub;
  channelBridgeManager?: import('../../bridges/manager.js').ChannelBridgeManager;
  broadcast?: (message: unknown) => void;
}): Promise<void> {
  const payload = params.event.payload as {
    scope: string;
    status: string;
    agentId?: string;
    summary?: string;
  };

  const agentId = payload.agentId || (params.event as any).agentId;
  if (!agentId) {
    log.warn('[AgentStatusSubscriber] No agentId in event');
    return;
  }

  const config = params.agentSubscriptions.get(agentId);
  const level = config?.level || 'summary';
  if (level === 'summary' && !['completed', 'failed', 'paused', 'waiting'].includes(payload.status)) {
    return;
  }

  const agentInfo = await params.getAgentInfo(agentId);
  const taskContext: TaskContext = {
    taskId: (params.event as any).dispatchId,
    targetAgentId: agentId,
    sourceAgentId: config?.parentAgentId || (params.event as any).sourceAgentId,
    taskDescription: payload.summary,
  };
  const wrappedUpdate = wrapStatusUpdate(params.event, payload, agentInfo, taskContext, level);
  const sessionId = params.event.sessionId;
  const mappings = params.resolveEnvelopeMappings(sessionId)
    .filter((mapping) => params.resolvePushSettings(sessionId, mapping.envelope.channel).statusUpdate);
  if (mappings.length === 0) {
    return;
  }

  for (const mapping of mappings) {
    mapping.timestamp = Date.now();
  }

  if (params.messageHub) {
    const relationInfo = resolveSessionRelationInfo(params.deps, sessionId);
    const relationLine = buildSessionRelationLine(relationInfo);
    if (relationLine) {
      wrappedUpdate.status.summary = [wrappedUpdate.status.summary, relationLine]
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .join('\n');
      wrappedUpdate.status.details = {
        ...(wrappedUpdate.status.details ?? {}),
        sessionRelation: relationInfo,
      };
    }
    await sendStatusUpdate(
      mappings.map((item) => item.envelope),
      wrappedUpdate,
      params.messageHub,
      params.channelBridgeManager,
    );
  }

  if (params.broadcast) {
    params.broadcast({
      type: 'agent_status',
      sessionId,
      agentId,
      timestamp: params.event.timestamp,
      payload: {
        status: payload.status,
        summary: payload.summary,
        agentName: agentInfo.agentName,
        agentRole: agentInfo.agentRole,
      },
    });
  }

  if (payload.status === 'completed' || payload.status === 'failed') {
    const remainingBuffer = params.stepBuffer.get(sessionId);
    if (remainingBuffer && remainingBuffer.length > 0) {
      await params.flushStepBuffer(sessionId, mappings[0]);
    }

    const session = params.deps.sessionManager.getSession(sessionId);
    const context = (session?.context && typeof session.context === 'object')
      ? (session.context as Record<string, unknown>)
      : {};
    const cleanupContext: Record<string, unknown> = {};
    if (context.progressDeliveryTransient === true) {
      cleanupContext.progressDelivery = null;
      cleanupContext.progressDeliveryTransient = false;
      cleanupContext.progressDeliveryUpdatedAt = null;
    }
    if (context.scheduledProgressDeliveryTransient === true) {
      cleanupContext.scheduledProgressDelivery = null;
      cleanupContext.scheduledProgressDeliveryTransient = false;
    }
    if (Object.keys(cleanupContext).length > 0) {
      params.deps.sessionManager.updateContext(sessionId, cleanupContext);
    }
  }
}

export async function sendProgressUpdateToChannels(params: {
  deps: AgentRuntimeDeps;
  report: {
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
    };
  };
  primaryAgentId: string | null;
  lastProgressMailboxSummaryBySession: Map<string, string>;
  resolveEnvelopeMappings: (sessionId: string) => SessionEnvelopeMapping[];
  resolvePushSettings: (sessionId: string, channelId: string) => {
    statusUpdate: boolean;
    updateMode: string;
    progressUpdates: boolean;
  };
  messageHub?: import('../../orchestration/message-hub.js').MessageHub;
  channelBridgeManager?: import('../../bridges/manager.js').ChannelBridgeManager;
}): Promise<void> {
  const mappings = params.resolveEnvelopeMappings(params.report.sessionId);
  if (mappings.length === 0 || !params.messageHub) return;

  const progressMappings = mappings.filter((mapping) => {
    const pushSettings = params.resolvePushSettings(params.report.sessionId, mapping.envelope.channel);
    return pushSettings.statusUpdate && pushSettings.updateMode !== 'command' && pushSettings.progressUpdates;
  });
  if (progressMappings.length === 0) return;

  const mailboxTargetAgent = typeof params.report.agentId === 'string' && params.report.agentId.trim().length > 0 && params.report.agentId !== 'unknown'
    ? params.report.agentId
    : (params.primaryAgentId || 'finger-system-agent');
  const mailboxSnapshot = buildMailboxProgressSnapshot(mailboxTargetAgent, params.primaryAgentId || 'finger-system-agent');
  const mailboxHasSignal = !!mailboxSnapshot
    && (mailboxSnapshot.counts.unread > 0 || mailboxSnapshot.counts.pending > 0 || mailboxSnapshot.counts.processing > 0);
  const mailboxSummaryText = mailboxHasSignal ? mailboxSnapshot?.summaryText : undefined;
  const lastMailboxSummary = params.lastProgressMailboxSummaryBySession.get(params.report.sessionId);
  const includeMailboxSummary = typeof mailboxSummaryText === 'string'
    && mailboxSummaryText.length > 0
    && mailboxSummaryText !== lastMailboxSummary;
  if (includeMailboxSummary && mailboxSummaryText) {
    params.lastProgressMailboxSummaryBySession.set(params.report.sessionId, mailboxSummaryText);
  }
  const mailboxSummary = includeMailboxSummary && mailboxSummaryText
    ? `📬 ${mailboxSummaryText}`
    : undefined;
  const relationInfo = resolveSessionRelationInfo(params.deps, params.report.sessionId);
  const relationLine = buildSessionRelationLine(relationInfo);
  const contextSnapshot = normalizeContextUsageSnapshot({
    contextUsagePercent: params.report.progress.contextUsagePercent,
    estimatedTokensInContextWindow: params.report.progress.estimatedTokensInContextWindow,
    maxInputTokens: params.report.progress.maxInputTokens,
  });
  const contextSummary = buildContextUsageLine(contextSnapshot);
  const normalizedReportSummary = params.report.summary ?? '';
  const appendContextSummary = contextSummary && !normalizedReportSummary.includes(contextSummary)
    ? contextSummary
    : undefined;
  const summary = [params.report.summary, relationLine, appendContextSummary, mailboxSummary]
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .join('\n');
  if (!summary) return;

  const wrappedUpdate: WrappedStatusUpdate = {
    type: 'agent_status',
    eventId: `progress-${Date.now()}`,
    timestamp: new Date().toISOString(),
    sessionId: params.report.sessionId,
    agent: { agentId: params.report.agentId },
    task: { taskDescription: params.report.summary },
    status: {
      state: params.report.progress.status === 'completed' ? 'completed'
        : params.report.progress.status === 'failed' ? 'failed'
        : 'running',
      summary,
      details: {
        toolCalls: params.report.progress.toolCallsCount,
        modelRounds: params.report.progress.modelRoundsCount,
        elapsedMs: params.report.progress.elapsedMs,
        ...(typeof params.report.progress.contextUsagePercent === 'number'
          ? { contextUsagePercent: params.report.progress.contextUsagePercent }
          : {}),
        ...(typeof params.report.progress.estimatedTokensInContextWindow === 'number'
          ? { estimatedTokensInContextWindow: params.report.progress.estimatedTokensInContextWindow }
          : {}),
        maxInputTokens: contextSnapshot.maxInputTokens,
        ...(mailboxHasSignal && mailboxSnapshot
          ? {
              mailboxStatus: {
                target: mailboxSnapshot.target,
                counts: mailboxSnapshot.counts,
                recentUnread: mailboxSnapshot.recentUnread,
              },
            }
          : {}),
        ...(relationLine
          ? {
              sessionRelation: relationInfo,
            }
          : {}),
      },
    },
    display: {
      title: '📊 进度更新',
      subtitle: undefined,
      icon: '🔄',
      level: 'detailed',
    },
  };

  await sendStatusUpdate(
    progressMappings.map((item) => item.envelope),
    wrappedUpdate,
    params.messageHub,
    params.channelBridgeManager,
  );
}
