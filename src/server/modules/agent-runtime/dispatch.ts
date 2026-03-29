import { logger } from '../../../core/logger.js';
import { isObjectRecord } from '../../common/object.js';
import { asString } from '../../common/strings.js';
import { getGlobalDispatchTracker } from './dispatch-tracker.js';
import { sanitizeDispatchResult, type DispatchSummaryResult } from '../../../common/agent-dispatch.js';
import type { AgentDispatchRequest, AgentRuntimeDeps } from './types.js';
import {
  enrichDispatchTagsAndTopic,
} from './dispatch-helpers.js';
import {
  FINGER_PROJECT_AGENT_ID,
  FINGER_SYSTEM_AGENT_ID,
} from '../../../agents/finger-general/finger-general-module.js';
import {
  applyExecutionLifecycleTransition,
  resolveLifecycleStageFromResultStatus,
} from '../execution-lifecycle.js';
import {
  applySessionProgressDeliveryFromDispatch,
  bindDispatchSessionToRuntime,
  persistAgentSummaryToMemory,
  persistDispatchUserMessage,
  persistUserMessageToMemory,
  resolveAutoDeployInstanceCount,
  resolveDispatchSessionSelection,
  resolveRetryBackoffMs,
  shouldUseTransientLedgerForDispatch,
  shouldAutoDeployForMissingTarget,
  sleep,
  syncBdDispatchLifecycle,
  withDispatchWorkspaceDefaults,
} from './dispatch-runtime-helpers.js';

const DISPATCH_ERROR_MAX_RETRIES = Number.isFinite(Number(process.env.FINGER_DISPATCH_ERROR_MAX_RETRIES))
  ? Math.max(0, Math.floor(Number(process.env.FINGER_DISPATCH_ERROR_MAX_RETRIES)))
  : 10;

