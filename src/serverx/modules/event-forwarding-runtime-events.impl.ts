import { logger } from '../../core/logger.js';
import type { SessionManager } from '../../orchestration/session-manager.js';
import type { UnifiedEventBus } from '../../runtime/event-bus.js';
import { isObjectRecord } from '../../server/common/object.js';
import type { AgentDispatchRequest } from '../../server/modules/agent-runtime/types.js';
import { heartbeatMailbox } from '../../server/modules/heartbeat-mailbox.js';
import { buildDispatchResultEnvelope } from '../../server/modules/mailbox-envelope.js';
import {
  applyExecutionLifecycleTransition,
} from '../../server/modules/execution-lifecycle.js';
import {
  buildDispatchFeedbackPayload,
  extractDispatchResultTags,
  extractDispatchResultTopic,
} from '../../server/modules/event-forwarding-helpers.js';
import {
  FINGER_PROJECT_AGENT_ID,
  FINGER_SYSTEM_AGENT_ID,
} from '../../agents/finger-general/finger-general-module.js';
import { buildVerificationPrompt } from '../../agents/prompts/verifier-prompts.js';

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

  const verdictFromText = (text: string): 'pass' | 'retry' | 'block' | 'feedback' | undefined => {
    const normalizedText = text.trim();
    if (!normalizedText) return undefined;
    if (/<verdict>\s*PASS\s*<\/verdict>/i.test(normalizedText) || /VERDICT\s*:\s*PASS/i.test(normalizedText)) {
      return 'pass';
    }
    if (/<verdict>\s*PARTIAL\s*<\/verdict>/i.test(normalizedText) || /VERDICT\s*:\s*PARTIAL/i.test(normalizedText)) {
      return 'retry';
    }
    if (/<verdict>\s*FAIL\s*<\/verdict>/i.test(normalizedText) || /VERDICT\s*:\s*FAIL/i.test(normalizedText)) {
      return 'retry';
    }
    const decisionInline = normalizedText.match(/\bdecision\b[^a-zA-Z0-9]+(pass|retry|block|feedback)\b/i);
    if (decisionInline) return normalize(decisionInline[1]);
    return undefined;
  };

  const resultTextCandidates: string[] = [];
  const directResponse = root && typeof root.response === 'string' ? root.response : '';
  if (directResponse) resultTextCandidates.push(directResponse);
  if (responseText) resultTextCandidates.push(responseText);
  for (const candidate of resultTextCandidates) {
    const parsed = verdictFromText(candidate);
    if (parsed) return parsed;
  }
  return undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
    .filter((item, index, arr) => arr.indexOf(item) === index);
}

function inferVerificationChangeCategory(
  changedFiles: string[],
): 'backend_api' | 'infrastructure' | 'frontend' | 'config' | 'multi_file' {
  if (changedFiles.length >= 3) return 'multi_file';
  if (changedFiles.some((file) => /(^|\/)(api|server|runtime|backend)(\/|$)/i.test(file))) return 'backend_api';
  if (changedFiles.some((file) => /(Dockerfile|docker-compose|k8s|infra|deployment|helm|terraform)/i.test(file))) return 'infrastructure';
  if (changedFiles.some((file) => /(^|\/)(ui|web|frontend)(\/|$)|\.(tsx?|jsx?)$/i.test(file))) return 'frontend';
  if (changedFiles.some((file) => /\.(json|ya?ml|toml|ini)$/i.test(file) || /config/i.test(file))) return 'config';
  return 'multi_file';
}

function extractChangedFilesForVerification(result: unknown): string[] {
  if (!isObjectRecord(result)) return [];
  const direct = [
    ...asStringArray(result.changedFiles),
    ...asStringArray(result.changed_files),
    ...asStringArray(result.files),
  ];
  const rawPayload = isObjectRecord(result.rawPayload) ? result.rawPayload : undefined;
  const raw = rawPayload ? [
    ...asStringArray(rawPayload.changedFiles),
    ...asStringArray(rawPayload.changed_files),
    ...asStringArray(rawPayload.files),
  ] : [];
  return [...direct, ...raw].filter((item, index, arr) => arr.indexOf(item) === index);
}

