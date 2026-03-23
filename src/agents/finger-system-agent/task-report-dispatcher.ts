/**
 * Task Report Dispatcher
 *
 * 将 Project Agent 的任务报告分发给 System Agent
 */

import type { AgentRuntimeDeps } from '../../server/modules/agent-runtime/types.js';

export interface TaskReportPayload {
  taskId: string;
  taskSummary: string;
  sessionId: string;
  result: 'success' | 'failure';
  projectId: string;
}

export interface TaskReportDispatchResult {
  ok: boolean;
  dispatchId: string;
  status: 'queued' | 'completed' | 'failed';
  error?: string;
}

export async function dispatchTaskToSystemAgent(
  deps: AgentRuntimeDeps,
  payload: TaskReportPayload
): Promise<TaskReportDispatchResult> {
  const sessionId = payload.sessionId;

  const raw = await deps.agentRuntimeBlock.execute('dispatch', {
    sourceAgentId: 'finger-project-agent',
    targetAgentId: 'finger-system-agent',
    task: {
      prompt: `[Task Report]\n任务ID: ${payload.taskId}\n任务摘要: ${payload.taskSummary}\n结果: ${payload.result}\n项目: ${payload.projectId}`,
    },
    sessionId,
    metadata: {
      source: 'task-report',
      role: 'system',
      projectId: payload.projectId,
      taskId: payload.taskId,
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
