import { logger } from '../../../core/logger.js';
import { isObjectRecord } from '../../common/object.js';
import { asString, firstNonEmptyString } from '../../common/strings.js';
import type { AgentDispatchRequest, AgentRuntimeDeps } from './types.js';
import { SYSTEM_AGENT_CONFIG } from '../../../agents/finger-system-agent/index.js';
import { FINGER_REVIEWER_AGENT_ID } from '../../../agents/finger-general/finger-general-module.js';
import { promises as fs } from 'fs';
import * as path from 'path';
import {
  formatDispatchTaskContent,
  formatLocalTimestamp,
  normalizeProjectPathHint,
  resolveDispatchSessionStrategy,
} from './dispatch-helpers.js';
import { normalizeProgressDeliveryPolicy } from '../../../common/progress-delivery-policy.js';

const DISPATCH_RETRY_BASE_DELAY_MS = Number.isFinite(Number(process.env.FINGER_DISPATCH_RETRY_BASE_DELAY_MS))
  ? Math.max(100, Math.floor(Number(process.env.FINGER_DISPATCH_RETRY_BASE_DELAY_MS)))
  : 1_000;
const DISPATCH_RETRY_MAX_DELAY_MS = Number.isFinite(Number(process.env.FINGER_DISPATCH_RETRY_MAX_DELAY_MS))
  ? Math.max(1_000, Math.floor(Number(process.env.FINGER_DISPATCH_RETRY_MAX_DELAY_MS)))
  : 60_000;
const TRANSIENT_LEDGER_SOURCE_ALLOWLIST = new Set([
  'system-heartbeat',
  'mailbox-check',
  'clock',
  'news-cron',
  'email-cron',
  'user_notification',
  'mailbox-cli',
]);

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveRetryBackoffMs(retryAttempt: number): number {
  const exponent = Math.max(0, retryAttempt - 1);
  const raw = DISPATCH_RETRY_BASE_DELAY_MS * Math.pow(2, exponent);
  return Math.min(DISPATCH_RETRY_MAX_DELAY_MS, Math.max(DISPATCH_RETRY_BASE_DELAY_MS, Math.floor(raw)));
}

function parseBooleanFlag(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  }
  return undefined;
}

