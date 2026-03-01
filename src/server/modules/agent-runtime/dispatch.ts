import { isObjectRecord } from '../../common/object.js';
import { asString, firstNonEmptyString } from '../../common/strings.js';
import type { AgentDispatchRequest, AgentRuntimeDeps } from './types.js';

function formatDispatchTaskContent(task: unknown): string {
  if (typeof task === 'string') return task;
  if (!isObjectRecord(task)) return String(task);
  const direct = asString(task.text)
    ?? asString(task.content)
    ?? asString(task.prompt)
    ?? asString(task.description)
    ?? asString(task.title)
    ?? asString(task.task)
    ?? asString(task.message);
  if (direct) return direct;
  if (isObjectRecord(task.input)) {
    const nested = asString(task.input.text)
      ?? asString(task.input.content)
      ?? asString(task.input.prompt)
      ?? asString(task.input.description);
    if (nested) return nested;
  }
  try {
    return JSON.stringify(task, null, 2);
  } catch {
    return String(task);
  }
}

function persistDispatchUserMessage(deps: AgentRuntimeDeps, input: AgentDispatchRequest): void {
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  if (!sessionId) return;
  const sourceAgentId = typeof input.sourceAgentId === 'string' && input.sourceAgentId.trim().length > 0
    ? input.sourceAgentId.trim()
    : deps.primaryOrchestratorAgentId;
  const content = formatDispatchTaskContent(input.task);
  if (content.trim().length === 0) return;
  deps.sessionManager.addMessage(sessionId, 'user', content, {
    type: 'dispatch',
    agentId: sourceAgentId,
    metadata: {
      targetAgentId: input.targetAgentId,
      workflowId: input.workflowId,
      assignment: input.assignment,
    },
  });
}

function withDispatchWorkspaceDefaults(deps: AgentRuntimeDeps, input: AgentDispatchRequest): AgentDispatchRequest {
  const taskRecord = isObjectRecord(input.task) ? input.task : null;
  const inputMetadata = isObjectRecord(input.metadata) ? input.metadata : {};
  const taskMetadata = taskRecord && isObjectRecord(taskRecord.metadata) ? taskRecord.metadata : {};
  const sessionId = firstNonEmptyString(
    input.sessionId,
    taskRecord?.sessionId,
    taskRecord?.session_id,
    inputMetadata.sessionId,
    inputMetadata.session_id,
    taskMetadata.sessionId,
    taskMetadata.session_id,
  );
  if (!sessionId) return input;

  const dirs = deps.sessionWorkspaces.resolveSessionWorkspaceDirsForMessage(sessionId);
  const withWorkspaceMetadata = (metadata: Record<string, unknown>): Record<string, unknown> => ({
    ...metadata,
    ...(typeof metadata.contextLedgerRootDir === 'string' && metadata.contextLedgerRootDir.trim().length > 0
      ? {}
      : { contextLedgerRootDir: dirs.memoryDir }),
    ...(typeof metadata.deliverablesDir === 'string' && metadata.deliverablesDir.trim().length > 0
      ? {}
      : { deliverablesDir: dirs.deliverablesDir }),
    ...(typeof metadata.exchangeDir === 'string' && metadata.exchangeDir.trim().length > 0
      ? {}
      : { exchangeDir: dirs.exchangeDir }),
  });

  const normalizedTask = taskRecord
    ? {
      ...taskRecord,
      ...(typeof taskRecord.sessionId === 'string' && taskRecord.sessionId.trim().length > 0
        ? {}
        : { sessionId }),
      metadata: withWorkspaceMetadata(taskMetadata),
    }
    : input.task;

  return {
    ...input,
    sessionId,
    task: normalizedTask,
    metadata: withWorkspaceMetadata(inputMetadata),
  };
}