export async function dispatchTaskToAgent(deps: AgentRuntimeDeps, input: AgentDispatchRequest): Promise<{
  ok: boolean;
  dispatchId: string;
  status: 'queued' | 'completed' | 'failed';
  result?: DispatchSummaryResult;
  error?: string;
  queuePosition?: number;
}> {
  const originalSessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  const fallbackDispatchId = 'dispatch-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  let normalizedInput: AgentDispatchRequest;
  try {
    const sessionSelectedInput = resolveDispatchSessionSelection(deps, input);
    const boundInput = bindDispatchSessionToRuntime(deps, sessionSelectedInput);
    normalizedInput = withDispatchWorkspaceDefaults(deps, boundInput);
    if (
      normalizedInput.sourceAgentId === FINGER_SYSTEM_AGENT_ID
      && normalizedInput.targetAgentId === FINGER_PROJECT_AGENT_ID
    ) {
      const assignment = isObjectRecord(normalizedInput.assignment) ? { ...normalizedInput.assignment } : {};
      const hasTaskId = typeof assignment.taskId === 'string' && assignment.taskId.trim().length > 0;
      if (!hasTaskId) {
        assignment.taskId = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      }
      if (typeof assignment.assignerAgentId !== 'string' || assignment.assignerAgentId.trim().length === 0) {
        assignment.assignerAgentId = FINGER_SYSTEM_AGENT_ID;
      }
      if (typeof assignment.assigneeAgentId !== 'string' || assignment.assigneeAgentId.trim().length === 0) {
        assignment.assigneeAgentId = FINGER_PROJECT_AGENT_ID;
      }
      if (typeof assignment.attempt !== 'number' || !Number.isFinite(assignment.attempt) || assignment.attempt < 1) {
        assignment.attempt = 1;
      }
      if (typeof assignment.phase !== 'string' || assignment.phase.trim().length === 0) {
        assignment.phase = 'assigned';
      }
      normalizedInput = {
        ...normalizedInput,
        assignment,
      };
    }
    if (originalSessionId
      && typeof normalizedInput.sessionId === 'string'
      && normalizedInput.sessionId.trim().length > 0
      && originalSessionId !== normalizedInput.sessionId.trim()) {
      const metadata = isObjectRecord(normalizedInput.metadata) ? { ...normalizedInput.metadata } : {};
      metadata.dispatchParentSessionId = originalSessionId;
      metadata.dispatchChildSessionId = normalizedInput.sessionId.trim();
      normalizedInput = {
        ...normalizedInput,
        metadata,
      };
    }
    if (typeof normalizedInput.sessionId === 'string' && normalizedInput.sessionId.trim().length > 0) {
      deps.runtime.bindAgentSession(normalizedInput.targetAgentId, normalizedInput.sessionId);
      deps.runtime.setCurrentSession(normalizedInput.sessionId);
    }
    const sessionIdForLedger = typeof normalizedInput.sessionId === 'string' ? normalizedInput.sessionId.trim() : '';
    if (sessionIdForLedger) {
      const transientPolicy = shouldUseTransientLedgerForDispatch(normalizedInput);
      if (transientPolicy.enabled) {
        const transientLedgerMode = `transient-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        deps.sessionManager.setTransientLedgerMode(sessionIdForLedger, transientLedgerMode, {
          source: transientPolicy.source,
          autoDeleteOnStop: true,
        });
        const metadata = isObjectRecord(normalizedInput.metadata) ? { ...normalizedInput.metadata } : {};
        metadata.ledgerMode = transientLedgerMode;
        metadata.transientLedger = true;
        metadata.transientLedgerMode = transientLedgerMode;
        normalizedInput = {
          ...normalizedInput,
          metadata,
        };
      } else {
        const dispatchMetadata = isObjectRecord(normalizedInput.metadata) ? normalizedInput.metadata : {};
        const isUserInbound = dispatchMetadata.role === 'user';
        if (isUserInbound) {
          deps.sessionManager.clearTransientLedgerMode(sessionIdForLedger);
        }
      }
    }
    applySessionProgressDeliveryFromDispatch(deps, normalizedInput);
    if (typeof normalizedInput.sessionId === 'string' && normalizedInput.sessionId.trim().length > 0) {
      applyExecutionLifecycleTransition(deps.sessionManager, normalizedInput.sessionId, {
        stage: 'dispatching',
        substage: 'normalized',
        updatedBy: 'dispatch',
        targetAgentId: normalizedInput.targetAgentId,
        detail: normalizedInput.sourceAgentId,
        lastError: null,
      });
    }
  } catch (preError) {
    const message = preError instanceof Error ? preError.message : String(preError);
    logger.module('dispatch').error('Pre-dispatch setup failed', preError instanceof Error ? preError : undefined, {
      targetAgentId: input.targetAgentId,
      sessionId: originalSessionId,
    });
    if (originalSessionId) {
      applyExecutionLifecycleTransition(deps.sessionManager, originalSessionId, {
        stage: 'failed',
        substage: 'dispatch_prepare_failed',
        updatedBy: 'dispatch',
        targetAgentId: input.targetAgentId,
        lastError: message,
      });
    }
    return { ok: false, dispatchId: fallbackDispatchId, status: 'failed', error: message };
  }

  await persistDispatchUserMessage(deps, normalizedInput);
  await persistUserMessageToMemory(deps, normalizedInput);

  let result: {
    ok: boolean;
    dispatchId: string;
    status: 'queued' | 'completed' | 'failed';
    result?: DispatchSummaryResult;
    error?: string;
    queuePosition?: number;
  } | undefined;
  let finalExecuteError: unknown;

  for (let attempt = 0; attempt <= DISPATCH_ERROR_MAX_RETRIES; attempt += 1) {
    try {
      result = await deps.agentRuntimeBlock.execute('dispatch', normalizedInput as unknown as Record<string, unknown>) as Exclude<typeof result, undefined>;
      finalExecuteError = undefined;
    } catch (executeError) {
      finalExecuteError = executeError;
      if (attempt >= DISPATCH_ERROR_MAX_RETRIES) break;
      const retryDelayMs = resolveRetryBackoffMs(attempt + 1);
      if (typeof normalizedInput.sessionId === 'string' && normalizedInput.sessionId.trim().length > 0) {
        applyExecutionLifecycleTransition(deps.sessionManager, normalizedInput.sessionId, {
          stage: 'retrying',
          substage: 'dispatch_execute_throw',
          updatedBy: 'dispatch',
          targetAgentId: normalizedInput.targetAgentId,
          lastError: executeError instanceof Error ? executeError.message : String(executeError),
          detail: `attempt=${attempt + 1}`,
          retryDelayMs,
          recoveryAction: 'retry',
          incrementRetry: true,
        });
      }
      logger.module('dispatch').warn('Dispatch execute threw error, retrying with exponential backoff', {
        retryAttempt: attempt + 1,
        maxRetries: DISPATCH_ERROR_MAX_RETRIES,
        retryDelayMs,
        targetAgentId: normalizedInput.targetAgentId,
        sessionId: normalizedInput.sessionId,
        error: executeError instanceof Error ? executeError.message : String(executeError),
      });
      await sleep(retryDelayMs);
      continue;
    }

    if (shouldAutoDeployForMissingTarget(normalizedInput, result)) {
      const deployRequest = {
        targetAgentId: normalizedInput.targetAgentId,
        sessionId: normalizedInput.sessionId,
        scope: 'session' as const,
        launchMode: 'orchestrator' as const,
        instanceCount: resolveAutoDeployInstanceCount(normalizedInput),
      };
      try {
        const deployResult = await deps.agentRuntimeBlock.execute('deploy', deployRequest as unknown as Record<string, unknown>) as {
          success?: boolean;
          error?: string;
        };
        if (deployResult?.success) {
          if (typeof normalizedInput.sessionId === 'string' && normalizedInput.sessionId.trim().length > 0) {
            applyExecutionLifecycleTransition(deps.sessionManager, normalizedInput.sessionId, {
              stage: 'retrying',
              substage: 'auto_deploy_retry',
              updatedBy: 'dispatch',
              targetAgentId: normalizedInput.targetAgentId,
              detail: `attempt=${attempt + 1}`,
              retryDelayMs: resolveRetryBackoffMs(attempt + 1),
              recoveryAction: 'retry',
              incrementRetry: true,
            });
          }
          logger.module('dispatch').info('Auto-deployed missing target agent before dispatch retry', {
            sourceAgentId: normalizedInput.sourceAgentId,
            targetAgentId: normalizedInput.targetAgentId,
            instanceCount: deployRequest.instanceCount,
            retryAttempt: attempt + 1,
            maxRetries: DISPATCH_ERROR_MAX_RETRIES,
          });
          if (attempt >= DISPATCH_ERROR_MAX_RETRIES) break;
          const retryDelayMs = resolveRetryBackoffMs(attempt + 1);
          await sleep(retryDelayMs);
          continue;
        }
        if (deployResult?.error) {
          logger.module('dispatch').warn('Auto-deploy failed before dispatch retry', {
            targetAgentId: normalizedInput.targetAgentId,
            error: deployResult.error,
          });
        }
      } catch (deployError) {
        logger.module('dispatch').warn('Auto-deploy retry threw error', {
          targetAgentId: normalizedInput.targetAgentId,
          error: deployError instanceof Error ? deployError.message : String(deployError),
        });
      }
    }

    if (result.ok || result.status !== 'failed') {
      break;
    }

    if (attempt >= DISPATCH_ERROR_MAX_RETRIES) {
      break;
    }
    const retryDelayMs = resolveRetryBackoffMs(attempt + 1);
    if (typeof normalizedInput.sessionId === 'string' && normalizedInput.sessionId.trim().length > 0) {
      applyExecutionLifecycleTransition(deps.sessionManager, normalizedInput.sessionId, {
        stage: 'retrying',
        substage: 'dispatch_result_failed',
        updatedBy: 'dispatch',
        targetAgentId: normalizedInput.targetAgentId,
        lastError: result.error,
        detail: `attempt=${attempt + 1}`,
        retryDelayMs,
        recoveryAction: 'retry',
        incrementRetry: true,
      });
    }
    logger.module('dispatch').warn('Dispatch returned failed result, retrying with exponential backoff', {
      retryAttempt: attempt + 1,
      maxRetries: DISPATCH_ERROR_MAX_RETRIES,
      retryDelayMs,
      targetAgentId: normalizedInput.targetAgentId,
      sessionId: normalizedInput.sessionId,
      error: result.error,
    });
    await sleep(retryDelayMs);
  }

  if (finalExecuteError) {
    const executeError = finalExecuteError;
    const message = executeError instanceof Error ? executeError.message : String(executeError);
    logger.module('dispatch').error('AgentRuntimeBlock.execute failed', executeError instanceof Error ? executeError : undefined, {
      dispatchId: fallbackDispatchId,
      targetAgentId: normalizedInput.targetAgentId,
      sessionId: normalizedInput.sessionId,
    });
    // Persist failure to session so the conversation history is complete
    const failSessionId = typeof normalizedInput.sessionId === 'string' ? normalizedInput.sessionId : '';
    if (failSessionId) {
      void deps.sessionManager.addMessage(failSessionId, 'system', '任务派发异常', {
        type: 'dispatch',
        agentId: normalizedInput.targetAgentId,
        metadata: { error: message, dispatchId: fallbackDispatchId },
      });
      applyExecutionLifecycleTransition(deps.sessionManager, failSessionId, {
        stage: 'failed',
        substage: 'dispatch_execute_final_error',
        updatedBy: 'dispatch',
        dispatchId: fallbackDispatchId,
        targetAgentId: normalizedInput.targetAgentId,
        lastError: message,
      });
    }
    await persistAgentSummaryToMemory(deps, normalizedInput, { ok: false, summary: message }, true);
    return { ok: false, dispatchId: fallbackDispatchId, status: 'failed', error: message };
  }
  if (!result) {
    if (typeof normalizedInput.sessionId === 'string' && normalizedInput.sessionId.trim().length > 0) {
      applyExecutionLifecycleTransition(deps.sessionManager, normalizedInput.sessionId, {
        stage: 'failed',
        substage: 'dispatch_result_empty',
        updatedBy: 'dispatch',
        targetAgentId: normalizedInput.targetAgentId,
        lastError: 'dispatch result is empty after retries',
      });
    }
    return { ok: false, dispatchId: fallbackDispatchId, status: 'failed', error: 'dispatch result is empty after retries' };
  }

  if (typeof normalizedInput.sessionId === 'string' && normalizedInput.sessionId.trim().length > 0) {
    const mailboxQueued = result.status === 'queued'
      && (result.result?.status === 'queued_mailbox' || typeof result.result?.messageId === 'string');
    applyExecutionLifecycleTransition(deps.sessionManager, normalizedInput.sessionId, {
      stage: resolveLifecycleStageFromResultStatus(result.status) ?? (result.ok ? 'completed' : 'failed'),
      substage: result.status === 'queued'
        ? (mailboxQueued ? 'dispatch_mailbox_wait_ack' : 'dispatch_queued')
        : result.status === 'completed'
          ? 'dispatch_completed'
          : 'dispatch_failed',
      updatedBy: 'dispatch',
      dispatchId: result.dispatchId,
      targetAgentId: normalizedInput.targetAgentId,
      lastError: result.ok ? null : (result.error ?? null),
      detail: result.result?.summary?.slice(0, 120) ?? result.error,
      timeoutMs: typeof result.result?.timeoutMs === 'number' ? result.result.timeoutMs : undefined,
      retryDelayMs: typeof result.result?.retryDelayMs === 'number' ? result.result.retryDelayMs : undefined,
      recoveryAction: mailboxQueued
        ? (result.result?.recoveryAction ?? 'mailbox')
        : result.ok
          ? (result.result?.recoveryAction ?? 'completed')
          : (result.result?.recoveryAction ?? 'failed'),
      delivery: mailboxQueued
        ? (result.result?.delivery ?? 'mailbox')
        : result.status === 'queued'
          ? (result.result?.delivery ?? 'queue')
          : result.result?.delivery ?? null,
    });
  }

  const newSessionId = typeof normalizedInput.sessionId === 'string' ? normalizedInput.sessionId.trim() : '';
  if (originalSessionId && newSessionId && originalSessionId !== newSessionId && result.dispatchId) {
    const tracker = getGlobalDispatchTracker();
    tracker.track({
      dispatchId: result.dispatchId,
      parentSessionId: originalSessionId,
      childSessionId: newSessionId,
      sourceAgentId: input.sourceAgentId,
      targetAgentId: input.targetAgentId,
    });
  }
  if (result.result !== undefined) {
    result.result = sanitizeDispatchResult(result.result);
    result.result = enrichDispatchTagsAndTopic(result.result, {
      task: normalizedInput.task,
      targetAgentId: normalizedInput.targetAgentId,
      sourceAgentId: normalizedInput.sourceAgentId,
    });
  }
  // Always record result to memory (success or failure)
  const summaryForMemory = result.result?.summary || result.error || undefined;
  if (summaryForMemory) {
    await persistAgentSummaryToMemory(deps, normalizedInput, { ok: result.ok, summary: summaryForMemory });
  }
  // Write dispatch result to session for all channels (unified ledger writing)
  // CRITICAL: Store FULL rawPayload in ledger - NEVER truncate
  const dispatchSessionId = typeof normalizedInput.sessionId === 'string' ? normalizedInput.sessionId.trim() : '';
  if (dispatchSessionId) {
    const dispatchSession = deps.sessionManager.getSession(dispatchSessionId);
    if (dispatchSession) {
      // Summary is for display (can be truncated), rawPayload is for ledger (NEVER truncated)
      const replyContent = result.ok
        ? (result.result?.summary || '处理完成')
        : `处理失败：${result.error || '未知错误'}`;

      // Build metadata with FULL rawPayload for ledger storage
      const ledgerMetadata: Record<string, unknown> = {
        source: 'dispatch',
        dispatchId: result.dispatchId,
        status: result.status,
        agentId: normalizedInput.targetAgentId,
        // Store full raw result for ledger - this is the single source of truth
        rawResult: result.result?.rawPayload ?? result.result,
      };
      if (result.error) ledgerMetadata.error = result.error;
      if (result.result?.tags) ledgerMetadata.tags = result.result.tags;
      if (result.result?.topic) ledgerMetadata.topic = result.result.topic;

      void deps.sessionManager.addMessage(dispatchSessionId, 'assistant', replyContent, {
        type: 'dispatch',
        agentId: normalizedInput.targetAgentId,
        metadata: ledgerMetadata,
      });
    }
  }
  await syncBdDispatchLifecycle(deps, normalizedInput, result);
  return result;
}
