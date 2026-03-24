import { logger } from '../../../core/logger.js';
import { isObjectRecord } from '../../common/object.js';
import { asString, firstNonEmptyString } from '../../common/strings.js';
import { getGlobalDispatchTracker } from './dispatch-tracker.js';
import { sanitizeDispatchResult, type DispatchSummaryResult } from '../../../common/agent-dispatch.js';
import type { AgentDispatchRequest, AgentRuntimeDeps } from './types.js';
import { SYSTEM_AGENT_CONFIG } from '../../../agents/finger-system-agent/index.js';
import { promises as fs } from 'fs';
import * as path from 'path';
import { formatLocalTimestamp, normalizeProjectPathHint } from './dispatch-helpers.js';

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

function resolveDispatchSessionStrategy(input: AgentDispatchRequest): NonNullable<AgentDispatchRequest['sessionStrategy']> {
  const metadata = isObjectRecord(input.metadata) ? input.metadata : {};
  const raw = firstNonEmptyString(
    input.sessionStrategy,
    asString(metadata.sessionStrategy),
    asString(metadata.session_strategy),
    asString(metadata.sessionMode),
    asString(metadata.session_mode),
  );
  const normalized = (raw ?? '').trim().toLowerCase();
  if (normalized === 'latest') return 'latest';
  if (normalized === 'new') return 'new';
  if (normalized === 'current') return 'current';
  return 'latest';
}

function resolveDispatchProjectPath(input: AgentDispatchRequest, deps: AgentRuntimeDeps): string {
  const metadata = isObjectRecord(input.metadata) ? input.metadata : {};
  const taskRecord = isObjectRecord(input.task) ? input.task : {};
  const taskMetadata = isObjectRecord(taskRecord.metadata) ? taskRecord.metadata : {};
  const hint = firstNonEmptyString(
    input.projectPath,
    asString(metadata.projectPath),
    asString(metadata.project_path),
    asString(metadata.cwd),
    asString(taskRecord.projectPath),
    asString(taskRecord.project_path),
    asString(taskRecord.cwd),
    asString(taskMetadata.projectPath),
    asString(taskMetadata.project_path),
    asString(taskMetadata.cwd),
    deps.runtime.getCurrentSession()?.projectPath,
    deps.sessionManager.getCurrentSession()?.projectPath,
    process.cwd(),
  );
  return normalizeProjectPathHint(hint ?? process.cwd());
}

function resolveLatestProjectRootSession(deps: AgentRuntimeDeps, projectPath: string) {
  const sessions = deps.sessionManager.findSessionsByProjectPath(projectPath)
    .filter((session) => !deps.isRuntimeChildSession(session))
    .sort((a, b) => new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime());
  return sessions[0] ?? null;
}

function resolveDispatchSessionSelection(deps: AgentRuntimeDeps, input: AgentDispatchRequest): AgentDispatchRequest {
  const explicitSessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  if (explicitSessionId.length > 0) {
    return {
      ...input,
      sessionId: explicitSessionId,
    };
  }

  const strategy = resolveDispatchSessionStrategy(input);
  if (strategy === 'current') {
    const currentSessionId = deps.runtime.getCurrentSession()?.id ?? deps.sessionManager.getCurrentSession()?.id;
    if (!currentSessionId) return input;
    return {
      ...input,
      sessionId: currentSessionId,
      sessionStrategy: 'current',
    };
  }

  const projectPath = resolveDispatchProjectPath(input, deps);
  const selectedSession = strategy === 'new'
    ? deps.sessionManager.createSession(projectPath, undefined, { allowReuse: false })
    : resolveLatestProjectRootSession(deps, projectPath)
      ?? deps.sessionManager.createSession(projectPath, undefined, { allowReuse: false });
  deps.sessionManager.setCurrentSession(selectedSession.id);
  return {
    ...input,
    sessionId: selectedSession.id,
    sessionStrategy: strategy,
    projectPath,
  };
}

