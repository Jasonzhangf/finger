import { logger } from '../../core/logger.js';
import type { SessionManager } from '../../orchestration/session-manager.js';
import type { UnifiedEventBus } from '../../runtime/event-bus.js';
import type { ChatCodexLoopEvent } from '../../agents/finger-general/finger-general-module.js';
import type { AgentStatusSubscriber } from './agent-status-subscriber.js';
import { isObjectRecord } from '../common/object.js';
import {
  buildDispatchFeedbackPayload,
  buildLedgerPointerInfo,
  extractLoopToolTrace,
  formatLedgerPointerContent,
} from './event-forwarding-helpers.js';
import { attachBroadcastHandlers } from './event-forwarding-handlers.js';

type SessionEventRecord = {
  type: 'tool_call' | 'tool_result' | 'tool_error' | 'agent_step' | 'reasoning';
  agentId?: string;
  toolName?: string;
  toolStatus?: 'success' | 'error';
  toolDurationMs?: number;
  toolInput?: unknown;
  toolOutput?: unknown;
  metadata?: Record<string, unknown>;
};
export interface EventForwardingDeps {
  eventBus: UnifiedEventBus;
  broadcast: (message: unknown) => void;
  sessionManager: SessionManager;
  agentStatusSubscriber?: AgentStatusSubscriber;
  runtimeInstructionBus: { push: (workflowId: string, content: string) => void };
  inferAgentRoleLabel: (agentId: string) => string;
  formatDispatchResultContent: (result: unknown, error?: string) => string;
  asString: (value: unknown) => string | undefined;
  generalAgentId: string;
}


