/**
 * Project Reject Task Tool (V3)
 *
 * System Agent 拒绝任务，要求 Project Agent 重做。
 */

import type { ToolRegistry } from '../../runtime/tool-registry.js';
import { RuntimeContext } from '../../runtime/runtime-context.js';
import type { AgentRuntimeDeps } from '../../server/modules/agent-runtime/types.js';
import { logger } from '../../core/logger.js';
import { FINGER_SYSTEM_AGENT_ID, FINGER_PROJECT_AGENT_ID } from '../../agents/finger-general/finger-general-module.js';
import { getClaimRecordByTaskId } from '../../common/claim-registry.js';
import { applyProjectStatusGatewayPatch } from '../../server/modules/project-status-gateway.js';

const log = logger.module('project-reject-task-tool');

export interface RejectTaskInput {
  taskId: string;
  feedback: string; // Specific issues to fix
  reworkPrompt?: string; // Optional explicit rework instruction
}

export interface RejectTaskOutput {
  ok: boolean;
  taskId: string;
  status: 'rejected';
  feedback: string;
  dispatchId?: string;
  message: string;
}



export function registerProjectRejectTaskTool(toolRegistry: ToolRegistry): void {
  const getAgentRuntimeDeps = () => RuntimeContext.getInstance().getDeps();
  toolRegistry.register({
    name: 'project.reject_task',
    description: 'System Agent rejects task after review_claim REJECT. Dispatches rework to Project Agent with specific feedback.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to reject' },
        feedback: { type: 'string', description: 'Specific issues to fix' },
        reworkPrompt: { type: 'string', description: 'Optional explicit rework instruction' },
      },
      required: ['taskId', 'feedback'],
    },
    policy: 'allow',
    handler: async (input: unknown): Promise<RejectTaskOutput> => {
      const deps = getAgentRuntimeDeps();
      const params = input as Partial<RejectTaskInput>;

      log.info('System Agent rejecting task', { taskId: params.taskId, feedback: params.feedback });

      // 1. 按 taskId 查找 claim record（必须是 rejected 状态）
      const claimRecord = getClaimRecordByTaskId(params.taskId!);
      if (!claimRecord || claimRecord.status !== 'rejected') {
        return {
          ok: false,
          taskId: params.taskId ?? '',
          status: 'rejected',
          feedback: params.feedback ?? '',
          message: 'Task not found or not reviewed as REJECT. Call project.review_claim first.',
        };
      }

      // 2. 构建重做提示
      const feedbackText = params.feedback?.trim() ?? 'Task rejected. Please fix the issues and resubmit.';
      const reworkPrompt = params.reworkPrompt?.trim() ?? `Previous submission rejected. Feedback: ${feedbackText}. Please fix the issues and submit a new completion claim.`;

      // 3. 派发重做任务给 Project Agent
      const dispatch = await deps.agentRuntimeBlock.execute('dispatch', {
        sourceAgentId: FINGER_SYSTEM_AGENT_ID,
        targetAgentId: FINGER_PROJECT_AGENT_ID,
        task: {
          prompt: reworkPrompt,
        },
        sessionId: claimRecord.claim.sessionId,
        assignment: {
          task_id: claimRecord.claim.taskId,
          rework: true,
          previous_claim_id: claimRecord.claimId,
        },
        metadata: {
          source: 'project-reject-task',
          role: 'system',
          rework: true,
          taskId: claimRecord.claim.taskId,
        },
        queueOnBusy: true,
        blocking: false,
      } as Record<string, unknown>) as {
        ok?: boolean;
        status?: string;
        dispatchId?: string;
        error?: string;
      };

      // 4. 更新 Project Status Gateway: rejected
      const rejectedAt = new Date().toISOString();
      if (claimRecord.claim.projectId && claimRecord.claim.sessionId) {
        applyProjectStatusGatewayPatch({
          sessionManager: deps.sessionManager,
          sessionIds: [claimRecord.claim.sessionId ?? ''],
          patch: {
            status: 'rejected',
            taskId: claimRecord.claim.taskId,
            updatedAt: rejectedAt,
            rejectedAt,
            feedback: feedbackText,
          },
        });
      }

      // 5. 广播拒绝事件
      deps.broadcast({
        type: 'project_task_rejected',
        sessionId: claimRecord.claim.sessionId ?? '',
        timestamp: rejectedAt,
        payload: {
          taskId: claimRecord.claim.taskId,
          claimId: claimRecord.claimId,
          feedback: feedbackText,
          dispatchId: dispatch?.dispatchId,
        },
      });

      log.info('Task rejected, rework dispatched', {
        taskId: claimRecord.claim.taskId,
        dispatchId: dispatch?.dispatchId,
      });

      return {
        ok: true,
        taskId: claimRecord.claim.taskId,
        status: 'rejected',
        feedback: feedbackText,
        dispatchId: dispatch?.dispatchId,
        message: 'Task rejected. Rework dispatched to Project Agent.',
      };
    },
  });
}
