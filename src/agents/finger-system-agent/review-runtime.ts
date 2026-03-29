import { logger } from '../../core/logger.js';
import type { AgentRuntimeDeps, AgentDispatchRequest } from '../../server/modules/agent-runtime/types.js';
import { FINGER_REVIEWER_AGENT_ID } from '../finger-general/finger-general-module.js';
import { upsertReviewRoute } from './review-route-registry.js';

const log = logger.module('review-runtime');

export async function setupReviewRuntimeForDispatch(
  deps: AgentRuntimeDeps,
  input: AgentDispatchRequest,
): Promise<void> {
  if (input.sourceAgentId !== 'finger-system-agent') return;
  if (input.targetAgentId !== 'finger-project-agent') return;
  const assignment = input.assignment;
  if (!assignment || assignment.reviewRequired !== true) return;
  const taskId = typeof assignment.taskId === 'string' ? assignment.taskId.trim() : '';
  if (!taskId) return;

  const acceptanceCriteria = typeof assignment.acceptanceCriteria === 'string'
    ? assignment.acceptanceCriteria.trim()
    : '';

  // 1) Ensure reviewer runtime is deployed
  try {
    await deps.agentRuntimeBlock.execute('deploy', {
      targetAgentId: FINGER_REVIEWER_AGENT_ID,
      sessionId: input.sessionId,
      scope: 'session',
      launchMode: 'orchestrator',
      instanceCount: 1,
    } as unknown as Record<string, unknown>);
  } catch (err) {
    log.warn('Failed to deploy reviewer runtime', {
      taskId,
      reviewer: FINGER_REVIEWER_AGENT_ID,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 2) Register routing metadata for automatic delivery->review route
  upsertReviewRoute({
    taskId,
    reviewRequired: true,
    reviewAgentId: FINGER_REVIEWER_AGENT_ID,
    acceptanceCriteria: acceptanceCriteria || undefined,
    projectId: typeof input.metadata?.projectId === 'string' ? input.metadata.projectId : undefined,
    parentSessionId: input.metadata?.dispatchParentSessionId as string | undefined,
    projectSessionId: input.sessionId,
  });

  // 3) Send review goal to reviewer upfront
  if (!acceptanceCriteria) return;
  try {
    await deps.agentRuntimeBlock.execute('dispatch', {
      sourceAgentId: 'finger-system-agent',
      targetAgentId: FINGER_REVIEWER_AGENT_ID,
      task: {
        prompt: `[Review Goal]\n任务ID: ${taskId}\n验收标准: ${acceptanceCriteria}\n请等待 project agent 的交付上报，按标准审查。`,
      },
      sessionId: input.sessionId,
      blocking: false,
      metadata: {
        source: 'review-bootstrap',
        role: 'system',
        taskId,
        acceptanceCriteria,
      },
    } as unknown as Record<string, unknown>);
  } catch (err) {
    log.warn('Failed to dispatch review goal', {
      taskId,
      reviewer: FINGER_REVIEWER_AGENT_ID,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

