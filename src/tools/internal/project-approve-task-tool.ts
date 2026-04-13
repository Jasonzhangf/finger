/**
 * Project Approve Task Tool (V3)
 *
 * System Agent 验收通过的任务，向用户汇报结果。
 */

import type { ToolRegistry } from '../../runtime/tool-registry.js';
import { RuntimeContext } from '../../runtime/runtime-context.js';
import type { AgentRuntimeDeps } from '../../server/modules/agent-runtime/types.js';
import { logger } from '../../core/logger.js';
import { getClaimRecordByTaskId } from '../../common/claim-registry.js';
import { applyProjectStatusGatewayPatch } from '../../server/modules/project-status-gateway.js';
import { releaseProjectDreamLock } from '../../core/project-dream-lock.js';

const log = logger.module('project-approve-task-tool');

export interface ApproveTaskInput {
  taskId: string;
  summary?: string; // Optional user-facing summary override
}

export interface ApproveTaskOutput {
  ok: boolean;
  taskId: string;
  status: 'approved';
  summary: string;
  changedFiles: string[];
  message: string;
}



export function registerProjectApproveTaskTool(toolRegistry: ToolRegistry): void {
  const getAgentRuntimeDeps = () => RuntimeContext.getInstance().getDeps();
  toolRegistry.register({
    name: 'project.approve_task',
    description: 'System Agent approves task after review_claim PASS. Marks task as approved, releases locks, and prepares summary for user reporting.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to approve' },
        summary: { type: 'string', description: 'Optional user-facing summary override' },
      },
      required: ['taskId'],
    },
    policy: 'allow',
    handler: async (input: unknown): Promise<ApproveTaskOutput> => {
      const deps = getAgentRuntimeDeps();
      const params = input as Partial<ApproveTaskInput>;

      log.info('System Agent approving task', { taskId: params.taskId });

      // 1. 按 taskId 查找 claim record（必须是 approved 状态）
      const claimRecord = getClaimRecordByTaskId(params.taskId!);
      if (!claimRecord || claimRecord.status !== 'approved') {
        return {
          ok: false,
          taskId: params.taskId ?? '',
          status: 'approved',
          summary: '',
          changedFiles: [],
          message: 'Task not found or not reviewed as PASS. Call project.review_claim first.',
        };
      }

      // 2. 使用 override summary 或原始 summary
      const summary = params.summary?.trim() ?? claimRecord.claim.summary;

      // 3. 释放项目锁
      if (claimRecord.claim.projectId) {
        await releaseProjectDreamLock({ projectSlug: claimRecord.claim.projectId });
      }

      // 4. 更新 Project Status Gateway: approved
      const approvedAt = new Date().toISOString();
      if (claimRecord.claim.projectId && claimRecord.claim.sessionId) {
        applyProjectStatusGatewayPatch({
          sessionManager: deps.sessionManager,
          sessionIds: [claimRecord.claim.sessionId ?? ''],
          patch: {
            status: 'approved',
            taskId: claimRecord.claim.taskId,
            updatedAt: approvedAt,
            approvedAt,
          },
        });
      }

      // 5. 广播批准事件
      deps.broadcast({
        type: 'project_task_approved',
        sessionId: claimRecord.claim.sessionId ?? '',
        timestamp: approvedAt,
        payload: {
          taskId: claimRecord.claim.taskId,
          claimId: claimRecord.claimId,
          summary,
          changedFiles: claimRecord.claim.changedFiles,
        },
      });

      log.info('Task approved', {
        taskId: claimRecord.claim.taskId,
        claimId: claimRecord.claimId,
      });

      return {
        ok: true,
        taskId: claimRecord.claim.taskId,
        status: 'approved',
        summary,
        changedFiles: claimRecord.claim.changedFiles,
        message: 'Task approved. Ready to report to user.',
      };
    },
  });
}