export function attachEventForwarding(deps: EventForwardingDeps): {
  emitLoopEventToEventBus: (event: ChatCodexLoopEvent) => void;
} {
  const {
    eventBus,
    broadcast,
    sessionManager,
    agentStatusSubscriber,
    runtimeInstructionBus,
    inferAgentRoleLabel,
    formatDispatchResultContent,
    asString,
    generalAgentId,
  } = deps;

  const persistSessionEventMessage = (
    sessionId: string,
    content: string,
    detail: SessionEventRecord,
    role: 'user' | 'assistant' | 'system' | 'orchestrator' = 'system',
  ): void => {
    if (!sessionId || sessionId.trim().length === 0) return;
    void sessionManager.addMessage(sessionId, role, content, detail);
  };

  const hasLedgerPointerMessage = (sessionId: string, label: string): boolean => {
    const messages = sessionManager.getMessages(sessionId, 0);
    return messages.some((message) => message.type === 'ledger_pointer'
      && isObjectRecord(message.metadata)
      && isObjectRecord(message.metadata.ledgerPointer)
      && message.metadata.ledgerPointer.label === label);
  };

  const addLedgerPointerMessage = (sessionId: string, label: string, agentId: string): void => {
    if (!sessionId || sessionId.trim().length === 0) return;
    if (hasLedgerPointerMessage(sessionId, label)) return;
    const pointerInfo = buildLedgerPointerInfo({ sessionId, agentId });
    const content = formatLedgerPointerContent(pointerInfo, label);
    void sessionManager.addMessage(sessionId, 'system', content, {
      type: 'ledger_pointer',
      agentId,
      metadata: {
        ledgerPointer: {
          label,
          ...pointerInfo,
        },
      },
    });
  };

  const emitToolStepEventsFromLoopEvent = (event: ChatCodexLoopEvent): void => {
    if (event.phase !== 'kernel_event') return;
    if (event.payload.enableLegacyToolTraceFallback !== true) return;
    const eventType = typeof event.payload.type === 'string' ? event.payload.type : '';
    if (eventType !== 'task_complete') return;
    if (event.payload.syntheticToolEvents === true || event.payload.realtimeToolEvents === true) return;

    const toolTrace = extractLoopToolTrace(event.payload.toolTrace);
    if (toolTrace.length === 0) return;

    const base = Date.parse(event.timestamp);
    const baseMs = Number.isFinite(base) ? base : Date.now();
    for (let i = 0; i < toolTrace.length; i += 1) {
      const trace = toolTrace[i];
      const toolId = trace.callId ?? `${event.sessionId}-tool-${i + 1}`;
      const resultTimestamp = new Date(baseMs + i * 2 + 1).toISOString();

      if (trace.status === 'ok') {
        broadcast({
          type: 'tool_result',
          sessionId: event.sessionId,
          agentId: generalAgentId,
          timestamp: resultTimestamp,
          payload: {
            toolId,
            toolName: trace.tool,
            ...(trace.input !== undefined ? { input: trace.input } : {}),
            ...(trace.output !== undefined ? { output: trace.output } : {}),
            ...(typeof trace.durationMs === 'number' ? { duration: trace.durationMs } : {}),
          },
        });
        continue;
      }

      broadcast({
        type: 'tool_error',
        sessionId: event.sessionId,
        agentId: generalAgentId,
        timestamp: resultTimestamp,
        payload: {
          toolId,
          toolName: trace.tool,
          ...(trace.input !== undefined ? { input: trace.input } : {}),
          error: trace.error ?? `工具执行失败：${trace.tool}`,
          ...(typeof trace.durationMs === 'number' ? { duration: trace.durationMs } : {}),
        },
      });
    }
  };

  const emitLoopEventToEventBus = (event: ChatCodexLoopEvent): void => {
    if (!event.sessionId || event.sessionId === 'unknown') return;
    emitToolStepEventsFromLoopEvent(event);

    broadcast({
      type: 'chat_codex_turn',
      sessionId: event.sessionId,
      timestamp: event.timestamp,
      payload: {
        phase: event.phase,
        ...event.payload,
      },
    });

    // On turn_start, inject main session ledger pointer
    if (event.phase === 'turn_start') {
      addLedgerPointerMessage(event.sessionId, 'main', generalAgentId);
    }

    // Persist reasoning events into session
    if (event.phase === 'kernel_event' && event.payload.type === 'reasoning') {
      const reasoningText = typeof event.payload.text === 'string'
        ? event.payload.text.trim()
        : '';
      if (reasoningText.length > 0) {
        // Use 'assistant' role so reasoning is included in next-turn context
        const reasoningAgentId = typeof event.payload.agentId === 'string' && event.payload.agentId.trim().length > 0
          ? event.payload.agentId.trim()
          : generalAgentId;
        const roleProfile = typeof event.payload.roleProfile === 'string' && event.payload.roleProfile.trim().length > 0
          ? event.payload.roleProfile.trim()
          : 'orchestrator';
        const contentPrefix = `[role=${roleProfile} agent=${reasoningAgentId}] `;
        persistSessionEventMessage(
          event.sessionId,
          `${contentPrefix}思考: ${reasoningText}`,
          {
            type: 'reasoning',
            agentId: reasoningAgentId,
            metadata: {
              role: roleProfile,
              agentId: reasoningAgentId,
              event: event.payload,
              fullReasoningText: reasoningText,
            },
          },
          'assistant', // Use assistant role so it's included in kernel history
        );
        
        // Send reasoning to channel bridge (QQBot) based on pushSettings.reasoning config
        if (agentStatusSubscriber) {
          agentStatusSubscriber.sendReasoningUpdate(event.sessionId, reasoningAgentId, reasoningText)
            .catch((err) => {
              logger.module('event-forwarding').error(
                'Failed to send reasoning to channel',
                err instanceof Error ? err : new Error(String(err))
              );
            });
        }
      }
    }

    if (event.phase === 'kernel_event' && event.payload.type === 'model_round') {
      const contextUsagePercent = typeof event.payload.contextUsagePercent === 'number'
        ? event.payload.contextUsagePercent
        : undefined;
      const turnId = typeof event.payload.responseId === 'string' && event.payload.responseId.trim().length > 0
        ? event.payload.responseId.trim()
        : typeof event.payload.round === 'number'
          ? `round-${event.payload.round}`
          : undefined;
      if (contextUsagePercent !== undefined) {
        void deps.eventBus.emit({
          type: 'system_notice',
          sessionId: event.sessionId,
          timestamp: event.timestamp,
          payload: {
            source: 'auto_compact_probe',
            contextUsagePercent,
            turnId,
          },
        });
      }
    }

    if (event.phase === 'turn_error') {
      void eventBus.emit({
        type: 'system_error',
        sessionId: event.sessionId,
        timestamp: event.timestamp,
        payload: {
          error: typeof event.payload.error === 'string' ? event.payload.error : 'finger-general runner error',
          component: 'finger-general-runner',
          recoverable: true,
        },
      });
    }
  };



  // WebSocket broadcast handlers (extracted to event-forwarding-handlers.ts)
  attachBroadcastHandlers({ eventBus, broadcast, generalAgentId, persistSessionEventMessage });
  eventBus.subscribe(
    'agent_runtime_dispatch',
    (event) => {
      const payload = event.payload as Record<string, unknown>;
      const status = typeof payload.status === 'string' ? payload.status : '';
      const sessionId = asString(event.sessionId) || asString(payload.sessionId);
      const targetAgentId = asString(payload.targetAgentId) ?? 'unknown-agent';
      const agentRole = inferAgentRoleLabel(targetAgentId);
      const assignment = isObjectRecord(payload.assignment) ? payload.assignment : null;
      const queuePosition = typeof payload.queuePosition === 'number' ? payload.queuePosition : undefined;
      const taskId = assignment && typeof assignment.taskId === 'string' ? assignment.taskId.trim() : '';
      const bdTaskId = assignment && typeof assignment.bdTaskId === 'string' ? assignment.bdTaskId.trim() : '';
      const statusLabel = status === 'queued' ? '排队' : status === 'completed' ? '完成' : status === 'failed' ? '失败' : status;
      const dispatchParts = [
        `派发给 ${agentRole}${targetAgentId ? ` (${targetAgentId})` : ''}`,
        statusLabel ? `状态 ${statusLabel}` : '',
        typeof queuePosition === 'number' ? `队列 #${queuePosition}` : '',
        taskId ? `task ${taskId}` : '',
        bdTaskId && !taskId ? `bd ${bdTaskId}` : '',
      ].filter((part) => part.length > 0);
      const dispatchContent = dispatchParts.join(' · ');
      if (sessionId && dispatchContent.length > 0) {
        void sessionManager.addMessage(sessionId, 'system', dispatchContent, {
          type: 'dispatch',
          agentId: targetAgentId,
          metadata: { event, agentRole },
        });
        if (status === 'completed' || status === 'failed') {
          const resultContent = formatDispatchResultContent(payload.result, asString(payload.error));
          if (resultContent.trim().length > 0) {
            void sessionManager.addMessage(sessionId, 'assistant', resultContent, {
              type: 'dispatch',
              agentId: targetAgentId,
              metadata: { event, agentRole },
            });
          }
        }
      }
      // Inject child session ledger pointer on dispatch completion
      if ((status === 'completed' || status === 'failed') && sessionId) {
        const childSessionId = asString(payload.childSessionId)
          ?? (isObjectRecord(payload.result)
            ? asString((payload.result as Record<string, unknown>).childSessionId)
              ?? asString((payload.result as Record<string, unknown>).sessionId)
            : undefined);
        if (childSessionId) {
          addLedgerPointerMessage(sessionId, `child:${childSessionId}`, targetAgentId);
        }
      }

      if (status !== 'completed' && status !== 'failed') return;
      if (!assignment) return;

      const feedback = {
        ...buildDispatchFeedbackPayload(payload),
        task: typeof assignment.taskId === 'string' ? assignment.taskId : undefined,
        assignment,
      };
      const feedbackText = JSON.stringify(feedback);
      const workflowId = typeof payload.workflowId === 'string' && payload.workflowId.trim().length > 0
        ? payload.workflowId.trim()
        : undefined;
      const epicId = typeof assignment.epicId === 'string' && assignment.epicId.trim().length > 0
        ? assignment.epicId.trim()
        : undefined;
      if (workflowId) {
        runtimeInstructionBus.push(workflowId, feedbackText);
      }
      if (epicId && epicId !== workflowId) {
        runtimeInstructionBus.push(epicId, feedbackText);
      }

      broadcast({
        type: 'orchestrator_feedback',
        payload: feedback,
        timestamp: event.timestamp,
      });
    },
  );

  logger.module('event-forwarding').info('EventBus orchestrator feedback forwarding enabled: agent_runtime_dispatch');

  return { emitLoopEventToEventBus };
}