function extractAcceptanceCriteriaForVerification(assignment: Record<string, unknown> | null): string[] {
  if (!assignment) return ['Validate delivery completeness against the dispatched task goal and provide evidence.'];
  const direct = [
    ...asStringArray(assignment.acceptanceCriteria),
    ...asStringArray(assignment.acceptance_criteria),
    ...asStringArray(assignment.ac),
  ];
  const rawCriteria = typeof assignment.acceptanceCriteria === 'string' && assignment.acceptanceCriteria.trim().length > 0
    ? [assignment.acceptanceCriteria.trim()]
    : [];
  const normalized = [...direct, ...rawCriteria].filter((item, index, arr) => arr.indexOf(item) === index);
  if (normalized.length > 0) return normalized;
  return ['Validate delivery completeness against the dispatched task goal and provide evidence.'];
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

  eventBus.subscribeMultiple(
    [
      'agent_dispatch_queued',
      'agent_dispatch_started',
      'agent_dispatch_complete',
      'agent_dispatch_failed',
      'agent_dispatch_partial',
    ],
    (event) => {
      const payload = event.payload as Record<string, unknown>;
      const status = typeof payload.status === 'string' ? payload.status : '';
      // Normalize protocol event status: 'success' -> 'completed', 'started' -> 'processing'
      const normalizedStatus = status === 'success' ? 'completed' : status === 'started' ? 'processing' : status;
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
      const isMailboxQueued = normalizedStatus === 'queued'
        && (asString(dispatchResult?.status) === 'queued_mailbox' || Boolean(mailboxMessageId));
      // Protocol events have flat taskId, legacy events have assignment.taskId
      const taskId = (typeof payload.taskId === 'string' ? payload.taskId.trim() : '') ||
                     (assignment && typeof assignment.taskId === 'string' ? assignment.taskId.trim() : '');
      const bdTaskId = assignment && typeof assignment.bdTaskId === 'string' ? assignment.bdTaskId.trim() : '';
      const statusLabel = isMailboxQueued
        ? '邮箱等待 ACK'
        : normalizedStatus === 'queued'
          ? '排队'
          : normalizedStatus === 'processing'
            ? '处理中'
            : normalizedStatus === 'completed'
              ? '完成'
              : normalizedStatus === 'failed'
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
          stage: normalizedStatus === 'completed'
            ? 'completed'
            : normalizedStatus === 'failed'
              ? 'failed'
              : 'dispatching',
          substage: normalizedStatus === 'queued'
            ? (isMailboxQueued ? 'dispatch_mailbox_wait_ack' : 'dispatch_queued')
            : normalizedStatus === 'processing'
              ? 'dispatch_processing'
              : normalizedStatus === 'completed'
                ? 'dispatch_completed'
                : normalizedStatus === 'failed'
                  ? 'dispatch_failed'
                  : 'dispatch_update',
          updatedBy: 'event-forwarding',
          dispatchId,
          targetAgentId,
          detail: dispatchContent.slice(0, 120),
          lastError: normalizedStatus === 'failed' ? asString(payload.error) : null,
          timeoutMs: typeof dispatchResult?.timeoutMs === 'number' ? dispatchResult.timeoutMs : undefined,
          retryDelayMs: typeof dispatchResult?.retryDelayMs === 'number' ? dispatchResult.retryDelayMs : undefined,
          recoveryAction: asString(dispatchResult?.recoveryAction)
            ?? (isMailboxQueued ? 'mailbox' : normalizedStatus === 'failed' ? 'failed' : normalizedStatus === 'completed' ? 'completed' : 'queue'),
          delivery: asString(dispatchResult?.delivery)
            ?? (isMailboxQueued ? 'mailbox' : normalizedStatus === 'queued' ? 'queue' : null),
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
        if (normalizedStatus === 'completed' || normalizedStatus === 'failed') {
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

      if ((normalizedStatus === 'completed' || normalizedStatus === 'failed') && sessionId) {
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
              priority: normalizedStatus === 'failed' ? 0 : 2,
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

      // Stage 1: system -> project completed => internal review gate
      if (
        normalizedStatus === 'completed'
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
        const changedFiles = extractChangedFilesForVerification(payload.result);
        const acceptanceCriteria = extractAcceptanceCriteriaForVerification(assignment);
        const reviewPrompt = [
          '[AUTO-REVIEW GATE]',
          `taskId: ${assignmentTaskId}`,
          `attempt: ${assignmentAttempt}`,
          `executor: ${FINGER_PROJECT_AGENT_ID}`,
          '',
          buildVerificationPrompt({
            changedFiles: changedFiles.length > 0 ? changedFiles : ['(unspecified-by-executor)'],
            changeCategory: inferVerificationChangeCategory(changedFiles),
            implementationSummary: executorSummary,
            acceptanceCriteria,
          }),
          '',
          '[Decision Contract]',
          'You must end with a machine-readable decision JSON:',
          '{"decision":"pass|retry|block","summary":"...","evidence":["..."]}',
          'Mapping rule: PASS -> pass, PARTIAL/FAIL -> retry (or block if truly blocked).',
          'After review, report via report-task-completion:',
          '- pass => result=success',
          '- retry/block => result=failure with clear system review feedback',
        ].join('\n');

        const reviewRequest: AgentDispatchRequest = {
          sourceAgentId: FINGER_SYSTEM_AGENT_ID,
          targetAgentId: FINGER_SYSTEM_AGENT_ID,
          task: { prompt: reviewPrompt },
          ...(sessionId ? { sessionId } : {}),
          assignment: {
            ...(typeof assignment.epicId === 'string' ? { epicId: assignment.epicId } : {}),
            taskId: assignmentTaskId,
            ...(typeof assignment.bdTaskId === 'string' ? { bdTaskId: assignment.bdTaskId } : {}),
            assignerAgentId: FINGER_SYSTEM_AGENT_ID,
            assigneeAgentId: FINGER_SYSTEM_AGENT_ID,
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
          logger.module('event-forwarding').warn('Failed to dispatch system review gate task', {
            dispatchId,
            taskId: assignmentTaskId,
            error: reviewDispatchError instanceof Error ? reviewDispatchError.message : String(reviewDispatchError),
          });
        });
        return;
      }

      // Stage 2: system review completed => pass or re-dispatch to project
      if (
        normalizedStatus === 'completed'
        && sourceAgentId === FINGER_SYSTEM_AGENT_ID
        && targetAgentId === FINGER_SYSTEM_AGENT_ID
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
          '上轮交付未通过系统审查。请基于以下反馈继续修复并完成闭环交付：',
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
          logger.module('event-forwarding').warn('Failed to redispatch project task after system review rejection', {
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

  eventBus.subscribe(
    'waiting_for_user',
    (event) => {
      const payload: Record<string, unknown> = isObjectRecord(event.payload) ? event.payload : {};
      const context: Record<string, unknown> = isObjectRecord(payload.context) ? payload.context : {};
      const sessionId = asString(payload.sessionId) ?? asString(event.sessionId);
      if (!sessionId) return;
      const detail = asString(context.question)
        ?? asString(payload.reason)
        ?? 'waiting_for_user';
      applyExecutionLifecycleTransition(sessionManager, sessionId, {
        stage: 'waiting_user',
        substage: 'waiting_for_user',
        updatedBy: 'event-forwarding',
        detail,
        allowFromTerminal: true,
      });
    },
  );

  eventBus.subscribe(
    'user_decision_received',
    (event) => {
      const payload: Record<string, unknown> = isObjectRecord(event.payload) ? event.payload : {};
      const sessionId = asString(payload.sessionId) ?? asString(event.sessionId);
      if (!sessionId) return;
      const detail = asString(payload.decision) ?? 'user_decision_received';
      applyExecutionLifecycleTransition(sessionManager, sessionId, {
        stage: 'running',
        substage: 'user_decision_received',
        updatedBy: 'event-forwarding',
        detail,
        allowFromTerminal: true,
        lastError: null,
      });
    },
  );
}