function persistDispatchUserMessage(deps: AgentRuntimeDeps, input: AgentDispatchRequest): void {
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  if (!sessionId) return;
  const sourceAgentId = typeof input.sourceAgentId === 'string' && input.sourceAgentId.trim().length > 0
    ? input.sourceAgentId.trim()
    : deps.primaryOrchestratorAgentId;
  const content = formatDispatchTaskContent(input.task);
  if (content.trim().length === 0) return;
  void deps.sessionManager.addMessage(sessionId, 'user', content, {
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
  if (targetAgentId === SYSTEM_AGENT_CONFIG.id) return input;
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

function shouldRecordToMemory(input: AgentDispatchRequest): boolean {
    const metadata = isObjectRecord(input.metadata) ? input.metadata : {};
    const source = String(metadata.source ?? '');
  const role = String(metadata.role ?? '');
  const sourceAgentId = String(input.sourceAgentId ?? '');

  const isFromChannel = ['channel', 'webui', 'api'].includes(source);
  const isFromUser = role === 'user';
  const isFromAgent = sourceAgentId && sourceAgentId !== 'channel-bridge' && sourceAgentId !== 'api';

  return isFromChannel && isFromUser && !isFromAgent;
}

async function persistUserMessageToMemory(deps: AgentRuntimeDeps, input: AgentDispatchRequest): Promise<void> {
  if (!shouldRecordToMemory(input)) return;

  const sessionId = String(input.sessionId ?? '').trim();
  if (!sessionId) return;

  const session = deps.sessionManager.getSession(sessionId);
  if (!session) return;

  const content = formatDispatchTaskContent(input.task);
  if (!content.trim()) return;

  try {
    const memoryPath = path.join(session.projectPath, 'MEMORY.md');
    const timestamp = formatLocalTimestamp();
    const entryId = `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const metadata = isObjectRecord(input.metadata) ? input.metadata : {};
    const source = String(metadata.source ?? 'unknown');

    const entry = `## [input] 用户消息 {#${entryId}}
时间: ${timestamp}
Agent: ${input.targetAgentId}
来源: ${source}

${content}

Tags: input, user, ${source}
---`;

    const existingContent = await fs.readFile(memoryPath, 'utf8').catch(() => '');
    await fs.writeFile(memoryPath, `${entry}\n\n${existingContent}`);
  } catch (err) {
    logger.module('dispatch').error('Failed to record user message', err instanceof Error ? err : undefined);
  }
}

async function persistAgentSummaryToMemory(
  deps: AgentRuntimeDeps,
  input: AgentDispatchRequest,
  result: { ok: boolean; summary?: string },
  forceRecord = false,
): Promise<void> {
  if (!forceRecord && !shouldRecordToMemory(input)) return;
  if (!result.summary || result.summary.trim().length === 0) return;

  const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
  if (!sessionId) return;
  const session = deps.sessionManager.getSession(sessionId);
  if (!session) return;

  try {
    const memoryPath = path.join(session.projectPath, 'MEMORY.md');
    const timestamp = formatLocalTimestamp();
    const entryId = `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const status = result.ok ? 'completed' : 'failed';

    const entry = `## [summary] Agent 响应 {#${entryId}}
时间: ${timestamp}
Agent: ${input.targetAgentId}
状态: ${status}

${result.summary}

Tags: output, agent, ${status}
---`;

    const existingContent = await fs.readFile(memoryPath, 'utf8').catch(() => '');
    await fs.writeFile(memoryPath, `${entry}\n\n${existingContent}`);
  } catch (err) {
    logger.module('dispatch').error('Failed to record agent summary', err instanceof Error ? err : undefined);
  }
}

function shouldAutoDeployForSystemDispatch(input: AgentDispatchRequest, result: { ok: boolean; status: string; error?: string }): boolean {
  if (result.ok || result.status !== 'failed') return false;
  const source = typeof input.sourceAgentId === 'string' ? input.sourceAgentId.trim().toLowerCase() : '';
  if (!source.includes('system')) return false;
  const error = typeof result.error === 'string' ? result.error : '';
  return error.includes('target agent is not started in resource pool:');
}

function resolveAutoDeployInstanceCount(input: AgentDispatchRequest): number {
  const metadata = isObjectRecord(input.metadata) ? input.metadata : {};
  const raw = metadata.instanceCount ?? metadata.instance_count ?? metadata.runtimeCount ?? metadata.runtime_count;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.max(1, Math.floor(raw));
  }
  return 1;
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
  } catch (preError) {
    const message = preError instanceof Error ? preError.message : String(preError);
    logger.module('dispatch').error('Pre-dispatch setup failed', preError instanceof Error ? preError : undefined, {
      targetAgentId: input.targetAgentId,
      sessionId: originalSessionId,
    });
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
  };

  try {
    result = await deps.agentRuntimeBlock.execute('dispatch', normalizedInput as unknown as Record<string, unknown>) as typeof result;
  } catch (executeError) {
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
    }
    await persistAgentSummaryToMemory(deps, normalizedInput, { ok: false, summary: message }, true);
    return { ok: false, dispatchId: fallbackDispatchId, status: 'failed', error: message };
  }

  if (shouldAutoDeployForSystemDispatch(normalizedInput, result)) {
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
        logger.module('dispatch').info('Auto-deployed target agent for system dispatch retry', {
          sourceAgentId: normalizedInput.sourceAgentId,
          targetAgentId: normalizedInput.targetAgentId,
          instanceCount: deployRequest.instanceCount,
        });
        result = await deps.agentRuntimeBlock.execute('dispatch', normalizedInput as unknown as Record<string, unknown>) as typeof result;
      } else if (deployResult?.error) {
        logger.module('dispatch').warn('Auto-deploy failed before retry', {
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
