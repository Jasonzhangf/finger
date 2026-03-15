/**
 * Report Task Completion Tool
 *
 * Project Agent 报告任务完成
 */

import type { ToolRegistry } from '../../runtime/tool-registry.js';
import type { AgentRuntimeDeps } from '../../server/modules/agent-runtime/types.js';
import { dispatchTaskToSystemAgent } from '../../agents/finger-system-agent/task-report-dispatcher.js';

export interface ReportTaskCompletionInput {
  action: 'report';
  taskId: string;
  taskSummary: string;
  sessionId: string;
  result: 'success' | 'failure';
  projectId: string;
}

export interface ReportTaskCompletionOutput {
  ok: boolean;
  action: string;
  error?: string;
}

export function registerReportTaskCompletionTool(
  toolRegistry: ToolRegistry,
  getAgentRuntimeDeps: () => AgentRuntimeDeps
): void {
  toolRegistry.register({
    name: 'report-task-completion',
    description: 'Project Agent 报告任务完成（仅 Project Agent 可用）',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['report'] },
        taskId: { type: 'string' },
        taskSummary: { type: 'string' },
        sessionId: { type: 'string' },
        result: { type: 'string', enum: ['success', 'failure'] },
        projectId: { type: 'string' },
      },
      required: ['action', 'taskId', 'taskSummary', 'sessionId', 'result', 'projectId'],
    },
    policy: 'allow',
    handler: async (input: unknown): Promise<ReportTaskCompletionOutput> => {
      const params = input as ReportTaskCompletionInput;
      if (params.action !== 'report') {
        return { ok: false, action: params.action, error: 'Unsupported action' };
      }

      try {
        const deps = getAgentRuntimeDeps();
        await dispatchTaskToSystemAgent(deps, {
          taskId: params.taskId,
          taskSummary: params.taskSummary,
          sessionId: params.sessionId,
          result: params.result,
          projectId: params.projectId,
        });

        return { ok: true, action: 'report' };
      } catch (error) {
        return { ok: false, action: 'report', error: error instanceof Error ? error.message : String(error) };
      }
    },
  });
}
