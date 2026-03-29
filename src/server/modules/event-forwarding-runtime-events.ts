import { logger } from '../../core/logger.js';
import type { SessionManager } from '../../orchestration/session-manager.js';
import type { UnifiedEventBus } from '../../runtime/event-bus.js';
import { isObjectRecord } from '../common/object.js';
import type { AgentDispatchRequest } from './agent-runtime/types.js';
import { heartbeatMailbox } from './heartbeat-mailbox.js';
import { buildDispatchResultEnvelope } from './mailbox-envelope.js';
import {
  applyExecutionLifecycleTransition,
} from './execution-lifecycle.js';
import {
  buildDispatchFeedbackPayload,
  extractDispatchResultTags,
  extractDispatchResultTopic,
} from './event-forwarding-helpers.js';
import {
  FINGER_PROJECT_AGENT_ID,
  FINGER_REVIEWER_AGENT_ID,
  FINGER_SYSTEM_AGENT_ID,
} from '../../agents/finger-general/finger-general-module.js';

const SYSTEM_AGENT_ID = FINGER_SYSTEM_AGENT_ID;
const REVIEW_REDISPATCH_MAX_ATTEMPTS = Number.isFinite(Number(process.env.FINGER_REVIEW_REDISPATCH_MAX_ATTEMPTS))
  ? Math.max(1, Math.floor(Number(process.env.FINGER_REVIEW_REDISPATCH_MAX_ATTEMPTS)))
  : 3;

interface AttachDispatchForwardingOptions {
  eventBus: UnifiedEventBus;
  broadcast: (message: unknown) => void;
  sessionManager: SessionManager;
  runtimeInstructionBus: { push: (workflowId: string, content: string) => void };
  inferAgentRoleLabel: (agentId: string) => string;
  formatDispatchResultContent: (result: unknown, error?: string) => string;
  asString: (value: unknown) => string | undefined;
  normalizeDispatchLedgerSessionId: (rawSessionId: string | undefined) => { sessionId?: string; originalSessionId?: string };
  shouldSkipDispatchLedgerEntry: (key: string) => boolean;
  addLedgerPointerMessage: (sessionId: string, label: string, agentId: string) => void;
  isAgentBusy?: (agentId: string) => boolean | Promise<boolean>;
  dispatchTaskToAgent?: (request: AgentDispatchRequest) => Promise<unknown>;
  resolveReviewPolicy?: () => { enabled: boolean; dispatchReviewMode?: 'off' | 'always' };
}

function extractReviewDecision(result: unknown): 'pass' | 'retry' | 'block' | 'feedback' | undefined {
  const asRecord = (value: unknown): Record<string, unknown> | undefined => (
    isObjectRecord(value) ? value as Record<string, unknown> : undefined
  );
  const normalize = (value: unknown): 'pass' | 'retry' | 'block' | 'feedback' | undefined => {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'pass' || normalized === 'passed' || normalized === 'approve' || normalized === 'approved') return 'pass';
    if (normalized === 'retry' || normalized === 'rework' || normalized === 'needs_changes' || normalized === 'needs-changes') return 'retry';
    if (normalized === 'block' || normalized === 'blocked' || normalized === 'reject' || normalized === 'rejected' || normalized === 'fail' || normalized === 'failed') return 'block';
    if (normalized === 'feedback') return 'feedback';
    return undefined;
  };
  const root = asRecord(result);
  const direct = normalize(root?.decision);
  if (direct) return direct;

  const rawPayload = asRecord(root?.rawPayload);
  const fromRawPayload = normalize(rawPayload?.decision);
  if (fromRawPayload) return fromRawPayload;

  const responseRecord = asRecord(rawPayload?.response);
  const fromResponseRecord = normalize(responseRecord?.decision);
  if (fromResponseRecord) return fromResponseRecord;

  const responseText = typeof rawPayload?.response === 'string' ? rawPayload.response : '';
  if (responseText) {
    try {
      const parsed = JSON.parse(responseText) as Record<string, unknown>;
      const parsedDecision = normalize(parsed?.decision);
      if (parsedDecision) return parsedDecision;
    } catch {
      // noop
    }
  }
  return undefined;
}

