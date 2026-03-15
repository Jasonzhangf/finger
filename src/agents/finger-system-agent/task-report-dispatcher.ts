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

export async function dispatchTaskToSystemAgent(
  deps: AgentRuntimeDeps,
  payload: TaskReportPayload
): Promise<void> {
  const sessionId = payload.sessionId;

  await deps.agentRuntimeBlock.execute('dispatch', {
    sourceAgentId: 'project-agent',
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
}
