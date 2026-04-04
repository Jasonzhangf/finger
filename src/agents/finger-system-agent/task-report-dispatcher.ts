/**
 * Task Report Dispatcher
 *
 * 将 Project Agent 的任务报告分发给 System Agent
 */

import type { AgentRuntimeDeps } from '../../server/modules/agent-runtime/types.js';
import { logger } from '../../core/logger.js';
import {
  buildTaskReportContract,
  parseTaskReportContract,
  type TaskReportContract,
} from '../../common/task-report-contract.js';

export interface TaskReportPayload {
  taskId: string;
  taskName?: string;
  taskSummary: string;
  sessionId: string;
  result: 'success' | 'failure';
  projectId: string;
  /** 交付标的 */
  deliveryArtifacts?: string;
  /** 上报来源，默认 finger-project-agent；review 通过上报时会改为 finger-reviewer */
  sourceAgentId?: string;
  /** Structured report payload (preferred). */
  taskReport?: TaskReportContract;
  evidence?: string[] | string;
  status?: string;
  nextAction?: string;
  reviewDecision?: string;
  deliveryClaim?: boolean;
}

export interface TaskReportDispatchResult {
  ok: boolean;
  dispatchId: string;
  status: 'queued' | 'completed' | 'failed';
  error?: string;
}

const SYSTEM_AGENT_ID = 'finger-system-agent';
const BUSY_STATUSES = new Set(['running', 'queued', 'waiting_input', 'paused']);
const log = logger.module('TaskReportDispatcher');

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  return value as Record<string, unknown>;
}

function resolveRootSessionIdIfRuntime(deps: AgentRuntimeDeps, sessionId: string | undefined): string | undefined {
  if (!sessionId || sessionId.trim().length === 0) return undefined;
  const session = deps.sessionManager.getSession(sessionId.trim());
  if (!session) return undefined;
  const context = asRecord(session.context) ?? {};
  const rootSessionId =
    (typeof context.rootSessionId === 'string' && context.rootSessionId.trim().length > 0
      ? context.rootSessionId.trim()
      : undefined)
    ?? (typeof context.parentSessionId === 'string' && context.parentSessionId.trim().length > 0
      ? context.parentSessionId.trim()
      : undefined);
  if (!rootSessionId) return session.id;
  const root = deps.sessionManager.getSession(rootSessionId);
  return root ? root.id : session.id;
}

function resolveTaskReportSessionId(deps: AgentRuntimeDeps, requestedSessionId: string): string {
  const fromRequested = resolveRootSessionIdIfRuntime(deps, requestedSessionId);
  if (fromRequested) return fromRequested;

  const runtimeCurrentSession = deps.runtime.getCurrentSession();
  const fromRuntimeCurrent = resolveRootSessionIdIfRuntime(deps, runtimeCurrentSession?.id);
  if (fromRuntimeCurrent) return fromRuntimeCurrent;

  const fromSessionCurrent = resolveRootSessionIdIfRuntime(deps, deps.sessionManager.getCurrentSession()?.id);
  if (fromSessionCurrent) return fromSessionCurrent;

  return deps.sessionManager.getOrCreateSystemSession().id;
}

function isBusyStatus(value: unknown): boolean {
  return typeof value === 'string' && BUSY_STATUSES.has(value.trim().toLowerCase());
}

async function isSystemAgentBusy(deps: AgentRuntimeDeps): Promise<boolean> {
  try {
    const raw = await deps.agentRuntimeBlock.execute('runtime_view', {});
    const view = (typeof raw === 'object' && raw !== null ? raw : {}) as { agents?: unknown };
    const agents = Array.isArray(view.agents) ? view.agents : [];
    const agent = agents.find((item) => (
      typeof item === 'object'
      && item !== null
      && typeof (item as { id?: unknown }).id === 'string'
      && (item as { id: string }).id === SYSTEM_AGENT_ID
    )) as { status?: unknown } | undefined;
    if (!agent) return true;
    return isBusyStatus(agent.status);
  } catch (err) {
    log.warn('Failed to query system agent busy status; fallback to busy=true for safety', {
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

export async function dispatchTaskToSystemAgent(
  deps: AgentRuntimeDeps,
  payload: TaskReportPayload
): Promise<TaskReportDispatchResult> {
  const sessionId = resolveTaskReportSessionId(deps, payload.sessionId);
  const sessionSubstituted = payload.sessionId.trim() !== sessionId;
  const systemBusy = await isSystemAgentBusy(deps);
  const sourceAgentId = typeof payload.sourceAgentId === 'string' && payload.sourceAgentId.trim().length > 0
    ? payload.sourceAgentId.trim()
    : 'finger-project-agent';
  const structuredTaskReport = parseTaskReportContract(payload.taskReport)
    ?? buildTaskReportContract({
      taskId: payload.taskId,
      taskName: payload.taskName,
      sessionId: payload.sessionId,
      projectId: payload.projectId,
      sourceAgentId,
      result: payload.result,
      summary: payload.taskSummary,
      status: payload.status,
      deliveryArtifacts: payload.deliveryArtifacts,
      evidence: payload.evidence,
      nextAction: payload.nextAction,
      reviewDecision: payload.reviewDecision,
      deliveryClaim: payload.deliveryClaim,
    });

  const raw = await deps.agentRuntimeBlock.execute('dispatch', {
    sourceAgentId,
    targetAgentId: SYSTEM_AGENT_ID,
    task: {
      prompt: `[Task Report]
任务ID: ${payload.taskId}
${payload.taskName ? `任务名: ${payload.taskName}\n` : ''}任务状态: ${structuredTaskReport.status}
任务摘要: ${payload.taskSummary}
结果: ${payload.result}
项目: ${payload.projectId}${payload.deliveryArtifacts ? "\n交付标的: " + payload.deliveryArtifacts : ""}`,
    },
    sessionId,
    metadata: {
      source: 'task-report',
      role: 'system',
      projectId: payload.projectId,
      taskId: payload.taskId,
      ...(payload.taskName ? { taskName: payload.taskName } : {}),
      taskReport: structuredTaskReport,
      taskReportSchema: structuredTaskReport.schema,
      ...(systemBusy ? {} : { deliveryMode: 'direct' }),
      ...(sessionSubstituted ? { originalSessionId: payload.sessionId } : {}),
    },
    blocking: false,
  });

  const result = (typeof raw === 'object' && raw !== null ? raw : {}) as {
    ok?: boolean;
    dispatchId?: string;
    status?: string;
    error?: string;
  };
  const status = result.status === 'completed' || result.status === 'failed' ? result.status : 'queued';
  return {
    ok: result.ok !== false && status !== 'failed',
    dispatchId: typeof result.dispatchId === 'string' && result.dispatchId.trim().length > 0
      ? result.dispatchId
      : `dispatch-${Date.now()}-task-report`,
    status,
    ...(typeof result.error === 'string' && result.error.trim().length > 0 ? { error: result.error.trim() } : {}),
  };
}
