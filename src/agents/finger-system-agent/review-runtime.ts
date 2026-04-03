import { logger } from '../../core/logger.js';
import type { AgentRuntimeDeps, AgentDispatchRequest } from '../../server/modules/agent-runtime/types.js';
import { FINGER_REVIEWER_AGENT_ID } from '../finger-general/finger-general-module.js';
import { upsertReviewRoute } from './review-route-registry.js';

const log = logger.module('review-runtime');

function extractTaskName(input: AgentDispatchRequest): string | undefined {
  const assignmentName = typeof input.assignment?.taskName === 'string' ? input.assignment.taskName.trim() : '';
  if (assignmentName.length > 0) return assignmentName;

  const taskRecord = typeof input.task === 'object' && input.task !== null
    ? (input.task as Record<string, unknown>)
    : null;
  const explicit =
    (typeof taskRecord?.title === 'string' ? taskRecord.title.trim() : '')
    || (typeof taskRecord?.name === 'string' ? taskRecord.name.trim() : '')
    || (typeof taskRecord?.taskName === 'string' ? taskRecord.taskName.trim() : '');
  if (explicit.length > 0) return explicit;

  const prompt = typeof taskRecord?.prompt === 'string' ? taskRecord.prompt.trim() : '';
  if (prompt.length === 0) return undefined;
  const firstLine = prompt.split('\n').map((line) => line.trim()).find((line) => line.length > 0);
  return firstLine && firstLine.length <= 120 ? firstLine : undefined;
}

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
  const taskName = extractTaskName(input);

  // Register routing metadata for automatic delivery->review route.
  // Reviewer is stateless: no pre-deploy/no pre-bound session required here.
  upsertReviewRoute({
    taskId,
    ...(taskName ? { taskName } : {}),
    reviewRequired: true,
    reviewAgentId: FINGER_REVIEWER_AGENT_ID,
    acceptanceCriteria: acceptanceCriteria || undefined,
    projectId: typeof input.metadata?.projectId === 'string' ? input.metadata.projectId : undefined,
    parentSessionId: input.metadata?.dispatchParentSessionId as string | undefined,
    projectSessionId: input.sessionId,
  });
  log.info('Registered review contract for project task', {
    taskId,
    taskName,
    reviewer: FINGER_REVIEWER_AGENT_ID,
    reviewerStateless: true,
    hasAcceptanceCriteria: acceptanceCriteria.length > 0,
  });
}