function resolveRootSessionForDispatch(deps: AgentRuntimeDeps, sessionId?: string) {
  if (sessionId) {
    const session = deps.sessionManager.getSession(sessionId);
    if (session) {
      if (!deps.isRuntimeChildSession(session)) {
        const hydrated = deps.sessionWorkspaces.hydrateSessionWorkspace(session.id);
        deps.sessionManager.updateContext(session.id, { sessionTier: 'orchestrator-root' });
        return hydrated;
      }
      const context = isObjectRecord(session.context) ? session.context : {};
      const rootSessionId = asString(context.rootSessionId) || asString(context.parentSessionId);
      if (rootSessionId) {
        const rootSession = deps.sessionManager.getSession(rootSessionId);
        if (rootSession && !deps.isRuntimeChildSession(rootSession)) {
          const hydrated = deps.sessionWorkspaces.hydrateSessionWorkspace(rootSession.id);
          deps.sessionManager.updateContext(rootSession.id, { sessionTier: 'orchestrator-root' });
          return hydrated;
        }
      }
    }
  }
  return deps.ensureOrchestratorRootSession();
}

function bindDispatchSessionToRuntime(deps: AgentRuntimeDeps, input: AgentDispatchRequest): AgentDispatchRequest {
  const targetAgentId = typeof input.targetAgentId === 'string' ? input.targetAgentId.trim() : '';
  if (!targetAgentId || deps.isPrimaryOrchestratorTarget(targetAgentId)) return input;

  const requestedSessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  if (requestedSessionId) {
    const session = deps.sessionManager.getSession(requestedSessionId);
    if (session) {
      const context = isObjectRecord(session.context) ? session.context : {};
      if (context.sessionTier === 'runtime' || typeof context.parentSessionId === 'string') {
        return input;
      }
    }
  }

  const rootSession = resolveRootSessionForDispatch(deps, requestedSessionId || undefined);
  const runtimeSessionId = deps.ensureRuntimeChildSession(rootSession, targetAgentId).id;
  return {
    ...input,
    sessionId: runtimeSessionId,
  };
}

async function syncBdDispatchLifecycle(deps: AgentRuntimeDeps, input: AgentDispatchRequest, result: {
  ok: boolean;
  dispatchId: string;
  status: 'queued' | 'completed' | 'failed';
  error?: string;
}): Promise<void> {
  const assignment = input.assignment ?? {};
  const bdTaskId = typeof assignment.bdTaskId === 'string' && assignment.bdTaskId.trim().length > 0
    ? assignment.bdTaskId.trim()
    : undefined;
  if (!bdTaskId) return;

  const assigner = assignment.assignerAgentId ?? input.sourceAgentId;
  const assignee = assignment.assigneeAgentId ?? input.targetAgentId;
  const attempt = typeof assignment.attempt === 'number' && Number.isFinite(assignment.attempt)
    ? Math.max(1, Math.floor(assignment.attempt))
    : 1;

  try {
    await deps.bdTools.assignTask(bdTaskId, assignee);
    if (result.status === 'queued') {
      await deps.bdTools.addComment(
        bdTaskId,
        `[dispatch queued] dispatch=${result.dispatchId} assigner=${assigner} assignee=${assignee} attempt=${attempt}`,
      );
      return;
    }
    if (result.status === 'completed' && result.ok) {
      await deps.bdTools.updateStatus(bdTaskId, 'review');
      await deps.bdTools.addComment(
        bdTaskId,
        `[dispatch completed] dispatch=${result.dispatchId} assigner=${assigner} assignee=${assignee} attempt=${attempt}`,
      );
      return;
    }

    await deps.bdTools.updateStatus(bdTaskId, 'blocked');
    await deps.bdTools.addComment(
      bdTaskId,
      `[dispatch failed] dispatch=${result.dispatchId} assigner=${assigner} assignee=${assignee} attempt=${attempt} error=${result.error ?? 'unknown'}`,
    );
  } catch {
    // Best-effort only.
  }
}

export async function dispatchTaskToAgent(deps: AgentRuntimeDeps, input: AgentDispatchRequest): Promise<{
  ok: boolean;
  dispatchId: string;
  status: 'queued' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
  queuePosition?: number;
}> {
  const boundInput = bindDispatchSessionToRuntime(deps, input);
  const normalizedInput = withDispatchWorkspaceDefaults(deps, boundInput);
  persistDispatchUserMessage(deps, normalizedInput);
  const result = await deps.agentRuntimeBlock.execute('dispatch', normalizedInput as unknown as Record<string, unknown>) as {
    ok: boolean;
    dispatchId: string;
    status: 'queued' | 'completed' | 'failed';
    result?: unknown;
    error?: string;
    queuePosition?: number;
  };
  await syncBdDispatchLifecycle(deps, normalizedInput, result);
  return result;
}
