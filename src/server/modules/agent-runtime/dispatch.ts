import { logger } from '../../../core/logger.js';
import { isObjectRecord } from '../../common/object.js';
import { asString, firstNonEmptyString } from '../../common/strings.js';
import { sanitizeDispatchResult, type DispatchSummaryResult } from '../../../common/agent-dispatch.js';
import type { AgentDispatchRequest, AgentRuntimeDeps } from './types.js';
import { promises as fs } from 'fs';
import * as path from 'path';

function formatLocalTimestamp(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  const offset = -date.getTimezoneOffset();
  const offsetHours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const offsetMinutes = String(Math.abs(offset) % 60).padStart(2, '0');
  const offsetSign = offset >= 0 ? '+' : '-';
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms} ${offsetSign}${offsetHours}:${offsetMinutes}`;
}

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
  result: { ok: boolean; summary?: string }
): Promise<void> {
  if (!shouldRecordToMemory(input)) return;
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

export async function dispatchTaskToAgent(deps: AgentRuntimeDeps, input: AgentDispatchRequest): Promise<{
  ok: boolean;
  dispatchId: string;
  status: 'queued' | 'completed' | 'failed';
  result?: DispatchSummaryResult;
  error?: string;
  queuePosition?: number;
}> {
  const boundInput = bindDispatchSessionToRuntime(deps, input);
  const normalizedInput = withDispatchWorkspaceDefaults(deps, boundInput);
  await persistDispatchUserMessage(deps, normalizedInput);
  await persistUserMessageToMemory(deps, normalizedInput);
  const result = await deps.agentRuntimeBlock.execute('dispatch', normalizedInput as unknown as Record<string, unknown>) as {
    ok: boolean;
    dispatchId: string;
    status: 'queued' | 'completed' | 'failed';
    result?: DispatchSummaryResult;
    error?: string;
    queuePosition?: number;
  };
  if (result.result !== undefined) {
    result.result = sanitizeDispatchResult(result.result);
  }
  await persistAgentSummaryToMemory(deps, normalizedInput, result);
  await syncBdDispatchLifecycle(deps, normalizedInput, result);
  return result;
}
