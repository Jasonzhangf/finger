
/**
 * Report Task Completion Tool
 *
 * Project Agent 报告任务完成，附交付标的。
 * System Agent 根据 dispatch 时的 review_required 决定是否触发 review。
 */

import type { ToolRegistry } from '../../runtime/tool-registry.js';
import type { AgentRuntimeDeps } from '../../server/modules/agent-runtime/types.js';
import { dispatchTaskToSystemAgent } from '../../agents/finger-system-agent/task-report-dispatcher.js';
import { emitTaskCompleted } from '../../agents/finger-system-agent/system-events.js';

export interface ReportTaskCompletionInput {
  action: 'report';
  taskId: string;
  taskSummary: string;
  sessionId: string;
  result: 'success' | 'failure';
  projectId: string;
  /** 交付标的：截图路径、执行结果、关键变更文件列表等 */
  deliveryArtifacts?: string;
}

export interface ReportTaskCompletionOutput {
  ok: boolean;
  action: string;
  dispatchId?: string;
  status?: 'queued' | 'completed' | 'failed';
  error?: string;
}

export function registerReportTaskCompletionTool(
  toolRegistry: ToolRegistry,
  getAgentRuntimeDeps: () => AgentRuntimeDeps
): void {
  toolRegistry.register({
    name: 'report-task-completion',
    description: 'Project Agent 报告任务完成，附交付标的（仅 Project Agent 可用）',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['report'] },
        taskId: { type: 'string' },
        taskSummary: { type: 'string' },
        sessionId: { type: 'string' },
        result: { type: 'string', enum: ['success', 'failure'] },
        projectId: { type: 'string' },
        delivery_artifacts: {
          type: 'string',
          description: '交付标的描述：截图路径、执行结果、关键变更文件列表等',
        },
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
        const deliveryArtifacts = typeof params.deliveryArtifacts === 'string'
          ? params.deliveryArtifacts.trim()
          : '';

        const dispatch = await dispatchTaskToSystemAgent(deps, {
          taskId: params.taskId,
          taskSummary: params.taskSummary,
          sessionId: params.sessionId,
          result: params.result,
          projectId: params.projectId,
          deliveryArtifacts,
        });

        const sessionManager = deps.sessionManager as
          | {
              getSession?: (sessionId: string) => unknown;
              addMessage?: (
                sessionId: string,
                role: 'user' | 'assistant' | 'system' | 'orchestrator',
                content: string,
                detail?: Record<string, unknown>
              ) => Promise<unknown> | unknown;
            }
          | undefined;
        if (
          sessionManager
          && typeof sessionManager.getSession === 'function'
          && typeof sessionManager.addMessage === 'function'
          && sessionManager.getSession(params.sessionId)
        ) {
          const statusLabel = dispatch.status === 'completed'
            ? '完成'
            : dispatch.status === 'failed'
              ? '失败'
              : '排队';
          const ackContent = dispatch.ok
            ? `任务完成已上报给 system · task=${params.taskId} · 状态 ${statusLabel}`
            : `任务完成上报失败 · task=${params.taskId}${dispatch.error ? ` · ${dispatch.error}` : ''}`;
          void sessionManager.addMessage(params.sessionId, 'system', ackContent, {
            type: 'dispatch',
            agentId: 'finger-system-agent',
            metadata: {
              source: 'report-task-completion',
              taskId: params.taskId,
              projectId: params.projectId,
              dispatchId: dispatch.dispatchId,
              status: dispatch.status,
              result: params.result,
              ...(deliveryArtifacts ? { deliveryArtifacts } : {}),
              ...(dispatch.error ? { error: dispatch.error } : {}),
            },
          });
        }

        if (!dispatch.ok || dispatch.status === 'failed') {
          return {
            ok: false,
            action: 'report',
            dispatchId: dispatch.dispatchId,
            status: dispatch.status,
            error: dispatch.error ?? 'dispatch to system agent failed',
          };
        }

        emitTaskCompleted(deps, {
          taskId: params.taskId,
          projectId: params.projectId,
        });

        return {
          ok: true,
          action: 'report',
          dispatchId: dispatch.dispatchId,
          status: dispatch.status,
        };
      } catch (error) {
        return { ok: false, action: 'report', error: error instanceof Error ? error.message : String(error) };
      }
    },
  });
}
