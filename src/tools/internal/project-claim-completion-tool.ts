/**
 * Project Claim Completion Tool (V3)
 *
 * Project Agent 提交结构化完成声明给 System Agent 审核。
 * V3: 不再路由到独立 Reviewer，直接通知 System Agent。
 */

import type { ToolRegistry } from '../../runtime/tool-registry.js';
import { RuntimeContext } from '../../runtime/runtime-context.js';
import type { AgentRuntimeDeps } from '../../server/modules/agent-runtime/types.js';
import { logger } from '../../core/logger.js';
import { FINGER_SYSTEM_AGENT_ID, FINGER_PROJECT_AGENT_ID } from '../../agents/finger-general/finger-general-module.js';
import { applyProjectStatusGatewayPatch } from '../../server/modules/project-status-gateway.js';
import { upsertClaimRecord, type CompletionClaim, type ClaimRecord } from '../../common/claim-registry.js';

const log = logger.module('project-claim-completion-tool');

export interface ProjectClaimCompletionInput {
  taskId: string;
  summary: string;
  changedFiles: string[];
  verification?: {
    commands?: string[];
    outputs?: string[];
    status?: 'pass' | 'fail' | 'partial';
  };
  acceptanceChecklist?: {
    criterion: string;
    status?: 'met' | 'partial' | 'not_met';
    evidence?: string;
  }[];
  projectId?: string;
  sessionId?: string;
}

export interface ProjectClaimCompletionOutput {
  ok: boolean;
  taskId: string;
  claimId: string;
  status: 'claimed_done';
  message: string;
  warnings?: string[];
}



function validateClaim(input: Partial<ProjectClaimCompletionInput>): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!input.taskId || input.taskId.trim().length === 0) {
    errors.push('taskId is required');
  }

  if (!input.summary || input.summary.trim().length === 0) {
    errors.push('summary is required');
  }

  if (!input.changedFiles || !Array.isArray(input.changedFiles)) {
    errors.push('changedFiles must be an array');
  }

  // 验证结果默认 'pass'（Project Agent 应先自检）
  const verificationStatus = input.verification?.status ?? 'pass';
  if (verificationStatus === 'fail') {
    errors.push('verification.status is "fail" - must pass self-check before claiming completion');
  }

  return { valid: errors.length === 0, errors };
}

export function registerProjectClaimCompletionTool(toolRegistry: ToolRegistry): void {
  const getAgentRuntimeDeps = () => RuntimeContext.getInstance().getDeps();
  toolRegistry.register({
    name: 'project.claim_completion',
    description: 'Project Agent submits structured completion claim for System Agent review. Must include taskId, summary, changedFiles, and verification evidence. Self-check must pass before claiming.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID from dispatch' },
        summary: { type: 'string', description: 'Concise completion summary' },
        changedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of modified files',
        },
        verification: {
          type: 'object',
          properties: {
            commands: { type: 'array', items: { type: 'string' } },
            outputs: { type: 'array', items: { type: 'string' } },
            status: { type: 'string', enum: ['pass', 'fail', 'partial'] },
          },
          description: 'Verification commands and results',
        },
        acceptanceChecklist: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              criterion: { type: 'string' },
              status: { type: 'string', enum: ['met', 'partial', 'not_met'] },
              evidence: { type: 'string' },
            },
            required: ['criterion'],
          },
          description: 'Acceptance criteria checklist',
        },
        projectId: { type: 'string' },
        sessionId: { type: 'string' },
      },
      required: ['taskId', 'summary', 'changedFiles'],
    },
    policy: 'allow',
    handler: async (input: unknown): Promise<ProjectClaimCompletionOutput> => {
      const deps = getAgentRuntimeDeps();
      const params = input as Partial<ProjectClaimCompletionInput>;

      log.info('Project Agent claiming completion', { taskId: params.taskId });

      // 1. 验证 claim 结构
      const validation = validateClaim(params);
      if (!validation.valid) {
        return {
          ok: false,
          taskId: params.taskId ?? '',
          claimId: '',
          status: 'claimed_done',
          message: `Claim validation failed: ${validation.errors.join(', ')}`,
          warnings: validation.errors,
        };
      }

      // 2. 构建 CompletionClaim
      const claim: CompletionClaim = {
        taskId: params.taskId!,
        summary: params.summary!.trim(),
        changedFiles: params.changedFiles!,
        verification: {
          commands: params.verification?.commands ?? [],
          outputs: params.verification?.outputs ?? [],
          status: params.verification?.status ?? 'pass',
        },
        acceptanceChecklist: params.acceptanceChecklist?.map(item => ({
          criterion: item.criterion,
          status: item.status ?? 'met',
          evidence: item.evidence,
        })) ?? [],
        claimedAt: new Date().toISOString(),
        projectId: params.projectId,
        sessionId: params.sessionId,
      };

      // 3. 写入 Claim Registry（持久化）
      const now = Date.now();
      const claimRecord: ClaimRecord = {
        claimId: `${claim.taskId}-${now}`,
        taskId: claim.taskId,
        claim,
        status: 'pending_review',
        createdAt: now,
        updatedAt: now,
      };
      upsertClaimRecord(claimRecord);

      // 4. 更新 Project Status Gateway：claimed_done
      if (claim.projectId && claim.sessionId) {
        applyProjectStatusGatewayPatch({
          sessionManager: deps.sessionManager,
          sessionIds: [claim.sessionId ?? ''],
          patch: {
            status: 'claimed_done',
            taskId: claim.taskId,
            updatedAt: new Date().toISOString(),
          },
        });
      }

      // 5. 广播事件给 System Agent（V3: 直接通知，不再路由到 reviewer）
      deps.broadcast({
        type: 'project_claim_completion',
        sessionId: claim.sessionId ?? '',
        timestamp: claim.claimedAt,
        payload: {
          taskId: claim.taskId,
          claimId: claimRecord.claimId,
          summary: claim.summary,
          changedFiles: claim.changedFiles,
          verificationStatus: claim.verification.status,
          checklistMet: claim.acceptanceChecklist.filter(c => c.status === 'met').length,
          checklistTotal: claim.acceptanceChecklist.length,
        },
      });

      log.info('Claim submitted to System Agent', {
        taskId: claim.taskId,
        claimId: claimRecord.claimId,
        verificationStatus: claim.verification.status,
      });

      return {
        ok: true,
        taskId: claim.taskId,
        claimId: claimRecord.claimId,
        status: 'claimed_done',
        message: 'Completion claim submitted. Waiting for System Agent review.',
      };
    },
  });
}

// Re-export CompletionClaim type for convenience
export { type CompletionClaim } from '../../common/claim-registry.js';