export function shouldUseTransientLedgerForDispatch(input: AgentDispatchRequest): {
  enabled: boolean;
  source?: string;
} {
  const metadata = isObjectRecord(input.metadata) ? input.metadata : {};
  const taskRecord = isObjectRecord(input.task) ? input.task : {};
  const taskMetadata = isObjectRecord(taskRecord.metadata) ? taskRecord.metadata : {};
  const source = typeof metadata.source === 'string'
    ? metadata.source.trim().toLowerCase()
    : typeof taskMetadata.source === 'string'
      ? taskMetadata.source.trim().toLowerCase()
      : '';

  const explicit =
    parseBooleanFlag(
      metadata.transientLedger
      ?? metadata.transient_ledger
      ?? taskMetadata.transientLedger
      ?? taskMetadata.transient_ledger,
    );
  if (explicit === true) {
    return { enabled: true, ...(source ? { source } : {}) };
  }
  if (explicit === false) {
    return { enabled: false, ...(source ? { source } : {}) };
  }

  const directInject =
    metadata.systemDirectInject === true
    || taskMetadata.systemDirectInject === true;
  if (directInject) {
    return { enabled: true, ...(source ? { source } : {}) };
  }

  if (source && TRANSIENT_LEDGER_SOURCE_ALLOWLIST.has(source)) {
    return { enabled: true, source };
  }
  return { enabled: false, ...(source ? { source } : {}) };
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

export function resolveDispatchSessionSelection(deps: AgentRuntimeDeps, input: AgentDispatchRequest): AgentDispatchRequest {
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

export function persistDispatchUserMessage(deps: AgentRuntimeDeps, input: AgentDispatchRequest): void {
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

export function withDispatchWorkspaceDefaults(deps: AgentRuntimeDeps, input: AgentDispatchRequest): AgentDispatchRequest {
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

export function applySessionProgressDeliveryFromDispatch(deps: AgentRuntimeDeps, input: AgentDispatchRequest): void {
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  if (!sessionId) return;

  const metadata = isObjectRecord(input.metadata) ? input.metadata : {};
  const taskRecord = isObjectRecord(input.task) ? input.task : {};
  const taskMetadata = isObjectRecord(taskRecord.metadata) ? taskRecord.metadata : {};
  const interactivePolicy = normalizeProgressDeliveryPolicy(
    metadata.progressDelivery
      ?? metadata.progress_delivery
      ?? taskMetadata.progressDelivery
      ?? taskMetadata.progress_delivery,
  );
  const scheduledPolicy = normalizeProgressDeliveryPolicy(
    metadata.scheduledProgressDelivery
      ?? metadata.scheduled_progress_delivery
      ?? taskMetadata.scheduledProgressDelivery
      ?? taskMetadata.scheduled_progress_delivery,
  );
  const source = typeof metadata.source === 'string'
    ? metadata.source.trim().toLowerCase()
    : typeof taskMetadata.source === 'string'
      ? taskMetadata.source.trim().toLowerCase()
      : '';
  const isScheduledSource = source === 'clock'
    || source === 'system-heartbeat'
    || source === 'mailbox-check'
    || source.endsWith('-cron')
    || metadata.systemDirectInject === true
    || taskMetadata.systemDirectInject === true;

  const useScheduledPolicy = !!scheduledPolicy || (isScheduledSource && !!interactivePolicy);
  const resolvedPolicy = scheduledPolicy ?? interactivePolicy;
  if (!resolvedPolicy) return;

  if (useScheduledPolicy) {
    deps.sessionManager.updateContext(sessionId, {
      scheduledProgressDelivery: resolvedPolicy,
      scheduledProgressDeliveryTransient: true,
      scheduledProgressDeliveryUpdatedAt: new Date().toISOString(),
    });
    return;
  }

  deps.sessionManager.updateContext(sessionId, {
    progressDelivery: resolvedPolicy,
    progressDeliveryTransient: true,
    progressDeliveryUpdatedAt: new Date().toISOString(),
  });
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

export function bindDispatchSessionToRuntime(deps: AgentRuntimeDeps, input: AgentDispatchRequest): AgentDispatchRequest {
  const targetAgentId = typeof input.targetAgentId === 'string' ? input.targetAgentId.trim() : '';
  if (targetAgentId === SYSTEM_AGENT_CONFIG.id) return input;
  if (!targetAgentId || deps.isPrimaryOrchestratorTarget(targetAgentId)) return input;
  const allowRuntimeChildSession = targetAgentId === FINGER_REVIEWER_AGENT_ID;

  const requestedSessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  if (!allowRuntimeChildSession && requestedSessionId) {
    const session = deps.sessionManager.getSession(requestedSessionId);
    if (session) {
      const context = isObjectRecord(session.context) ? session.context : {};
      const rootSessionId = asString(context.rootSessionId) || asString(context.parentSessionId);
      if (rootSessionId) {
        const root = deps.sessionManager.getSession(rootSessionId);
        if (root && !deps.isRuntimeChildSession(root)) {
          return { ...input, sessionId: root.id };
        }
      }
    }
  }

  if (!allowRuntimeChildSession) return input;

  if (requestedSessionId) {
    const session = deps.sessionManager.getSession(requestedSessionId);
    if (session) {
      const context = isObjectRecord(session.context) ? session.context : {};
      if ((context.sessionTier === 'runtime' || typeof context.parentSessionId === 'string')
        && asString(context.ownerAgentId) === FINGER_REVIEWER_AGENT_ID) {
        return input;
      }
    }
  }

  const rootSession = resolveRootSessionForDispatch(deps, requestedSessionId || undefined);
  const dispatchProjectPath = resolveDispatchProjectPath(input, deps);
  const sameProject = normalizeProjectPathHint(dispatchProjectPath) === normalizeProjectPathHint(rootSession.projectPath);
  if (!sameProject) {
    return {
      ...input,
      sessionId: rootSession.id,
    };
  }
  const runtimeSessionId = deps.ensureRuntimeChildSession(rootSession, targetAgentId).id;
  return {
    ...input,
    sessionId: runtimeSessionId,
  };
}

export async function syncBdDispatchLifecycle(deps: AgentRuntimeDeps, input: AgentDispatchRequest, result: {
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

export async function persistUserMessageToMemory(deps: AgentRuntimeDeps, input: AgentDispatchRequest): Promise<void> {
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

export async function persistAgentSummaryToMemory(
  deps: AgentRuntimeDeps,
  input: AgentDispatchRequest,
  result: { ok: boolean; summary?: string },
  forceRecord = false,
): Promise<void> {
  if (!forceRecord && !shouldRecordToMemory(input)) return;
  if (!result.summary || result.summary.trim().length === 0) return;

  const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
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

export function shouldAutoDeployForMissingTarget(input: AgentDispatchRequest, result: { ok: boolean; status: string; error?: string }): boolean {
  if (result.ok || result.status !== 'failed') return false;
  const error = typeof result.error === 'string' ? result.error : '';
  if (!error.includes('target agent is not started in resource pool:')) return false;
  return typeof input.targetAgentId === 'string' && input.targetAgentId.trim().length > 0;
}

export function resolveAutoDeployInstanceCount(input: AgentDispatchRequest): number {
  const metadata = isObjectRecord(input.metadata) ? input.metadata : {};
  const raw = metadata.instanceCount ?? metadata.instance_count ?? metadata.runtimeCount ?? metadata.runtime_count;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.max(1, Math.floor(raw));
  }
  return 1;
}
