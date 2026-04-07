/**
 * Project Review Claim Tool (V3)
 *
 * System Agent 审核 Project Agent 的完成声明。
 * V3: Reviewer Agent 已合并，System Agent 执行审核。
 */

import type { ToolRegistry } from '../../runtime/tool-registry.js';
import type { AgentRuntimeDeps } from '../../server/modules/agent-runtime/types.js';
import { logger } from '../../core/logger.js';
import { getClaimRecord, getClaimRecordByTaskId, updateClaimStatus, type ClaimRecord } from '../../common/claim-registry.js';
import { applyProjectStatusGatewayPatch } from '../../server/modules/project-status-gateway.js';

const log = logger.module('project-review-claim-tool');

export interface ReviewClaimInput {
  claimId?: string;
  taskId?: string;
}

export interface ReviewChecklistResult {
  taskIdMatch: boolean;
  summaryClear: boolean;
  changedFilesListed: boolean;
  verificationPass: boolean;
  checklistAllMet: boolean;
}

export interface ReviewClaimOutput {
  ok: boolean;
  claimId: string;
  taskId: string;
  decision: 'PASS' | 'REJECT';
  checklist: ReviewChecklistResult;
  message: string;
  missingItems?: string[];
}

function getAgentRuntimeDeps(): AgentRuntimeDeps {
  const globalScope = globalThis as unknown as { __FINGER_AGENT_RUNTIME_DEPS__: AgentRuntimeDeps };
  if (!globalScope.__FINGER_AGENT_RUNTIME_DEPS__) {
    throw new Error('AgentRuntimeDeps not initialized in global scope');
  }
  return globalScope.__FINGER_AGENT_RUNTIME_DEPS__;
}

function executeReviewChecklist(claim: ClaimRecord['claim']): { checklist: ReviewChecklistResult; missingItems: string[] } {
  const missingItems: string[] = [];

  const checklist: ReviewChecklistResult = {
    taskIdMatch: !!claim.taskId && claim.taskId.trim().length > 0,
    summaryClear: !!claim.summary && claim.summary.trim().length > 0,
    changedFilesListed: Array.isArray(claim.changedFiles) && claim.changedFiles.length > 0,
    verificationPass: claim.verification?.status === 'pass',
    checklistAllMet: claim.acceptanceChecklist?.length > 0
      ? claim.acceptanceChecklist.every(c => c.status === 'met')
      : true, // 无 checklist 时默认 pass
  };

  if (!checklist.taskIdMatch) missingItems.push('taskId missing or empty');
  if (!checklist.summaryClear) missingItems.push('summary missing or empty');
  if (!checklist.changedFilesListed) missingItems.push('changedFiles empty or not array');
  if (!checklist.verificationPass) missingItems.push(`verification status is "${claim.verification?.status ?? 'unknown'}", expected "pass"`);
  if (!checklist.checklistAllMet) {
    const notMet = claim.acceptanceChecklist?.filter(c => c.status !== 'met') ?? [];
    missingItems.push(`acceptance checklist has ${notMet.length} items not met: ${notMet.map(c => c.criterion).join(', ')}`);
  }

  return { checklist, missingItems };
}

export function registerProjectReviewClaimTool(toolRegistry: ToolRegistry): void {
  toolRegistry.register({
    name: 'project.review_claim',
    description: 'System Agent reviews Project Agent completion claim. Checks taskId match, summary clarity, changedFiles list, verification status (must be pass), and acceptance checklist (all items must be met). Returns PASS or REJECT decision.',
    inputSchema: {
      type: 'object',
      properties: {
        claimId: { type: 'string', description: 'Claim ID from claim_completion' },
        taskId: { type: 'string', description: 'Task ID (alternative lookup)' },
      },
    },
    policy: 'allow',
    handler: async (input: unknown): Promise<ReviewClaimOutput> => {
      const deps = getAgentRuntimeDeps();
      const params = input as Partial<ReviewClaimInput>;

      log.info('System Agent reviewing claim', { claimId: params.claimId, taskId: params.taskId });

      // 1. 查找 claim record
      let claimRecord: ClaimRecord | undefined;
      if (params.claimId) {
        claimRecord = getClaimRecord(params.claimId);
      } else if (params.taskId) {
        claimRecord = getClaimRecordByTaskId(params.taskId);
      }

      if (!claimRecord) {
        return {
          ok: false,
          claimId: params.claimId ?? '',
          taskId: params.taskId ?? '',
          decision: 'REJECT',
          checklist: {
            taskIdMatch: false,
            summaryClear: false,
            changedFilesListed: false,
            verificationPass: false,
            checklistAllMet: false,
          },
          message: 'Claim not found. No matching claimId or taskId.',
          missingItems: ['claim not found'],
        };
      }

      // 2. 执行审核检查项
      const { checklist, missingItems } = executeReviewChecklist(claimRecord.claim);

      // 3. 决策：PASS 或 REJECT
      const decision: 'PASS' | 'REJECT' = missingItems.length === 0 ? 'PASS' : 'REJECT';

      // 4. 更新 claim registry
      const reviewedAt = new Date().toISOString();
      updateClaimStatus(claimRecord.claimId, decision === 'PASS' ? 'approved' : 'rejected', {
        decision,
        reviewedAt,
        reviewerFeedback: decision === 'PASS'
          ? 'All checklist items passed. Claim approved.'
          : `Missing items: ${missingItems.join(', ')}`,
      });

      // 5. 更新 Project Status Gateway（使用 V3 状态）
      const gatewayStatus = decision === 'PASS' ? 'approved' : 'rejected';
      if (claimRecord.claim.projectId && claimRecord.claim.sessionId) {
        applyProjectStatusGatewayPatch({
          sessionManager: deps.sessionManager,
          sessionIds: [claimRecord.claim.sessionId ?? ''],
          patch: {
            status: gatewayStatus,
            taskId: claimRecord.claim.taskId,
            updatedAt: reviewedAt,
          },
        });
      }

      // 6. 广播审核结果（使用 deps.broadcast）
      deps.broadcast({
        type: 'project_claim_reviewed',
        sessionId: claimRecord.claim.sessionId ?? '',
        timestamp: reviewedAt,
        payload: {
          claimId: claimRecord.claimId,
          taskId: claimRecord.claim.taskId,
          decision,
          checklist,
          missingItems: decision === 'REJECT' ? missingItems : undefined,
        },
      });

      log.info('Claim reviewed', {
        claimId: claimRecord.claimId,
        taskId: claimRecord.claim.taskId,
        decision,
        missingItemsCount: missingItems.length,
      });

      return {
        ok: true,
        claimId: claimRecord.claimId,
        taskId: claimRecord.claim.taskId,
        decision,
        checklist,
        message: decision === 'PASS'
          ? 'Claim approved. Ready to report to user.'
          : `Claim rejected. Missing items: ${missingItems.join(', ')}`,
        missingItems: decision === 'REJECT' ? missingItems : undefined,
      };
    },
  });
}
