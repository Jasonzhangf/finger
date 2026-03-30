import { logger } from '../../../core/logger.js';
import { writeFileSync } from 'fs';
import { isObjectRecord } from '../../common/object.js';
import { asString, firstNonEmptyString } from '../../common/strings.js';
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
  parseDelegatedProjectTaskRegistry,
  mergeProjectTaskState,
  parseProjectTaskState,
  upsertDelegatedProjectTaskRegistry,
} from '../../../common/project-task-state.js';
import { setupReviewRuntimeForDispatch } from '../../../agents/finger-system-agent/review-runtime.js';
import {
  applyExecutionLifecycleTransition,
  getExecutionLifecycleState,
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
import { setMonitorStatus } from '../../../agents/finger-system-agent/registry.js';

const DISPATCH_ERROR_MAX_RETRIES = Number.isFinite(Number(process.env.FINGER_DISPATCH_ERROR_MAX_RETRIES))
  ? Math.max(0, Math.floor(Number(process.env.FINGER_DISPATCH_ERROR_MAX_RETRIES)))
  : 10;
const BUSY_RUNTIME_STATUSES = new Set(['running', 'queued', 'waiting_input', 'paused']);
const ACTIVE_PROJECT_LIFECYCLE_STAGES = new Set([
  'received',
  'session_bound',
  'dispatching',
  'running',
  'waiting_tool',
  'waiting_model',
  'retrying',
  'interrupted',
]);

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveDispatchTaskIdentity(input: AgentDispatchRequest): { taskId?: string; taskName?: string } {
  const assignment = isObjectRecord(input.assignment) ? input.assignment : {};
  const taskRecord = isObjectRecord(input.task) ? input.task : {};
  const taskId = firstNonEmptyString(
    asString(assignment.taskId),
    asString(taskRecord.taskId),
    asString(taskRecord.task_id),
  );
  const taskName = firstNonEmptyString(
    asString(assignment.taskName),
    asString(taskRecord.taskName),
    asString(taskRecord.task_name),
    asString(taskRecord.title),
    asString(taskRecord.name),
  );
  return {
    ...(taskId ? { taskId } : {}),
    ...(taskName ? { taskName } : {}),
  };
}

function allowDispatchWhileBusy(input: AgentDispatchRequest): boolean {
  const metadata = isObjectRecord(input.metadata) ? input.metadata : {};
  const taskRecord = isObjectRecord(input.task) ? input.task : {};
  const taskMetadata = isObjectRecord(taskRecord.metadata) ? taskRecord.metadata : {};
  const explicit =
    metadata.allowDispatchWhileBusy
    ?? metadata.allow_dispatch_while_busy
    ?? metadata.forceDispatch
    ?? metadata.force_dispatch
    ?? taskMetadata.allowDispatchWhileBusy
    ?? taskMetadata.allow_dispatch_while_busy
    ?? taskMetadata.forceDispatch
    ?? taskMetadata.force_dispatch;
  return explicit === true;
}

async function resolveBusyProjectAgentState(
  deps: AgentRuntimeDeps,
  input: AgentDispatchRequest,
): Promise<{
  busy: boolean;
  status?: string;
  dispatchId?: string;
  taskId?: string;
  summary?: string;
}> {
  if (input.sourceAgentId !== FINGER_SYSTEM_AGENT_ID || input.targetAgentId !== FINGER_PROJECT_AGENT_ID) {
    return { busy: false };
  }
  if (allowDispatchWhileBusy(input)) {
    return { busy: false };
  }
  try {
    const snapshot = await deps.agentRuntimeBlock.execute('runtime_view', {});
    const view = isObjectRecord(snapshot) ? snapshot : {};
    const agents = Array.isArray(view.agents) ? view.agents : [];
    const target = agents.find((agent) => (
      isObjectRecord(agent)
      && asTrimmedString(agent.id) === FINGER_PROJECT_AGENT_ID
    ));
    if (!isObjectRecord(target)) return { busy: false };
    const status = asTrimmedString(target.status).toLowerCase();
    const busy = BUSY_RUNTIME_STATUSES.has(status);
    if (!busy) {
      return { busy: false, ...(status ? { status } : {}) };
    }
    const lastEvent = isObjectRecord(target.lastEvent) ? target.lastEvent : {};
    const eventTaskId = asTrimmedString(lastEvent.taskId);
    const eventDispatchId = asTrimmedString(lastEvent.dispatchId);
    const eventSummary = asTrimmedString(lastEvent.summary);
    return {
      busy: true,
      ...(status ? { status } : {}),
      ...(eventDispatchId ? { dispatchId: eventDispatchId } : {}),
      ...(eventTaskId ? { taskId: eventTaskId } : {}),
      ...(eventSummary ? { summary: eventSummary } : {}),
    };
  } catch {
    // Best effort: if runtime_view fails, don't block dispatch.
    return { busy: false };
  }
}

function resolveActiveProjectLifecycleState(
  deps: AgentRuntimeDeps,
  input: AgentDispatchRequest,
): {
  active: boolean;
  stage?: string;
  substage?: string;
  finishReason?: string;
  dispatchId?: string;
  turnId?: string;
} {
  if (input.sourceAgentId !== FINGER_SYSTEM_AGENT_ID || input.targetAgentId !== FINGER_PROJECT_AGENT_ID) {
    return { active: false };
  }
  if (allowDispatchWhileBusy(input)) return { active: false };
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  if (!sessionId) return { active: false };
  const lifecycle = getExecutionLifecycleState(deps.sessionManager, sessionId);
  if (!lifecycle) return { active: false };
  if (lifecycle.finishReason === 'stop') {
    return {
      active: false,
      stage: lifecycle.stage,
      ...(lifecycle.substage ? { substage: lifecycle.substage } : {}),
      ...(lifecycle.finishReason ? { finishReason: lifecycle.finishReason } : {}),
    };
  }
  if (!ACTIVE_PROJECT_LIFECYCLE_STAGES.has(lifecycle.stage)) {
    return {
      active: false,
      stage: lifecycle.stage,
      ...(lifecycle.substage ? { substage: lifecycle.substage } : {}),
      ...(lifecycle.finishReason ? { finishReason: lifecycle.finishReason } : {}),
    };
  }
  return {
    active: true,
    stage: lifecycle.stage,
    ...(lifecycle.substage ? { substage: lifecycle.substage } : {}),
    ...(lifecycle.finishReason ? { finishReason: lifecycle.finishReason } : {}),
    ...(lifecycle.dispatchId ? { dispatchId: lifecycle.dispatchId } : {}),
    ...(lifecycle.turnId ? { turnId: lifecycle.turnId } : {}),
  };
}

function resolveProjectTaskStateSessionIds(
  originalSessionId: string,
  normalizedSessionId?: string,
): string[] {
  const values = [originalSessionId, normalizedSessionId ?? '']
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return Array.from(new Set(values));
}

function persistProjectTaskState(
  deps: AgentRuntimeDeps,
  sessionIds: string[],
  patch: {
    active?: boolean;
    status?: 'dispatching' | 'in_progress' | 'waiting_review' | 'completed' | 'failed' | 'cancelled';
    taskId?: string;
    taskName?: string;
    dispatchId?: string;
    summary?: string;
    note?: string;
    sourceAgentId?: string;
    targetAgentId?: string;
  },
): void {
  for (const sessionId of sessionIds) {
    const session = deps.sessionManager.getSession(sessionId);
    if (!session) continue;
    const current = parseProjectTaskState(session.context?.projectTaskState);
    const next = mergeProjectTaskState(current, {
      ...patch,
      sourceAgentId: patch.sourceAgentId ?? current?.sourceAgentId ?? FINGER_SYSTEM_AGENT_ID,
      targetAgentId: patch.targetAgentId ?? current?.targetAgentId ?? FINGER_PROJECT_AGENT_ID,
    });
    const currentRegistry = parseDelegatedProjectTaskRegistry(session.context?.projectTaskRegistry);
    const nextRegistry = upsertDelegatedProjectTaskRegistry(currentRegistry, {
      sourceAgentId: next.sourceAgentId,
      targetAgentId: next.targetAgentId,
      taskId: next.taskId,
      taskName: next.taskName,
      status: next.status,
      active: next.active,
      dispatchId: next.dispatchId,
      summary: next.summary,
      note: next.note,
    });
    deps.sessionManager.updateContext(sessionId, {
      projectTaskState: next,
      projectTaskRegistry: nextRegistry,
    });
    writeTaskRouterMarkdown(session.projectPath, next, nextRegistry);
  }
}

function writeTaskRouterMarkdown(
  projectPath: string,
  state: ReturnType<typeof mergeProjectTaskState>,
  registry: ReturnType<typeof upsertDelegatedProjectTaskRegistry>,
): void {
  if (typeof projectPath !== 'string' || projectPath.trim().length === 0) return;
  const normalized = projectPath.replace(/\/+$/, '');
  const taskFilePath = `${normalized}/TASK.md`;
  const nowIso = new Date().toISOString();
  const lines: string[] = [
    '# TASK Router',
    '',
    `Updated: ${nowIso}`,
    '',
    '## Current Task State',
    `- active: ${state.active}`,
    `- status: ${state.status}`,
    `- source: ${state.sourceAgentId}`,
    `- target: ${state.targetAgentId}`,
    state.taskId ? `- taskId: ${state.taskId}` : '- taskId: N/A',
    state.taskName ? `- taskName: ${state.taskName}` : '- taskName: N/A',
    state.dispatchId ? `- dispatchId: ${state.dispatchId}` : '- dispatchId: N/A',
    state.note ? `- note: ${state.note}` : '- note: N/A',
    '',
    '## Delegated Project List (latest)',
  ];

  const ordered = [...registry]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 20);
  if (ordered.length === 0) {
    lines.push('- (empty)');
  } else {
    for (const item of ordered) {
      lines.push(
        `- [${item.status}] active=${item.active} target=${item.targetAgentId}`
        + `${item.taskId ? ` taskId=${item.taskId}` : ''}`
        + `${item.taskName ? ` task="${item.taskName}"` : ''}`
        + `${item.dispatchId ? ` dispatch=${item.dispatchId}` : ''}`
        + ` updated=${item.updatedAt}`,
      );
    }
  }
  lines.push('');
  lines.push('## Routing Rule');
  lines.push('- Context exposes concise status only.');
  lines.push('- Full task details and progression should be maintained in this TASK.md.');
  try {
    writeFileSync(taskFilePath, lines.join('\n') + '\n', 'utf8');
  } catch {
    // Best effort only: task state remains in session context even if file write fails.
  }
}

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
    if (normalizedInput.targetAgentId === FINGER_PROJECT_AGENT_ID) {
      const metadata = isObjectRecord(normalizedInput.metadata) ? normalizedInput.metadata : {};
      const taskRecord = isObjectRecord(normalizedInput.task) ? normalizedInput.task : {};
      const taskMetadata = isObjectRecord(taskRecord.metadata) ? taskRecord.metadata : {};
      const sessionId = typeof normalizedInput.sessionId === 'string' ? normalizedInput.sessionId.trim() : '';
      const boundSession = sessionId ? deps.sessionManager.getSession(sessionId) : null;
      const projectPathHint = firstNonEmptyString(
        normalizedInput.projectPath,
        asString(metadata.projectPath),
        asString(metadata.project_path),
        asString(metadata.cwd),
        asString(taskRecord.projectPath),
        asString(taskRecord.project_path),
        asString(taskRecord.cwd),
        asString(taskMetadata.projectPath),
        asString(taskMetadata.project_path),
        asString(taskMetadata.cwd),
        boundSession?.projectPath,
      );
      if (projectPathHint) {
        try {
          const monitoredAgent = await setMonitorStatus(projectPathHint, true);
          const nextMetadata = { ...(isObjectRecord(normalizedInput.metadata) ? normalizedInput.metadata : {}) };
          nextMetadata.projectId = monitoredAgent.projectId;
          nextMetadata.projectPath = monitoredAgent.projectPath;
          nextMetadata.projectAgentId = monitoredAgent.agentId;
          nextMetadata.projectMonitored = monitoredAgent.monitored === true;
          normalizedInput = {
            ...normalizedInput,
            projectPath: monitoredAgent.projectPath,
            metadata: nextMetadata,
          };
        } catch (registerError) {
          logger.module('dispatch').warn('Auto monitor registration failed for project dispatch', {
            targetAgentId: normalizedInput.targetAgentId,
            sessionId,
            projectPathHint,
            error: registerError instanceof Error ? registerError.message : String(registerError),
          });
        }
      }
    }
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
      await setupReviewRuntimeForDispatch(deps, normalizedInput);
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
      const sessionForSnapshot = deps.sessionManager.getSession(normalizedInput.sessionId.trim());
      const sessionContext = (sessionForSnapshot?.context && typeof sessionForSnapshot.context === 'object')
        ? (sessionForSnapshot.context as Record<string, unknown>)
        : {};
      const metadata = isObjectRecord(normalizedInput.metadata) ? { ...normalizedInput.metadata } : {};
      const taskRouterPath = (
        typeof sessionForSnapshot?.projectPath === 'string' && sessionForSnapshot.projectPath.trim().length > 0
          ? `${sessionForSnapshot.projectPath.replace(/\/+$/, '')}/TASK.md`
          : undefined
      );
      metadata.sessionContextSnapshot = {
        executionLifecycle: sessionContext.executionLifecycle,
        projectTaskState: sessionContext.projectTaskState,
        projectTaskRegistry: sessionContext.projectTaskRegistry,
        ...(taskRouterPath ? { taskRouterPath } : {}),
      };
      if (taskRouterPath) metadata.taskRouterPath = taskRouterPath;
      normalizedInput = {
        ...normalizedInput,
        metadata,
      };
    }
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

  const projectTaskIdentity = resolveDispatchTaskIdentity(normalizedInput);
  const projectTaskStateSessionIds = (
    normalizedInput.sourceAgentId === FINGER_SYSTEM_AGENT_ID
    && normalizedInput.targetAgentId === FINGER_PROJECT_AGENT_ID
  )
    ? resolveProjectTaskStateSessionIds(
      originalSessionId,
      typeof normalizedInput.sessionId === 'string' ? normalizedInput.sessionId : '',
    )
    : [];
  if (projectTaskStateSessionIds.length > 0) {
    persistProjectTaskState(deps, projectTaskStateSessionIds, {
      active: true,
      status: 'dispatching',
      taskId: projectTaskIdentity.taskId,
      taskName: projectTaskIdentity.taskName,
      sourceAgentId: normalizedInput.sourceAgentId,
      targetAgentId: normalizedInput.targetAgentId,
      note: 'system_dispatched_project_task',
    });
  }

  const activeLifecycle = resolveActiveProjectLifecycleState(deps, normalizedInput);
  if (activeLifecycle.active) {
    const fallbackDispatchId = activeLifecycle.dispatchId || `dispatch-active-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const summary = [
      `target ${normalizedInput.targetAgentId} has active lifecycle`,
      activeLifecycle.stage ? `stage=${activeLifecycle.stage}` : '',
      activeLifecycle.substage ? `substage=${activeLifecycle.substage}` : '',
      activeLifecycle.turnId ? `turn=${activeLifecycle.turnId}` : '',
      '- dispatch suppressed; waiting for project update/reviewer pass',
    ].filter(Boolean).join(' ');
    if (typeof normalizedInput.sessionId === 'string' && normalizedInput.sessionId.trim().length > 0) {
      applyExecutionLifecycleTransition(deps.sessionManager, normalizedInput.sessionId, {
        stage: 'dispatching',
        substage: 'dispatch_suppressed_active_lifecycle',
        updatedBy: 'dispatch',
        dispatchId: fallbackDispatchId,
        targetAgentId: normalizedInput.targetAgentId,
        detail: summary,
        recoveryAction: 'wait_current_task',
        delivery: 'queue',
      });
    }
    logger.module('dispatch').info('Suppressed system->project dispatch due to active lifecycle', {
      sourceAgentId: normalizedInput.sourceAgentId,
      targetAgentId: normalizedInput.targetAgentId,
      sessionId: normalizedInput.sessionId,
      stage: activeLifecycle.stage,
      substage: activeLifecycle.substage,
      taskId: projectTaskIdentity.taskId,
      taskName: projectTaskIdentity.taskName,
      dispatchId: fallbackDispatchId,
    });
    if (projectTaskStateSessionIds.length > 0) {
      persistProjectTaskState(deps, projectTaskStateSessionIds, {
        active: true,
        status: 'in_progress',
        taskId: projectTaskIdentity.taskId,
        taskName: projectTaskIdentity.taskName,
        dispatchId: fallbackDispatchId,
        summary,
        note: 'dispatch_suppressed_active_lifecycle',
      });
    }
    return {
      ok: true,
      dispatchId: fallbackDispatchId,
      status: 'queued',
      result: sanitizeDispatchResult({
        success: true,
        status: 'queued_active_lifecycle_suppressed',
        summary,
        recoveryAction: 'wait_current_task',
        delivery: 'queue',
        ...(projectTaskIdentity.taskId ? { taskId: projectTaskIdentity.taskId } : {}),
        ...(projectTaskIdentity.taskName ? { taskName: projectTaskIdentity.taskName } : {}),
        ...(activeLifecycle.stage ? { lifecycleStage: activeLifecycle.stage } : {}),
        ...(activeLifecycle.substage ? { lifecycleSubstage: activeLifecycle.substage } : {}),
      }),
    };
  }

  const busyState = await resolveBusyProjectAgentState(deps, normalizedInput);
  if (busyState.busy) {
    const fallbackDispatchId = busyState.dispatchId || `dispatch-busy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const busySummary = [
      `target ${normalizedInput.targetAgentId} busy`,
      busyState.taskId ? `(task=${busyState.taskId})` : '',
      busyState.status ? `status=${busyState.status}` : '',
      '- dispatch suppressed; wait for current task update',
    ].filter(Boolean).join(' ');
    if (typeof normalizedInput.sessionId === 'string' && normalizedInput.sessionId.trim().length > 0) {
      applyExecutionLifecycleTransition(deps.sessionManager, normalizedInput.sessionId, {
        stage: 'dispatching',
        substage: 'dispatch_suppressed_target_busy',
        updatedBy: 'dispatch',
        dispatchId: fallbackDispatchId,
        targetAgentId: normalizedInput.targetAgentId,
        detail: busySummary,
        recoveryAction: 'wait_current_task',
        delivery: 'queue',
      });
    }
    logger.module('dispatch').info('Suppressed duplicate system->project dispatch while target is busy', {
      sourceAgentId: normalizedInput.sourceAgentId,
      targetAgentId: normalizedInput.targetAgentId,
      sessionId: normalizedInput.sessionId,
      busyStatus: busyState.status,
      currentTaskId: busyState.taskId,
      taskId: projectTaskIdentity.taskId,
      taskName: projectTaskIdentity.taskName,
      dispatchId: fallbackDispatchId,
    });
    if (projectTaskStateSessionIds.length > 0) {
      persistProjectTaskState(deps, projectTaskStateSessionIds, {
        active: true,
        status: 'in_progress',
        taskId: projectTaskIdentity.taskId,
        taskName: projectTaskIdentity.taskName,
        dispatchId: fallbackDispatchId,
        summary: busySummary,
        note: 'dispatch_suppressed_target_busy',
      });
    }
    return {
      ok: true,
      dispatchId: fallbackDispatchId,
      status: 'queued',
      result: sanitizeDispatchResult({
        success: true,
        status: 'queued_busy_suppressed',
        summary: busySummary,
        recoveryAction: 'wait_current_task',
        delivery: 'queue',
        ...(busyState.taskId ? { currentTaskId: busyState.taskId } : {}),
        ...(projectTaskIdentity.taskId ? { taskId: projectTaskIdentity.taskId } : {}),
        ...(projectTaskIdentity.taskName ? { taskName: projectTaskIdentity.taskName } : {}),
      }),
    };
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
    if (projectTaskStateSessionIds.length > 0) {
      persistProjectTaskState(deps, projectTaskStateSessionIds, {
        active: false,
        status: 'failed',
        taskId: projectTaskIdentity.taskId,
        taskName: projectTaskIdentity.taskName,
        dispatchId: fallbackDispatchId,
        summary: message,
        note: 'dispatch_execute_final_error',
      });
    }
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
    if (projectTaskStateSessionIds.length > 0) {
      persistProjectTaskState(deps, projectTaskStateSessionIds, {
        active: false,
        status: 'failed',
        taskId: projectTaskIdentity.taskId,
        taskName: projectTaskIdentity.taskName,
        dispatchId: fallbackDispatchId,
        summary: 'dispatch result is empty after retries',
        note: 'dispatch_result_empty',
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
  if (projectTaskStateSessionIds.length > 0) {
    const mappedStatus = result.status === 'failed' ? 'failed' : 'in_progress';
    const shouldStayActive = result.status !== 'failed';
    persistProjectTaskState(deps, projectTaskStateSessionIds, {
      active: shouldStayActive,
      status: mappedStatus,
      taskId: projectTaskIdentity.taskId,
      taskName: projectTaskIdentity.taskName,
      dispatchId: result.dispatchId,
      summary: result.result?.summary ?? result.error,
      note: result.status === 'failed'
        ? 'dispatch_failed'
        : result.status === 'queued'
          ? 'dispatch_queued'
          : 'dispatch_completed_waiting_project_delivery',
    });
  }
  return result;
}
