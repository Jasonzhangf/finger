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
import { applyExecutionLifecycleTransition } from './execution-lifecycle.js';
import {
  attachControlLifecycleForwarding,
  attachDispatchLifecycleForwarding,
} from './event-forwarding-runtime-events.js';

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
    if (event.phase === 'turn_start') {
      applyExecutionLifecycleTransition(sessionManager, event.sessionId, {
        stage: 'running',
        substage: 'turn_start',
        updatedBy: 'event-forwarding',
        finishReason: null,
      });
    } else if (event.phase === 'turn_complete') {
      const pendingInputAccepted = event.payload.pendingInputAccepted === true;
      const finishReason = typeof event.payload.finishReason === 'string' && event.payload.finishReason.trim().length > 0
        ? event.payload.finishReason.trim()
        : undefined;
      const isFinishedStop = finishReason === 'stop';
      applyExecutionLifecycleTransition(sessionManager, event.sessionId, {
        stage: pendingInputAccepted
          ? 'running'
          : isFinishedStop
            ? 'completed'
            : 'interrupted',
        substage: pendingInputAccepted
          ? 'pending_input_queued'
          : isFinishedStop
            ? 'turn_complete'
            : 'turn_incomplete',
        updatedBy: 'event-forwarding',
        turnId: typeof event.payload.responseId === 'string' ? event.payload.responseId : undefined,
        finishReason: finishReason ?? null,
        detail: pendingInputAccepted
          ? (typeof event.payload.pendingTurnId === 'string' ? `pendingTurn=${event.payload.pendingTurnId}` : 'pending input accepted')
          : typeof event.payload.replyPreview === 'string'
            ? event.payload.replyPreview.slice(0, 120)
            : undefined,
        lastError: null,
      });
    } else if (event.phase === 'turn_error') {
      const errorMessage = typeof event.payload.error === 'string' ? event.payload.error : 'turn_error';
      const normalizedError = errorMessage.toLowerCase();
      applyExecutionLifecycleTransition(sessionManager, event.sessionId, {
        stage: normalizedError.includes('interrupt') ? 'interrupted' : 'failed',
        substage: normalizedError.includes('interrupt') ? 'turn_interrupted' : 'turn_error',
        updatedBy: 'event-forwarding',
        lastError: normalizedError.includes('interrupt') ? null : errorMessage,
        detail: errorMessage,
        timeoutMs: typeof event.payload.timeoutMs === 'number' ? event.payload.timeoutMs : undefined,
        recoveryAction: asString(event.payload.recoveryAction)
          ?? (normalizedError.includes('interrupt') ? 'interrupted' : 'failed'),
      });
    } else if (event.phase === 'kernel_event' && isObjectRecord(event.payload)) {
      if (event.payload.type === 'tool_call') {
        applyExecutionLifecycleTransition(sessionManager, event.sessionId, {
          stage: 'waiting_tool',
          substage: 'tool_call',
          updatedBy: 'event-forwarding',
          toolName: asString(event.payload.toolName),
          detail: asString(event.payload.toolId),
        });
      } else if (
        event.payload.type === 'tool_result'
        || event.payload.type === 'tool_error'
        || event.payload.type === 'model_round'
        || event.payload.type === 'reasoning'
      ) {
        applyExecutionLifecycleTransition(sessionManager, event.sessionId, {
          stage: 'waiting_model',
          substage: event.payload.type,
          updatedBy: 'event-forwarding',
          toolName: event.payload.type === 'tool_result' || event.payload.type === 'tool_error'
            ? asString(event.payload.toolName)
            : undefined,
          turnId: event.payload.type === 'model_round' ? asString(event.payload.responseId) : undefined,
          detail: event.payload.type === 'tool_error'
            ? asString(event.payload.error)
            : event.payload.type === 'reasoning'
              ? asString(event.payload.text)?.slice(0, 120)
              : undefined,
          lastError: event.payload.type === 'tool_error' ? asString(event.payload.error) : null,
        });
      } else if (event.payload.type === 'turn_retry') {
        applyExecutionLifecycleTransition(sessionManager, event.sessionId, {
          stage: 'retrying',
          substage: 'turn_retry',
          updatedBy: 'event-forwarding',
          detail: typeof event.payload.attempt === 'number' ? `attempt=${event.payload.attempt}` : undefined,
          lastError: asString(event.payload.error),
          timeoutMs: typeof event.payload.timeoutMs === 'number' ? event.payload.timeoutMs : undefined,
          retryDelayMs: typeof event.payload.retryDelayMs === 'number' ? event.payload.retryDelayMs : undefined,
          recoveryAction: asString(event.payload.recoveryAction) ?? 'retry',
          incrementRetry: true,
        });
      }
    }
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
          event.phase === 'turn_complete' && typeof event.payload.finishReason === 'string'
            ? event.payload.finishReason
            : undefined,
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
  attachDispatchLifecycleForwarding({
    eventBus,
    broadcast,
    sessionManager,
    runtimeInstructionBus,
    inferAgentRoleLabel,
    formatDispatchResultContent,
    asString,
    normalizeDispatchLedgerSessionId,
    shouldSkipDispatchLedgerEntry,
    addLedgerPointerMessage,
    isAgentBusy,
  });

  attachControlLifecycleForwarding({
    eventBus,
    sessionManager,
    asString,
  });

  logger.module('event-forwarding').info('EventBus orchestrator feedback forwarding enabled: agent_runtime_dispatch');

  return { emitLoopEventToEventBus };
}