export function attachDispatchLifecycleForwarding(options: AttachDispatchForwardingOptions): void {
  const {
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
    dispatchTaskToAgent,
    resolveReviewPolicy,
  } = options;

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

      if (sessionId) {
        applyExecutionLifecycleTransition(sessionManager, sessionId, {
          stage: status === 'completed'
            ? 'completed'
            : status === 'failed'
              ? 'failed'
              : 'dispatching',
          substage: status === 'queued'
            ? (isMailboxQueued ? 'dispatch_mailbox_wait_ack' : 'dispatch_queued')
            : status === 'processing'
              ? 'dispatch_processing'
              : status === 'completed'
                ? 'dispatch_completed'
                : status === 'failed'
                  ? 'dispatch_failed'
                  : 'dispatch_update',
          updatedBy: 'event-forwarding',
          dispatchId,
          targetAgentId,
          detail: dispatchContent.slice(0, 120),
          lastError: status === 'failed' ? asString(payload.error) : null,
          timeoutMs: typeof dispatchResult?.timeoutMs === 'number' ? dispatchResult.timeoutMs : undefined,
          retryDelayMs: typeof dispatchResult?.retryDelayMs === 'number' ? dispatchResult.retryDelayMs : undefined,
          recoveryAction: asString(dispatchResult?.recoveryAction)
            ?? (isMailboxQueued ? 'mailbox' : status === 'failed' ? 'failed' : status === 'completed' ? 'completed' : 'queue'),
          delivery: asString(dispatchResult?.delivery)
            ?? (isMailboxQueued ? 'mailbox' : status === 'queued' ? 'queue' : null),
        });
      }

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
          if (!shouldRouteResultToSourceMailbox) return;
          const busy = typeof isAgentBusy === 'function'
            ? await Promise.resolve(isAgentBusy(parentAgentId))
            : true;
          if (!busy) return;
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

      const reviewPolicy = resolveReviewPolicy?.();
      const autoReviewEnabled = reviewPolicy?.enabled === true && reviewPolicy.dispatchReviewMode === 'always';
      if (!autoReviewEnabled || typeof dispatchTaskToAgent !== 'function') return;

      const assignmentTaskId = typeof assignment.taskId === 'string' && assignment.taskId.trim().length > 0
        ? assignment.taskId.trim()
        : '';
      if (!assignmentTaskId) return;

      const assignmentAttempt = typeof assignment.attempt === 'number' && Number.isFinite(assignment.attempt)
        ? Math.max(1, Math.floor(assignment.attempt))
        : 1;

      // Stage 1: system -> project completed => dispatch reviewer gate
      if (
        status === 'completed'
        && sourceAgentId === FINGER_SYSTEM_AGENT_ID
        && targetAgentId === FINGER_PROJECT_AGENT_ID
      ) {
        const reviewDispatchKey = [
          'auto-review-dispatch',
          dispatchId,
          assignmentTaskId,
          String(assignmentAttempt),
        ].join('|');
        if (shouldSkipDispatchLedgerEntry(reviewDispatchKey)) return;

        const executorSummary = formatDispatchResultContent(payload.result, asString(payload.error));
        const reviewPrompt = [
          '[AUTO-REVIEW GATE]',
          `taskId: ${assignmentTaskId}`,
          `attempt: ${assignmentAttempt}`,
          `executor: ${FINGER_PROJECT_AGENT_ID}`,
          '',
          '请对该任务交付做严格审查：',
          '- 必须检查交付是否完整覆盖任务目标；',
          '- 证据不足或未闭环时，不得通过；',
          '- 给出明确 decision（pass / retry / block）和可执行反馈。',
          '',
          '[Executor Summary]',
          executorSummary,
        ].join('\n');

        const reviewRequest: AgentDispatchRequest = {
          sourceAgentId: FINGER_SYSTEM_AGENT_ID,
          targetAgentId: FINGER_REVIEWER_AGENT_ID,
          task: { prompt: reviewPrompt },
          ...(sessionId ? { sessionId } : {}),
          assignment: {
            ...(typeof assignment.epicId === 'string' ? { epicId: assignment.epicId } : {}),
            taskId: assignmentTaskId,
            ...(typeof assignment.bdTaskId === 'string' ? { bdTaskId: assignment.bdTaskId } : {}),
            assignerAgentId: FINGER_SYSTEM_AGENT_ID,
            assigneeAgentId: FINGER_REVIEWER_AGENT_ID,
            phase: 'reviewing',
            attempt: assignmentAttempt,
          },
          metadata: {
            role: 'system',
            source: 'review-gate',
            systemDirectInject: true,
            parentDispatchId: dispatchId,
            reviewGate: true,
          },
          blocking: false,
          queueOnBusy: true,
        };
        void dispatchTaskToAgent(reviewRequest).catch((reviewDispatchError) => {
          logger.module('event-forwarding').warn('Failed to dispatch reviewer gate task', {
            dispatchId,
            taskId: assignmentTaskId,
            error: reviewDispatchError instanceof Error ? reviewDispatchError.message : String(reviewDispatchError),
          });
        });
        return;
      }

      // Stage 2: reviewer completed => pass or re-dispatch to project
      if (
        status === 'completed'
        && sourceAgentId === FINGER_SYSTEM_AGENT_ID
        && targetAgentId === FINGER_REVIEWER_AGENT_ID
      ) {
        const decision = extractReviewDecision(payload.result);
        if (decision === 'pass') return;

        if (assignmentAttempt >= REVIEW_REDISPATCH_MAX_ATTEMPTS) {
          logger.module('event-forwarding').warn('Review gate rejected but max redispatch attempts reached', {
            taskId: assignmentTaskId,
            attempt: assignmentAttempt,
            maxAttempts: REVIEW_REDISPATCH_MAX_ATTEMPTS,
            dispatchId,
          });
          return;
        }

        const reworkDispatchKey = [
          'auto-review-redispatch',
          dispatchId,
          assignmentTaskId,
          String(assignmentAttempt),
          decision ?? 'unknown',
        ].join('|');
        if (shouldSkipDispatchLedgerEntry(reworkDispatchKey)) return;

        const reviewFeedback = formatDispatchResultContent(payload.result, asString(payload.error));
        const retryAttempt = assignmentAttempt + 1;
        const reworkPrompt = [
          '[REVIEW FAILED — REWORK REQUIRED]',
          `taskId: ${assignmentTaskId}`,
          `retryAttempt: ${retryAttempt}`,
          '',
          '上轮交付未通过 reviewer 审查。请基于以下反馈继续修复并完成闭环交付：',
          reviewFeedback,
          '',
          '要求：',
          '- 完整覆盖任务目标；',
          '- 明确列出变更与验证证据；',
          '- 完成后调用 report-task-completion 上报。',
        ].join('\n');

        const reworkRequest: AgentDispatchRequest = {
          sourceAgentId: FINGER_SYSTEM_AGENT_ID,
          targetAgentId: FINGER_PROJECT_AGENT_ID,
          task: { prompt: reworkPrompt },
          ...(sessionId ? { sessionId } : {}),
          assignment: {
            ...(typeof assignment.epicId === 'string' ? { epicId: assignment.epicId } : {}),
            taskId: assignmentTaskId,
            ...(typeof assignment.bdTaskId === 'string' ? { bdTaskId: assignment.bdTaskId } : {}),
            assignerAgentId: FINGER_SYSTEM_AGENT_ID,
            assigneeAgentId: FINGER_PROJECT_AGENT_ID,
            phase: 'retry',
            attempt: retryAttempt,
          },
          metadata: {
            role: 'system',
            source: 'review-gate-redispatch',
            systemDirectInject: true,
            parentDispatchId: dispatchId,
            reviewDecision: decision ?? 'retry',
            reviewGate: true,
          },
          blocking: false,
          queueOnBusy: true,
        };
        void dispatchTaskToAgent(reworkRequest).catch((redispatchError) => {
          logger.module('event-forwarding').warn('Failed to redispatch project task after reviewer rejection', {
            dispatchId,
            taskId: assignmentTaskId,
            retryAttempt,
            error: redispatchError instanceof Error ? redispatchError.message : String(redispatchError),
          });
        });
      }
    },
  );
}

export function attachControlLifecycleForwarding(options: {
  eventBus: UnifiedEventBus;
  sessionManager: SessionManager;
  asString: (value: unknown) => string | undefined;
}): void {
  const { eventBus, sessionManager, asString } = options;
  eventBus.subscribe(
    'agent_runtime_control',
    (event) => {
      const payload: Record<string, unknown> = isObjectRecord(event.payload) ? event.payload : {};
      const action = asString(payload.action) ?? '';
      const status = asString(payload.status) ?? '';
      const sessionId = asString(payload.sessionId) ?? asString(event.sessionId);
      if (!sessionId) return;

      const stage = (action === 'interrupt' || action === 'cancel') && status === 'completed'
        ? 'interrupted'
        : status === 'failed'
          ? 'failed'
          : 'completed';
      const substage = action ? `control_${action}` : 'control';
      const error = asString(payload.error);

      applyExecutionLifecycleTransition(sessionManager, sessionId, {
        stage,
        substage,
        updatedBy: 'event-forwarding',
        detail: action || status || undefined,
        lastError: stage === 'failed' ? error : null,
      });
    },
  );
}
