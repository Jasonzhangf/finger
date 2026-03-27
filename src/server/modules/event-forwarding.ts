import { logger } from '../../core/logger.js';
import type { SessionManager } from '../../orchestration/session-manager.js';
import type { UnifiedEventBus } from '../../runtime/event-bus.js';
import type { ChatCodexLoopEvent } from '../../agents/finger-general/finger-general-module.js';
import type { AgentStatusSubscriber } from './agent-status-subscriber.js';
import { isObjectRecord } from '../common/object.js';
import {
  buildDispatchFeedbackPayload,
  buildLedgerPointerInfo,
  extractAssistantBodyUpdate,
  extractDispatchResultTags,
  extractDispatchResultTopic,
  extractLoopToolTrace,
  formatLedgerPointerContent,
} from './event-forwarding-helpers.js';
import { attachBroadcastHandlers } from './event-forwarding-handlers.js';
import { buildDispatchResultEnvelope } from './mailbox-envelope.js';
import { heartbeatMailbox } from './heartbeat-mailbox.js';
import { normalizeDispatchLedgerSessionId as _normalizeDispatchLedgerSessionId } from './event-forwarding-session-utils.js';

const SYSTEM_AGENT_ID = 'finger-system-agent';

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
  isAgentBusy?: (agentId: string) => boolean | Promise<boolean>;
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
    isAgentBusy,
  } = deps;
  const latestBodyBySession = new Map<string, string>();
  const dispatchLedgerDedup = new Map<string, number>();
  const DISPATCH_LEDGER_DEDUP_TTL_MS = 10 * 60_000;

  const normalizeDispatchLedgerSessionId = (rawSessionId: string | undefined) =>
    _normalizeDispatchLedgerSessionId(sessionManager, rawSessionId);


  const shouldSkipDispatchLedgerEntry = (key: string): boolean => {
    const now = Date.now();
    for (const [existingKey, ts] of dispatchLedgerDedup.entries()) {
      if (now - ts > DISPATCH_LEDGER_DEDUP_TTL_MS) {
        dispatchLedgerDedup.delete(existingKey);
      }
    }
    if (dispatchLedgerDedup.has(key)) return true;
    dispatchLedgerDedup.set(key, now);
    return false;
  };

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
  const emitLoopEventToEventBus = (event: ChatCodexLoopEvent): void => {
    if (!event.sessionId || event.sessionId === 'unknown') return;
    if (event.phase === 'turn_complete' || event.phase === 'turn_error') {
      const latestBody = latestBodyBySession.get(event.sessionId);
      if (agentStatusSubscriber) {
        const finalReply = event.phase === 'turn_complete'
          ? (latestBody || (typeof event.payload.replyPreview === 'string' ? event.payload.replyPreview : ''))
          : (typeof event.payload.error === 'string' ? `处理失败：${event.payload.error}` : '处理失败，请稍后再试');
        agentStatusSubscriber.finalizeChannelTurn(
          event.sessionId,
          finalReply,
          generalAgentId,
        ).catch((err) => {
          logger.module('event-forwarding').error(
            'Failed to finalize channel turn',
            err instanceof Error ? err : new Error(String(err)),
          );
        });
      }
      latestBodyBySession.delete(event.sessionId);
    }
    // TODO: implement emitToolStepEventsFromLoopEvent
    // emitToolStepEventsFromLoopEvent(event);

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

    if (event.phase === 'kernel_event' && isObjectRecord(event.payload)) {
      const bodyUpdate = extractAssistantBodyUpdate(event.payload);
      if (bodyUpdate && agentStatusSubscriber) {
        const normalized = bodyUpdate.trim();
        if (normalized.length > 0 && latestBodyBySession.get(event.sessionId) !== normalized) {
          latestBodyBySession.set(event.sessionId, normalized);
          const bodyAgentId = asString(event.payload.agentId) ?? generalAgentId;
          agentStatusSubscriber.sendBodyUpdate(event.sessionId, bodyAgentId, normalized)
            .catch((err) => {
              logger.module('event-forwarding').error(
                'Failed to send body update to channel',
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
          error: typeof event.payload.error === 'string' ? event.payload.error : 'finger-project-agent runner error',
          component: 'finger-project-agent-runner',
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
      const dispatchId = asString(payload.dispatchId) ?? 'unknown-dispatch';
      const requestedSessionId = asString(event.sessionId) || asString(payload.sessionId);
      const sessionResolution = normalizeDispatchLedgerSessionId(requestedSessionId);
      const sessionId = sessionResolution.sessionId;
      const targetAgentId = asString(payload.targetAgentId) ?? 'unknown-agent';
      const sourceAgentId = asString(payload.sourceAgentId) ?? 'unknown-agent';
      const agentRole = inferAgentRoleLabel(targetAgentId);
      const assignment = isObjectRecord(payload.assignment) ? payload.assignment : null;
      const queuePosition = typeof payload.queuePosition === 'number' ? payload.queuePosition : undefined;
      const dispatchResult = isObjectRecord(payload.result) ? payload.result : null;
      const mailboxMessageId = asString(dispatchResult?.messageId);
      const isMailboxQueued = status === 'queued'
        && (asString(dispatchResult?.status) === 'queued_mailbox' || Boolean(mailboxMessageId));
      const taskId = assignment && typeof assignment.taskId === 'string' ? assignment.taskId.trim() : '';
      const bdTaskId = assignment && typeof assignment.bdTaskId === 'string' ? assignment.bdTaskId.trim() : '';
      const statusLabel = isMailboxQueued
        ? '邮箱等待 ACK'
        : status === 'queued'
          ? '排队'
          : status === 'processing'
            ? '处理中'
          : status === 'completed'
            ? '完成'
            : status === 'failed'
              ? '失败'
              : status;
      const dispatchParts = [
        `dispatch ${dispatchId}`,
        `派发给 ${agentRole}${targetAgentId ? ` (${targetAgentId})` : ''}`,
        statusLabel ? `状态 ${statusLabel}` : '',
        typeof queuePosition === 'number' ? `队列 #${queuePosition}` : '',
        mailboxMessageId ? `mailbox ${mailboxMessageId}` : '',
        taskId ? `task ${taskId}` : '',
        bdTaskId && !taskId ? `bd ${bdTaskId}` : '',
      ].filter((part) => part.length > 0);
      const dispatchContent = dispatchParts.join(' · ');
      if (sessionId && dispatchContent.length > 0) {
        const statusDedupeKey = [
          sessionId,
          dispatchId,
          'status',
          status,
          asString(dispatchResult?.status) ?? '',
          typeof queuePosition === 'number' ? String(queuePosition) : '',
          mailboxMessageId ?? '',
          asString(payload.error) ?? '',
        ].join('|');
        if (!shouldSkipDispatchLedgerEntry(statusDedupeKey)) {
          void sessionManager.addMessage(sessionId, 'system', dispatchContent, {
            type: 'dispatch',
            agentId: targetAgentId,
            metadata: {
              dispatchId,
              sourceAgentId,
              targetAgentId,
              status,
              queuePosition,
              mailboxMessageId,
              taskId: taskId || undefined,
              bdTaskId: bdTaskId || undefined,
              sessionId,
              requestedSessionId: requestedSessionId || undefined,
              originalSessionId: sessionResolution.originalSessionId,
              event,
              agentRole,
            },
          });
        }
        if (status === 'completed' || status === 'failed') {
          const resultContent = formatDispatchResultContent(payload.result, asString(payload.error));
          if (resultContent.trim().length > 0) {
            const resultDedupeKey = [
              sessionId,
              dispatchId,
              'result',
              status,
              asString(payload.error) ?? '',
              resultContent.trim(),
            ].join('|');
            if (!shouldSkipDispatchLedgerEntry(resultDedupeKey)) {
              void sessionManager.addMessage(sessionId, 'assistant', resultContent, {
                type: 'dispatch',
                agentId: targetAgentId,
                metadata: {
                  dispatchId,
                  sourceAgentId,
                  targetAgentId,
                  status,
                  mailboxMessageId,
                  sessionId,
                  requestedSessionId: requestedSessionId || undefined,
                  originalSessionId: sessionResolution.originalSessionId,
                  taskId: taskId || undefined,
                  bdTaskId: bdTaskId || undefined,
                  error: asString(payload.error) ?? undefined,
                  event,
                  agentRole,
                },
              });
            }
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

        const parentAgentId = asString(payload.sourceAgentId) ?? SYSTEM_AGENT_ID;
        const shouldRouteResultToSourceMailbox = parentAgentId === SYSTEM_AGENT_ID;
        const appendToMailbox = async (): Promise<void> => {
          if (!shouldRouteResultToSourceMailbox) {
            logger.module('event-forwarding').debug('Skip dispatch result mailbox append: source agent does not consume mailbox callbacks', {
              parentAgentId,
              status,
              childSessionId: childSessionId || sessionId,
            });
            return;
          }
          const busy = typeof isAgentBusy === 'function'
            ? await Promise.resolve(isAgentBusy(parentAgentId))
            : true;
          if (!busy) {
            logger.module('event-forwarding').debug('Skip dispatch result mailbox append: source agent idle', {
              parentAgentId,
              status,
              childSessionId: childSessionId || sessionId,
            });
            return;
          }
          try {
            const summary = formatDispatchResultContent(payload.result, asString(payload.error));
            const errorMessage = asString(payload.error) || undefined;
            const resultTags = extractDispatchResultTags(payload.result);
            const resultTopic = extractDispatchResultTopic(payload.result);
            const envelope = buildDispatchResultEnvelope(childSessionId || sessionId, summary, errorMessage, undefined, resultTags, resultTopic);
            heartbeatMailbox.append(parentAgentId, {
              type: 'dispatch-result',
              dispatchId: payload.dispatchId,
              sourceAgentId: payload.targetAgentId,
              targetAgentId: parentAgentId,
              status,
              childSessionId: childSessionId || sessionId,
              envelopeId: envelope.id,
              envelope,
              summary,
              error: errorMessage,
            }, {
              sender: asString(payload.targetAgentId) ?? 'system-dispatch',
              sourceType: 'control',
              category: 'notification',
              priority: status === 'failed' ? 0 : 2,
              ...(sessionId ? { sessionId } : {}),
            });
            logger.module('event-forwarding').debug('Dispatch result appended to mailbox (source busy)', {
              parentAgentId,
              envelopeId: envelope.id,
              status,
              childSessionId: childSessionId || sessionId,
            });
          } catch (mailErr) {
            logger.module('event-forwarding').warn('Failed to append dispatch result to mailbox', mailErr instanceof Error ? { message: mailErr.message, stack: mailErr.stack } : undefined);
          }
        };
        void appendToMailbox();
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
